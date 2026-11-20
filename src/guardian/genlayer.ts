// GenLayer Bradbury (Phase 2) access for the guardian roles, with genlayer-js 2.0.0-rc.2.
// Reads go to the GenLayer node; writes are signed by the relayer key. The public node refuses eth_call without a
// "from", so reads carry the caller's address.

import { createAccount, createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import type { Hex } from "viem";

export const DEFAULT_GL_NODE = "https://rpc-bradbury.genlayer.com";
const MAX_FEE_WEI = 10n * 10n ** 18n;

let shimmed = false;

/** Adds "from" to every eth_call the SDK sends without one. */
export function installFromShim(address: string): void {
  if (shimmed) return;
  shimmed = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    if (init && typeof init.body === "string" && init.body.includes('"eth_call"')) {
      const b = JSON.parse(init.body);
      for (const r of Array.isArray(b) ? b : [b]) if (r.method === "eth_call" && r.params?.[0] && !r.params[0].from) r.params[0].from = address;
      init = { ...init, body: JSON.stringify(b) };
    }
    return realFetch(url, init);
  }) as typeof fetch;
}

export interface ReviewRecord {
  round_id: string;
  inputs: {
    asset: string;
    lock_ts: number;
    close_ts: number;
    lock_price: string;
    close_price: string;
    outcome: "UP" | "DOWN" | "TIE";
    price_decimals: number;
  };
  result: {
    verdict: "VALID" | "VOID" | "INCONCLUSIVE";
    lock_sources: string[];
    close_sources: string[];
    median_lock?: string;
    median_close?: string;
    deviation_lock_bps?: number;
    deviation_close_bps?: number;
    tolerance_bps?: number;
    computed_outcome?: string;
  };
}

export class GuardianGL {
  private readonly reader;
  private readonly writer;

  constructor(
    readonly guardian: Hex,
    readerAddress: Hex,
    private readonly signerKey?: Hex,
    node = DEFAULT_GL_NODE,
  ) {
    installFromShim(readerAddress);
    this.reader = createClient({ chain: testnetBradbury, endpoint: node } as any);
    this.writer = signerKey ? createClient({ chain: testnetBradbury, account: createAccount(signerKey) } as any) : undefined;
  }

  /** The review stored for a round in the latest FINALIZED state of the contract, or undefined. */
  async finalReview(roundId: Hex): Promise<ReviewRecord | undefined> {
    const raw = (await (this.reader as any).readContract({
      address: this.guardian,
      functionName: "get_review",
      args: [roundId.toLowerCase()],
      transactionHashVariant: "latest-final",
    })) as string;
    return raw ? (JSON.parse(raw) as ReviewRecord) : undefined;
  }

  /** Sends review(...) and returns the GenLayer transaction hash. */
  async sendReview(args: [string, string, number, number, string, string, string, number]): Promise<Hex> {
    if (!this.writer) throw new Error("no GenLayer signer");
    const w = this.writer as any;
    const fees = await w.estimateTransactionFees({ appealRounds: 0 });
    if (BigInt(fees.feeValue) > MAX_FEE_WEI) throw new Error(`fee deposit ${fees.feeValue} wei above 10 GEN, not sent`);
    return (await w.writeContract({ address: this.guardian, functionName: "review", args, value: 0n, fees })) as Hex;
  }

  /** Waits until the transaction is FINALIZED or `timeoutMs` passes. Returns its status and execution result. */
  async waitFinal(hash: Hex, timeoutMs: number): Promise<{ status: string; execution?: string; final: boolean }> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const tx = (await (this.reader as any).getTransaction({ hash })) as any;
      const status = String(tx.statusName ?? tx.status);
      if (status === "FINALIZED" || Date.now() > end) {
        return { status, execution: tx.txExecutionResultName, final: status === "FINALIZED" };
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}
