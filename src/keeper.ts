import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  formatEther,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type Log,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { predictionMarketAbi, predictionMarketLensAbi, pythBoundaryReaderAbi } from "./abi.js";
import { readBoundary, type BoundarySnapshot, type StaticMarket } from "./boundary-read.js";
import type { KeeperConfig } from "./config.js";
import { logSummary, summarizeLogs } from "./events.js";
import { captureFirstUpdates, type FirstUpdateCapture, type StreamResult } from "./hermes.js";
import { assetIdToSymbol, MULTICALL3 } from "./ids.js";
import { log } from "./log.js";
import { hasOpenRound, planBoundary, streamFeedsFor, type BoundaryPlan } from "./plan.js";
import { RpcProvider, type RpcEvent } from "./rpc.js";
import { BASE_INTERVAL, backoffMs, chooseOnceTarget, nextBoundary, selectDue, sleep, type MarketInfo } from "./schedule.js";

/** Pull a readable reason out of a viem error, including custom contract error names. */
export function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      return { error: reverted.data?.errorName ?? reverted.shortMessage, args: reverted.data?.args };
    }
    return { error: err.shortMessage, details: err.details };
  }
  return { error: err instanceof Error ? err.message : String(err) };
}

export function makeChain(chainId: number, rpcUrl: string): Chain {
  return defineChain({
    id: chainId,
    name: chainId === 421614 ? "arbitrum-sepolia" : `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
}

export function logRpcEvent(e: RpcEvent): void {
  if (e.type === "fallback") log("warn", "rpc fallback used: primary RPC failed after retries", { method: e.method, reason: e.reason });
  else log("warn", "rpc retry", { endpoint: e.endpoint, method: e.method, attempt: e.attempt, delayMs: e.delayMs, reason: e.reason });
}

/**
 * Logs PYTH_KEY_INVALID_OR_EXPIRED when Hermes rejected the API key. It is an error line, so a CI pass exits non
 * zero and the workflow run fails. Returns true when the key was rejected.
 */
export function reportAuthError(result: Pick<StreamResult, "authError">, boundary: number): boolean {
  if (!result.authError) return false;
  log("error", "PYTH_KEY_INVALID_OR_EXPIRED", {
    boundary,
    status: result.authError.status,
    detail: result.authError.detail,
    note: "Hermes rejected PYTH_API_KEY (missing, expired, invalid or without access to a feed); renew the key secret",
  });
  return true;
}

class KeyRejectedError extends Error {}

/** Markets of `due` whose asset has a captured Pyth update, and the symbols that have none. */
export function splitByCapture(
  due: MarketInfo[],
  capture: FirstUpdateCapture,
  feedIds: Record<string, Hex>,
): { ready: MarketInfo[]; missingSymbols: string[]; feeds: Hex[] } {
  const ready: MarketInfo[] = [];
  const missing = new Set<string>();
  const feeds: Hex[] = [];
  for (const m of due) {
    const feed = feedIds[m.symbol];
    if (feed && capture.has(feed)) {
      ready.push(m);
      if (!feeds.includes(feed)) feeds.push(feed);
    } else {
      missing.add(m.symbol);
    }
  }
  return { ready, missingSymbols: [...missing], feeds };
}

export class Keeper {
  readonly rpc: RpcProvider;
  private readonly publicClient: PublicClient<Transport, Chain>;
  private readonly walletClient: WalletClient<Transport, Chain, Account>;
  private readonly account: Account;
  private readonly market: Address;
  private readonly lens: Address;
  private reader: Address | undefined;
  private readonly stop = new AbortController();
  private staticMarkets: StaticMarket[] = [];
  private bufferSeconds = 30;
  private lastBalanceCheck = 0;
  private cleanBoundaries = 0;
  private executedBoundaries = 0;
  private idleBoundaries = 0;
  private lastPlan: BoundaryPlan | undefined;
  private lastInclusionDelay: number | undefined;

  constructor(private readonly cfg: KeeperConfig) {
    this.rpc = new RpcProvider({
      primaryUrl: cfg.rpcUrl,
      fallbackUrl: cfg.rpcFallbackUrl,
      timeoutMs: cfg.httpTimeoutMs,
      onEvent: logRpcEvent,
    });
    const chain = makeChain(cfg.chainId, cfg.rpcUrl);
    const transport = custom({ request: (args) => this.rpc.request(args) }, { retryCount: 0 });
    this.account = privateKeyToAccount(cfg.privateKey);
    this.publicClient = createPublicClient({ chain, transport });
    this.walletClient = createWalletClient({ chain, transport, account: this.account });
    this.market = cfg.marketAddress;
    this.lens = cfg.lensAddress;
  }

  shutdown(): void {
    this.stop.abort();
  }

  get stopped(): boolean {
    return this.stop.signal.aborted;
  }

  /**
   * Startup checks: chain id, lens wiring, market list, Pyth feed ids and balance. The keeper needs no role: boundary
   * execution is permissionless and the wallet only pays gas and Pyth fees.
   */
  async preflight(): Promise<void> {
    const chainId = await this.publicClient.getChainId();
    if (chainId !== this.cfg.chainId) throw new Error(`RPC chain id ${chainId} does not match CHAIN_ID ${this.cfg.chainId}`);

    const [lensMarket, reader, params] = (await this.publicClient.multicall({
      contracts: [
        { address: this.lens, abi: predictionMarketLensAbi, functionName: "market" },
        { address: this.market, abi: predictionMarketAbi, functionName: "reader" },
        { address: this.lens, abi: predictionMarketLensAbi, functionName: "getParams" },
      ] as never,
      allowFailure: false,
      batchSize: 0,
    })) as unknown as [Address, Address, { bufferSeconds: bigint }];
    if (lensMarket.toLowerCase() !== this.market.toLowerCase()) {
      throw new Error(`LENS_ADDRESS reads market ${lensMarket}, not MARKET_ADDRESS ${this.market}`);
    }
    this.reader = reader;
    this.bufferSeconds = Number(params.bufferSeconds);

    await this.loadStaticMarkets();
    const unknown = [...new Set(this.staticMarkets.map((m) => m.symbol))].filter((s) => !this.cfg.feedIds[s]);
    if (unknown.length > 0) throw new Error(`no Pyth feed id configured for ${unknown.join(", ")} (set FEED_IDS)`);

    log("info", "preflight ok", {
      keeper: this.account.address,
      market: this.market,
      lens: this.lens,
      reader,
      chainId,
      markets: this.staticMarkets.length,
      hermes: this.cfg.hermesUrl,
      fallbackRpc: Boolean(this.cfg.rpcFallbackUrl),
      idleMode: this.cfg.idleMode,
      idleRefreshSeconds: this.cfg.idleRefreshSeconds,
      dryRun: this.cfg.dryRun,
    });
    await this.checkBalance();
  }

  /**
   * Single pass for CI (GitHub Actions). Logs runner punctuality, checks the previous boundary for rounds with bets
   * that were never executed (MISSED_WITH_BETS), then handles one boundary: the current one if its execution window
   * is still open (late runner), otherwise the next one.
   */
  async runOnce(): Promise<void> {
    const readyAt = Date.now() / 1000;
    const windowSec = this.bufferSeconds - this.cfg.safetyMarginMs / 1000;
    const { target, late, previous } = chooseOnceTarget(Math.floor(readyAt), windowSec);
    const runnerStartedAt = this.cfg.runnerStartedAt ?? Math.floor(readyAt);
    const nominalTrigger = target - this.cfg.triggerLeadSeconds;
    log(late ? "warn" : "info", "runner timing", {
      runnerStartedAt: new Date(runnerStartedAt * 1000).toISOString(),
      keeperReadyAt: new Date(readyAt * 1000).toISOString(),
      targetBoundary: target,
      // Positive: seconds of margin before the boundary. Negative: the runner arrived after it.
      leadSeconds: Math.round((target - readyAt) * 10) / 10,
      // Runner start relative to the nominal trigger time (boundary minus TRIGGER_LEAD_SECONDS).
      startDelaySeconds: runnerStartedAt - nominalTrigger,
      late,
    });
    if (previous !== undefined) await this.checkMissed(previous);
    if (!late) await sleep(target * 1000 - this.cfg.streamLeadMs - Date.now(), this.stop.signal);
    if (this.stopped) return;
    try {
      await this.handleBoundary(target);
    } catch (err) {
      log("error", "unexpected boundary failure", { boundary: target, ...describeError(err) });
    }
    log("info", "keeper stopped");
  }

  /** Logs MISSED_WITH_BETS when a due market of `boundary` still holds a round with bets that was never executed. */
  private async checkMissed(boundary: number): Promise<void> {
    try {
      const snap = await readBoundary(this.publicClient, this.market, this.lens, this.staticMarkets, boundary);
      const missed = selectDue(snap.markets, boundary).filter((m) => hasOpenRound(snap, m, boundary));
      if (missed.length > 0) {
        log("error", "MISSED_WITH_BETS", {
          boundary,
          markets: missed.map(describeMarket),
          note: "rounds with bets were not executed in their window; they are voided and fully refundable",
        });
      }
    } catch (err) {
      log("warn", "missed boundary check failed", { boundary, ...describeError(err) });
    }
  }

  /** Main loop: open the Hermes stream shortly before every 5 minute boundary and execute what is due. */
  async run(once = false): Promise<void> {
    if (once) return this.runOnce();
    while (!this.stopped) {
      const boundary = nextBoundary(Math.floor(Date.now() / 1000) + Math.ceil(this.cfg.streamLeadMs / 1000), BASE_INTERVAL);
      const wakeAt = boundary * 1000 - this.cfg.streamLeadMs;
      log("debug", "sleeping until stream lead", { boundary, wakeAt: new Date(wakeAt).toISOString() });
      await sleep(wakeAt - Date.now(), this.stop.signal);
      if (this.stopped) break;
      try {
        await this.handleBoundary(boundary);
      } catch (err) {
        log("error", "unexpected boundary failure", { boundary, ...describeError(err) });
      }
      if (Date.now() - this.lastBalanceCheck >= this.cfg.balanceCheckIntervalMs) {
        try {
          await this.checkBalance();
        } catch (err) {
          log("warn", "balance check failed", describeError(err));
        }
      }
    }
    log("info", "keeper stopped");
  }

  /**
   * One boundary: the Hermes stream is opened first (so the first update after the boundary is never missed), the
   * chain is read once the boundary passed, and the due markets are executed with the captured updates.
   */
  async handleBoundary(boundary: number): Promise<void> {
    const deadlineMs = (boundary + this.bufferSeconds) * 1000 - this.cfg.safetyMarginMs;
    // Capture ends early enough to leave time for the transaction.
    const captureDeadlineMs = Math.max(boundary * 1000 + 3_000, deadlineMs - 8_000);
    const streamStop = new AbortController();
    const onStop = () => streamStop.abort();
    this.stop.signal.addEventListener("abort", onStop, { once: true });
    const feeds = await this.feedsToStream(boundary);
    const capturing = captureFirstUpdates({
      hermesUrl: this.cfg.hermesUrl,
      apiKey: this.cfg.pythApiKey,
      ids: feeds,
      boundary,
      deadlineMs: captureDeadlineMs,
      signal: streamStop.signal,
      onEvent: (e) => {
        if (e.type === "connected") log(e.attempt > 1 ? "warn" : "debug", "hermes stream connected", { boundary, attempt: e.attempt });
        else log("warn", "hermes stream failed, reconnecting inside the window", { boundary, attempt: e.attempt, reason: e.reason });
      },
    });

    this.rpc.setDeadline(deadlineMs);
    this.rpc.resetRequestCount();
    try {
      await sleep(boundary * 1000 + this.cfg.wakeDelayMs - Date.now(), this.stop.signal);
      if (this.stopped) return;
      for (let attempt = 1; ; attempt++) {
        const started = Date.now();
        try {
          const ok = await this.attemptBoundary(boundary, deadlineMs, attempt, capturing, streamStop, feeds);
          if (ok) {
            this.cleanBoundaries = attempt === 1 ? this.cleanBoundaries + 1 : 0;
            const plan = this.lastPlan;
            const executed = plan !== undefined && plan.mode !== "idle" && plan.execute.length > 0;
            if (executed) this.executedBoundaries++;
            else this.idleBoundaries++;
            log("info", "boundary done", {
              boundary,
              inclusionDelaySeconds: executed ? this.lastInclusionDelay : undefined,
              mode: plan?.mode ?? "none",
              executed,
              marketsDue: plan?.due ?? 0,
              marketsWithBets: plan?.marketsWithBets ?? 0,
              marketsExecuted: plan?.execute.length ?? 0,
              attempts: attempt,
              rpcCalls: this.rpc.requestCount,
              consecutiveClean: this.cleanBoundaries,
              totalExecuted: this.executedBoundaries,
              totalSkippedIdle: this.idleBoundaries,
            });
            return;
          }
        } catch (err) {
          if (err instanceof KeyRejectedError) return;
          log("warn", "boundary attempt failed", { boundary, attempt, ms: Date.now() - started, ...describeError(err) });
        }
        const wait = backoffMs(attempt);
        if (Date.now() + wait >= deadlineMs || this.stopped) {
          this.cleanBoundaries = 0;
          log("error", "boundary missed: buffer window exhausted, affected rounds will be voided and refunded", {
            boundary,
            attempts: attempt,
            rpcCalls: this.rpc.requestCount,
          });
          if ((this.lastPlan?.marketsWithBets ?? 0) > 0) {
            log("error", "MISSED_WITH_BETS", { boundary, marketsWithBets: this.lastPlan?.marketsWithBets });
          }
          return;
        }
        await sleep(wait, this.stop.signal);
      }
    } finally {
      streamStop.abort();
      this.stop.signal.removeEventListener("abort", onStop);
      // A rejected key is reported at every boundary, also when nothing had to be executed.
      const result = await capturing.catch(() => undefined);
      if (result) reportAuthError(result, boundary);
      this.rpc.setDeadline(undefined);
    }
  }

  /** One full attempt. Returns true when nothing else is needed for this boundary. */
  private async attemptBoundary(
    boundary: number,
    deadlineMs: number,
    attempt: number,
    capturing: ReturnType<typeof captureFirstUpdates>,
    streamStop: AbortController,
    streamed: Hex[],
  ): Promise<boolean> {
    this.lastPlan = undefined;
    this.lastInclusionDelay = undefined;
    let snap = await this.readSnapshot(boundary, deadlineMs);
    if (snap.marketCount !== this.staticMarkets.length) {
      log("info", "market list changed, reloading", { before: this.staticMarkets.length, after: snap.marketCount });
      await this.loadStaticMarkets();
      snap = await this.readSnapshot(boundary, deadlineMs);
    }
    this.bufferSeconds = snap.bufferSeconds;

    // Pause only blocks new bets: rounds with bets must still lock and close, so a paused market is executed too.
    if (snap.paused) log("warn", "market is paused: new bets are blocked, rounds with bets still settle", { boundary });
    const planned = planBoundary(snap, boundary, this.cfg.idleMode, this.cfg.idleRefreshSeconds);
    // Markets whose feed is not in the stream (inactive and without bets) are not refreshed. A market with bets is
    // always kept: if its feed is missing it is reported below as not executed.
    const execute = planned.execute.filter(
      (m) => streamed.includes(this.cfg.feedIds[m.symbol] as Hex) || hasOpenRound(snap, m, boundary),
    );
    if (execute.length < planned.execute.length) {
      log("debug", "inactive markets without bets are not refreshed", { boundary, skipped: planned.execute.length - execute.length });
    }
    const plan: BoundaryPlan = { ...planned, execute };
    this.lastPlan = plan;
    if (plan.execute.length === 0) {
      streamStop.abort();
      log("info", plan.mode === "idle" ? "boundary skipped (idle): no rounds with bets" : "nothing due", {
        boundary,
        marketsDue: plan.due,
        marketsWithBets: plan.marketsWithBets,
      });
      return true;
    }

    const result = await capturing;
    const { capture, failed } = result;
    // Reported once in handleBoundary; retrying with a rejected key cannot help.
    if (result.authError) throw new KeyRejectedError();
    const { ready, missingSymbols, feeds } = splitByCapture(plan.execute, capture, this.cfg.feedIds);
    for (const symbol of missingSymbols) {
      const feed = this.cfg.feedIds[symbol] as Hex;
      log("warn", "no usable Pyth update for asset, its markets are not executed", {
        boundary,
        asset: symbol,
        reason: capture.reasonFor(feed, failed),
      });
    }
    if (ready.length === 0) throw new Error("no Pyth update captured for any due asset");

    const data = capture.updateData(feeds);
    const reader = this.reader as Address;
    const feePerCall = (await this.publicClient.readContract({
      address: reader,
      abi: pythBoundaryReaderAbi,
      functionName: "updateFee",
      args: [data],
    })) as bigint;
    // The market parses every asset in its own Pyth call.
    const value = feePerCall * BigInt(feeds.length);
    const ids = ready.map((m) => m.id);
    const captured = feeds.map((f) => {
      const c = capture.captured.get(f)!;
      return { feed: f, publishTime: c.publishTime, prevPublishTime: c.prevPublishTime, price: c.price, expo: c.expo };
    });

    if (this.cfg.dryRun) {
      await this.publicClient.simulateContract({
        account: this.account,
        address: this.market,
        abi: predictionMarketAbi,
        functionName: "executeBoundary",
        args: [ids, data],
        value,
      });
      log("info", "dry run: would execute", { boundary, markets: ready.map(describeMarket), pythFeeWei: value, captured });
      return true;
    }

    const hash = await this.walletClient.writeContract({
      address: this.market,
      abi: predictionMarketAbi,
      functionName: "executeBoundary",
      args: [ids, data],
      value,
    });
    const receipt = await this.waitReceipt(hash, deadlineMs);
    const block = await this.publicClient.getBlock({ blockNumber: receipt.blockNumber });
    this.lastInclusionDelay = Number(block.timestamp) - boundary;
    const summary = summarizeLogs(receipt.logs as Log[], this.market);
    logSummary(summary);
    const notable = summary.skipped.length + summary.rejected.length + summary.wideConfidence.length + summary.rebased.length;
    log(notable > 0 ? "warn" : "info", "boundary executed", {
      boundary,
      attempt,
      tx: hash,
      block: receipt.blockNumber,
      inclusionDelaySeconds: this.lastInclusionDelay,
      gasUsed: receipt.gasUsed,
      pythFeeWei: value,
      lagMs: Date.now() - boundary * 1000,
      mode: plan.mode,
      marketsWithBets: plan.marketsWithBets,
      markets: ready.map(describeMarket),
      captured,
      locked: summary.locked,
      closed: summary.closed,
      skipped: summary.skipped.length,
      rejected: summary.rejected.length,
      wideConfidence: summary.wideConfidence.length,
      rebased: summary.rebased.length,
      voided: summary.voided.length,
    });

    const notExecuted = plan.execute.filter((m) => missingSymbols.includes(m.symbol) && hasOpenRound(snap, m, boundary));
    if (notExecuted.length > 0) {
      log("error", "MISSED_WITH_BETS", {
        boundary,
        markets: notExecuted.map(describeMarket),
        note: "no usable Pyth update for these assets; their rounds will be voided and fully refundable",
      });
    }
    // The update of a market skipped for PriceUnavailable is the only valid one for this boundary: a retry with the
    // same data cannot succeed, so it is reported instead of retried.
    const unavailable = summary.skipped.filter((s) => s.reason === "PriceUnavailable");
    if (unavailable.length > 0) log("warn", "markets skipped for PriceUnavailable", { boundary, markets: unavailable.map((s) => s.market) });
    return true;
  }

  /**
   * Feeds to subscribe for `boundary`, from a snapshot read a few seconds before it (see streamFeedsFor). If that read
   * fails, every listed feed is streamed so nothing can be missed.
   */
  private async feedsToStream(boundary: number): Promise<Hex[]> {
    try {
      const pre = await readBoundary(this.publicClient, this.market, this.lens, this.staticMarkets, boundary);
      const feeds = streamFeedsFor(pre, boundary, this.cfg.feedIds);
      log("debug", "hermes stream feeds", { boundary, feeds: feeds.length });
      return feeds;
    } catch (err) {
      log("warn", "pre boundary read failed, streaming every listed feed", { boundary, ...describeError(err) });
      return [...new Set(this.staticMarkets.map((m) => this.cfg.feedIds[m.symbol] as Hex))];
    }
  }

  /** Single aggregate3 read; repeats only while the chain clock has not reached the boundary yet. */
  private async readSnapshot(boundary: number, deadlineMs: number): Promise<BoundarySnapshot> {
    for (;;) {
      const snap = await readBoundary(this.publicClient, this.market, this.lens, this.staticMarkets, boundary);
      const skew = Math.floor(Date.now() / 1000) - snap.chainTime;
      if (Math.abs(skew) > 2) log("warn", "clock skew between keeper and chain", { skewSeconds: skew });
      if (snap.chainTime >= boundary) return snap;
      if (Date.now() >= deadlineMs) throw new Error(`chain time ${snap.chainTime} never reached boundary ${boundary}`);
      await sleep(500, this.stop.signal);
    }
  }

  private async loadStaticMarkets(): Promise<void> {
    const ids = (await this.publicClient.readContract({ address: this.lens, abi: predictionMarketLensAbi, functionName: "getMarketIds" })) as readonly Hex[];
    const rows = (await this.publicClient.multicall({
      contracts: ids.map((id) => ({ address: this.lens, abi: predictionMarketLensAbi, functionName: "getMarket", args: [id] })) as never,
      allowFailure: false,
      batchSize: 0,
    })) as unknown as readonly { assetId: Hex; interval: number }[];
    this.staticMarkets = rows.map((row, i) => ({
      id: ids[i] as Hex,
      assetId: row.assetId,
      symbol: assetIdToSymbol(row.assetId),
      interval: Number(row.interval),
    }));
  }

  private async checkBalance(): Promise<void> {
    this.lastBalanceCheck = Date.now();
    const balance = await this.publicClient.getBalance({ address: this.account.address });
    if (balance < this.cfg.minBalanceWei) {
      log("warn", "low keeper balance: top up ETH for gas and Pyth fees", {
        keeper: this.account.address,
        balanceEth: formatEther(balance),
        thresholdEth: formatEther(this.cfg.minBalanceWei),
      });
    } else {
      log("info", "keeper balance", { balanceEth: formatEther(balance) });
    }
  }

  /** Receipt polling every second, never past the execution window. */
  private async waitReceipt(hash: Hash, deadlineMs: number) {
    const timeout = Math.max(1_000, deadlineMs - Date.now());
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout, pollingInterval: 1_000 });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
    return receipt;
  }
}

function describeMarket(m: MarketInfo): string {
  return `${m.symbol}/${m.interval}s${m.active ? "" : " (inactive)"}`;
}
