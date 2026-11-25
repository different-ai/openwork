import { expect, test } from "bun:test";
import type { AutomationList } from "@openwork/types/automations";
import { automationFailureNotices, missedRunBody, missedRunOffer } from "../src/react-app/domains/automations/automation-failure-watch.ts";

type Item = AutomationList["items"][number];

function item(
  name: string,
  run: { id: string; status: string; finishedAt: number | null; code?: string; message?: string; attemptCount?: number; startedAt?: number | null } | null,
  automation: { state?: string; nextDueAt?: number | null; executionTarget?: "desktop" | "cloud" } = {},
): Item {
  return {
    automation: { id: `aut_${name}`, name, state: automation.state ?? "active", nextDueAt: automation.nextDueAt === undefined ? 9_000 : automation.nextDueAt },
    revision: { executionTarget: automation.executionTarget },
    latestRun: run && {
      id: run.id,
      status: run.status,
      finishedAt: run.finishedAt,
      attemptCount: run.attemptCount ?? 1,
      startedAt: run.startedAt === undefined ? 1 : run.startedAt,
      error: run.code ? { code: run.code, message: run.message ?? "It stopped.", retryable: false } : null,
    },
  } as unknown as Item;
}

/** A desktop occurrence nobody picked up, as Den records it. */
function missedRun(id: string, finishedAt: number) {
  return { id, status: "skipped", finishedAt, code: "runner_unavailable", message: "Missed — no desktop was connected.", attemptCount: 0, startedAt: null };
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
  expect(first.notices).toEqual([{ runId: "run_new", automationId: "aut_Daily summary", name: "Daily summary", title: "Daily summary needs a connection", body: reconnect }]);
  expect(first.watermark).toBe(300);
  // The next poll returns the same list: nothing new to say.
  expect(automationFailureNotices(items, first.watermark).notices).toEqual([]);
});

test("other failures say the Automation failed; cancelled, skipped and interrupted runs stay quiet", () => {
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

test("a missed run is announced once, with whether runs ahead still need a desktop", () => {
  const items = [
    item("Daily summary", missedRun("run_missed", 520)),
    item("One-off export", missedRun("run_once", 510), { state: "inactive", nextDueAt: null }),
    // A Cloud Automation run once on a desktop: its schedule is already in the cloud.
    item("Cloud digest", missedRun("run_borrowed", 505), { executionTarget: "cloud" }),
  ];
  const first = automationFailureNotices(items, 500);
  expect(first.notices).toEqual([
    { runId: "run_borrowed", automationId: "aut_Cloud digest", name: "Cloud digest", title: "Cloud digest didn't run", body: "Missed — no desktop was connected.", missed: { desktopRunsAhead: false } },
    { runId: "run_once", automationId: "aut_One-off export", name: "One-off export", title: "One-off export didn't run", body: "Missed — no desktop was connected.", missed: { desktopRunsAhead: false } },
    { runId: "run_missed", automationId: "aut_Daily summary", name: "Daily summary", title: "Daily summary didn't run", body: "Missed — no desktop was connected.", missed: { desktopRunsAhead: true } },
  ]);
  expect(automationFailureNotices(items, first.watermark).notices).toEqual([]);
});

test("a missed run of an Automation that cannot be run now stays quiet", () => {
  const { notices } = automationFailureNotices([
    item("Archived", missedRun("run_archived", 610), { state: "archived" }),
    item("Needs a model", missedRun("run_blocked", 620), { state: "needs_attention" }),
  ], 600);
  expect(notices).toEqual([]);
});

test("a desktop offers to run it now, a browser offers one run in the cloud", () => {
  expect(missedRunOffer({ desktopRunsAhead: true, onDesktop: true, cloudAvailable: true })).toEqual({ run: "desktop", moveToCloud: true });
  expect(missedRunOffer({ desktopRunsAhead: true, onDesktop: false, cloudAvailable: true })).toEqual({ run: "cloud", moveToCloud: true });
  // Without the cloud there is nowhere to move it, and a browser cannot run it at all.
  expect(missedRunOffer({ desktopRunsAhead: true, onDesktop: true, cloudAvailable: false })).toEqual({ run: "desktop", moveToCloud: false });
  expect(missedRunOffer({ desktopRunsAhead: true, onDesktop: false, cloudAvailable: false })).toEqual({ run: null, moveToCloud: false });
  // With no desktop runs ahead there is nothing to move.
  expect(missedRunOffer({ desktopRunsAhead: false, onDesktop: true, cloudAvailable: true })).toEqual({ run: "desktop", moveToCloud: false });
});

test("the message says why it did not run, then what the buttons offer", () => {
  const reason = "Missed — no desktop was connected.";
  expect(missedRunBody(reason, { run: "desktop", moveToCloud: true }))
    .toBe(`${reason} Run it now, or move it to the cloud so it runs even when your desktop is offline.`);
  expect(missedRunBody(reason, { run: "cloud", moveToCloud: false })).toBe(`${reason} Run it in the cloud now to catch up.`);
  expect(missedRunBody(reason, { run: null, moveToCloud: false })).toContain("Keep OpenWork open");
});
