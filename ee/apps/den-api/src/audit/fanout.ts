import type { AuditActor, AuditEventInput, AuditOrigin } from "@openwork-ee/den-db/audit-log"
import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { AuditCategory } from "@openwork/types/den/audit"
import { db } from "../db.js"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
import { getFeaturesForOrganizations } from "../features.js"
import { appendAuditEventInOwnTransaction, readEffectiveAuditPolicyWithRetry, auditOperationOutcome, auditUserPrincipalKey, currentAuditChangeCapture, auditLogsFeatureEnabled, currentAuditRequestId, logAuditOutcomeLost, type AuditChangeCapture } from "./request-capture.js"

// Events about a USER (sessions, account security, failed sign-ins) that have
// no single request tenant (attribution "user_memberships", src/audit/routes).
// They are appended into the user's verified active memberships: every
// membership (account fan-out, failed sign-ins) or the one organization a
// session belongs to (`organizationId`). Each organization gets its own
// operation and transaction (entitlement recheck + policy-current fence) and
// shares the request id, so the organization sees the request reference.
// Only organizations with the auditLogs feature (features registry), deployment capture, an
// enabled policy (lazy default allowed; entitlement checked there) and the
// event category store anything. A failure in one organization logs
// [audit-outcome-lost] and never fails the user's request or other organizations.

export type AuditUserMembership = Readonly<{ organizationId: string; memberId: string; userId: string }>
export type UserMembershipsAuditInput = Readonly<{
  userId: string
  /** Restrict to this organization (the session's); still requires an active membership in it. */
  organizationId?: string | null
  action: string
  kind: string
  category: AuditCategory
  outcome?: AuditEventInput["outcome"]
  /**
   * "member": the user with that organization's member id; "unknown":
   * unauthenticated attempt; `{ system }`: a Den process acting on the user
   * (credential revocation, bootstrap cleanup), never joined to a request operation.
   */
  actor: "member" | "unknown" | Readonly<{ system: string }>
  /** Operation scope (resource id); defaults to the user id. */
  scope?: string
  resources: (membership: AuditUserMembership) => AuditEventInput["resources"]
  changes?: AuditEventInput["changes"]
  reasonCode?: string
  /** Defaults to the enclosing den-api request id. */
  requestId?: string | null
  origin?: AuditOrigin
  /** Stable per-event discriminator; the idempotency key also carries the request id. */
  idempotencyDiscriminator?: string
}>

const logger = appLogger.child({ component: "audit_fanout" })
const UNKNOWN_ACTOR: AuditActor = { type: "unknown", id: null }

function typeIdOrNull<T extends "user" | "organization">(kind: T, value: string | null | undefined) {
  if (!value) return null
  try { return normalizeDenTypeId(kind, value) } catch { return null }
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : typeof error
}

/** Active memberships (one query). */
async function activeMemberships(userId: string, organizationId: string | null) {
  const user = normalizeDenTypeId("user", userId)
  const filters = [eq(MemberTable.userId, user), isNull(MemberTable.removedAt)]
  if (organizationId) filters.push(eq(MemberTable.organizationId, normalizeDenTypeId("organization", organizationId)))
  return db.select({ memberId: MemberTable.id, organizationId: MemberTable.organizationId }).from(MemberTable).where(and(...filters))
}

function fanoutActor(actor: UserMembershipsAuditInput["actor"], membership: AuditUserMembership): { actor: AuditActor; principalKey: string } {
  if (actor === "member") return { actor: { type: "user", id: membership.userId, memberId: membership.memberId }, principalKey: auditUserPrincipalKey({ userId: membership.userId, memberId: membership.memberId }) }
  if (actor === "unknown") return { actor: UNKNOWN_ACTOR, principalKey: "unknown:unauthenticated" }
  return { actor: { type: "system", id: actor.system }, principalKey: `system:${actor.system}` }
}

/**
 * Own-operation capture in one organization for code outside its request
 * operation: null unless deployment capture, the auditLogs feature
 * (`auditLogs` when already resolved in this call, else read), an enabled
 * policy (lazy default allowed) and the category hold. Throws on lookup errors
 * (callers log [audit-outcome-lost]).
 */
export async function standaloneOrganizationAuditCapture(input: Readonly<{
  organizationId: string
  auditLogs?: boolean
  actor: AuditActor
  principalKey: string
  origin?: AuditOrigin
  requestId?: string | null
  kind: string
  scope: string
  category: AuditCategory
}>): Promise<AuditChangeCapture | null> {
  if (!env.auditCaptureEnabled) return null
  const organizationId = typeIdOrNull("organization", input.organizationId)
  if (!organizationId) return null
  const auditLogs = input.auditLogs ?? await auditLogsFeatureEnabled(organizationId)
  if (!auditLogs) return null
  const policy = await readEffectiveAuditPolicyWithRetry(organizationId)
  if (!policy || !policy.categories.includes(input.category)) return null
  return {
    policy,
    context: {
      organizationId, actor: input.actor, principalKey: input.principalKey, origin: input.origin ?? "api", originTrust: "authenticated",
      requestId: input.requestId === undefined ? currentAuditRequestId() : input.requestId, kind: input.kind, scope: input.scope,
    },
  }
}

/** Returns the number of organizations that stored the event. Never throws. */
export async function recordAuditForUserMemberships(input: UserMembershipsAuditInput): Promise<number> {
  if (!env.auditCaptureEnabled) return 0
  const userId = typeIdOrNull("user", input.userId)
  if (!userId) return 0
  const onlyOrganizationId = input.organizationId === undefined ? null : typeIdOrNull("organization", input.organizationId)
  if (input.organizationId !== undefined && !onlyOrganizationId) return 0
  const requestId = input.requestId === undefined ? currentAuditRequestId() : input.requestId
  let memberships: Awaited<ReturnType<typeof activeMemberships>>
  let features: Awaited<ReturnType<typeof getFeaturesForOrganizations>>
  try {
    memberships = await activeMemberships(userId, onlyOrganizationId)
    // Every membership organization's features in one batched read.
    features = await getFeaturesForOrganizations([...new Set(memberships.map((row) => row.organizationId))])
  } catch (error) {
    logger.warn("audit membership lookup failed; user event not recorded", { request_id: requestId, audit_action: input.action, error_name: errorName(error) })
    return 0
  }
  let stored = 0
  for (const row of memberships) {
    if (!features.get(row.organizationId)?.auditLogs) continue
    const membership: AuditUserMembership = { organizationId: row.organizationId, memberId: row.memberId, userId }
    const outcome = input.outcome ?? "succeeded"
    try {
      // A request already captured for this organization (e.g. organization/set-active)
      // keeps its single operation; otherwise a standalone user operation.
      const requestCapture = input.category === "change" && input.actor === "member" ? currentAuditChangeCapture(membership.organizationId) : null
      let capture: AuditChangeCapture | null = requestCapture
      if (!capture) {
        const { actor, principalKey } = fanoutActor(input.actor, membership)
        capture = await standaloneOrganizationAuditCapture({
          organizationId: membership.organizationId, auditLogs: true, actor, principalKey, origin: input.origin, requestId,
          kind: input.kind, scope: input.scope ?? userId, category: input.category,
        })
        if (!capture) continue
      }
      if (!capture.policy.categories.includes(input.category)) continue
      const event: AuditEventInput = {
        action: input.action, category: input.category, outcome, resources: input.resources(membership),
        ...(input.changes ? { changes: input.changes } : {}),
        ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
        ...(requestId ? { idempotencyKey: `${requestId}:${input.action}:${input.idempotencyDiscriminator ?? userId}` } : {}),
      }
      await appendAuditEventInOwnTransaction(capture, event, requestCapture ? undefined : auditOperationOutcome(outcome))
      stored++
    } catch (error) {
      logAuditOutcomeLost({ requestId, organizationId: membership.organizationId, action: input.action, error })
    }
  }
  return stored
}
