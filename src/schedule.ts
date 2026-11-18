import type { Hex } from "viem";

/** The keeper wakes on every 5 minute UTC boundary, which also covers the 15 and 30 minute ones. */
export const BASE_INTERVAL = 300;

export interface MarketInfo {
  id: Hex;
  assetId: Hex;
  symbol: string;
  interval: number;
  active: boolean;
  lastBoundary: number;
}

export function nextBoundary(nowSec: number, interval = BASE_INTERVAL): number {
  return Math.floor(nowSec / interval) * interval + interval;
}

/**
 * Markets that must be executed at `boundary`: the boundary is aligned with the market interval and was not executed
 * yet. Inactive markets are included because rounds opened before deactivation still lock and close normally.
 */
export function selectDue(markets: MarketInfo[], boundary: number): MarketInfo[] {
  return markets.filter((m) => boundary % m.interval === 0 && m.lastBoundary !== boundary);
}

export interface OnceTarget {
  /** Boundary this pass handles. */
  target: number;
  /** True when the pass arrived after `target` (inside its execution window) and handles it immediately. */
  late: boolean;
  /** The boundary before the next one, checked for rounds with bets that were never executed. */
  previous: number | undefined;
}

/**
 * Target of a single CI pass started at `nowSec`. If the execution window of the current boundary is still open,
 * the pass handles it right away (a late runner); otherwise it waits for the next boundary and checks the current
 * one for missed rounds with bets.
 */
export function chooseOnceTarget(nowSec: number, windowSec: number, interval = BASE_INTERVAL): OnceTarget {
  const current = Math.floor(nowSec / interval) * interval;
  if (nowSec - current <= windowSec) return { target: current, late: nowSec > current, previous: undefined };
  return { target: current + interval, late: false, previous: current };
}

/** Exponential backoff: 500 ms, 1 s, 2 s, then 4 s. */
export function backoffMs(attempt: number, baseMs = 500, maxMs = 4000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, Math.max(0, ms));
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
