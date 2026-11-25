import { AuditLogError, appendAuditEvent, readAuditPolicy, type AuditDatabase, type AuditPolicy, type AuditTx } from "@openwork-ee/den-db/audit-log"
import { eq, sql } from "@openwork-ee/den-db/drizzle"
import { AuditPolicyTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { AuditEntitlement } from "@openwork/types/den/audit"
import { PILOT_DEFAULT_CATEGORIES } from "./pilot-policy.js"

export const PROVISIONAL_AUDIT_ALLOWANCE = 6_000_000
export const PROVISIONAL_AUDIT_ATTACHMENT_WINDOW_SECONDS = 300
export const PROVISIONAL_AUDIT_SYSTEM_ACTOR = "den-api.audit-defaults"

export async function readAuditAvailability(database: AuditDatabase | AuditTx, organizationId: string) {
  const [organization] = await database.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable)
    .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", organizationId))).limit(1)
  if (!organization) throw new AuditLogError("audit_storage_inconsistent")
  const { getAuditEntitlement } = await import("../entitlements.js")
  return { entitlement: getAuditEntitlement(organization.metadata) }
}

export async function readAuditEntitlement(database: AuditDatabase | AuditTx, organizationId: string): Promise<AuditEntitlement> {
  return (await readAuditAvailability(database, organizationId)).entitlement
}

export async function initializeAuditPolicyInTx(tx: AuditTx, inputOrganizationId: string, captureAvailable: boolean): Promise<{ policy: AuditPolicy | null; initialized: boolean }> {
  if (!captureAvailable) return { policy: null, initialized: false }
  const organizationId = normalizeDenTypeId("organization", inputOrganizationId)
  const availability = await readAuditAvailability(tx, organizationId)
  if (!availability.entitlement.enabled) return { policy: null, initialized: false }
  const existing = await readAuditPolicy(tx, organizationId)
  if (existing) return { policy: existing, initialized: false }

  const now = new Date()
  const source = availability.entitlement.source === "self_hosted" ? "operator" : "cloud"
  const policy: AuditPolicy = {
    organizationId, revision: 1, source, enabled: true, categories: [...PILOT_DEFAULT_CATEGORIES],
    allowance: PROVISIONAL_AUDIT_ALLOWANCE, excessMode: source === "cloud" ? "delete_oldest" : "keep_all",
    effectiveAt: now.toISOString(), captureStartedAt: null, attachmentWindowSeconds: PROVISIONAL_AUDIT_ATTACHMENT_WINDOW_SECONDS,
  }
  await tx.insert(AuditPolicyTable).values({
    organization_id: organizationId, revision: policy.revision, source: policy.source, enabled: policy.enabled,
    categories: policy.categories, allowance: policy.allowance, excess_mode: policy.excessMode,
    effective_at: now, capture_started_at: null, attachment_window_seconds: policy.attachmentWindowSeconds,
  }).onDuplicateKeyUpdate({ set: { organization_id: sql`${AuditPolicyTable.organization_id}` } })
  const stored = await readAuditPolicy(tx, organizationId)
  if (!stored) return { policy: null, initialized: false }
  if (stored.effectiveAt !== policy.effectiveAt || stored.source !== policy.source || stored.revision !== policy.revision) return { policy: stored, initialized: false }
  const { captureStartedAt: _captureStartedAt, ...after } = policy
  const event = await appendAuditEvent(tx, {
    context: {
      organizationId, actor: { type: "system", id: PROVISIONAL_AUDIT_SYSTEM_ACTOR }, principalKey: `system:${PROVISIONAL_AUDIT_SYSTEM_ACTOR}`,
      origin: "api", originTrust: "authenticated", requestId: null, kind: "audit.policy", scope: organizationId,
    },
    policy,
    event: {
      action: "audit.policy.initialized", category: "lifecycle", outcome: "succeeded",
      resources: [{ type: "audit_policy", id: organizationId, relationship: "target" }, { type: "organization", id: organizationId, relationship: "parent" }],
      changes: { before: null, after, changedFields: Object.keys(after) },
    },
  })
  if (!event) throw new AuditLogError("audit_storage_inconsistent")
  return { policy: { ...policy, captureStartedAt: event.recordedAt }, initialized: true }
}

export async function readEffectiveAuditPolicy(database: AuditDatabase | AuditTx, organizationId: string, captureAvailable: boolean): Promise<AuditPolicy | null> {
  if (!captureAvailable) return null
  const { policy } = "rollback" in database
    ? await initializeAuditPolicyInTx(database, organizationId, captureAvailable)
    : await database.transaction((tx) => initializeAuditPolicyInTx(tx, organizationId, captureAvailable))
  return policy?.enabled ? policy : null
}

export async function recheckAuditEntitlement(database: AuditDatabase | AuditTx, organizationId: string): Promise<void> {
  const availability = await readAuditAvailability(database, organizationId)
  if (!availability.entitlement.enabled) throw new AuditLogError("audit_policy_changed")
}
