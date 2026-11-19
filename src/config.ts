import { existsSync } from "node:fs";
import { isAddress, isHex, parseEther, type Address, type Hex } from "viem";
import type { Level } from "./log.js";

export interface KeeperConfig {
  /** RPC endpoint of the chain. */
  rpcUrl: string;
  /** Optional backup, used only after rpcUrl failed all its retries. */
  rpcFallbackUrl?: string;
  chainId: number;
  privateKey: Hex;
  marketAddress: Address;
  lensAddress: Address;
  /** Pyth Hermes base URL and API key (sent as a bearer token, never logged). */
  hermesUrl: string;
  pythApiKey: string;
  /** Map from on-chain asset symbol to Pyth price feed id. */
  feedIds: Record<string, Hex>;
  /** How long before the boundary the Hermes stream is opened (ms). */
  streamLeadMs: number;
  /** Delay after the local boundary before reading the chain, to let the chain clock pass the boundary. */
  wakeDelayMs: number;
  /** Stop capturing and retrying this long before the on-chain buffer closes. */
  safetyMarginMs: number;
  httpTimeoutMs: number;
  dryRun: boolean;
  logLevel: Level;
  /** Warn when the keeper native balance drops below this (wei). */
  minBalanceWei: bigint;
  /** How often the balance is checked (ms). */
  balanceCheckIntervalMs: number;
  /** Idle mode: send a transaction only for rounds with bets, plus a reference refresh every idleRefreshSeconds. */
  idleMode: boolean;
  idleRefreshSeconds: number;
  /** Unix seconds when the CI runner started the job (RUNNER_STARTED_AT), for punctuality logs. */
  runnerStartedAt?: number;
  /** Nominal lead of the external trigger before each boundary, in seconds (120 for minutes 3, 8, ..., 58). */
  triggerLeadSeconds: number;
}

/** Pyth price feed ids (Crypto.X/USD) of the listed assets. */
export const DEFAULT_FEED_IDS: Record<string, Hex> = {
  BTC: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  HYPE: "0x4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b",
  SOL: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  BNB: "0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f",
};

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

function parseAddress(name: string): Address {
  const value = required(name);
  if (!isAddress(value)) throw new Error(`${name} is not a valid address`);
  return value;
}

/** FEED_IDS overrides: "SYMBOL:0xid,SYMBOL:0xid". */
export function parseFeedIds(raw: string): Record<string, Hex> {
  const map: Record<string, Hex> = { ...DEFAULT_FEED_IDS };
  if (raw.trim() === "") return map;
  for (const pair of raw.split(",")) {
    const [symbol, id] = pair.split(":").map((s) => s.trim());
    if (!symbol || !id || !isHex(id) || id.length !== 66) throw new Error(`Invalid FEED_IDS entry "${pair}", expected SYMBOL:0x<32 bytes>`);
    map[symbol] = id.toLowerCase() as Hex;
  }
  return map;
}

export function parseMinBalance(value: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`MIN_BALANCE must be a decimal number, got "${value}"`);
  return parseEther(value);
}

export function parseRefresh(value: string): number {
  const n = parseIntStrict("IDLE_REFRESH_SECONDS", value);
  if (n === 0 || n % 300 !== 0) throw new Error("IDLE_REFRESH_SECONDS must be a positive multiple of 300");
  return n;
}

export function loadConfig(): KeeperConfig {
  // Local runs: .env for the chain settings, .env.pyth for the Pyth API key. On CI both come from secrets.
  if (existsSync(".env")) process.loadEnvFile(".env");
  if (existsSync(".env.pyth")) process.loadEnvFile(".env.pyth");

  const privateKey = required("KEEPER_PRIVATE_KEY");
  if (!isHex(privateKey) || privateKey.length !== 66) throw new Error("KEEPER_PRIVATE_KEY must be a 0x prefixed 32 byte hex");

  const logLevel = optional("LOG_LEVEL", "info");
  if (!["debug", "info", "warn", "error"].includes(logLevel)) throw new Error("Invalid LOG_LEVEL");

  return {
    rpcUrl: required("RPC_URL"),
    rpcFallbackUrl: process.env.RPC_FALLBACK_URL?.trim() || undefined,
    chainId: parseIntStrict("CHAIN_ID", required("CHAIN_ID")),
    privateKey: privateKey as Hex,
    marketAddress: parseAddress("MARKET_ADDRESS"),
    lensAddress: parseAddress("LENS_ADDRESS"),
    hermesUrl: optional("HERMES_URL", "https://hermes.pyth.network"),
    pythApiKey: required("PYTH_API_KEY"),
    feedIds: parseFeedIds(optional("FEED_IDS", "")),
    streamLeadMs: parseIntStrict("STREAM_LEAD_MS", optional("STREAM_LEAD_MS", "5000")),
    wakeDelayMs: parseIntStrict("WAKE_DELAY_MS", optional("WAKE_DELAY_MS", "1500")),
    safetyMarginMs: parseIntStrict("SAFETY_MARGIN_MS", optional("SAFETY_MARGIN_MS", "6000")),
    httpTimeoutMs: parseIntStrict("HTTP_TIMEOUT_MS", optional("HTTP_TIMEOUT_MS", "4000")),
    dryRun: parseBool(optional("DRY_RUN", "false")),
    logLevel: logLevel as Level,
    minBalanceWei: parseMinBalance(optional("MIN_BALANCE", "0.01")),
    balanceCheckIntervalMs: parseIntStrict("BALANCE_CHECK_MINUTES", optional("BALANCE_CHECK_MINUTES", "60")) * 60_000,
    idleMode: parseBool(optional("IDLE_MODE", "true")),
    idleRefreshSeconds: parseRefresh(optional("IDLE_REFRESH_SECONDS", "1800")),
    runnerStartedAt: process.env.RUNNER_STARTED_AT
      ? parseIntStrict("RUNNER_STARTED_AT", process.env.RUNNER_STARTED_AT.trim())
      : undefined,
    triggerLeadSeconds: parseIntStrict("TRIGGER_LEAD_SECONDS", optional("TRIGGER_LEAD_SECONDS", "120")),
  };
}
