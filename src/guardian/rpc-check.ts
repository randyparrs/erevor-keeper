// rpc-check: tests the primary and the fallback RPC of the guardian roles separately, with the calls the roles make
// (chain id, latest block, eth_getLogs over the relayer's 6.5 hour window, halving the range when an endpoint refuses
// it). Endpoints are named "primary" and "fallback" only: URLs (which may carry an API key) are never logged.

import { createPublicClient, custom, type Address } from "viem";
import { predictionMarketAbi } from "../abi.js";
import { log } from "../log.js";
import { RpcProvider } from "../rpc.js";

export interface EndpointCheck {
  endpoint: "primary" | "fallback";
  ok: boolean;
  chainId?: number;
  latestBlock?: string;
  logsChunkBlocks?: string;
  logs?: number;
  error?: string;
}

/** Removes the endpoint URLs (and anything shaped like a URL) from an error text. */
export function redactUrls(text: string, urls: (string | undefined)[]): string {
  let out = text;
  for (const u of urls) if (u) out = out.split(u).join("[rpc url]");
  return out.replace(/https?:\/\/\S+/g, "[url]");
}

export async function checkEndpoint(
  endpoint: "primary" | "fallback",
  url: string,
  chainId: number,
  market: Address,
  windowMinutes: number,
  fetchFn: typeof fetch = fetch,
): Promise<EndpointCheck> {
  const rpc = new RpcProvider({ primaryUrl: url, timeoutMs: 15_000, maxRetries: 1, baseDelayMs: 500, defaultBudgetMs: 60_000, fetchFn });
  const pub = createPublicClient({ transport: custom({ request: (a) => rpc.request(a) }, { retryCount: 0 }) });
  try {
    const id = await pub.getChainId();
    if (id !== chainId) return { endpoint, ok: false, chainId: id, error: `chain id ${id}, expected ${chainId}` };
    const latest = await pub.getBlockNumber();
    const span = BigInt(Math.ceil((windowMinutes * 60) / 0.2));
    const from = latest > span ? latest - span : 0n;
    const event = (predictionMarketAbi as readonly any[]).find((x) => x.type === "event" && x.name === "RoundClosed");
    let chunk = 200_000n;
    let logs = 0;
    for (let start = from; start <= latest; ) {
      const end = start + chunk - 1n > latest ? latest : start + chunk - 1n;
      try {
        logs += (await pub.getLogs({ address: market, event, fromBlock: start, toBlock: end })).length;
        start = end + 1n;
      } catch (err) {
        if (chunk <= 1_000n) throw err;
        chunk /= 2n;
      }
    }
    return { endpoint, ok: true, chainId: id, latestBlock: latest.toString(), logsChunkBlocks: chunk.toString(), logs };
  } catch (err) {
    return { endpoint, ok: false, error: redactUrls(err instanceof Error ? err.message : String(err), [url]).split("\n")[0] };
  }
}

/** Checks both endpoints; logs one line each and an error when an endpoint fails or no fallback is configured. */
export async function rpcCheck(cfg: { rpcUrl: string; rpcFallbackUrl?: string; chainId: number; market: Address }): Promise<EndpointCheck[]> {
  const results = [await checkEndpoint("primary", cfg.rpcUrl, cfg.chainId, cfg.market, 390)];
  if (cfg.rpcFallbackUrl) results.push(await checkEndpoint("fallback", cfg.rpcFallbackUrl, cfg.chainId, cfg.market, 390));
  else log("error", "no fallback RPC configured (RPC_FALLBACK_URL)");
  for (const r of results) log(r.ok ? "info" : "error", `rpc check ${r.endpoint}`, { ...r });
  return results;
}
