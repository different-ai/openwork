#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  UI_ARTIFACT_MAX_JSON_BYTES,
  UI_ARTIFACT_SCHEMA_VERSION,
  uiArtifactRenderResultSchema,
  uiArtifactUseInputSchema,
  type UiArtifactError,
  type UiArtifactErrorCode,
} from "@openwork/types/ui-artifact"
import {
  searchArtifacts,
  searchArtifactsInputSchema,
  searchArtifactsResultSchema,
} from "./catalog.js"
import { UiArtifactMockStore } from "./state.js"

const server = new McpServer({
  name: "openwork-ui-artifacts-demo",
  version: "0.1.0",
})
const store = new UiArtifactMockStore()

function serializeBounded(value: unknown) {
  const text = JSON.stringify(value)
  return Buffer.byteLength(text, "utf8") <= UI_ARTIFACT_MAX_JSON_BYTES ? text : null
}

function oversizedResult() {
  return errorResult(
    "payload_too_large",
    `UI artifact payload exceeds the ${UI_ARTIFACT_MAX_JSON_BYTES}-byte render limit. Reduce rows or excerpt lengths and try again.`,
  )
}

function errorResult(code: UiArtifactErrorCode, message: string) {
  const retry = (() => {
    switch (code) {
      case "schema_digest_mismatch":
      case "manifest_changed":
      case "unknown_artifact":
        return { action: "search_artifacts" as const, changedArgumentsRequired: true }
      case "invalid_artifact_payload":
      case "unsafe_action":
      case "source_receipt_required":
      case "source_receipt_invalid":
      case "operation_unsupported":
      case "revision_conflict":
      case "state_not_found":
      case "action_not_allowed":
        return { action: "use_artifact" as const, changedArgumentsRequired: true }
      default:
        return { action: "none" as const, changedArgumentsRequired: false }
    }
  })()
  const error: UiArtifactError = {
    protocol: "openwork.ui-artifact-error",
    schemaVersion: UI_ARTIFACT_SCHEMA_VERSION,
    code,
    message,
    retry,
  }
  return {
    content: [{ type: "text" as const, text: serializeBounded(error) ?? JSON.stringify(error) }],
    structuredContent: error,
    isError: true,
  }
}

server.registerTool(
  "search_artifacts",
  {
    title: "Search UI artifacts",
    description: "Find a native OpenWork UI artifact for the user's request. Call this after a data tool returns calendar, email, chat, task, incident, approval, progress, or summary data. Include only bounded triggering tool metadata. The result returns a ranked use_artifact definition and a deterministic demo example. Pick at most one artifact per user turn.",
    inputSchema: searchArtifactsInputSchema,
    outputSchema: searchArtifactsResultSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (input) => {
    const result = searchArtifacts(input)
    const text = serializeBounded(result)
    if (!text) return oversizedResult()
    return {
      content: [{ type: "text", text }],
      structuredContent: result,
    }
  },
)

server.registerTool(
  "use_artifact",
  {
    title: "Use UI artifact",
    description: "Render the exact synthetic invocation returned by search_artifacts, or apply an explicit revision-safe decision to a rendered mock approval. The server holds mock state for its process lifetime. Never infer an approval decision. After success, use the narration instead of repeating every row.",
    inputSchema: uiArtifactUseInputSchema,
    outputSchema: uiArtifactRenderResultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (input) => {
    const resolved = store.use(input)
    if (!resolved.ok) return errorResult(resolved.code, resolved.message)
    const result = uiArtifactRenderResultSchema.parse(resolved.result)
    const text = serializeBounded(result)
    if (!text) return oversizedResult()
    return {
      content: [{ type: "text", text }],
      structuredContent: result,
    }
  },
)

await server.connect(new StdioServerTransport())
