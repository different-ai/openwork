/**
 * One quiet line about what a coworker holds — "2 assignments · 1 Worker · 3
 * documents" — shared by the composer's summary line and the count rows at the
 * top of the Activity panel, so both say the same numbers. Pure and
 * unit-tested; the views only render what this returns.
 */
import type { LocalResponsibility, LocalResponsibilityRun } from "./bridge.ts";
import { documentsChangedSince, type CoworkerDocumentSummary } from "./documents.ts";
import type { ThreadListItem } from "./threads.ts";
import { isLiveWorker, type WorkerSummary } from "./workers.ts";

export type SummaryKind = "assignments" | "workers" | "documents";

/** The composer's line, left to right. */
export const SUMMARY_ORDER: readonly SummaryKind[] = ["assignments", "workers", "documents"];

/** The Activity panel's rows, top to bottom — the order the strip used to show them. */
export const ACTIVITY_ROW_ORDER: readonly SummaryKind[] = ["documents", "workers", "assignments"];

export const SUMMARY_TITLES: Record<SummaryKind, string> = {
  assignments: "Assignments",
  workers: "Workers",
  documents: "Documents",
};

export type SummaryPart = {
  kind: SummaryKind;
  count: number;
  /** "2 assignments", "1 Worker", "3 documents". */
  label: string;
  /** One quiet clause for the Activity row — "1 once · 1 on a schedule", "1 running", "2 new since you last looked"; empty when there is nothing to add. */
  note: string;
  /** Documents the coworker changed since the person last looked at them. */
  changed: number;
};

export type CoworkerSummaryLine = {
  /** Only the kinds with something to count, in `SUMMARY_ORDER`. */
  parts: SummaryPart[];
  /** The parts joined with " · ", or `NOTHING_IN_PROGRESS`. */
  text: string;
  /** Every kind, counted, in `ACTIVITY_ROW_ORDER`, for the panel's rows. */
  rows: SummaryPart[];
};

export const NOTHING_IN_PROGRESS = "Nothing in progress";

export type CoworkerSummaryInput = {
  /** The one-off assignment threads, as the conversation column lists them. */
  assignments: ReadonlyArray<Pick<ThreadListItem, "id" | "status">>;
  /** Scheduled assignments on this Mac; their runs are threads too and are never counted twice. */
  scheduled: ReadonlyArray<Pick<LocalResponsibility, "id"> & { runs: ReadonlyArray<Pick<LocalResponsibilityRun, "threadId">> }>;
  workers: ReadonlyArray<Pick<WorkerSummary, "status" | "waitingFor">>;
  documents: ReadonlyArray<Pick<CoworkerDocumentSummary, "status" | "updatedAt" | "updatedBy">>;
  /** When the person last opened the Documents view; 0 when never. */
  documentsSeenAt: number;
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One-off assignments without the threads that scheduled runs produced. */
export function onceOnlyAssignments<T extends Pick<ThreadListItem, "id">>(
  assignments: ReadonlyArray<T>,
  scheduled: ReadonlyArray<{ runs: ReadonlyArray<Pick<LocalResponsibilityRun, "threadId">> }>,
): T[] {
  const runThreads = new Set(scheduled.flatMap((item) => item.runs.map((run) => run.threadId).filter(Boolean)));
  return assignments.filter((item) => !runThreads.has(item.id));
}

function assignmentsPart(input: CoworkerSummaryInput): SummaryPart {
  const once = onceOnlyAssignments(input.assignments, input.scheduled);
  const onSchedule = input.scheduled.length;
  const count = once.length + onSchedule;
  const working = once.filter((item) => item.status === "busy" || item.status === "retry").length;
  const notes: string[] = [];
  if (once.length > 0 && onSchedule > 0) notes.push(`${once.length} once · ${onSchedule} on a schedule`);
  else if (onSchedule > 0) notes.push("On a schedule");
  if (working > 0) notes.push(`${working} in progress`);
  return { kind: "assignments", count, label: plural(count, "assignment", "assignments"), note: notes.join(" · "), changed: 0 };
}

function workersPart(input: CoworkerSummaryInput): SummaryPart {
  const live = input.workers.filter(isLiveWorker);
  const running = live.filter((worker) => worker.status === "running" || worker.status === "starting" || (worker.status === "waiting" && worker.waitingFor === "turn")).length;
  const deciding = live.filter((worker) => worker.status === "waiting" && worker.waitingFor === "decision").length;
  const notes: string[] = [];
  if (running > 0) notes.push(`${running} running`);
  if (deciding > 0) notes.push(`${deciding} waiting for a decision`);
  if (live.length > 0 && notes.length === 0) notes.push(plural(live.length, "paused", "paused"));
  return { kind: "workers", count: live.length, label: plural(live.length, "Worker", "Workers"), note: notes.join(" · "), changed: 0 };
}

function documentsPart(input: CoworkerSummaryInput): SummaryPart {
  const active = input.documents.filter((document) => document.status === "active").length;
  const changed = documentsChangedSince(input.documents, input.documentsSeenAt);
  return {
    kind: "documents",
    count: active,
    label: plural(active, "document", "documents"),
    note: changed > 0 ? `${changed} new since you last looked` : "",
    changed,
  };
}

/** The line and the rows, from the same counts. Zero counts leave the line and stay in the rows. */
export function describeCoworkerSummary(input: CoworkerSummaryInput): CoworkerSummaryLine {
  const byKind: Record<SummaryKind, SummaryPart> = {
    assignments: assignmentsPart(input),
    workers: workersPart(input),
    documents: documentsPart(input),
  };
  const parts = SUMMARY_ORDER.map((kind) => byKind[kind]).filter((part) => part.count > 0);
  return {
    parts,
    text: parts.length > 0 ? parts.map((part) => part.label).join(" · ") : NOTHING_IN_PROGRESS,
    rows: ACTIVITY_ROW_ORDER.map((kind) => byKind[kind]),
  };
}

/** A row's title: the count when there is one ("3 documents"), the plain name when there is none. */
export function summaryRowTitle(part: Pick<SummaryPart, "kind" | "count" | "label">): string {
  return part.count > 0 ? part.label : SUMMARY_TITLES[part.kind];
}

/**
 * Whether the composer shows the line at all: a coworker that has never held
 * anything and never worked gets no "Nothing in progress" under its first
 * message.
 */
export function showSummaryLine(summary: Pick<CoworkerSummaryLine, "parts">, hasWorked: boolean): boolean {
  return summary.parts.length > 0 || hasWorked;
}

/**
 * Several coworkers' lines as one, for a group chat's composer: the counts add
 * up, the notes are dropped (they belong to one coworker's Activity), and the
 * text reads the same way.
 */
export function combineSummaryLines(lines: ReadonlyArray<CoworkerSummaryLine>): CoworkerSummaryLine {
  const totals: Record<SummaryKind, { count: number; changed: number }> = {
    assignments: { count: 0, changed: 0 },
    workers: { count: 0, changed: 0 },
    documents: { count: 0, changed: 0 },
  };
  for (const line of lines) {
    for (const row of line.rows) {
      totals[row.kind].count += row.count;
      totals[row.kind].changed += row.changed;
    }
  }
  const part = (kind: SummaryKind): SummaryPart => {
    const total = totals[kind];
    const label = kind === "assignments"
      ? plural(total.count, "assignment", "assignments")
      : kind === "workers"
        ? plural(total.count, "Worker", "Workers")
        : plural(total.count, "document", "documents");
    return { kind, count: total.count, label, note: "", changed: total.changed };
  };
  const parts = SUMMARY_ORDER.map(part).filter((candidate) => candidate.count > 0);
  return {
    parts,
    text: parts.length > 0 ? parts.map((candidate) => candidate.label).join(" · ") : NOTHING_IN_PROGRESS,
    rows: ACTIVITY_ROW_ORDER.map(part),
  };
}
