import type { DynamicToolUIPart, JSONValue, ProviderMetadata, TextUIPart } from "ai";
import type { ToolPart } from "@opencode-ai/sdk/v2/client";
import {
  connectionActionAppSchemaVersion,
  connectionActionPayloadSchema,
  connectionTargetFromResult,
  hostConnectionDecisionSchema,
  isMemberConnectionDecision,
} from "@openwork/types/connection-action-app";

import { safeStringify } from "@/app/utils";
import { normalizeErrorText } from "@/lib/error-text";

export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, depth = 0): value is JSONValue {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length <= 4_096 && value.every((entry) => isJsonValue(entry, depth + 1));
  if (!isRecord(value)) return false;
  const entries = Object.values(value);
  return entries.length <= 4_096 && entries.every((entry) => isJsonValue(entry, depth + 1));
}

function structuredToolError(error: string): Record<string, unknown> | null {
  if (error.length > 64 * 1_024) return null;
  try {
    const parsed: unknown = JSON.parse(error);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function connectionActionMcpResultFromError(error: string): JSONValue | null {
  const parsed = structuredToolError(error);
  if (!parsed || !isRecord(parsed.connectionStatus)) return null;
  const status = parsed.connectionStatus;
  const action = isRecord(status.action) ? status.action : null;
  const payload = connectionActionPayloadSchema.safeParse({
    schemaVersion: connectionActionAppSchemaVersion,
    connectionId: status.connectionId,
    connectionName: status.connectionName,
    state: status.state,
    actor: status.actor,
    message: status.message,
    action: action
      ? {
          type: action.type,
          label: action.label,
          surface: action.surface,
          ...(typeof action.url === "string" ? { url: action.url } : {}),
        }
      : null,
  });
  if (!payload.success) return null;
  return {
    isError: true,
    content: [{ type: "text", text: error }],
    structuredContent: payload.data,
  };
}

/** Host provenance comes from our native tool metadata, or a gateway root error. */
function toolConnectionDecision(part: ToolPart, metadata: Record<string, unknown>) {
  const gatewayTool = /^(?:openwork|openwork-cloud)_(?:search_capabilities|execute_capability|connection_action)$/.test(part.tool);
  const codeMode = part.tool === "execute" && part.metadata?.openworkV2CodeMode === true;
  if (!gatewayTool && !codeMode) return null;
  if ("openworkConnectionDecision" in metadata) {
    const decision = hostConnectionDecisionSchema.safeParse(metadata.openworkConnectionDecision);
    return decision.success && isMemberConnectionDecision(decision.data.connection) ? decision.data : null;
  }
  // Only these gateway tools own this root error envelope. Never search a
  // provider's prose, nested error text, or an outer script error for metadata.
  if (part.state.status !== "error" || !/^(?:openwork|openwork-cloud)_(?:execute_capability|connection_action)$/.test(part.tool)) return null;
  const error = structuredToolError(part.state.error);
  if (!error || !isRecord(error.connectionStatus)) return null;
  const decision = hostConnectionDecisionSchema.safeParse(error.openworkConnectionDecision);
  if (!decision.success || !isMemberConnectionDecision(decision.data.connection)) return null;
  const target = connectionTargetFromResult(error);
  if (!target?.memberOAuth || !isMemberConnectionDecision(target.connection)) return null;
  // The shared normalizer rejects conflicting identity, state, actor or action.
  const consistent = connectionTargetFromResult({ connectionStatus: target.connection, connectionAction: decision.data.connection });
  return consistent
    && target.connection.action?.label === decision.data.connection.action?.label
    && target.connection.action?.url === decision.data.connection.action?.url ? decision.data : null;
}

function toolCallProviderMetadata(part: ToolPart): ProviderMetadata {
  const stateMetadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {};
  const persistedMcpResult = isJsonValue(stateMetadata.openworkMcpResult)
    ? stateMetadata.openworkMcpResult
    : isJsonValue(stateMetadata.openworkMcpApp)
      ? stateMetadata.openworkMcpApp
      : null;
  const mcpResult = persistedMcpResult
    ?? (part.state.status === "error" ? connectionActionMcpResultFromError(part.state.error) : null);
  // The engine's task tool reports the sub-agent's session id in state
  // metadata. Forward it so the transcript card can open that child session.
  const childSessionId = part.tool === "task" && typeof stateMetadata.sessionId === "string" && stateMetadata.sessionId.trim()
    ? stateMetadata.sessionId.trim()
    : null;
  const appBuilder = /(?:^|_)(?:search_capabilities|prepare_app|create_app|update_app)$/.test(part.tool);
  const toolStartedAt = (appBuilder || part.tool === "task" || part.metadata?.openworkV2CodeMode === true) && "time" in part.state && typeof part.state.time?.start === "number"
    && Number.isFinite(part.state.time.start)
    ? part.state.time.start
    : null;
  const connectionDecision = toolConnectionDecision(part, stateMetadata);
  const toolCompletedAt = appBuilder && "time" in part.state && "end" in part.state.time && typeof part.state.time.end === "number"
    && Number.isFinite(part.state.time.end) ? part.state.time.end : null;
  const openwork = {
    ...(connectionDecision ? { connectionDecision } : {}),
    ...(part.id !== part.callID ? { sourcePartId: part.id } : {}),
    ...(mcpResult ? { mcpResult } : {}),
    ...(childSessionId ? { childSessionId } : {}),
    ...(toolStartedAt === null ? {} : { toolStartedAt }),
    ...(toolCompletedAt === null ? {} : { toolCompletedAt }),
    ...(part.metadata?.openworkV2CodeMode === true ? {
      codeMode: {
        calls: Array.isArray(stateMetadata.toolCalls) && isJsonValue(stateMetadata.toolCalls) ? stateMetadata.toolCalls : [],
      },
    } : {}),
  };
  return {
    opencode: { partId: part.id },
    ...(Object.keys(openwork).length > 0 ? { openwork } : {}),
  };
}

function shouldDeferInProgressTool(part: ToolPart) {
  if (part.state.status === "completed" || part.state.status === "error") {
    return false;
  }

  return Object.keys(part.state.input).length === 0;
}

export function parseStructuredOutputUIPart(part: ToolPart): TextUIPart | null {
  if (part.state.status === "error") {
    return null;
  }

  const text = safeStringify(part.state.input);

  if (text === "{}" && part.state.status !== "completed") {
    return null;
  }

  return {
    type: "text",
    text,
    state: part.state.status === "completed" ? "done" : "streaming",
    providerMetadata: { opencode: { partId: `structured-output-${part.callID}`, toolPartId: part.id } },
  };
}

export function parseDynamicToolUIPart(part: ToolPart): DynamicToolUIPart | null {
  if (part.tool === STRUCTURED_OUTPUT_TOOL) {
    return null;
  }

  if (part.state.status === "error") {
    return {
      type: "dynamic-tool",
      toolName: part.tool,
      toolCallId: part.callID,
      state: "output-error",
      input: part.state.input,
      errorText: normalizeErrorText(part.state.error).display,
      callProviderMetadata: toolCallProviderMetadata(part),
    };
  }

  if (part.state.status === "completed") {
    if (part.metadata?.openworkV2CodeMode === true && part.state.metadata.error === true) {
      return {
        type: "dynamic-tool", toolName: part.tool, toolCallId: part.callID,
        state: "output-error", input: part.state.input,
        errorText: normalizeErrorText(part.state.output).display,
        callProviderMetadata: toolCallProviderMetadata(part),
      };
    }
    return {
      type: "dynamic-tool",
      toolName: part.tool,
      toolCallId: part.callID,
      state: "output-available",
      input: part.state.input,
      output: part.state.output,
      callProviderMetadata: toolCallProviderMetadata(part),
    };
  }

  // OpenCode emits pending/running tool parts with `{}` input before args
  // (e.g. filePath) are filled in. Skip UI until the next part.updated.
  if (shouldDeferInProgressTool(part)) {
    return null;
  }

  return {
    type: "dynamic-tool",
    toolName: part.tool,
    toolCallId: part.callID,
    // The engine's running event means the full builder input was submitted;
    // pending events still represent the model writing its arguments.
    state: part.state.status === "running" && /(?:^|_)(?:search_capabilities|prepare_app|create_app|update_app)$/.test(part.tool) ? "input-available" : "input-streaming",
    input: part.state.input,
    callProviderMetadata: toolCallProviderMetadata(part),
  };
}
