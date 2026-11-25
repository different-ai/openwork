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

export function codeModeScriptError(part: DynamicToolUIPart): string | null {
  const raw = part.state === "output-error" ? part.errorText : part.state === "output-available" ? outputText(part.output) : null;
  if (!raw) return null;
  const message = structuredMessage(raw, 0);
  if (message) return message;
  return part.state === "output-error" && raw.trim() ? raw.trim() : null;
}

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
  for (const key of ["message", "error"]) {
    const value = parsed[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const inner = value.includes("{") ? structuredMessage(value, depth + 1) : null;
    if (inner) return inner;
    if (key === "message" && !value.trim().startsWith("{")) return value.trim();
  }
  return null;
}

function stableJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, (_key, entry: unknown) => isRecord(entry)
      ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry);
  } catch {
    return undefined;
  }
}

function capturedDetails(part: DynamicToolUIPart, codeMode: Record<string, unknown>, calls: unknown[]): Array<Record<string, unknown> | null> {
  const details = (Array.isArray(codeMode.details) ? codeMode.details : []).filter((detail): detail is Record<string, unknown> =>
    isRecord(detail) && typeof detail.tool === "string"
    && (typeof detail.invocationId !== "string" || detail.invocationId.startsWith(`${part.toolCallId}:`)))
    .toSorted((left, right) => Number(left.ordinal) - Number(right.ordinal));
  const byTool = new Map<string, Array<Record<string, unknown>>>();
  for (const detail of details) {
    const tool = String(detail.tool).replaceAll(".", "_");
    byTool.set(tool, [...(byTool.get(tool) ?? []), detail]);
  }
  const seen = new Map<string, number>();
  return calls.map((call) => {
    if (!isRecord(call) || typeof call.tool !== "string") return null;
    const tool = call.tool.replaceAll(".", "_");
    const occurrence = seen.get(tool) ?? 0;
    seen.set(tool, occurrence + 1);
    const sameTool = byTool.get(tool) ?? [];
    const candidate = sameTool[occurrence] ?? null;
    const inputKey = call.input === undefined ? undefined : stableJson(call.input);
    const comparable = (detail: Record<string, unknown>) => detail.input !== undefined && detail.truncated !== true;
    if (!candidate || inputKey === undefined || !comparable(candidate) || stableJson(candidate.input) === inputKey) return candidate;
    const equal = sameTool.filter((detail) => comparable(detail) && stableJson(detail.input) === inputKey);
    return equal.length === 1 ? equal[0]! : candidate;
  });
}

export function codeModeToolCalls(part: DynamicToolUIPart): DynamicToolUIPart[] | null {
  const codeMode = part.callProviderMetadata?.openwork?.codeMode;
  if (!isRecord(codeMode) || !Array.isArray(codeMode.calls)) return null;
  const calls = codeMode.calls;
  const details = capturedDetails(part, codeMode, calls);
  const lastFailed = calls.reduce<number>((found, call, index) => isRecord(call) && call.status === "error" ? index : found, -1);
  const scriptError = lastFailed >= 0 ? codeModeScriptError(part) : null;
  return calls.flatMap((call, ordinal): DynamicToolUIPart[] => {
    if (!isRecord(call) || typeof call.tool !== "string" || !call.tool.trim()) return [];
    const detail = details[ordinal] ?? null;
    const startedAt = typeof detail?.startedAt === "number" && Number.isFinite(detail.startedAt) ? detail.startedAt : null;
    const base = {
      toolCallId: `${part.toolCallId}:call:${ordinal}`,
      toolName: call.tool.replaceAll(".", "_"),
      input: call.input,
      ...(startedAt === null ? {} : { callProviderMetadata: { openwork: { toolStartedAt: startedAt } } }),
    };
    if (call.status === "running") return [{ ...base, type: "dynamic-tool", state: "input-streaming" }];
    if (call.status === "completed") return [{ ...base, type: "dynamic-tool", state: "output-available", output: detail?.output }];
    if (call.status === "error") return [{
      ...base, type: "dynamic-tool", state: "output-error",
      errorText: typeof detail?.error === "string" && detail.error.trim() ? detail.error
        : ordinal === lastFailed && scriptError ? scriptError : NO_INDIVIDUAL_ERROR,
    }];
    return [];
  });
}
