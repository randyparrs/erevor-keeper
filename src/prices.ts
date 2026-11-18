import { hexToBytes, type Hex } from "viem";
import type { PriceField } from "./config.js";

/** Decimals of prices pushed to KeeperSignedPriceSource (PRICE_DECIMALS in the contract). */
export const PUSH_DECIMALS = 18;

/** Convert a plain decimal string such as "64320.5" to an integer scaled by 10**decimals, without floats. */
export function decimalToUnits(value: string, decimals = PUSH_DECIMALS): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Invalid decimal price "${value}"`);
  const [whole = "0", frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    // Truncate extra precision (never happens with 18 decimals and Hyperliquid prices).
    return BigInt(whole + frac.slice(0, decimals));
  }
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

/** Decode a left aligned bytes32 ticker such as bytes32("BTC") into "BTC". */
export function assetIdToSymbol(assetId: Hex): string {
  const bytes = hexToBytes(assetId);
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

interface PerpUniverseEntry {
  name: string;
}
interface PerpAssetCtx {
  oraclePx?: string;
  markPx?: string;
  midPx?: string | null;
}

export interface PriceSnapshot {
  /** Prices scaled to PUSH_DECIMALS, keyed by on-chain symbol. */
  prices: Map<string, bigint>;
  /** Raw decimal strings, for logs. */
  raw: Map<string, string>;
  /** Unix seconds at which the response was received. */
  observedAt: number;
}

async function postInfo<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Hyperliquid info API ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/**
 * Fetch prices for `symbols` from the Hyperliquid info API, perp asset contexts only (metaAndAssetCtxs).
 * Only assets with a HyperCore perp oracle price are eligible; spot only tokens are rejected on purpose.
 * HL_COIN_OVERRIDES maps an on-chain symbol to a different perp coin name (for example kPEPE).
 */
export async function fetchPrices(
  infoUrl: string,
  symbols: string[],
  field: PriceField,
  overrides: Record<string, string>,
  timeoutMs: number,
): Promise<PriceSnapshot> {
  const [meta, ctxs] = await postInfo<[{ universe: PerpUniverseEntry[] }, PerpAssetCtx[]]>(
    infoUrl,
    { type: "metaAndAssetCtxs" },
    timeoutMs,
  );
  const perpIndex = new Map(meta.universe.map((u, i) => [u.name, i]));

  const raw = new Map<string, string>();
  for (const symbol of symbols) {
    const coin = overrides[symbol] ?? symbol;
    const idx = perpIndex.get(coin);
    if (idx === undefined) throw new Error(`${symbol} (coin "${coin}") is not a Hyperliquid perp: not eligible`);
    const value = ctxs[idx]?.[field];
    if (typeof value !== "string") throw new Error(`No ${field} for ${symbol} (coin "${coin}")`);
    raw.set(symbol, value);
  }

  const observedAt = Math.floor(Date.now() / 1000);
  const prices = new Map<string, bigint>();
  for (const [symbol, value] of raw) {
    const units = decimalToUnits(value);
    if (units === 0n) throw new Error(`Zero price for ${symbol}`);
    prices.set(symbol, units);
  }
  return { prices, raw, observedAt };
}
