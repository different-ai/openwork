import { eq, inArray } from "@openwork-ee/den-db/drizzle"
import { DesktopConnectGrantTable, InstallLinkTable } from "@openwork-ee/den-db/schema"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"
import { organizationInstallLinksEnabled } from "../../../capability-sources/install-links-rollout.js"

// Future owner: installLinks.

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/install-links/purge-organization-install-links",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup,
  handler: async ({ tx, organizationId }) => {
    const installLinkIds = (await tx
      .select({ id: InstallLinkTable.id })
      .from(InstallLinkTable)
      .where(eq(InstallLinkTable.organizationId, organizationId)))
      .map((row) => row.id)
    if (installLinkIds.length > 0) {
      await tx.delete(DesktopConnectGrantTable).where(inArray(DesktopConnectGrantTable.installLinkId, installLinkIds))
    }
    await tx.delete(InstallLinkTable).where(eq(InstallLinkTable.organizationId, organizationId))
  },
})

coreHooks.registerContributor({
  point: "org.context",
  id: "legacy/install-links/org-context-capability",
  registrant: "legacy",
  // Today a failure here is a 500; keep it.
  errorPolicy: "propagate",
  order: CORE_HOOK_ORDER.default + 8,
  contribute: async ({ metadata }) => ({ capabilities: { installLinks: organizationInstallLinksEnabled(metadata) } }),
})
