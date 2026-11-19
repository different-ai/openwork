import { eq } from "@openwork-ee/den-db/drizzle"
import {
  ExternalMcpConnectionTable,
  SandboxOrganizationTable,
  SlackAssistantInstallationTable as Installation,
} from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { env } from "../env.js"
import { isSandboxSlackToken } from "./protocol.js"

/**
 * Where a sandbox organization's sample Slack app makes its Slack calls: the sandbox's own fictional workplace
 * (evals/packages/open-workplace/src/workshop-slack.mjs), never Slack. Decided per installation from what only Den
 * sets, so every other organization and connector keeps Slack's API:
 *
 * - the installation's bot token is a sample token, which only sandbox setup writes (every other bot token comes
 *   from Slack's own install answer, and Slack never issues one with the sample prefix);
 * - the organization is an open sandbox, the address is the workplace address a platform admin gave it, and the
 *   Slack connector still points at that workplace (so a member's connector token only goes where it came from);
 * - this is a Cloud deployment.
 *
 * When any of these stops being true the sample app is unavailable: Den refuses to call anything with it rather
 * than sending a sample token to Slack (slackClient refuses that too).
 */

/** The sample Slack addresses a sandbox's workplace serves, from its root address. */
export function sandboxSlackAddresses(workplaceUrl: string) {
  const root = workplaceUrl.replace(/\/+$/, "")
  return {
    appsUrl: `${root}/_workshop/slack/apps`,
    mcpUrl: `${root}/slack/mcp`,
    apiBaseUrl: (teamId: string) => `${root}/slack/teams/${encodeURIComponent(teamId)}/api`,
  }
}

function sameOrigin(left: string, right: string) {
  try {
    return new URL(left).origin === new URL(right).origin
  } catch {
    return false
  }
}

/** The Slack API address of a sandbox's sample app, or null when it is not one or can't be used now. */
export async function sandboxSlackApiBase(connectionId: DenTypeId<"externalMcpConnection">, now = new Date()): Promise<string | null> {
  if (env.features.deployment !== "cloud") return null
  const [row] = await db
    .select({
      botToken: Installation.botToken,
      teamId: Installation.teamId,
      connectionUrl: ExternalMcpConnectionTable.url,
      workplaceUrl: SandboxOrganizationTable.connectorBaseUrl,
      closedAt: SandboxOrganizationTable.closedAt,
      expiresAt: SandboxOrganizationTable.expiresAt,
    })
    .from(Installation)
    .innerJoin(ExternalMcpConnectionTable, eq(ExternalMcpConnectionTable.id, Installation.connectionId))
    .innerJoin(SandboxOrganizationTable, eq(SandboxOrganizationTable.organizationId, Installation.organizationId))
    .where(eq(Installation.connectionId, connectionId))
    .limit(1)
  if (!row || !isSandboxSlackToken(row.botToken) || !row.teamId || !row.workplaceUrl) return null
  if (row.closedAt || row.expiresAt <= now) return null
  if (!sameOrigin(row.connectionUrl, row.workplaceUrl)) return null
  return sandboxSlackAddresses(row.workplaceUrl).apiBaseUrl(row.teamId)
}
