import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FirstUpdateCapture,
  captureFirstUpdates,
  parseStreamEvent,
  splitSse,
  streamUrl,
  type FetchLike,
  type StreamEvent,
} from "../src/hermes.js";

const B = 1_800_000_000; // boundary
const BTC = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const ETH = "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";

/** One Hermes stream payload with every feed published at `t` (prev = t - 1), as observed on the live stream. */
function payload(t: number, feeds = [BTC, ETH], blob = `aa${t.toString(16)}`, prev = t - 1): string {
  return JSON.stringify({
    binary: { encoding: "hex", data: [blob] },
    parsed: feeds.map((id) => ({
      id,
      price: { price: "6263002512839", conf: "3077487161", expo: -8, publish_time: t },
      ema_price: { price: "6282188150000", conf: "3974375557", expo: -8, publish_time: t },
      metadata: { slot: 1, proof_available_time: t, prev_publish_time: prev },
    })),
  });
}

function event(t: number, feeds?: string[]): StreamEvent {
  return parseStreamEvent(payload(t, feeds))!;
}

test("SSE buffers are split into complete data events and a tail", () => {
  const { events, rest } = splitSse(`data:${payload(B)}\n\n: keepalive\n\ndata:${payload(B + 1)}\r\n\r\ndata:{"par`);
  assert.equal(events.length, 2);
  assert.equal(rest, 'data:{"par');
  assert.equal(parseStreamEvent(events[0]!)?.parsed[0]?.price.publish_time, B);
  assert.equal(parseStreamEvent("not json"), undefined);
  assert.equal(parseStreamEvent('{"parsed":[]}'), undefined);
});

test("stream URL asks for hex encoded, parsed updates of every feed", () => {
  const url = streamUrl("https://hermes.pyth.network/", [`0x${BTC}`, ETH]);
  assert.equal(url, `https://hermes.pyth.network/v2/updates/price/stream?ids[]=${BTC}&ids[]=${ETH}&encoding=hex&parsed=true`);
});

test("the first update at or after the boundary is captured, earlier and later ones are ignored", () => {
  const c = new FirstUpdateCapture([BTC, ETH], B);
  c.offer(event(B - 2));
  c.offer(event(B - 1));
  assert.equal(c.captured.size, 0, "pre boundary updates are never used");
  c.offer(event(B));
  c.offer(event(B + 1));
  assert.equal(c.captured.get(`0x${BTC}`)?.publishTime, B);
  assert.equal(c.captured.get(`0x${BTC}`)?.prevPublishTime, B - 1);
  assert.equal(c.captured.get(`0x${ETH}`)?.publishTime, B);
  assert.ok(c.settled);
  assert.deepEqual(c.updateData([BTC, ETH]), [`0xaa${B.toString(16)}`], "one blob covers both feeds");
});

test("feeds first seen in different events keep their own blob", () => {
  const c = new FirstUpdateCapture([BTC, ETH], B);
  c.offer(event(B, [BTC]));
  // ETH had no update at B: its first update after the boundary is at B + 1, with a previous one before B.
  c.offer(parseStreamEvent(payload(B + 1, [ETH], undefined, B - 3))!);
  assert.deepEqual(c.updateData([BTC, ETH]), [`0xaa${B.toString(16)}`, `0xaa${(B + 1).toString(16)}`]);
});

test("an update whose previous publish time is already past the boundary means the first one was missed", () => {
  const c = new FirstUpdateCapture([BTC], B);
  c.offer(event(B + 3)); // prev = B + 2: the first update after the boundary was not seen
  assert.equal(c.has(BTC), false);
  assert.ok(c.settled);
  assert.equal(c.reasonFor(BTC, true), "first update missed");
  c.offer(event(B + 4));
  assert.equal(c.has(BTC), false, "later updates are rejected on chain, never captured");
});

// ------------------------------------------------------------------ stream with a fake fetch

function body(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

function fakeFetch(responses: (() => Awaited<ReturnType<FetchLike>>)[]): { fetch: FetchLike; calls: { url: string; auth?: string }[] } {
  const calls: { url: string; auth?: string }[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    const next = responses[Math.min(i++, responses.length - 1)]!;
    return next();
  };
  return { fetch, calls };
}

const ok = (chunks: string[]) => () => ({ ok: true, status: 200, body: body(chunks), text: async () => "" });
const httpError = (status: number) => () => ({ ok: false, status, body: body(["denied"]), text: async () => "denied" });

test("events split across chunks are captured and the key is sent as a bearer token", async () => {
  const full = `data:${payload(B - 1)}\n\ndata:${payload(B)}\n\n`;
  const half = Math.floor(full.length / 2);
  const { fetch, calls } = fakeFetch([ok([full.slice(0, 7), full.slice(7, half), full.slice(half)])]);
  const r = await captureFirstUpdates({ hermesUrl: "https://h", apiKey: "k", ids: [BTC, ETH], boundary: B, deadlineMs: Date.now() + 2_000, fetchImpl: fetch });
  assert.equal(r.failed, false);
  assert.equal(r.connections, 1);
  assert.equal(r.capture.captured.size, 2);
  assert.equal(calls[0]?.auth, "Bearer k");
});

test("a failed connection is retried inside the window and the reason is reported", async () => {
  const { fetch, calls } = fakeFetch([httpError(503), ok([`data:${payload(B)}\n\n`])]);
  const events: { type: string; reason?: string }[] = [];
  const r = await captureFirstUpdates({
    hermesUrl: "https://h",
    apiKey: "k",
    ids: [BTC, ETH],
    boundary: B,
    deadlineMs: Date.now() + 2_000,
    reconnectDelayMs: 10,
    fetchImpl: fetch,
    onEvent: (e) => events.push(e),
  });
  assert.equal(calls.length, 2);
  assert.equal(r.failed, true);
  assert.ok(r.capture.settled);
  assert.equal(r.capture.captured.size, 2);
  assert.equal(events[0]?.type, "error");
  assert.match(events[0]?.reason ?? "", /503/);
});

test("a stream dropped before the boundary reconnects and still captures the first update", async () => {
  const { fetch } = fakeFetch([ok([`data:${payload(B - 1)}\n\n`]), ok([`data:${payload(B)}\n\n`])]);
  const r = await captureFirstUpdates({ hermesUrl: "https://h", apiKey: "k", ids: [BTC], boundary: B, deadlineMs: Date.now() + 2_000, reconnectDelayMs: 10, fetchImpl: fetch });
  assert.equal(r.connections, 2);
  assert.equal(r.capture.captured.get(`0x${BTC}`)?.publishTime, B);
});

test("a reconnection that arrives after the first update reports the feed as missed", async () => {
  const { fetch } = fakeFetch([ok([`data:${payload(B - 1)}\n\n`]), ok([`data:${payload(B + 2)}\n\n`])]);
  const r = await captureFirstUpdates({ hermesUrl: "https://h", apiKey: "k", ids: [BTC], boundary: B, deadlineMs: Date.now() + 2_000, reconnectDelayMs: 10, fetchImpl: fetch });
  assert.equal(r.capture.has(BTC), false);
  assert.equal(r.capture.reasonFor(BTC, r.failed), "first update missed");
});

test("the capture stops at the deadline when no update arrives", async () => {
  const { fetch } = fakeFetch([httpError(401)]);
  const started = Date.now();
  const r = await captureFirstUpdates({ hermesUrl: "https://h", apiKey: "bad", ids: [BTC], boundary: B, deadlineMs: Date.now() + 300, reconnectDelayMs: 50, fetchImpl: fetch });
  assert.ok(Date.now() - started < 1_000);
  assert.equal(r.capture.has(BTC), false);
  assert.equal(r.capture.reasonFor(BTC, r.failed), "stream failed");
});

test("a rejected API key (401 or 403) stops the capture at once with the status", async () => {
  for (const status of [401, 403]) {
    const { fetch, calls } = fakeFetch([httpError(status)]);
    const r = await captureFirstUpdates({ hermesUrl: "https://h", apiKey: "expired", ids: [BTC], boundary: B, deadlineMs: Date.now() + 2_000, reconnectDelayMs: 10, fetchImpl: fetch });
    assert.equal(calls.length, 1, "no retry with a rejected key");
    assert.equal(r.authError?.status, status);
    assert.match(r.authError?.detail ?? "", /denied/);
  }
});
