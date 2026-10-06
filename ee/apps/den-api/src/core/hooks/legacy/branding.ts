import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationBrandAssetTable } from "@openwork-ee/den-db/schema"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: branding.

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/branding/purge-organization-brand-assets",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 8,
  handler: async ({ tx, organizationId }) => {
    await tx.delete(OrganizationBrandAssetTable).where(eq(OrganizationBrandAssetTable.organizationId, organizationId))
  },
})
