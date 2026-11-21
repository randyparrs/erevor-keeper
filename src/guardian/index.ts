// Entry point of the guardian workflows: node dist/src/guardian/index.js relayer | vigilante
// Local runs read .env and .env.guardian; on CI everything comes from the workflow env and secrets.

import { existsSync } from "node:fs";
import { isAddress, isHex, type Address, type Hex } from "viem";
import { errorCount, log } from "../log.js";
import { Relayer, Vigilante, type GuardianConfig } from "./roles.js";
import { redactUrls, rpcCheck } from "./rpc-check.js";

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function address(name: string): Address {
  const v = required(name);
  if (!isAddress(v)) throw new Error(`${name} is not an address`);
  return v;
}

function key(name: string): Hex {
  const v = required(name);
  if (!isHex(v) || v.length !== 66) throw new Error(`${name} must be a 0x prefixed 32 byte hex`);
  return v as Hex;
}

async function main(): Promise<void> {
  if (existsSync(".env.guardian")) process.loadEnvFile(".env.guardian");
  const role = process.argv[2];
  const cfg: GuardianConfig = {
    rpcUrl: required("RPC_URL"),
    rpcFallbackUrl: process.env.RPC_FALLBACK_URL?.trim() || undefined,
    chainId: Number(required("CHAIN_ID")),
    market: address("MARKET_ADDRESS"),
    lens: address("LENS_ADDRESS"),
    receiver: address("RECEIVER_ADDRESS"),
    guardianGL: address("GUARDIAN_GL_ADDRESS") as Hex,
    glNode: process.env.GL_NODE?.trim() || undefined,
    lookbackMinutes: Number(process.env.LOOKBACK_MINUTES ?? "15"),
    maxWaitFinalMs: Number(process.env.MAX_WAIT_FINAL_MINUTES ?? "15") * 60_000,
  };
  fallbackForRedaction = cfg.rpcFallbackUrl;
  if (role !== "rpc-check" && !cfg.rpcFallbackUrl) log("warn", "no fallback RPC configured (RPC_FALLBACK_URL): primary only");
  if (role === "rpc-check") {
    await rpcCheck(cfg);
  } else if (role === "relayer") {
    // Disputes stay open up to disputeTimeout (6 hours): look back that far.
    cfg.lookbackMinutes = Number(process.env.LOOKBACK_MINUTES ?? "390");
    await new Relayer(cfg, key("RELAYER_PRIVATE_KEY")).run();
  } else if (role === "vigilante") {
    await new Vigilante(cfg, key("VIGILANTE_PRIVATE_KEY")).run();
  } else {
    throw new Error("usage: guardian/index.js relayer | vigilante | rpc-check");
  }
  if (errorCount() > 0) {
    log("error", "guardian pass finished with errors", { role, errors: errorCount() });
    process.exitCode = 1;
  }
}

let fallbackForRedaction: string | undefined;

main().catch((err) => {
  // The fallback URL may carry an API key: it never reaches the log.
  log("error", "guardian fatal", { error: redactUrls(err instanceof Error ? err.message : String(err), [fallbackForRedaction]) });
  process.exit(1);
});
