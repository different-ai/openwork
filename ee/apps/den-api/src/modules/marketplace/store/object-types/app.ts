// Policy for `app` config objects. Generic config-object routes must never
// write or return authored MCP App source; these checks protect data whether or
// not the mcpApps module is available, so they stay with marketplace.
import { isAuthoredMcpAppVersion, redactMcpAppRevision } from "@openwork/types/mcp-app"
import { clampCodePoints, clampUtf8Bytes, PROJECTION_TEXT_MAX_BYTES, PROJECTION_TITLE_MAX_CHARS } from "../../../../routes/org/plugin-system/projection-text.js"
import { PluginArchRouteFailure } from "../route-failure.js"

export const INTERNAL_MCP_APP_WRITE = Symbol("internal-mcp-app-write")

export function rejectAuthoredMcpAppWrite(value: Parameters<typeof isAuthoredMcpAppVersion>[0], internal?: typeof INTERNAL_MCP_APP_WRITE) {
  if (isAuthoredMcpAppVersion(value) && internal !== INTERNAL_MCP_APP_WRITE) {
    throw new PluginArchRouteFailure(400, "reserved_mcp_app_schema", "Authored MCP Apps must be compiled and published through create_app or update_app.")
  }
}

export function deriveAuthoredMcpAppProjection(input: {
  objectType: string
  value: Parameters<typeof isAuthoredMcpAppVersion>[0] & { metadata?: Record<string, unknown> }
}) {
  if (input.objectType === "app" && isAuthoredMcpAppVersion(input.value)) {
    const metadata = input.value.metadata ?? {}
    const title = clampCodePoints((typeof metadata.title === "string" && metadata.title.trim()) || "MCP App", PROJECTION_TITLE_MAX_CHARS)
    const description = typeof metadata.description === "string" ? clampUtf8Bytes(metadata.description.trim(), PROJECTION_TEXT_MAX_BYTES) || null : null
    return { title, description, searchText: clampUtf8Bytes([title, description].filter(Boolean).join("\n"), PROJECTION_TEXT_MAX_BYTES) }
  }
  return null
}

export function authoredMcpAppVersionReadView(row: Parameters<typeof isAuthoredMcpAppVersion>[0] & Parameters<typeof redactMcpAppRevision>[0]) {
  if (!isAuthoredMcpAppVersion(row)) {
    return null
  }
  return { normalizedPayloadJson: redactMcpAppRevision(row) }
}
