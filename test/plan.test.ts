import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import type { BoundarySnapshot, RoundView } from "../src/boundary-read.js";
import { parseRefresh } from "../src/config.js";
import { assetIdOf, marketIdOf, roundIdOf } from "../src/ids.js";
import { executableMarkets, planBoundary, streamFeedsFor } from "../src/plan.js";
import { DEFAULT_FEED_IDS } from "../src/config.js";
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

const sol5 = { ...market("SOL", 300), active: false };
const hype5 = { ...market("HYPE", 300), active: false };

function snapshotWith(markets: MarketInfo[], rounds: [Hex, number][] = []): BoundarySnapshot {
  return { ...snapshot(rounds), marketCount: markets.length, markets };
}

test("the stream carries only the feeds of active due markets and of markets with bets", () => {
  const b = T0 + 300; // 5 minute boundary: only the 300 s markets are due
  const snap = snapshotWith([btc5, eth5, btc30, sol5, hype5]);
  assert.deepEqual(streamFeedsFor(snap, b, DEFAULT_FEED_IDS), [DEFAULT_FEED_IDS.BTC, DEFAULT_FEED_IDS.ETH]);
});

test("an inactive market that still holds a round with bets keeps its feed in the stream", () => {
  const b = T0 + 300;
  const snap = snapshotWith([btc5, sol5, hype5], [[roundIdOf(sol5.id, b - 300), 2]]);
  assert.deepEqual(streamFeedsFor(snap, b, DEFAULT_FEED_IDS), [DEFAULT_FEED_IDS.BTC, DEFAULT_FEED_IDS.SOL]);
});

test("a refresh boundary streams the active assets only, once per asset", () => {
  const snap = snapshotWith([btc5, eth5, btc30, sol5, hype5]);
  assert.deepEqual(streamFeedsFor(snap, T0, DEFAULT_FEED_IDS), [DEFAULT_FEED_IDS.BTC, DEFAULT_FEED_IDS.ETH]);
});

test("a refresh executes active markets only: inactive 15 and 30 minute markets without bets are left out", () => {
  const btc15 = { ...market("BTC", 900), active: false };
  const btc30i = { ...market("BTC", 1800), active: false };
  const eth30i = { ...market("ETH", 1800), active: false };
  const snap = snapshotWith([btc5, eth5, btc15, btc30i, eth30i]);
  const plan = planBoundary(snap, T0, true, 1800);
  assert.equal(plan.mode, "refresh");
  assert.equal(plan.execute.length, 5);
  assert.deepEqual(executableMarkets(plan.execute, snap, T0).map((m) => `${m.symbol}${m.interval}`), ["BTC300", "ETH300"]);
});

test("an inactive market that still holds a round with bets is executed so the round locks or closes", () => {
  const btc15 = { ...market("BTC", 900), active: false };
  const b = T0 + 900;
  const snap = snapshotWith([btc5, btc15], [[roundIdOf(btc15.id, b - 900), 2]]);
  // Idle mode: only the market with bets; idle mode off: every due market except inactive ones without bets.
  const idle = planBoundary(snap, b, true, 1800);
  assert.deepEqual(executableMarkets(idle.execute, snap, b).map((m) => `${m.symbol}${m.interval}`), ["BTC900"]);
  const all = planBoundary(snap, b, false, 1800);
  assert.deepEqual(executableMarkets(all.execute, snap, b).map((m) => `${m.symbol}${m.interval}`), ["BTC300", "BTC900"]);
});
