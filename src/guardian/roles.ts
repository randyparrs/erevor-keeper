// Guardian roles, one pass each (GitHub Actions):
//   relayer    reviews every open dispute on GenLayer, then carries the FINALIZED verdict to GuardianReceiver
//              (VALID applied at once, VOID after the veto delay, which it also executes once due).
//   vigilante  after each close compares the recorded lock and close prices with the exchange medians (the guardian
//              rule) and opens a dispute when the rule says VOID. It holds no veto power: the vetoer runs apart, in
//              the erevor-vetoer Cloudflare Worker (vetoer/), so the relayer and the vetoer never share a platform.
// Any error is logged at error level, so the pass exits with code 1 and GitHub notifies.

import {
  createPublicClient,
  createWalletClient,
  custom,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { guardianReceiverAbi, predictionMarketAbi, predictionMarketLensAbi } from "../abi.js";
import { assetIdToSymbol } from "../ids.js";
import { log } from "../log.js";
import { logRpcEvent, makeChain } from "../keeper.js";
import { RpcProvider } from "../rpc.js";
import { GuardianGL, type ReviewRecord } from "./genlayer.js";
import { TOLERANCE_BPS, decide, direction, fetchPrices, type Outcome } from "./rule.js";
import { STATUS_DISPUTED, STATUS_NONE, candidateRounds, closesToCheck, planRelayer, type MarketRef, type PendingVoidView } from "./scan.js";

/** Bytes of calldata per Multicall3 call: about 100 round reads, well under any eth_call gas cap. */
const MULTICALL_BATCH_BYTES = 8_192;
const VERDICT_VALID = 0;
const VERDICT_VOID = 1;
const PRICE_DECIMALS = 18;
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function faucet(address,uint256)",
]);

export interface GuardianConfig {
  rpcUrl: string;
  /** Used only after the primary RPC failed its retries. Must not be the vetoer Worker's provider. */
  rpcFallbackUrl?: string;
  chainId: number;
  market: Address;
  lens: Address;
  receiver: Address;
  guardianGL: Hex;
  glNode?: string;
  lookbackMinutes: number;
  maxWaitFinalMs: number;
}

export interface RoundView {
  marketId: Hex;
  configHash: Hex;
  start: bigint;
  interval: number;
  status: number;
  lockPrice: bigint;
  closePrice: bigint;
  upAmount: bigint;
  downAmount: bigint;
  claimableAt: bigint;
}

/** The review arguments for a round, exactly as recorded by the market. */
export function reviewInputs(roundId: Hex, asset: string, r: RoundView): [string, string, number, number, string, string, string, number] {
  const lockTs = Number(r.start);
  return [roundId.toLowerCase(), asset, lockTs, lockTs + r.interval, r.lockPrice.toString(), r.closePrice.toString(), direction(r.lockPrice, r.closePrice), PRICE_DECIMALS];
}

/**
 * Why a VOID review does not back a VOID for this round, or undefined when it does: a FINALIZED review for this round
 * with verdict VOID and exactly the recorded asset, timestamps and prices. The relayer refuses to propose a VOID
 * otherwise; the vetoer Worker (vetoer/src/core.js) applies the same rule on its own.
 */
export function vetoReason(review: ReviewRecord | undefined, roundId: Hex, asset: string, r: RoundView): string | undefined {
  if (!review) return "no finalized review for this round on GenLayer";
  if (review.round_id.toLowerCase() !== roundId.toLowerCase()) return "review is for another round";
  if (review.result.verdict !== "VOID") return `the review verdict is ${review.result.verdict}, not VOID`;
  const [, a, lockTs, closeTs, lockPrice, closePrice, outcome] = reviewInputs(roundId, asset, r);
  const i = review.inputs;
  if (i.asset !== a) return `asset ${i.asset} differs from ${a}`;
  if (i.lock_ts !== lockTs || i.close_ts !== closeTs) return "timestamps differ from the round";
  if (i.lock_price !== lockPrice || i.close_price !== closePrice) return "prices differ from the recorded ones";
  if (i.outcome !== outcome || i.price_decimals !== PRICE_DECIMALS) return "outcome or decimals differ";
  return undefined;
}

/** Reference of a review whose GenLayer transaction hash is not known in this pass: keccak256 of the stored JSON. */
export function reviewRef(review: ReviewRecord): Hex {
  return keccak256(toHex(JSON.stringify(review)));
}

/** RPC of the guardian roles: the primary with 2 retries and backoff, then the fallback with the same, then the error. */
export function guardianRpc(cfg: Pick<GuardianConfig, "rpcUrl" | "rpcFallbackUrl">, overrides: Partial<ConstructorParameters<typeof RpcProvider>[0]> = {}): RpcProvider {
  return new RpcProvider({
    primaryUrl: cfg.rpcUrl,
    fallbackUrl: cfg.rpcFallbackUrl,
    timeoutMs: 15_000,
    maxRetries: 2,
    baseDelayMs: 500,
    maxDelayMs: 4_000,
    defaultBudgetMs: 60_000,
    onEvent: logRpcEvent,
    ...overrides,
  });
}

class Base {
  readonly pub: PublicClient;
  readonly chain;
  private readonly transport;

  constructor(readonly cfg: GuardianConfig) {
    this.chain = makeChain(cfg.chainId, cfg.rpcUrl);
    const rpc = guardianRpc(cfg);
    this.transport = custom({ request: (a) => rpc.request(a) }, { retryCount: 0 });
    this.pub = createPublicClient({ chain: this.chain, transport: this.transport }) as PublicClient;
  }

  wallet(key: Hex) {
    return createWalletClient({ chain: this.chain, transport: this.transport, account: privateKeyToAccount(key) });
  }

  async round(roundId: Hex): Promise<RoundView> {
    return (await this.pub.readContract({ address: this.cfg.lens, abi: predictionMarketLensAbi, functionName: "getRound", args: [roundId] })) as unknown as RoundView;
  }

  async assetOf(r: RoundView): Promise<string> {
    const m = (await this.pub.readContract({ address: this.cfg.lens, abi: predictionMarketLensAbi, functionName: "getMarket", args: [r.marketId] })) as { assetId: Hex };
    return assetIdToSymbol(m.assetId);
  }

  /** Timestamp of the latest block: the chain clock, not the runner's. */
  async chainNow(): Promise<number> {
    return Number((await this.pub.getBlock()).timestamp);
  }

  private async multicall(contracts: any[]): Promise<any[]> {
    if (contracts.length === 0) return [];
    return this.pub.multicall({ contracts, allowFailure: false, batchSize: MULTICALL_BATCH_BYTES } as any) as Promise<any[]>;
  }

  /** Every market of the lens (inactive ones too: their recent rounds can still be disputed). */
  async markets(): Promise<MarketRef[]> {
    const ids = (await this.pub.readContract({ address: this.cfg.lens, abi: predictionMarketLensAbi, functionName: "getMarketIds" })) as Hex[];
    const ms = await this.multicall(ids.map((id) => ({ address: this.cfg.lens, abi: predictionMarketLensAbi, functionName: "getMarket", args: [id] })));
    return ids.map((marketId, i) => ({ marketId, interval: Number(ms[i].interval), exists: ms[i].exists })).filter((m) => m.exists);
  }

  /** Rounds that closed in the last `minutes` (by computed round id), read with Multicall3; rounds never opened are skipped. */
  async roundsClosedWithin(minutes: number, now: number): Promise<{ roundId: Hex; round: RoundView }[]> {
    const cands = candidateRounds(await this.markets(), now, minutes * 60);
    const rs = await this.multicall(cands.map((c) => ({ address: this.cfg.lens, abi: predictionMarketLensAbi, functionName: "getRound", args: [c.roundId] })));
    return cands.map((c, i) => ({ roundId: c.roundId, round: rs[i] as RoundView })).filter((x) => x.round.status !== STATUS_NONE);
  }

  /** GuardianReceiver.pendingVoid of each round, keyed by lower case round id. */
  async pendingVoids(roundIds: Hex[]): Promise<Map<string, PendingVoidView>> {
    const ps = await this.multicall(roundIds.map((id) => ({ address: this.cfg.receiver, abi: guardianReceiverAbi, functionName: "pendingVoid", args: [id] })));
    return new Map(roundIds.map((id, i) => [id.toLowerCase(), { executeAfter: BigInt(ps[i][0]), genlayerTxRef: ps[i][1] as Hex }]));
  }

  async send(key: Hex, address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]) {
    const w = this.wallet(key);
    const hash = await w.writeContract({ address, abi: abi as any, functionName, args, chain: this.chain } as any);
    const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
    return hash;
  }
}

export class Relayer extends Base {
  constructor(
    cfg: GuardianConfig,
    private readonly key: Hex,
  ) {
    super(cfg);
  }

  async run(): Promise<void> {
    const me = privateKeyToAccount(this.key).address;
    const gl = new GuardianGL(this.cfg.guardianGL, me, this.key, this.cfg.glNode);
    const now = await this.chainNow();
    const rounds = await this.roundsClosedWithin(this.cfg.lookbackMinutes, now);
    const disputed = rounds.filter((x) => x.round.status === STATUS_DISPUTED);
    const plan = planRelayer(disputed, await this.pendingVoids(disputed.map((x) => x.roundId)), now);
    log("info", "relayer pass", { relayer: me, roundsRead: rounds.length, disputed: disputed.length, toReview: plan.review.length, voidsDue: plan.execute.length, voidsWaiting: plan.waiting.length });
    for (const x of plan.execute) {
      try {
        const tx = await this.send(this.key, this.cfg.receiver, guardianReceiverAbi, "executeVerdict", [x.roundId]);
        log("warn", "VOID executed after the veto delay", { roundId: x.roundId, genlayerTxRef: x.pending.genlayerTxRef, tx });
      } catch (err) {
        log("error", "relayer failed to execute a VOID", { roundId: x.roundId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    for (const x of plan.review) {
      try {
        await this.handle(x.roundId, x.round, gl, now);
      } catch (err) {
        log("error", "relayer failed on a dispute", { roundId: x.roundId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /** A disputed round with no VOID pending: review on GenLayer if needed, then propose the FINALIZED verdict. */
  private async handle(roundId: Hex, r: RoundView, gl: GuardianGL, nowSeconds: number): Promise<void> {
    const now = BigInt(nowSeconds);
    const asset = await this.assetOf(r);
    let review = await gl.finalReview(roundId);
    let ref: Hex | undefined;
    if (!review || review.result.verdict === "INCONCLUSIVE") {
      const hash = await gl.sendReview(reviewInputs(roundId, asset, r));
      log("info", "guardian review sent to GenLayer", { roundId, genlayerTx: hash });
      const fin = await gl.waitFinal(hash, this.cfg.maxWaitFinalMs);
      if (!fin.final) {
        log("error", "REVIEW_NOT_FINAL", { roundId, genlayerTx: hash, status: fin.status, note: "the next pass reads it once FINALIZED" });
        return;
      }
      review = await gl.finalReview(roundId);
      ref = hash;
    }
    if (!review) throw new Error("review missing after FINALIZED");
    const dispute = (await this.pub.readContract({ address: this.cfg.lens, abi: predictionMarketLensAbi, functionName: "getDispute", args: [roundId] })) as { timeoutAt: bigint };
    if (review.result.verdict === "INCONCLUSIVE") {
      const left = Number(dispute.timeoutAt - now);
      log(left < 3600 ? "error" : "warn", "review INCONCLUSIVE, dispute unresolved", { roundId, secondsToTimeout: left, sources: review.result });
      return;
    }
    // The relayer only carries a review made with the recorded prices.
    if (review.result.verdict === "VOID" && vetoReason(review, roundId, asset, r)) {
      throw new Error(`stored review does not match the round: ${vetoReason(review, roundId, asset, r)}`);
    }
    const verdict = review.result.verdict === "VOID" ? VERDICT_VOID : VERDICT_VALID;
    const tx = await this.send(this.key, this.cfg.receiver, guardianReceiverAbi, "proposeVerdict", [roundId, verdict, ref ?? reviewRef(review)]);
    log(verdict === VERDICT_VOID ? "warn" : "info", "verdict proposed", { roundId, verdict: review.result.verdict, genlayerTxRef: ref ?? reviewRef(review), tx });
  }
}

export class Vigilante extends Base {
  constructor(
    cfg: GuardianConfig,
    private readonly vigilanteKey: Hex,
  ) {
    super(cfg);
  }

  async run(): Promise<void> {
    const closesSeen = await this.watchCloses();
    log("info", "vigilante pass", { vigilante: privateKeyToAccount(this.vigilanteKey).address, closesSeen });
  }

  /** Disputes a just closed round when the guardian rule, applied to the exchange data, says VOID. */
  private async watchCloses(): Promise<number> {
    const now = await this.chainNow();
    const rounds = await this.roundsClosedWithin(this.cfg.lookbackMinutes, now);
    const configs = new Map<string, boolean>();
    for (const { roundId, round: r } of closesToCheck(rounds, now)) {
      try {
        if (!configs.has(r.configHash)) {
          const c = (await this.pub.readContract({ address: this.cfg.lens, abi: predictionMarketLensAbi, functionName: "getConfig", args: [r.configHash] })) as { disputesEnabled: boolean };
          configs.set(r.configHash, c.disputesEnabled);
        }
        if (!configs.get(r.configHash)) continue;
        const asset = await this.assetOf(r);
        const tol = TOLERANCE_BPS[asset];
        if (tol === undefined) continue;
        const lockTs = Number(r.start);
        const [lockPrices, closePrices] = await Promise.all([fetchPrices(asset, lockTs, PRICE_DECIMALS), fetchPrices(asset, lockTs + r.interval, PRICE_DECIMALS)]);
        const d = decide(tol, r.lockPrice, r.closePrice, direction(r.lockPrice, r.closePrice) as Outcome, lockPrices, closePrices);
        const fields = { roundId, asset, verdict: d.verdict, lockSources: d.lockSources, closeSources: d.closeSources, deviationLockBps: d.deviationLockBps, deviationCloseBps: d.deviationCloseBps };
        if (d.verdict === "VOID") {
          const tx = await this.openDispute(roundId);
          log("warn", "DISPUTE_OPENED: recorded prices disagree with the exchange medians", { ...fields, tx });
        } else if (d.verdict === "INCONCLUSIVE") {
          log("warn", "close check inconclusive: fewer than 3 sources answered", fields);
        } else {
          log("info", "close checked", fields);
        }
      } catch (err) {
        log("error", "vigilante failed on a close", { roundId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return rounds.length;
  }

  private async openDispute(roundId: Hex): Promise<Hex> {
    const me = privateKeyToAccount(this.vigilanteKey).address;
    const token = (await this.pub.readContract({ address: this.cfg.market, abi: predictionMarketAbi, functionName: "stakeToken" })) as Address;
    const bond = (await this.pub.readContract({ address: this.cfg.market, abi: predictionMarketAbi, functionName: "bondFor", args: [roundId] })) as bigint;
    const balance = (await this.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [me] })) as bigint;
    // Testnet stake token: the vigilante mints its own bond from the capped faucet.
    if (balance < bond) await this.send(this.vigilanteKey, token, erc20Abi, "faucet", [me, bond - balance]);
    const allowance = (await this.pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [me, this.cfg.market] })) as bigint;
    if (allowance < bond) await this.send(this.vigilanteKey, token, erc20Abi, "approve", [this.cfg.market, 2n ** 256n - 1n]);
    return this.send(this.vigilanteKey, this.cfg.market, predictionMarketAbi, "dispute", [roundId]);
  }
}
