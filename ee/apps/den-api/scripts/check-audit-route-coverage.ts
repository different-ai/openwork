import { readFile, writeFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import type { AuditRouteClass } from "../src/audit/routes/types.js"
import type { AuditJobOutcomeDeclaration } from "../src/audit/job-outcomes.js"
import type { AuditServiceActionDeclaration } from "../src/audit/service-actions.js"

// Enforces design §7: every den-api route (app.routes) and every HTTP-reachable
// better-auth endpoint carries exactly one audit declaration, declarations are
// well formed, and src/audit/COVERAGE.md matches the registry.
//   pnpm --filter @openwork-ee/den-api audit:coverage          # check (CI)
//   pnpm --filter @openwork-ee/den-api audit:coverage --write  # regenerate COVERAGE.md

function setEnvDefault(name: string, value: string) {
  if (!process.env[name]?.trim()) process.env[name] = value
}

// Importing the app never touches the database; these only satisfy env validation.
setEnvDefault("OPENWORK_DEV_MODE", "1")
setEnvDefault("DB_MODE", "mysql")
setEnvDefault("DATABASE_URL", "mysql://root:password@127.0.0.1:3306/openwork_den")
setEnvDefault("DEN_DB_ENCRYPTION_KEY", "local-dev-db-encryption-key-please-change-1234567890")
setEnvDefault("BETTER_AUTH_SECRET", "local-dev-secret-not-for-production-use!!")
setEnvDefault("BETTER_AUTH_URL", "http://localhost:8790")
setEnvDefault("DEN_AUTOMATIONS_ENABLED", "true")
setEnvDefault("DEN_AUTOMATIONS_RUNTIME_ENABLED", "true")

const ACTION = /^[a-z][a-z0-9_.-]*$/
const KIND = /^[a-z][a-z0-9_.-]{0,127}$/
const RESOURCE_TYPE = /^[a-z][a-z0-9_.-]{0,63}$/
// Path parameters that carry bearer secrets (claim codes, reset tokens, OTPs) must
// never become an audit resource id. Allowlist: none.
const SECRET_PARAM = /(token|secret|password|code|otp)$/i
const SECRET_PARAM_ALLOWLIST: ReadonlySet<string> = new Set<string>()

type Endpoint = { path: string; methods: string[] }

function betterAuthEndpoint(value: unknown): Endpoint | null {
  if (typeof value !== "function" && (typeof value !== "object" || value === null)) return null
  if (!("path" in value) || typeof value.path !== "string" || !("options" in value)) return null
  const options = value.options
  if (typeof options !== "object" || options === null) return null
  const metadata = "metadata" in options ? options.metadata : undefined
  // better-call registers only endpoints with a path and without SERVER_ONLY metadata.
  if (typeof metadata === "object" && metadata !== null && "SERVER_ONLY" in metadata && metadata.SERVER_ONLY) return null
  const method = "method" in options ? options.method : undefined
  const methods = (Array.isArray(method) ? method : [method]).filter((entry): entry is string => typeof entry === "string")
  return methods.length ? { path: value.path, methods: methods.map((entry) => entry.toUpperCase()) } : null
}

function cell(value: string | null | undefined) {
  return (value ?? "").replace(/\r?\n/g, " ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|")
}

async function main() {
  const { values } = parseArgs({ options: { write: { type: "boolean", default: false } } })
  const app = (await import("../src/app.js")).default
  const { auth } = await import("../src/auth.js")
  const registry = await import("../src/audit/routes/index.js")
  const { LEGACY_ACTION_BRIDGE } = await import("../src/audit/legacy-bridge.js")
  const { ORGANIZATION_AUDIT_ACTIONS } = await import("../src/audit-events.js")
  const { domainChangeEmitters, domainChangeEventTypes, domainEventCategories } = await import("../src/audit/domain/catalog.js")
  const coverage = await import("../src/audit/coverage.js")
  const serviceActions = await import("../src/audit/service-actions.js")
  const jobOutcomes = await import("../src/audit/job-outcomes.js")
  const { auditEventTypesResponseSchema } = await import("@openwork/types/den/audit")

  const appKeys = new Set(app.routes.map((route) => registry.auditRouteKey(route.method, route.path)))
  const betterAuthKeys = new Set<string>()
  for (const value of Object.values(auth.api)) {
    const endpoint = betterAuthEndpoint(value)
    if (!endpoint) continue
    for (const method of endpoint.methods) betterAuthKeys.add(registry.auditRouteKey(method, `${registry.BETTER_AUTH_BASE_PATH}${endpoint.path}`))
  }
  const liveKeys = new Set([...appKeys, ...betterAuthKeys])
  const declarations = registry.auditRouteDeclarations
  const declaredKeys = new Set(declarations.map((declaration) => registry.auditRouteKey(declaration.method, declaration.path)))
  const failures = new Map<string, string[]>()
  const fail = (category: string, entry: string) => failures.set(category, [...(failures.get(category) ?? []), entry])

  for (const key of [...liveKeys].sort()) if (!declaredKeys.has(key)) fail(betterAuthKeys.has(key) && !appKeys.has(key) ? "undeclared better-auth endpoints" : "undeclared den-api routes", key)
  for (const key of [...declaredKeys].sort()) if (!liveKeys.has(key)) fail("stale declarations (no live route or endpoint)", key)
  for (const key of registry.duplicateAuditRouteKeys()) fail("duplicate declarations", key)

  const exclusionKeys = new Set(registry.MCP_CONSUMPTION_EXCLUSIONS.map(({ method, path }) => registry.auditRouteKey(method, path)))
  const operationalKeys = new Set(registry.OPERATIONAL_EXCLUSIONS.map(({ method, path }) => registry.auditRouteKey(method, path)))
  // The operational exclusion is exactly GET /, /health and /ready; widening it needs a reviewed change here.
  const expectedOperational = ["GET /", "GET /health", "GET /ready"]
  if ([...operationalKeys].sort().join(",") !== expectedOperational.join(",")) fail("OPERATIONAL_EXCLUSIONS must be exactly GET /, /health, /ready", [...operationalKeys].sort().join(", "))
  for (const declaration of declarations) {
    const key = registry.auditRouteKey(declaration.method, declaration.path)
    const params = new Set((declaration.path.match(/:[A-Za-z0-9_]+/g) ?? []).map((segment) => segment.slice(1)))
    const tenant = declaration.class.startsWith("tenant_")
    if (declaration.class === "mcp_consumption" && !exclusionKeys.has(key)) fail("mcp_consumption outside MCP_CONSUMPTION_EXCLUSIONS", key)
    if (!ACTION.test(declaration.action)) fail("invalid action", `${key}: ${declaration.action}`)
    if (!KIND.test(declaration.kind)) fail("invalid kind", `${key}: ${declaration.kind}`)
    if (!RESOURCE_TYPE.test(declaration.resource.type)) fail("invalid resource type", `${key}: ${declaration.resource.type}`)
    for (const eventType of [...registry.auditRouteEventTypes(declaration), `${declaration.action}.attempted`]) if (eventType.length > 128) fail("event type longer than 128", `${key}: ${eventType}`)
    if (declaration.resource.idParam !== null && !params.has(declaration.resource.idParam)) fail("resource idParam not in path", `${key}: ${declaration.resource.idParam}`)
    if (declaration.attribution.startsWith("path:") && !params.has(declaration.attribution.slice("path:".length))) fail("path attribution param not in path", `${key}: ${declaration.attribution}`)
    if (declaration.class === "tenant_read" && declaration.method !== "GET" && declaration.method !== "HEAD") fail("non-GET route declared tenant_read", key)
    if (declaration.readOnly && (declaration.class !== "platform" || (declaration.method !== "GET" && declaration.method !== "HEAD"))) fail("readOnly outside platform GET/HEAD", key)
    if (declaration.resource.idParam !== null && SECRET_PARAM.test(declaration.resource.idParam) && !SECRET_PARAM_ALLOWLIST.has(`${key}:${declaration.resource.idParam}`)) fail("secret-like path parameter used as resource idParam", `${key}: ${declaration.resource.idParam}`)
    if (tenant && declaration.attribution === "none") fail("tenant class without attribution", key)
    if (declaration.attribution === "user_memberships") {
      if (declaration.class !== "platform") fail("user_memberships attribution outside class platform", key)
      const emitters = (declaration.changeEvidence ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)
      if (emitters.length === 0) fail("user_memberships attribution without changeEvidence", key)
      for (const emitter of emitters) if (!Object.values(domainChangeEmitters).includes(emitter)) fail("user_memberships changeEvidence is not a registered domain emitter", `${key}: ${emitter}`)
    }
    if (declaration.class === "tenant_external" && !declaration.external) fail("tenant_external without external system", key)
    if (declaration.class === "tenant_job" && !declaration.jobOutcome) fail("tenant_job without jobOutcome", key)
    if (declaration.class === "support" && declaration.method !== "ALL" && declaration.method !== "OPTIONS") fail("support class on a non-middleware method", key)
    if (declaration.class === "excluded_operational" && !operationalKeys.has(key)) fail("excluded_operational outside OPERATIONAL_EXCLUSIONS", key)
  }
  for (const key of exclusionKeys) {
    const declaration = declarations.find((entry) => registry.auditRouteKey(entry.method, entry.path) === key)
    if (declaration && declaration.class !== "mcp_consumption") fail("MCP exclusion not declared mcp_consumption", key)
  }
  for (const key of operationalKeys) {
    const declaration = declarations.find((entry) => registry.auditRouteKey(entry.method, entry.path) === key)
    if (!declaration) fail("operational exclusion without a declaration", key)
    else if (declaration.class !== "excluded_operational") fail("operational exclusion not declared excluded_operational", key)
  }

  const bridge: Readonly<Record<string, string>> = LEGACY_ACTION_BRIDGE
  for (const action of Object.values(ORGANIZATION_AUDIT_ACTIONS)) {
    const target = bridge[action]
    if (!target) fail("legacy actions without LEGACY_ACTION_BRIDGE entry", action)
    else if (!ACTION.test(target)) fail("invalid legacy bridge target", `${action} -> ${target}`)
    else if (!domainChangeEventTypes.includes(target)) fail("legacy bridge target not registered in src/audit/domain/catalog.ts", `${action} -> ${target}`)
  }
  // Service-layer (non-HTTP) actions: same naming rules, unique, and never
  // sharing an action or event type with a route declaration or domain event.
  const routeActions = new Set(declarations.map((declaration) => declaration.action))
  const routeEventTypes = new Set(declarations.flatMap(registry.auditRouteEventTypes))
  const serviceActionNames = new Set<string>()
  const serviceDeclarations: readonly AuditServiceActionDeclaration[] = serviceActions.auditServiceActionDeclarations
  for (const declaration of serviceDeclarations) {
    const label = `${declaration.action} (${declaration.tools.join(", ")})`
    if (!ACTION.test(declaration.action)) fail("invalid service action", label)
    if (!KIND.test(declaration.kind)) fail("invalid service action kind", `${label}: ${declaration.kind}`)
    if (!RESOURCE_TYPE.test(declaration.resource.type)) fail("invalid service action resource type", `${label}: ${declaration.resource.type}`)
    if (serviceActionNames.has(declaration.action)) fail("duplicate service actions", label)
    serviceActionNames.add(declaration.action)
    if (routeActions.has(declaration.action)) fail("service action collides with a route declaration action", label)
    for (const eventType of [...serviceActions.auditServiceActionEventTypesFor(declaration), `${declaration.action}.attempted`]) {
      if (eventType.length > 128) fail("event type longer than 128", `${label}: ${eventType}`)
      if (routeEventTypes.has(eventType) || domainChangeEventTypes.includes(eventType)) fail("service action event type collides with a route or domain event type", `${label}: ${eventType}`)
    }
    if (declaration.tools.length === 0 || declaration.callSites.length === 0) fail("service action without tools or call sites", label)
    if (declaration.class === "tenant_external" && !declaration.external) fail("tenant_external service action without external system", label)
    if (declaration.class === "tenant_job" && !declaration.jobOutcome) fail("tenant_job service action without jobOutcome", label)
  }
  // Background job outcomes (src/audit/job-outcomes.ts): full event types, unique, never shared with request/domain/service events.
  const serviceEventTypes = new Set(serviceDeclarations.flatMap(serviceActions.auditServiceActionEventTypesFor))
  const jobEventTypes = new Set<string>()
  const jobDeclarations: readonly AuditJobOutcomeDeclaration[] = jobOutcomes.auditJobOutcomeDeclarations
  for (const declaration of jobDeclarations) {
    if (!ACTION.test(declaration.eventType) || declaration.eventType.length > 128) fail("invalid job outcome event type", declaration.eventType)
    if (!KIND.test(declaration.kind)) fail("invalid job outcome kind", `${declaration.eventType}: ${declaration.kind}`)
    if (jobEventTypes.has(declaration.eventType)) fail("duplicate job outcome event types", declaration.eventType)
    jobEventTypes.add(declaration.eventType)
    if (routeEventTypes.has(declaration.eventType) || domainChangeEventTypes.includes(declaration.eventType) || serviceEventTypes.has(declaration.eventType)) fail("job outcome event type collides with a route, domain or service event type", declaration.eventType)
    if (declaration.emitters.length === 0) fail("job outcome without emitters", declaration.eventType)
  }
  for (const event of coverage.userScopedAuditEvents) {
    if (!domainChangeEventTypes.includes(event.eventType)) fail("user-scoped event not registered in src/audit/domain/catalog.ts", event.eventType)
    const category: string = domainEventCategories[event.eventType] ?? "change"
    if (category !== event.category) fail("user-scoped event category differs from the catalog", `${event.eventType}: ${event.category} vs ${category}`)
  }
  const catalog = auditEventTypesResponseSchema.safeParse({ eventTypes: coverage.supportedAuditEventTypes() })
  if (!catalog.success) fail("invalid supported event-type catalog", catalog.error.issues.map((issue) => issue.message).join("; "))

  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const repoRoot = resolve(scriptDir, "../../../..")
  const coveragePath = resolve(scriptDir, "../src/audit/COVERAGE.md")
  const markdown = renderCoverage({ registry, coverage, bridge, appKeys, betterAuthKeys, serviceActions, jobOutcomes })
  if (values.write) await writeFile(coveragePath, markdown)
  else {
    const current = await readFile(coveragePath, "utf8").catch(() => null)
    if (current !== markdown) fail("stale generated matrix", `${relative(repoRoot, coveragePath)} differs; run pnpm --filter @openwork-ee/den-api audit:coverage --write`)
  }

  const classCounts = new Map<string, number>()
  for (const declaration of declarations) classCounts.set(declaration.class, (classCounts.get(declaration.class) ?? 0) + 1)
  console.log([
    `den-api route keys: ${appKeys.size}; better-auth endpoints: ${betterAuthKeys.size}; live keys: ${liveKeys.size}; declarations: ${declarations.length}`,
    `slices: ${Object.entries(registry.auditRouteSlices).map(([name, slice]) => `${name}=${slice.length}`).join(" ")}`,
    `classes: ${[...classCounts].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `${name}=${count}`).join(" ")}`,
    values.write ? `Wrote ${relative(repoRoot, coveragePath)}` : "",
  ].filter(Boolean).join("\n"))
  if (failures.size === 0) {
    console.log("audit route coverage: OK")
    return 0
  }
  let total = 0
  for (const [category, entries] of failures) {
    total += entries.length
    console.error(`\n${category} (${entries.length}):`)
    for (const entry of entries) console.error(`  ${entry}`)
  }
  console.error(`\naudit route coverage: FAILED (${total} problems in ${failures.size} categories)`)
  return 1
}

type Registry = typeof import("../src/audit/routes/index.js")
type Coverage = typeof import("../src/audit/coverage.js")
type ServiceActions = typeof import("../src/audit/service-actions.js")
type JobOutcomes = typeof import("../src/audit/job-outcomes.js")

// Standalone audit appends (src/audit/retry.ts) are re-run as whole transactions on transient database errors before failing.
const RETRY = "up to 3 attempts on transient database errors, then"

const CLASS_POLICY: Readonly<Record<AuditRouteClass, { capture: string; failure: string }>> = {
  tenant_read: { capture: "served before release (category read, off by default)", failure: `capture-start failure: served without capture; served append after capture started: ${RETRY} 503, no content` },
  tenant_access: { capture: "requested before handler; served before release (access)", failure: `intent or served: ${RETRY} 503, no content` },
  tenant_change: { capture: "requested before handler; succeeded/attempted after (request)", failure: `intent: ${RETRY} 503, handler not run; outcome: ${RETRY} logged [audit-outcome-lost]` },
  tenant_external: { capture: "requested before handler; confirmed/attempted, 5xx unknown (request)", failure: `intent: ${RETRY} 503, handler not run; outcome: ${RETRY} logged [audit-outcome-lost]` },
  tenant_job: { capture: "requested before handler; accepted/attempted after (execution)", failure: `intent: ${RETRY} 503, handler not run; outcome: ${RETRY} logged [audit-outcome-lost]` },
  tenant_signal: { capture: "one outcome after handler: observed/attempted (category read, off by default; denials use security when selected); no intent", failure: `never fail-closed: capture-start failure served without capture; outcome: ${RETRY} logged [audit-outcome-lost]` },
  domain_provider: { capture: "provider emitter (src/audit/provider.ts)", failure: `evidence failure rolls back (in-transaction, not retried); attempts outside rollback: ${RETRY} propagated` },
  domain_audit: { capture: "audit emitter (src/routes/org/audit.ts)", failure: `${RETRY} fails closed with 503` },
  platform: { capture: "platform_audit_event after handler with target; successful readOnly reads only with the platformAuditReads feature", failure: `written before the response is released; ${RETRY} a failed insert never fails the request ([platform-audit-lost])` },
  excluded_operational: { capture: "excluded: operational probe (OPERATIONAL_EXCLUSIONS); no audit record", failure: "none" },
  proxy: { capture: "destination route records", failure: "none" },
  support: { capture: "app.use middleware entry, not an endpoint", failure: "none" },
  mcp_consumption: { capture: "excluded: MCP consumption transport", failure: "none" },
}

function renderCoverage(input: { registry: Registry; coverage: Coverage; bridge: Readonly<Record<string, string>>; appKeys: Set<string>; betterAuthKeys: Set<string>; serviceActions: ServiceActions; jobOutcomes: JobOutcomes }) {
  const serviceDeclarations: readonly AuditServiceActionDeclaration[] = input.serviceActions.auditServiceActionDeclarations
  const { registry, coverage, bridge } = input
  const declarations = [...registry.auditRouteDeclarations].sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method))
  const lines: string[] = [
    "# den-api audit route coverage",
    "",
    "Generated by `pnpm --filter @openwork-ee/den-api audit:coverage --write` from `src/audit/routes`. Do not edit by hand; CI fails when this file is stale.",
    "",
    `- ${input.appKeys.size} den-api route keys (\`app.routes\`), ${input.betterAuthKeys.size} HTTP-reachable better-auth endpoints, ${declarations.length} declarations.`,
    "- Tenant capture requires the trusted organization's `auditLogs` feature (features registry, read fresh), `DEN_AUDIT_CAPTURE_ENABLED`, an enabled policy and the class category; with capture off no audit database work happens.",
    "- Request evidence: declared resource type, validated path-parameter id (`unparseable` otherwise) or `collection:<type>`, parent organization, method, route template and status. Never bodies, query strings, headers, IPs or secrets.",
    "- One operation per request: intent, outcome and domain change events (`appendAuditChanges`) share it. Requests without trustworthy tenant attribution go to `platform_audit_event` (no organization column, not tenant-visible) with a target: the declared resource type plus validated path id, else the first handler-named resource; an organization target only when it is the authenticated context's organization.",
    "- The platform read filter keys on effect, not method: only declarations marked `readOnly` (platform GET/HEAD without side effects) skip successful requests unless the deployment-wide `platformAuditReads` feature is on; every other platform request, including side-effecting GETs (OAuth/social callbacks, verify-email, unsubscribe, end-session, SLO, token), is recorded.",
    "- Retry: every standalone audit transaction (intent, served, outcome, service-action and job outcomes, user fan-out, after-commit change events, `/v1/audit/*` access evidence, platform rows) is re-run as a whole (entitlement recheck and policy fence included) on transient database errors: deadlock (1213) and lock wait timeout (1205) always, connection loss (ECONNRESET, EPIPE, ETIMEDOUT, PROTOCOL_CONNECTION_LOST) only when the append is idempotent on replay (stable request/job operation plus idempotency key, or a pre-generated platform row id). Up to 3 attempts with ~50/150 ms jittered backoff, each retry logged `[audit-append-retry]`; then the failure behaviour below applies. `AuditLogError`s and feature/entitlement decisions are never retried. Change events appended inside a business transaction are not retried (a deadlock rolls the mutation back).",
    "- When a tenant outcome append fails with `audit_policy_changed` after its intent was recorded (the request itself disabled capture, e.g. an `auditLogs` feature override set to off or a plan change removing the entitlement), the outcome is written to `platform_audit_event` targeting the verified organization.",
    "",
    "## Classes",
    "",
    "| Class | Declarations | Capture policy | Event types | Failure behaviour |",
    "|---|---|---|---|---|",
    ...registry.AUDIT_ROUTE_CLASSES.map((name) => {
      const policy = CLASS_POLICY[name]
      const suffixes = registry.AUDIT_ROUTE_EVENT_SUFFIXES[name]
      return `| ${name} | ${declarations.filter((declaration) => declaration.class === name).length} | ${cell(policy.capture)} | ${cell(suffixes.length ? suffixes.map((suffix) => `.${suffix}`).join(" ") : "none")} | ${cell(policy.failure)} |`
    }),
    "",
    "## Boundaries",
    "",
    "In scope: every den-api Hono route and every HTTP-reachable better-auth endpoint behind `/api/auth/*`. MCP tool calls that re-enter den-api (`invokeMcpOperation` → `app.fetch`) are recorded at the destination route with origin `mcp`; MCP mutations that do not re-enter a route use `runAuditedServiceAction`. Other repository surfaces:",
    "",
    "| Location | Surface | Status | Boundary |",
    "|---|---|---|---|",
    ...coverage.otherAuditSurfaces.map((surface) => `| \`${surface.location}\` | ${surface.surface} | ${surface.coverage.status} | ${cell(surface.coverage.limitations)} |`),
    "",
    "## Exclusions",
    "",
    "The only routes excluded from audit logs, each pinned by this check: MCP consumption transports (`MCP_CONSUMPTION_EXCLUSIONS`, class `mcp_consumption`) and the operational probes (`OPERATIONAL_EXCLUSIONS`, class `excluded_operational`, exactly `GET /`, `/health`, `/ready`). Request capture records nothing for them.",
    "",
    "| Exclusion | Method | Path | Reason |",
    "|---|---|---|---|",
    ...registry.MCP_CONSUMPTION_EXCLUSIONS.map((entry) => `| MCP consumption | ${entry.method} | \`${entry.path}\` | ${cell(entry.reason)} |`),
    ...registry.OPERATIONAL_EXCLUSIONS.map((entry) => `| Operational probe | ${entry.method} | \`${entry.path}\` | ${cell(entry.reason)} |`),
    "",
    "## Service-layer (non-HTTP) actions",
    "",
    "MCP tools that mutate organization state without re-entering a den-api route (`src/audit/service-actions.ts`), recorded by `runAuditedServiceAction` with the verified MCP caller (platform-admin tools: the admin user and the verified target organization). Intent before the mutation; if it cannot be recorded the tool returns `audit_unavailable` and nothing is changed. MCP transport requests themselves record nothing.",
    "",
    "| Action | Class | Kind | Resource | Origin | Tools | Call sites | Event types | External / job / notes |",
    "|---|---|---|---|---|---|---|---|---|",
    ...serviceDeclarations.map((declaration) => {
      const resource = `${declaration.resource.type}${declaration.resource.idFrom ? ` (${declaration.resource.idFrom})` : ""}`
      const extra = [declaration.external ? `external: ${declaration.external}` : "", declaration.jobOutcome ? `job outcome: ${declaration.jobOutcome}` : "", declaration.notes ?? ""].filter(Boolean).join("; ")
      const events = input.serviceActions.auditServiceActionEventTypesFor(declaration).map((eventType) => `\`${eventType}\``).join(" ")
      return `| \`${cell(declaration.action)}\` | ${declaration.class} | ${cell(declaration.kind)} | ${cell(resource)} | ${declaration.origin} | ${cell(declaration.tools.join(", "))} | ${cell(declaration.callSites.join("; "))} | ${events} | ${cell(extra)} |`
    }),
    "",
    "## Job outcomes",
    "",
    "Outcomes of asynchronous work started by den-api endpoints or its schedulers (`src/audit/job-outcomes.ts`), appended by `src/audit/job-capture.ts:recordAuditJobOutcome` in category `execution` under one job operation per job row (`jobRunId` = row id, no request id). Same capture gates as requests; up to 3 attempts on transient database errors, then failures never affect the job and log `[audit-outcome-lost]`. Starting routes keep their own `.requested`/`.accepted` request operation; their `jobOutcome` names the event below or `not_recorded: <reason>`.",
    "",
    "| Event type | Kind | Resources | Actor | Origins | Idempotency key | Emitters | Started by | Evidence | Limitations |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...input.jobOutcomes.auditJobOutcomeDeclarations.map((declaration) => `| \`${cell(declaration.eventType)}\` | ${cell(declaration.kind)} | ${cell([`${declaration.target} (target)`, ...declaration.parents.map((parent) => `${parent} (parent)`)].join(", "))} | ${cell(declaration.actor)} | ${declaration.origins.join(", ")} | \`${cell(declaration.idempotencyKey)}\` | ${cell(declaration.emitters.join("; "))} | ${cell(declaration.startedBy.join("; "))} | ${cell(declaration.evidence)} | ${cell(declaration.limitations)} |`),
    "",
    "## User-scoped events (attribution `user_memberships`)",
    "",
    "Rule: endpoints acting on a user rather than one trusted tenant (sign-in, sign-out, session revocation, account and password changes, identity links, organization switching, desktop handoff) keep their request evidence in `platform_audit_event` (class `platform`, declared action stem) and declare `attribution: user_memberships` plus the emitter in `changeEvidence`. The emitter appends the events below through `src/audit/fanout.ts:recordAuditForUserMemberships` into the user's verified active memberships: session events into the session's (or destination) organization, or into every organization where the user is an active member when the session has no active organization (it can act in all of them); account and failed sign-in events into every active membership. Sessions Den deletes directly (organization-scoped credential revocation, bearer sign-out, admin user deletion) record `session.revoked` with a reasonCode in the affected organization, reusing the current request's change capture for that organization. Each organization gets its own operation and transaction (entitlement recheck, policy-current fence) sharing the request id; only organizations with the literal `auditLogs` flag, capture on, an enabled policy and the event category store anything; up to 3 attempts on transient database errors (connection loss only when the request id makes the replay idempotent), then a failure logs `[audit-outcome-lost]` and never fails the user's request. Endpoints already attributed to one tenant (better-auth `organization/set-active`, SSO callbacks) keep that request evidence; their `session.*` change event joins the request operation when it is captured for the same organization. No `session.updated` event exists: `update-session` cannot change a meaningful field in Den.",
    "",
    "| Event type | Category | Organizations | Actor | Chokepoints | Evidence |",
    "|---|---|---|---|---|---|",
    ...coverage.userScopedAuditEvents.map((event) => `| \`${event.eventType}\` | ${event.category} | ${event.organizations} | ${cell(event.actor)} | ${cell(event.chokepoints)} | ${cell(event.evidence)} |`),
    "",
    "## Organization-bound auth endpoints",
    "",
    "Better-auth and auth helper endpoints whose organization is proven by the request itself (an MCP consent referenceId / token org claim, an invitation, the session's organization, or the caller's own membership for a refused raw mutation) are tenant-declared with `handler` attribution; everything unverified stays platform evidence.",
    "",
    "| Event type | Category | Organization | Actor | Chokepoints | Evidence |",
    "|---|---|---|---|---|---|",
    ...coverage.organizationBoundAuthEvents.map((event) => `| \`${event.eventType}\` | ${event.category} | ${cell(event.organization)} | ${cell(event.actor)} | ${cell(event.chokepoints)} | ${cell(event.evidence)} |`),
    "",
    "## Legacy bridge",
    "",
    "When tenant capture is active the domain emitter appends the new change event inside the business transaction instead of the legacy `audit_event` row; otherwise the legacy row is written unchanged. `[audit-alert]` is logged once either way. Historical legacy rows are never backfilled or counted.",
    "",
    "| Legacy action | Change event |",
    "|---|---|",
    ...Object.entries(bridge).sort(([a], [b]) => a.localeCompare(b)).map(([legacy, target]) => `| \`${legacy}\` | \`${target}\` |`),
    "",
    "## Route matrix",
    "",
    "| Method | Path | Class | Action | Kind | Resource | Attribution | Capture | Change evidence | Failure | External / job / notes |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...declarations.map((declaration) => {
      const policy = CLASS_POLICY[declaration.class]
      const resource = `${declaration.resource.type}${declaration.resource.idParam ? ` (:${declaration.resource.idParam})` : ""}`
      const evidence = declaration.changeEvidence ?? (declaration.class.startsWith("tenant_") ? "request evidence only" : "")
      const extra = [declaration.readOnly ? "read-only (successes need the platformAuditReads feature)" : "", declaration.external ? `external: ${declaration.external}` : "", declaration.jobOutcome ? `job outcome: ${declaration.jobOutcome}` : "", declaration.notes ?? ""].filter(Boolean).join("; ")
      return `| ${declaration.method} | \`${cell(declaration.path)}\` | ${declaration.class} | \`${cell(declaration.action)}\` | ${cell(declaration.kind)} | ${cell(resource)} | ${cell(declaration.attribution)} | ${cell(policy.capture)} | ${cell(evidence)} | ${cell(policy.failure)} | ${cell(extra)} |`
    }),
    "",
  ]
  return lines.join("\n")
}

let code = 1
try {
  code = await main()
} catch (error) {
  console.error(error)
  code = 1
}
// Importing the app starts background timers and pools; exit explicitly.
process.exit(code)
