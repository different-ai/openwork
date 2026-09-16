import { describe, expect, test } from "bun:test";

import type { AutomationRun } from "@openwork/types/automations";
import { automationRunNotice, formatAutomationTime, formatAutomationWeekdays, runStatusLabel } from "../src/react-app/domains/automations/automation-format";

function receipt(overrides: Partial<AutomationRun> = {}) {
  return {
    status: "skipped",
    error: { code: "runner_unavailable", message: "The connected desktop was busy.", retryable: false },
    attemptCount: 0,
    startedAt: null,
    resultSummary: null,
    usage: { inputTokens: null, outputTokens: null, costMicros: null },
    ...overrides,
  } satisfies Partial<AutomationRun>;
}

describe("Automation labels", () => {
  test("formats weekly schedules with human-readable weekday names", () => {
    expect(formatAutomationWeekdays([5], "en-US")).toBe("Fri");
    expect(formatAutomationWeekdays([1, 3, 5], "en-US")).toBe("Mon, Wed, Fri");
  });

  test.each([
    "No desktop was connected at the scheduled time.",
    "The connected desktop was busy.",
    "The connected desktop did not claim this occurrence in time.",
  ])("presents an unstarted missed occurrence without replacing its cause: %s", (message) => {
    const run = receipt({ error: { code: "runner_unavailable", message, retryable: false } });
    expect(automationRunNotice(run)).toEqual({
      variant: "default",
      title: "Run missed",
      message: `This occurrence never started. ${message} Keep OpenWork open, signed in, and your computer awake and connected for future runs.`,
    });
    expect(runStatusLabel(run)).toBe("Run missed");
  });

  test.each([
    { attemptCount: 1, startedAt: null },
    { attemptCount: 2, startedAt: null },
    { attemptCount: 0, startedAt: 0 },
    { attemptCount: 0, startedAt: 1_700_000_000_000 },
    { attemptCount: 1, startedAt: 1_700_000_000_000 },
  ])("does not soothe a historical receipt with attempted or started evidence: %j", (evidence) => {
    const run = receipt(evidence);
    expect(automationRunNotice(run)).toEqual({
      variant: "destructive",
      title: "Run interrupted",
      message: `An execution attempt or start was recorded for this run. Recorded cause: ${run.error?.message}`,
    });
    expect(runStatusLabel(run)).toBe("Run interrupted");
    expect(automationRunNotice(run)?.message).not.toContain("never started");
    expect(automationRunNotice(run)?.message).not.toContain("for future runs");
  });

  test.each(["execution_failed", "execution_timed_out", "runner_unavailable", "internal_error"] satisfies NonNullable<AutomationRun["error"]>["code"][])("keeps failed %s errors destructive with their recorded code and message", (code) => {
    const run = receipt({ status: "failed", error: { code, message: "Recorded failure", retryable: false } });
    expect(automationRunNotice(run)).toEqual({ variant: "destructive", title: code, message: "Recorded failure" });
    expect(runStatusLabel(run)).toBe("failed");
  });

  test("names a lost execution lease as interrupted without changing the cause", () => {
    const run = receipt({ status: "failed", error: { code: "lease_lost", message: "The execution lease expired.", retryable: false } });
    expect(automationRunNotice(run)).toEqual({ variant: "destructive", title: "Run interrupted", message: "The execution lease expired." });
    expect(runStatusLabel(run)).toBe("Run interrupted");
  });

  test.each(["model_access_lost", "provider_unavailable"] satisfies NonNullable<AutomationRun["error"]>["code"][])("does not soften a skipped %s error", (code) => {
    const run = receipt({ error: { code, message: "Model unavailable", retryable: false } });
    expect(automationRunNotice(run)).toEqual({ variant: "destructive", title: code, message: "Model unavailable" });
    expect(runStatusLabel(run)).toBe("Skipped — model unavailable");
  });

  test("does not invent a notice, usage or result for an error-free receipt", () => {
    const run = receipt({ status: "succeeded", error: null });
    expect(automationRunNotice(run)).toBeNull();
    expect(runStatusLabel(run)).toBe("Completed");
    expect(run.usage).toEqual({ inputTokens: null, outputTokens: null, costMicros: null });
    expect(run.resultSummary).toBeNull();
    expect(formatAutomationTime(run.startedAt)).toBe("—");
  });

  test("preserves existing usage and result on an interrupted historical receipt", () => {
    const run = receipt({ attemptCount: 1, resultSummary: "Partial output", usage: { inputTokens: 42, outputTokens: null, costMicros: null } });
    expect(automationRunNotice(run)?.variant).toBe("destructive");
    expect(run.resultSummary).toBe("Partial output");
    expect(run.usage).toEqual({ inputTokens: 42, outputTokens: null, costMicros: null });
  });
});
