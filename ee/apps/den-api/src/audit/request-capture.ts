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
import { getAuditEntitlement } from "../entitlements.js"
import { appLogger } from "../observability/logger.js"
import { AUDIT_OUTCOME_LOST_OPERATIONAL_MARKER, PLATFORM_AUDIT_LOST_OPERATIONAL_MARKER } from "../operational-log-markers.js"
import type { OrganizationContext } from "../orgs.js"
import { readInternalMcpPrincipalCredentialId, type AuthContextVariables } from "../session.js"
import { readEffectiveAuditPolicy, recheckAuditEntitlement } from "./capture.js"
import { withAuditRetry } from "./retry.js"
import { BETTER_AUTH_BASE_PATH, findAuditRouteDeclaration, findBetterAuthDeclaration, type AuditRouteClass, type AuditRouteDeclaration } from "./routes/index.js"

export type TenantAuditClass = Extract<AuditRouteClass, "tenant_read" | "tenant_access" | "tenant_change" | "tenant_external" | "tenant_job" | "tenant_signal">
export type AuditChangeCapture = Readonly<{ context: AuditContext; policy: AuditPolicy }>
export type AuditRequestAttribution = Readonly<{
  organizationId: string
  actor: AuditActor
  principalKey: string
  origin?: AuditOrigin
  phase?: "before" | "after"
  refusal?: Readonly<{ reasonCode: string }>
}>
type TenantAttribution = { organizationId: string; actor: AuditActor; principalKey: string; origin: AuditOrigin; entitled?: boolean }
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
  intentRecorded: boolean
  platformAdminUserId: string | null
  mcpCredentialId: string | null
  extraResources: AuditRequestResource[]
  refusalReasonCode: string | null
}

const logger = appLogger.child({ component: "audit_request" })
const requestStore = new AsyncLocalStorage<AuditRequestState>()
const jobChangeCaptureStore = new AsyncLocalStorage<{ capture: AuditChangeCapture | null }>()
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

export function auditClassCategory(value: TenantAuditClass): AuditCategory {
  return value === "tenant_read" || value === "tenant_signal" ? "read" : value === "tenant_access" ? "access" : value === "tenant_job" ? "execution" : "request"
}

export function auditClassNeedsIntent(value: TenantAuditClass): boolean {
  return value !== "tenant_read" && value !== "tenant_signal"
}

export type AuditRequestOutcome = Readonly<{ suffix: string; outcome: AuditEventInput["outcome"]; reasonCode?: string; denied: boolean }>

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

export function auditOperationOutcome(outcome: AuditEventInput["outcome"]): AuditOperationOutcome {
  return outcome === "succeeded" ? "succeeded" : outcome === "unknown" ? "unknown" : "failed"
}

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

export function auditServiceAttribution(name: string, id: string | null, options: { memberId?: string | null; credentialId?: string | null } = {}): Pick<AuditRequestAttribution, "actor" | "principalKey"> {
  const serviceId = id === null ? name : `${name}:${auditResourceId(id)}`
  const memberId = safeTypeId("member", options.memberId)
  const credentialId = options.credentialId && credentialIdPattern.test(options.credentialId) ? options.credentialId : null
  return {
    actor: { type: "service", id: serviceId, ...(memberId ? { memberId } : {}), ...(credentialId ? { credentialId } : {}) },
    principalKey: `service:${serviceId}${memberId ? `:member:${memberId}` : ""}${credentialId ? `:key:${credentialId}` : ""}`,
  }
}

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

export async function appendRequiredAuditEvent(tx: AuditTx, capture: AuditChangeCapture, event: AuditEventInput, operationOutcome?: AuditOperationOutcome) {
  await recheckAuditEntitlement(tx, capture.context.organizationId)
  const appended = await appendAuditEvent(tx, { context: capture.context, policy: capture.policy, event, ...(operationOutcome ? { operationOutcome } : {}) })
  if (!appended) throw new AuditLogError("audit_storage_inconsistent")
  return appended
}

export function auditAppendIsIdempotent(context: AuditContext, event: Pick<AuditEventInput, "idempotencyKey">): boolean {
  return event.idempotencyKey !== undefined && Boolean(context.requestId || context.jobRunId)
}

export async function appendAuditEventInOwnTransaction(capture: AuditChangeCapture, event: AuditEventInput, operationOutcome?: AuditOperationOutcome) {
  return withAuditRetry(() => db.transaction((tx) => appendRequiredAuditEvent(tx, capture, event, operationOutcome)), {
    label: event.action, idempotent: auditAppendIsIdempotent(capture.context, event), requestId: capture.context.requestId ?? null, organizationId: capture.context.organizationId,
  })
}

export function readEffectiveAuditPolicyWithRetry(organizationId: string) {
  return withAuditRetry(() => readEffectiveAuditPolicy(db, organizationId, true), { label: "audit.policy.read", idempotent: true, organizationId })
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

export function currentAuditRequestId(): string | null {
  return requestStore.getStore()?.requestId ?? null
}

export function currentAuditChangeCapture(organizationId?: string): AuditChangeCapture | null {
  const state = requestStore.getStore()
  const capture = state ? changeCaptureOf(state) : jobChangeCapture()
  if (!capture || organizationId === undefined) return capture
  return safeOrganizationId(organizationId) === capture.context.organizationId ? capture : null
}


export function runWithAuditJobChangeCapture<T>(capture: AuditChangeCapture | null, fn: () => Promise<T>): Promise<T> {
  if (capture && (!capture.context.jobRunId || capture.context.requestId !== null)) throw new AuditLogError("audit_invalid_input")
  return jobChangeCaptureStore.run({ capture }, fn)
}

function jobChangeCapture(): AuditChangeCapture | null {
  const capture = jobChangeCaptureStore.getStore()?.capture ?? null
  return capture && capture.policy.categories.includes("change") ? { context: { ...capture.context }, policy: capture.policy } : null
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

const CONTENT_HEADERS = ["content-type", "content-length", "content-encoding", "content-disposition", "etag"] as const

function unavailable(c: Context) {
  for (const name of CONTENT_HEADERS) c.header(name, undefined)
  c.header("Cache-Control", "no-store")
  return c.json({ error: "audit_unavailable" }, 503)
}

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
  if (!env.auditCaptureEnabled || tenant.entitled === false) return null
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
      logger.warn("audit capture unavailable; request served without capture", {
        request_id: state.requestId, organization_id: tenant.organizationId, audit_action: declaration.action, http_route: declaration.path, error_name: errorName(error),
      })
      return null
    }
    if (phase === "after" || refusal) {
      logAuditOutcomeLost({ requestId: state.requestId, organizationId: tenant.organizationId, action: `${declaration.action}.requested`, route: declaration.path, method: c.req.method, error })
      return null
    }
    state.blocked = true
    logger.warn("audit request intent unavailable; request refused", {
      request_id: state.requestId, organization_id: tenant.organizationId, audit_action: declaration.action, http_route: declaration.path, error_name: errorName(error),
    })
    return unavailable(c)
  }
}

type VerifiedMembership = Readonly<{ organizationId: string; userId: string; memberId: string }>

function memberTenant(c: Context, state: AuditRequestState, membership: VerifiedMembership): TenantAttribution {
  const apiKey: DenApiKeySession | null | undefined = c.get("apiKey")
  const credentialId = apiKey?.id ?? (state.origin === "mcp" ? state.mcpCredentialId : null)
  const keyPart = apiKey?.id ?? (credentialId ? `mcp:${credentialId}` : null)
  return {
    organizationId: membership.organizationId,
    actor: { type: "user", id: membership.userId, memberId: membership.memberId, ...(credentialId ? { credentialId } : {}) },
    principalKey: auditUserPrincipalKey({ userId: membership.userId, memberId: membership.memberId, credentialId: keyPart }),
    origin: state.origin,
  }
}

function orgContextTenant(c: Context, state: AuditRequestState, organization: OrganizationContext): TenantAttribution {
  const member = organization.currentMember
  const tenant = memberTenant(c, state, { organizationId: organization.organization.id, userId: member.userId, memberId: member.id })
  return { ...tenant, entitled: getAuditEntitlement(organization.organization.metadata).enabled }
}

function pathTenantBase(c: Context, declaration: AuditRouteDeclaration, adminUserId: string): TenantAttribution | null {
  const organizationId = safeOrganizationId(c.req.param(declaration.attribution.slice("path:".length)))
  if (!organizationId) return null
  const actor: AuditActor = { type: "user", id: adminUserId }
  return { organizationId, actor, principalKey: `user:${adminUserId}:platform_admin`, origin: "platform_admin" }
}

export async function beginAuditRequest(c: Context, options: { origin?: AuditOrigin; platformAdminUserId?: string } = {}): Promise<Response | null> {
  const state = stateFor(c)
  if (!state) return null
  if (options.origin) state.origin = options.origin
  if (options.platformAdminUserId) {
    try { state.platformAdminUserId = normalizeDenTypeId("user", options.platformAdminUserId) } catch { state.platformAdminUserId = null }
  }
  if (state.began) return state.blocked ? unavailable(c) : null
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
    if (!env.auditCaptureEnabled) return startTenantCapture(c, state, resolved, base)
    try {
      if (!(await organizationExists(base.organizationId))) return null
    } catch (error) {
      if (!auditClassNeedsIntent(declaration.class)) {
        logger.warn("audit platform-admin attribution unavailable; request served without capture", { request_id: state.requestId, http_route: declaration.path, error_name: errorName(error) })
        state.began = true
        state.tenant = base
        return null
      }
      state.blocked = true
      logger.warn("audit platform-admin attribution unavailable; request refused", { request_id: state.requestId, http_route: declaration.path, error_name: errorName(error) })
      return unavailable(c)
    }
    return startTenantCapture(c, state, resolved, base)
  }
  return null
}

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
  return startTenantCapture(c, state, resolved, memberTenant(c, state, { ...membership, organizationId }))
}

export function addAuditRequestResource(c: Context, resource: Readonly<{ type: string; id: string | null | undefined; relationship?: "target" | "related" }>): void {
  const state = stateFor(c)
  if (!state || !resource.id || !resourceIdPattern.test(resource.id) || !resourceTypePattern.test(resource.type)) return
  if (state.extraResources.length >= MAX_EXTRA_RESOURCES) return
  const entry: AuditRequestResource = { type: resource.type, id: resource.id, relationship: resource.relationship ?? "related" }
  if (!state.extraResources.some((existing) => existing.type === entry.type && existing.id === entry.id && existing.relationship === entry.relationship)) state.extraResources.push(entry)
}

export async function attributeAuditRequest(c: Context, input: AuditRequestAttribution): Promise<{ ok: true } | { ok: false; response: Response }> {
  const state = stateFor(c)
  if (!state) return { ok: true }
  if (state.began) return state.blocked ? { ok: false, response: unavailable(c) } : { ok: true }
  const resolved = stateDeclaration(c, state)
  if (!resolved || !isTenantAuditClass(resolved.declaration.class)) return { ok: true }
  const organizationId = safeOrganizationId(input.organizationId)
  if (!organizationId) return { ok: true }
  const tenant: TenantAttribution = { organizationId, actor: input.actor, principalKey: input.principalKey, origin: input.origin ?? state.origin }
  const blocked = await startTenantCapture(c, state, resolved, tenant, input.phase, input.refusal)
  return blocked ? { ok: false, response: blocked } : { ok: true }
}

export async function attributeCurrentAuditRequest(input: AuditRequestAttribution): Promise<{ ok: true } | { ok: false; response: Response }> {
  const state = requestStore.getStore()
  if (!state) return { ok: true }
  const resolved = stateDeclaration(state.context, state)
  if (!resolved || !resolved.declaration.path.startsWith(`${BETTER_AUTH_BASE_PATH}/`)) return { ok: true }
  const template = routePath(state.context)
  if (template !== `${BETTER_AUTH_BASE_PATH}/*` && template !== resolved.declaration.path) return { ok: true }
  return attributeAuditRequest(state.context, input)
}

export function currentAuditRequestKey(): object | null {
  return requestStore.getStore() ?? null
}

export function auditChangeCapture(c: Context): AuditChangeCapture | null {
  const state = stateFor(c)
  return state ? changeCaptureOf(state) : jobChangeCapture()
}

export type AuditChangeEventInput = Omit<AuditEventInput, "category" | "outcome"> & Partial<Pick<AuditEventInput, "category" | "outcome">>

export async function appendAuditChanges(tx: AuditTx, capture: AuditChangeCapture | null, events: readonly AuditChangeEventInput[]): Promise<string[]> {
  if (!capture || events.length === 0) return []
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
      logger.warn("audit served evidence unavailable; response withheld", { request_id: state.requestId, organization_id: capture.context.organizationId, audit_action: event.action, http_route: declaration.path, error_name: errorName(error) })
      await replaceWithUnavailable(c)
      return
    }
    logAuditOutcomeLost({ requestId: state.requestId, organizationId: capture.context.organizationId, action: event.action, route: declaration.path, method: c.req.method, error })
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

export function platformActorOf(actor: AuditActor): PlatformAuditEventInput["actor"] {
  if ((actor.type === "user" || actor.type === "service") && actor.id) return { type: actor.type, id: actor.id, credentialId: actor.credentialId ?? null }
  return { type: "unknown", id: null }
}

async function writePlatformEvent(state: AuditRequestState, fields: PlatformEventFields): Promise<void> {
  await writePlatformAuditEvent(state.requestId, fields)
}

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

function trustedOrganizationId(c: Context, state: AuditRequestState): string | null {
  const organization: OrganizationContext | undefined = c.get("organizationContext")
  return safeOrganizationId(state.tenant?.organizationId ?? organization?.organization.id)
}

function platformTarget(c: Context, state: AuditRequestState, resolved: ResolvedDeclaration): NonNullable<PlatformAuditEventInput["target"]> {
  const declaration = resolved.declaration
  const pathId = resourceIdFor(c, resolved)
  const extra = state.extraResources.find((entry) => entry.relationship === "target") ?? state.extraResources[0]
  const candidate = pathId ? { type: declaration.resource.type, id: pathId } : extra ? { type: extra.type, id: extra.id } : { type: declaration.resource.type, id: null }
  if (candidate.type !== "organization") return candidate
  const trusted = trustedOrganizationId(c, state)
  return { type: candidate.type, id: candidate.id === null || candidate.id === trusted ? trusted : null }
}

async function recordPlatform(c: Context, state: AuditRequestState, resolved: ResolvedDeclaration, auditClass: TenantAuditClass | "platform", status: number): Promise<void> {
  if (!env.auditCaptureEnabled) return
  const declaration = resolved.declaration
  const method = c.req.method.toUpperCase()
  const mapped = auditRequestOutcome(auditClass, status)
  const user: AuthContextVariables["user"] | undefined = c.get("user")
  const apiKey: DenApiKeySession | null | undefined = c.get("apiKey")
  let userId: string | null = null
  try { userId = user?.id ? normalizeDenTypeId("user", user.id) : null } catch { userId = null }
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
    if (declaration.class === "platform") return await recordPlatform(c, state, resolved, "platform", status)
    if (!isTenantAuditClass(declaration.class)) return
    if (!state.tenant) return await recordPlatform(c, state, resolved, declaration.class, status)
    if (state.capture) await recordTenantOutcome(c, state, resolved, declaration.class, state.capture, status)
  } catch (error) {
    logAuditOutcomeLost({ requestId: state.requestId, organizationId: state.tenant?.organizationId ?? "none", action: resolved?.declaration.action ?? "unresolved", route: resolved?.declaration.path, method: c.req.method, error })
  }
}

function mcpInternalCredentialId(headers: Headers): string | null {
  const value = readInternalMcpPrincipalCredentialId(headers)
  return value && credentialIdPattern.test(value) ? value : null
}

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
