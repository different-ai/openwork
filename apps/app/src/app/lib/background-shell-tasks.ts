export const SHELL_CREATED_EVENT = "shell.created";
export const SHELL_EXITED_EVENT = "shell.exited";
export const SHELL_DELETED_EVENT = "shell.deleted";
export const BACKGROUND_SHELL_STARTED_EVENT = "shell.background.started";
export const BACKGROUND_SHELL_FINISHED_EVENT = "shell.background.finished";

export type EngineShell = {
  id: string;
  status: "running" | "exited" | "timeout" | "killed";
  command: string;
  sessionID: string | null;
  startedAt: number;
  exit: number | null;
};

export type BackgroundShellOutcome = "finished" | "failed" | "timed-out" | "stopped";

export type BackgroundShellNotice = {
  shellId: string;
  command: string;
  outcome: BackgroundShellOutcome;
  exit: number | null;
};

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

export function backgroundShellNoticeLabel(notice: Pick<BackgroundShellNotice, "outcome" | "exit">): string {
  if (notice.outcome === "timed-out") return "Background task timed out";
  if (notice.outcome === "stopped") return "Background task stopped";
  if (notice.outcome === "failed") return notice.exit === null ? "Background task failed" : `Background task failed · exit ${notice.exit}`;
  return "Background task finished";
}

export function runningBackgroundTasksLabel(count: number): string {
  return `${count} running background ${count === 1 ? "task" : "tasks"}`;
}
