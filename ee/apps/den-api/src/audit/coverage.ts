import type { AuditCategory } from "@openwork/types/den/audit"
import { ORGANIZATION_AUDIT_ACTIONS } from "../audit-events.js"
import { auditReadCoveredRoutes, providerCoveredRoutes } from "./covered-routes.js"
import { domainChangeEmitters, domainChangeEventTypes } from "./domain/catalog.js"
import { LEGACY_ACTION_BRIDGE } from "./legacy-bridge.js"
import { auditRouteDeclarations, auditRouteEventTypes, MCP_CONSUMPTION_EXCLUSIONS, OPERATIONAL_EXCLUSIONS, type AuditRouteClass } from "./routes/index.js"
import { auditJobOutcomeDeclarations, auditJobOutcomeEventTypes } from "./job-outcomes.js"
import { auditServiceActionDeclarations, auditServiceActionEventTypes } from "./service-actions.js"

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
export type { ProviderCoveredRoute } from "./covered-routes.js"
export { auditReadCoveredRoutes, auditSettingsCoveredRoute, providerCoveredRoutes } from "./covered-routes.js"

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
// Not covered by the provider emitter; declared like other routes and recorded by generic request capture.
export const providerUncoveredRoutes = [
  "DELETE /v1/inference-providers/:inferenceProviderId/oauth",
  "POST /v1/inference-providers/migrate-from-llm-provider",
  // LiteLLM setup, sync and member key connection: request evidence only (routes/integrations.ts).
  "POST /v1/inference-providers/litellm",
  "POST /v1/inference-providers/:inferenceProviderId/litellm/sync",
  "PATCH /v1/inference-providers/:inferenceProviderId/litellm",
  "PUT /v1/inference-providers/:inferenceProviderId/litellm/member-key",
  "POST /v1/inference-providers/oauth/browser-litellm-key",
  "POST /v1/inference-providers/oauth/browser-litellm-check",
]
export const providerCoverage: AuditCoverageDeclaration = {
  status: "implemented_scoped", operationKinds: ["provider.configuration"],
  actions: [
    ...providerCoveredResources.flatMap(({ action }) => ["created", "updated", "deleted"].map((outcome) => `${action}.${outcome}`)),
    ...[...new Set([...providerCoveredRoutes.map(({ step }) => step), ...providerBackgroundSteps])].flatMap((step) => ["committed", "attempted"].map((outcome) => `provider.configuration.${step}.${outcome}`)),
  ],
  categories: ["change", "request", "security", "execution"],
  capturePolicy: "auditLogs feature on for the organization (read fresh) AND (Enterprise plan OR explicit self-hosted installation entitlement) AND default-on deployment capture switch AND enabled stored policy AND selected category; missing policies initialize with temporary server defaults before snapshot reads. Organization share lock before snapshot reads, state/policy revision recheck before commit. Existing OFF stays OFF. Generic DB writer semantics are unchanged.",
  resources: [...providerCoveredResources.map(({ type }) => type), "organization", "member", "team"],
  snapshotPolicy: "Per-resource allowlisted before/after and changed fields; secret/configuration changes use markers, never secret values or comparison hashes; oversize rejects.",
  emitter: "src/audit/provider.ts:providerAuditMutation; recordProviderAttempt; src/llm/gateway-matrix.ts:refreshGatewayCatalog",
  failurePolicy: "Required evidence failure rolls back local mutations (in-transaction appends are not retried). Failed/denied management attempts are recorded outside rollback in their own transaction, up to 3 attempts on transient database errors, then capture failures propagate.",
  limitations: "ONLY declared local configuration mutations and catalog refresh; generic request capture skips these routes (class domain_provider) and records provider reads, OAuth disconnect, migration and LiteLLM routes instead. Unauthenticated denials go to the platform store. No member OAuth/token refresh, Google revocation effects or other services. Read-triggered catalog changes are independent system work, not read access. No authoritative operation completion event.",
}
export const auditReadCoverage: AuditCoverageDeclaration = {
  status: "implemented_scoped", operationKinds: ["audit.access"],
  actions: auditReadCoveredRoutes.flatMap(({ action }) => [`audit.${action}.requested`, `audit.${action}.served`]),
  categories: ["access", "read"], capturePolicy: "Admin + fresh org auditLogs feature + default-on visibility gate; capture also requires fresh Enterprise/installation entitlement AND default-on capture switch AND enabled policy; organization share fence before state/policy, access preferred, read fallback.",
  resources: ["audit_collection", "audit_operation"], snapshotPolicy: "Scope and requested/served outcome only; no content, response body or historical snapshots.",
  emitter: "src/routes/org/audit.ts:serveAudit", failurePolicy: "Durable request intent before read and served event before response release, each up to 3 attempts on transient database errors (idempotent replay by request id), then required capture failure returns 503 without content.",
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
  capturePolicy: "Fresh org auditLogs feature, visibility, administrator authorization and live role fence; ON requires fresh Enterprise or explicit installation entitlement and capture rollout; OFF remains allowed after entitlement loss while flagged. Missing ready policy initializes with server defaults; expected revision zero accepted only by its initializer, with explicit OFF applied atomically.",
  resources: ["audit_policy"], snapshotPolicy: "Only captureOn, revision and effectiveAt before/after; fixed immutable control evidence independent of new policy enabled state and lifecycle category selection.",
  emitter: "src/routes/org/audit.ts:updateAuditCapture; den-db/audit-log.ts:setAuditCaptureState",
  failurePolicy: "Organization share fence then live member/team authority, state and policy update locks; required evidence failure rolls back setting. Stale revisions reject; matching no-ops create no operation.",
  limitations: "No caller-supplied capacity, category, entitlement, source or retention changes; no external effects or deletion. Retained history remains readable after capture OFF or plan loss.",
}

export const defaultPolicyCoverage: AuditCoverageDeclaration = {
  status: "implemented_scoped", operationKinds: ["audit.policy"], actions: ["audit.policy.initialized"], categories: ["lifecycle"],
  capturePolicy: "Fresh locked literal org flag AND Enterprise/explicit self-hosted entitlement AND deployment capture availability. Lazy creation before capture snapshots, also on GET usage and first settings PATCH. Existing policies never updated by initialization.",
  resources: ["audit_policy", "organization"], snapshotPolicy: "before=null; allowlisted server defaults only, honest system actor den-api.audit-defaults; first event sets captureStartedAt.",
  emitter: "src/audit/capture.ts:initializeAuditPolicyInTx", failurePolicy: "Organization share fence then unique state INSERT/update lock then policy update lock; re-read concurrent winner. Policy, state and lifecycle evidence commit atomically or roll back.",
  limitations: "Temporary 6,000,000 retained OPERATIONS, not events; 300-second grouping; PILOT_DEFAULT_CATEGORIES; cloud/delete_oldest or operator/keep_all declarations grant no entitlement. No enforced cap, billing, cleanup, deletion, legacy backfill or forced restore on upgrade.",
}

const tenantRouteClasses: readonly AuditRouteClass[] = ["tenant_read", "tenant_access", "tenant_change", "tenant_external", "tenant_job", "tenant_signal"]
const tenantRouteDeclarations = auditRouteDeclarations.filter((declaration) => tenantRouteClasses.includes(declaration.class))
/** Tenant-visible request event types derived from route declarations (platform store events are not tenant-visible). */
export const routeAuditEventTypes: readonly string[] = [...new Set(tenantRouteDeclarations.flatMap(auditRouteEventTypes))].sort()

export function supportedAuditEventTypes(): string[] {
  return [...new Set([
    ...providerCoverage.actions, ...auditReadCoverage.actions, ...pilotPolicyCoverage.actions, ...auditCaptureCoverage.actions, ...defaultPolicyCoverage.actions,
    ...routeAuditEventTypes, ...domainChangeEventTypes, ...auditServiceActionEventTypes(), ...auditJobOutcomeEventTypes,
  ])].sort()
}

export const genericRequestCoverage: AuditCoverageDeclaration = {
  status: "implemented_scoped",
  operationKinds: [...new Set(tenantRouteDeclarations.map(({ kind }) => kind))].sort(),
  actions: routeAuditEventTypes,
  categories: ["read", "access", "request", "execution", "security"],
  capturePolicy: "Every den-api route and HTTP-reachable better-auth endpoint carries a declaration (src/audit/routes, enforced by scripts/check-audit-route-coverage.ts). Tenant classes record only when the trusted organization has the auditLogs feature on (features registry, src/features.ts; never organization metadata), deployment capture is on, a fresh enabled policy exists (lazy default allowed) and the class category is selected: read=read (off by default), access=access, change/external=request, job=execution; 401/403 use security when selected. With DEN_AUDIT_CAPTURE_ENABLED=false nothing is read. Organization-context routes reuse the features getOrganizationContextForUser reads in the same request (in parallel with the membership query; no audit query). Every other tenant path resolves the verified organization's feature itself with one fresh organizationFeatureEnabled read, only after the deployment capture switch passes: handler/token routes (worker heartbeat and compatibility tokens, runner routes, SCIM, Slack webhooks and install callback, install links and connect grants, workbot, brand-asset downloads, device-code decisions, bootstrap credentials, invitation acceptance, member OAuth entries/callbacks, Stripe/GitHub webhooks), useUserOrganizations routes (the active organization, once), platform-admin path routes (plus an existence check when the feature is on), MCP service actions and job outcomes; callers never pass the flag. User fan-out reads every membership organization's features in one batched read. The better-auth hooks check the candidate organization's feature first and only look up the member or verify the SCIM token when it is on. Appends recheck the feature fresh under the organization share lock (readAuditAvailability).",
  resources: [...new Set(tenantRouteDeclarations.map(({ resource }) => resource.type))].sort(),
  snapshotPolicy: "Request evidence only: declared resource type, validated path-parameter id (else unparseable) or collection:<type>, parent organization, method, route template and status. Never bodies, query strings, headers, IPs or secrets. Before/after snapshots come only from named domain emitters (changeEvidence) through appendAuditChanges inside the business transaction.",
  emitter: "src/audit/request-capture.ts:auditRequestMiddleware, beginAuditRequest, attributeAuditRequest, appendAuditChanges; src/audit/service-capture.ts:runAuditedServiceAction",
  failurePolicy: "Every standalone append (intent, served, outcome, platform row) is its own transaction, re-run up to 3 attempts on transient database errors (deadlock and lock wait timeout always; connection loss only when replay is idempotent: request-bound operation plus idempotency key, or a pre-generated platform row id), then: access/change/external/job: durable .requested intent before the handler or 503 audit_unavailable without running it (a failed attribution lookup also refuses). read: no intent; a capture-start or attribution-lookup failure serves the request without capture (never 503 at start); once capture started, the served event is appended before release or the response is replaced by a 503 without content. access: served event before release or 503 without content. signal (heartbeats, polls, ingestion, worker runtime pass-through): no intent, one .observed/.attempted outcome in the read category, never fail-closed (start or outcome failure is logged, [audit-outcome-lost] for outcomes). change/external/job outcome loss keeps the response and logs [audit-outcome-lost]. The outcome event (request, service action or job) also sets the operation's outcome projection (succeeded; failed for failed/denied; unknown) in the same transaction. 503 replacements keep CORS and other non-content headers. Requests without trustworthy tenant attribution are written to platform_audit_event before the response is released (a failed insert never fails the request and logs [platform-audit-lost]).",
  limitations: "Request evidence describes the HTTP attempt and its status, not every downstream effect; external outcomes on 5xx are recorded as unknown. Asynchronous job outcomes only where a declaration names jobOutcome. Preclaim-scope 403s are recorded in the platform store against the endpoint they refused; unmatched 404s are request-access-log only.",
}

/** Background job outcomes (src/audit/job-outcomes.ts) recorded by src/audit/job-capture.ts:recordAuditJobOutcome. */
function jobOutcomes(eventTypes: readonly string[], limitations: string): AuditCoverageDeclaration {
  const declarations = auditJobOutcomeDeclarations.filter((declaration) => eventTypes.includes(declaration.eventType))
  return {
    status: "implemented_scoped", operationKinds: [...new Set(declarations.map(({ kind }) => kind))].sort(), actions: declarations.map(({ eventType }) => eventType), categories: ["execution"],
    capturePolicy: "The organization's auditLogs feature (one fresh read after the deployment capture switch), deployment capture switch, enabled policy (lazy default allowed) and the execution category. One job operation per job row (jobRunId = row id, requestId null) shared by its start and terminal outcome.",
    resources: [...new Set(declarations.flatMap(({ target, parents }) => [target, ...parents]))].sort(),
    snapshotPolicy: "Status, reason code and counts only; never job input, output, prompts, repository content or error messages.",
    emitter: [...new Set(declarations.flatMap(({ emitters }) => emitters))].join("; "),
    failurePolicy: "Own transaction after the job's state change with entitlement recheck and policy-current fence, up to 3 attempts on transient database errors (job operation plus idempotency key make a replay idempotent), then failure never affects the job and logs [audit-outcome-lost]. Recorded only by the caller that made the terminal transition; idempotency keys deduplicate within the attachment window.",
    limitations,
  }
}

function uncovered(limitations: string): AuditCoverageDeclaration {
  return { status: "uncovered", operationKinds: [], actions: [], categories: [], resources: [],
    capturePolicy: "not_implemented", snapshotPolicy: "not_implemented", emitter: null, failurePolicy: "No operation-audit guarantee; existing operational logging remains independent.", limitations }
}
function support(limitations: string): AuditCoverageDeclaration {
  return { ...uncovered(limitations), status: "support" }
}
function routes(limitations: string): AuditCoverageDeclaration {
  return { ...genericRequestCoverage, limitations: `${limitations} ${genericRequestCoverage.limitations}` }
}
function bridged(legacyActions: string[], resources: string[], extraActions: string[] = []): AuditCoverageDeclaration {
  const actions = [...legacyActions.map((action) => LEGACY_ACTION_BRIDGE[legacyActionKey(action)]), ...extraActions]
  const emitters = [...new Set(actions.map((action) => domainChangeEmitters[action]).filter((emitter): emitter is string => Boolean(emitter)))].map((emitter) => `src/${emitter}`)
  return { ...genericRequestCoverage, actions: [...genericRequestCoverage.actions, ...actions], categories: [...genericRequestCoverage.categories, "change"], resources: [...genericRequestCoverage.resources, ...resources],
    capturePolicy: `${genericRequestCoverage.capturePolicy} Change snapshots additionally require the change category (auditChangeCapture / currentAuditChangeCapture non-null).`,
    snapshotPolicy: "Allowlisted per-resource before/after and changedFields (create: before null; delete: after null; no-op: no event). Secrets, tokens, credential/configuration material and secret-derived hashes are never stored; their changes are opaque markers (credentialMaterial, configuration). Free-text admin reasons only as reasonProvided.",
    emitter: `${genericRequestCoverage.emitter}; ${emitters.join(", ")} via src/audit/domain/legacy.ts (LEGACY_ACTION_BRIDGE: ${legacyActions.join(", ")})`,
    failurePolicy: `${genericRequestCoverage.failurePolicy} Single writer: with change capture active the change events are appended inside the business transaction (organization lock first, then business rows, then audit; evidence failure rolls the mutation back) and the legacy audit_event row is not written; otherwise the unchanged legacy row is written. Writes performed by better-auth (createApiKey, generateSCIMToken, registerSSOProvider) and multi-step repairs append the after-snapshot in a fresh transaction and log [audit-outcome-lost] on failure. [audit-alert] is emitted once per action either way.`,
    limitations: "Historical legacy rows are preserved, never backfilled, returned or counted. Implicit API-key revocation is recorded as api_key.revoked (revocation itself is never rolled back for audit failure). Role renames rewrite member/invitation role strings without per-member events (described by role.updated)." }
}
function legacyActionKey(action: string): keyof typeof LEGACY_ACTION_BRIDGE {
  const key = Object.values(ORGANIZATION_AUDIT_ACTIONS).find((value) => value === action)
  if (!key) throw new Error(`unknown legacy audit action ${action}`)
  return key
}

export const orgAuditCoverage: Readonly<Record<string, AuditCoverageDeclaration>> = {
  "api-keys.ts": bridged(["organization.api_key.created", "organization.api_key.deleted"], ["api_key"], ["api_key.revoked"]),
  "audit.ts": { ...auditReadCoverage, operationKinds: [...auditReadCoverage.operationKinds, ...auditCaptureCoverage.operationKinds], actions: [...auditReadCoverage.actions, ...auditCaptureCoverage.actions], categories: [...auditReadCoverage.categories, ...auditCaptureCoverage.categories], capturePolicy: `${auditReadCoverage.capturePolicy} ${auditCaptureCoverage.capturePolicy}`, snapshotPolicy: `${auditReadCoverage.snapshotPolicy} ${auditCaptureCoverage.snapshotPolicy}`, emitter: `${auditReadCoverage.emitter}; ${auditCaptureCoverage.emitter}`, failurePolicy: `${auditReadCoverage.failurePolicy} ${auditCaptureCoverage.failurePolicy}`, limitations: `${auditReadCoverage.limitations} ${auditCaptureCoverage.limitations}` },
  "billing.ts": routes("Organization billing and checkout are not operation-audited; no audit billing product is introduced."),
  "brand-assets.ts": routes("Branding uploads and downloads."),
  "codemode-scripts.ts": routes("Workflow authoring, testing, saving and execution."),
  "core.ts": routes("Organization settings and lifecycle."),
  "dashboards.ts": routes("Dashboard mutations and reads."),
  "declarative.ts": support("Route description/validation helpers; not an event emitter."),
  "delete-organization.ts": routes("Organization purge is existing behavior, not pilot retention; it deletes the organization's audit tables in one transaction."),
  "desktop-policies.ts": routes("Desktop policy administration."),
  "egress-diagnostics.ts": routes("Egress diagnostic execution."),
  "gateway-usage-limits.ts": routes("Gateway limit policy and usage administration."),
  "gateway-usage.ts": routes("Gateway usage reads."),
  "gmail-management.ts": routes("Gmail operations, including external effects."),
  "google-productivity-management.ts": routes("Calendar, Sheets and Drive operations, including external effects."),
  "google-workspace-actions.ts": routes("Google Workspace native action dispatch."),
  "google-workspace.ts": routes("Google Workspace connections and OAuth lifecycle."),
  "index.ts": support("Router registration and legacy organization proxy; coverage belongs to destination handlers, no proxy audit claim."),
  "inference-providers.ts": providerCoverage,
  "inference.ts": routes("Inference management outside the provider-emitter routes."),
  "install-links.ts": routes("Installation link creation and consumption."),
  "invitations.ts": bridged(["organization.invitation.created", "organization.invitation.refreshed", "organization.invitation.canceled"], ["invitation", "member", "api_key"], ["member.removed", "api_key.revoked"]),
  "llm-provider-access.ts": support("Legacy LLM provider authorization helpers, not operation capture."),
  "llm-providers.ts": routes("Legacy LLM provider management; not the inference-provider emitter."),
  "mcp-app-catalog.ts": routes("Reads of the Apps built in OpenWork an admin can add to a dashboard."),
  "mcp-connections.ts": routes("MCP connection administration and OAuth."),
  "members.ts": bridged(["organization.member.role_updated", "organization.member.ownership_transferred", "organization.member.removed"], ["member", "api_key"], ["api_key.revoked"]),
  "microsoft-365.ts": routes("Microsoft 365 connections and external operations."),
  "models-analytics.ts": routes("Model analytics reads and exports."),
  "oauth-providers.ts": routes("OAuth provider configuration and authorization lifecycle."),
  "plugin-system/": routes("Plugin/marketplace configuration, permissions, versions and imports, including nested modules."),
  "resources.ts": routes("Organization resource reads."),
  "roles.ts": bridged(["organization.role.created", "organization.role.updated", "organization.role.deleted"], ["role", "api_key"], ["api_key.revoked"]),
  "scim.ts": bridged(["organization.scim.token_rotated", "organization.scim.connection_deleted", "organization.scim.reconciliation_run", "organization.scim.group_mapping_updated"], ["scim_connection"]),
  "shared.ts": support("Organization authorization and context utilities, not an audit emitter."),
  "slack.ts": routes("Member-scoped read-only Slack search and thread excerpts: sensitive-access request evidence only; no search queries, message content, response bodies or token lifecycle snapshots."),
  "sso.ts": bridged(["organization.sso.connection_registered", "organization.sso.connection_enabled", "organization.sso.connection_disabled", "organization.sso.connection_deleted"], ["sso_connection"]),
  "teams.ts": routes("Team and membership management."),
  "web-origins.ts": bridged(["organization.web_origin.approved", "organization.web_origin.removed"], ["web_origin"]),
}

function boundary(limitations: string): AuditCoverageDeclaration {
  return { ...uncovered(limitations), status: "excluded", failurePolicy: "Not an org operation-audit surface; see limitations for where its effects are recorded." }
}

export const otherAuditSurfaces: readonly Readonly<{ location: string; surface: "route" | "mcp" | "job" | "service" | "cli"; coverage: AuditCoverageDeclaration }>[] = [
  { location: "ee/apps/den-api/src/audit/capture.ts", surface: "service", coverage: defaultPolicyCoverage },
  { location: "ee/apps/den-api/scripts/audit-pilot.ts", surface: "cli", coverage: pilotPolicyCoverage },
  { location: "ee/apps/den-api/src/routes/admin", surface: "route", coverage: { ...genericRequestCoverage, limitations: "Organization-targeted admin routes declare path:<organizationId> attribution: actor is the platform admin user (no memberId), origin platform_admin, tenant is the validated target organization; other admin routes record to the platform store. DPA and complimentary-access changes use the single-writer legacy bridge (src/audit/domain/organization-settings.ts via writeLegacyOrChangesInTx): change event or legacy row inside the existing organization-locked transaction; free-text reasons are recorded only as reasonProvided." } },
  ...[
    "auth", "automations", "bootstrap", "cloud", "dev", "email", "me", "mcp", "version", "webhooks", "workers", "deprecated-memory.ts", "deprecated-skill-hubs.ts",
  ].map((name) => ({ location: `ee/apps/den-api/src/routes/${name}`, surface: "route", coverage: routes("Declared per route in src/audit/routes; token, webhook and runner routes attribute their tenant in the handler after verification (attributeAuditRequest), otherwise they record to the platform store.") } satisfies { location: string; surface: "route"; coverage: AuditCoverageDeclaration })),
  { location: "ee/apps/den-api/src/mcp", surface: "mcp", coverage: { ...genericRequestCoverage, status: "implemented_scoped", emitter: "src/audit/service-capture.ts:runAuditedServiceAction via src/audit/mcp-service-audit.ts (declarations: src/audit/service-actions.ts)",
    operationKinds: [...new Set(auditServiceActionDeclarations.map(({ kind }) => kind))].sort(), actions: auditServiceActionEventTypes(),
    resources: [...new Set(auditServiceActionDeclarations.map(({ resource }) => resource.type))].sort(),
    limitations: `MCP consumption transport is the only MCP exclusion (${MCP_CONSUMPTION_EXCLUSIONS.map(({ method, path }) => `${method} ${path}`).join(", ")}). Tool calls re-entering den-api through invokeMcpOperation are recorded at the destination route with origin mcp. Direct service mutations (create/update skill and app, artifact view save/activate/retire, workflow run records, remote-session create/send/stop, admin plan/capability tools) use runAuditedServiceAction; external MCP tool side effects are not observed.` } },
  { location: "ee/apps/den-api/src/workers", surface: "job", coverage: jobOutcomes(["connector_sync.completed"], "GitHub connector sync events record connector_sync.completed when terminal. Worker provisioning, cloud lifecycle (wake, idle stop, recovery) and the provisioning reconciler record no outcome: their terminal worker status is written by several independent paths (continueCloudProvisioning success/failure, reconciler markFailed, lifecycle markWorkerFailed, worker-access recovery) and is visible on the worker row only. No persisted initiating audit event id.") },
  { location: "ee/apps/den-api/src/automations", surface: "job", coverage: jobOutcomes(["automation_run.started", "automation_run.completed"], "Scheduler-created runs record automation_run.started; every run records exactly one automation_run.completed whichever executor made the terminal transition. Run output, prompts and results are never recorded. The initiating request event id is not persisted on automation_run (no causedByEventId link).") },
  { location: "ee/apps/den-api/src/llm/gateway-matrix.ts", surface: "job", coverage: { ...providerCoverage, limitations: "Only refreshGatewayCatalog local mutations via catalog.refresh; no general job or runtime token-refresh coverage." } },
  { location: "ee/apps/gateway", surface: "service", coverage: boundary("Inference gateway is a separate high-volume data plane with its own request logs and usage ledgers; not org operation audit.") },
  { location: "ee/apps/den-gateway", surface: "service", coverage: boundary("Worker gateway proxy: /api/den traffic is recorded at the den-api destination route; worker-instance traffic is runtime consumption.") },
  { location: "ee/apps/den-worker-runtime", surface: "service", coverage: boundary("Launches apps/server inside cloud workers; local single-user server with its own JSONL audit. Org effects reach den-api routes or /mcp/agent and are recorded there.") },
  { location: "ee/apps/den-web", surface: "service", coverage: boundary("Next.js route handlers proxy to den-api; the destination den-api route records. clear-session-cookie changes no server state; health/ready/runtime-config are operational.") },
  { location: "packages/automations", surface: "job", coverage: boundary("Automation runner library; its den-api calls are recorded at destination routes.") },
  { location: "apps/server", surface: "service", coverage: boundary("Local single-user OpenWork server with its own JSONL audit (apps/server/src/audit.ts); org effects go through den-api routes or /mcp/agent.") },
]

export type UserScopedAuditEvent = Readonly<{
  eventType: string
  category: AuditCategory
  organizations: "session organization" | "session organization, else every active membership" | "affected organization or session organization, else every active membership" | "destination organization" | "every active membership"
  actor: string
  chokepoints: string
  evidence: string
}>

/**
 * Events about a user (attribution user_memberships): request evidence of the
 * endpoint stays in the platform store; these are appended by
 * src/audit/fanout.ts:recordAuditForUserMemberships into the user's verified
 * active memberships, one operation per organization sharing the request id.
 */
export const userScopedAuditEvents: readonly UserScopedAuditEvent[] = [
  { eventType: "session.created", category: "change", organizations: "session organization, else every active membership", actor: "the session user + member id", chokepoints: "src/auth.ts databaseHooks.session.create.after (password, email OTP, social, SSO, device, sign-up auto sign-in, verify-email auto sign-in)", evidence: "after: method (password | email_otp | social:<providerId> | sso | device | other), expiresAt. Target session id (never the token), related member, parent organization. No IP or user agent. A session without an active organization (a member of several organizations) can act in all of them, so it fans out to every organization where the user is an active member (own operation each)." },
  { eventType: "session.handed_off", category: "change", organizations: "session organization, else every active membership", actor: "the session user + member id", chokepoints: "src/routes/auth/desktop-handoff.ts exchange (POST /v1/auth/desktop-handoff/exchange)", evidence: "after: method desktop_handoff, expiresAt. The desktop receives the EXISTING web session (same session id), so no second session.created is recorded. Never the grant or session token." },
  { eventType: "desktop_handoff.created", category: "change", organizations: "session organization, else every active membership", actor: "the session user + member id", chokepoints: "src/routes/auth/desktop-handoff.ts create (POST /v1/auth/desktop-handoff), after the request is attributed to the session's organization", evidence: "after: expiresAt, returnUrlApproved. Target the handed-over session id; the grant (a bearer secret) is never recorded." },
  { eventType: "session.revoked", category: "change", organizations: "affected organization or session organization, else every active membership", actor: "the session owner + member id; for direct revocations the request actor (change capture of the same organization) or system den-api.credential-revocation; platform admin for admin user deletion", chokepoints: "src/auth.ts databaseHooks.session.delete.after (fires per row, also for bulk deletes: sign-out, revoke-session, revoke-sessions, revoke-other-sessions, change-password, reset-password revocation, oauth2/end-session); Den direct deletes: src/credential-revocation.ts revokeMembershipSessionCredentials (member removal incl. SCIM deprovision and organization/leave, role change, role permission change, ownership transfer) → recordOrganizationSessionsRevoked; src/session.ts revokeBearerSession (desktop bearer sign-out); src/routes/admin/index.ts DELETE /v1/admin/users/:userId; src/workspace-preclaim.ts setup-agent cleanup", evidence: "before: expiresAt; reasonCode sign_out | session_revoked | all_sessions_revoked | other_sessions_revoked | password_changed | password_reset | end_session | saml_logout | member_removed | role_changed | role_permissions_changed | ownership_transferred | admin_user_deleted | bootstrap_credentials_revoked | other. Expired rows are skipped. Direct deletes fire no better-auth hook, and both paths share the idempotency key <requestId>:session.revoked:<sessionId>, so a row is never recorded twice in one request operation. Direct-delete events are appended after the delete committed (revocation never waits on or rolls back for audit; loss logs [audit-outcome-lost]). SCIM global user deletion (src/user-deletion.ts) finds no live sessions: the preceding member removal already revoked them." },
  { eventType: "session.organization_entered", category: "change", organizations: "destination organization", actor: "the session user + member id", chokepoints: "POST /v1/me/active-organization handler; better-auth organization/set-active and organization/set-active-team hooks.after", evidence: "after: via active_organization | active_team (+ teamId). The previous organization is never recorded; unchanged organization/team records nothing. Automatic active-organization repair is not recorded." },
  { eventType: "session.sign_in_failed", category: "security", organizations: "every active membership", actor: "unknown (id null)", chokepoints: "hooks.after (detached) on sign-in/email, sign-in/email-otp, email-otp/check-verification-otp, reset-password, email-otp/reset-password", evidence: "Target user, related member; after: method; outcome denied | failed with reasonCode from the better-auth error code (invalid_credentials, email_not_verified, invalid_otp, otp_expired, too_many_attempts, validation_failed…). Only for an existing account; the submitted email, password or OTP (or a hash) is never stored and the response status, body and timing are unchanged. Trade-off: anyone who guesses a member's email can generate these events; there is no rate limit." },
  { eventType: "account.profile_updated", category: "change", organizations: "every active membership", actor: "the user + member id", chokepoints: "src/auth.ts databaseHooks.user.update.before/after (update-user, IdP profile sync); PATCH /v1/me/profile handler", evidence: "name before/after; image as a changed marker only." },
  { eventType: "account.email_changed", category: "change", organizations: "every active membership", actor: "the user + member id", chokepoints: "src/auth.ts databaseHooks.user.update.before/after (change-email, verify-email change link, email-otp change-email)", evidence: "changed marker only (never the addresses)." },
  { eventType: "account.password_changed", category: "change", organizations: "every active membership", actor: "the user + member id", chokepoints: "hooks.after on change-password, reset-password (account from the token, looked up before the endpoint), email-otp reset-password", evidence: "after: method (change_password | reset_password | email_otp_reset); password marker; never values or hashes." },
  { eventType: "account.identity_linked", category: "change", organizations: "every active membership", actor: "the user + member id", chokepoints: "src/auth.ts databaseHooks.account.create.after (link-social callback, implicit linking at social/SSO sign-in, first credential account at password reset)", evidence: "after: providerId, method. Never provider account ids or tokens." },
  { eventType: "account.identity_unlinked", category: "change", organizations: "every active membership", actor: "the user + member id", chokepoints: "src/auth.ts databaseHooks.account.delete.after (unlink-account)", evidence: "before: providerId." },
  { eventType: "account.deleted", category: "change", organizations: "every active membership", actor: "the user + member id", chokepoints: "src/auth.ts databaseHooks.user.delete.before (delete-user; disabled in Den, user.deleteUser not enabled)", evidence: "before: userId. Admin deletion (DELETE /v1/admin/users/:userId) records member.removed per organization instead." },
  { eventType: "account.provider_token.accessed", category: "access", organizations: "every active membership", actor: "the user + member id", chokepoints: "hooks.after on get-access-token, refresh-token", evidence: "Related auth_provider (providerId); reasonCode read | refreshed, or denied/failed outcome. Never the token." },
]

export type OrganizationBoundAuthEvent = Readonly<{ eventType: string; category: AuditCategory; organization: string; actor: string; chokepoints: string; evidence: string }>

/**
 * Auth endpoints attributed to the organization the request itself proves
 * (src/audit/better-auth.ts, src/routes/auth/*); request evidence is the
 * declared tenant_change/tenant_read outcome, plus these domain events.
 */
export const organizationBoundAuthEvents: readonly OrganizationBoundAuthEvent[] = [
  { eventType: "oauth_token.issued", category: "change", organization: "MCP consent referenceId (the access token's org claim), after the user's active membership there is verified", actor: "the token's user + member id", chokepoints: "POST /api/auth/oauth2/token (authorization_code, refresh_token): access-token claims extension notes the issuance; hooks.after attributes (phase after) and appends", evidence: "after: clientId, scopes, grantType, resource; target the MCP grant (oauth_consent) or the client. Never token values, authorization codes, client secrets or hashes. Tokens without an organization (non-MCP OIDC) stay platform evidence." },
  { eventType: "oauth_token.revoked", category: "change", organization: "the revoked token row's referenceId, membership verified", actor: "the token's user + member id", chokepoints: "POST /api/auth/oauth2/revoke: hooks.before looks the stored refresh/opaque access token up by its storage hash (nothing kept); hooks.after attributes (phase after) and appends on success", evidence: "before: tokenType, clientId, scopes. JWT access tokens are stateless and not looked up (platform evidence)." },
  { eventType: "invitation.rejected", category: "change", organization: "the invitation's organization", actor: "the invitee user (no member id)", chokepoints: "POST /api/auth/organization/reject-invitation: hooks.before verifies the pending invitation and the session email = invitation email, attributes (intent before); hooks.after appends on success", evidence: "status pending → rejected only; never the email or join token." },
  { eventType: "<action>.attempted (raw_endpoint_refused)", category: "security", organization: "body organizationId, else the session's active organization, only when the session user is an active member there", actor: "the session user + member id", chokepoints: "hooks.before getRawBetterAuthMutationDenial (23 raw organization/api-key/sso endpoints) and the Den-shadowed POST /api/auth/scim/generate-token, /api/auth/scim/delete-provider-connection", evidence: "Request evidence only: outcome denied, reasonCode raw_endpoint_refused (category request when security is not selected). No .requested intent (attribution refusal), so audit never changes the 403; a foreign or unflagged organization records nothing there (platform evidence)." },
  { eventType: "oauth.authorize.succeeded / auth.oauth.authorize.post.succeeded", category: "request", organization: "postLogin.consentReferenceId (the session's active organization), membership verified", actor: "the session user + member id", chokepoints: "GET (Den route) and POST /api/auth/oauth2/authorize: hooks.after, phase after", evidence: "Request evidence only; the authorization code is never recorded." },
  { eventType: "invitation.preview.served", category: "read", organization: "the invitation's organization (the token proves it)", actor: "unknown", chokepoints: "GET /v1/orgs/invitations/preview handler after the invitation is found", evidence: "Request evidence only (category read, off by default); the token is never recorded." },
]

/** The only permitted exclusions: MCP consumption transport and the operational probes (src/audit/routes/types.ts). */
export const auditExclusions = [
  ...MCP_CONSUMPTION_EXCLUSIONS.map(({ method, path, reason }) => ({ location: "ee/apps/den-api/src/mcp", routes: [`${method} ${path}`], reason })),
  ...OPERATIONAL_EXCLUSIONS.map(({ method, path, reason }) => ({ location: "ee/apps/den-api/src/app.ts", routes: [`${method} ${path}`], reason })),
] satisfies Array<{ location: string; routes: string[]; reason: string }>

export const auditRolloutStatus = {
  stage: "pilot", comprehensiveCoverage: true,
  coverageScope: "Every den-api route and HTTP-reachable better-auth endpoint is declared and checked in CI; only MCP consumption transport and the operational probes (GET /, /health, /ready) are excluded; other repository surfaces are declared boundaries.",
  legacyBridge: "single_writer", platformStore: "platform_audit_event", platformReadsFeature: "platformAuditReads",
  legacyBackfill: false, paidOverage: false,
  billing: "disabled", retention: "preview_only", deletionEnabled: false, scheduledCleanup: false,
  jobContextPropagation: false, drains: "not_configured",
  trafficCaptureFlag: "DEN_AUDIT_CAPTURE_ENABLED", visibilityFlag: "DEN_AUDIT_VISIBILITY_ENABLED", installationEntitlementFlag: "DEN_AUDIT_SELF_HOSTED_ENABLED",
} satisfies Record<string, string | boolean>
