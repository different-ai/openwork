import type { UIMessage } from "ai";

export type SessionNotice = {
  id: string;
  source: "subagent" | "shell";
  subjectId: string;
  outcome: "completed" | "error" | "cancelled";
  description: string;
  timestamp: number;
};

export type RunActivity = {
  id: string;
  promptIds?: string[];
  noticeIds?: string[];
  initiator?: "prompt" | "notice" | "restored";
  startedAt: number;
  endedAt?: number;
  waiting: { start: number; end?: number }[];
  outcome?: "completed" | "stopped" | "failed";
};

export function runElapsed(run: RunActivity, now: number): number {
  const end = run.endedAt ?? now;
  let cursor = run.startedAt;
  let paused = 0;
  for (const wait of [...run.waiting].sort((left, right) => left.start - right.start)) {
    const start = Math.max(cursor, run.startedAt, wait.start);
    const stop = Math.min(wait.end ?? end, end);
    paused += Math.max(0, stop - start);
    cursor = Math.max(cursor, stop);
  }
  return Math.max(0, end - run.startedAt - paused);
}

/** Optional local timing must never turn corrupt storage into a plausible duration. */
export function readRunActivities(value: unknown): Record<string, RunActivity> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, RunActivity> = {};
  for (const [id, candidate] of Object.entries(value).slice(-200)) {
    if (!candidate || typeof candidate !== "object" || !("id" in candidate) || candidate.id !== id
      || !("startedAt" in candidate) || typeof candidate.startedAt !== "number" || !Number.isFinite(candidate.startedAt)
      || candidate.startedAt <= 0 || !("waiting" in candidate) || !Array.isArray(candidate.waiting)) continue;
    const endedAt = "endedAt" in candidate ? candidate.endedAt : undefined;
    if (endedAt !== undefined && (typeof endedAt !== "number" || !Number.isFinite(endedAt) || endedAt < candidate.startedAt)) continue;
    const waiting: RunActivity["waiting"] = [];
    let valid = candidate.waiting.length <= 1_000;
    for (const interval of candidate.waiting) {
      if (!interval || typeof interval !== "object" || typeof interval.start !== "number" || !Number.isFinite(interval.start)
        || interval.start < candidate.startedAt || interval.end !== undefined && (typeof interval.end !== "number"
          || !Number.isFinite(interval.end) || interval.end < interval.start)) { valid = false; break; }
      waiting.push({ start: interval.start, ...(interval.end === undefined ? {} : { end: interval.end }) });
    }
    if (!valid) continue;
    const outcome = "outcome" in candidate ? candidate.outcome : undefined;
    const initiator = "initiator" in candidate ? candidate.initiator : undefined;
    const promptIds = "promptIds" in candidate && Array.isArray(candidate.promptIds)
      ? candidate.promptIds.filter((value: unknown): value is string => typeof value === "string").slice(-1_000) : undefined;
    const noticeIds = "noticeIds" in candidate && Array.isArray(candidate.noticeIds)
      ? candidate.noticeIds.filter((value: unknown): value is string => typeof value === "string").slice(-1_000) : undefined;
    result[id] = { id, startedAt: candidate.startedAt, waiting,
      ...(promptIds ? { promptIds } : {}),
      ...(noticeIds ? { noticeIds } : {}),
      ...(typeof endedAt === "number" ? { endedAt } : {}),
      ...(outcome === "completed" || outcome === "stopped" || outcome === "failed" ? { outcome } : {}),
      ...(initiator === "prompt" || initiator === "notice" || initiator === "restored" ? { initiator } : {}) };
  }
  return result;
}

export function messageActivity(message: UIMessage): Record<string, unknown> {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object" || !("opencode" in metadata)) return {};
  const value = metadata.opencode;
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** Only native completion notices are visible. Hidden model inputs remain hidden. */
export function sessionNotice(value: unknown, id: string, timestamp: number): SessionNotice | null {
  if (!value || typeof value !== "object") return null;
  const metadata = value as Record<string, unknown>;
  const source = metadata.source;
  const outcome = metadata.state;
  const subjectId = source === "subagent" ? metadata.childID ?? metadata.sessionID : metadata.shellID ?? metadata.jobID;
  if ((source !== "subagent" && source !== "shell") || typeof subjectId !== "string"
    || (outcome !== "completed" && outcome !== "error" && outcome !== "cancelled")) return null;
  return { id, source, subjectId, outcome, timestamp,
    description: typeof metadata.description === "string" ? metadata.description : source === "subagent" ? "Agent" : "Command" };
}

export function reasoningProviderMetadata(part: { id: string; time?: { start: number; end?: number } }) {
  return { opencode: { partId: part.id,
    ...(part.time ? { startedAt: part.time.start, ...(part.time.end === undefined ? {} : { endedAt: part.time.end }) } : {}) } };
}

export function projectedMessageMetadata(info: { time?: { created?: number; completed?: number }; parentID?: unknown; model?: unknown; modelID?: unknown; providerID?: unknown; error?: unknown; replyModel?: unknown }) {
  return { opencode: {
    ...(typeof info.time?.created === "number" ? { created: info.time.created } : {}),
    ...(typeof info.time?.completed === "number" ? { completed: info.time.completed } : {}),
    ...(typeof info.parentID === "string" ? { parentID: info.parentID } : {}),
    ...(info.model ? { model: info.model } : typeof info.modelID === "string" ? { model: { modelID: info.modelID, providerID: info.providerID } } : {}),
    ...(info.replyModel ? { replyModel: info.replyModel } : {}),
    ...(info.error ? { outcome: typeof info.error === "object" && "name" in info.error && info.error.name === "MessageAbortedError" ? "stopped" : "failed" } : {}),
  } };
}

export function messageNotice(message: UIMessage): SessionNotice | null {
  for (const part of message.parts) {
    if (part.type !== "text") continue;
    const value = part.providerMetadata?.opencode?.notice;
    if (value && typeof value === "object" && "id" in value && typeof value.id === "string"
      && "source" in value && (value.source === "subagent" || value.source === "shell")
      && "subjectId" in value && typeof value.subjectId === "string"
      && "outcome" in value && (value.outcome === "completed" || value.outcome === "error" || value.outcome === "cancelled")
      && "timestamp" in value && typeof value.timestamp === "number" && Number.isFinite(value.timestamp)
      && "description" in value && typeof value.description === "string") return value as SessionNotice;
  }
  return null;
}
