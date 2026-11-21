import { test } from "node:test";
import assert from "node:assert/strict";
import { assetSymbol, health, vetoPass, vetoReason } from "../src/core.js";

const TS = 1795123500;
const ROUND = "0x" + "ab".repeat(32);
const OTHER = "0x" + "cd".repeat(32);
const u = (x) => BigInt(x) * 10n ** 18n;
const round = { marketId: "0x" + "01".repeat(32), start: BigInt(TS), interval: 300, lockPrice: u(61500), closePrice: u(62014) };

function review(over = {}, verdict = "VOID") {
  return {
    round_id: ROUND,
    inputs: { asset: "BTC", lock_ts: TS, close_ts: TS + 300, lock_price: u(61500).toString(), close_price: u(62014).toString(), outcome: "UP", price_decimals: 18, ...over },
    result: { verdict, lock_sources: ["binance", "coinbase", "okx"], close_sources: ["binance", "coinbase", "okx"] },
  };
}

function fakeChain({ proposals, pending = {} }) {
  const vetoed = [];
  return {
    vetoed,
    voidProposals: async () => proposals,
    pendingVoid: async (id) => pending[id] ?? 0n,
    round: async () => round,
    assetOf: async () => "BTC",
    veto: async (id) => {
      vetoed.push(id);
      return "0x" + "ee".repeat(32);
    },
  };
}

const quiet = () => {};

test("asset ids decode to their ticker", () => {
  assert.equal(assetSymbol("0x" + "425443".padEnd(64, "0")), "BTC");
});

test("a pending VOID is backed only by a finalized VOID review with the recorded round", () => {
  assert.equal(vetoReason(review(), ROUND, "BTC", round), undefined);
  assert.match(vetoReason(undefined, ROUND, "BTC", round), /no finalized review/);
  assert.match(vetoReason(review({}, "VALID"), ROUND, "BTC", round), /VALID, not VOID/);
  assert.match(vetoReason(review({}, "INCONCLUSIVE"), ROUND, "BTC", round), /INCONCLUSIVE/);
  assert.match(vetoReason(review({ close_price: "1" }), ROUND, "BTC", round), /prices differ/);
  assert.match(vetoReason(review({ lock_ts: TS + 60 }), ROUND, "BTC", round), /timestamps differ/);
  assert.match(vetoReason(review({ asset: "ETH" }), ROUND, "BTC", round), /asset ETH/);
  assert.match(vetoReason(review({ outcome: "DOWN" }), ROUND, "BTC", round), /outcome/);
  assert.match(vetoReason({ ...review(), round_id: OTHER }, ROUND, "BTC", round), /another round/);
});

test("an unbacked pending VOID is vetoed; a backed one is left to execute", async () => {
  const chain = fakeChain({ proposals: [{ roundId: ROUND, genlayerTxRef: "0x01" }, { roundId: OTHER, genlayerTxRef: "0x02" }], pending: { [ROUND]: 1n, [OTHER]: 1n } });
  const reviews = { [ROUND]: review(), [OTHER]: undefined };
  const s = await vetoPass({ chain, readReview: async (id) => reviews[id], log: quiet });
  assert.deepEqual(chain.vetoed, [OTHER]);
  assert.equal(s.backed, 1);
  assert.equal(s.vetoed, 1);
  assert.match(s.vetoes[0].reason, /no finalized review/);
});

test("VOIDs no longer pending (vetoed or executed) and repeated proposals are checked once", async () => {
  const chain = fakeChain({ proposals: [{ roundId: ROUND }, { roundId: ROUND }], pending: {} });
  const s = await vetoPass({ chain, readReview: async () => undefined, log: quiet });
  assert.deepEqual(chain.vetoed, []);
  assert.equal(s.voidProposals, 1);
  assert.equal(s.pending, 0);
});

test("a failing check is counted as an error and does not stop the others", async () => {
  const chain = fakeChain({ proposals: [{ roundId: ROUND }, { roundId: OTHER }], pending: { [ROUND]: 1n, [OTHER]: 1n } });
  const s = await vetoPass({
    chain,
    readReview: async (id) => {
      if (id === ROUND) throw new Error("GenLayer node down");
      return undefined;
    },
    log: quiet,
  });
  assert.equal(s.errors, 1);
  assert.deepEqual(chain.vetoed, [OTHER]);
});

test("health is 503 when passes stop, fail or a veto happened in the last hour", () => {
  const now = 1_000_000;
  assert.equal(health({}, now).ok, false);
  assert.equal(health({ lastPassAt: now - 60 }, now).ok, true);
  assert.equal(health({ lastPassAt: now - 900 }, now).ok, false);
  assert.equal(health({ lastPassAt: now - 60, lastError: "x" }, now).ok, false);
  assert.equal(health({ lastPassAt: now - 60, lastVetoAt: now - 600 }, now).ok, false);
  assert.equal(health({ lastPassAt: now - 60, lastVetoAt: now - 7200 }, now).ok, true);
});

test("rounds of the veto window are computed from the markets, aligned to each interval", async () => {
  const { candidateStarts } = await import("../src/core.js");
  const now = 1795280000;
  const c = candidateStarts([{ marketId: "0x01", interval: 300 }, { marketId: "0x02", interval: 1800 }], now, 390 * 60);
  assert.equal(c.filter((x) => x.marketId === "0x01").length, 78);
  assert.equal(c.filter((x) => x.marketId === "0x02").length, 13);
  assert.ok(c.every((x) => x.start % 300 === 0 && x.start + 300 <= now));
});
