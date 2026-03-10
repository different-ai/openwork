import { isTauriRuntime } from "../utils";
import { debugSessionAppend } from "./tauri";
import {
  getActiveDebugSession,
  isDebugLoggingEnabled,
  sanitizePayload,
  type DebugEvent,
} from "./debug-log";

export type DebugLogTarget = "timeline" | "system";

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
