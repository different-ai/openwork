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
