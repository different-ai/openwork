import type {
  RemoteSessionAccessMode,
  RemoteSessionAnswerInput,
  RemoteSessionPending,
  RemoteSessionPendingSummary,
  RemoteSessionReadResult,
  RemoteSessionTranscriptMessage,
} from "@openwork/types/automations";
import type { MemberSession, MemberSessionComputer, MemberSessionState } from "@openwork/types/den/remote-sessions";
import type { DenBadgeTone } from "../../../_components/ui/badge";

/*
 * What My Sessions shows and sends, kept apart from React so each rule can be
 * tested on its own. Everything a computer reports (titles, steps, questions,
 * commands, messages) is text from another machine: it is shown as plain text
 * and never turned into links or markup.
 */

export const ACCESS_LABELS: Record<RemoteSessionAccessMode, string> = {
  created: "Only sessions started remotely",
  all: "All sessions",
};

/** Why a computer reaches less than its owner might expect, or where to change it. Null when there is nothing to add. */
export function computerAccessNote(
  computer: Pick<MemberSessionComputer, "supportsAccess" | "access" | "effectiveAccess">,
  ceiling: RemoteSessionAccessMode,
): string | null {
  if (!computer.supportsAccess) return "Update OpenWork on this computer to choose.";
  // A computer reports the access in force, so under a narrow ceiling its owner's own choice is not known here.
  if (ceiling === "created") return "Your organization only allows sessions started remotely.";
  if (computer.effectiveAccess === "created") return "Change this in Settings › Devices on that computer.";
  return null;
}

export const UNTITLED_SESSION = "Untitled session";

export function sessionTitle(title: string | null | undefined): string {
  return title?.trim() || UNTITLED_SESSION;
}

/** The badge for a session's state. `unknown` has none: the computer has not said how the session is doing. */
export const SESSION_STATE_BADGES: Record<Exclude<MemberSessionState, "unknown">, { label: string; tone: DenBadgeTone }> = {
  starting: { label: "Starting", tone: "neutral" },
  running: { label: "Working", tone: "info" },
  waiting: { label: "Needs you", tone: "warning" },
  idle: { label: "Idle", tone: "neutral" },
  error: { label: "Error", tone: "danger" },
};

export function sessionStateBadge(state: MemberSessionState): { label: string; tone: DenBadgeTone } | null {
  return state === "unknown" ? null : SESSION_STATE_BADGES[state];
}

/** A dot's colour: amber for what waits on the member, red for a failure, green for work in progress, neutral otherwise. */
export type SessionDotTone = "success" | "warning" | "danger" | "neutral";

const SESSION_STATE_TONES: Record<Exclude<MemberSessionState, "unknown">, SessionDotTone> = {
  starting: "neutral",
  running: "success",
  waiting: "warning",
  idle: "neutral",
  error: "danger",
};

/** A session's state in a row: a dot and one word. `unknown` has none. */
export function sessionStateDot(state: MemberSessionState): { label: string; tone: SessionDotTone } | null {
  return state === "unknown" ? null : { label: SESSION_STATE_BADGES[state].label, tone: SESSION_STATE_TONES[state] };
}

/** The same state as the line under an open session's title, said to the person reading it. */
export function sessionStateLine(state: MemberSessionState): { label: string; tone: SessionDotTone } | null {
  if (state === "unknown") return null;
  return { label: state === "waiting" ? "Waiting for you" : SESSION_STATE_BADGES[state].label, tone: SESSION_STATE_TONES[state] };
}

/** The one line of state under the page title: "1 needs you, 2 working", or that nothing waits. */
export function sessionsStateLine(sessions: readonly Pick<MemberSession, "state">[]): string {
  if (sessions.length === 0) return "No sessions yet";
  const needs = sessions.filter((session) => session.state === "waiting").length;
  const working = sessions.filter((session) => session.state === "running" || session.state === "starting").length;
  const parts = [
    ...(needs ? [`${needs} ${needs === 1 ? "needs" : "need"} you`] : []),
    ...(working ? [`${working} working`] : []),
  ];
  return parts.length ? parts.join(", ") : "No sessions waiting";
}

function newestFirst(left: MemberSession, right: MemberSession): number {
  return (right.updatedAt ?? -1) - (left.updatedAt ?? -1);
}

/** Sessions waiting on the member come first, then everything else; newest first within each. */
export function groupSessions(sessions: readonly MemberSession[]): { needsYou: MemberSession[]; rest: MemberSession[] } {
  const needsYou = sessions.filter((session) => session.state === "waiting").sort(newestFirst);
  const rest = sessions.filter((session) => session.state !== "waiting").sort(newestFirst);
  return { needsYou, rest };
}

/** One line of what a waiting session waits for. */
export function pendingSummaryLine(pending: RemoteSessionPendingSummary | null): string | null {
  if (!pending) return null;
  const line = pending.kind === "permission" ? pending.title : pending.question;
  return line.trim() || null;
}

/** A session that was started on the computer itself rather than from another device. */
export function startedOnComputer(session: Pick<MemberSession, "origin" | "reach">): boolean {
  return session.origin === "local" || session.reach === "attachable";
}

export function findSessionByCommand(sessions: readonly MemberSession[], commandId: string): MemberSession | null {
  return commandId ? sessions.find((session) => session.commandId === commandId) ?? null : null;
}

// ─── Connect (attach) ────────────────────────────────────────────────────────

export const ATTACH_FAILED_MESSAGE = "Couldn't connect. Try again.";

/**
 * A Connect the member pressed on a session started on its computer.
 * `requesting`: the attach call is out. `queued`: the computer has to pick it
 * up; `since` is when that was learned, so only a newer list decides how it
 * went. `failed`: it did not connect, with the line to show on the row.
 */
export type AttachAttempt =
  | { phase: "requesting" }
  | { phase: "queued"; since: number }
  | { phase: "failed"; message: string };

export type AttachOutcome = { kind: "waiting" } | { kind: "open"; commandId: string } | { kind: "failed"; message: string };

/**
 * How a queued Connect went, judged from a list fetched at `listFetchedAt`.
 * Reachable opens it. Gone, or back to needing a Connect, means the computer
 * refused or never took it. A list older than the attach says nothing yet.
 */
export function attachOutcome(attempt: AttachAttempt, session: MemberSession | null, listFetchedAt: number): AttachOutcome {
  if (attempt.phase === "failed") return { kind: "failed", message: attempt.message };
  if (attempt.phase === "requesting" || listFetchedAt <= attempt.since) return { kind: "waiting" };
  if (!session) return { kind: "failed", message: ATTACH_FAILED_MESSAGE };
  if (session.reach === "reachable" && session.commandId) return { kind: "open", commandId: session.commandId };
  if (session.reach === "attachable") return { kind: "failed", message: ATTACH_FAILED_MESSAGE };
  return { kind: "waiting" };
}

/** The session on its computer, however the list keys it before and after it is connected. */
export function sessionIdentity(session: Pick<MemberSession, "key" | "computerId" | "workspaceId" | "sessionId">): string {
  return session.computerId && session.workspaceId && session.sessionId
    ? [session.computerId, session.workspaceId, session.sessionId].join("\n")
    : session.key;
}

/** Every Connect in flight or failed, by `sessionIdentity`. */
export type AttachAttempts = Readonly<Record<string, AttachAttempt>>;

/** What the page does next: the attempts to keep, and a session to open when one just became reachable. */
export type AttachStep = { attempts: AttachAttempts; open: string | null };

function withAttempt(attempts: AttachAttempts, identity: string, attempt: AttachAttempt | null): AttachAttempts {
  const next: Record<string, AttachAttempt> = { ...attempts };
  if (attempt) next[identity] = attempt;
  else delete next[identity];
  return next;
}

/** Connect was pressed: the attach call is out. */
export function attachRequested(attempts: AttachAttempts, identity: string): AttachAttempts {
  return withAttempt(attempts, identity, { phase: "requesting" });
}

/**
 * Den answered the attach. Already attached: open it now. Queued: wait for a
 * list read after `now` to say how it went.
 */
export function attachAnswered(attempts: AttachAttempts, identity: string, answer: { state: "queued" | "attached"; commandId: string }, now: number): AttachStep {
  if (answer.state === "attached") return { attempts: withAttempt(attempts, identity, null), open: answer.commandId };
  return { attempts: withAttempt(attempts, identity, { phase: "queued", since: now }), open: null };
}

/** Den or the computer refused: the row says why and offers Connect again. */
export function attachRefused(attempts: AttachAttempts, identity: string, message: string | null | undefined): AttachAttempts {
  return withAttempt(attempts, identity, { phase: "failed", message: message?.trim() || ATTACH_FAILED_MESSAGE });
}

export function attachDismissed(attempts: AttachAttempts, identity: string): AttachAttempts {
  return withAttempt(attempts, identity, null);
}

/**
 * Settles every queued Connect against a list read at `listFetchedAt`. One
 * that became reachable is cleared and opened, unless the member is reading
 * another session by now (`reading`): nothing navigates away from that. One
 * that is gone, or needs a Connect again, becomes a failure to show. Returns
 * the same `attempts` when nothing changed.
 */
export function settleAttachAttempts(attempts: AttachAttempts, sessions: readonly MemberSession[], listFetchedAt: number, reading: boolean): AttachStep {
  let next = attempts;
  let open: string | null = null;
  for (const [identity, attempt] of Object.entries(attempts)) {
    if (attempt.phase !== "queued") continue;
    const outcome = attachOutcome(attempt, sessions.find((session) => sessionIdentity(session) === identity) ?? null, listFetchedAt);
    if (outcome.kind === "waiting") continue;
    next = withAttempt(next, identity, outcome.kind === "failed" ? { phase: "failed", message: outcome.message } : null);
    if (outcome.kind === "open" && !reading && open === null) open = outcome.commandId;
  }
  return { attempts: next, open };
}

/** A failed Connect whose session has left the list, so no row can report it. */
export function lostAttachFailure(attempts: AttachAttempts, sessions: readonly MemberSession[]): { identity: string; message: string } | null {
  for (const [identity, attempt] of Object.entries(attempts)) {
    if (attempt.phase === "failed" && !sessions.some((session) => sessionIdentity(session) === identity)) return { identity, message: attempt.message };
  }
  return null;
}

// ─── Answers ─────────────────────────────────────────────────────────────────

export type PermissionPending = Extract<RemoteSessionPending, { kind: "permission" }>;
export type QuestionPending = Extract<RemoteSessionPending, { kind: "question" }>;
export type PendingQuestion = QuestionPending["questions"][number];

/** Allow once or deny. A remote surface never offers "always". */
export function permissionAnswer(requestId: string, decision: "once" | "reject"): RemoteSessionAnswerInput {
  return { kind: "permission", requestId, decision };
}

export function dismissAnswer(requestId: string): RemoteSessionAnswerInput {
  return { kind: "dismiss", requestId };
}

/** What the member has picked or typed for one question so far. */
export type QuestionDraft = { selected: readonly string[]; custom: string };
export const EMPTY_QUESTION_DRAFT: QuestionDraft = { selected: [], custom: "" };

/** Pick or unpick an option: a single-choice question keeps one, and a pick replaces the typed answer. */
export function toggleQuestionOption(question: Pick<PendingQuestion, "multiple">, draft: QuestionDraft, label: string): QuestionDraft {
  if (!question.multiple) return { selected: [label], custom: "" };
  return draft.selected.includes(label)
    ? { ...draft, selected: draft.selected.filter((entry) => entry !== label) }
    : { ...draft, selected: [...draft.selected, label] };
}

/** Type an answer of one's own: on a single-choice question it stands in for the options. */
export function setQuestionCustom(question: Pick<PendingQuestion, "multiple">, draft: QuestionDraft, custom: string): QuestionDraft {
  return question.multiple || !custom.trim() ? { ...draft, custom } : { selected: [], custom };
}

/** The answer one question would send, or null while it has none. Only labels the question offers count. */
export function questionAnswer(question: PendingQuestion, draft: QuestionDraft | undefined): string[] | null {
  const current = draft ?? EMPTY_QUESTION_DRAFT;
  const offered = question.options.map((option) => option.label);
  const picked = offered.filter((label) => current.selected.includes(label));
  const typed = question.custom ? current.custom.trim() : "";
  const answer = question.multiple ? [...picked, ...(typed ? [typed] : [])] : typed ? [typed] : picked.slice(0, 1);
  return answer.length > 0 ? answer : null;
}

/** One answer per question, in order; null until every question has one. */
export function questionAnswers(questions: readonly PendingQuestion[], drafts: readonly (QuestionDraft | undefined)[]): string[][] | null {
  const answers: string[][] = [];
  for (const [index, question] of questions.entries()) {
    const answer = questionAnswer(question, drafts[index]);
    if (!answer) return null;
    answers.push(answer);
  }
  return answers.length > 0 ? answers : null;
}

export function questionsAnswer(requestId: string, answers: string[][]): RemoteSessionAnswerInput {
  return { kind: "question", requestId, answers };
}

/** Every open question and permission of a read; older computers report only the first as `pending`. */
export function pendingItemsOf(read: Pick<RemoteSessionReadResult, "pending" | "pendingItems">): RemoteSessionPending[] {
  if (read.pendingItems) return read.pendingItems;
  return read.pending ? [read.pending] : [];
}

// ─── Conversation ────────────────────────────────────────────────────────────

/** One thing to show for a message, in order: words, or a tool step as one line. */
export type TranscriptStep =
  | { kind: "text"; key: string; text: string }
  | { kind: "tool"; key: string; name: string; status: string | null };

/**
 * A message as steps. Reasoning is left out. Older computers send the words
 * and the tool calls apart; there the work reads before the answer.
 */
export function transcriptSteps(message: RemoteSessionTranscriptMessage): TranscriptStep[] {
  if (message.parts) {
    return message.parts.flatMap((part, index): TranscriptStep[] => {
      if (part.type === "text") return part.text.trim() ? [{ kind: "text", key: `text:${index}`, text: part.text }] : [];
      if (part.type === "tool") return [{ kind: "tool", key: `tool:${part.id || index}`, name: part.title?.trim() || part.name || "Tool", status: part.status }];
      return [];
    });
  }
  return [
    ...message.toolCalls.map((call, index): TranscriptStep => ({ kind: "tool", key: `tool:${call.id || index}`, name: call.name || "Tool", status: call.status })),
    ...(message.text.trim() ? [{ kind: "text" as const, key: "text", text: message.text }] : []),
  ];
}

const TOOL_STATUS_LABELS: Record<string, string> = {
  pending: "Waiting",
  running: "Running",
  completed: "Done",
  error: "Failed",
};

/** "Done", "Running", "Failed"; an unfamiliar status is shown as the computer sent it. */
export function toolStatusLabel(status: string | null): string | null {
  if (!status) return null;
  return TOOL_STATUS_LABELS[status] ?? status;
}

/** A session as the panel holds it: the newest read plus every message loaded so far, oldest first. */
export type SessionView = {
  read: RemoteSessionReadResult;
  messages: RemoteSessionTranscriptMessage[];
  /** Pass to read the page before the oldest message shown; null when there is none. */
  earlierCursor: string | null;
};

/**
 * Folds a fresh read of the newest page into what is already shown. Messages
 * it shares are updated in place and newer ones are added, so earlier pages
 * the member loaded stay. With nothing in common the page replaces the lot.
 */
export function mergeLatestPage(current: SessionView | undefined, read: RemoteSessionReadResult): SessionView {
  const known = new Set(current?.messages.map((message) => message.id));
  if (!current || !read.messages.some((message) => known.has(message.id))) {
    return { read, messages: read.messages, earlierCursor: read.nextCursor };
  }
  const fresh = new Map(read.messages.map((message) => [message.id, message]));
  return {
    read,
    messages: [
      ...current.messages.map((message) => fresh.get(message.id) ?? message),
      ...read.messages.filter((message) => !known.has(message.id)),
    ],
    earlierCursor: current.earlierCursor,
  };
}

/** Puts an earlier page in front of what is shown. */
export function mergeEarlierPage(current: SessionView, read: RemoteSessionReadResult): SessionView {
  const known = new Set(current.messages.map((message) => message.id));
  return {
    read: current.read,
    messages: [...read.messages.filter((message) => !known.has(message.id)), ...current.messages],
    earlierCursor: read.nextCursor,
  };
}

/**
 * Shows a follow-up the computer accepted, under the id it gave it, until the
 * next read brings the message itself: the member's words stay on screen.
 */
export function appendSentMessage(current: SessionView, sent: { id: string; text: string; createdAt: number }): SessionView {
  if (current.messages.some((message) => message.id === sent.id)) return current;
  return {
    ...current,
    messages: [...current.messages, { id: sent.id, role: "user", createdAt: sent.createdAt, text: sent.text, truncated: false, toolCalls: [], error: null }],
  };
}
