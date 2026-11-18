import { parseEventLogs, type Hex, type Log } from "viem";
import { predictionMarketAbi } from "./abi.js";
import { log } from "./log.js";
import { assetIdToSymbol } from "./prices.js";

export const SKIP_REASONS = ["UnknownMarket", "OutsideWindow", "AlreadyExecuted", "PriceUnavailable"] as const;
export const VOID_REASONS = ["MissedLock", "MissedClose", "DisputeVoid", "PriceRejected", "PriceUnavailable"] as const;

export interface ExecutionSummary {
  skipped: { market: Hex; reason: string }[];
  rejected: { asset: string; previous: string; rejected: string; timestamp: number }[];
  pending: { asset: string; pendingReference: string; count: number }[];
  rebased: { asset: string; oldReference: string; newReference: string; timestamp: number }[];
  voided: { roundId: Hex; reason: string }[];
  locked: number;
  closed: number;
}

/**
 * Decode the market events of an executeBoundary receipt: MarketSkipped, PriceRejected, RebasePending, PriceRebased,
 * RoundVoided, RoundLocked and RoundClosed. Logs of other contracts are ignored.
 */
export function summarizeLogs(logs: Log[], market: string): ExecutionSummary {
  const events = parseEventLogs({
    abi: predictionMarketAbi,
    logs: logs.filter((l) => l.address.toLowerCase() === market.toLowerCase()),
    eventName: ["MarketSkipped", "PriceRejected", "RebasePending", "PriceRebased", "RoundVoided", "RoundLocked", "RoundClosed"],
  });
  const s: ExecutionSummary = { skipped: [], rejected: [], pending: [], rebased: [], voided: [], locked: 0, closed: 0 };
  for (const e of events) {
    switch (e.eventName) {
      case "MarketSkipped":
        s.skipped.push({ market: e.args.marketId, reason: SKIP_REASONS[e.args.reason] ?? String(e.args.reason) });
        break;
      case "PriceRejected":
        s.rejected.push({
          asset: assetIdToSymbol(e.args.assetId),
          previous: e.args.previous.toString(),
          rejected: e.args.rejected.toString(),
          timestamp: Number(e.args.timestamp),
        });
        break;
      case "RebasePending":
        s.pending.push({
          asset: assetIdToSymbol(e.args.assetId),
          pendingReference: e.args.pendingReference.toString(),
          count: Number(e.args.count),
        });
        break;
      case "PriceRebased":
        s.rebased.push({
          asset: assetIdToSymbol(e.args.assetId),
          oldReference: e.args.oldReference.toString(),
          newReference: e.args.newReference.toString(),
          timestamp: Number(e.args.timestamp),
        });
        break;
      case "RoundVoided":
        s.voided.push({ roundId: e.args.roundId, reason: VOID_REASONS[e.args.reason] ?? String(e.args.reason) });
        break;
      case "RoundLocked":
        s.locked++;
        break;
      case "RoundClosed":
        s.closed++;
        break;
    }
  }
  return s;
}

/** One structured log line per notable event. */
export function logSummary(s: ExecutionSummary): void {
  for (const x of s.skipped) log("warn", "market skipped", x);
  for (const x of s.rejected) log("warn", "price rejected by circuit breaker", x);
  for (const x of s.pending) log("warn", "rebase pending: new price level awaiting confirmation", x);
  for (const x of s.rebased) log("warn", "price rebased: new reference level confirmed", x);
  for (const x of s.voided) log("warn", "round voided", x);
}
