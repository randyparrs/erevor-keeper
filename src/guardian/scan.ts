// Round discovery without eth_getLogs: the round ids of every market are computed locally from the market id and the
// round start (roundId = keccak256(abi.encode(marketId, start)), starts aligned to the interval), and the rounds are
// read with Multicall3 at the latest block. Only state reads (eth_call), which every RPC plan serves.

import type { Hex } from "viem";
import { roundIdOf } from "../ids.js";

export const STATUS_NONE = 0;
export const STATUS_CLOSED = 3;
export const STATUS_DISPUTED = 4;

export interface MarketRef {
  marketId: Hex;
  interval: number;
}

export interface Candidate {
  roundId: Hex;
  marketId: Hex;
  start: number;
  interval: number;
  closeAt: number;
}

/** Rounds of every market whose close boundary is in (now - windowSeconds, now]. */
export function candidateRounds(markets: MarketRef[], now: number, windowSeconds: number): Candidate[] {
  const out: Candidate[] = [];
  for (const m of markets) {
    if (!(m.interval > 0)) continue;
    for (let closeAt = Math.floor(now / m.interval) * m.interval; closeAt > now - windowSeconds; closeAt -= m.interval) {
      const start = closeAt - m.interval;
      out.push({ roundId: roundIdOf(m.marketId, start), marketId: m.marketId, start, interval: m.interval, closeAt });
    }
  }
  return out;
}

export interface PendingVoidView {
  executeAfter: bigint;
  genlayerTxRef: Hex;
}

export interface RelayerPlan<R> {
  /** Disputed, no VOID pending: request or read the GenLayer review, then propose. */
  review: { roundId: Hex; round: R }[];
  /** VOID pending and past its veto delay: executeVerdict. */
  execute: { roundId: Hex; round: R; pending: PendingVoidView }[];
  /** VOID pending inside its veto delay: nothing to do yet. */
  waiting: { roundId: Hex; round: R; pending: PendingVoidView }[];
}

/** What the relayer does with each disputed round, from the multicall reads alone. */
export function planRelayer<R extends { status: number }>(
  rounds: { roundId: Hex; round: R }[],
  pendings: Map<string, PendingVoidView>,
  now: number,
): RelayerPlan<R> {
  const plan: RelayerPlan<R> = { review: [], execute: [], waiting: [] };
  for (const x of rounds) {
    if (x.round.status !== STATUS_DISPUTED) continue;
    const p = pendings.get(x.roundId.toLowerCase());
    if (!p || p.executeAfter === 0n) plan.review.push(x);
    else if (BigInt(now) >= p.executeAfter) plan.execute.push({ ...x, pending: p });
    else plan.waiting.push({ ...x, pending: p });
  }
  return plan;
}

/** Closed rounds the vigilante checks: still inside the dispute window, with bets on both sides. */
export function closesToCheck<R extends { status: number; claimableAt: bigint; upAmount: bigint; downAmount: bigint }>(
  rounds: { roundId: Hex; round: R }[],
  now: number,
): { roundId: Hex; round: R }[] {
  return rounds.filter(
    (x) => x.round.status === STATUS_CLOSED && BigInt(now) < x.round.claimableAt && x.round.upAmount > 0n && x.round.downAmount > 0n,
  );
}
