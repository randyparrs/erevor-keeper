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

/**
 * Pyth feeds the Hermes stream must carry for `boundary`, decided before the boundary from a snapshot taken a few
 * seconds earlier: the assets of due markets that hold a round with bets, plus the assets of due active markets (they
 * can still receive a bet until the boundary, and they are the markets refreshed when idle). Inactive markets without
 * bets are left out, so the signed update carries fewer feeds and every per asset Pyth call is cheaper.
 */
export function streamFeedsFor(snap: BoundarySnapshot, boundary: number, feedIds: Record<string, `0x${string}`>): `0x${string}`[] {
  const out: `0x${string}`[] = [];
  for (const m of selectDue(snap.markets, boundary)) {
    if (!m.active && !hasOpenRound(snap, m, boundary)) continue;
    const feed = feedIds[m.symbol];
    if (feed && !out.includes(feed)) out.push(feed);
  }
  return out;
}

/**
 * Markets of a plan that are actually executed: active markets, and inactive markets that still hold a Pending or
 * Locked round with bets (so those rounds lock and close normally). An inactive market without bets is never executed:
 * the circuit breaker reference is kept per asset, so executing the active market of the asset refreshes it.
 */
export function executableMarkets(markets: MarketInfo[], snap: BoundarySnapshot, boundary: number): MarketInfo[] {
  return markets.filter((m) => m.active || hasOpenRound(snap, m, boundary));
}
