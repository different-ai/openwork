import type { DynamicToolUIPart } from "ai";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NO_INDIVIDUAL_ERROR = "The tool call failed. The engine did not provide an individual error; see the execution details.";

function outputText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value.flatMap((item) => isRecord(item) && typeof item.text === "string" ? [item.text] : []).join("\n");
    return text || null;
  }
  return null;
}

/**
 * The script's own error, when the engine recorded one. A failed Den script
 * returns `{ error: "script_failed", message, kind }` as the step's result;
 * that message ("`.then` is not supported, use await…") is what a person or a
 * support engineer needs, not a generic placeholder.
 */
export function codeModeScriptError(part: DynamicToolUIPart): string | null {
  const raw = part.state === "output-error" ? part.errorText : part.state === "output-available" ? outputText(part.output) : null;
  if (!raw) return null;
  const message = structuredMessage(raw, 0);
  if (message) return message;
  return part.state === "output-error" && raw.trim() ? raw.trim() : null;
}

/**
 * The engine wraps a thrown script result, so the payload can arrive as
 * `{"error":"Error: {\"error\":\"script_failed\",\"message\":…}"}`. Unwrap a
 * few levels to the first `message`.
 */
function structuredMessage(text: string, depth: number): string | null {
  if (depth > 3) return null;
  const start = text.indexOf("{");
  if (start < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  // The wrapper's own `message` can be the inner JSON string; keep unwrapping.
  for (const key of ["message", "error"]) {
    const value = parsed[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const inner = value.includes("{") ? structuredMessage(value, depth + 1) : null;
    if (inner) return inner;
    if (key === "message" && !value.trim().startsWith("{")) return value.trim();
  }
  return null;
}

/** Project recorded calls, never infer execution by parsing the generated code. */
export function codeModeToolCalls(part: DynamicToolUIPart): DynamicToolUIPart[] | null {
  const codeMode = part.callProviderMetadata?.openwork?.codeMode;
  if (!isRecord(codeMode) || !Array.isArray(codeMode.calls)) return null;
  const calls = codeMode.calls;
  // The engine reports one error for the whole script. Attribute it to the
  // call that failed last; earlier failures keep the honest placeholder.
  const lastFailed = calls.reduce<number>((found, call, index) => isRecord(call) && call.status === "error" ? index : found, -1);
  const scriptError = lastFailed >= 0 ? codeModeScriptError(part) : null;
  return calls.flatMap((call, ordinal): DynamicToolUIPart[] => {
    if (!isRecord(call) || typeof call.tool !== "string" || !call.tool.trim()) return [];
    const base = {
      // v2 reports calls in their invocation order, including repeated/parallel calls.
      toolCallId: `${part.toolCallId}:call:${ordinal}`,
      toolName: call.tool.replaceAll(".", "_"),
      input: call.input,
    };
    if (call.status === "running") return [{ ...base, type: "dynamic-tool", state: "input-streaming" }];
    if (call.status === "completed") return [{ ...base, type: "dynamic-tool", state: "output-available", output: undefined }];
    if (call.status === "error") return [{
      ...base, type: "dynamic-tool", state: "output-error",
      errorText: ordinal === lastFailed && scriptError ? scriptError : NO_INDIVIDUAL_ERROR,
    }];
    return [];
  });
}
