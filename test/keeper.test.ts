import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FEED_IDS } from "../src/config.js";
import { FirstUpdateCapture } from "../src/hermes.js";
import { assetIdOf, marketIdOf } from "../src/ids.js";
import { reportAuthError, splitByCapture } from "../src/keeper.js";
import { errorCount } from "../src/log.js";
import type { MarketInfo } from "../src/schedule.js";

const B = 1_800_000_000;

function market(symbol: string, interval: number): MarketInfo {
  return { id: marketIdOf(assetIdOf(symbol), interval), assetId: assetIdOf(symbol), symbol, interval, active: true, lastBoundary: 0 };
}

test("markets of assets without a captured update are left out, the others share one update per feed", () => {
  const c = new FirstUpdateCapture([DEFAULT_FEED_IDS.BTC!, DEFAULT_FEED_IDS.ETH!], B);
  c.offer({
    binary: "0xaa",
    parsed: [{ id: DEFAULT_FEED_IDS.BTC!.slice(2), price: { price: "1", conf: "0", expo: -8, publish_time: B }, metadata: { prev_publish_time: B - 1 } }],
  });
  const due = [market("BTC", 300), market("BTC", 900), market("ETH", 300)];
  const { ready, missingSymbols, feeds } = splitByCapture(due, c, DEFAULT_FEED_IDS);
  assert.deepEqual(ready.map((m) => `${m.symbol}${m.interval}`), ["BTC300", "BTC900"]);
  assert.deepEqual(missingSymbols, ["ETH"]);
  assert.deepEqual(feeds, [DEFAULT_FEED_IDS.BTC]);
  assert.deepEqual(c.updateData(feeds), ["0xaa"]);
});

test("a rejected Pyth key is logged as PYTH_KEY_INVALID_OR_EXPIRED and counts as an error (exit code 1)", () => {
  const before = errorCount();
  const lines: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.equal(reportAuthError({ authError: { status: 401, detail: "expired" } }, B), true);
    assert.equal(reportAuthError({}, B), false);
  } finally {
    process.stdout.write = write;
  }
  assert.equal(errorCount(), before + 1);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]!).msg, "PYTH_KEY_INVALID_OR_EXPIRED");
});
