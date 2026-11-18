import { encodeAbiParameters, keccak256, stringToHex, toHex, type Hex } from "viem";

/** Canonical Multicall3, deployed on Elysium testnet and mainnet. */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

export const OPERATOR_ROLE = keccak256(toHex("OPERATOR_ROLE"));
export const PRICE_PUSHER_ROLE = keccak256(toHex("PRICE_PUSHER_ROLE"));

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
