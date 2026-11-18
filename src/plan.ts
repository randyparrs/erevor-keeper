// Idle mode: decide, from the multicall snapshot alone (no gas), what a boundary needs.

import type { BoundarySnapshot } from "./boundary-read.js";
import { roundIdOf } from "./ids.js";
import { selectDue, type MarketInfo } from "./schedule.js";

const ROUND_PENDING = 1;
const ROUND_LOCKED = 2;

export type PlanMode = "active" | "refresh" | "idle";

export interface BoundaryPlan {
  /** "active": markets with open rounds only; "refresh": every due market; "idle": no transaction. */
  mode: PlanMode;
  /** Markets to execute in this boundary. */
  execute: MarketInfo[];
  /** Due markets in this boundary. */
  due: number;
  /** Due markets holding a round with bets to lock (Pending at the boundary) or to close (Locked one interval ago). */
  marketsWithBets: number;
}

/** Rounds only exist once they hold a bet, so a Pending or Locked round always has bets. */
export function hasOpenRound(snap: BoundarySnapshot, market: MarketInfo, boundary: number): boolean {
  const lock = snap.rounds.get(roundIdOf(market.id, boundary));
  const close = snap.rounds.get(roundIdOf(market.id, boundary - market.interval));
  return lock?.status === ROUND_PENDING || close?.status === ROUND_LOCKED;
}

/**
 * - Rounds with bets always lock and close on time: their markets are executed at every boundary.
 * - With idle mode on and nothing to settle, a transaction is sent only at refresh boundaries (every
 *   `refreshSeconds`, 30 minutes by default) to keep the circuit breaker reference of every asset fresh.
 * - With idle mode off, every due market is executed at every boundary.
 */
export function planBoundary(snap: BoundarySnapshot, boundary: number, idleMode: boolean, refreshSeconds: number): BoundaryPlan {
  const due = selectDue(snap.markets, boundary);
  const withBets = due.filter((m) => hasOpenRound(snap, m, boundary));
  const base = { due: due.length, marketsWithBets: withBets.length };
  if (!idleMode) return { ...base, mode: "active", execute: due };
  if (boundary % refreshSeconds === 0) return { ...base, mode: "refresh", execute: due };
  if (withBets.length > 0) return { ...base, mode: "active", execute: withBets };
  return { ...base, mode: "idle", execute: [] };
}
