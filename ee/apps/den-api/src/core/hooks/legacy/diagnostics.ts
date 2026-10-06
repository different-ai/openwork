import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationDiagnosticCredentialTable } from "@openwork-ee/den-db/schema"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: diagnostics.

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/diagnostics/purge-organization-diagnostic-credentials",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 14,
  handler: async ({ tx, organizationId }) => {
    await tx.delete(OrganizationDiagnosticCredentialTable).where(eq(OrganizationDiagnosticCredentialTable.organizationId, organizationId))
  },
})
