import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { roundIdOf } from "../src/ids.js";
import { STATUS_CLOSED, STATUS_DISPUTED, candidateRounds, closesToCheck, planRelayer, type PendingVoidView } from "../src/guardian/scan.js";

const M5 = `0x${"05".repeat(32)}` as Hex;
const M15 = `0x${"15".repeat(32)}` as Hex;
const NOW = 1795280000; // 2026-11-21 16:13:20 UTC, between boundaries

test("round ids of the closes in a window are computed like the market computes them", () => {
  const c = candidateRounds([{ marketId: M5, interval: 300 }], NOW, 600);
  // Closes at 16:10 and 16:05; 16:00 is more than 600 s back.
  assert.deepEqual(c.map((x) => x.closeAt), [1795279800, 1795279500]);
  assert.deepEqual(c.map((x) => x.start), [1795279500, 1795279200]);
  assert.equal(c[0]!.roundId, roundIdOf(M5, 1795279500));
});

test("the relayer window of 6.5 hours covers 78 five minute and 26 fifteen minute rounds per market", () => {
  const c = candidateRounds([{ marketId: M5, interval: 300 }, { marketId: M15, interval: 900 }], NOW, 390 * 60);
  assert.equal(c.filter((x) => x.marketId === M5).length, 78);
  assert.equal(c.filter((x) => x.marketId === M15).length, 26);
  assert.ok(c.every((x) => x.closeAt <= NOW && x.closeAt > NOW - 390 * 60 && x.start % x.interval === 0));
});

const r = (status: number, extra: Partial<{ claimableAt: bigint; upAmount: bigint; downAmount: bigint }> = {}) => ({
  status,
  claimableAt: BigInt(NOW + 100),
  upAmount: 1n,
  downAmount: 1n,
  ...extra,
});
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

test("disputed rounds and due VOIDs are found from the reads alone", () => {
  const rounds = [
    { roundId: id(1), round: r(STATUS_DISPUTED) }, // no VOID pending: review
    { roundId: id(2), round: r(STATUS_DISPUTED) }, // VOID due: execute
    { roundId: id(3), round: r(STATUS_DISPUTED) }, // VOID inside its veto delay: wait
    { roundId: id(4), round: r(STATUS_CLOSED) }, // not disputed: ignored
  ];
  const pending = new Map<string, PendingVoidView>([
    [id(1), { executeAfter: 0n, genlayerTxRef: id(0) }],
    [id(2), { executeAfter: BigInt(NOW - 1), genlayerTxRef: id(9) }],
    [id(3), { executeAfter: BigInt(NOW + 60), genlayerTxRef: id(9) }],
  ]);
  const plan = planRelayer(rounds, pending, NOW);
  assert.deepEqual(plan.review.map((x) => x.roundId), [id(1)]);
  assert.deepEqual(plan.execute.map((x) => x.roundId), [id(2)]);
  assert.deepEqual(plan.waiting.map((x) => x.roundId), [id(3)]);
});

test("the vigilante checks only closed rounds inside the dispute window with bets on both sides", () => {
  const rounds = [
    { roundId: id(1), round: r(STATUS_CLOSED) },
    { roundId: id(2), round: r(STATUS_CLOSED, { claimableAt: BigInt(NOW) }) }, // window over
    { roundId: id(3), round: r(STATUS_CLOSED, { downAmount: 0n }) }, // one sided
    { roundId: id(4), round: r(STATUS_DISPUTED) },
  ];
  assert.deepEqual(closesToCheck(rounds, NOW).map((x) => x.roundId), [id(1)]);
});
