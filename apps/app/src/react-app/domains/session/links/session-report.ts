import { SESSION_REPORT_SOURCE } from "@openwork/types/session-link";

import { buildSessionTree } from "../sidebar/session-tree";
import { isActiveWorkSessionStatus, isNeedsAttentionSessionStatus, type SessionListItem } from "../sidebar/utils";

export type SessionRunOutcome = "succeeded" | "failed" | "interrupted";
export type SessionReportState = "completed" | "error" | "cancelled";

export const SESSION_REPORT_MAX_CHARS = 4_000;
export const SESSION_REPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const SESSION_REPORT_WAKES_PER_HOUR = 12;
const HOUR_MS = 60 * 60 * 1000;

const STATE_BY_OUTCOME: Record<SessionRunOutcome, SessionReportState> = {
  succeeded: "completed",
  failed: "error",
  interrupted: "cancelled",
};

export function sessionReportState(outcome: SessionRunOutcome): SessionReportState {
  return STATE_BY_OUTCOME[outcome];
}

export function sessionReportId(childSessionId: string, idleAt: number): string {
  return `msg_${childSessionId.replace(/^ses_/, "")}_report_${idleAt}`;
}

const attribute = (value: string) => value.replace(/["<>]/g, " ").replace(/\s+/g, " ").trim();

function reportBody(state: SessionReportState, reply: string): string {
  if (state === "error") return "The session's last run failed.";
  if (state === "cancelled") return "The session was stopped before it finished.";
  const text = reply.trim().replace(/<\/session/gi, "</ session");
  if (!text) return "The session finished without a text reply.";
  if (text.length <= SESSION_REPORT_MAX_CHARS) return text;
  return `${text.slice(0, SESSION_REPORT_MAX_CHARS)}…[+${text.length - SESSION_REPORT_MAX_CHARS} chars; read the rest with session.read]`;
}

export function sessionReportNote(input: { sessionId: string; title: string; state: SessionReportState; reply: string }) {
  const title = attribute(input.title);
  return {
    text: `<session sessionID="${attribute(input.sessionId)}" state="${input.state}" title="${title}">\n${reportBody(input.state, input.reply)}\n</session>`,
    description: title,
    metadata: { source: SESSION_REPORT_SOURCE, childID: input.sessionId, state: input.state },
  };
}

export type SessionReportCandidate = {
  childId: string;
  parentId: string;
  title: string;
  key: string;
};

const isRunning = (status: string | undefined) => isActiveWorkSessionStatus(status) || isNeedsAttentionSessionStatus(status);

export function sessionReportCandidates(input: {
  sessions: readonly SessionListItem[];
  statuses: Readonly<Record<string, string>> | undefined;
  now: number;
}): { settled: SessionReportCandidate[]; running: Array<{ childId: string; parentId: string }> } {
  const tree = buildSessionTree(input.sessions);
  const settled: SessionReportCandidate[] = [];
  const running: Array<{ childId: string; parentId: string }> = [];
  for (const session of input.sessions) {
    const parent = tree.parentOf(session.id);
    if (parent?.kind !== "sub") continue;
    const status = input.statuses?.[session.id];
    if (isRunning(status)) {
      running.push({ childId: session.id, parentId: parent.sessionId });
      continue;
    }
    const updated = session.time?.updated ?? session.time?.created ?? 0;
    if (input.now - updated > SESSION_REPORT_MAX_AGE_MS) continue;
    settled.push({ childId: session.id, parentId: parent.sessionId, title: session.title, key: `${session.id}:${status ?? ""}:${updated}` });
  }
  return { settled, running };
}

export function reportWakesParent(input: {
  sawRunning: boolean;
  sentBy: string | null;
  parentId: string;
  siblingsRunning: boolean;
  recentWakes: readonly number[];
  now: number;
}): boolean {
  if (!input.sawRunning || input.sentBy !== input.parentId || input.siblingsRunning) return false;
  return input.recentWakes.filter((at) => input.now - at < HOUR_MS).length < SESSION_REPORT_WAKES_PER_HOUR;
}

export type SessionReportClient = {
  runEnd: (sessionId: string) => Promise<{ idleAt: number; outcome: SessionRunOutcome } | null>;
  lastTurn: (sessionId: string) => Promise<{ reply: string; sentBy: string | null }>;
  addNote: (note: { sessionID: string; id: string; text: string; description: string; metadata: Record<string, string>; resume: boolean }) => Promise<boolean>;
};

export async function deliverSessionReport(client: SessionReportClient, input: {
  candidate: SessionReportCandidate;
  handledIdleAt: number | undefined;
  wakes: (turn: { sentBy: string | null }) => boolean;
}): Promise<{ idleAt: number; added: boolean; woke: boolean } | null> {
  const end = await client.runEnd(input.candidate.childId);
  if (!end) return null;
  if (end.idleAt === input.handledIdleAt) return { idleAt: end.idleAt, added: false, woke: false };
  const turn = await client.lastTurn(input.candidate.childId);
  const state = sessionReportState(end.outcome);
  const resume = input.wakes({ sentBy: turn.sentBy });
  const added = await client.addNote({
    sessionID: input.candidate.parentId,
    id: sessionReportId(input.candidate.childId, end.idleAt),
    ...sessionReportNote({ sessionId: input.candidate.childId, title: input.candidate.title, state, reply: turn.reply }),
    resume,
  });
  return { idleAt: end.idleAt, added, woke: added && resume };
}
