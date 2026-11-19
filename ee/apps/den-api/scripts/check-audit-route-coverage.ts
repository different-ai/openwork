import type { AuditJobOutcomeDeclaration } from "../src/audit/job-outcomes.js"
import type { AuditServiceActionDeclaration } from "../src/audit/service-actions.js"

// Enforces design §7: every den-api route (app.routes) and every HTTP-reachable
// better-auth endpoint carries exactly one audit declaration, declarations are
// well formed. No generated report is required.
//   pnpm --filter @openwork-ee/den-api audit:coverage

function setEnvDefault(name: string, value: string) {
  if (!process.env[name]?.trim()) process.env[name] = value
}

// Importing the app initializes Better Auth's OAuth resource registry. These
// defaults satisfy env validation; the database must also have its schema.
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

async function main() {
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
  const highVolumeKeys = new Set(registry.HIGH_VOLUME_EXCLUSIONS.map(({ method, path }) => registry.auditRouteKey(method, path)))
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
    if (declaration.class === "excluded_high_volume" && !highVolumeKeys.has(key)) fail("excluded_high_volume outside HIGH_VOLUME_EXCLUSIONS", key)
  }
  for (const key of exclusionKeys) {
    const declaration = declarations.find((entry) => registry.auditRouteKey(entry.method, entry.path) === key)
    if (declaration && declaration.class !== "mcp_consumption") fail("MCP exclusion not declared mcp_consumption", key)
  }
  for (const key of highVolumeKeys) {
    const declaration = declarations.find((entry) => registry.auditRouteKey(entry.method, entry.path) === key)
    if (!declaration) fail("high-volume exclusion without a declaration", key)
    else if (declaration.class !== "excluded_high_volume") fail("high-volume exclusion not declared excluded_high_volume", key)
    else if (declaration.method !== "GET") fail("high-volume exclusion on a non-GET route", key)
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

  const classCounts = new Map<string, number>()
  for (const declaration of declarations) classCounts.set(declaration.class, (classCounts.get(declaration.class) ?? 0) + 1)
  console.log([
    `den-api route keys: ${appKeys.size}; better-auth endpoints: ${betterAuthKeys.size}; live keys: ${liveKeys.size}; declarations: ${declarations.length}`,
    `slices: ${Object.entries(registry.auditRouteSlices).map(([name, slice]) => `${name}=${slice.length}`).join(" ")}`,
    `classes: ${[...classCounts].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `${name}=${count}`).join(" ")}`,
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

let code = 1
try {
  code = await main()
} catch (error) {
  console.error(error)
  code = 1
}
// Importing the app starts background timers and pools; exit explicitly.
process.exit(code)
