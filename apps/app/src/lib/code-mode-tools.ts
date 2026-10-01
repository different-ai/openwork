import type { DynamicToolUIPart, JSONValue } from "ai";

function isRecord(value: JSONValue | undefined): value is Record<string, JSONValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Project recorded calls, never infer execution by parsing the generated code. */
export function codeModeToolCalls(part: DynamicToolUIPart): DynamicToolUIPart[] | null {
  const codeMode = part.callProviderMetadata?.openwork?.codeMode;
  if (!isRecord(codeMode) || !Array.isArray(codeMode.calls)) return null;
  return codeMode.calls.flatMap((call, ordinal): DynamicToolUIPart[] => {
    if (!isRecord(call) || typeof call.tool !== "string" || !call.tool.trim()) return [];
    // Invocation ordinal is assigned at call start by the pinned native runtime.
    // The native call list uses server.tool, while plugin hooks use server_tool.
    // Match the pinned runtime's flattened ID AND invocation ordinal. A
    // conflicting outer invocation ID or ambiguous detail remains unavailable.
    const toolId = call.tool.replaceAll(".", "_");
    const candidates = Array.isArray(codeMode.details) ? codeMode.details.filter(value =>
      isRecord(value) && value.ordinal === ordinal && typeof value.tool === "string"
      && value.tool.replaceAll(".", "_") === toolId
      && (value.invocationId === undefined || value.invocationId === `${part.toolCallId}:${ordinal}`)) : [];
    const detail = candidates.length === 1 ? candidates[0] : null;
    const enriched = isRecord(detail) ? detail : null;
    const base = {
      // v2 reports calls in their invocation order, including repeated/parallel calls.
      toolCallId: `${part.toolCallId}:call:${ordinal}`,
      toolName: toolId,
      input: call.input,
      callProviderMetadata: { openwork: {
        ...(typeof enriched?.startedAt === "number" ? { toolStartedAt: enriched.startedAt } : {}),
        ...(typeof enriched?.endedAt === "number" ? { toolEndedAt: enriched.endedAt } : {}),
        ...(enriched?.truncated ? { resultTruncated: true } : {}),
        ...(enriched?.output && typeof enriched.output === "object" ? { mcpResult: enriched.output } : {}),
      } },
    };
    if (call.status === "running") return [{ ...base, type: "dynamic-tool", state: "input-streaming" }];
    if (call.status === "completed") return [{ ...base, type: "dynamic-tool", state: "output-available", output: enriched?.output }];
    if (call.status === "error") return [{
      ...base, type: "dynamic-tool", state: "output-error",
      errorText: typeof enriched?.error === "string" ? enriched.error : "The tool call failed. The engine did not provide an individual error; see the execution details.",
    }];
    return [];
  });
}
