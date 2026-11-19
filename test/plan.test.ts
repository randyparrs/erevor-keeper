import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import type { BoundarySnapshot, RoundView } from "../src/boundary-read.js";
import { parseRefresh } from "../src/config.js";
import { assetIdOf, marketIdOf, roundIdOf } from "../src/ids.js";
import { planBoundary } from "../src/plan.js";
import type { MarketInfo } from "../src/schedule.js";

const T0 = 1_800_000_000; // aligned to 300, 900 and 1800

function market(symbol: string, interval: number): MarketInfo {
  return { id: marketIdOf(assetIdOf(symbol), interval), assetId: assetIdOf(symbol), symbol, interval, active: true, lastBoundary: 0 };
}

const btc5 = market("BTC", 300);
const eth5 = market("ETH", 300);
const btc30 = market("BTC", 1800);

function snapshot(rounds: [Hex, number][] = []): BoundarySnapshot {
  const map = new Map<Hex, RoundView>(rounds.map(([id, status]) => [id, { status }]));
  return { chainTime: T0, paused: false, bufferSeconds: 30, marketCount: 3, markets: [btc5, eth5, btc30], rounds: map };
}

test("an empty 5 minute boundary is skipped in idle mode, no transaction", () => {
  const plan = planBoundary(snapshot(), T0 + 300, true, 1800);
  assert.equal(plan.mode, "idle");
  assert.equal(plan.execute.length, 0);
  assert.equal(plan.marketsWithBets, 0);
  assert.equal(plan.due, 2);
});

test("a round with bets to lock (Pending at the boundary) always executes, only its market", () => {
  const b = T0 + 300;
  const plan = planBoundary(snapshot([[roundIdOf(btc5.id, b), 1]]), b, true, 1800);
  assert.equal(plan.mode, "active");
  assert.deepEqual(plan.execute.map((m) => m.symbol + m.interval), ["BTC300"]);
  assert.equal(plan.marketsWithBets, 1);
});

test("a round with bets to close (Locked one interval ago) always executes", () => {
  const b = T0 + 600;
  const plan = planBoundary(snapshot([[roundIdOf(eth5.id, b - 300), 2]]), b, true, 1800);
  assert.equal(plan.mode, "active");
  assert.deepEqual(plan.execute.map((m) => m.symbol), ["ETH"]);
});

test("closed or voided rounds do not count as open", () => {
  const b = T0 + 300;
  const plan = planBoundary(snapshot([[roundIdOf(btc5.id, b - 300), 3], [roundIdOf(eth5.id, b), 5]]), b, true, 1800);
  assert.equal(plan.mode, "idle");
});

test("30 minute boundaries refresh every due market even when empty", () => {
  const plan = planBoundary(snapshot(), T0, true, 1800);
  assert.equal(plan.mode, "refresh");
  assert.equal(plan.execute.length, 3);
});

test("idle mode off executes every due market at every boundary", () => {
  const plan = planBoundary(snapshot(), T0 + 300, false, 1800);
  assert.equal(plan.mode, "active");
  assert.equal(plan.execute.length, 2);
});

test("refresh interval must be a positive multiple of 300", () => {
  assert.equal(parseRefresh("1800"), 1800);
  assert.throws(() => parseRefresh("1000"));
  assert.throws(() => parseRefresh("0"));
});
