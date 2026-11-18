import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  multicall3Abi,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { predictionMarketAbi } from "../src/abi.js";
import { multicall3TimeAbi, readBoundary, type StaticMarket } from "../src/boundary-read.js";
import { MULTICALL3, assetIdOf, marketIdOf, roundIdOf } from "../src/ids.js";
import { makeChain } from "../src/keeper.js";
import { JsonRpcError, RpcProvider, TransientRpcError, backoffWithJitter, type RpcEvent } from "../src/rpc.js";

// ------------------------------------------------------------------ helpers

type Reply = { status?: number; body?: unknown; throws?: boolean };

/** Fake fetch serving scripted replies per URL and recording every call. */
function fakeFetch(script: Record<string, Reply[]>) {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const queue = script[url] ?? [];
    const reply = queue.length > 1 ? queue.shift()! : queue[0];
    if (!reply || reply.throws) throw new Error("connection reset");
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ok = (result: unknown): Reply => ({ body: { jsonrpc: "2.0", id: 1, result } });
const conduitRateLimit: Reply = {
  body: { jsonrpc: "2.0", id: 1, error: { code: -32016, message: "Rate Limit Exceeded. Please get an api key at https://app.conduit.xyz/nodes" } },
};

function provider(script: Record<string, Reply[]>, extra: Partial<ConstructorParameters<typeof RpcProvider>[0]> = {}) {
  const f = fakeFetch(script);
  const sleeps: number[] = [];
  const events: RpcEvent[] = [];
  let clock = 1_000_000;
  const p = new RpcProvider({
    primaryUrl: "https://primary",
    timeoutMs: 1000,
    fetchFn: f.fn,
    sleepFn: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    random: () => 0.5,
    onEvent: (e) => events.push(e),
    ...extra,
  });
  return { p, f, sleeps, events, setClock: (v: number) => (clock = v) };
}

// ------------------------------------------------------------------ backoff and fallback

test("backoff with jitter stays within half to full exponential delay", () => {
  assert.equal(backoffWithJitter(1, 250, 4000, () => 0), 125);
  assert.equal(backoffWithJitter(1, 250, 4000, () => 1), 250);
  assert.equal(backoffWithJitter(3, 250, 4000, () => 0.5), 750);
  assert.equal(backoffWithJitter(10, 250, 4000, () => 1), 4000);
});

test("HTTP 429 is retried with backoff and then succeeds", async () => {
  const { p, f, sleeps } = provider({ "https://primary": [{ status: 429 }, { status: 429 }, ok("0x10")] });
  assert.equal(await p.request({ method: "eth_blockNumber" }), "0x10");
  assert.equal(f.calls.length, 3);
  assert.equal(p.requestCount, 3);
  assert.deepEqual(sleeps, [188, 375]); // equal jitter with random 0.5
});

test("Conduit style rate limit JSON-RPC error is retried", async () => {
  const { p, f } = provider({ "https://primary": [conduitRateLimit, ok("0x1")] });
  assert.equal(await p.request({ method: "eth_call" }), "0x1");
  assert.equal(f.calls.length, 2);
});

test("fallback is used only after the primary exhausted its retries, and the use is reported", async () => {
  const { p, f, events } = provider(
    { "https://primary": [{ status: 429 }], "https://fallback": [ok("0xfa")] },
    { fallbackUrl: "https://fallback", maxRetries: 2 },
  );
  assert.equal(await p.request({ method: "eth_getBalance" }), "0xfa");
  assert.deepEqual(f.calls, ["https://primary", "https://primary", "https://primary", "https://fallback"]);
  const fallbacks = events.filter((e) => e.type === "fallback");
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0]?.method, "eth_getBalance");
});

test("retries never wait past the deadline (execution window)", async () => {
  const { p, sleeps, setClock } = provider({ "https://primary": [{ status: 429 }] });
  setClock(1_000_000);
  p.setDeadline(1_000_000 + 300); // room for one short backoff only
  await assert.rejects(p.request({ method: "eth_call" }), TransientRpcError);
  assert.deepEqual(sleeps, [188], "second backoff (375 ms) would cross the deadline");
});

test("fallback is skipped once the window is gone, and tried while it is still open", async () => {
  // Each HTTP request takes 200 ms of simulated latency.
  let clock = 0;
  const slow = (inner: typeof fetch) => (async (...a: Parameters<typeof fetch>) => {
    clock += 200;
    return inner(...a);
  }) as typeof fetch;
  const run = async (windowMs: number) => {
    const f = fakeFetch({ "https://primary": [{ status: 429 }], "https://fallback": [ok("0xfa")] });
    clock = 0;
    const p = new RpcProvider({
      primaryUrl: "https://primary",
      fallbackUrl: "https://fallback",
      timeoutMs: 1000,
      fetchFn: slow(f.fn),
      sleepFn: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      random: () => 0.5,
    });
    p.setDeadline(windowMs);
    const result = await p.request({ method: "eth_call" }).catch(() => "failed");
    return { result, calls: f.calls };
  };
  const closed = await run(150); // window gone after the first primary request
  assert.equal(closed.result, "failed");
  assert.deepEqual(closed.calls, ["https://primary"]);
  // Primary fails at 200 ms; its next backoff (188 ms) would cross 350 ms, so the fallback is tried right away.
  const open = await run(350);
  assert.equal(open.result, "0xfa");
  assert.equal(open.calls.at(-1), "https://fallback");
});

test("a non rate limit JSON-RPC error (revert) is thrown at once, no retry, no fallback", async () => {
  const revert: Reply = { body: { jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted", data: "0x1234" } } };
  const { p, f } = provider({ "https://primary": [revert] }, { fallbackUrl: "https://fallback" });
  await assert.rejects(p.request({ method: "eth_call" }), (err: unknown) => err instanceof JsonRpcError && err.code === 3);
  assert.equal(f.calls.length, 1);
});

test("network errors are retried like rate limits", async () => {
  const { p, f } = provider({ "https://primary": [{ throws: true }, ok("0x2")] });
  assert.equal(await p.request({ method: "eth_chainId" }), "0x2");
  assert.equal(f.calls.length, 2);
});

// ------------------------------------------------------------------ local ids

test("roundIdOf and marketIdOf match the deployed contract", () => {
  const btc5m = marketIdOf(assetIdOf("BTC"), 300);
  assert.equal(btc5m, "0x67b96a3d8be9f79f8727339aae30739e3743423501961aa9a2e2fd9d1b8358e5");
  // On-chain PredictionMarket.roundIdOf(btc5m, 1794951300) on Elysium testnet.
  assert.equal(roundIdOf(btc5m, 1_794_951_300), "0xa0e044b0a09bcfa5049ecda53f8bfd56827149fec165b146920b853ed2dc558f");
});

// ------------------------------------------------------------------ multicall read

test("a boundary is read with exactly one eth_call to Multicall3 aggregate3", async () => {
  const MARKET = "0x00000000000000000000000000000000000000aa" as Address;
  const SOURCE = "0x00000000000000000000000000000000000000bb" as Address;
  const boundary = 1_800_000_000;
  const markets: StaticMarket[] = [
    { id: marketIdOf(assetIdOf("BTC"), 300), assetId: assetIdOf("BTC"), symbol: "BTC", interval: 300 },
    { id: marketIdOf(assetIdOf("BTC"), 900), assetId: assetIdOf("BTC"), symbol: "BTC", interval: 900 },
    { id: marketIdOf(assetIdOf("ETH"), 1800), assetId: assetIdOf("ETH"), symbol: "ETH", interval: 1800 },
  ];
  const lockedRound = roundIdOf(markets[0]!.id, boundary - 300);
  const abi = [...predictionMarketAbi, ...multicall3TimeAbi];
  const getRoundOutputs = (predictionMarketAbi.find((x) => x.type === "function" && x.name === "getRound") as {
    outputs: readonly { components: readonly { name: string; type: string }[] }[];
  }).outputs[0]!.components;
  const emptyRound = (status: number, priceSource: Address) =>
    Object.fromEntries(
      getRoundOutputs.map((c) => [
        c.name,
        c.name === "status" ? status : c.name === "priceSource" ? priceSource : c.type === "bool" ? false : c.type.startsWith("bytes") ? stringToHex("", { size: 32 }) : c.type === "address" ? "0x0000000000000000000000000000000000000000" : c.type.startsWith("uint8") ? 0 : 0n,
      ]),
    );

  const ethCalls: { to: string }[] = [];
  const client = createPublicClient({
    chain: makeChain(99801, "http://unused"),
    transport: custom({
      request: async ({ method, params }) => {
        if (method !== "eth_call") throw new Error(`unexpected ${method}`);
        const [tx] = params as [{ to: string; data: Hex }];
        ethCalls.push({ to: tx.to });
        const { args } = decodeFunctionData({ abi: multicall3Abi, data: tx.data });
        const inner = args[0] as readonly { target: Address; callData: Hex }[];
        const results = inner.map((c) => {
          const d = decodeFunctionData({ abi, data: c.callData });
          const value = (() => {
            switch (d.functionName) {
              case "getCurrentBlockTimestamp": return BigInt(boundary + 1);
              case "paused": return false;
              case "bufferSeconds": return 30n;
              case "priceSource": return SOURCE;
              case "getMarketIds": return markets.map((m) => m.id);
              case "markets": {
                const m = markets.find((x) => x.id === (d.args as readonly Hex[])[0])!;
                return [m.assetId, m.interval, true, true, BigInt(boundary - m.interval), 1n, stringToHex("", { size: 32 })];
              }
              case "getRound": {
                const id = (d.args as readonly Hex[])[0];
                return id === lockedRound ? emptyRound(2, SOURCE) : emptyRound(0, "0x0000000000000000000000000000000000000000");
              }
              default: throw new Error(`unexpected inner call ${d.functionName}`);
            }
          })();
          return { success: true, returnData: encodeFunctionResult({ abi, functionName: d.functionName, result: value } as never) };
        });
        return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
      },
    }),
  });

  const snap = await readBoundary(client as never, MARKET, markets, boundary);
  assert.equal(ethCalls.length, 1, "one eth_call for the whole boundary");
  assert.equal(ethCalls[0]?.to.toLowerCase(), MULTICALL3.toLowerCase());
  assert.equal(snap.chainTime, boundary + 1);
  assert.equal(snap.priceSource, SOURCE);
  assert.equal(snap.marketCount, 3);
  assert.deepEqual(snap.markets.map((m) => m.lastBoundary), [boundary - 300, boundary - 900, boundary - 1800]);
  // Every aligned market contributes its close and lock round: 3 markets x 2 at a 30 minute boundary.
  assert.equal(snap.rounds.size, 6);
  assert.equal(snap.rounds.get(lockedRound)?.status, 2);
});

test("an endpoint that cannot serve the request (archive on a free plan) goes straight to the fallback", async () => {
  const archive: Reply = {
    body: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Archive, Debug and Trace requests are not available on your current plan." } },
  };
  const { p, f, events, sleeps } = provider(
    { "https://primary": [archive], "https://fallback": [ok(["0xlog"])] },
    { fallbackUrl: "https://fallback" },
  );
  assert.deepEqual(await p.request({ method: "eth_getLogs" }), ["0xlog"]);
  assert.deepEqual(f.calls, ["https://primary", "https://fallback"], "no retry on the primary");
  assert.equal(sleeps.length, 0);
  assert.equal(events.filter((e) => e.type === "fallback").length, 1);
});
