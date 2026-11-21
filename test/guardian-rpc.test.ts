import { test } from "node:test";
import assert from "node:assert/strict";
import { guardianRpc } from "../src/guardian/roles.js";
import { checkEndpoint, redactUrls } from "../src/guardian/rpc-check.js";
import type { RpcEvent } from "../src/rpc.js";

const PRIMARY = "https://primary.example/rpc";
const FALLBACK = "https://fallback.example/v2/secret-api-key";
const MARKET = "0x0008917F984e12142a48eE3133e2153B30BCBC63";

type Handler = (url: string, method: string, params: any[]) => { status?: number; result?: unknown; error?: { code: number; message: string } };

function fakeFetch(handler: Handler, calls: string[] = []): typeof fetch {
  return (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push(`${url === FALLBACK ? "fallback" : "primary"}:${body.method}`);
    const r = handler(url, body.method, body.params);
    const status = r.status ?? 200;
    const payload = r.error ? { jsonrpc: "2.0", id: body.id, error: r.error } : { jsonrpc: "2.0", id: body.id, result: r.result };
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
}

const instant = async () => {};

test("the primary is retried twice with backoff, then the fallback answers and the switch is reported", async () => {
  const calls: string[] = [];
  const events: RpcEvent[] = [];
  const rpc = guardianRpc(
    { rpcUrl: PRIMARY, rpcFallbackUrl: FALLBACK },
    { fetchFn: fakeFetch((url) => (url === PRIMARY ? { status: 500 } : { result: "0x10" }), calls), sleepFn: instant, onEvent: (e) => events.push(e) },
  );
  assert.equal(await rpc.request({ method: "eth_blockNumber" }), "0x10");
  assert.deepEqual(calls, ["primary:eth_blockNumber", "primary:eth_blockNumber", "primary:eth_blockNumber", "fallback:eth_blockNumber"]);
  assert.deepEqual(events.map((e) => `${e.type}:${e.endpoint}`), ["retry:primary", "retry:primary", "fallback:fallback"]);
  assert.ok(events[0]!.delayMs! > 0);
});

test("when the fallback fails too the error surfaces, so the pass exits with code 1", async () => {
  const rpc = guardianRpc({ rpcUrl: PRIMARY, rpcFallbackUrl: FALLBACK }, { fetchFn: fakeFetch(() => ({ status: 503 })), sleepFn: instant, onEvent: () => {} });
  await assert.rejects(rpc.request({ method: "eth_blockNumber" }), /HTTP 503/);
});

test("a node error such as a revert is not retried and does not switch endpoint", async () => {
  const calls: string[] = [];
  const rpc = guardianRpc(
    { rpcUrl: PRIMARY, rpcFallbackUrl: FALLBACK },
    { fetchFn: fakeFetch(() => ({ error: { code: 3, message: "execution reverted" } }), calls), sleepFn: instant, onEvent: () => {} },
  );
  await assert.rejects(rpc.request({ method: "eth_call" }), /execution reverted/);
  assert.deepEqual(calls, ["primary:eth_call"]);
});

test("URLs never reach a log line", () => {
  const text = `failed at ${FALLBACK}: connection refused (see https://other.example/x)`;
  const out = redactUrls(text, [FALLBACK]);
  assert.ok(!out.includes("secret-api-key"));
  assert.ok(!out.includes("other.example"));
});

test("rpc-check finds the largest eth_getLogs range an endpoint accepts and checks the chain id", async () => {
  const handler: Handler = (_url, method, params) => {
    if (method === "eth_chainId") return { result: "0x66eee" };
    if (method === "eth_blockNumber") return { result: "0x1000000" };
    if (method === "eth_getLogs") {
      const range = BigInt(params[0].toBlock) - BigInt(params[0].fromBlock) + 1n;
      return range > 10_000n ? { error: { code: -32602, message: "block range too large" } } : { result: [] };
    }
    return { error: { code: -32601, message: "unexpected" } };
  };
  const ok = await checkEndpoint("fallback", FALLBACK, 421614, MARKET, 390, fakeFetch(handler));
  assert.equal(ok.ok, true);
  assert.ok(BigInt(ok.logsChunkBlocks!) <= 10_000n);

  const wrongChain = await checkEndpoint("fallback", FALLBACK, 1, MARKET, 390, fakeFetch(handler));
  assert.equal(wrongChain.ok, false);
  assert.match(wrongChain.error!, /chain id 421614, expected 1/);
});

test("rpc-check reports the underlying HTTP failure, not viem's generic wrapper, and no URL", async () => {
  const r = await checkEndpoint("fallback", FALLBACK, 421614, MARKET, 390, (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch);
  assert.equal(r.ok, false);
  assert.match(r.error!, /HTTP 401/);
  assert.ok(!r.error!.includes("secret-api-key"));
});
