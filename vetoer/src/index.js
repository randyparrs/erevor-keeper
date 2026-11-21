// erevor-vetoer: Cloudflare Worker that holds GuardianReceiver's vetoer key, apart from the relayer (GitHub Actions).
// A Cron Trigger runs the veto pass every minute: each VOID proposed to GuardianReceiver in the last LOOKBACK_MINUTES
// plus the veto delay that is still pending is checked against the review stored on GenLayer, and vetoed unless a
// FINALIZED VOID review with exactly the recorded prices backs it. GET /health answers 503 when passes stop, fail or
// a veto happened in the last hour, for an external monitor.
//
// Secrets (wrangler secret put): VETOER_PRIVATE_KEY, ARB_RPC_URL, GL_NODE. Addresses are vars in wrangler.toml.
// KV namespace HEALTH keeps the last pass state (written at most every 5 minutes unless something changes).
import { createPublicClient, createWalletClient, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { lensAbi, receiverAbi } from "./abi.js";
import { assetSymbol, health, vetoPass } from "./core.js";

const STATE_KEY = "state";
const WRITE_EVERY_SECONDS = 300;

const log = (level, msg, fields = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }));
const nowSeconds = () => Math.floor(Date.now() / 1000);
const redact = (e) => String((e && (e.shortMessage || e.message)) || e).replace(/(0x)?[0-9a-fA-F]{64}/g, "[redacted]").slice(0, 300);

function key(env) {
  const t = String(env.VETOER_PRIVATE_KEY || "").trim();
  if (!t) throw new Error("VETOER_PRIVATE_KEY secret missing");
  return t.startsWith("0x") ? t : "0x" + t;
}

function address(env, name) {
  const v = String(env[name] || "").trim();
  if (!isAddress(v)) throw new Error(`${name} is not an address`);
  return v;
}

export function makeChain(env) {
  if (!env.ARB_RPC_URL) throw new Error("ARB_RPC_URL secret missing");
  const receiver = address(env, "RECEIVER_ADDRESS");
  const lens = address(env, "LENS_ADDRESS");
  const account = privateKeyToAccount(key(env));
  const transport = http(env.ARB_RPC_URL);
  const pub = createPublicClient({ chain: arbitrumSepolia, transport });
  const wallet = createWalletClient({ chain: arbitrumSepolia, transport, account });
  const lookbackMinutes = Number(env.LOOKBACK_MINUTES || "30");

  return {
    account,
    async checkKey() {
      const expected = address(env, "VETOER_ADDRESS");
      if (account.address.toLowerCase() !== expected.toLowerCase()) throw new Error(`the key is ${account.address}, not VETOER_ADDRESS`);
      const onChain = await pub.readContract({ address: receiver, abi: receiverAbi, functionName: "vetoer" });
      if (onChain.toLowerCase() !== account.address.toLowerCase()) throw new Error(`GuardianReceiver vetoer is ${onChain}, not this key`);
    },
    async voidProposals() {
      const delay = await pub.readContract({ address: receiver, abi: receiverAbi, functionName: "vetoDelay" });
      const seconds = BigInt(Number(delay) + lookbackMinutes * 60);
      const latest = await pub.getBlock();
      // Arbitrum block times vary: measure them over the last 20,000 blocks to size the window.
      const probe = latest.number > 20_000n ? latest.number - 20_000n : 0n;
      const old = await pub.getBlock({ blockNumber: probe });
      const perBlock = Math.max(0.05, Number(latest.timestamp - old.timestamp) / Number(latest.number - probe || 1n));
      const span = BigInt(Math.ceil(Number(seconds) / perBlock)) + 1_000n;
      const fromBlock = latest.number > span ? latest.number - span : 0n;
      const event = receiverAbi.find((x) => x.type === "event" && x.name === "VerdictProposed");
      const logs = await pub.getLogs({ address: receiver, event, fromBlock, toBlock: latest.number });
      return logs.filter((l) => Number(l.args.verdict) === 1).map((l) => ({ roundId: l.args.roundId, genlayerTxRef: l.args.genlayerTxRef }));
    },
    async pendingVoid(roundId) {
      const [executeAfter] = await pub.readContract({ address: receiver, abi: receiverAbi, functionName: "pendingVoid", args: [roundId] });
      return BigInt(executeAfter);
    },
    round: (roundId) => pub.readContract({ address: lens, abi: lensAbi, functionName: "getRound", args: [roundId] }),
    async assetOf(round) {
      const m = await pub.readContract({ address: lens, abi: lensAbi, functionName: "getMarket", args: [round.marketId] });
      return assetSymbol(m.assetId);
    },
    async veto(roundId) {
      const hash = await wallet.writeContract({ address: receiver, abi: receiverAbi, functionName: "vetoVerdict", args: [roundId] });
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error(`vetoVerdict reverted (${hash})`);
      return hash;
    },
  };
}

export function makeReviewReader(env) {
  const guardian = address(env, "GUARDIAN_GL_ADDRESS");
  if (!env.GL_NODE) throw new Error("GL_NODE secret missing");
  const gl = createClient({ chain: testnetBradbury, endpoint: env.GL_NODE });
  return async (roundId) => {
    const raw = await gl.readContract({ address: guardian, functionName: "get_review", args: [roundId.toLowerCase()], transactionHashVariant: "latest-final" });
    return raw ? JSON.parse(String(raw)) : undefined;
  };
}

async function readState(env) {
  try {
    return (await env.HEALTH.get(STATE_KEY, "json")) || {};
  } catch {
    return {};
  }
}

export async function runPass(env) {
  const started = nowSeconds();
  const prev = await readState(env);
  const next = { ...prev, lastPassAt: started };
  let summary;
  try {
    const chain = makeChain(env);
    await chain.checkKey();
    summary = await vetoPass({ chain, readReview: makeReviewReader(env), log });
    next.lastError = summary.errors > 0 ? `${summary.errors} check(s) failed` : null;
    if (summary.vetoed > 0) {
      next.lastVetoAt = started;
      next.lastVetoes = summary.vetoes;
    }
    log(summary.errors > 0 ? "error" : "info", "veto pass", { vetoer: chain.account.address, ...summary, vetoes: undefined });
  } catch (err) {
    next.lastError = redact(err);
    log("error", "veto pass failed", { error: next.lastError });
  }
  const changed = (prev.lastError ?? null) !== (next.lastError ?? null) || prev.lastVetoAt !== next.lastVetoAt;
  if (changed || !prev.writtenAt || started - prev.writtenAt >= WRITE_EVERY_SECONDS) {
    next.writtenAt = started;
    await env.HEALTH.put(STATE_KEY, JSON.stringify(next));
  }
  return { summary, state: next };
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runPass(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/health") return new Response("not found", { status: 404 });
    const state = await readState(env);
    const h = health(state, nowSeconds());
    const body = { ...h, lastPassAt: state.lastPassAt ?? null, lastVetoAt: state.lastVetoAt ?? null, lastVetoes: state.lastVetoes ?? [] };
    return new Response(JSON.stringify(body), {
      status: h.ok ? 200 : 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  },
};
