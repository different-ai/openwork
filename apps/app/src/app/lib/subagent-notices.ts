/**
 * Sub-agents the agent starts in the background (OpenCode v2 only). When one
 * ends, the engine tells the parent conversation through a synthetic message
 * whose metadata has `source: "subagent"`, the sub-agent's session as
 * `childID`, and `state` (`completed`, `error` or `cancelled`). Its text is
 * `<subagent …>output</subagent>` for the model; the chat shows one sentence
 * that opens the sub-agent's chat.
 *
 * Pure readers, shared by the engine adapter, the sync layer and the chat.
 */

import { SESSION_REPORT_SOURCE } from "@openwork/types/session-link";

export type SubagentOutcome = "finished" | "failed" | "stopped";

/** What the chat shows when a background sub-agent ends. */
export type SubagentNotice = {
  childSessionId: string;
  description: string;
  outcome: SubagentOutcome;
  /**
   * The note is about a session the agent started with session.create, which
   * the app reports in the engine's own shape (`source: "openwork-session"`).
   */
  linkedSession?: true;
};

/** The text part metadata key that marks a sub-agent notice row in the transcript. */
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

/** Read the engine's completion message (or inbox payload) for a background sub-agent. */
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

/** A notice carried on a transcript part (engine part metadata or UI provider metadata). */
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
