import { t } from "@/i18n";

function parseBody(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

export function proxyFailure(error: unknown): { code: string | null; message: string | null; status: number | null } {
  const parsed = typeof error === "string" ? parseBody(error) : error;
  const record = parsed && typeof parsed === "object" ? parsed : {};
  const message = "message" in record && typeof record.message === "string" ? record.message : null;
  const body = message ? parseBody(message) : null;
  const nested = body && typeof body === "object" ? body : {};
  const code = "code" in nested && typeof nested.code === "string" ? nested.code
    : "code" in record && typeof record.code === "string" ? record.code
    : "error" in nested && typeof nested.error === "string" ? nested.error
    : "error" in record && typeof record.error === "string" ? record.error : null;
  return {
    code,
    message: "message" in nested && typeof nested.message === "string" ? nested.message : message,
    status: "status" in record && typeof record.status === "number" ? record.status : null,
  };
}

export function sandboxTransitionNote(error: unknown, transitioning = false): string | null {
  const { code, status, message } = proxyFailure(error);
  if ((status === null || status === 409) && (code === "sandbox_engine_busy" || code === "sandbox_engine_policy_pending" || code === "sandbox_engine_activity_unavailable")) {
    if (message && /^Your sandbox setting (?:is saved and )?applies when current tasks finish\. Send this again then\.$/.test(message)) return message;
    return t("sandbox.send_pending");
  }
  if (status === null || status === 503) {
    if (code === "engine_v2_preview_not_running" || code === "sandbox_engine_refresh_in_progress") return t("sandbox.applying");
    if (code === "sandbox_engine_refresh_failed" && transitioning) return t("sandbox.applying");
  }
  return null;
}

export function sandboxSendDisposition(error: unknown, transitioning = false) {
  const note = sandboxTransitionNote(error, transitioning);
  return note
    ? { kind: "deferred", note } satisfies { kind: "deferred"; note: string }
    : { kind: "failed" } satisfies { kind: "failed" };
}
