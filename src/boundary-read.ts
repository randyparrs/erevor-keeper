// All reads a boundary needs, in a single Multicall3 aggregate3 eth_call.

import { parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { predictionMarketAbi } from "./abi.js";
import { MULTICALL3, roundIdOf } from "./ids.js";
import type { MarketInfo } from "./schedule.js";

export const multicall3TimeAbi = parseAbi(["function getCurrentBlockTimestamp() view returns (uint256 timestamp)"]);

/** Market data that never changes once listed: cached at startup and refreshed when the market count changes. */
export interface StaticMarket {
  id: Hex;
  assetId: Hex;
  symbol: string;
  interval: number;
}

export interface RoundView {
  status: number;
  priceSource: Address;
}

export interface BoundarySnapshot {
  chainTime: number;
  paused: boolean;
  bufferSeconds: number;
  priceSource: Address;
  marketCount: number;
  markets: MarketInfo[];
  /** Rounds to close (start = boundary - interval) and lock (start = boundary) of aligned markets. */
  rounds: Map<Hex, RoundView>;
}

interface Call {
  address: Address;
  abi: unknown;
  functionName: string;
  args?: readonly unknown[];
}

const FIXED_CALLS = 5;

/** Builds the aggregate3 call list. Round ids are computed locally from the boundary and the interval. */
export function boundaryCalls(market: Address, markets: StaticMarket[], boundary: number) {
  const calls: Call[] = [
    { address: MULTICALL3, abi: multicall3TimeAbi, functionName: "getCurrentBlockTimestamp" },
    { address: market, abi: predictionMarketAbi, functionName: "paused" },
    { address: market, abi: predictionMarketAbi, functionName: "bufferSeconds" },
    { address: market, abi: predictionMarketAbi, functionName: "priceSource" },
    { address: market, abi: predictionMarketAbi, functionName: "getMarketIds" },
  ];
  for (const m of markets) calls.push({ address: market, abi: predictionMarketAbi, functionName: "markets", args: [m.id] });
  const roundKeys: Hex[] = [];
  for (const m of markets) {
    if (boundary % m.interval !== 0) continue;
    for (const start of [boundary - m.interval, boundary]) {
      const id = roundIdOf(m.id, start);
      roundKeys.push(id);
      calls.push({ address: market, abi: predictionMarketAbi, functionName: "getRound", args: [id] });
    }
  }
  return { calls, roundKeys };
}

type MarketTuple = readonly [Hex, number, boolean, boolean, bigint, bigint, Hex];

export function parseBoundary(results: readonly unknown[], markets: StaticMarket[], roundKeys: Hex[]): BoundarySnapshot {
  const marketIds = results[4] as readonly Hex[];
  const out: BoundarySnapshot = {
    chainTime: Number(results[0] as bigint),
    paused: results[1] as boolean,
    bufferSeconds: Number(results[2] as bigint),
    priceSource: results[3] as Address,
    marketCount: marketIds.length,
    markets: [],
    rounds: new Map(),
  };
  markets.forEach((m, i) => {
    const [, , active, , lastBoundary] = results[FIXED_CALLS + i] as MarketTuple;
    out.markets.push({ ...m, active, lastBoundary: Number(lastBoundary) });
  });
  const roundOffset = FIXED_CALLS + markets.length;
  roundKeys.forEach((id, i) => {
    const r = results[roundOffset + i] as { status: number; priceSource: Address };
    out.rounds.set(id, { status: r.status, priceSource: r.priceSource });
  });
  return out;
}

/** One eth_call to Multicall3.aggregate3 for the whole boundary. */
export async function readBoundary(
  client: PublicClient,
  market: Address,
  markets: StaticMarket[],
  boundary: number,
): Promise<BoundarySnapshot> {
  const { calls, roundKeys } = boundaryCalls(market, markets, boundary);
  const results = await client.multicall({
    contracts: calls as never,
    allowFailure: false,
    multicallAddress: MULTICALL3,
    batchSize: 0,
  });
  return parseBoundary(results as readonly unknown[], markets, roundKeys);
}
