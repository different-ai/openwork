/**
 * Commands the agent leaves running with the shell tool's `background: true`
 * (OpenCode v2 only). The engine reports each command's life on its event
 * stream (`shell.created` / `shell.exited` / `shell.deleted`), answers a
 * background tool call at once with `{ status: "running", shellID }`, and
 * tells the conversation when the command ends through a synthetic inbox item
 * whose metadata has `source: "shell"`.
 *
 * This module holds the pure readers for those shapes, so the engine
 * adapter, the sync layer and the chat agree on one meaning without
 * importing each other.
 */

/** Translated event types shared by the engine adapter and session sync. */
export const SHELL_CREATED_EVENT = "shell.created";
export const SHELL_EXITED_EVENT = "shell.exited";
export const SHELL_DELETED_EVENT = "shell.deleted";
export const BACKGROUND_SHELL_STARTED_EVENT = "shell.background.started";
export const BACKGROUND_SHELL_FINISHED_EVENT = "shell.background.finished";

/** One command the engine reports, from `Shell.Info`. */
export type EngineShell = {
  id: string;
  status: "running" | "exited" | "timeout" | "killed";
  command: string;
  /** The conversation that started it; absent for commands started outside a conversation. */
  sessionID: string | null;
  startedAt: number;
  exit: number | null;
};

export type BackgroundShellOutcome = "finished" | "failed" | "timed-out" | "stopped";

/** What the chat shows when a background command ends. */
export type BackgroundShellNotice = {
  shellId: string;
  command: string;
  outcome: BackgroundShellOutcome;
  exit: number | null;
};

/** The text part metadata key that marks a notice row in the transcript. */
export const BACKGROUND_SHELL_NOTICE_KEY = "openworkBackgroundShell";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

const SHELL_STATUSES = ["running", "exited", "timeout", "killed"] as const;

function shellStatus(value: string | undefined): EngineShell["status"] | null {
  return SHELL_STATUSES.find((status) => status === value) ?? null;
}

/** Read one engine `Shell.Info`; anything without an id, status and command is not a shell. */
export function readEngineShell(value: unknown): EngineShell | null {
  if (!isRecord(value)) return null;
  const id = readString(value, "id");
  const status = shellStatus(readString(value, "status"));
  const command = readString(value, "command");
  if (!id?.startsWith("sh_") || !status || command === undefined) return null;
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const sessionID = readString(metadata, "sessionID") ?? readString(metadata, "sessionId") ?? null;
  const time = isRecord(value.time) ? value.time : {};
  return {
    id,
    status,
    command,
    sessionID: sessionID?.startsWith("ses") ? sessionID : null,
    startedAt: readNumber(time, "started") ?? 0,
    exit: readNumber(value, "exit") ?? null,
  };
}

/**
 * The shell id a tool result reports when the call moved its command to the
 * background. A foreground call reports `status: "completed"` and an exit
 * code instead, so it never matches.
 */
export function backgroundShellIdFromToolMetadata(metadata: unknown): string | null {
  if (readString(metadata, "status") !== "running") return null;
  const shellID = readString(metadata, "shellID") ?? readString(metadata, "shellId");
  return shellID?.startsWith("sh_") ? shellID : null;
}

export function backgroundShellOutcome(state: string | undefined, exit: number | null): BackgroundShellOutcome {
  if (state === "timeout" || state === "timed_out") return "timed-out";
  if (state === "killed" || state === "cancelled" || state === "canceled" || state === "stopped") return "stopped";
  if (state === "failed" || state === "error" || (exit !== null && exit !== 0)) return "failed";
  return "finished";
}

/**
 * The completion notice inside a `session.inbox.enqueued` item or a stored
 * `synthetic` message: `metadata.source === "shell"` with the shell id. The
 * command comes from the item's description, never from its `<shell>` text.
 */
export function readBackgroundShellCompletion(payload: unknown): BackgroundShellNotice | null {
  if (!isRecord(payload)) return null;
  const metadata = isRecord(payload.metadata) ? payload.metadata : null;
  if (!metadata || readString(metadata, "source") !== "shell") return null;
  const shellId = readString(metadata, "shellID") ?? readString(metadata, "jobID");
  if (!shellId) return null;
  const exit = readNumber(metadata, "exit") ?? null;
  return {
    shellId,
    command: readString(payload, "description") ?? "",
    outcome: backgroundShellOutcome(readString(metadata, "state"), exit),
    exit,
  };
}

/** A notice carried on a transcript part (engine part metadata or UI provider metadata). */
export function readBackgroundShellNotice(value: unknown): BackgroundShellNotice | null {
  if (!isRecord(value)) return null;
  const shellId = readString(value, "shellId");
  const command = readString(value, "command");
  const outcome = readString(value, "outcome");
  const exit = value.exit;
  if (!shellId || command === undefined) return null;
  if (outcome !== "finished" && outcome !== "failed" && outcome !== "timed-out" && outcome !== "stopped") return null;
  if (exit !== null && (typeof exit !== "number" || !Number.isFinite(exit))) return null;
  return { shellId, command, outcome, exit };
}

/** The row's words: what happened, in the person's terms. */
export function backgroundShellNoticeLabel(notice: Pick<BackgroundShellNotice, "outcome" | "exit">): string {
  if (notice.outcome === "timed-out") return "Background task timed out";
  if (notice.outcome === "stopped") return "Background task stopped";
  if (notice.outcome === "failed") return notice.exit === null ? "Background task failed" : `Background task failed · exit ${notice.exit}`;
  return "Background task finished";
}

export function runningBackgroundTasksLabel(count: number): string {
  return `${count} running background ${count === 1 ? "task" : "tasks"}`;
}
