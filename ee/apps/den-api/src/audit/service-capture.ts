import { randomUUID } from "node:crypto"
import { AuditLogError, type AuditActor, type AuditEventInput, type AuditOrigin } from "@openwork-ee/den-db/audit-log"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { env } from "../env.js"
import { statusFromError } from "../observability/hono.js"
import { appLogger } from "../observability/logger.js"
import { appendAuditEventInOwnTransaction, readEffectiveAuditPolicyWithRetry, auditClassCategory, auditClassNeedsIntent, auditOperationOutcome, auditRequestOutcome, auditTargetResources, auditLogsFeatureEnabled, currentAuditRequestId, logAuditOutcomeLost, platformActorOf, writePlatformAuditEvent, type AuditChangeCapture, type TenantAuditClass } from "./request-capture.js"

// Non-HTTP mutation paths (design §6): MCP tools that mutate state without
// re-entering a den-api route, and platform-admin MCP tools. Same intent and
// outcome semantics as generic request capture, without a Hono context.

export class AuditUnavailableError extends Error {
  readonly code = "audit_unavailable"
  constructor() {
    super("audit_unavailable")
    this.name = "AuditUnavailableError"
  }
}

export type AuditedServiceAction = Readonly<{
  /** Verified, existing target organization (for admin tools: the argument org). */
  organizationId: string
  actor: AuditActor
  principalKey: string
  /** "mcp" for MCP tools, "platform_admin" for admin tools. */
  origin: AuditOrigin
  kind: string
  /** Semantic stem; events are `${action}.${suffix}` like route declarations. */
  action: string
  resource: Readonly<{ type: string; id: string | null }>
  class: TenantAuditClass
}>

const logger = appLogger.child({ component: "audit_service" })

/**
 * Change capture for a platform-admin effect on one organization that the
 * request is not attributed to (DELETE /v1/admin/users/:userId removes the
 * user's memberships in several organizations): actor = the admin user,
 * origin platform_admin, the enclosing request id. Null when capture, the
 * organization rollout, the policy or the change category is off — callers
 * then write the legacy row (single writer, finishLegacyAuditAction).
 */
export async function platformAdminChangeCapture(input: Readonly<{ organizationId: string; adminUserId: string; kind: string; scope: string }>): Promise<AuditChangeCapture | null> {
  if (!env.auditCaptureEnabled) return null
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const adminUserId = normalizeDenTypeId("user", input.adminUserId)
  if (!(await auditLogsFeatureEnabled(organizationId))) return null
  const policy = await readEffectiveAuditPolicyWithRetry(organizationId)
  if (!policy || !policy.categories.includes("change")) return null
  return {
    policy,
    context: {
      organizationId, actor: { type: "user", id: adminUserId }, principalKey: `user:${adminUserId}:platform_admin`, origin: "platform_admin", originTrust: "authenticated",
      requestId: currentAuditRequestId() ?? createDenTypeId("request"), kind: input.kind, scope: input.scope,
    },
  }
}

/**
 * Runs `fn` with durable `.requested` intent before (fail closed: throws
 * AuditUnavailableError and fn never runs) and an outcome after. `fn` receives
 * the change capture (null when capture or the change category is off) for
 * appendAuditChanges inside its own transaction; all events share one
 * operation. Read/access results are withheld (AuditUnavailableError) when the
 * served event cannot be recorded; other outcome losses are logged
 * `[audit-outcome-lost]` and the result is returned.
 */
export async function runAuditedServiceAction<T>(input: AuditedServiceAction, fn: (capture: AuditChangeCapture | null) => Promise<T>): Promise<T> {
  if (!env.auditCaptureEnabled) return fn(null)
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const requestId = currentAuditRequestId() ?? createDenTypeId("request")
  // Several service actions may share one enclosing MCP request (and operation).
  const actionKey = `${requestId}:${randomUUID()}`
  let capture: AuditChangeCapture | null = null
  let category: ReturnType<typeof auditClassCategory> | null = null
  const resourceId = input.resource.id
  const resources: AuditEventInput["resources"] = auditTargetResources(input.resource.type, resourceId, organizationId)
  let intentRecorded = false
  try {
    // Resolved here for the target organization, never passed in by callers.
    if (!(await auditLogsFeatureEnabled(organizationId))) return fn(null)
    const policy = await readEffectiveAuditPolicyWithRetry(organizationId)
    if (!policy) return fn(null)
    capture = {
      policy,
      context: {
        organizationId, actor: input.actor, principalKey: input.principalKey, origin: input.origin, originTrust: "authenticated",
        requestId, kind: input.kind, scope: resourceId ?? organizationId,
      },
    }
    const selected = auditClassCategory(input.class)
    category = policy.categories.includes(selected) ? selected : null
    if (category && auditClassNeedsIntent(input.class)) {
      await appendAuditEventInOwnTransaction(capture, { action: `${input.action}.requested`, category, outcome: "unknown", resources, idempotencyKey: `${actionKey}:requested` })
      intentRecorded = true
    }
  } catch (error) {
    logger.warn("audit service intent unavailable; action refused", { request_id: requestId, organization_id: organizationId, audit_action: input.action, error_name: error instanceof Error ? error.name : typeof error })
    throw new AuditUnavailableError()
  }
  const activeCapture = capture
  const changeCapture = activeCapture.policy.categories.includes("change") ? activeCapture : null
  const outcome = async (status: number) => {
    const mapped = auditRequestOutcome(input.class, status)
    const eventCategory = mapped.denied && activeCapture.policy.categories.includes("security") ? "security" : category
    if (!eventCategory) return true
    try {
      await appendAuditEventInOwnTransaction(activeCapture, {
        action: `${input.action}.${mapped.suffix}`, category: eventCategory, outcome: mapped.outcome, resources,
        ...(mapped.reasonCode ? { reasonCode: mapped.reasonCode } : {}), idempotencyKey: `${actionKey}:outcome`,
      }, auditOperationOutcome(mapped.outcome))
      return true
    } catch (error) {
      logAuditOutcomeLost({ requestId, organizationId, action: `${input.action}.${mapped.suffix}`, error })
      // The action itself turned tenant capture off for its organization
      // (auditLogs feature or plan entitlement removed) after its intent was
      // recorded: keep the outcome as platform evidence targeting that
      // organization (same fallback as request capture). Not an HTTP route:
      // method SERVICE, route service:<action> (never the MCP transport).
      if (intentRecorded && error instanceof AuditLogError && error.code === "audit_policy_changed") {
        await writePlatformAuditEvent(requestId, {
          method: "SERVICE", route: `service:${input.action}`, action: `${input.action}.${mapped.suffix}`, outcome: mapped.outcome, status,
          reasonCode: mapped.reasonCode ?? "tenant_audit_disabled", actor: platformActorOf(input.actor), origin: input.origin,
          target: { type: "organization", id: organizationId },
        })
      }
      return false
    }
  }
  let result: T
  try {
    result = await fn(changeCapture)
  } catch (error) {
    await outcome(statusFromError(error))
    throw error
  }
  const recorded = await outcome(200)
  if (!recorded && (input.class === "tenant_read" || input.class === "tenant_access")) throw new AuditUnavailableError()
  return result
}
