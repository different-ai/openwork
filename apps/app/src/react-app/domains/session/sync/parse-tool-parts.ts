import type { DynamicToolUIPart, JSONValue, ProviderMetadata, TextUIPart } from "ai";
import type { ToolPart } from "@opencode-ai/sdk/v2/client";
import {
  connectionActionAppResourceUri,
  connectionActionAppSchemaVersion,
  connectionActionPayloadSchema,
  connectionActionToolName,
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

function connectionActionMcpResultFromError(error: string): JSONValue | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(error);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.connectionStatus)) return null;
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
    content: [{ type: "text", text: error }],
    structuredContent: payload.data,
    _meta: {
      "openwork/mcpApp": {
        toolName: connectionActionToolName,
        resourceUri: connectionActionAppResourceUri,
        arguments: { connectionId: payload.data.connectionId },
      },
    },
  };
}

type ChangedFileKind = "added" | "deleted" | "modified" | "moved";

function changedFileEntry(
  file: unknown,
  additions: unknown,
  deletions: unknown,
  kind: ChangedFileKind,
): JSONValue | null {
  if (typeof file !== "string" || !file.trim()) return null;
  return {
    file: file.trim(),
    kind,
    ...(typeof additions === "number" && Number.isFinite(additions) ? { additions } : {}),
    ...(typeof deletions === "number" && Number.isFinite(deletions) ? { deletions } : {}),
  };
}

function applyPatchChangeKind(type: unknown): ChangedFileKind {
  if (type === "add") return "added";
  if (type === "delete") return "deleted";
  if (type === "move") return "moved";
  return "modified";
}

// The engine reports per-file diff stats in completed edit/write/apply_patch
// state metadata. Forward them so the thread panel can aggregate the
// session's changed files without re-reading raw parts.
function changedFilesMetadata(part: ToolPart, stateMetadata: Record<string, unknown>): JSONValue[] {
  if (part.state.status !== "completed") return [];
  const input = isRecord(part.state.input) ? part.state.input : {};

  if (part.tool === "edit") {
    const filediff = isRecord(stateMetadata.filediff) ? stateMetadata.filediff : null;
    const entry = changedFileEntry(
      filediff?.file ?? input.filePath,
      filediff?.additions,
      filediff?.deletions,
      "modified",
    );
    return entry ? [entry] : [];
  }

  if (part.tool === "write") {
    const file = typeof stateMetadata.filepath === "string" && stateMetadata.filepath.trim()
      ? stateMetadata.filepath
      : input.filePath;
    // `exists` reports whether the file existed before the write.
    const created = stateMetadata.exists !== true;
    const content = typeof input.content === "string" ? input.content : null;
    const additions = created && content !== null ? content.split("\n").length : undefined;
    const entry = changedFileEntry(file, additions, created ? 0 : undefined, created ? "added" : "modified");
    return entry ? [entry] : [];
  }

  if (part.tool === "apply_patch") {
    const files = Array.isArray(stateMetadata.files) ? stateMetadata.files : [];
    return files.flatMap((candidate) => {
      if (!isRecord(candidate)) return [];
      const entry = changedFileEntry(
        candidate.relativePath ?? candidate.filePath,
        candidate.additions,
        candidate.deletions,
        applyPatchChangeKind(candidate.type),
      );
      return entry ? [entry] : [];
    });
  }

  return [];
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
  const changedFiles = changedFilesMetadata(part, stateMetadata);
  // The bash tool reports its exit status in completed state metadata.
  const exitCode = part.tool === "bash"
    && part.state.status === "completed"
    && typeof stateMetadata.exit === "number"
    && Number.isFinite(stateMetadata.exit)
    ? stateMetadata.exit
    : null;
  const openwork = {
    ...(mcpResult ? { mcpResult } : {}),
    ...(childSessionId ? { childSessionId } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(exitCode !== null ? { exitCode } : {}),
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
    state: "input-streaming",
    input: part.state.input,
    callProviderMetadata: toolCallProviderMetadata(part),
  };
}
