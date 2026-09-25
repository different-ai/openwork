import type { AuditCategory } from "@openwork/types/den/audit"

export type AuditCoverageDeclaration = Readonly<{
  status: "implemented_scoped" | "legacy_only" | "uncovered" | "support" | "excluded"
  operationKinds: readonly string[]
  actions: readonly string[]
  categories: readonly AuditCategory[]
  capturePolicy: string
  resources: readonly string[]
  snapshotPolicy: string
  emitter: string | null
  failurePolicy: string
  limitations: string
}>
export type ProviderCoveredRoute = Readonly<{ method: "POST" | "PATCH" | "DELETE"; path: string; step: string }>

export const providerCoveredRoutes: readonly ProviderCoveredRoute[] = [
  { method: "POST", path: "/v1/inference-providers", step: "create" },
  { method: "PATCH", path: "/v1/inference-providers/:inferenceProviderId", step: "update" },
  { method: "DELETE", path: "/v1/inference-providers/:inferenceProviderId", step: "delete" },
  { method: "POST", path: "/v1/inference-providers/:inferenceProviderId/enable-models", step: "models.enable" },
  { method: "POST", path: "/v1/inference-providers/:inferenceProviderId/model-groups", step: "group.create" },
  { method: "PATCH", path: "/v1/inference-providers/:inferenceProviderId/model-groups/:groupId", step: "group.update" },
  { method: "DELETE", path: "/v1/inference-providers/:inferenceProviderId/model-groups/:groupId", step: "group.delete" },
  { method: "POST", path: "/v1/inference-providers/:inferenceProviderId/credential-sets", step: "set.create" },
  { method: "PATCH", path: "/v1/inference-providers/:inferenceProviderId/credential-sets/:credentialSetId", step: "set.update" },
  { method: "DELETE", path: "/v1/inference-providers/:inferenceProviderId/credential-sets/:credentialSetId", step: "set.delete" },
  { method: "POST", path: "/v1/inference-providers/:inferenceProviderId/access-grants", step: "grant.create" },
  { method: "PATCH", path: "/v1/inference-providers/:inferenceProviderId/access-grants/:grantId", step: "grant.update" },
  { method: "DELETE", path: "/v1/inference-providers/:inferenceProviderId/access-grants/:grantId", step: "grant.delete" },
  { method: "DELETE", path: "/v1/inference-providers/:inferenceProviderId/access/:grantId", step: "grant.delete" },
]
export const providerCoveredResources = [
  { type: "provider", action: "provider" },
  { type: "provider_model_universe", action: "provider.universe" },
  { type: "provider_model", action: "provider.model" },
  { type: "provider_model_group", action: "provider.group" },
  { type: "provider_credential_set", action: "provider.credential_set" },
  { type: "provider_credential", action: "provider.credential" },
  { type: "provider_access_grant", action: "provider.access_grant" },
] satisfies Array<{ type: string; action: string }>
export const providerBackgroundSteps = ["catalog.refresh"]
export const providerUncoveredRoutes = [
  "DELETE /v1/inference-providers/:inferenceProviderId/oauth",
  "POST /v1/inference-providers/migrate-from-llm-provider",
]
export const auditReadCoveredRoutes = [
  { method: "GET", path: "/v1/audit/event-types", action: "event_types" },
  { method: "GET", path: "/v1/audit/operations", action: "operations" },
  { method: "GET", path: "/v1/audit/operations/:operationId/events", action: "events" },
  { method: "GET", path: "/v1/audit/usage", action: "usage" },
  { method: "GET", path: "/v1/audit/export", action: "export" },
] satisfies Array<{ method: "GET"; path: string; action: string }>

export const providerCoverage: AuditCoverageDeclaration = {
  status: "implemented_scoped", operationKinds: ["provider.configuration"],
  actions: [
    ...providerCoveredResources.flatMap(({ action }) => ["created", "updated", "deleted"].map((outcome) => `${action}.${outcome}`)),
    ...[...new Set([...providerCoveredRoutes.map(({ step }) => step), ...providerBackgroundSteps])].flatMap((step) => ["committed", "attempted"].map((outcome) => `provider.configuration.${step}.${outcome}`)),
  ],
  categories: ["change", "request", "security", "execution"],
  capturePolicy: "Fresh Enterprise plan or explicit self-hosted installation entitlement AND deployment capture flag AND org opt-in policy AND selected category; organization share lock before snapshot reads, state/policy revision recheck before commit. Generic DB writer semantics are unchanged.",
  resources: [...providerCoveredResources.map(({ type }) => type), "organization", "member", "team"],
  snapshotPolicy: "Per-resource allowlisted before/after and changed fields; secret/configuration changes use markers, never secret values or comparison hashes; oversize rejects.",
  emitter: "src/audit/provider.ts:providerAuditMutation; recordProviderAttempt; src/llm/gateway-matrix.ts:refreshGatewayCatalog",
  failurePolicy: "Required evidence failure rolls back local mutations; failed/denied management attempts recorded outside rollback and capture failures propagate.",
  limitations: "ONLY declared local configuration mutations and catalog refresh. No generic HTTP capture, unauthenticated denial coverage, routine provider reads, member OAuth/token refresh, Google revocation effects, legacy migration or other services. Read-triggered catalog changes are independent system work, not read access. No authoritative operation completion event.",
}
export const auditReadCoverage: AuditCoverageDeclaration = {
  status: "implemented_scoped", operationKinds: ["audit.access"],
  actions: auditReadCoveredRoutes.flatMap(({ action }) => [`audit.${action}.requested`, `audit.${action}.served`]),
  categories: ["access", "read"], capturePolicy: "Admin + visibility gate; fresh Enterprise/installation entitlement AND capture flag AND enabled policy; organization share fence before state/policy, access preferred, read fallback.",
  resources: ["audit_collection", "audit_operation"], snapshotPolicy: "Scope and requested/served outcome only; no content, response body or historical snapshots.",
  emitter: "src/routes/org/audit.ts:serveAudit", failurePolicy: "Durable request intent before read and served event before response release; required capture failure returns 503 without content.",
  limitations: "Only declared audit endpoints; served means response prepared, not human viewed. Authorization/visibility denials occur before capture. Legacy payloads excluded. Visibility does not itself require an enabled capture policy; no continuous drain.",
}
export const pilotPolicyCoverage: AuditCoverageDeclaration = {
  status: "implemented_scoped", operationKinds: ["audit.policy"], actions: ["audit.policy.enabled"], categories: ["lifecycle"],
  capturePolicy: "Explicit operator CLI --apply for a NEW policy only; lifecycle forced; direct initialization independent of traffic flag.",
  resources: ["audit_policy", "organization"], snapshotPolicy: "before=null; allowlisted newly inserted configuration at the current clock, not a historical reconstruction; captureStartedAt assigned by append.",
  emitter: "src/audit/pilot-policy.ts:initializeAuditPilot", failurePolicy: "Organization update lock, state update lock, policy update lock; policy insert and append in one transaction, fail closed.",
  limitations: "No HTTP route, existing policy changes, paid overage, billing, deletion, scheduled cleanup or legacy backfill. Self-reported operator reference does not authenticate a user.",
}

export const auditCaptureCoverage: AuditCoverageDeclaration = {
  status: "implemented_scoped", operationKinds: ["audit.policy"], actions: ["audit.capture.enabled", "audit.capture.disabled"], categories: ["lifecycle"],
  capturePolicy: "Fresh administrator authorization and live role fence; ON requires fresh Enterprise or explicit installation entitlement and capture rollout; OFF remains allowed. Existing operator policy only, expected revision required.",
  resources: ["audit_policy"], snapshotPolicy: "Only captureOn, revision and effectiveAt before/after; fixed immutable control evidence independent of new policy enabled state and lifecycle category selection.",
  emitter: "src/routes/org/audit.ts:updateAuditCapture; den-db/audit-log.ts:setAuditCaptureState",
  failurePolicy: "Organization share fence then live member/team authority, state and policy update locks; required evidence failure rolls back setting. Stale revisions reject; matching no-ops create no operation.",
  limitations: "No capacity, category, entitlement, source or retention changes; no policy initialization, external effects or deletion. Retained history remains readable after capture OFF or plan loss.",
}

export function supportedAuditEventTypes(): string[] {
  return [...new Set([...providerCoverage.actions, ...auditReadCoverage.actions, ...pilotPolicyCoverage.actions, ...auditCaptureCoverage.actions])].sort()
}

function uncovered(limitations: string): AuditCoverageDeclaration {
  return { status: "uncovered", operationKinds: [], actions: [], categories: [], resources: [],
    capturePolicy: "not_implemented", snapshotPolicy: "not_implemented", emitter: null, failurePolicy: "No operation-audit guarantee; existing operational logging remains independent.", limitations }
}
function support(limitations: string): AuditCoverageDeclaration {
  return { ...uncovered(limitations), status: "support" }
}
function legacy(actions: string[], resources: string[]): AuditCoverageDeclaration {
  return { status: "legacy_only", operationKinds: [], actions, categories: [], resources,
    capturePolicy: "Existing legacy emitter only; not operation policy gated.", snapshotPolicy: "Existing legacy payload only; no new safe before/after or operation grouping guarantee.",
    emitter: "src/audit-events.ts:recordOrganizationAuditEvent", failurePolicy: "Existing legacy semantics; not upgraded to atomic operation capture.",
    limitations: "Only selected legacy actions, NOT every route/read/denial in this module. Legacy rows preserved, not backfilled or counted retroactively." }
}

export const orgAuditCoverage: Readonly<Record<string, AuditCoverageDeclaration>> = {
  "api-keys.ts": legacy(["organization.api_key.created", "organization.api_key.deleted"], ["api_key"]),
  "audit.ts": { ...auditReadCoverage, operationKinds: [...auditReadCoverage.operationKinds, ...auditCaptureCoverage.operationKinds], actions: [...auditReadCoverage.actions, ...auditCaptureCoverage.actions], categories: [...auditReadCoverage.categories, ...auditCaptureCoverage.categories], capturePolicy: `${auditReadCoverage.capturePolicy} ${auditCaptureCoverage.capturePolicy}`, snapshotPolicy: `${auditReadCoverage.snapshotPolicy} ${auditCaptureCoverage.snapshotPolicy}`, emitter: `${auditReadCoverage.emitter}; ${auditCaptureCoverage.emitter}`, failurePolicy: `${auditReadCoverage.failurePolicy} ${auditCaptureCoverage.failurePolicy}`, limitations: `${auditReadCoverage.limitations} ${auditCaptureCoverage.limitations}` },
  "billing.ts": uncovered("Organization billing and checkout are not operation-audited; no audit billing product is introduced."),
  "brand-assets.ts": uncovered("Branding uploads and downloads."),
  "codemode-runs.ts": uncovered("Workflow run receipts and reads."),
  "codemode-scripts.ts": uncovered("Workflow authoring, testing, saving and execution."),
  "core.ts": uncovered("Organization settings and lifecycle."),
  "dashboards.ts": uncovered("Dashboard mutations and reads."),
  "declarative.ts": support("Route description/validation helpers; not an event emitter."),
  "delete-organization.ts": uncovered("Organization purge is existing behavior, not pilot retention; this CLI never invokes it."),
  "desktop-policies.ts": uncovered("Desktop policy administration."),
  "egress-diagnostics.ts": uncovered("Egress diagnostic execution."),
  "gateway-usage-limits.ts": uncovered("Gateway limit policy and usage administration."),
  "gateway-usage.ts": uncovered("Gateway usage reads."),
  "gmail-management.ts": uncovered("Gmail operations, including external effects."),
  "google-productivity-management.ts": uncovered("Calendar, Sheets and Drive operations, including external effects."),
  "google-workspace-actions.ts": uncovered("Google Workspace native action dispatch."),
  "google-workspace.ts": uncovered("Google Workspace connections and OAuth lifecycle."),
  "index.ts": support("Router registration and legacy organization proxy; coverage belongs to destination handlers, no proxy audit claim."),
  "inference-providers.ts": providerCoverage,
  "inference.ts": uncovered("Inference management outside the declared provider configuration routes."),
  "install-links.ts": uncovered("Installation link creation and consumption."),
  "invitations.ts": legacy(["organization.invitation.created", "organization.invitation.refreshed", "organization.invitation.canceled"], ["invitation"]),
  "llm-provider-access.ts": support("Legacy LLM provider authorization helpers, not operation capture."),
  "llm-providers.ts": uncovered("Legacy LLM provider management; not the implemented inference-provider emitter."),
  "mcp-connections.ts": uncovered("MCP connection administration and OAuth."),
  "members.ts": legacy(["organization.member.role_updated", "organization.member.ownership_transferred", "organization.member.removed"], ["member"]),
  "microsoft-365.ts": uncovered("Microsoft 365 connections and external operations."),
  "models-analytics.ts": uncovered("Model analytics reads; exports registered outside this module also uncovered."),
  "oauth-providers.ts": uncovered("OAuth provider configuration and authorization lifecycle."),
  "plugin-system/": uncovered("Plugin/marketplace configuration, permissions, versions and imports; nested modules included as uncovered, not covered by provider capture."),
  "remote-mcp-apps.ts": uncovered("Remote MCP App tools/resources."),
  "resources.ts": uncovered("Organization resource reads."),
  "roles.ts": legacy(["organization.role.created", "organization.role.updated", "organization.role.deleted"], ["role"]),
  "scim.ts": legacy(["organization.scim.token_rotated", "organization.scim.connection_deleted", "organization.scim.reconciliation_run", "organization.scim.group_mapping_updated"], ["scim_connection"]),
  "shared.ts": support("Organization authorization and context utilities, not an audit emitter."),
  "sso.ts": legacy(["organization.sso.connection_registered", "organization.sso.connection_enabled", "organization.sso.connection_disabled", "organization.sso.connection_deleted"], ["sso_connection"]),
  "teams.ts": uncovered("Team and membership management."),
  "web-origins.ts": legacy(["organization.web_origin.approved", "organization.web_origin.removed"], ["web_origin"]),
}

export const otherAuditSurfaces: readonly Readonly<{ location: string; surface: "route" | "mcp" | "job" | "service" | "cli"; coverage: AuditCoverageDeclaration }>[] = [
  { location: "ee/apps/den-api/scripts/audit-pilot.ts", surface: "cli", coverage: pilotPolicyCoverage },
  { location: "ee/apps/den-api/src/routes/admin", surface: "route", coverage: { ...uncovered("Some platform-admin actions retain legacy events; remaining actions uncovered, not migrated to operation capture."), status: "legacy_only", emitter: "src/audit-events.ts:buildOrganizationAuditEvent" } },
  ...[
    "auth", "automations", "bootstrap", "cloud", "dev", "me", "telemetry", "version", "webhooks", "workers", "deprecated-memory.ts", "deprecated-skill-hubs.ts",
  ].map((name) => ({ location: `ee/apps/den-api/src/routes/${name}`, surface: "route", coverage: uncovered("No operation-audit implementation for this route surface; existing logging/receipts do not establish coverage.") } satisfies { location: string; surface: "route"; coverage: AuditCoverageDeclaration })),
  { location: "ee/apps/den-api/src/routes/mcp", surface: "mcp", coverage: uncovered("MCP transport, invocation, delegation and observed external effects not captured. A downstream covered provider mutation does not imply MCP invocation coverage.") },
  { location: "ee/apps/den-api/src/mcp", surface: "mcp", coverage: uncovered("Capability search/execution and external MCP tools/apps are not operation-audited.") },
  { location: "ee/apps/den-api/src/workers", surface: "job", coverage: uncovered("Provisioning, GitHub sync/retry/reconciliation and cloud lifecycle jobs; no persisted audit job context or late-result protection.") },
  { location: "ee/apps/den-api/src/automations", surface: "job", coverage: uncovered("Scheduler dispatch, durable runs and completion/reconciliation; receipts are not operation audit events and no audit job-context propagation is implemented.") },
  { location: "ee/apps/den-api/src/models-analytics-export.ts", surface: "route", coverage: uncovered("Analytics exports are not captured by the audit export access emitter.") },
  { location: "ee/apps/den-api/src/llm/gateway-matrix.ts", surface: "job", coverage: { ...providerCoverage, limitations: "Only refreshGatewayCatalog local mutations via catalog.refresh; no general job or runtime token-refresh coverage." } },
  { location: "ee/apps/gateway", surface: "service", coverage: uncovered("Inference gateway requests, streaming outcomes, usage and token refresh outside den-api.") },
  { location: "ee/apps/den-gateway", surface: "service", coverage: uncovered("Worker gateway proxy and access activity outside den-api.") },
  { location: "ee/apps/den-controller", surface: "job", coverage: uncovered("Controller reconciliation and lifecycle work outside den-api.") },
  { location: "ee/apps/den-worker-runtime", surface: "service", coverage: uncovered("Remote runtime execution outside den-api.") },
  { location: "ee/apps/den-web", surface: "service", coverage: uncovered("Web server/proxy/auth/download surfaces; downstream covered APIs only, not blanket web coverage.") },
  { location: "packages/automations", surface: "job", coverage: uncovered("Automation runners and scheduled work; no general operation propagation or completion capture.") },
  { location: "apps/server", surface: "service", coverage: uncovered("Agent server tools, sessions and execution effects outside den-api.") },
]

export const auditExclusions = [
  { location: "ee/apps/den-api/src/app.ts", routes: ["GET /", "GET /health"], reason: "Health/service identity probes, not organization activity." },
  { location: "ee/apps/den-web", routes: ["public static assets", "Next.js static assets"], reason: "Static asset delivery excluded; authenticated downloads and other application routes are NOT excluded." },
] satisfies Array<{ location: string; routes: string[]; reason: string }>

export const auditRolloutStatus = {
  stage: "pilot", comprehensiveCoverage: false, legacyBackfill: false, paidOverage: false,
  billing: "disabled", retention: "preview_only", deletionEnabled: false, scheduledCleanup: false,
  jobContextPropagation: false, drains: "not_configured",
  trafficCaptureFlag: "DEN_AUDIT_CAPTURE_ENABLED", visibilityFlag: "DEN_AUDIT_VISIBILITY_ENABLED", installationEntitlementFlag: "DEN_AUDIT_SELF_HOSTED_ENABLED",
} satisfies Record<string, string | boolean>
