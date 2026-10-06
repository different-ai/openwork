import { AuditLogError, appendAuditEvent, readAuditPolicy, type AuditDatabase, type AuditPolicy, type AuditTx } from "@openwork-ee/den-db/audit-log"
import { eq, sql } from "@openwork-ee/den-db/drizzle"
import { AuditPolicyTable, AuditStateTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { auditPolicySchema, type AuditEntitlement } from "@openwork/types/den/audit"
import { organizationFeatureEnabled } from "../features.js"
import { AuditReadError } from "./cursors.js"
import { PILOT_DEFAULT_CATEGORIES } from "./pilot-policy.js"

// Temporary server-owned declarations, not an enforced cap or a billing product.
// Capacity counts retained OPERATIONS, never child events. Neither provenance
// nor excess mode grants entitlement. No cleanup/deletion is enabled here.
export const PROVISIONAL_AUDIT_ALLOWANCE = 6_000_000
export const PROVISIONAL_AUDIT_ATTACHMENT_WINDOW_SECONDS = 300
export const PROVISIONAL_AUDIT_SYSTEM_ACTOR = "den-api.audit-defaults"

/** Current read, after the state lock; never reuse an older repeatable-read snapshot. */
export async function readLockedAuditPolicy(tx: AuditTx, organizationId: string, lock: "share" | "update" = "share"): Promise<AuditPolicy | null> {
  const [row] = await tx.select().from(AuditPolicyTable)
    .where(eq(AuditPolicyTable.organization_id, normalizeDenTypeId("organization", organizationId))).limit(1).for(lock)
  return row ? auditPolicySchema.parse({
    organizationId: row.organization_id, revision: row.revision, source: row.source, enabled: row.enabled,
    categories: row.categories, allowance: row.allowance, excessMode: row.excess_mode,
    effectiveAt: row.effective_at.toISOString(), captureStartedAt: row.capture_started_at?.toISOString() ?? null,
    attachmentWindowSeconds: row.attachment_window_seconds,
  }) : null
}

/** One fresh organization read; the rollout flag never changes the entitlement. */
export async function readAuditAvailability(database: AuditDatabase | AuditTx, organizationId: string, lock = false) {
  const query = database.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable)
    .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", organizationId))).limit(1)
  const [organization] = await (lock ? query.for("share") : query)
  if (!organization) throw new AuditLogError("audit_storage_inconsistent")
  const { getAuditEntitlement } = await import("../entitlements.js")
  // Read after the organization fence, with the same share lock, so a concurrent
  // /admin change cannot flip the flag between this check and commit.
  const featureEnabled = await organizationFeatureEnabled(organizationId, "auditLogs", { database, lock: lock ? "share" : undefined })
  return { featureEnabled, entitlement: getAuditEntitlement(organization.metadata) }
}

export async function readAuditEntitlement(database: AuditDatabase | AuditTx, organizationId: string, lock = false): Promise<AuditEntitlement> {
  return (await readAuditAvailability(database, organizationId, lock)).entitlement
}

/** Lock organization before member/provider, audit state and policy locks. */
export async function requireAuditFeature(tx: AuditTx, organizationId: string) {
  const availability = await readAuditAvailability(tx, organizationId, true)
  if (!availability.featureEnabled) throw new AuditReadError("audit_feature_disabled")
  return availability
}

/**
 * Call before acquiring audit state share locks or business snapshots. The fresh
 * organization share fence is retained until commit; never upgrade it to UPDATE.
 * A nonlocking existing-policy fast path preserves all stored preferences. Only
 * missing policies serialize on the unique state INSERT, then lock policy. The
 * locked re-read handles concurrent winners even under an older RR snapshot.
 */
export async function initializeAuditPolicyInTx(tx: AuditTx, inputOrganizationId: string, captureAvailable: boolean): Promise<{ policy: AuditPolicy | null; initialized: boolean }> {
  if (!captureAvailable) return { policy: null, initialized: false }
  const organizationId = normalizeDenTypeId("organization", inputOrganizationId)
  const availability = await readAuditAvailability(tx, organizationId, true)
  if (!availability.featureEnabled || !availability.entitlement.enabled) return { policy: null, initialized: false }
  const existing = await readAuditPolicy(tx, organizationId)
  if (existing) return { policy: existing, initialized: false }

  await tx.insert(AuditStateTable).values({ organization_id: organizationId })
    .onDuplicateKeyUpdate({ set: { organization_id: sql`${AuditStateTable.organization_id}` } })
  const [state] = await tx.select().from(AuditStateTable).where(eq(AuditStateTable.organization_id, organizationId)).limit(1).for("update")
  const winner = await readLockedAuditPolicy(tx, organizationId, "update")
  if (winner) return { policy: winner, initialized: false }
  if (!state || state.last_sequence !== 0 || state.retained_operations !== 0 || state.event_count !== 0 || state.logical_bytes !== 0) throw new AuditLogError("audit_storage_inconsistent")

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
  })
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
  // Both Drizzle adapters expose rollback only on transactions. Reuse the
  // caller's transaction rather than opening a nested transaction/savepoint.
  const { policy } = "rollback" in database
    ? await initializeAuditPolicyInTx(database, organizationId, captureAvailable)
    : await database.transaction((tx) => initializeAuditPolicyInTx(tx, organizationId, captureAvailable))
  return policy?.enabled ? policy : null
}

export async function recheckAuditEntitlement(tx: AuditTx, organizationId: string): Promise<void> {
  const availability = await readAuditAvailability(tx, organizationId, true)
  if (!availability.featureEnabled || !availability.entitlement.enabled) throw new AuditLogError("audit_policy_changed")
}
