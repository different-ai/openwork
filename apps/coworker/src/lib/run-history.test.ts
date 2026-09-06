import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutomationRun } from "@openwork/types/automations";
import type { LocalResponsibilityRun } from "./bridge.ts";
import { cloudRunEntry, describeRunOutcome, formatDuration, localRunEntry, summarizeRuns, type RunOutcome } from "./run-history.ts";

const now = Date.UTC(2026, 8, 1, 12, 0, 0);

test("local runs describe themselves once, with duration and their own summary", () => {
  const entry = localRunEntry({
    id: "run1",
    status: "succeeded",
    trigger: "manual",
    queuedAt: null,
    startedAt: now - 95_000,
    finishedAt: now,
    threadId: "ses_1",
    error: "",
    summary: "Digest sent to the team.",
  });
  assert.equal(entry.outcome, "succeeded");
  assert.equal(entry.how, "Started by you");
  assert.equal(entry.at, now);
  assert.equal(entry.durationMs, 95_000);
  assert.equal(formatDuration(entry.durationMs ?? 0), "1m 35s");
  assert.equal(entry.summary, "Digest sent to the team.");

  const queuedRun: LocalResponsibilityRun = {
    id: "run2",
    status: "queued",
    trigger: "scheduled",
    queuedAt: now,
    startedAt: 0,
    finishedAt: null,
    threadId: "",
    error: "",
    summary: "",
  };
  const queued = localRunEntry(queuedRun);
  assert.equal(queued.at, now);
  assert.equal(queued.durationMs, null);
  assert.equal(queued.how, "");
  assert.equal(describeRunOutcome(queued.outcome), "Waiting its turn");
  assert.equal(localRunEntry({ ...queuedRun, id: "run3", trigger: "resume" }).how, "Picked up where it stopped");
});

function denRun(overrides: Partial<AutomationRun>): AutomationRun {
  return {
    id: "arun_1",
    automationId: "atm_1",
    revisionId: "arev_1",
    trigger: "scheduled",
    scheduledFor: Date.UTC(2026, 8, 1, 9, 0, 0),
    idempotencyKey: "k1",
    status: "succeeded",
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    attemptCount: 1,
    executionTarget: "cloud",
    executionThread: null,
    providerId: "openwork",
    modelId: "fable",
    modelVariant: null,
    startedAt: Date.UTC(2026, 8, 1, 9, 0, 2),
    finishedAt: Date.UTC(2026, 8, 1, 9, 0, 40),
    error: null,
    resultSummary: " Posted the summary. ",
    usage: { inputTokens: null, outputTokens: null, costMicros: null },
    createdAt: Date.UTC(2026, 8, 1, 9, 0, 0),
    updatedAt: Date.UTC(2026, 8, 1, 9, 0, 40),
    ...overrides,
  };
}

test("cloud runs map Den statuses onto the same words and keep Den's result summary", () => {
  const succeeded = cloudRunEntry(denRun({}));
  assert.equal(succeeded.outcome, "succeeded");
  assert.equal(succeeded.summary, "Posted the summary.");
  assert.equal(succeeded.durationMs, 38_000);
  assert.equal(succeeded.threadId, "");
  const skipped = cloudRunEntry(denRun({
    status: "skipped",
    startedAt: null,
    finishedAt: null,
    error: { code: "runner_unavailable", message: "No desktop was connected", retryable: true },
  }));
  assert.equal(skipped.outcome, "missed");
  assert.equal(describeRunOutcome(skipped.outcome), "Missed");
  assert.equal(skipped.error, "No desktop was connected");
  assert.equal(skipped.at, Date.UTC(2026, 8, 1, 9, 0, 0));
  assert.equal(cloudRunEntry(denRun({ status: "claimed" })).outcome, "running");
});

test("durations and trend lines stay short", () => {
  assert.equal(formatDuration(4_000), "4s");
  assert.equal(formatDuration(120_000), "2m");
  assert.equal(formatDuration(3_900_000), "1h 5m");
  const outcomes: RunOutcome[] = ["succeeded", "succeeded", "failed", "missed", "running", "queued"];
  const entries = outcomes.map((outcome, index) => ({
    id: String(index),
    outcome,
    how: "",
    at: now,
    durationMs: null,
    summary: "",
    error: "",
    threadId: "",
  }));
  assert.equal(summarizeRuns(entries), "Ran 4 times · 2 done · 1 didn't finish · 1 missed");
  assert.equal(summarizeRuns(entries.filter((entry) => entry.outcome === "succeeded").slice(0, 1)), "Ran once · done");
  assert.equal(summarizeRuns([]), "");
});
