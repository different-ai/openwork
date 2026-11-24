import { SESSION_REPORT_SOURCE } from "@openwork/types/session-link";

export type SubagentOutcome = "finished" | "failed" | "stopped";

export type SubagentNotice = {
  childSessionId: string;
  description: string;
  outcome: SubagentOutcome;
  linkedSession?: true;
};

export const SUBAGENT_NOTICE_KEY = "openworkSubagentNotice";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

const ENGINE_OUTCOMES: Record<string, SubagentOutcome> = { completed: "finished", error: "failed", cancelled: "stopped" };

export function readSubagentCompletion(payload: unknown): SubagentNotice | null {
  if (!isRecord(payload)) return null;
  const metadata = isRecord(payload.metadata) ? payload.metadata : null;
  const source = metadata ? readString(metadata, "source") : undefined;
  if (!metadata || (source !== "subagent" && source !== SESSION_REPORT_SOURCE)) return null;
  const childSessionId = readString(metadata, "childID")?.trim();
  const state = readString(metadata, "state");
  const outcome = state ? ENGINE_OUTCOMES[state] : undefined;
  if (!childSessionId || !outcome) return null;
  return {
    childSessionId, description: readString(payload, "description")?.trim() ?? "", outcome,
    ...(source === SESSION_REPORT_SOURCE ? { linkedSession: true } : {}),
  };
}

export function readSubagentNotice(value: unknown): SubagentNotice | null {
  if (!isRecord(value)) return null;
  const childSessionId = readString(value, "childSessionId");
  const description = readString(value, "description");
  const outcome = readString(value, "outcome");
  if (!childSessionId || description === undefined) return null;
  if (outcome !== "finished" && outcome !== "failed" && outcome !== "stopped") return null;
  return { childSessionId, description, outcome, ...(value.linkedSession === true ? { linkedSession: true } : {}) };
}

export function subagentNoticeLabel(notice: Pick<SubagentNotice, "outcome" | "linkedSession">): string {
  const who = notice.linkedSession ? "Session" : "Sub-agent";
  if (notice.outcome === "failed") return `${who} failed`;
  if (notice.outcome === "stopped") return `${who} stopped`;
  return `${who} finished`;
}
