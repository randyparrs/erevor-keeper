import { test } from "node:test";
import assert from "node:assert/strict";
import { stringToHex } from "viem";
import { assetIdToSymbol, decimalToUnits } from "../src/prices.js";
import { backoffMs, nextBoundary, selectDue, type MarketInfo } from "../src/schedule.js";
import { parseCoinOverrides, parseMinBalance } from "../src/config.js";

const T0 = 1_800_000_000; // aligned to 300, 900 and 1800

function market(symbol: string, interval: number, lastBoundary: number, active = true): MarketInfo {
  return {
    id: stringToHex(`${symbol}-${interval}`, { size: 32 }),
    assetId: stringToHex(symbol, { size: 32 }),
    symbol,
    interval,
    active,
    lastBoundary,
  };
}

test("nextBoundary aligns to 5 minutes", () => {
  assert.equal(nextBoundary(T0 - 1), T0);
  assert.equal(nextBoundary(T0), T0 + 300);
  assert.equal(nextBoundary(T0 + 299), T0 + 300);
});

test("selectDue picks markets by interval alignment", () => {
  const markets = [market("BTC", 300, T0), market("BTC", 900, T0), market("BTC", 1800, T0)];
  assert.deepEqual(
    selectDue(markets, T0 + 300).map((m) => m.interval),
    [300],
  );
  assert.deepEqual(
    selectDue(markets, T0 + 900).map((m) => m.interval),
    [300, 900],
  );
  assert.deepEqual(
    selectDue(markets, T0 + 1800).map((m) => m.interval),
    [300, 900, 1800],
  );
});

test("selectDue skips executed boundaries but keeps inactive markets", () => {
  const executed = market("HYPE", 300, T0 + 300);
  const inactive = market("SOL", 300, T0, false);
  const due = selectDue([executed, inactive], T0 + 300);
  assert.deepEqual(
    due.map((m) => m.symbol),
    ["SOL"],
  );
});

test("decimalToUnits scales without floats", () => {
  assert.equal(decimalToUnits("64320.0"), 64320n * 10n ** 18n);
  assert.equal(decimalToUnits("67.9185"), 679185n * 10n ** 14n);
  assert.equal(decimalToUnits("0.000012"), 12n * 10n ** 12n);
  assert.equal(decimalToUnits("588"), 588n * 10n ** 18n);
  assert.equal(decimalToUnits("1.5", 8), 150000000n);
  assert.throws(() => decimalToUnits("1e5"));
  assert.throws(() => decimalToUnits("-1"));
  assert.throws(() => decimalToUnits(""));
});

test("assetIdToSymbol decodes left aligned bytes32", () => {
  assert.equal(assetIdToSymbol(stringToHex("BTC", { size: 32 })), "BTC");
  assert.equal(assetIdToSymbol(stringToHex("HYPE", { size: 32 })), "HYPE");
});

test("backoff grows and caps", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((a) => backoffMs(a)), [500, 1000, 2000, 4000, 4000]);
});

test("coin overrides parse", () => {
  assert.deepEqual(parseCoinOverrides("PURR:PURR/USDC, FOO:@107"), { PURR: "PURR/USDC", FOO: "@107" });
  assert.deepEqual(parseCoinOverrides(""), {});
  assert.throws(() => parseCoinOverrides("BAD"));
});

test("min balance parses HYPE amounts", () => {
  assert.equal(parseMinBalance("0.1"), 10n ** 17n);
  assert.equal(parseMinBalance("2"), 2n * 10n ** 18n);
  assert.throws(() => parseMinBalance("-1"));
});
