import { eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  AutomationRevisionTable,
  AutomationRunEventTable,
  AutomationRunnerNotificationTable,
  AutomationRunnerTable,
  AutomationRunTable,
  AutomationTable,
} from "@openwork-ee/den-db/schema"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: automations. Previously orphaned (W0-05). Revisions, runs and
// run events carry no organization column, so they are joined through the
// organization's automations.

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/automations/purge-organization-automations",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 21,
  handler: async ({ tx, organizationId }) => {
    const automationIds = (await tx
      .select({ id: AutomationTable.id })
      .from(AutomationTable)
      .where(eq(AutomationTable.organization_id, organizationId)))
      .map((row) => row.id)
    if (automationIds.length > 0) {
      const runIds = (await tx
        .select({ id: AutomationRunTable.id })
        .from(AutomationRunTable)
        .where(inArray(AutomationRunTable.automation_id, automationIds)))
        .map((row) => row.id)
      if (runIds.length > 0) {
        await tx.delete(AutomationRunEventTable).where(inArray(AutomationRunEventTable.run_id, runIds))
      }
      await tx.delete(AutomationRunTable).where(inArray(AutomationRunTable.automation_id, automationIds))
      await tx.delete(AutomationRevisionTable).where(inArray(AutomationRevisionTable.automation_id, automationIds))
    }
    await tx.delete(AutomationRunnerNotificationTable).where(eq(AutomationRunnerNotificationTable.organization_id, organizationId))
    await tx.delete(AutomationRunnerTable).where(eq(AutomationRunnerTable.organization_id, organizationId))
    await tx.delete(AutomationTable).where(eq(AutomationTable.organization_id, organizationId))
  },
})

// Platform-owned metadata; always reserved, whatever the module state.
coreHooks.registerBootContributor({
  point: "org.reservedMetadataKeys",
  id: "legacy/automations/reserved-metadata-keys",
  registrant: "legacy",
  security: true,
  order: CORE_HOOK_ORDER.security + 4,
  contribute: () => ({ capabilityKeys: ["headlessAutomations"] }),
})
