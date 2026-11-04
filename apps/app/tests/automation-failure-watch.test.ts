import { expect, test } from "bun:test";
import type { AutomationList } from "@openwork/types/automations";
import { automationFailureNotices } from "../src/react-app/domains/automations/automation-failure-watch.ts";

type Item = AutomationList["items"][number];

function item(name: string, run: { id: string; status: string; finishedAt: number | null; code?: string; message?: string } | null): Item {
  return {
    automation: { id: `aut_${name}`, name },
    latestRun: run && {
      id: run.id,
      status: run.status,
      finishedAt: run.finishedAt,
      error: run.code ? { code: run.code, message: run.message ?? "It stopped.", retryable: false } : null,
    },
  } as unknown as Item;
}

const reconnect = "Gmail needs to be reconnected, so this run could not use it. Reconnect Gmail in OpenWork, then run the Automation again.";

test("the first check only records where it is: earlier failures are history", () => {
  const result = automationFailureNotices([
    item("Daily summary", { id: "run_old", status: "failed", finishedAt: 100, code: "execution_failed" }),
    item("Inbox triage", { id: "run_ok", status: "succeeded", finishedAt: 200 }),
  ], null);
  expect(result).toEqual({ notices: [], watermark: 200 });
});

test("a run that failed after the watermark is announced once, naming the connection fix", () => {
  const items = [
    item("Daily summary", { id: "run_new", status: "failed", finishedAt: 300, code: "connection_action_required", message: reconnect }),
    item("Inbox triage", { id: "run_ok", status: "succeeded", finishedAt: 250 }),
    item("Weekly report", { id: "run_running", status: "running", finishedAt: null }),
  ];
  const first = automationFailureNotices(items, 200);
  expect(first.notices).toEqual([{ runId: "run_new", automationId: "aut_Daily summary", title: "Daily summary needs a connection", body: reconnect }]);
  expect(first.watermark).toBe(300);
  // The next poll returns the same list: nothing new to say.
  expect(automationFailureNotices(items, first.watermark).notices).toEqual([]);
});

test("other failures say the Automation failed; cancelled and skipped runs stay quiet", () => {
  const { notices } = automationFailureNotices([
    item("Weekly report", { id: "run_timeout", status: "failed", finishedAt: 410, code: "execution_timed_out", message: "The Automation run exceeded its maximum runtime." }),
    item("Daily summary", { id: "run_bare", status: "failed", finishedAt: 405 }),
    item("Inbox triage", { id: "run_cancelled", status: "cancelled", finishedAt: 420, code: "cancelled" }),
    item("Standup notes", { id: "run_skipped", status: "skipped", finishedAt: 430, code: "runner_unavailable" }),
  ], 400);
  expect(notices.map((notice) => [notice.runId, notice.title])).toEqual([
    ["run_bare", "Daily summary failed"],
    ["run_timeout", "Weekly report failed"],
  ]);
  expect(notices[0]?.body).toContain("Open it in Automations");
});
