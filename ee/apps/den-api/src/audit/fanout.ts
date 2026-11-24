import type { AuditActor, AuditEventInput, AuditOrigin } from "@openwork-ee/den-db/audit-log"
import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { AuditCategory } from "@openwork/types/den/audit"
import { db } from "../db.js"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
import { appendAuditEventInOwnTransaction, readEffectiveAuditPolicyWithRetry, auditOperationOutcome, auditUserPrincipalKey, currentAuditChangeCapture, currentAuditRequestId, logAuditOutcomeLost, type AuditChangeCapture } from "./request-capture.js"

export type AuditUserMembership = Readonly<{ organizationId: string; memberId: string; userId: string }>
export type UserMembershipsAuditInput = Readonly<{
  userId: string
  organizationId?: string | null
  action: string
  kind: string
  category: AuditCategory
  outcome?: AuditEventInput["outcome"]
  actor: "member" | "unknown" | Readonly<{ system: string }>
  scope?: string
  resources: (membership: AuditUserMembership) => AuditEventInput["resources"]
  changes?: AuditEventInput["changes"]
  reasonCode?: string
  requestId?: string | null
  origin?: AuditOrigin
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

export async function standaloneOrganizationAuditCapture(input: Readonly<{
  organizationId: string
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

export async function recordAuditForUserMemberships(input: UserMembershipsAuditInput): Promise<number> {
  if (!env.auditCaptureEnabled) return 0
  const userId = typeIdOrNull("user", input.userId)
  if (!userId) return 0
  const onlyOrganizationId = input.organizationId === undefined ? null : typeIdOrNull("organization", input.organizationId)
  if (input.organizationId !== undefined && !onlyOrganizationId) return 0
  const requestId = input.requestId === undefined ? currentAuditRequestId() : input.requestId
  let memberships: Awaited<ReturnType<typeof activeMemberships>>
  try {
    memberships = await activeMemberships(userId, onlyOrganizationId)
  } catch (error) {
    logger.warn("audit membership lookup failed; user event not recorded", { request_id: requestId, audit_action: input.action, error_name: errorName(error) })
    return 0
  }
  let stored = 0
  for (const row of memberships) {
    const membership: AuditUserMembership = { organizationId: row.organizationId, memberId: row.memberId, userId }
    const outcome = input.outcome ?? "succeeded"
    try {
      const requestCapture = input.category === "change" && input.actor === "member" ? currentAuditChangeCapture(membership.organizationId) : null
      let capture: AuditChangeCapture | null = requestCapture
      if (!capture) {
        const { actor, principalKey } = fanoutActor(input.actor, membership)
        capture = await standaloneOrganizationAuditCapture({
          organizationId: membership.organizationId, actor, principalKey, origin: input.origin, requestId,
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
