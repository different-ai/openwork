import assert from "node:assert/strict";
import test from "node:test";
import { compareBaseline, countRawEscapes } from "./spec-channel-ratchet.mjs";

test("countRawEscapes counts raw rails only when their exact syntax is present", () => {
  const source = `
    import { evalIn } from "@openwork/behaviors";
    evalIn(app, "read");
    denFetch(den, "/v1/write");
    browser.client.send("Input.insertText");
    localStorage.setItem("key", "value");
    seed.evalIn(app, "write");
    probe.eval("read");
  `;
  assert.equal(countRawEscapes(source), 6);
  assert.equal(countRawEscapes("const evalIn = () => true; evalIn();"), 0);
});

test("compareBaseline rejects increases and stale entries", () => {
  assert.deepEqual(compareBaseline({ "kept.e2e.test.ts": 3 }, { "kept.e2e.test.ts": 2 }, new Set(["kept.e2e.test.ts"])), [
    "kept.e2e.test.ts: raw channel escapes increased 2 → 3",
  ]);
  assert.deepEqual(compareBaseline({ "kept.e2e.test.ts": 1 }, { "kept.e2e.test.ts": 2 }, new Set(["kept.e2e.test.ts"])), [
    "kept.e2e.test.ts: baseline is stale 2 → 1; lower it",
  ]);
  assert.deepEqual(compareBaseline({}, { "gone.e2e.test.ts": 1 }, new Set()), [
    "gone.e2e.test.ts: baseline is stale; file no longer exists",
  ]);
});
