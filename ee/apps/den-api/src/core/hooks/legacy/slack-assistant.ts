import { eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  ExternalMcpConnectionTable,
  SlackAssistantDesktopHandoffTable,
  SlackAssistantEventTable,
  SlackAssistantIdentityTable,
  SlackAssistantInstallationTable,
  SlackAssistantOAuthStateTable,
  SlackAssistantRunTokenTable,
  SlackAssistantThreadTable,
} from "@openwork-ee/den-db/schema"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: slackAssistant. Previously orphaned (W0-05): org deletion
// removed external_mcp_connection rows directly, bypassing the Slack cascade
// in deleteExternalMcpConnection. Must run before connect purges connections.

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/slack-assistant/purge-organization-slack-assistant",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 16,
  handler: async ({ tx, organizationId }) => {
    const connectionIds = (await tx
      .select({ id: ExternalMcpConnectionTable.id })
      .from(ExternalMcpConnectionTable)
      .where(eq(ExternalMcpConnectionTable.organizationId, organizationId)))
      .map((row) => row.id)
    if (connectionIds.length > 0) {
      for (const table of [
        SlackAssistantIdentityTable,
        SlackAssistantThreadTable,
        SlackAssistantEventTable,
        SlackAssistantOAuthStateTable,
        SlackAssistantRunTokenTable,
        SlackAssistantDesktopHandoffTable,
        SlackAssistantInstallationTable,
      ]) {
        await tx.delete(table).where(inArray(table.connectionId, connectionIds))
      }
    }
    await tx.delete(SlackAssistantDesktopHandoffTable).where(eq(SlackAssistantDesktopHandoffTable.organizationId, organizationId))
    await tx.delete(SlackAssistantInstallationTable).where(eq(SlackAssistantInstallationTable.organizationId, organizationId))
  },
})
