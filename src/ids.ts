import { encodeAbiParameters, hexToBytes, keccak256, stringToHex, type Hex } from "viem";

/** Canonical Multicall3 (same address on Arbitrum Sepolia and most chains). */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/** keccak256(abi.encode(assetId, uint32 interval)), as PredictionMarket.marketIdOf. */
export function marketIdOf(assetId: Hex, interval: number): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint32" }], [assetId, interval]));
}

/** keccak256(abi.encode(marketId, uint64 start)), as PredictionMarket.roundIdOf. */
export function roundIdOf(marketId: Hex, start: number | bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint64" }], [marketId, BigInt(start)]));
}

export function assetIdOf(symbol: string): Hex {
  return stringToHex(symbol, { size: 32 });
}

/** Decode a left aligned bytes32 ticker such as bytes32("BTC") into "BTC". */
export function assetIdToSymbol(assetId: Hex): string {
  const bytes = hexToBytes(assetId);
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}
