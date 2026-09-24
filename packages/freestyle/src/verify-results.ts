// Parsers for what CI verification prints to its public log. Guest output is
// untrusted: accept only known step names, finite timings and short error codes.

export const DESKTOP_CHAT_STEPS = ["import", "attach", "route", "model", "send", "reply", "done"];

export interface DesktopChatResult {
  ok: boolean;
  step: string;
  timedOut: boolean;
  timings: Record<string, number>;
  model?: string;
  reply?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The last stdout line of packages/freestyle/src/desktop-chat-check.mjs, or null when it is not a valid result. */
export function desktopChatResult(stdout: string | null | undefined): DesktopChatResult | null {
  let value: unknown;
  try { value = JSON.parse((stdout ?? "").trim().split("\n").pop() ?? ""); } catch { return null; }
  if (!record(value) || typeof value.ok !== "boolean" || typeof value.step !== "string"
    || !DESKTOP_CHAT_STEPS.includes(value.step) || !record(value.timings)) return null;
  const timings: Record<string, number> = {};
  for (const [name, ms] of Object.entries(value.timings)) {
    if (!DESKTOP_CHAT_STEPS.includes(name) || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
    timings[name] = Math.round(ms);
  }
  return {
    ok: value.ok, step: value.step, timedOut: value.timedOut === true, timings,
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.reply === "string" ? { reply: value.reply } : {}),
  };
}

/** An engine (`code`) or OpenCode (`name`) error identifier that is safe to print, or "". */
export function responseErrorCode(body: unknown): string {
  const code = record(body) ? body.code ?? body.name : undefined;
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : "";
}

// The preview gateway's own error bodies (packages/freestyle/src/gateway.mjs).
const GATEWAY_ERRORS = new Map([
  ["Sandbox unavailable. Launch a fresh sandbox from the review.", "preview gateway could not reach the service"],
  ["This world is not ready. Try launching again from the review.", "preview gateway has no service map yet"],
]);

/**
 * Where a failed response came from, safe to print: the service behind the
 * gateway (which relays with `referrer-policy: no-referrer`), the gateway
 * itself, or something before it such as the provider edge.
 */
export function responseErrorSource(headers: Headers, text: string): string {
  if (headers.get("referrer-policy") === "no-referrer") {
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = undefined; }
    const code = responseErrorCode(body);
    return code ? `service error ${code}` : "service error without a code";
  }
  return GATEWAY_ERRORS.get(text.trim()) ?? "not from the preview gateway (provider edge or network)";
}
