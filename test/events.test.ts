import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, stringToHex, type Hex, type Log } from "viem";
import { predictionMarketAbi } from "../src/abi.js";
import { summarizeLogs } from "../src/events.js";

const MARKET = "0x00000000000000000000000000000000000000aa";
const OTHER = "0x00000000000000000000000000000000000000bb";
const BTC = stringToHex("BTC", { size: 32 });

function fakeLog(address: string, topics: Hex[], data: Hex): Log {
  return {
    address,
    topics,
    data,
    blockHash: null,
    blockNumber: null,
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false,
  } as unknown as Log;
}

test("PriceRebased, RebasePending, PriceRejected and MarketSkipped are decoded for the logs", () => {
  const rebased = fakeLog(
    MARKET,
    encodeEventTopics({ abi: predictionMarketAbi, eventName: "PriceRebased", args: { assetId: BTC } }) as Hex[],
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint64" }],
      [100n * 10n ** 18n, 96n * 10n ** 18n, 1_800_000_302n],
    ),
  );
  const pending = fakeLog(
    MARKET,
    encodeEventTopics({ abi: predictionMarketAbi, eventName: "RebasePending", args: { assetId: BTC } }) as Hex[],
    encodeAbiParameters([{ type: "uint256" }, { type: "uint8" }], [96n * 10n ** 18n, 1]),
  );
  const rejected = fakeLog(
    MARKET,
    encodeEventTopics({ abi: predictionMarketAbi, eventName: "PriceRejected", args: { assetId: BTC } }) as Hex[],
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint64" }],
      [100n * 10n ** 18n, 96n * 10n ** 18n, 1_800_000_002n],
    ),
  );
  const marketId = stringToHex("m", { size: 32 });
  const skipped = fakeLog(
    MARKET,
    encodeEventTopics({ abi: predictionMarketAbi, eventName: "MarketSkipped", args: { marketId } }) as Hex[],
    encodeAbiParameters([{ type: "uint8" }], [1]),
  );
  const foreign = { ...rebased, address: OTHER } as Log;

  const s = summarizeLogs([rebased, pending, rejected, skipped, foreign], MARKET);
  assert.deepEqual(s.rebased, [
    { asset: "BTC", oldReference: "100000000000000000000", newReference: "96000000000000000000", timestamp: 1_800_000_302 },
  ]);
  assert.deepEqual(s.pending, [{ asset: "BTC", pendingReference: "96000000000000000000", count: 1 }]);
  assert.equal(s.rejected.length, 1);
  assert.deepEqual(s.skipped, [{ market: marketId, reason: "OutsideWindow" }]);
});
