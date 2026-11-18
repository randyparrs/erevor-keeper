import { existsSync } from "node:fs";
import { isAddress, isHex, parseEther, type Address, type Hex } from "viem";
import type { Level } from "./log.js";

export type PriceField = "oraclePx" | "markPx" | "midPx";

export interface KeeperConfig {
  /** Dedicated RPC (Chainstack, Alchemy, Conduit key). Mandatory on mainnet. */
  rpcUrl: string;
  /** Optional backup, used only after rpcUrl failed all its retries. Typically the public RPC. */
  rpcFallbackUrl?: string;
  chainId: number;
  privateKey: Hex;
  marketAddress: Address;
  /** Push prices to the KeeperSignedPriceSource before every execution (testnet adapter mode). */
  pushPrices: boolean;
  hlInfoUrl: string;
  hlPriceField: PriceField;
  /** Map from on-chain asset symbol to Hyperliquid coin name, for assets whose names differ. */
  coinOverrides: Record<string, string>;
  /** Delay after the local boundary before acting, to let the chain clock pass the boundary. */
  wakeDelayMs: number;
  /** Stop retrying this long before the on-chain buffer closes. */
  safetyMarginMs: number;
  httpTimeoutMs: number;
  dryRun: boolean;
  logLevel: Level;
  /** Warn when the keeper HYPE balance drops below this (wei). */
  minBalanceWei: bigint;
  /** How often the HYPE balance is checked (ms). */
  balanceCheckIntervalMs: number;
  /** Idle mode: send a transaction only for rounds with bets, plus a reference refresh every idleRefreshSeconds. */
  idleMode: boolean;
  idleRefreshSeconds: number;
  /** Unix seconds when the CI runner started the job (RUNNER_STARTED_AT), for punctuality logs. */
  runnerStartedAt?: number;
  /** Nominal lead of the external trigger before each boundary, in seconds (120 for minutes 3, 8, ..., 58). */
  triggerLeadSeconds: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") throw new Error(`Missing required env var ${name}`);
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

function parseBool(value: string): boolean {
  return ["1", "true", "yes"].includes(value.toLowerCase());
}

function parseIntStrict(name: string, value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non negative integer, got "${value}"`);
  return Number(value);
}

export function parseCoinOverrides(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  if (raw.trim() === "") return map;
  for (const pair of raw.split(",")) {
    const [asset, coin] = pair.split(":").map((s) => s.trim());
    if (!asset || !coin) throw new Error(`Invalid HL_COIN_OVERRIDES entry "${pair}", expected ASSET:COIN`);
    map[asset] = coin;
  }
  return map;
}

export function parseMinBalance(value: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`MIN_BALANCE_HYPE must be a decimal number, got "${value}"`);
  return parseEther(value);
}

export function parseRefresh(value: string): number {
  const n = parseIntStrict("IDLE_REFRESH_SECONDS", value);
  if (n === 0 || n % 300 !== 0) throw new Error("IDLE_REFRESH_SECONDS must be a positive multiple of 300");
  return n;
}

export function loadConfig(): KeeperConfig {
  if (existsSync(".env")) process.loadEnvFile(".env");

  const privateKey = required("KEEPER_PRIVATE_KEY");
  if (!isHex(privateKey) || privateKey.length !== 66) throw new Error("KEEPER_PRIVATE_KEY must be a 0x prefixed 32 byte hex");
  const marketAddress = required("MARKET_ADDRESS");
  if (!isAddress(marketAddress)) throw new Error("MARKET_ADDRESS is not a valid address");

  const field = optional("HL_PRICE_FIELD", "oraclePx");
  if (field !== "oraclePx" && field !== "markPx" && field !== "midPx") {
    throw new Error("HL_PRICE_FIELD must be oraclePx, markPx or midPx");
  }
  const logLevel = optional("LOG_LEVEL", "info");
  if (!["debug", "info", "warn", "error"].includes(logLevel)) throw new Error("Invalid LOG_LEVEL");

  return {
    rpcUrl: required("RPC_URL"),
    rpcFallbackUrl: process.env.RPC_FALLBACK_URL?.trim() || undefined,
    chainId: parseIntStrict("CHAIN_ID", required("CHAIN_ID")),
    privateKey: privateKey as Hex,
    marketAddress,
    pushPrices: parseBool(optional("PUSH_PRICES", "true")),
    hlInfoUrl: optional("HL_INFO_URL", "https://api.hyperliquid.xyz/info"),
    hlPriceField: field,
    coinOverrides: parseCoinOverrides(optional("HL_COIN_OVERRIDES", "")),
    wakeDelayMs: parseIntStrict("WAKE_DELAY_MS", optional("WAKE_DELAY_MS", "1500")),
    safetyMarginMs: parseIntStrict("SAFETY_MARGIN_MS", optional("SAFETY_MARGIN_MS", "3000")),
    httpTimeoutMs: parseIntStrict("HTTP_TIMEOUT_MS", optional("HTTP_TIMEOUT_MS", "4000")),
    dryRun: parseBool(optional("DRY_RUN", "false")),
    logLevel: logLevel as Level,
    minBalanceWei: parseMinBalance(optional("MIN_BALANCE_HYPE", "0.1")),
    balanceCheckIntervalMs: parseIntStrict("BALANCE_CHECK_MINUTES", optional("BALANCE_CHECK_MINUTES", "60")) * 60_000,
    idleMode: parseBool(optional("IDLE_MODE", "true")),
    idleRefreshSeconds: parseRefresh(optional("IDLE_REFRESH_SECONDS", "1800")),
    runnerStartedAt: process.env.RUNNER_STARTED_AT
      ? parseIntStrict("RUNNER_STARTED_AT", process.env.RUNNER_STARTED_AT.trim())
      : undefined,
    triggerLeadSeconds: parseIntStrict("TRIGGER_LEAD_SECONDS", optional("TRIGGER_LEAD_SECONDS", "120")),
  };
}
