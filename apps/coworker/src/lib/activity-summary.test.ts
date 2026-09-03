import assert from "node:assert/strict";
import { test } from "node:test";
import { describeNow, describeOutcome, mergeRecentWork, relativeTime } from "./activity-summary.ts";

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
  assert.deepEqual(summary, { subject: "", note: "Waiting for the first assignment.", needsYou: false });
  assert.deepEqual(describeNow(undefined), { subject: "", note: "Checking status…", needsYou: false });
});

test("a ready coworker with history says only Ready; the recent list owns the history", () => {
  const summary = describeNow({
    state: "recent",
    label: "Ready",
    detail: "Draft the release note",
    updatedAt: now,
    threadId: "s1",
    last: { title: "Draft the release note", updatedAt: now, threadId: "s1" },
  });
  assert.deepEqual(summary, { subject: "", note: "", needsYou: false });
});

test("working names the subject once; attention asks for the person", () => {
  const working = describeNow({
    state: "working",
    label: "Working",
    detail: "Compare onboarding flows",
    updatedAt: now,
    threadId: "s2",
    last: { title: "Draft the release note", updatedAt: now - 3_600_000, threadId: "s1" },
  });
  assert.deepEqual(working, { subject: "Compare onboarding flows", note: "", needsYou: false });

  const attention = describeNow({
    state: "attention",
    label: "Waiting for permission",
    detail: "Wants to run a command: rm -rf build",
    updatedAt: now,
    threadId: "s2",
  });
  assert.equal(attention.subject, "Wants to run a command: rm -rf build");
  assert.equal(attention.needsYou, true);

  const failedRun = describeNow({ state: "attention", label: "Run failed", detail: "Morning digest", updatedAt: now, threadId: "s4" });
  assert.deepEqual(failedRun, { subject: "Morning digest", note: "", needsYou: false });

  const retrying = describeNow({ state: "retrying", label: "Retrying", detail: "Weekly digest", updatedAt: now, threadId: "s3" });
  assert.equal(retrying.note, "Retrying after an interruption");
  const stalled = describeNow({ state: "retrying", label: "Paused", detail: "Weekly digest", reason: "Free usage exceeded, subscribe to Go", updatedAt: now, threadId: "s3" });
  assert.deepEqual(stalled, { subject: "Weekly digest", note: "The AI model is unavailable: Free usage exceeded, subscribe to Go. Choose another AI model to continue.", needsYou: true });

  const offline = describeNow({ state: "offline", label: "Not responding", detail: "", updatedAt: 0 });
  assert.match(offline.note, /not answering/);
  assert.deepEqual(describeNow({ state: "starting", label: "Starting up", detail: "", updatedAt: 0 }), { subject: "", note: "", needsYou: false });
});

test("recent work merges finished assignments and responsibility runs, newest first, bounded", () => {
  const merged = mergeRecentWork(
    {
      recent: [
        { id: "s1", title: "Draft the release note", kind: "assignment", outcome: "finished", finishedAt: now - 60_000, threadId: "s1" },
        { id: "s0", title: "Old research", kind: "assignment", outcome: "finished", finishedAt: now - 86_400_000, threadId: "s0" },
      ],
    },
    [
      {
        id: "r1",
        name: "Morning digest",
        latestRun: { id: "run1", status: "succeeded", trigger: "scheduled", queuedAt: null, startedAt: now - 30_000, finishedAt: now - 10_000, threadId: "ses_digest", error: "", summary: "Digest sent." },
      },
      {
        id: "r2",
        name: "Backup check",
        latestRun: { id: "run2", status: "failed", trigger: "manual", queuedAt: null, startedAt: now - 7_200_000, finishedAt: now - 7_000_000, threadId: "", error: "Model unavailable", summary: "" },
      },
      {
        id: "r3",
        name: "Still running",
        latestRun: { id: "run3", status: "running", trigger: "manual", queuedAt: null, startedAt: now - 5_000, finishedAt: null, threadId: "ses_live", error: "", summary: "" },
      },
      { id: "r4", name: "Never ran", latestRun: null },
    ],
    3,
  );
  assert.deepEqual(merged.map((entry) => entry.title), ["Morning digest", "Draft the release note", "Backup check"]);
  assert.equal(merged[0]?.threadId, "ses_digest");
  assert.equal(merged[2]?.error, "Model unavailable");
  assert.equal(merged[2]?.threadId, undefined);
  assert.deepEqual(merged.map(describeOutcome), ["Done", "Finished", "Didn't finish"]);
  assert.deepEqual(mergeRecentWork(undefined, []), []);
});

test("a responsibility run's own thread is listed once, as the run", () => {
  const merged = mergeRecentWork(
    {
      recent: [
        { id: "ses_digest", title: "Morning digest", kind: "assignment", outcome: "finished", finishedAt: now - 9_000, threadId: "ses_digest" },
        { id: "s1", title: "Draft the release note", kind: "assignment", outcome: "finished", finishedAt: now - 60_000, threadId: "s1" },
      ],
    },
    [
      {
        id: "r1",
        name: "Morning digest",
        latestRun: { id: "run1", status: "succeeded", trigger: "manual", queuedAt: null, startedAt: now - 30_000, finishedAt: now - 10_000, threadId: "ses_digest", error: "", summary: "" },
      },
    ],
  );
  assert.deepEqual(merged.map((entry) => [entry.title, entry.kind]), [["Morning digest", "responsibility"], ["Draft the release note", "assignment"]]);
});
