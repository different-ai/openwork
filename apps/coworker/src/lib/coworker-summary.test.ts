import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTIVITY_ROW_ORDER,
  NOTHING_IN_PROGRESS,
  SUMMARY_ORDER,
  combineSummaryLines,
  describeCoworkerSummary,
  onceOnlyAssignments,
  showSummaryLine,
  summaryRowTitle,
  type CoworkerSummaryInput,
} from "./coworker-summary.ts";

const now = Date.UTC(2026, 8, 3, 12, 0, 0);
const run = (threadId: string) => ({ threadId });
const worker = (status: "starting" | "running" | "waiting" | "paused" | "finished" | "cancelled" | "failed", waitingFor: "" | "turn" | "decision" = "") => ({ status, waitingFor });
const document = (status: "active" | "aside" | "archived", updatedAt: number, updatedBy: "coworker" | "person" = "coworker") => ({ status, updatedAt, updatedBy });

const empty: CoworkerSummaryInput = { assignments: [], scheduled: [], workers: [], documents: [], documentsSeenAt: 0 };

test("nothing held reads as Nothing in progress, with every row still present at zero", () => {
  const summary = describeCoworkerSummary(empty);
  assert.deepEqual(summary.parts, []);
  assert.equal(summary.text, NOTHING_IN_PROGRESS);
  assert.deepEqual(summary.rows.map((row) => [row.kind, row.count, summaryRowTitle(row)]), [
    ["documents", 0, "Documents"],
    ["workers", 0, "Workers"],
    ["assignments", 0, "Assignments"],
  ]);
  assert.deepEqual(ACTIVITY_ROW_ORDER, ["documents", "workers", "assignments"]);
  assert.deepEqual(SUMMARY_ORDER, ["assignments", "workers", "documents"]);
});

test("the line counts assignments, live Workers, and documents in play, singular and plural, zeros left out", () => {
  const summary = describeCoworkerSummary({
    assignments: [{ id: "a1", status: "idle" }, { id: "a2", status: "busy" }],
    scheduled: [],
    workers: [worker("running")],
    documents: [document("active", now), document("active", now), document("active", now), document("aside", now), document("archived", now)],
    documentsSeenAt: now + 1,
  });
  assert.equal(summary.text, "2 assignments · 1 Worker · 3 documents");
  assert.deepEqual(summary.parts.map((part) => [part.kind, part.count]), [["assignments", 2], ["workers", 1], ["documents", 3]]);
  const one = describeCoworkerSummary({ ...empty, assignments: [{ id: "a1", status: "idle" }] });
  assert.equal(one.text, "1 assignment");
  const workersOnly = describeCoworkerSummary({ ...empty, workers: [worker("running"), worker("paused")] });
  assert.equal(workersOnly.text, "2 Workers");
  const documentsOnly = describeCoworkerSummary({ ...empty, documents: [document("active", now)] });
  assert.equal(documentsOnly.text, "1 document");
});

test("scheduled assignments count once: as themselves, never again as the threads their runs made", () => {
  const scheduled = [{ id: "r1", runs: [run("ses_run1"), run("ses_run2")] }, { id: "r2", runs: [] }];
  const assignments = [{ id: "ses_run1", status: "idle" as const }, { id: "ses_run2", status: "idle" as const }, { id: "a1", status: "idle" as const }];
  assert.deepEqual(onceOnlyAssignments(assignments, scheduled).map((item) => item.id), ["a1"]);
  const summary = describeCoworkerSummary({ ...empty, assignments, scheduled });
  assert.equal(summary.text, "3 assignments");
  const row = summary.rows.find((candidate) => candidate.kind === "assignments");
  assert.equal(row?.note, "1 once · 2 on a schedule");
  const onlyScheduled = describeCoworkerSummary({ ...empty, scheduled: [{ id: "r1", runs: [] }] });
  assert.equal(onlyScheduled.rows.find((candidate) => candidate.kind === "assignments")?.note, "On a schedule");
  const working = describeCoworkerSummary({ ...empty, assignments: [{ id: "a1", status: "busy" }, { id: "a2", status: "retry" }, { id: "a3", status: "idle" }] });
  assert.equal(working.rows.find((candidate) => candidate.kind === "assignments")?.note, "2 in progress");
});

test("only live Workers count, and the row says what they are up to", () => {
  const summary = describeCoworkerSummary({
    ...empty,
    workers: [worker("running"), worker("waiting", "turn"), worker("waiting", "decision"), worker("finished"), worker("cancelled"), worker("failed")],
  });
  assert.equal(summary.text, "3 Workers");
  assert.equal(summary.rows.find((row) => row.kind === "workers")?.note, "2 running · 1 waiting for a decision");
  const paused = describeCoworkerSummary({ ...empty, workers: [worker("paused")] });
  assert.equal(paused.rows.find((row) => row.kind === "workers")?.note, "1 paused");
  assert.equal(describeCoworkerSummary({ ...empty, workers: [worker("finished")] }).text, NOTHING_IN_PROGRESS);
});

test("documents in play are the active ones; the coworker's changes since the person looked are marked", () => {
  const seen = now - 60_000;
  const summary = describeCoworkerSummary({
    ...empty,
    documents: [document("active", now), document("active", seen - 1), document("aside", now), document("active", now, "person")],
    documentsSeenAt: seen,
  });
  const row = summary.rows.find((candidate) => candidate.kind === "documents");
  assert.equal(summary.text, "3 documents");
  // The put-aside one the coworker just changed counts as new too; the person's own edit does not.
  assert.deepEqual([row?.changed, row?.note], [2, "2 new since you last looked"]);
  const quiet = describeCoworkerSummary({ ...empty, documents: [document("active", seen - 1)], documentsSeenAt: seen });
  assert.deepEqual([quiet.rows.find((candidate) => candidate.kind === "documents")?.changed, quiet.rows.find((candidate) => candidate.kind === "documents")?.note], [0, ""]);
});

test("the composer hides the empty line until the coworker has ever worked", () => {
  assert.equal(showSummaryLine({ parts: [] }, false), false);
  assert.equal(showSummaryLine({ parts: [] }, true), true);
  assert.equal(showSummaryLine(describeCoworkerSummary({ ...empty, documents: [document("active", now)] }), false), true);
});

test("a group's line adds its members' counts and keeps the same words", () => {
  const editor = describeCoworkerSummary({ ...empty, assignments: [{ id: "a1", status: "idle" }], documents: [document("active", now)], documentsSeenAt: 0 });
  const scout = describeCoworkerSummary({ ...empty, assignments: [{ id: "b1", status: "busy" }, { id: "b2", status: "idle" }], workers: [worker("running")] });
  const combined = combineSummaryLines([editor, scout]);
  assert.equal(combined.text, "3 assignments · 1 Worker · 1 document");
  assert.equal(combined.rows.find((row) => row.kind === "documents")?.changed, 1);
  assert.deepEqual(combined.parts.map((part) => part.note), ["", "", ""]);
  assert.equal(combineSummaryLines([]).text, NOTHING_IN_PROGRESS);
  assert.equal(combineSummaryLines([describeCoworkerSummary(empty)]).parts.length, 0);
});
