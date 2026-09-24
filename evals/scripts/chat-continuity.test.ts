import test from "node:test";
import assert from "node:assert/strict";
import { historyRequestState, normalizeContinuityText } from "../worlds/chat-continuity.ts";

const native = "1. Watch the **buds** open.\n\n2. Record the leaf's colour.\n\n3. Keep 12 observations.";
const rendered = "Watch the buds open.\nRecord the leaf's colour.\nKeep 12 observations.";

test("continuity normalization tolerates markdown ordinals, formatting and rendered whitespace", () => {
  assert.equal(normalizeContinuityText(native), normalizeContinuityText(rendered));
  assert.equal(normalizeContinuityText("**1.** Watch\u00a0the buds.\n02) Record the leaves."), "Watch the buds. Record the leaves.");
  assert.equal(normalizeContinuityText("# Notes\n- Observe `buds`.\n* Record leaves."), "Notes Observe buds. Record leaves.");
  assert(normalizeContinuityText(rendered).startsWith(normalizeContinuityText("1. Watch the bu")));
});

test("normalization retains meaningful content and detects dropped, duplicated, reordered or changed text", () => {
  const expected = normalizeContinuityText(native);
  for (const changed of [
    "Record the leaf's colour. Keep 12 observations.",
    `${rendered}\nKeep 12 observations.`,
    "Record the leaf's colour. Watch the buds open. Keep 12 observations.",
    rendered.replace("12", "13"),
    rendered.replace("leaf's", "bud's"),
    rendered.replace("the buds", "thebuds"),
  ]) assert.notEqual(normalizeContinuityText(changed), expected);
  assert.equal(normalizeContinuityText("Record the leaf's colour.").startsWith(normalizeContinuityText("Watch the buds")), false);
});

test("outstanding history reads are session-scoped, independent of limit and exclude finished or failed network IDs", () => {
  const held = new Map([
    ["fetch-a-full", { networkId: "network-a-full", sessionId: "A", snapshot: true, startedAt: 100 }],
    ["fetch-a-page", { networkId: "network-a-page", sessionId: "A", snapshot: false, startedAt: 200 }],
    ["fetch-b-full", { networkId: "network-b-full", sessionId: "B", snapshot: true, startedAt: 300 }],
  ]);
  const ended = new Set<string>();
  assert.deepEqual(historyRequestState(held, ended, "A", false, 500), { held: 3, outstanding: 2, pending: true, elapsedMs: 400 });
  ended.add("network-a-full");
  assert.deepEqual(historyRequestState(held, ended, "A", false, 500), { held: 3, outstanding: 1, pending: false, elapsedMs: 0 });
  ended.add("network-a-page");
  assert.deepEqual(historyRequestState(held, ended, "A", false, 500), { held: 3, outstanding: 0, pending: false, elapsedMs: 0 });
  assert.equal(historyRequestState(held, ended, "B", false, 500).outstanding, 1);
  assert.equal(historyRequestState(held, ended, "missing", false, 500).outstanding, 0);
  assert.deepEqual(historyRequestState(held, ended, "B", true, 500), { held: 3, outstanding: 1, pending: false, elapsedMs: 200 });
  ended.add("network-b-full");
  assert.equal(historyRequestState(held, ended, "B", true, 500).outstanding, 0);
});
