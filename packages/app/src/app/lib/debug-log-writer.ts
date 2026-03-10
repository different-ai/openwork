import { isTauriRuntime } from "../utils";
import {
  buildDebugEventBase,
  createDebugCorrelationId,
  getActiveDebugSession,
  getActiveCorrelationId,
  isDebugLoggingEnabled,
  setActiveCorrelationId,
  sanitizePayload,
  type DebugEvent,
  type DebugEventBase,
} from "./debug-log";

export type DebugLogTarget = "timeline" | "system";

type DebugCallInput = {
  operation: string;
  surface: string;
  args?: Record<string, unknown> | null;
  entity?: DebugEventBase["entity"];
};

export async function appendDebugEvent(
  event: DebugEvent,
  target: DebugLogTarget = "timeline",
): Promise<boolean> {
  if (!isDebugLoggingEnabled()) return false;
  if (!isTauriRuntime()) return false;
  const session = getActiveDebugSession();
  if (!session) return false;

  const sanitized = { ...event, payload: sanitizePayload(event.payload) };
  const line = JSON.stringify(sanitized);
  const maxBytes =
    target === "system" ? session.retention.maxSystemBytes : session.retention.maxTimelineBytes;

  try {
    const { debugSessionAppend } = await import("./tauri");
    const result = await debugSessionAppend({
      sessionId: session.id,
      target,
      line,
      maxBytes,
    });
    return result.appended;
  } catch {
    return false;
  }
}

const normalizeError = (error: unknown) => {
  if (error instanceof Error) {
    const anyError = error as Error & { code?: string; status?: number; statusCode?: number };
    return {
      message: error.message,
      kind: error.name,
      code: typeof anyError.code === "string" ? anyError.code : undefined,
      status: typeof anyError.status === "number" ? anyError.status : anyError.statusCode,
    };
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : undefined;
    const code = typeof record.code === "string" ? record.code : undefined;
    const kind = typeof record.name === "string" ? record.name : undefined;
    const status = typeof record.status === "number"
      ? record.status
      : typeof record.statusCode === "number"
        ? record.statusCode
        : undefined;
    return { message, code, kind, status };
  }
  return { message: undefined, code: undefined, kind: undefined, status: undefined };
};

export async function withDebugCall<T>(input: DebugCallInput, fn: () => Promise<T>): Promise<T> {
  if (!isDebugLoggingEnabled() || !isTauriRuntime()) {
    return fn();
  }
  const session = getActiveDebugSession();
  if (!session) return fn();

  const correlationId = getActiveCorrelationId() ?? createDebugCorrelationId();
  setActiveCorrelationId(correlationId);
  const startedAt = Date.now();

  try {
    const result = await fn();
    const endedAt = Date.now();
    const base = buildDebugEventBase({
      kind: "call",
      debugSessionId: session.id,
      correlationId,
      surface: input.surface,
      action: input.operation,
      entity: input.entity,
      payload: input.args ? { args: input.args, startedAt, endedAt } : { startedAt, endedAt },
    });
    await appendDebugEvent({
      ...base,
      kind: "call",
      operation: input.operation,
      status: "ok",
      durationMs: endedAt - startedAt,
    });
    return result;
  } catch (error) {
    const endedAt = Date.now();
    const normalized = normalizeError(error);
    const base = buildDebugEventBase({
      kind: "call",
      debugSessionId: session.id,
      correlationId,
      surface: input.surface,
      action: input.operation,
      entity: input.entity,
      payload: input.args ? { args: input.args, startedAt, endedAt } : { startedAt, endedAt },
    });
    await appendDebugEvent({
      ...base,
      kind: "call",
      operation: input.operation,
      status: "error",
      durationMs: endedAt - startedAt,
      error: {
        code: normalized.code || (normalized.status ? String(normalized.status) : undefined),
        message: normalized.message,
        kind: normalized.kind,
      },
    });
    throw error;
  }
}
