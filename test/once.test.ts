import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseOnceTarget } from "../src/schedule.js";

const T0 = 1_800_000_000; // aligned to 300
const WINDOW = 27; // bufferSeconds 30 minus a 3 s safety margin

test("a runner ready 2 minutes early waits for the next boundary and checks the previous one", () => {
  assert.deepEqual(chooseOnceTarget(T0 + 180, WINDOW), { target: T0 + 300, late: false, previous: T0 });
});

test("a late runner still inside the window handles the current boundary immediately", () => {
  assert.deepEqual(chooseOnceTarget(T0 + 12, WINDOW), { target: T0, late: true, previous: undefined });
});

test("exactly at the boundary is not late", () => {
  assert.deepEqual(chooseOnceTarget(T0, WINDOW), { target: T0, late: false, previous: undefined });
});

test("a runner past the window moves to the next boundary and checks the missed one", () => {
  assert.deepEqual(chooseOnceTarget(T0 + 40, WINDOW), { target: T0 + 300, late: false, previous: T0 });
});
