import type { DynamicToolUIPart } from "ai"
import { openworkCloudMcpConnectionActionSchema } from "@openwork/types/den/mcp-connection-action"
import { connectionActionPayloadSchema, type ConnectionActionPayload } from "@openwork/types/connection-action-app"
import { parseMcpAppResourceUri } from "@openwork/types/mcp-app"

export type ToolErrorAttribution = {
  label: string
  confidence: "Confirmed" | "Inferred"
  description: string
}

export type ChatToolReconnectAction = {
  credentialKind?: "personal_key";
  connectionId: string
  connectionName: string
  label: string
}

export type ChatToolReconnectProgress =
  | { phase: "opening" }
  | { phase: "authorization_opened"; authorizeUrl: string }
export type ChatToolReconnectResult = "connected"

const OPENWORK_CLOUD_CAPABILITY_TOOLS = new Set([
  "openwork-cloud_search_capabilities",
  "openwork-cloud_execute_capability",
  "openwork-cloud_list_skills",
  "openwork-cloud_get_skill",
  "openwork-cloud_connection_action",
  "openwork_search_capabilities",
  "openwork_execute_capability",
  "openwork_list_skills",
  "openwork_get_skill",
  "openwork_connection_action",
])

/**
 * The tool name an App's own call result is read as. An App built in OpenWork is
 * served by the desktop's private OpenWork Connect host, and each of its tools
 * runs one OpenWork Cloud capability, so its failures carry the same connection
 * cards as execute_capability. Any other App's results stay its own.
 */
export function appToolResultConnectionToolName(app: { serverName: string; resourceUri: string }, toolName: string): string {
  return parseMcpAppResourceUri(app.resourceUri) && app.serverName.startsWith("openwork-app-host-connect-")
    ? "openwork-cloud_execute_capability"
    : toolName
}

export function isConnectionDiscoveryTool(toolName: string): boolean {
  return toolName === "openwork_search_capabilities" || toolName === "openwork-cloud_search_capabilities"
}

const MAX_PARSED_RESULT_LENGTH = 64 * 1_024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseResultRecord(result: unknown): Record<string, unknown> | null {
  if (isRecord(result)) return result
  if (typeof result !== "string") return null
  if (result.length > MAX_PARSED_RESULT_LENGTH) return null

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

const CONNECTION_ACTION_LABELS = {
  connect: "Connect your account",
  reconnect: "Reconnect your account",
  update_credentials: "Update credentials",
  inspect_connection: "Inspect the connection",
  fix_provider: "Fix provider access",
  fix_network: "Fix network access",
  contact_openwork: "Contact OpenWork support",
}

function isConnectionTool(toolName: string): boolean {
  return OPENWORK_CLOUD_CAPABILITY_TOOLS.has(toolName) || /^openwork(?:-cloud)?_run_artifact_[A-Za-z0-9_-]+$/.test(toolName)
}

/**
 * Ordinary discovery (`search_capabilities` without `intent: "connect"`) stays
 * quiet in the transcript. `allowDiscovery` lets a caller that already holds a
 * pending native connection question read the same blocker from such a result.
 */
export type ChatConnectionTargetOptions = { allowDiscovery?: boolean }

function chatConnectionTarget(toolName: string, result: unknown, input?: unknown, options?: ChatConnectionTargetOptions) {
  if (!isConnectionTool(toolName)) return null
  if (isConnectionDiscoveryTool(toolName) && !options?.allowDiscovery && (!isRecord(input) || input.intent !== "connect")) return null
  const parsed = parseResultRecord(result)
  if (!parsed) return null
  const candidates = [
    ...(typeof parsed.connectionId === "string" ? [parsed] : []),
    parsed.connectionAction,
    parsed.connectionStatus,
    ...(Array.isArray(parsed.matches) ? parsed.matches.filter(isRecord).flatMap(match => [match.connectionAction, match.connectionStatus]) : []),
  ].filter(candidate => candidate !== undefined && candidate !== null)
  let target: ConnectionActionPayload | null = null
  let memberOAuth = true
  let authType: unknown
  let credentialMode: unknown
  for (const candidate of candidates) {
    if (!isRecord(candidate)) return null
    if (("source" in candidate && candidate.source !== "openwork-cloud")
      || ("version" in candidate && candidate.version !== 1)
      || ("kind" in candidate && candidate.kind !== "connection_action")) return null
    const legacy = openworkCloudMcpConnectionActionSchema.safeParse(candidate)
    const payload = connectionActionPayloadSchema.safeParse(legacy.success && !("schemaVersion" in candidate)
      ? {
        ...legacy.data,
        schemaVersion: "1",
        message: stringValue(candidate, "message") ?? CONNECTION_ACTION_LABELS[legacy.data.action.type],
        action: {
          ...legacy.data.action,
          label: isRecord(candidate.action) ? stringValue(candidate.action, "label") ?? CONNECTION_ACTION_LABELS[legacy.data.action.type] : CONNECTION_ACTION_LABELS[legacy.data.action.type],
        },
      }
      : candidate)
    if (!payload.success) return null
    if (target && (target.connectionId !== payload.data.connectionId || target.connectionName !== payload.data.connectionName
      || target.state !== payload.data.state || target.actor !== payload.data.actor
      || target.action?.type !== payload.data.action?.type || target.action?.surface !== payload.data.action?.surface)) return null
    target = payload.data
    if ("authType" in candidate) {
      if (authType !== undefined && authType !== candidate.authType) return null
      authType = candidate.authType
    }
    if ("credentialMode" in candidate) {
      if (credentialMode !== undefined && credentialMode !== candidate.credentialMode) return null
      credentialMode = candidate.credentialMode
    }
    if (("authType" in candidate && candidate.authType !== "oauth")
      || ("credentialMode" in candidate && candidate.credentialMode !== "per_member")) memberOAuth = false
  }
  const targetId = target?.connectionId
  if (targetId && Array.isArray(parsed.matches) && parsed.matches.some(match => isRecord(match)
    && typeof match.connectionId === "string" && match.connectionId !== targetId)) return null
  return target ? { connection: target, memberOAuth, memberPersonalKey: authType === "apikey" && credentialMode === "per_member" } : null
}

export function connectionCardPayloadFromChatToolResult(
  toolName: string,
  result: unknown,
  input?: unknown,
  options?: ChatConnectionTargetOptions,
): ConnectionActionPayload | null {
  return chatConnectionTarget(toolName, result, input, options)?.connection ?? null
}

/**
 * The one connection an MCP tool result reports, read from the result itself,
 * its structured content, its metadata, or the JSON in its text parts, with
 * the part it was found in for the card to render.
 */
export function connectionCardFromMcpToolResult(
  toolName: string,
  value: unknown,
  input?: unknown,
): { connection: ConnectionActionPayload; output: unknown } | null {
  const outputs: unknown[] = [value]
  if (isRecord(value)) {
    outputs.push(value.structuredContent, value._meta)
    if (Array.isArray(value.content)) outputs.push(...value.content.filter(isRecord).filter(item => item.type === "text").map(item => item.text))
  }
  const matches = new Map<string, { connection: ConnectionActionPayload; output: unknown }>()
  for (const output of outputs) {
    const connection = connectionCardPayloadFromChatToolResult(toolName, output, input)
    if (connection) matches.set(connection.connectionId, { connection, output })
  }
  return matches.size === 1 ? matches.values().next().value ?? null : null
}

export function reconnectActionFromChatToolResult(
  toolName: string,
  result: unknown,
  input?: unknown,
  options?: ChatConnectionTargetOptions,
): ChatToolReconnectAction | null {
  const target = chatConnectionTarget(toolName, result, input, options)
  if (!target || (!target.memberOAuth && !target.memberPersonalKey)) return null
  const { connection } = target
  if (connection.actor !== "member" || connection.action?.surface !== "openwork_your_connections"
    || !(target.memberPersonalKey
      // A member-held key only ever uses the credential action, never an OAuth connect or reconnect.
      ? connection.action.type === "update_credentials" && (connection.state === "needs_connection" || connection.state === "reauth_required")
      : (connection.state === "needs_connection" && connection.action.type === "connect")
        || (connection.state === "reauth_required" && connection.action.type === "reconnect"))) return null
  return {
    connectionId: connection.connectionId,
    connectionName: connection.connectionName,
    label: target.memberPersonalKey ? connection.state === "reauth_required" ? "Replace key" : "Add key" : connection.state === "needs_connection" ? "Connect" : "Reconnect",
    ...(target.memberPersonalKey ? { credentialKind: "personal_key" } : {}),
  }
}

export function connectionResultFromChatToolPart(part: DynamicToolUIPart, options?: ChatConnectionTargetOptions): unknown {
  if (!isConnectionTool(part.toolName) || (part.state !== "output-error" && part.state !== "output-available")) return undefined
  const raw = part.state === "output-error" ? part.errorText : part.output
  const metadata = part.callProviderMetadata?.openwork
  const preserved = isRecord(metadata) ? [metadata.mcpResult, metadata.mcpApp] : []
  const records = [raw, ...preserved.flatMap(result => isRecord(result) ? [result.structuredContent] : [])]
    .map(parseResultRecord).filter(isRecord)
  const matches: unknown[] = []
  for (const record of records) {
    if ("connectionId" in record || "schemaVersion" in record || record.kind === "connection_action") matches.push({ connectionStatus: record })
    if ("connectionAction" in record) matches.push({ connectionStatus: record.connectionAction })
    if ("connectionStatus" in record) matches.push({ connectionStatus: record.connectionStatus })
    if (Array.isArray(record.matches)) matches.push(...record.matches)
  }
  const combined = { matches }
  return chatConnectionTarget(part.toolName, combined, part.input, options) ? combined : undefined
}

/**
 * The connection a chat tool part reports, if any. Ordinary discovery is
 * excluded unless `allowDiscovery` is set.
 */
export function connectionFromChatToolPart(part: DynamicToolUIPart, options?: ChatConnectionTargetOptions): {
  connection: ConnectionActionPayload
  action: ChatToolReconnectAction | null
} | null {
  const result = connectionResultFromChatToolPart(part, options)
  const connection = connectionCardPayloadFromChatToolResult(part.toolName, result, part.input, options)
  if (!connection) return null
  return { connection, action: reconnectActionFromChatToolResult(part.toolName, result, part.input, options) }
}

export function attributeChatToolError(errorText: string): ToolErrorAttribution | null {
  if (errorText.length > MAX_PARSED_RESULT_LENGTH) return null
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

/** End-user copy; attribution and raw provider payloads belong in details. */
export function describeChatToolFailure(errorText: string): string {
  const attribution = attributeChatToolError(errorText)
  if (attribution?.label === "Blocked by OpenWork") return "This action is blocked by your workspace settings."
  if (/timeout|timed out|deadline|\b504\b/i.test(errorText)) return "The service didn’t respond in time. Check whether the action finished before trying again."
  if (/\b401\b|unauthorized|invalid[_ ]token|authentication required/i.test(errorText)) return "This connection needs attention. Check its sign-in settings."
  if (/\b403\b|forbidden|access[_ ]denied|insufficient[_ ]scope/i.test(errorText)) return "This connection doesn’t have access to the requested action."
  if (/\b50[0234]\b|internal[_ ]server[_ ]error|bad gateway|service unavailable|fetch failed|ECONNRESET|ENOTFOUND/i.test(errorText)) return "The service couldn’t complete this action. Check its status before trying again."
  return "This action couldn’t finish. Check the details before trying again."
}
