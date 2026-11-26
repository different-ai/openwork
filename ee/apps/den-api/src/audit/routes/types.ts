export const AUDIT_ROUTE_CLASSES = [
  "tenant_read", "tenant_access", "tenant_change", "tenant_external", "tenant_job", "tenant_signal",
  "domain_provider", "domain_audit", "platform", "excluded_operational", "excluded_high_volume", "proxy", "support", "mcp_consumption",
] as const
export type AuditRouteClass = typeof AUDIT_ROUTE_CLASSES[number]
export type AuditRouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ALL" | "OPTIONS" | "HEAD"
export type AuditRouteAttribution = "org_context" | "handler" | `path:${string}` | "user_memberships" | "none"

export type AuditRouteDeclaration = Readonly<{
  method: AuditRouteMethod
  path: string
  class: AuditRouteClass
  action: string
  kind: string
  resource: Readonly<{ type: string; idParam: string | null }>
  attribution: AuditRouteAttribution
  changeEvidence?: string
  external?: string
  jobOutcome?: string
  readOnly?: true
  notes?: string
}>

export const AUDIT_ROUTE_EVENT_SUFFIXES: Readonly<Record<AuditRouteClass, readonly string[]>> = {
  tenant_read: ["served", "attempted"],
  tenant_access: ["requested", "served", "attempted"],
  tenant_change: ["requested", "succeeded", "attempted"],
  tenant_external: ["requested", "confirmed", "attempted", "unknown"],
  tenant_job: ["requested", "accepted", "attempted"],
  tenant_signal: ["observed", "attempted"],
  domain_provider: [],
  domain_audit: [],
  platform: ["succeeded", "attempted"],
  excluded_operational: [],
  excluded_high_volume: [],
  proxy: [],
  support: [],
  mcp_consumption: [],
}

export function auditRouteEventTypes(declaration: AuditRouteDeclaration): string[] {
  return AUDIT_ROUTE_EVENT_SUFFIXES[declaration.class].map((suffix) => `${declaration.action}.${suffix}`)
}

export type AuditExclusion = Readonly<{ method: AuditRouteMethod; path: string; reason: string }>

export const MCP_CONSUMPTION_EXCLUSIONS: readonly AuditExclusion[] = [
  { method: "ALL", path: "/mcp", reason: "Streamable HTTP MCP transport for desktop agents; tool calls re-enter covered REST routes with origin mcp." },
  { method: "ALL", path: "/mcp/agent-chat", reason: "Restricted standing-chat transport; tool calls are recorded at the connector service layer." },
  { method: "ALL", path: "/mcp/agent", reason: "Agent MCP transport (search_capabilities/execute_capability) for desktop, external OAuth MCP clients and headless runs; direct service mutations are audited at the service layer." },
  { method: "ALL", path: "/mcp/agent/connections/:connectionId", reason: "Per-connection MCP proxy through which agents consume an external MCP server or an authored App's MCP server." },
  { method: "ALL", path: "/mcp/admin", reason: "Platform-admin MCP transport consumed by agents; its org-mutating tools are audited at the service layer." },
  { method: "ALL", path: "/mcp/public/apps/:appIdOrName", reason: "An App marked public, consumed without sign-in: it serves only the App's current revision and has no tools, so it changes nothing. Marking an App public is an App write through create_app or update_app, audited at the service layer." },
  { method: "GET", path: "/mcp/.well-known/oauth-protected-resource", reason: "Static OAuth protected-resource metadata MCP clients fetch to consume /mcp." },
  { method: "GET", path: "/mcp/agent/.well-known/oauth-protected-resource", reason: "Static OAuth protected-resource metadata MCP clients fetch to consume /mcp/agent." },
  { method: "GET", path: "/mcp/admin/.well-known/oauth-protected-resource", reason: "Static OAuth protected-resource metadata MCP clients fetch to consume /mcp/admin." },
]

const OPERATIONAL_REASON = "Liveness/readiness probes and service identity; not organization or user activity; must not depend on the database."

export const OPERATIONAL_EXCLUSIONS: readonly AuditExclusion[] = [
  { method: "GET", path: "/", reason: OPERATIONAL_REASON },
  { method: "GET", path: "/health", reason: OPERATIONAL_REASON },
  { method: "GET", path: "/ready", reason: OPERATIONAL_REASON },
]

export const HIGH_VOLUME_EXCLUSIONS: readonly AuditExclusion[] = [
  { method: "GET", path: "/v1/plugins/:pluginId/resolved", reason: "Not audited (ENG-683). Den web (usePlugins, dashboard activity) and the desktop Connect inventory request it once per plugin, in parallel, on every load and sync: about 90 calls per load for a 90-plugin organization, 15.4k calls from five users in 3.5 hours. Recording an intent and an outcome for each filled the shared PlanetScale transaction pool. Read-only; returns a plugin's active items with their latest config object versions, the same content GET /v1/plugins/:pluginId/config-objects (audited, tenant_access) returns." },
  { method: "GET", path: "/v1/resolved-plugins", reason: "Not audited, like GET /v1/plugins/:pluginId/resolved, which it batches: Den web and the desktop Connect inventory request every plugin's contents on each load and sync, now up to 100 plugins per call instead of one call per plugin. Read-only; returns the same body per plugin as the single-plugin route, after the same viewer check." },
  { method: "GET", path: "/v1/org/inventory-revision", reason: "Not audited. Every desktop asks for it when the app regains focus and on a timer, before deciding whether to reload its Cloud inventory, so it is the most frequent org read once deployed. Read-only; returns an opaque counter digest and no organization data." },
]
