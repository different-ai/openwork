import { eq } from "@openwork-ee/den-db/drizzle"
import {
  AuditEventResourceTable,
  AuditEventTable,
  AuditOperationStepTable,
  AuditOperationTable,
  AuditPolicyTable,
  AuditStateTable,
  AuditUsageFactTable,
} from "@openwork-ee/den-db/schema"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: auditLogs.

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/audit-logs/purge-organization-audit",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 11,
  handler: async ({ tx, organizationId }) => {
    // Explicit owner-authorized organization erasure, not resource cleanup.
    // No settlement is active for these pilot facts. Billing evidence needs
    // a separate retention policy before commercial settlement is enabled.
    await tx.select().from(AuditStateTable).where(eq(AuditStateTable.organization_id, organizationId)).for("update")
    await tx.delete(AuditEventResourceTable).where(eq(AuditEventResourceTable.organization_id, organizationId))
    await tx.delete(AuditEventTable).where(eq(AuditEventTable.org_id, organizationId))
    await tx.delete(AuditOperationStepTable).where(eq(AuditOperationStepTable.organization_id, organizationId))
    await tx.delete(AuditOperationTable).where(eq(AuditOperationTable.organization_id, organizationId))
    await tx.delete(AuditUsageFactTable).where(eq(AuditUsageFactTable.organization_id, organizationId))
    await tx.delete(AuditPolicyTable).where(eq(AuditPolicyTable.organization_id, organizationId))
    await tx.delete(AuditStateTable).where(eq(AuditStateTable.organization_id, organizationId))
  },
})

// Platform-owned metadata; always reserved, whatever the module state.
coreHooks.registerBootContributor({
  point: "org.reservedMetadataKeys",
  id: "legacy/audit-logs/reserved-metadata-keys",
  registrant: "legacy",
  security: true,
  order: CORE_HOOK_ORDER.security + 2,
  contribute: () => ({ capabilityKeys: ["auditLogs"] }),
})
