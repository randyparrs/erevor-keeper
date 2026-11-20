// Guardian roles, one pass each (GitHub Actions):
//   relayer    reviews every open dispute on GenLayer, then carries the FINALIZED verdict to GuardianReceiver
//              (VALID applied at once, VOID after the veto delay, which it also executes once due).
//   vigilante  after each close compares the recorded lock and close prices with the exchange medians (the guardian
//              rule) and opens a dispute when the rule says VOID; as the vetoer it checks every pending VOID against
//              the review stored on GenLayer and vetoes any VOID that does not match it.
// Any error is logged at error level, so the pass exits with code 1 and GitHub notifies.

import {
  createPublicClient,
  createWalletClient,
  http,
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
import { makeChain } from "../keeper.js";
import { GuardianGL, type ReviewRecord } from "./genlayer.js";
import { TOLERANCE_BPS, decide, direction, fetchPrices, type Outcome } from "./rule.js";

const STATUS_CLOSED = 3;
const STATUS_DISPUTED = 4;
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
 * Why a pending VOID must be vetoed, or undefined when the review stored on GenLayer backs it: a FINALIZED review
 * for this round with verdict VOID and exactly the recorded asset, timestamps and prices.
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

class Base {
  readonly pub: PublicClient;
  readonly chain;

  constructor(readonly cfg: GuardianConfig) {
    this.chain = makeChain(cfg.chainId, cfg.rpcUrl);
    this.pub = createPublicClient({ chain: this.chain, transport: http(cfg.rpcUrl) }) as PublicClient;
  }

  wallet(key: Hex) {
    return createWalletClient({ chain: this.chain, transport: http(this.cfg.rpcUrl), account: privateKeyToAccount(key) });
  }

  async round(roundId: Hex): Promise<RoundView> {
    return (await this.pub.readContract({ address: this.cfg.lens, abi: predictionMarketLensAbi, functionName: "getRound", args: [roundId] })) as unknown as RoundView;
  }

  async assetOf(r: RoundView): Promise<string> {
    const m = (await this.pub.readContract({ address: this.cfg.lens, abi: predictionMarketLensAbi, functionName: "getMarket", args: [r.marketId] })) as { assetId: Hex };
    return assetIdToSymbol(m.assetId);
  }

  /** Logs of `event` from `address` over the last `minutes`, in chunks (Arbitrum blocks are about 0.25 s). */
  async recentLogs(address: Address, abi: readonly unknown[], eventName: string, minutes: number) {
    const latest = await this.pub.getBlockNumber();
    const span = BigInt(Math.ceil((minutes * 60) / 0.2));
    const from = latest > span ? latest - span : 0n;
    const event = (abi as any[]).find((x) => x.type === "event" && x.name === eventName);
    const out: any[] = [];
    for (let start = from; start <= latest; start += 200_000n) {
      const end = start + 199_999n > latest ? latest : start + 199_999n;
      out.push(...(await this.pub.getLogs({ address, event, fromBlock: start, toBlock: end } as any)));
    }
    return out;
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
    const disputes = await this.recentLogs(this.cfg.market, predictionMarketAbi, "RoundDisputed", this.cfg.lookbackMinutes);
    const ids = [...new Set(disputes.map((l) => l.args.roundId as Hex))];
    log("info", "relayer pass", { relayer: me, disputesSeen: ids.length });
    for (const roundId of ids) {
      try {
        await this.handle(roundId, gl);
      } catch (err) {
        log("error", "relayer failed on a dispute", { roundId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private async handle(roundId: Hex, gl: GuardianGL): Promise<void> {
    const r = await this.round(roundId);
    if (r.status !== STATUS_DISPUTED) return;
    const [executeAfter] = (await this.pub.readContract({ address: this.cfg.receiver, abi: guardianReceiverAbi, functionName: "pendingVoid", args: [roundId] })) as readonly [bigint, Hex];
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (executeAfter !== 0n) {
      if (now >= executeAfter) {
        const tx = await this.send(this.key, this.cfg.receiver, guardianReceiverAbi, "executeVerdict", [roundId]);
        log("warn", "VOID executed after the veto delay", { roundId, tx });
      }
      return;
    }
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
    private readonly vetoerKey: Hex,
  ) {
    super(cfg);
  }

  async run(): Promise<void> {
    const closesSeen = await this.watchCloses();
    const voidProposalsSeen = await this.watchVoids();
    log("info", "vigilante pass", {
      vigilante: privateKeyToAccount(this.vigilanteKey).address,
      vetoer: privateKeyToAccount(this.vetoerKey).address,
      closesSeen,
      voidProposalsSeen,
    });
  }

  /** Disputes a just closed round when the guardian rule, applied to the exchange data, says VOID. */
  private async watchCloses(): Promise<number> {
    const closes = await this.recentLogs(this.cfg.market, predictionMarketAbi, "RoundClosed", this.cfg.lookbackMinutes);
    const now = BigInt(Math.floor(Date.now() / 1000));
    for (const l of closes) {
      const roundId = l.args.roundId as Hex;
      try {
        const r = await this.round(roundId);
        if (r.status !== STATUS_CLOSED || now >= r.claimableAt || r.upAmount === 0n || r.downAmount === 0n) continue;
        const cfg = (await this.pub.readContract({ address: this.cfg.lens, abi: predictionMarketLensAbi, functionName: "getConfig", args: [r.configHash] })) as { disputesEnabled: boolean };
        if (!cfg.disputesEnabled) continue;
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
    return closes.length;
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

  /** Vetoes every pending VOID that the review stored on GenLayer does not back. */
  private async watchVoids(): Promise<number> {
    const me = privateKeyToAccount(this.vetoerKey).address;
    const gl = new GuardianGL(this.cfg.guardianGL, me, undefined, this.cfg.glNode);
    const delay = (await this.pub.readContract({ address: this.cfg.receiver, abi: guardianReceiverAbi, functionName: "vetoDelay" })) as bigint;
    const proposals = await this.recentLogs(this.cfg.receiver, guardianReceiverAbi, "VerdictProposed", Number(delay) / 60 + this.cfg.lookbackMinutes);
    for (const l of proposals) {
      if (Number(l.args.verdict) !== VERDICT_VOID) continue;
      const roundId = l.args.roundId as Hex;
      try {
        const [executeAfter] = (await this.pub.readContract({ address: this.cfg.receiver, abi: guardianReceiverAbi, functionName: "pendingVoid", args: [roundId] })) as readonly [bigint, Hex];
        if (executeAfter === 0n) continue;
        const r = await this.round(roundId);
        const reason = vetoReason(await gl.finalReview(roundId), roundId, await this.assetOf(r), r);
        if (reason === undefined) {
          log("info", "pending VOID matches the GenLayer review", { roundId, genlayerTxRef: l.args.genlayerTxRef });
          continue;
        }
        const tx = await this.send(this.vetoerKey, this.cfg.receiver, guardianReceiverAbi, "vetoVerdict", [roundId]);
        log("error", "VETO", { roundId, reason, genlayerTxRef: l.args.genlayerTxRef, tx });
      } catch (err) {
        log("error", "vetoer failed on a pending VOID", { roundId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return proposals.filter((l) => Number(l.args.verdict) === VERDICT_VOID).length;
  }
}
