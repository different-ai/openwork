import { z } from "zod"
import { openworkCloudMcpConnectionActionSchema } from "./den/mcp-connection-action.js"

const idSchema = z.string().trim().min(1).max(160)

export const connectionActionAppSchemaVersion = "1" as const
// Persisted conversations may still contain this retired resource; never embed it.
export const legacyConnectionActionAppResourceUri = "ui://openwork/connection-action/v1/view.html"

/**
 * Data contract for the native connection card: one live
 * status report for one Connect connection, including the exact human action
 * (sign in, admin setup, provider fix) that unblocks it. `connected` is the
 * healthy probe result; the other states mirror the gateway's
 * ExternalConnectionStatus steering.
 */
export const connectionActionPayloadSchema = z.object({
  schemaVersion: z.literal(connectionActionAppSchemaVersion),
  connectionId: idSchema,
  connectionName: z.string().trim().min(1).max(255),
  state: z.enum(["connected", "needs_connection", "reauth_required", "provider_error"]),
  actor: z.enum([
    "member",
    "organization_admin",
    "provider_admin",
    "network_admin",
    "openwork",
  ]).nullable(),
  message: z.string().trim().min(1).max(2_000),
  action: z.object({
    type: z.enum([
      "connect",
      "reconnect",
      "update_credentials",
      "inspect_connection",
      "fix_provider",
      "fix_network",
      "contact_openwork",
    ]),
    label: z.string().trim().min(1).max(255),
    surface: z.enum([
      "openwork_your_connections",
      "openwork_organization_connections",
      "provider_admin_console",
      "network_infrastructure",
      "openwork_support",
    ]),
    url: z.string().url().optional(),
  }).nullable(),
})

export type ConnectionActionPayload = z.infer<typeof connectionActionPayloadSchema>

/** Host-owned decision attached to a pending native form and its originating tool. */
export const hostConnectionDecisionSchema = z.object({
  connection: connectionActionPayloadSchema,
  outcome: z.enum(["connected", "skipped"]).optional(),
})
export type HostConnectionDecision = z.infer<typeof hostConnectionDecisionSchema>

const connectionActionLabels = {
  connect: "Connect your account",
  reconnect: "Reconnect your account",
  update_credentials: "Update credentials",
  inspect_connection: "Inspect the connection",
  fix_provider: "Fix provider access",
  fix_network: "Fix network access",
  contact_openwork: "Contact OpenWork support",
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Read structured connection reports, including the engine's JSON error envelope. */
export function connectionResultRecord(value: unknown): Record<string, unknown> | null {
  if (record(value)) return value
  if (typeof value !== "string" || value.length > 64 * 1_024) return null
  const start = value.indexOf("{")
  const end = value.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(value.slice(start, end + 1))
    return record(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** A single verified identity. Conflicting reports and explicit non-member credentials fail closed. */
export function connectionTargetFromResult(result: unknown): {
  connection: ConnectionActionPayload
  memberOAuth: boolean
} | null {
  const parsed = connectionResultRecord(result)
  if (!parsed) return null
  const candidates = [
    ...(typeof parsed.connectionId === "string" ? [parsed] : []),
    parsed.connectionAction,
    parsed.connectionStatus,
    ...(Array.isArray(parsed.matches) ? parsed.matches.filter(record).flatMap(match => [match.connectionAction, match.connectionStatus]) : []),
  ].filter(candidate => candidate !== undefined && candidate !== null)
  let target: ConnectionActionPayload | null = null
  let memberOAuth = true
  let authType: unknown
  let credentialMode: unknown
  for (const candidate of candidates) {
    if (!record(candidate)) return null
    if (("source" in candidate && candidate.source !== "openwork-cloud")
      || ("version" in candidate && candidate.version !== 1)
      || ("kind" in candidate && candidate.kind !== "connection_action")) return null
    const legacy = openworkCloudMcpConnectionActionSchema.safeParse(candidate)
    const payload = connectionActionPayloadSchema.safeParse(legacy.success && !("schemaVersion" in candidate)
      ? {
        ...legacy.data,
        schemaVersion: "1",
        message: typeof candidate.message === "string" && candidate.message.trim() ? candidate.message : connectionActionLabels[legacy.data.action.type],
        action: {
          ...legacy.data.action,
          label: record(candidate.action) && typeof candidate.action.label === "string" && candidate.action.label.trim()
            ? candidate.action.label : connectionActionLabels[legacy.data.action.type],
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
  if (targetId && Array.isArray(parsed.matches) && parsed.matches.some(match => record(match)
    && typeof match.connectionId === "string" && match.connectionId !== targetId)) return null
  return target ? { connection: target, memberOAuth } : null
}

export function isMemberConnectionDecision(connection: ConnectionActionPayload): boolean {
  return connection.actor === "member" && connection.action?.surface === "openwork_your_connections"
    && ((connection.state === "needs_connection" && connection.action.type === "connect")
      || (connection.state === "reauth_required" && connection.action.type === "reconnect"))
}

export const connectionActionAppResourceUri = "ui://openwork/connection-action/v2/view.html"
export const connectionActionIntentSchema = z.object({
  schemaVersion: z.literal("1"),
  kind: z.literal("connection_action_intent"),
  action: z.enum(["authenticate", "skip"]),
  connection: connectionActionPayloadSchema,
})
export type ConnectionActionIntent = z.infer<typeof connectionActionIntentSchema>

export const connectorCatalogSchema = z.object({
  version: z.literal(1),
  selectedIds: z.array(z.string()),
  entries: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string(),
    description: z.string(),
    serviceUrl: z.string().url().optional(),
    setup: z.enum(["oauth", "oauth_client", "api_key", "instant", "suite"]),
    setupUrl: z.string().url(),
  })),
})
export type ConnectorCatalog = z.infer<typeof connectorCatalogSchema>
