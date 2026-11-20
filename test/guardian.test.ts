import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { reviewInputs, reviewRef, vetoReason, type RoundView } from "../src/guardian/roles.js";
import { decide, deviationBps, fetchPrices, median, parseOpen, sourceUrl, toUnits, type Fetcher } from "../src/guardian/rule.js";
import type { ReviewRecord } from "../src/guardian/genlayer.js";

const TS = 1795123500; // 2026-11-19 21:25:00 UTC
const ROUND = `0x${"ab".repeat(32)}` as Hex;
const u = (x: string) => toUnits(x, 18);
const same = (p: string) => ({ binance: u(p), coinbase: u(p), kraken: u(p), okx: u(p), bybit: u(p) });

test("decimal prices convert exactly, never through a float", () => {
  assert.equal(toUnits("61500.10", 18), 61500_100000000000000000n);
  assert.equal(toUnits("0.000001", 8), 100n);
  assert.throws(() => toUnits("-1", 18));
  assert.throws(() => toUnits("1e5", 18));
});

test("each source format yields the open of the candle that starts at the timestamp", () => {
  assert.equal(parseOpen("binance", JSON.stringify([[TS * 1000, "61500.10", "1", "1", "1"]]), TS), "61500.10");
  // Coinbase sends numbers: the text is kept as is, newest first, the next minute included.
  assert.equal(parseOpen("coinbase", `[[${TS + 60},1.0,2.0,3.0,4.0,5.0],[${TS},61470.12,61500.5,61480.55,61490.0,2.5]]`, TS), "61480.55");
  assert.equal(parseOpen("kraken", JSON.stringify({ error: [], result: { XXBTZUSD: [[TS, "61490.0", "1"]], last: TS } }), TS), "61490.0");
  assert.equal(parseOpen("okx", JSON.stringify({ code: "0", data: [[String(TS * 1000), "61505.2", "1"]] }), TS), "61505.2");
  assert.equal(parseOpen("bybit", JSON.stringify({ retCode: 0, result: { list: [[String(TS * 1000), "61499.9", "1"]] } }), TS), "61499.9");
  assert.throws(() => parseOpen("binance", JSON.stringify([[(TS + 60) * 1000, "1"]]), TS), /no candle/);
});

test("source URLs point at the candle of the timestamp (Binance through data-api.binance.vision)", () => {
  assert.match(sourceUrl("binance", "BTC", TS), /^https:\/\/data-api\.binance\.vision\/.*symbol=BTCUSDT.*startTime=1795123500000/);
  assert.match(sourceUrl("coinbase", "ETH", TS), /ETH-USD\/candles\?granularity=60&start=2026-11-19T21:25:00Z&end=2026-11-19T21:26:00Z/);
  assert.match(sourceUrl("kraken", "BTC", TS), /pair=XBTUSD&interval=1&since=1795123440$/);
});

test("median and deviation follow the contract (even count: floor of the middle average; deviation rounded up)", () => {
  assert.equal(median([3n, 1n, 2n]), 2n);
  assert.equal(median([1n, 2n, 3n, 10n]), 2n);
  assert.equal(deviationBps(10001n, 10000n), 1);
  assert.equal(deviationBps(10000n, 10000n), 0);
});

test("the rule gives the same verdicts as the contract tests", () => {
  // VALID: recorded prices match the sources.
  assert.equal(decide(30, u("61500"), u("61600"), "UP", same("61500"), same("61600")).verdict, "VALID");
  // VOID: close 1 percent above the sources, which went down.
  const v = decide(30, u("61500"), u("62014"), "UP", same("61500"), same("61400"));
  assert.equal(v.verdict, "VOID");
  assert.equal(v.computedOutcome, "DOWN");
  // Large deviation, same outcome: VALID.
  assert.equal(decide(30, u("61500"), u("62418"), "UP", same("61500"), same("61800")).verdict, "VALID");
  // Sources say tie, record says UP with a deviation: VOID.
  assert.equal(decide(30, u("61500"), u("61900"), "UP", same("61500"), same("61500")).verdict, "VOID");
  // Fewer than 3 sources: INCONCLUSIVE.
  assert.equal(decide(30, u("61500"), u("62014"), "UP", { binance: u("61500"), okx: u("61500") }, same("61400")).verdict, "INCONCLUSIVE");
});

test("fetchPrices skips sources that fail or answer another candle", async () => {
  const fetcher: Fetcher = async (url) => {
    if (url.includes("okx")) return { status: 500, body: "" };
    if (url.includes("bybit")) return { status: 200, body: "not json" };
    if (url.includes("binance")) return { status: 200, body: JSON.stringify([[TS * 1000, "61500.00"]]) };
    if (url.includes("coinbase")) return { status: 200, body: `[[${TS},1,2,61480.5,4,5]]` };
    return { status: 200, body: JSON.stringify({ error: [], result: { XXBTZUSD: [[TS - 60, "1"]] } }) };
  };
  const p = await fetchPrices("BTC", TS, 18, fetcher);
  assert.deepEqual(Object.keys(p).sort(), ["binance", "coinbase"]);
  assert.equal(p.coinbase, u("61480.5"));
});

const round: RoundView = {
  marketId: `0x${"01".repeat(32)}` as Hex,
  configHash: `0x${"02".repeat(32)}` as Hex,
  start: BigInt(TS),
  interval: 300,
  status: 4,
  lockPrice: u("61500"),
  closePrice: u("62014"),
  upAmount: 1n,
  downAmount: 1n,
  claimableAt: 0n,
};

function review(over: Partial<ReviewRecord["inputs"]> = {}, verdict: "VALID" | "VOID" | "INCONCLUSIVE" = "VOID"): ReviewRecord {
  const [, asset, lockTs, closeTs, lockPrice, closePrice, outcome, dec] = reviewInputs(ROUND, "BTC", round);
  return {
    round_id: ROUND,
    inputs: { asset, lock_ts: lockTs, close_ts: closeTs, lock_price: lockPrice, close_price: closePrice, outcome: outcome as "UP", price_decimals: dec, ...over },
    result: { verdict, lock_sources: [], close_sources: [] },
  };
}

test("review inputs are exactly the recorded round", () => {
  assert.deepEqual(reviewInputs(ROUND, "BTC", round), [ROUND, "BTC", TS, TS + 300, u("61500").toString(), u("62014").toString(), "UP", 18]);
});

test("a pending VOID is backed only by a finalized VOID review with the recorded prices", () => {
  assert.equal(vetoReason(review(), ROUND, "BTC", round), undefined);
  assert.match(vetoReason(undefined, ROUND, "BTC", round)!, /no finalized review/);
  assert.match(vetoReason(review({}, "VALID"), ROUND, "BTC", round)!, /VALID, not VOID/);
  assert.match(vetoReason(review({ close_price: u("61000").toString() }), ROUND, "BTC", round)!, /prices differ/);
  assert.match(vetoReason(review({ lock_ts: TS + 300 }), ROUND, "BTC", round)!, /timestamps differ/);
  assert.match(vetoReason(review({ asset: "ETH" }), ROUND, "BTC", round)!, /asset ETH/);
  assert.match(vetoReason({ ...review(), round_id: `0x${"cd".repeat(32)}` }, ROUND, "BTC", round)!, /another round/);
});

test("the fallback reference of a review is stable", () => {
  assert.equal(reviewRef(review()), reviewRef(review()));
  assert.notEqual(reviewRef(review()), reviewRef(review({}, "VALID")));
});
