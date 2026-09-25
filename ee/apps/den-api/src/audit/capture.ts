import { AuditLogError, readAuditPolicy, type AuditDatabase, type AuditPolicy, type AuditTx } from "@openwork-ee/den-db/audit-log"
import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { AuditEntitlement } from "@openwork/types/den/audit"

export async function readAuditEntitlement(database: AuditDatabase | AuditTx, organizationId: string, lock = false): Promise<AuditEntitlement> {
  const query = database.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable)
    .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", organizationId))).limit(1)
  const [organization] = await (lock ? query.for("share") : query)
  if (!organization) throw new AuditLogError("audit_storage_inconsistent")
  const { getAuditEntitlement } = await import("../entitlements.js")
  return getAuditEntitlement(organization.metadata)
}

export async function readEffectiveAuditPolicy(database: AuditDatabase | AuditTx, organizationId: string, captureAvailable: boolean, lock = false): Promise<AuditPolicy | null> {
  if (!captureAvailable) return null
  if (!(await readAuditEntitlement(database, organizationId, lock)).enabled) return null
  const policy = await readAuditPolicy(database, organizationId)
  return policy?.enabled ? policy : null
}

export async function recheckAuditEntitlement(tx: AuditTx, organizationId: string): Promise<void> {
  if (!(await readAuditEntitlement(tx, organizationId, true)).enabled) throw new AuditLogError("audit_policy_changed")
}
