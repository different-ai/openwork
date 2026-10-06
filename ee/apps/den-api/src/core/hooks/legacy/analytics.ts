import { deleteModelsAnalyticsForOrganization } from "@openwork-ee/telemetry"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: analytics (models analytics).

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/analytics/erase-organization-models-analytics",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.lock + 1,
  handler: ({ tx, organizationId }) => deleteModelsAnalyticsForOrganization(tx, organizationId),
})
