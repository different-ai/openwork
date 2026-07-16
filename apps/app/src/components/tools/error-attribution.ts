import { openworkCloudMcpInlineReconnectSchema } from "@openwork/types/den/mcp-connection-action"

export type ToolErrorAttribution = {
  label: string
  confidence: "Confirmed" | "Inferred"
  description: string
}

export type ChatToolReconnectAction = {
  connectionId: string
  connectionName: string
  label: string
}

export type ChatToolReconnectProgress = "opening" | "authorization_opened"
export type ChatToolReconnectResult = "connected"

const OPENWORK_CLOUD_CAPABILITY_TOOLS = new Set([
  "openwork-cloud_search_capabilities",
  "openwork-cloud_execute_capability",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseResultRecord(result: unknown): Record<string, unknown> | null {
  if (isRecord(result)) return result
  if (typeof result !== "string") return null

  const trimmed = result.trim()
  const jsonStart = trimmed.indexOf("{")
  const jsonEnd = trimmed.lastIndexOf("}")
  const candidates = [
    trimmed,
    ...(jsonStart > 0 ? [trimmed.slice(jsonStart)] : []),
    ...(jsonStart >= 0 && jsonEnd > jsonStart ? [trimmed.slice(jsonStart, jsonEnd + 1)] : []),
  ]

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (isRecord(parsed)) return parsed
    } catch {
      // The engine may wrap the MCP JSON in a plain error message.
    }
  }
  return null
}

function diagnosticFromError(errorText: string): Record<string, unknown> | null {
  const parsed = parseResultRecord(errorText)
  if (!parsed) return null
  return isRecord(parsed.diagnostic) ? parsed.diagnostic : parsed
}

function stringValue(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === "string" && value.trim() ? value : undefined
}

function numberValue(record: Record<string, unknown> | null, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function confirmed(label: string, description: string): ToolErrorAttribution {
  return { label, confidence: "Confirmed", description }
}

export function reconnectActionFromChatToolResult(
  toolName: string,
  result: unknown,
): ChatToolReconnectAction | null {
  // Tool output is otherwise untrusted. Only the two canonical OpenWork Cloud
  // capability tools may turn a structured Den response into a UI action.
  // Discovery is included because it performs a live connection probe before
  // the agent can safely proceed to execution.
  if (!OPENWORK_CLOUD_CAPABILITY_TOOLS.has(toolName)) return null

  const parsed = parseResultRecord(result)
  if (!parsed) return null

  const candidates = [
    ...(isRecord(parsed.connectionStatus) ? [parsed.connectionStatus] : []),
    ...(Array.isArray(parsed.matches)
      ? parsed.matches
        .filter(isRecord)
        .map((match) => match.connectionStatus)
        .filter(isRecord)
      : []),
  ]
  const reconnectTargets = new Map<string, { connectionId: string; connectionName: string }>()
  for (const connectionStatus of candidates) {
    const parsedStatus = openworkCloudMcpInlineReconnectSchema.safeParse(connectionStatus)
    if (!parsedStatus.success) continue
    const { connectionId, connectionName } = parsedStatus.data
    reconnectTargets.set(connectionId, { connectionId, connectionName })
  }

  // One tool row should never guess which of several connections the user
  // intended to authorize. Multi-connection search results remain descriptive.
  if (reconnectTargets.size !== 1) return null
  const [{ connectionId, connectionName }] = reconnectTargets.values()

  // Keep the chat action concise and derived from the trusted connection
  // identity. Diagnostic operator guidance can be much longer than a button
  // label, and tool output must never get to inject arbitrary action copy.
  return { connectionId, connectionName, label: "Reconnect" }
}

export function attributeChatToolError(errorText: string): ToolErrorAttribution | null {
  const diagnostic = diagnosticFromError(errorText)
  const code = stringValue(diagnostic, "code")
  const category = stringValue(diagnostic, "category")
  const phase = stringValue(diagnostic, "phase")
  const httpStatus = numberValue(diagnostic, "httpStatus")
  const providerStatus = numberValue(diagnostic, "providerStatus")
  const providerCode = stringValue(diagnostic, "providerCode")

  if (
    errorText.includes("OpenWork stopped waiting after")
    || /The capability call exceeded \d+(?:\.\d+)?s\b/.test(errorText)
    || code === "MCP_LIFECYCLE_DEADLINE"
    || code === "MCP_REQUEST_TIMEOUT"
    || category === "lifecycle_deadline"
  ) {
    return confirmed(
      "OpenWork timeout",
      "OpenWork created this deadline. The external operation may still have completed, so verify its state before retrying.",
    )
  }

  if (
    category === "security_blocked"
    || code === "MCP_URL_BLOCKED"
    || code === "MCP_FETCH_FORBIDDEN_PORT"
  ) {
    return confirmed("Blocked by OpenWork", "OpenWork blocked the request before it was sent.")
  }

  if (httpStatus !== undefined && (httpStatus < 200 || httpStatus >= 300)) {
    return confirmed(
      `Remote MCP · HTTP ${httpStatus}`,
      `The remote MCP returned HTTP ${httpStatus}.`,
    )
  }

  if (
    phase?.startsWith("PROVIDER_")
    || category?.startsWith("provider_")
    || providerStatus !== undefined
    || providerCode !== undefined
  ) {
    return confirmed(
      "Provider error",
      providerStatus === undefined
        ? "The remote MCP responded, but the downstream provider or tool rejected the operation."
        : `The remote MCP responded, but the downstream provider returned status ${providerStatus}.`,
    )
  }

  if (/\b(?:timed out|timeout|deadline exceeded)\b/i.test(errorText)) {
    return {
      label: "Timeout · source unclear",
      confidence: "Inferred",
      description: "A timeout was reported, but the client did not receive structured evidence identifying which boundary created it.",
    }
  }

  return null
}
