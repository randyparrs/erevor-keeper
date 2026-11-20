// The guardian rule, mirrored from the erevor-guardian intelligent contract on GenLayer (same sources, same median,
// same thresholds). The vigilante uses it to decide whether a closed round deserves a dispute.

export const SOURCES = ["binance", "coinbase", "kraken", "okx", "bybit"] as const;
export type Source = (typeof SOURCES)[number];
export const MIN_SOURCES = 3;
export const TOLERANCE_BPS: Record<string, number> = { BTC: 30, ETH: 40 };

const SYMBOLS: Record<string, Record<Source, string>> = {
  BTC: { binance: "BTCUSDT", coinbase: "BTC-USD", kraken: "XBTUSD", okx: "BTC-USDT", bybit: "BTCUSDT" },
  ETH: { binance: "ETHUSDT", coinbase: "ETH-USD", kraken: "ETHUSD", okx: "ETH-USDT", bybit: "ETHUSDT" },
};

export type Outcome = "UP" | "DOWN" | "TIE";

export function isoSecond(ts: number): string {
  return new Date(ts * 1000).toISOString().replace(".000Z", "Z");
}

export function sourceUrl(source: Source, asset: string, ts: number): string {
  const sym = SYMBOLS[asset]![source];
  switch (source) {
    case "binance":
      return `https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=1m&startTime=${ts * 1000}&limit=1`;
    case "coinbase":
      return `https://api.exchange.coinbase.com/products/${sym}/candles?granularity=60&start=${isoSecond(ts)}&end=${isoSecond(ts + 60)}`;
    case "kraken":
      return `https://api.kraken.com/0/public/OHLC?pair=${sym}&interval=1&since=${ts - 60}`;
    case "okx":
      return `https://www.okx.com/api/v5/market/history-candles?instId=${sym}&bar=1m&after=${(ts + 60) * 1000}&before=${(ts - 60) * 1000}&limit=3`;
    case "bybit":
      return `https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=1&start=${ts * 1000}&end=${ts * 1000}&limit=1`;
  }
}

/** Exact decimal string to an integer with `decimals` decimals (truncated). Numbers are read as raw JSON text. */
export function toUnits(text: string, decimals: number): bigint {
  const s = text.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`bad price ${text}`);
  const [whole = "0", frac = ""] = s.split(".");
  const v = BigInt(whole + (frac + "0".repeat(decimals)).slice(0, decimals));
  if (v <= 0n) throw new Error("non positive price");
  return v;
}

/** Keeps every JSON number as its source text, so prices are never rounded through a float. */
function parseJsonExact(body: string): unknown {
  return JSON.parse(body.replace(/(?<=[:\[,]\s*)(-?\d+\.\d+(?:[eE][-+]?\d+)?)(?=\s*[,\]}])/g, '"$1"'));
}

export function parseOpen(source: Source, body: string, ts: number): string {
  const d = parseJsonExact(body) as any;
  const pick = (rows: any[], key: (r: any) => number, value: (r: any) => unknown) => {
    const row = rows.find((r) => key(r) === ts);
    if (!row) throw new Error(`${source}: no candle at ${ts}`);
    return String(value(row));
  };
  switch (source) {
    case "binance":
      return pick(d, (r) => Number(r[0]) / 1000, (r) => r[1]);
    case "coinbase":
      return pick(d, (r) => Number(r[0]), (r) => r[3]); // [time, low, high, open, close, volume]
    case "kraken": {
      if (d.error?.length) throw new Error("kraken error");
      const series = Object.entries(d.result).find(([k]) => k !== "last")![1] as any[];
      return pick(series, (r) => Number(r[0]), (r) => r[1]);
    }
    case "okx":
      if (String(d.code) !== "0") throw new Error("okx error");
      return pick(d.data, (r) => Number(r[0]) / 1000, (r) => r[1]);
    case "bybit":
      if (Number(d.retCode) !== 0) throw new Error("bybit error");
      return pick(d.result.list, (r) => Number(r[0]) / 1000, (r) => r[1]);
  }
}

export type Fetcher = (url: string) => Promise<{ status: number; body: string }>;

export const httpFetcher: Fetcher = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": "erevor-guardian", Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  return { status: res.status, body: await res.text() };
};

export async function fetchPrices(asset: string, ts: number, decimals: number, fetcher: Fetcher = httpFetcher): Promise<Partial<Record<Source, bigint>>> {
  const out: Partial<Record<Source, bigint>> = {};
  await Promise.all(
    SOURCES.map(async (s) => {
      try {
        const r = await fetcher(sourceUrl(s, asset, ts));
        if (r.status !== 200) return;
        out[s] = toUnits(parseOpen(s, r.body, ts), decimals);
      } catch {
        // a source that does not answer simply does not count
      }
    }),
  );
  return out;
}

export function median(values: bigint[]): bigint {
  const v = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = v.length;
  return n % 2 ? v[(n - 1) / 2]! : (v[n / 2 - 1]! + v[n / 2]!) / 2n;
}

export function direction(lock: bigint, close: bigint): Outcome {
  return close > lock ? "UP" : close < lock ? "DOWN" : "TIE";
}

/** |recorded - median| in basis points of the median, rounded up (same as the contract). */
export function deviationBps(recorded: bigint, med: bigint): number {
  const diff = recorded > med ? recorded - med : med - recorded;
  return Number((diff * 10000n + med - 1n) / med);
}

export interface Decision {
  verdict: "VALID" | "VOID" | "INCONCLUSIVE";
  lockSources: string[];
  closeSources: string[];
  medianLock?: bigint;
  medianClose?: bigint;
  deviationLockBps?: number;
  deviationCloseBps?: number;
  computedOutcome?: Outcome;
}

export function decide(
  tolBps: number,
  lockPrice: bigint,
  closePrice: bigint,
  outcome: Outcome,
  lockPrices: Partial<Record<Source, bigint>>,
  closePrices: Partial<Record<Source, bigint>>,
): Decision {
  const lockSources = Object.keys(lockPrices).sort();
  const closeSources = Object.keys(closePrices).sort();
  if (lockSources.length < MIN_SOURCES || closeSources.length < MIN_SOURCES) return { verdict: "INCONCLUSIVE", lockSources, closeSources };
  const medianLock = median(Object.values(lockPrices) as bigint[]);
  const medianClose = median(Object.values(closePrices) as bigint[]);
  const deviationLockBps = deviationBps(lockPrice, medianLock);
  const deviationCloseBps = deviationBps(closePrice, medianClose);
  const computedOutcome = direction(medianLock, medianClose);
  const deviates = deviationLockBps > tolBps || deviationCloseBps > tolBps;
  return {
    verdict: deviates && computedOutcome !== outcome ? "VOID" : "VALID",
    lockSources,
    closeSources,
    medianLock,
    medianClose,
    deviationLockBps,
    deviationCloseBps,
    computedOutcome,
  };
}
