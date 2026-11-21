// rpc-check: tests the primary and the fallback RPC of the guardian roles separately, with the reads the roles make:
// chain id, latest block, and the Multicall3 eth_calls at the latest block (markets of the lens, every round closed
// in the relayer's 6.5 hour window, GuardianReceiver.pendingVoid). The roles do not use eth_getLogs. Endpoints are
// named "primary" and "fallback" only: URLs (which may carry an API key) are never logged.

import { createPublicClient, custom, type Address, type Hex, type PublicClient } from "viem";
import { guardianReceiverAbi, predictionMarketLensAbi } from "../abi.js";
import { makeChain } from "../keeper.js";
import { log } from "../log.js";
import { RpcProvider } from "../rpc.js";
import { candidateRounds } from "./scan.js";

export interface CheckTargets {
  chainId: number;
  lens: Address;
  receiver: Address;
}

export interface EndpointCheck {
  endpoint: "primary" | "fallback";
  ok: boolean;
  chainId?: number;
  latestBlock?: string;
  markets?: number;
  roundsRead?: number;
  error?: string;
}

/** The causes of an error, outermost first: viem wraps transport failures in a generic message. */
export function errorChain(err: unknown): string {
  const parts: string[] = [];
  let e: any = err;
  for (let i = 0; e && i < 6; i++, e = e.cause) {
    const text = String(e.details ?? e.shortMessage ?? e.message ?? e).split("\n")[0];
    if (text && !parts.includes(text)) parts.push(text);
  }
  return parts.join(" <- ");
}

/** Removes the endpoint URLs (and anything shaped like a URL) from an error text. */
export function redactUrls(text: string, urls: (string | undefined)[]): string {
  let out = text;
  for (const u of urls) if (u) out = out.split(u).join("[rpc url]");
  return out.replace(/https?:\/\/\S+/g, "[url]");
}

/** The reads of a relayer pass at the latest block: markets, every round of the window, pendingVoid. */
export async function relayerReads(pub: PublicClient, t: CheckTargets, windowMinutes: number): Promise<{ markets: number; roundsRead: number }> {
  const block = await pub.getBlock();
  const ids = (await pub.readContract({ address: t.lens, abi: predictionMarketLensAbi, functionName: "getMarketIds" })) as Hex[];
  const ms = (await pub.multicall({ contracts: ids.map((id) => ({ address: t.lens, abi: predictionMarketLensAbi, functionName: "getMarket", args: [id] })), allowFailure: false, batchSize: 8_192 } as any)) as any[];
  const markets = ids.map((marketId, i) => ({ marketId, interval: Number(ms[i].interval) }));
  const cands = candidateRounds(markets, Number(block.timestamp), windowMinutes * 60);
  await pub.multicall({ contracts: cands.map((c) => ({ address: t.lens, abi: predictionMarketLensAbi, functionName: "getRound", args: [c.roundId] })), allowFailure: false, batchSize: 8_192 } as any);
  await pub.multicall({ contracts: cands.slice(0, 50).map((c) => ({ address: t.receiver, abi: guardianReceiverAbi, functionName: "pendingVoid", args: [c.roundId] })), allowFailure: false, batchSize: 8_192 } as any);
  return { markets: ids.length, roundsRead: cands.length };
}

export async function checkEndpoint(
  endpoint: "primary" | "fallback",
  url: string,
  t: CheckTargets,
  windowMinutes: number,
  fetchFn: typeof fetch = fetch,
  reads: (pub: PublicClient) => Promise<{ markets: number; roundsRead: number }> = (pub) => relayerReads(pub, t, windowMinutes),
): Promise<EndpointCheck> {
  const rpc = new RpcProvider({ primaryUrl: url, timeoutMs: 15_000, maxRetries: 1, baseDelayMs: 500, defaultBudgetMs: 60_000, fetchFn });
  const pub = createPublicClient({ chain: makeChain(t.chainId, url), transport: custom({ request: (a) => rpc.request(a) }, { retryCount: 0 }) }) as PublicClient;
  try {
    const id = await pub.getChainId();
    if (id !== t.chainId) return { endpoint, ok: false, chainId: id, error: `chain id ${id}, expected ${t.chainId}` };
    const latest = await pub.getBlockNumber();
    const r = await reads(pub);
    return { endpoint, ok: true, chainId: id, latestBlock: latest.toString(), ...r };
  } catch (err) {
    return { endpoint, ok: false, error: redactUrls(errorChain(err), [url]) };
  }
}

/** Checks both endpoints; logs one line each and an error when an endpoint fails or no fallback is configured. */
export async function rpcCheck(cfg: { rpcUrl: string; rpcFallbackUrl?: string } & CheckTargets): Promise<EndpointCheck[]> {
  const results = [await checkEndpoint("primary", cfg.rpcUrl, cfg, 390)];
  if (cfg.rpcFallbackUrl) results.push(await checkEndpoint("fallback", cfg.rpcFallbackUrl, cfg, 390));
  else log("error", "no fallback RPC configured (RPC_FALLBACK_URL)");
  for (const r of results) log(r.ok ? "info" : "error", `rpc check ${r.endpoint}`, { ...r });
  return results;
}
