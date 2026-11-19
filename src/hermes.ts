// Pyth Hermes stream capture: for every price feed, the first update published at or after a boundary.
//
// The market only accepts, per asset, the first Pyth update with publishTime >= boundary (parsePriceFeedUpdatesUnique,
// prevPublishTime < boundary). The keeper never asks Hermes for a timestamp: it subscribes to the live stream before
// the boundary and keeps, for each feed, the first update whose publish_time is at or after the boundary. If that
// update was missed (for example during a reconnection), the next ones are useless on chain, so the feed is reported
// as missing with the reason instead of sending data that would be rejected.

import type { Hex } from "viem";

/** One feed of one stream event, as Hermes sends it with parsed=true. */
export interface ParsedFeed {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
  metadata?: { prev_publish_time?: number };
}

/** One stream event: the signed update (hex) and its decoded feeds. */
export interface StreamEvent {
  binary: Hex;
  parsed: ParsedFeed[];
}

export interface CapturedUpdate {
  /** Feed id, lower case, 0x prefixed. */
  id: Hex;
  price: bigint;
  conf: bigint;
  expo: number;
  publishTime: number;
  prevPublishTime: number;
  /** Signed update data (0x prefixed hex) that contains this feed. */
  binary: Hex;
}

export type MissReason = "no update yet" | "first update missed" | "stream failed";

export function normalizeId(id: string): Hex {
  const lower = id.toLowerCase();
  return (lower.startsWith("0x") ? lower : `0x${lower}`) as Hex;
}

/**
 * Splits a Server-Sent Events buffer into complete events. Returns the data payload of each complete event and the
 * unfinished tail to keep for the next chunk.
 */
export function splitSse(buffer: string): { events: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() ?? "";
  const events: string[] = [];
  for (const part of parts) {
    const data = part
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("");
    if (data !== "") events.push(data);
  }
  return { events, rest };
}

/** Decodes one stream payload. Returns undefined for payloads that are not price updates. */
export function parseStreamEvent(payload: string): StreamEvent | undefined {
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return undefined;
  }
  const ev = json as { binary?: { data?: string[]; encoding?: string }; parsed?: ParsedFeed[] };
  const data = ev.binary?.data;
  if (!Array.isArray(data) || data.length === 0 || !Array.isArray(ev.parsed)) return undefined;
  if (ev.binary?.encoding !== undefined && ev.binary.encoding !== "hex") return undefined;
  // Hermes sends one accumulator update per event that carries every feed in `parsed`.
  const hex = data.join("");
  return { binary: (hex.startsWith("0x") ? hex : `0x${hex}`) as Hex, parsed: ev.parsed };
}

/** Keeps, per feed, the first update at or after `boundary`, and why a feed could not be captured. */
export class FirstUpdateCapture {
  readonly captured = new Map<Hex, CapturedUpdate>();
  private readonly missed = new Map<Hex, MissReason>();
  private readonly wanted: Set<Hex>;

  constructor(ids: readonly string[], readonly boundary: number) {
    this.wanted = new Set(ids.map(normalizeId));
  }

  /** Feeds a stream event in. */
  offer(ev: StreamEvent): void {
    for (const feed of ev.parsed) {
      const id = normalizeId(feed.id);
      if (!this.wanted.has(id) || this.captured.has(id) || this.missed.has(id)) continue;
      const publishTime = Number(feed.price.publish_time);
      if (publishTime < this.boundary) continue;
      const prev = Number(feed.metadata?.prev_publish_time ?? Number.NaN);
      // Only the first update after the boundary passes the on chain uniqueness check.
      if (!(prev < this.boundary)) {
        this.missed.set(id, "first update missed");
        continue;
      }
      this.captured.set(id, {
        id,
        price: BigInt(feed.price.price),
        conf: BigInt(feed.price.conf),
        expo: Number(feed.price.expo),
        publishTime,
        prevPublishTime: prev,
        binary: ev.binary,
      });
    }
  }

  /** True once every wanted feed is either captured or known to be lost. */
  get settled(): boolean {
    for (const id of this.wanted) if (!this.captured.has(id) && !this.missed.has(id)) return false;
    return true;
  }

  has(id: string): boolean {
    return this.captured.has(normalizeId(id));
  }

  /** Why a feed has no usable update. */
  reasonFor(id: string, streamFailed: boolean): MissReason {
    return this.missed.get(normalizeId(id)) ?? (streamFailed ? "stream failed" : "no update yet");
  }

  /** Distinct signed updates covering `ids` (captured ones only), in first seen order. */
  updateData(ids: readonly string[]): Hex[] {
    const out: Hex[] = [];
    for (const id of ids) {
      const c = this.captured.get(normalizeId(id));
      if (c && !out.includes(c.binary)) out.push(c.binary);
    }
    return out;
  }
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}>;

export interface StreamOptions {
  hermesUrl: string;
  apiKey: string;
  ids: readonly string[];
  boundary: number;
  /** Stop capturing at this time (ms since epoch) even if some feeds are still missing. */
  deadlineMs: number;
  /** Delay between reconnection attempts (ms). */
  reconnectDelayMs?: number;
  fetchImpl?: FetchLike;
  onEvent?: (e: { type: "connected" | "disconnected" | "error"; attempt: number; reason?: string }) => void;
  signal?: AbortSignal;
}

export interface StreamResult {
  capture: FirstUpdateCapture;
  /** True when the stream could not be kept open at some point (the reasons were reported through onEvent). */
  failed: boolean;
  connections: number;
  /** Set when Hermes rejected the API key (401 or 403): retrying cannot help, so the capture stops at once. */
  authError?: { status: number; detail: string };
}

/** 401 (missing or expired key) and 403 (invalid key or no access to a feed) are authentication failures. */
export function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

class HermesAuthError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`hermes rejected the API key: http ${status}${detail ? `: ${detail}` : ""}`);
  }
}

export function streamUrl(hermesUrl: string, ids: readonly string[]): string {
  const qs = ids.map((id) => `ids[]=${normalizeId(id).slice(2)}`).join("&");
  return `${hermesUrl.replace(/\/$/, "")}/v2/updates/price/stream?${qs}&encoding=hex&parsed=true`;
}

/**
 * Subscribes to the Hermes stream and captures the first update at or after `boundary` for every id. Reconnects with
 * a fixed delay while the deadline allows. Resolves when every feed is settled, at the deadline, or on abort.
 */
export async function captureFirstUpdates(opts: StreamOptions): Promise<StreamResult> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const capture = new FirstUpdateCapture(opts.ids, opts.boundary);
  const url = streamUrl(opts.hermesUrl, opts.ids);
  const reconnectDelay = opts.reconnectDelayMs ?? 500;
  let failed = false;
  let connections = 0;
  let authError: StreamResult["authError"];

  for (let attempt = 1; !capture.settled && Date.now() < opts.deadlineMs && !opts.signal?.aborted; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(0, opts.deadlineMs - Date.now()));
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${opts.apiKey}`, Accept: "text/event-stream" },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const detail = res.body ? (await res.text()).slice(0, 200) : "";
        if (isAuthStatus(res.status)) throw new HermesAuthError(res.status, detail);
        throw new Error(`hermes stream http ${res.status}${detail ? `: ${detail}` : ""}`);
      }
      connections++;
      opts.onEvent?.({ type: "connected", attempt });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = splitSse(buffer);
        buffer = rest;
        for (const payload of events) {
          const ev = parseStreamEvent(payload);
          if (ev) capture.offer(ev);
        }
        if (capture.settled) break;
      }
      await reader.cancel().catch(() => undefined);
      if (!capture.settled && Date.now() < opts.deadlineMs) {
        failed = true;
        opts.onEvent?.({ type: "disconnected", attempt, reason: "stream ended by the server" });
      }
    } catch (err) {
      if (err instanceof HermesAuthError) {
        failed = true;
        authError = { status: err.status, detail: err.detail };
        opts.onEvent?.({ type: "error", attempt, reason: err.message });
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        break;
      }
      const aborted = ctrl.signal.aborted;
      if (!aborted || Date.now() < opts.deadlineMs - 5) {
        failed = true;
        opts.onEvent?.({ type: "error", attempt, reason: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
    if (!capture.settled && Date.now() + reconnectDelay < opts.deadlineMs && !opts.signal?.aborted) {
      await new Promise((r) => setTimeout(r, reconnectDelay));
    }
  }
  return { capture, failed, connections, authError };
}
