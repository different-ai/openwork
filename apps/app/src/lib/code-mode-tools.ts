import type { DynamicToolUIPart } from "ai";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Project recorded calls, never infer execution by parsing the generated code. */
export function codeModeToolCalls(part: DynamicToolUIPart): DynamicToolUIPart[] | null {
  const codeMode = part.callProviderMetadata?.openwork?.codeMode;
  if (!isRecord(codeMode) || !Array.isArray(codeMode.calls)) return null;
  return codeMode.calls.flatMap((call, ordinal): DynamicToolUIPart[] => {
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
      errorText: "The tool call failed. The engine did not provide an individual error; see the execution details.",
    }];
    return [];
  });
}
