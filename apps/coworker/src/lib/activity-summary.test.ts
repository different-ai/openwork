import assert from "node:assert/strict";
import { test } from "node:test";
import { describeMemory, describeModelPreference, describeNow, relativeTime } from "./activity-summary.ts";

const now = Date.UTC(2026, 8, 1, 12, 0, 0);

test("relativeTime is compact and empty when unknown", () => {
  assert.equal(relativeTime(0, now), "");
  assert.equal(relativeTime(now - 20_000, now), "now");
  assert.equal(relativeTime(now - 12 * 60_000, now), "12m");
  assert.equal(relativeTime(now - 3 * 3_600_000, now), "3h");
  assert.equal(relativeTime(now - 2 * 86_400_000, now), "2d");
});

test("an idle coworker with no history gets exactly one line", () => {
  const summary = describeNow({ state: "ready", label: "Ready", detail: "Waiting for first assignment", updatedAt: 0 });
  assert.deepEqual(summary, { subject: "", note: "Waiting for the first assignment.", previous: undefined });
  assert.deepEqual(describeNow(undefined), { subject: "", note: "Checking status…", previous: undefined });
});

test("recent work is named once, never repeated as previous", () => {
  const summary = describeNow({
    state: "recent",
    label: "Ready",
    detail: "Draft the release note",
    updatedAt: now,
    threadId: "s1",
    last: { title: "Draft the release note", updatedAt: now, threadId: "s1" },
  });
  assert.equal(summary.subject, "Draft the release note");
  assert.equal(summary.note, "Last worked on this");
  assert.equal(summary.previous, undefined);
});

test("working and attention show the subject plus a distinct previous thread", () => {
  const working = describeNow({
    state: "working",
    label: "Working",
    detail: "Compare onboarding flows",
    updatedAt: now,
    threadId: "s2",
    last: { title: "Draft the release note", updatedAt: now - 3_600_000, threadId: "s1" },
  });
  assert.equal(working.note, "Running now");
  assert.equal(working.previous?.title, "Draft the release note");

  const attention = describeNow({
    state: "attention",
    label: "Needs you",
    detail: "Wants to run a command: rm -rf build",
    updatedAt: now,
    threadId: "s2",
    last: { title: "Wants to run a command: rm -rf build", updatedAt: now, threadId: "s2" },
  });
  assert.equal(attention.note, "Waiting for you — open to respond");
  assert.equal(attention.previous, undefined, "same title as the subject is not repeated");

  const denAttention = describeNow({ state: "attention", label: "Needs you", detail: "Model access lost", updatedAt: now });
  assert.equal(denAttention.note, "Waiting for you");
});

test("model and memory rows describe the persisted state compactly", () => {
  assert.deepEqual(describeModelPreference({ model: "", modelVariant: "" }), { value: "Engine default", hint: "Follows the OpenWork default" });
  assert.deepEqual(describeModelPreference({ model: "anthropic/claude-haiku-4-5", modelVariant: "high" }), {
    value: "claude-haiku-4-5 · High",
    hint: "anthropic",
  });
  assert.deepEqual(describeMemory([], now), { value: "Working memory", hint: "working.md · 0 long-term notes" });
  assert.deepEqual(
    describeMemory(
      [
        { id: "working", updatedAt: now - 12 * 60_000 },
        { id: "long-term/people.md", updatedAt: now },
      ],
      now,
    ),
    { value: "Updated 12m ago", hint: "working.md · 1 long-term note" },
  );
  assert.equal(describeMemory([{ id: "working", updatedAt: now - 5_000 }], now).value, "Updated just now");
});
