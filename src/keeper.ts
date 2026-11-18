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
import { keeperSignedPriceSourceAbi, predictionMarketAbi } from "./abi.js";
import { readBoundary, type BoundarySnapshot, type StaticMarket } from "./boundary-read.js";
import type { KeeperConfig } from "./config.js";
import { logSummary, summarizeLogs } from "./events.js";
import { hasOpenRound, planBoundary, type BoundaryPlan } from "./plan.js";
import { MULTICALL3, OPERATOR_ROLE, PRICE_PUSHER_ROLE } from "./ids.js";
import { log } from "./log.js";
import { assetIdToSymbol, fetchPrices } from "./prices.js";
import { RpcProvider, type RpcEvent } from "./rpc.js";
import { BASE_INTERVAL, backoffMs, chooseOnceTarget, nextBoundary, selectDue, sleep, type MarketInfo } from "./schedule.js";

const ROUND_PENDING = 1;
const ROUND_LOCKED = 2;

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
    name: `elysium-${chainId}`,
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
}

export function logRpcEvent(e: RpcEvent): void {
  if (e.type === "fallback") log("warn", "rpc fallback used: primary RPC failed after retries", { method: e.method, reason: e.reason });
  else log("warn", "rpc retry", { endpoint: e.endpoint, method: e.method, attempt: e.attempt, delayMs: e.delayMs, reason: e.reason });
}

export class Keeper {
  readonly rpc: RpcProvider;
  private readonly publicClient: PublicClient<Transport, Chain>;
  private readonly walletClient: WalletClient<Transport, Chain, Account>;
  private readonly account: Account;
  private readonly market: Address;
  private readonly stop = new AbortController();
  private staticMarkets: StaticMarket[] = [];
  private readonly pusherBySource = new Map<string, boolean>();
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
  }

  shutdown(): void {
    this.stop.abort();
  }

  get stopped(): boolean {
    return this.stop.signal.aborted;
  }

  /** Startup checks: chain id, roles (the only time roles are read), market list and balance. */
  async preflight(): Promise<void> {
    const chainId = await this.publicClient.getChainId();
    if (chainId !== this.cfg.chainId) throw new Error(`RPC chain id ${chainId} does not match CHAIN_ID ${this.cfg.chainId}`);

    const [source, isOperator, bufferSeconds] = (await this.publicClient.multicall({
      contracts: [
        { address: this.market, abi: predictionMarketAbi, functionName: "priceSource" },
        { address: this.market, abi: predictionMarketAbi, functionName: "hasRole", args: [OPERATOR_ROLE, this.account.address] },
        { address: this.market, abi: predictionMarketAbi, functionName: "bufferSeconds" },
      ] as never,
      allowFailure: false,
      batchSize: 0,
    })) as unknown as [Address, boolean, bigint];
    this.bufferSeconds = Number(bufferSeconds);

    const missing: string[] = [];
    if (!isOperator) missing.push(`OPERATOR_ROLE on market ${this.market}`);
    if (this.cfg.pushPrices && !(await this.isPusher(source))) missing.push(`PRICE_PUSHER_ROLE on price source ${source}`);
    if (missing.length > 0) {
      log("error", "keeper cannot start: missing role", { keeper: this.account.address, missing });
      throw new Error(`missing role(s): ${missing.join(", ")}`);
    }

    await this.loadStaticMarkets();
    log("info", "preflight ok", {
      keeper: this.account.address,
      market: this.market,
      chainId,
      markets: this.staticMarkets.length,
      pushPrices: this.cfg.pushPrices,
      priceField: this.cfg.hlPriceField,
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
    if (!late) await sleep(target * 1000 + this.cfg.wakeDelayMs - Date.now(), this.stop.signal);
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
      const snap = await readBoundary(this.publicClient, this.market, this.staticMarkets, boundary);
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

  /** Main loop: wake at every 5 minute boundary and execute what is due. */
  async run(once = false): Promise<void> {
    if (once) return this.runOnce();
    while (!this.stopped) {
      const boundary = nextBoundary(Math.floor(Date.now() / 1000), BASE_INTERVAL);
      const wakeAt = boundary * 1000 + this.cfg.wakeDelayMs;
      log("debug", "sleeping until boundary", { boundary, wakeAt: new Date(wakeAt).toISOString() });
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
      if (once) break;
    }
    log("info", "keeper stopped");
  }

  async handleBoundary(boundary: number): Promise<void> {
    const deadlineMs = (boundary + this.bufferSeconds) * 1000 - this.cfg.safetyMarginMs;
    this.rpc.setDeadline(deadlineMs);
    this.rpc.resetRequestCount();
    try {
      for (let attempt = 1; ; attempt++) {
        const started = Date.now();
        try {
          const ok = await this.attemptBoundary(boundary, deadlineMs, attempt);
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
      this.rpc.setDeadline(undefined);
    }
  }

  /** One full attempt. Returns true when nothing else is needed for this boundary. */
  private async attemptBoundary(boundary: number, deadlineMs: number, attempt: number): Promise<boolean> {
    this.lastPlan = undefined;
    this.lastInclusionDelay = undefined;
    let snap = await this.readSnapshot(boundary, deadlineMs);
    if (snap.marketCount !== this.staticMarkets.length) {
      log("info", "market list changed, reloading", { before: this.staticMarkets.length, after: snap.marketCount });
      await this.loadStaticMarkets();
      snap = await this.readSnapshot(boundary, deadlineMs);
    }
    this.bufferSeconds = snap.bufferSeconds;

    if (snap.paused) {
      log("warn", "market is paused, skipping boundary", { boundary });
      return true;
    }
    const plan = planBoundary(snap, boundary, this.cfg.idleMode, this.cfg.idleRefreshSeconds);
    this.lastPlan = plan;
    if (plan.execute.length === 0) {
      log("info", plan.mode === "idle" ? "boundary skipped (idle): no rounds with bets" : "nothing due", {
        boundary,
        marketsDue: plan.due,
        marketsWithBets: plan.marketsWithBets,
      });
      return true;
    }
    const due = plan.execute;
    const ids = due.map((m) => m.id);

    if (this.cfg.pushPrices) await this.pushPrices(boundary, due, snap, deadlineMs, attempt);

    if (this.cfg.dryRun) {
      if (!this.cfg.pushPrices) {
        await this.publicClient.simulateContract({ account: this.account, address: this.market, abi: predictionMarketAbi, functionName: "executeBoundary", args: [ids] });
      }
      log("info", "dry run: would execute", { boundary, markets: due.map(describeMarket) });
      return true;
    }

    const hash = await this.walletClient.writeContract({
      address: this.market,
      abi: predictionMarketAbi,
      functionName: "executeBoundary",
      args: [ids],
    });
    const receipt = await this.waitReceipt(hash, deadlineMs);
    const block = await this.publicClient.getBlock({ blockNumber: receipt.blockNumber });
    this.lastInclusionDelay = Number(block.timestamp) - boundary;
    const summary = summarizeLogs(receipt.logs as Log[], this.market);
    logSummary(summary);
    log(summary.skipped.length + summary.rejected.length + summary.rebased.length > 0 ? "warn" : "info", "boundary executed", {
      boundary,
      attempt,
      tx: hash,
      block: receipt.blockNumber,
      inclusionDelaySeconds: this.lastInclusionDelay,
      gasUsed: receipt.gasUsed,
      lagMs: Date.now() - boundary * 1000,
      mode: plan.mode,
      marketsWithBets: plan.marketsWithBets,
      markets: due.map(describeMarket),
      locked: summary.locked,
      closed: summary.closed,
      skipped: summary.skipped.length,
      rejected: summary.rejected.length,
      rebased: summary.rebased.length,
      voided: summary.voided.length,
    });

    // A market skipped for a missing price recorded nothing on chain and can still be retried in the window.
    const retry = summary.skipped.filter((s) => s.reason === "PriceUnavailable");
    if (retry.length > 0) throw new Error(`${retry.length} market(s) skipped for PriceUnavailable, retrying`);
    return true;
  }

  /** Single aggregate3 read; repeats only while the chain clock has not reached the boundary yet. */
  private async readSnapshot(boundary: number, deadlineMs: number): Promise<BoundarySnapshot> {
    for (;;) {
      const snap = await readBoundary(this.publicClient, this.market, this.staticMarkets, boundary);
      const skew = Math.floor(Date.now() / 1000) - snap.chainTime;
      if (Math.abs(skew) > 2) log("warn", "clock skew between keeper and chain", { skewSeconds: skew });
      if (snap.chainTime >= boundary) return snap;
      if (Date.now() >= deadlineMs) throw new Error(`chain time ${snap.chainTime} never reached boundary ${boundary}`);
      await sleep(500, this.stop.signal);
    }
  }

  /**
   * Push fresh prices to every price source the due rounds read: the current source plus any older source still
   * referenced by the snapshot of a round to lock or close at this boundary (taken from the same multicall read).
   */
  private async pushPrices(boundary: number, due: MarketInfo[], snap: BoundarySnapshot, deadlineMs: number, attempt: number): Promise<void> {
    const byAsset = new Map<Hex, string>();
    for (const m of due) byAsset.set(m.assetId, m.symbol);
    const assetIds = [...byAsset.keys()];
    const symbols = [...byAsset.values()];

    const sources = new Set<string>([snap.priceSource.toLowerCase()]);
    for (const r of snap.rounds.values()) {
      if (r.status === ROUND_PENDING || r.status === ROUND_LOCKED) sources.add(r.priceSource.toLowerCase());
    }

    const prices = await fetchPrices(this.cfg.hlInfoUrl, symbols, this.cfg.hlPriceField, this.cfg.coinOverrides, this.cfg.httpTimeoutMs);
    if (prices.observedAt < boundary) throw new Error(`local clock ${prices.observedAt} is behind boundary ${boundary}`);
    const values = symbols.map((s) => {
      const p = prices.prices.get(s);
      if (p === undefined) throw new Error(`missing price for ${s}`);
      return p;
    });
    const raw = Object.fromEntries(prices.raw);

    for (const source of sources as Set<Address>) {
      if (!(await this.isPusher(source))) {
        log("warn", "no PRICE_PUSHER_ROLE on a snapshot price source, its rounds will void", { source });
        continue;
      }
      const args = [assetIds, values, BigInt(prices.observedAt)] as const;
      if (this.cfg.dryRun) {
        await this.publicClient.simulateContract({ account: this.account, address: source, abi: keeperSignedPriceSourceAbi, functionName: "pushPrices", args });
        log("info", "dry run: would push prices", { boundary, source, observedAt: prices.observedAt, prices: raw });
        continue;
      }
      const hash = await this.walletClient.writeContract({ address: source, abi: keeperSignedPriceSourceAbi, functionName: "pushPrices", args });
      const receipt = await this.waitReceipt(hash, deadlineMs);
      log("info", "prices pushed", { boundary, attempt, source, tx: hash, gasUsed: receipt.gasUsed, observedAt: prices.observedAt, prices: raw });
    }
  }

  /** PRICE_PUSHER_ROLE check, cached per source (the current source is checked at startup). */
  private async isPusher(source: Address): Promise<boolean> {
    const key = source.toLowerCase();
    const cached = this.pusherBySource.get(key);
    if (cached !== undefined) return cached;
    let ok = false;
    try {
      ok = await this.publicClient.readContract({
        address: source,
        abi: keeperSignedPriceSourceAbi,
        functionName: "hasRole",
        args: [PRICE_PUSHER_ROLE, this.account.address],
      });
    } catch {
      ok = false; // not a keeper signed source (for example the HyperCore precompile adapter)
    }
    this.pusherBySource.set(key, ok);
    return ok;
  }

  private async loadStaticMarkets(): Promise<void> {
    const ids = (await this.publicClient.readContract({ address: this.market, abi: predictionMarketAbi, functionName: "getMarketIds" })) as readonly Hex[];
    const rows = (await this.publicClient.multicall({
      contracts: ids.map((id) => ({ address: this.market, abi: predictionMarketAbi, functionName: "markets", args: [id] })) as never,
      allowFailure: false,
      batchSize: 0,
    })) as unknown as readonly (readonly [Hex, number])[];
    this.staticMarkets = rows.map(([assetId, interval], i) => ({
      id: ids[i] as Hex,
      assetId,
      symbol: assetIdToSymbol(assetId),
      interval: Number(interval),
    }));
  }

  private async checkBalance(): Promise<void> {
    this.lastBalanceCheck = Date.now();
    const balance = await this.publicClient.getBalance({ address: this.account.address });
    if (balance < this.cfg.minBalanceWei) {
      log("warn", "low keeper balance: top up HYPE for gas", {
        keeper: this.account.address,
        balanceHype: formatEther(balance),
        thresholdHype: formatEther(this.cfg.minBalanceWei),
      });
    } else {
      log("info", "keeper balance", { balanceHype: formatEther(balance) });
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
