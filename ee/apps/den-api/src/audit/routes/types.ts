// Every registered den-api route and HTTP-reachable better-auth endpoint carries one
// declaration. scripts/check-audit-route-coverage.ts compares these against the live
// app.routes inventory; an undeclared or stale route fails the den-contract job.

export const AUDIT_ROUTE_CLASSES = [
  "tenant_read", "tenant_access", "tenant_change", "tenant_external", "tenant_job", "tenant_signal",
  "domain_provider", "domain_audit", "platform", "excluded_operational", "excluded_high_volume", "proxy", "support", "mcp_consumption",
] as const
export type AuditRouteClass = typeof AUDIT_ROUTE_CLASSES[number]
export type AuditRouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ALL" | "OPTIONS" | "HEAD"
/**
 * org_context / handler / path:<param>: one trusted tenant for the request.
 * user_memberships: platform-class request evidence (platform store) while the
 * named domain emitter (changeEvidence) appends change/security events about
 * the acting or targeted USER into that user's verified active memberships:
 * every membership (account changes, failed sign-ins) or only the membership a
 * session belongs to (session lifecycle, organization switching).
 * none: platform store only.
 */
export type AuditRouteAttribution = "org_context" | "handler" | `path:${string}` | "user_memberships" | "none"

export type AuditRouteDeclaration = Readonly<{
  method: AuditRouteMethod
  /** Exactly as app.routes reports it; better-auth endpoints use "/api/auth" + endpoint path. */
  path: string
  class: AuditRouteClass
  /** Semantic stem `resource.verb`; event types are derived from class + action. */
  action: string
  /** Operation kind grouping this request's events. */
  kind: string
  resource: Readonly<{ type: string; idParam: string | null }>
  attribution: AuditRouteAttribution
  /** Domain emitter adding change-category before/after evidence; absent means request evidence only. */
  changeEvidence?: string
  /** External system reached by a tenant_external route. */
  external?: string
  /** Where the asynchronous outcome of a tenant_job route is recorded, or "not_recorded: <reason>". */
  jobOutcome?: string
  /**
   * Platform GET/HEAD only, and only when the route has no side effect (pure metadata,
   * docs, discovery or session reads): a successful request is then recorded only with
   * the deployment-wide platformAuditReads feature. Every other platform request is always recorded.
   */
  readOnly?: true
  notes?: string
}>

/** Suffixes per class; event type = `${action}.${suffix}`. Classes without audit events return []. */
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

/**
 * Permitted exclusion (1 of 3, with OPERATIONAL_EXCLUSIONS and HIGH_VOLUME_EXCLUSIONS): MCP transport endpoints agents use to call or consume
 * an MCP. Management APIs for MCP connections, credentials, grants and plugins are
 * declared like any other route. Mutations these transports perform without
 * re-entering an HTTP route are audited at the service layer.
 */
export const MCP_CONSUMPTION_EXCLUSIONS: readonly AuditExclusion[] = [
  { method: "ALL", path: "/mcp", reason: "Streamable HTTP MCP transport for desktop agents; tool calls re-enter covered REST routes with origin mcp." },
  { method: "ALL", path: "/mcp/agent", reason: "Agent MCP transport (search_capabilities/execute_capability) for desktop, external OAuth MCP clients and headless runs; direct service mutations are audited at the service layer." },
  { method: "ALL", path: "/mcp/agent/connections/:connectionId", reason: "Per-connection MCP proxy through which agents consume an external MCP server or an authored App's MCP server." },
  { method: "ALL", path: "/mcp/admin", reason: "Platform-admin MCP transport consumed by agents; its org-mutating tools are audited at the service layer." },
  { method: "GET", path: "/mcp/.well-known/oauth-protected-resource", reason: "Static OAuth protected-resource metadata MCP clients fetch to consume /mcp." },
  { method: "GET", path: "/mcp/agent/.well-known/oauth-protected-resource", reason: "Static OAuth protected-resource metadata MCP clients fetch to consume /mcp/agent." },
  { method: "GET", path: "/mcp/admin/.well-known/oauth-protected-resource", reason: "Static OAuth protected-resource metadata MCP clients fetch to consume /mcp/admin." },
]

const OPERATIONAL_REASON = "Liveness/readiness probes and service identity; not organization or user activity; must not depend on the database."

/**
 * Permitted exclusion (2 of 3): the operational probes, declared class
 * excluded_operational and nothing else. Request capture records nothing for them
 * (no tenant or platform audit row, no audit database work).
 */
export const OPERATIONAL_EXCLUSIONS: readonly AuditExclusion[] = [
  { method: "GET", path: "/", reason: OPERATIONAL_REASON },
  { method: "GET", path: "/health", reason: OPERATIONAL_REASON },
  { method: "GET", path: "/ready", reason: OPERATIONAL_REASON },
]

/**
 * Permitted exclusion (3 of 3): organization reads that clients fan out to in
 * bulk, declared class excluded_high_volume and nothing else. Request capture
 * records nothing for them: no intent, no outcome, no audit database work, and
 * audit can never refuse or withhold the response. The content they return is
 * still reachable through audited routes (plugin list/detail, config objects).
 */
export const HIGH_VOLUME_EXCLUSIONS: readonly AuditExclusion[] = [
  { method: "GET", path: "/v1/plugins/:pluginId/resolved", reason: "Not audited (ENG-683). Den web (usePlugins, dashboard activity) and the desktop Connect inventory request it once per plugin, in parallel, on every load and sync: about 90 calls per load for a 90-plugin organization, 15.4k calls from five users in 3.5 hours. Recording an intent and an outcome for each filled the shared PlanetScale transaction pool. Read-only; returns a plugin's active items with their latest config object versions, the same content GET /v1/plugins/:pluginId/config-objects (audited, tenant_access) returns." },
]
