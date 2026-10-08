import { AsyncLocalStorage } from "node:async_hooks"
import { AuditLogError, appendAuditEvent, appendPlatformAuditEvent, type AuditActor, type AuditContext, type AuditEventInput, type AuditOperationOutcome, type AuditOrigin, type AuditPolicy, type AuditTx, type PlatformAuditEventInput } from "@openwork-ee/den-db/audit-log"
import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable, OrganizationTable, PlatformAuditEventTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { AuditCategory } from "@openwork/types/den/audit"
import type { Context, MiddlewareHandler } from "hono"
import { matchedRoutes, routePath } from "hono/route"
import type { DenApiKeySession } from "../api-keys.js"
import { db } from "../db.js"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
import { AUDIT_OUTCOME_LOST_OPERATIONAL_MARKER, PLATFORM_AUDIT_LOST_OPERATIONAL_MARKER } from "../operational-log-markers.js"
import { deploymentFeatureEnabled, organizationFeatureEnabled } from "../features.js"
import type { OrganizationContext } from "../orgs.js"
import { readInternalMcpPrincipalCredentialId, type AuthContextVariables } from "../session.js"
import { readEffectiveAuditPolicy, recheckAuditEntitlement } from "./capture.js"
import { withAuditRetry } from "./retry.js"
import { BETTER_AUTH_BASE_PATH, findAuditRouteDeclaration, findBetterAuthDeclaration, type AuditRouteClass, type AuditRouteDeclaration } from "./routes/index.js"

// Generic request evidence for every declared den-api route (design §3). One
// operation per request: the pre-handler intent, the post-handler outcome and
// any domain change events appended through appendAuditChanges share it.
// Request/response bodies, query strings, headers, IPs and secrets are never
// recorded; resources are the declared type plus a validated path parameter.

export type TenantAuditClass = Extract<AuditRouteClass, "tenant_read" | "tenant_access" | "tenant_change" | "tenant_external" | "tenant_job" | "tenant_signal">
export type AuditChangeCapture = Readonly<{ context: AuditContext; policy: AuditPolicy }>
export type AuditRequestAttribution = Readonly<{
  organizationId: string
  actor: AuditActor
  /** e.g. `service:scim:<providerId>` or `user:<usr>:member:<om>:key:<apk|session>`. */
  principalKey: string
  origin?: AuditOrigin
  /**
   * "after": the effect already happened (e.g. better-auth hooks.after); intent
   * and outcome are still appended, but an intent failure logs
   * [audit-outcome-lost] instead of refusing the request. Default "before".
   */
  phase?: "before" | "after"
  /**
   * The endpoint refuses the request itself (raw better-auth mutations Den
   * blocks): no `.requested` intent is appended (so nothing can turn the
   * refusal into a 503) and the denied `.attempted` outcome carries this
   * reasonCode instead of request_denied.
   */
  refusal?: Readonly<{ reasonCode: string }>
}>
type TenantAttribution = { organizationId: string; actor: AuditActor; principalKey: string; origin: AuditOrigin; flagged: boolean }
type ResolvedDeclaration = { declaration: AuditRouteDeclaration; params: Record<string, string> }
type AuditRequestResource = AuditEventInput["resources"][number]
type AuditRequestState = {
  context: Context
  requestId: string
  parent: AuditRequestState | null
  origin: AuditOrigin
  resolved: ResolvedDeclaration | null | undefined
  tenant: TenantAttribution | null
  capture: AuditChangeCapture | null
  requestCategory: AuditCategory | null
  resourceId: string | null
  began: boolean
  blocked: boolean
  /** The `.requested` intent was durably appended for this request. */
  intentRecorded: boolean
  platformAdminUserId: string | null
  /** MCP grant/client/run-token id of an MCP-internal re-entry (never token material). */
  mcpCredentialId: string | null
  /** Resources the handler created or started (addAuditRequestResource), added to the outcome event. */
  extraResources: AuditRequestResource[]
  /** Set by a refusal attribution: outcome reasonCode for the denied attempt. */
  refusalReasonCode: string | null
}

const logger = appLogger.child({ component: "audit_request" })
const requestStore = new AsyncLocalStorage<AuditRequestState>()
// Keyed by the Hono Context object: route middleware, handlers and the global
// middleware of one request share it, while a nested app.fetch gets its own.
const states = new WeakMap<object, AuditRequestState>()
const resourceIdPattern = /^[A-Za-z0-9_.:@-]{1,128}$/
const resourceTypePattern = /^[a-z][a-z0-9_.-]{0,63}$/
const credentialIdPattern = /^[A-Za-z0-9_.:@/-]{1,200}$/
const MAX_EXTRA_RESOURCES = 8
const tenantClasses: readonly AuditRouteClass[] = ["tenant_read", "tenant_access", "tenant_change", "tenant_external", "tenant_job", "tenant_signal"]
const successSuffix: Readonly<Record<TenantAuditClass | "platform", string>> = {
  tenant_read: "served", tenant_access: "served", tenant_change: "succeeded", tenant_external: "confirmed", tenant_job: "accepted", tenant_signal: "observed", platform: "succeeded",
}

export function isTenantAuditClass(value: AuditRouteClass): value is TenantAuditClass {
  return tenantClasses.includes(value)
}

/**
 * Request evidence category per class; change snapshots always use "change".
 * tenant_signal (heartbeats, polls, ingestion, runtime pass-through) shares the
 * "read" polling category, off by default.
 */
export function auditClassCategory(value: TenantAuditClass): AuditCategory {
  return value === "tenant_read" || value === "tenant_signal" ? "read" : value === "tenant_access" ? "access" : value === "tenant_job" ? "execution" : "request"
}

/** Classes whose `.requested` intent must be durable before the handler runs. */
export function auditClassNeedsIntent(value: TenantAuditClass): boolean {
  return value !== "tenant_read" && value !== "tenant_signal"
}

export type AuditRequestOutcome = Readonly<{ suffix: string; outcome: AuditEventInput["outcome"]; reasonCode?: string; denied: boolean }>

/** 2xx/3xx success suffix; 401/403 denied; other 4xx rejected; 5xx failed (external: unknown remote outcome). */
export function auditRequestOutcome(value: TenantAuditClass | "platform", status: number): AuditRequestOutcome {
  if (status < 400) return { suffix: successSuffix[value], outcome: "succeeded", denied: false }
  if (status === 401 || status === 403) return { suffix: "attempted", outcome: "denied", reasonCode: "request_denied", denied: true }
  if (status < 500) {
    const reasonCode = status === 404 ? "resource_not_found" : status === 409 ? "request_conflict" : status === 400 || status === 422 ? "validation_failed" : "request_rejected"
    return { suffix: "attempted", outcome: "failed", reasonCode, denied: false }
  }
  if (value === "tenant_external") return { suffix: "unknown", outcome: "unknown", reasonCode: "external_outcome_unknown", denied: false }
  return { suffix: "attempted", outcome: "failed", reasonCode: "request_failed", denied: false }
}

/** Operation outcome projection for a request/service/job outcome event (denied counts as failed). */
export function auditOperationOutcome(outcome: AuditEventInput["outcome"]): AuditOperationOutcome {
  return outcome === "succeeded" ? "succeeded" : outcome === "unknown" ? "unknown" : "failed"
}

/** Validated path parameter, never free text; anything else is recorded as "unparseable". */
export function auditResourceId(value: string | undefined | null): string {
  return typeof value === "string" && resourceIdPattern.test(value) ? value : "unparseable"
}

export function auditUserPrincipalKey(input: { userId: string; memberId: string; credentialId?: string | null }) {
  return `user:${input.userId}:member:${input.memberId}:key:${input.credentialId ?? "session"}`
}

function safeTypeId<T extends "member" | "user">(kind: T, value: string | null | undefined): string | null {
  if (!value) return null
  try { return normalizeDenTypeId(kind, value) } catch { return null }
}

/**
 * Non-human actor for handler attribution: `{ type: "service", id: "<name>:<id>" }`
 * (id validated like a resource id, else "unparseable"), optionally carrying
 * the initiating member the verified credential names, plus its principal key.
 */
export function auditServiceAttribution(name: string, id: string | null, options: { memberId?: string | null; credentialId?: string | null } = {}): Pick<AuditRequestAttribution, "actor" | "principalKey"> {
  const serviceId = id === null ? name : `${name}:${auditResourceId(id)}`
  const memberId = safeTypeId("member", options.memberId)
  const credentialId = options.credentialId && credentialIdPattern.test(options.credentialId) ? options.credentialId : null
  return {
    actor: { type: "service", id: serviceId, ...(memberId ? { memberId } : {}), ...(credentialId ? { credentialId } : {}) },
    principalKey: `service:${serviceId}${memberId ? `:member:${memberId}` : ""}${credentialId ? `:key:${credentialId}` : ""}`,
  }
}

/**
 * OAuth callbacks whose HMAC-signed / single-use state names the organization
 * and the initiating member (verified active): attribute to that member's user.
 */
export async function attributeOAuthCallbackMember(c: Context, owner: Readonly<{ organizationId: string; memberId: string; userId?: string | null }>): Promise<Response | null> {
  let userId = owner.userId
  if (userId === undefined) {
    const organizationId = safeOrganizationId(owner.organizationId)
    const memberId = safeTypeId("member", owner.memberId)
    if (!organizationId || !memberId) return null
    const [member] = await db.select({ userId: MemberTable.userId }).from(MemberTable)
      .where(and(eq(MemberTable.id, normalizeDenTypeId("member", memberId)), eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt))).limit(1)
    userId = member?.userId ?? null
  }
  const attribution = userId ? auditSessionUserAttribution(userId, owner.memberId) : null
  if (!attribution) return null
  const audited = await attributeAuditRequest(c, { organizationId: owner.organizationId, ...attribution })
  return audited.ok ? null : audited.response
}

/** User actor for handler attribution once the session user is verified (member id when known). */
export function auditSessionUserAttribution(userId: string, memberId?: string | null): Pick<AuditRequestAttribution, "actor" | "principalKey"> | null {
  const user = safeTypeId("user", userId)
  if (!user) return null
  const member = safeTypeId("member", memberId)
  return member
    ? { actor: { type: "user", id: user, memberId: member }, principalKey: auditUserPrincipalKey({ userId: user, memberId: member }) }
    : { actor: { type: "user", id: user }, principalKey: `user:${user}:session` }
}

function errorName(error: unknown) {
  return error instanceof AuditLogError ? error.code : error instanceof Error ? error.name : typeof error
}

export function logAuditOutcomeLost(fields: Readonly<{ requestId: string | null; organizationId: string; action: string; route?: string; method?: string; error: unknown }>) {
  logger.warn(`${AUDIT_OUTCOME_LOST_OPERATIONAL_MARKER} audit outcome not recorded; operation stays requested/unknown`, {
    operational_marker: AUDIT_OUTCOME_LOST_OPERATIONAL_MARKER, request_id: fields.requestId, organization_id: fields.organizationId,
    audit_action: fields.action, http_route: fields.route, http_method: fields.method, error_name: errorName(fields.error),
  })
}

/** Fresh entitlement recheck, then append; the append itself checks the policy identity (plain reads, no locks). */
export async function appendRequiredAuditEvent(tx: AuditTx, capture: AuditChangeCapture, event: AuditEventInput, operationOutcome?: AuditOperationOutcome) {
  await recheckAuditEntitlement(tx, capture.context.organizationId)
  const appended = await appendAuditEvent(tx, { context: capture.context, policy: capture.policy, event, ...(operationOutcome ? { operationOutcome } : {}) })
  if (!appended) throw new AuditLogError("audit_storage_inconsistent")
  return appended
}

/**
 * A replay of this append after an ambiguous commit returns the stored event:
 * the operation binding is stable (request or job run id) and the event has an
 * idempotency key. Without a request/job id the binding is per call, so only
 * definite rollbacks (lock conflicts) are retried.
 */
export function auditAppendIsIdempotent(context: AuditContext, event: Pick<AuditEventInput, "idempotencyKey">): boolean {
  return event.idempotencyKey !== undefined && Boolean(context.requestId || context.jobRunId)
}

/**
 * Own transaction, retried on transient database failures (src/audit/retry.ts).
 * `operationOutcome` only for outcome events (request, service action, job), never intents or change snapshots.
 */
export async function appendAuditEventInOwnTransaction(capture: AuditChangeCapture, event: AuditEventInput, operationOutcome?: AuditOperationOutcome) {
  return withAuditRetry(() => db.transaction((tx) => appendRequiredAuditEvent(tx, capture, event, operationOutcome)), {
    label: event.action, idempotent: auditAppendIsIdempotent(capture.context, event), requestId: capture.context.requestId ?? null, organizationId: capture.context.organizationId,
  })
}

/** The lazily initialized effective policy (its own transaction), retried on transient failures; initialization is idempotent. */
export function readEffectiveAuditPolicyWithRetry(organizationId: string) {
  return withAuditRetry(() => readEffectiveAuditPolicy(db, organizationId, true), { label: "audit.policy.read", idempotent: true, organizationId })
}

/**
 * The auditLogs feature for one organization, read fresh from the features
 * registry (one query). Callers check env.auditCaptureEnabled first; appends
 * recheck it with a fresh, unlocked read (readAuditAvailability).
 */
export function auditLogsFeatureEnabled(organizationId: string): Promise<boolean> {
  return organizationFeatureEnabled(organizationId, "auditLogs")
}

async function organizationExists(organizationId: string): Promise<boolean> {
  const [row] = await db.select({ id: OrganizationTable.id }).from(OrganizationTable).where(eq(OrganizationTable.id, normalizeDenTypeId("organization", organizationId))).limit(1)
  return Boolean(row)
}

function safeOrganizationId(value: string | undefined | null) {
  if (!value) return null
  try { return normalizeDenTypeId("organization", value) } catch { return null }
}

function stateFor(c: Context) {
  return states.get(c) ?? null
}

/** The request id of the enclosing den-api request (also inside MCP tool handlers), if any. */
export function currentAuditRequestId(): string | null {
  return requestStore.getStore()?.requestId ?? null
}

/**
 * Change capture of the enclosing request for service code without a Hono
 * context. With `organizationId`, null unless the request is captured for that
 * same organization (a cross-organization effect falls back to the legacy row).
 */
export function currentAuditChangeCapture(organizationId?: string): AuditChangeCapture | null {
  const state = requestStore.getStore()
  const capture = state ? changeCaptureOf(state) : null
  if (!capture || organizationId === undefined) return capture
  return safeOrganizationId(organizationId) === capture.context.organizationId ? capture : null
}


function changeCaptureOf(state: AuditRequestState): AuditChangeCapture | null {
  const capture = state.capture
  return capture && capture.policy.categories.includes("change") ? { context: { ...capture.context }, policy: capture.policy } : null
}

function declarationForTemplate(c: Context, template: string): ResolvedDeclaration | null {
  if (template === `${BETTER_AUTH_BASE_PATH}/*`) {
    const endpoint = findBetterAuthDeclaration(c.req.method, c.req.path)
    if (endpoint) return endpoint
  }
  const declaration = findAuditRouteDeclaration(c.req.method, template)
  return declaration && declaration.class !== "support" ? { declaration, params: {} } : null
}

function resolveDeclaration(c: Context): ResolvedDeclaration | null {
  const template = routePath(c)
  if (!template) return null
  const direct = declarationForTemplate(c, template)
  if (direct || c.req.method.toUpperCase() === "OPTIONS") return direct
  // The request ended in an app.use entry (support/undeclared): either nothing
  // matched (unmatched 404, access log only) or a middleware such as
  // preclaimScopeMiddleware short-circuited before the endpoint ran. Attribute
  // the latter to the first declared endpoint matched after it (the route that
  // would have responded; never index -1, see overlapping routes).
  const routes = matchedRoutes(c)
  for (let index = c.req.routeIndex + 1; index < routes.length; index++) {
    const path = routes[index]?.path
    if (!path || path === template) continue
    const resolved = declarationForTemplate(c, path)
    if (resolved) return resolved
  }
  return null
}

function stateDeclaration(c: Context, state: AuditRequestState) {
  if (state.resolved === undefined) state.resolved = resolveDeclaration(c)
  return state.resolved
}

function resourceIdFor(c: Context, resolved: ResolvedDeclaration): string | null {
  const name = resolved.declaration.resource.idParam
  if (!name) return null
  return auditResourceId(resolved.params[name] ?? c.req.param(name))
}

// Content headers of the withheld response; every other header (CORS, security,
// Vary…) is kept on the 503 so browsers can read it.
const CONTENT_HEADERS = ["content-type", "content-length", "content-encoding", "content-disposition", "etag"] as const

/** 503 audit_unavailable sent instead of running the handler; keeps the context's non-content headers. */
function unavailable(c: Context) {
  for (const name of CONTENT_HEADERS) c.header(name, undefined)
  c.header("Cache-Control", "no-store")
  return c.json({ error: "audit_unavailable" }, 503)
}

/**
 * Target plus organization parent. When the target is the organization itself
 * the parent reference would repeat it, so it is omitted.
 */
export function auditTargetResources(type: string, id: string | null, organizationId: string): AuditRequestResource[] {
  const target: AuditRequestResource = { type, id: id ?? `collection:${type}`, relationship: "target" }
  return type === "organization" && target.id === organizationId ? [target] : [target, { type: "organization", id: organizationId, relationship: "parent" }]
}

function eventResources(declaration: AuditRouteDeclaration, organizationId: string, resourceId: string | null, extra: readonly AuditRequestResource[] = []): AuditEventInput["resources"] {
  const resources = auditTargetResources(declaration.resource.type, resourceId, organizationId)
  for (const resource of extra) {
    if (!resources.some((entry) => entry.type === resource.type && entry.id === resource.id && entry.relationship === resource.relationship)) resources.push(resource)
  }
  return resources
}

async function startTenantCapture(c: Context, state: AuditRequestState, resolved: ResolvedDeclaration, tenant: TenantAttribution, phase: "before" | "after" = "before", refusal: AuditRequestAttribution["refusal"] = undefined): Promise<Response | null> {
  const declaration = resolved.declaration
  if (!isTenantAuditClass(declaration.class)) return null
  state.began = true
  state.tenant = tenant
  if (refusal) state.refusalReasonCode = refusal.reasonCode
  if (!tenant.flagged || !env.auditCaptureEnabled) return null
  const auditClass = declaration.class
  try {
    const policy = await readEffectiveAuditPolicyWithRetry(tenant.organizationId)
    if (!policy) return null
    const resourceId = resourceIdFor(c, resolved)
    state.resourceId = resourceId
    state.capture = {
      policy,
      context: {
        organizationId: tenant.organizationId, actor: tenant.actor, principalKey: tenant.principalKey, origin: tenant.origin, originTrust: "authenticated",
        requestId: state.requestId, kind: declaration.kind, scope: resourceId ?? tenant.organizationId,
      },
    }
    const category = auditClassCategory(auditClass)
    state.requestCategory = policy.categories.includes(category) ? category : null
    if (state.requestCategory && auditClassNeedsIntent(auditClass) && !refusal) {
      await appendAuditEventInOwnTransaction(state.capture, {
        action: `${declaration.action}.requested`, category: state.requestCategory, outcome: "unknown",
        resources: eventResources(declaration, tenant.organizationId, resourceId),
        http: { method: c.req.method.toUpperCase(), route: declaration.path }, idempotencyKey: `${state.requestId}:requested`,
      })
      state.intentRecorded = true
    }
    return null
  } catch (error) {
    state.capture = null
    state.requestCategory = null
    if (!auditClassNeedsIntent(auditClass)) {
      // Reads and signals need no intent: a capture-start failure (policy read,
      // lock timeout) serves the request without capture rather than refusing it.
      logger.warn("audit capture unavailable; request served without capture", {
        request_id: state.requestId, organization_id: tenant.organizationId, audit_action: declaration.action, http_route: declaration.path, error_name: errorName(error),
      })
      return null
    }
    if (phase === "after" || refusal) {
      logAuditOutcomeLost({ requestId: state.requestId, organizationId: tenant.organizationId, action: `${declaration.action}.requested`, route: declaration.path, method: c.req.method, error })
      return null
    }
    // Unknown capture state or lost intent: fail closed, the handler never runs.
    state.blocked = true
    logger.warn("audit request intent unavailable; request refused", {
      request_id: state.requestId, organization_id: tenant.organizationId, audit_action: declaration.action, http_route: declaration.path, error_name: errorName(error),
    })
    return unavailable(c)
  }
}

type VerifiedMembership = Readonly<{ organizationId: string; userId: string; memberId: string }>

function memberTenant(c: Context, state: AuditRequestState, membership: VerifiedMembership, flagged: boolean): TenantAttribution {
  const apiKey: DenApiKeySession | null | undefined = c.get("apiKey")
  // API key first; an MCP-internal re-entry names the MCP grant/client instead.
  const credentialId = apiKey?.id ?? (state.origin === "mcp" ? state.mcpCredentialId : null)
  const keyPart = apiKey?.id ?? (credentialId ? `mcp:${credentialId}` : null)
  return {
    organizationId: membership.organizationId,
    actor: { type: "user", id: membership.userId, memberId: membership.memberId, ...(credentialId ? { credentialId } : {}) },
    principalKey: auditUserPrincipalKey({ userId: membership.userId, memberId: membership.memberId, credentialId: keyPart }),
    origin: state.origin,
    flagged,
  }
}

function orgContextTenant(c: Context, state: AuditRequestState, organization: OrganizationContext): TenantAttribution {
  const member = organization.currentMember
  // Features were read with the organization context in this request: no extra query.
  return memberTenant(c, state, { organizationId: organization.organization.id, userId: member.userId, memberId: member.id }, organization.features.auditLogs)
}

function pathTenantBase(c: Context, declaration: AuditRouteDeclaration, adminUserId: string): Omit<TenantAttribution, "flagged"> | null {
  const organizationId = safeOrganizationId(c.req.param(declaration.attribution.slice("path:".length)))
  if (!organizationId) return null
  const actor: AuditActor = { type: "user", id: adminUserId }
  return { organizationId, actor, principalKey: `user:${adminUserId}:platform_admin`, origin: "platform_admin" }
}

/**
 * Pre-handler hook. Called by resolveOrganizationContextMiddleware and
 * cloudTransportRoute right before `next()`, and by the platform-admin guard
 * (`platformAdminUserId`) for `path:<param>` attribution. Returns a 503
 * response to send instead of running the handler, or null to continue.
 */
export async function beginAuditRequest(c: Context, options: { origin?: AuditOrigin; platformAdminUserId?: string } = {}): Promise<Response | null> {
  const state = stateFor(c)
  if (!state) return null
  if (options.origin) state.origin = options.origin
  if (options.platformAdminUserId) {
    try { state.platformAdminUserId = normalizeDenTypeId("user", options.platformAdminUserId) } catch { state.platformAdminUserId = null }
  }
  if (state.began) return state.blocked ? unavailable(c) : null
  // Inside route middleware the current route index is the handler's route.
  const resolved = resolveDeclaration(c)
  if (!resolved) return null
  state.resolved = resolved
  const declaration = resolved.declaration
  if (!isTenantAuditClass(declaration.class)) return null
  if (declaration.attribution === "org_context") {
    const organization: OrganizationContext | undefined = c.get("organizationContext")
    return organization ? startTenantCapture(c, state, resolved, orgContextTenant(c, state, organization)) : null
  }
  if (declaration.attribution.startsWith("path:") && state.platformAdminUserId) {
    const base = pathTenantBase(c, declaration, state.platformAdminUserId)
    if (!base) return null
    if (!env.auditCaptureEnabled) return startTenantCapture(c, state, resolved, { ...base, flagged: false })
    try {
      const flagged = await auditLogsFeatureEnabled(base.organizationId)
      // The path id is admin input: an organization that does not exist is never a tenant.
      if (flagged && !(await organizationExists(base.organizationId))) return null
      return startTenantCapture(c, state, resolved, { ...base, flagged })
    } catch (error) {
      if (!auditClassNeedsIntent(declaration.class)) {
        // Reads and signals continue without capture.
        logger.warn("audit platform-admin attribution unavailable; request served without capture", { request_id: state.requestId, http_route: declaration.path, error_name: errorName(error) })
        return startTenantCapture(c, state, resolved, { ...base, flagged: false })
      }
      state.blocked = true
      logger.warn("audit platform-admin attribution unavailable; request refused", { request_id: state.requestId, http_route: declaration.path, error_name: errorName(error) })
      return unavailable(c)
    }
  }
  return null
}

/**
 * Pre-handler hook for orgMemberRoute({ useUserOrganizations: true }) routes
 * (declared org_context): resolveUserOrganizationsMiddleware has no
 * organizationContext, but its active organization is one of the caller's
 * verified memberships, which carries the member id. Its auditLogs feature is
 * read once, only when the route is tenant-captured and capture is on.
 */
export async function beginUserOrganizationsAuditRequest(c: Context, membership: VerifiedMembership): Promise<Response | null> {
  const state = stateFor(c)
  if (!state) return null
  if (state.began) return state.blocked ? unavailable(c) : null
  const resolved = resolveDeclaration(c)
  if (!resolved) return null
  state.resolved = resolved
  if (!isTenantAuditClass(resolved.declaration.class) || resolved.declaration.attribution !== "org_context") return null
  const organizationId = safeOrganizationId(membership.organizationId)
  if (!organizationId) return null
  const flag = await resolveAuditLogsFlag(c, state, resolved.declaration.path, resolved.declaration.class, organizationId)
  if (!flag.ok) return flag.response
  return startTenantCapture(c, state, resolved, memberTenant(c, state, { ...membership, organizationId }, flag.flagged))
}

/**
 * auditLogs for a verified tenant outside org-context routes, read only after
 * the deployment capture switch passes. A read failure refuses requests that
 * need durable intent (503) and serves the others without capture.
 */
async function resolveAuditLogsFlag(c: Context, state: AuditRequestState, route: string, auditClass: TenantAuditClass, organizationId: string, refusal: AuditRequestAttribution["refusal"] = undefined): Promise<{ ok: true; flagged: boolean } | { ok: false; response: Response }> {
  if (!env.auditCaptureEnabled) return { ok: true, flagged: false }
  try {
    return { ok: true, flagged: await auditLogsFeatureEnabled(organizationId) }
  } catch (error) {
    if (auditClassNeedsIntent(auditClass) && !refusal) {
      state.blocked = true
      logger.warn("audit tenant attribution unavailable; request refused", { request_id: state.requestId, http_route: route, error_name: errorName(error) })
      return { ok: false, response: unavailable(c) }
    }
    // Reads and signals continue without capture (the tenant stays known, nothing is recorded).
    logger.warn("audit tenant attribution unavailable; request served without capture", { request_id: state.requestId, http_route: route, error_name: errorName(error) })
    return { ok: true, flagged: false }
  }
}

/**
 * Attaches a resource the handler created or started (worker, automation run,
 * invitation…) to this request's outcome event. The id must be a validated
 * identifier (same pattern as path parameters); at most a few per request.
 * Only recorded when the request is tenant-captured, or as the platform
 * record's target (the first entry; an organization entry only when it equals
 * the request's authenticated organization context).
 */
export function addAuditRequestResource(c: Context, resource: Readonly<{ type: string; id: string | null | undefined; relationship?: "target" | "related" }>): void {
  const state = stateFor(c)
  if (!state || !resource.id || !resourceIdPattern.test(resource.id) || !resourceTypePattern.test(resource.type)) return
  if (state.extraResources.length >= MAX_EXTRA_RESOURCES) return
  const entry: AuditRequestResource = { type: resource.type, id: resource.id, relationship: resource.relationship ?? "related" }
  if (!state.extraResources.some((existing) => existing.type === entry.type && existing.id === entry.id && existing.relationship === entry.relationship)) state.extraResources.push(entry)
}

/**
 * Handler attribution for routes declared `attribution: "handler"` (SCIM,
 * runner/worker tokens, webhooks, install links, SSO callbacks…). Call ONLY
 * after the token/signature has been verified. `{ ok: false }` carries the 503
 * to return without performing the action.
 */
export async function attributeAuditRequest(c: Context, input: AuditRequestAttribution): Promise<{ ok: true } | { ok: false; response: Response }> {
  const state = stateFor(c)
  if (!state) return { ok: true }
  if (state.began) return state.blocked ? { ok: false, response: unavailable(c) } : { ok: true }
  const resolved = stateDeclaration(c, state)
  if (!resolved || !isTenantAuditClass(resolved.declaration.class)) return { ok: true }
  const organizationId = safeOrganizationId(input.organizationId)
  if (!organizationId) return { ok: true }
  const base = { organizationId, actor: input.actor, principalKey: input.principalKey, origin: input.origin ?? state.origin }
  // Always the verified organization's own feature state (never caller-supplied).
  const flag = await resolveAuditLogsFlag(c, state, resolved.declaration.path, resolved.declaration.class, organizationId, input.refusal)
  if (!flag.ok) return flag
  const tenant: TenantAttribution = { ...base, flagged: flag.flagged }
  const blocked = await startTenantCapture(c, state, resolved, tenant, input.phase, input.refusal)
  return blocked ? { ok: false, response: blocked } : { ok: true }
}

/**
 * attributeAuditRequest for code without the Hono context (better-auth hooks),
 * via the request's AsyncLocalStorage state. Only acts when the current request
 * is a better-auth endpoint served by the `/api/auth/*` catch-all, so a Den
 * route calling auth.api server-side can never be re-attributed by a hook.
 */
export async function attributeCurrentAuditRequest(input: AuditRequestAttribution): Promise<{ ok: true } | { ok: false; response: Response }> {
  const state = requestStore.getStore()
  if (!state) return { ok: true }
  const resolved = stateDeclaration(state.context, state)
  if (!resolved || !resolved.declaration.path.startsWith(`${BETTER_AUTH_BASE_PATH}/`)) return { ok: true }
  // The catch-all, or a Den route registered at the endpoint's own path that
  // forwards to auth.handler (GET /api/auth/oauth2/authorize).
  const template = routePath(state.context)
  if (template !== `${BETTER_AUTH_BASE_PATH}/*` && template !== resolved.declaration.path) return { ok: true }
  return attributeAuditRequest(state.context, input)
}

/**
 * Opaque identity of the enclosing den-api request (its audit state), for
 * request-scoped notes kept in a WeakMap by better-auth hooks; null outside a request.
 */
export function currentAuditRequestKey(): object | null {
  return requestStore.getStore() ?? null
}

/** Domain change evidence for the current request, or null when capture/change category is off. */
export function auditChangeCapture(c: Context): AuditChangeCapture | null {
  const state = stateFor(c)
  return state ? changeCaptureOf(state) : null
}

export type AuditChangeEventInput = Omit<AuditEventInput, "category" | "outcome"> & Partial<Pick<AuditEventInput, "category" | "outcome">>

/**
 * Appends change events (default category "change", outcome "succeeded") into
 * the caller's business transaction. Audit takes no locks of its own: it only
 * inserts this request's rows and bumps its own operation row. Any failure
 * throws and must roll back the business mutation. Never retried by
 * withAuditRetry (a retry would re-run the business mutation): a deadlock here
 * rolls the mutation back exactly as before. Emit nothing when before
 * equals after. Returns the appended event ids.
 */
export async function appendAuditChanges(tx: AuditTx, capture: AuditChangeCapture | null, events: readonly AuditChangeEventInput[]): Promise<string[]> {
  if (!capture || events.length === 0) return []
  // Never write another organization's evidence into this organization's log.
  const organizationId = capture.context.organizationId
  if (events.some((event) => event.resources.some((resource) => resource.type === "organization" && resource.id !== organizationId))) throw new AuditLogError("audit_invalid_input")
  await recheckAuditEntitlement(tx, capture.context.organizationId)
  const ids: string[] = []
  for (const event of events) {
    const appended = await appendAuditEvent(tx, { context: capture.context, policy: capture.policy, event: { ...event, category: event.category ?? "change", outcome: event.outcome ?? "succeeded" } })
    if (!appended && (event.category ?? "change") === "change") throw new AuditLogError("audit_storage_inconsistent")
    if (appended) ids.push(appended.id)
  }
  return ids
}

async function replaceWithUnavailable(c: Context) {
  const original = c.res
  const headers = new Headers(original.headers)
  for (const name of CONTENT_HEADERS) headers.delete(name)
  headers.set("Content-Type", "application/json")
  headers.set("Cache-Control", "no-store")
  c.res = undefined
  c.res = new Response(JSON.stringify({ error: "audit_unavailable" }), { status: 503, headers })
  await original.body?.cancel().catch(() => undefined)
}

async function recordTenantOutcome(c: Context, state: AuditRequestState, resolved: ResolvedDeclaration, auditClass: TenantAuditClass, capture: AuditChangeCapture, status: number) {
  const declaration = resolved.declaration
  const mapped = auditRequestOutcome(auditClass, status)
  const category = mapped.denied && capture.policy.categories.includes("security") ? "security" : state.requestCategory
  if (!category) return
  const reasonCode = mapped.denied && state.refusalReasonCode ? state.refusalReasonCode : mapped.reasonCode
  const event: AuditEventInput = {
    action: `${declaration.action}.${mapped.suffix}`, category, outcome: mapped.outcome,
    resources: eventResources(declaration, capture.context.organizationId, state.resourceId, state.extraResources),
    ...(reasonCode ? { reasonCode } : {}),
    http: { method: c.req.method.toUpperCase(), route: declaration.path, status }, idempotencyKey: `${state.requestId}:outcome`,
  }
  const releaseGated = (auditClass === "tenant_read" || auditClass === "tenant_access") && mapped.outcome === "succeeded"
  try {
    await appendAuditEventInOwnTransaction(capture, event, auditOperationOutcome(mapped.outcome))
  } catch (error) {
    if (releaseGated) {
      // Served evidence is a release precondition: no content without it.
      logger.warn("audit served evidence unavailable; response withheld", { request_id: state.requestId, organization_id: capture.context.organizationId, audit_action: event.action, http_route: declaration.path, error_name: errorName(error) })
      await replaceWithUnavailable(c)
      return
    }
    logAuditOutcomeLost({ requestId: state.requestId, organizationId: capture.context.organizationId, action: event.action, route: declaration.path, method: c.req.method, error })
    // The request itself turned tenant capture off (auditLogs feature override off,
    // plan without the entitlement) after its intent was recorded: keep the
    // outcome as platform evidence targeting the verified organization.
    if (state.intentRecorded && state.tenant && error instanceof AuditLogError && error.code === "audit_policy_changed") {
      await writePlatformEvent(state, {
        method: c.req.method.toUpperCase(), route: declaration.path, action: event.action, outcome: mapped.outcome, status,
        reasonCode: mapped.reasonCode ?? "tenant_audit_disabled", actor: platformActorOf(state.tenant.actor),
        origin: state.tenant.origin, target: { type: "organization", id: state.tenant.organizationId },
      })
    }
  }
}

type PlatformEventFields = Omit<PlatformAuditEventInput, "requestId" | "occurredAt">

/** Deployment-wide platformAuditReads feature (no organization applies); a failed read counts as off. */
async function platformAuditReadsEnabled(): Promise<boolean> {
  try {
    return await deploymentFeatureEnabled("platformAuditReads")
  } catch (error) {
    logger.warn("platformAuditReads feature unavailable; read-only platform success not recorded", { error_name: errorName(error) })
    return false
  }
}

export function platformActorOf(actor: AuditActor): PlatformAuditEventInput["actor"] {
  if ((actor.type === "user" || actor.type === "service") && actor.id) return { type: actor.type, id: actor.id, credentialId: actor.credentialId ?? null }
  return { type: "unknown", id: null }
}

async function writePlatformEvent(state: AuditRequestState, fields: PlatformEventFields): Promise<void> {
  await writePlatformAuditEvent(state.requestId, fields)
}

/**
 * Platform-store write that never throws: retried on transient failures, then a
 * failed insert is logged [platform-audit-lost]. The row id is generated once,
 * so a retry after an ambiguous commit hits the primary key and is recognised
 * as already written instead of inserting a duplicate.
 */
export async function writePlatformAuditEvent(requestId: string | null, fields: PlatformEventFields): Promise<void> {
  const id = createDenTypeId("platformAuditEvent")
  try {
    await withAuditRetry(async (attempt) => {
      try {
        await appendPlatformAuditEvent(db, { requestId, ...fields, id })
      } catch (error) {
        if (attempt > 1 && await platformAuditEventExists(id)) return
        throw error
      }
    }, { label: fields.action, idempotent: true, requestId })
  } catch (error) {
    logger.warn(`${PLATFORM_AUDIT_LOST_OPERATIONAL_MARKER} platform audit event not recorded`, {
      operational_marker: PLATFORM_AUDIT_LOST_OPERATIONAL_MARKER, request_id: requestId, audit_action: fields.action, http_route: fields.route, http_method: fields.method, error_name: errorName(error),
    })
  }
}

async function platformAuditEventExists(id: string): Promise<boolean> {
  const [row] = await db.select({ id: PlatformAuditEventTable.id }).from(PlatformAuditEventTable).where(eq(PlatformAuditEventTable.id, normalizeDenTypeId("platformAuditEvent", id))).limit(1)
  return Boolean(row)
}

/** The organization of the request's authenticated context (verified tenant attribution or organizationContext), never request input. */
function trustedOrganizationId(c: Context, state: AuditRequestState): string | null {
  const organization: OrganizationContext | undefined = c.get("organizationContext")
  return safeOrganizationId(state.tenant?.organizationId ?? organization?.organization.id)
}

/**
 * Platform record target: the declared resource type with its validated path id,
 * else the first handler-named resource (addAuditRequestResource). Only the
 * declared idParam is ever read. An organization target only ever carries the
 * authenticated context's organization id; any other id is dropped.
 */
function platformTarget(c: Context, state: AuditRequestState, resolved: ResolvedDeclaration): NonNullable<PlatformAuditEventInput["target"]> {
  const declaration = resolved.declaration
  const pathId = resourceIdFor(c, resolved)
  const extra = state.extraResources.find((entry) => entry.relationship === "target") ?? state.extraResources[0]
  const candidate = pathId ? { type: declaration.resource.type, id: pathId } : extra ? { type: extra.type, id: extra.id } : { type: declaration.resource.type, id: null }
  if (candidate.type !== "organization") return candidate
  // Organization targets: only the authenticated context's own organization
  // (e.g. DELETE /v1/org refused after organization resolution), never input.
  const trusted = trustedOrganizationId(c, state)
  return { type: candidate.type, id: candidate.id === null || candidate.id === trusted ? trusted : null }
}

async function recordPlatform(c: Context, state: AuditRequestState, resolved: ResolvedDeclaration, auditClass: TenantAuditClass | "platform", status: number): Promise<void> {
  if (!env.auditCaptureEnabled) return
  const declaration = resolved.declaration
  const method = c.req.method.toUpperCase()
  const mapped = auditRequestOutcome(auditClass, status)
  // Filter by effect, not method: only side-effect-free platform reads are optional.
  if (mapped.outcome === "succeeded" && declaration.readOnly === true && !(await platformAuditReadsEnabled())) return
  const user: AuthContextVariables["user"] | undefined = c.get("user")
  const apiKey: DenApiKeySession | null | undefined = c.get("apiKey")
  let userId: string | null = null
  try { userId = user?.id ? normalizeDenTypeId("user", user.id) : null } catch { userId = null }
  // Durable before the response is released (e.g. DELETE /v1/org evidence), yet
  // never refuses it: a failed insert is logged [platform-audit-lost].
  await writePlatformEvent(state, {
    method, route: declaration.path, action: `${declaration.action}.${mapped.suffix}`, outcome: mapped.outcome, status, reasonCode: mapped.reasonCode ?? null,
    actor: userId ? { type: "user", id: userId, credentialId: apiKey?.id ?? null } : { type: "unknown", id: null },
    origin: state.platformAdminUserId ? "platform_admin" : state.origin,
    target: platformTarget(c, state, resolved),
  })
}

async function finishAuditRequest(c: Context, state: AuditRequestState) {
  if (state.blocked) return
  let resolved: ResolvedDeclaration | null = null
  try {
    resolved = state.resolved ?? resolveDeclaration(c)
    if (!resolved) return
    const declaration = resolved.declaration
    const status = c.res.status
    // Class platform, including attribution "user_memberships": the request record stays in
    // the platform store; that declaration's domain emitter appends the user's tenant events.
    if (declaration.class === "platform") return await recordPlatform(c, state, resolved, "platform", status)
    if (!isTenantAuditClass(declaration.class)) return
    if (!state.tenant) return await recordPlatform(c, state, resolved, declaration.class, status)
    if (state.capture) await recordTenantOutcome(c, state, resolved, declaration.class, state.capture, status)
  } catch (error) {
    logAuditOutcomeLost({ requestId: state.requestId, organizationId: state.tenant?.organizationId ?? "none", action: resolved?.declaration.action ?? "unresolved", route: resolved?.declaration.path, method: c.req.method, error })
  }
}

/** `grant:<id>` / `run_token:<id>` / `client:<id>` from the signed internal principal (mcp-service-audit parity). */
function mcpInternalCredentialId(headers: Headers): string | null {
  const value = readInternalMcpPrincipalCredentialId(headers)
  return value && credentialIdPattern.test(value) ? value : null
}

/**
 * Global middleware registered right after sessionMiddleware, before preclaim. Creates
 * the per-request state (AsyncLocalStorage, so a nested app.fetch from MCP or a
 * proxy gets its own state with `parent` set) and records the outcome after the
 * handler. MCP-internal re-entry (session "mcp_internal") is origin "mcp".
 */
export const auditRequestMiddleware: MiddlewareHandler = async (c, next) => {
  const session: AuthContextVariables["session"] | undefined = c.get("session")
  const requestId: unknown = c.get("requestId")
  const state: AuditRequestState = {
    context: c,
    requestId: typeof requestId === "string" && requestId ? requestId : createDenTypeId("request"),
    parent: requestStore.getStore() ?? null,
    origin: session?.id === "mcp_internal" ? "mcp" : "api",
    resolved: undefined, tenant: null, capture: null, requestCategory: null, resourceId: null,
    began: false, blocked: false, intentRecorded: false, platformAdminUserId: null,
    mcpCredentialId: session?.id === "mcp_internal" ? mcpInternalCredentialId(c.req.raw.headers) : null,
    extraResources: [], refusalReasonCode: null,
  }
  states.set(c, state)
  await requestStore.run(state, next)
  await finishAuditRequest(c, state)
}
