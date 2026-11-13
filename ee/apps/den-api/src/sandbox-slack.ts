import { SlackAssistantInstallationTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { externalMcpOAuthConfigurationDefaults } from "./capability-sources/external-mcp-auth-policy.js"
import { createExternalMcpConnection, getExternalMcpConnectionByExternalKey } from "./capability-sources/external-mcp-connections.js"
import { assertPublicUrl } from "./capability-sources/url-guard.js"
import { db } from "./db.js"
import { env } from "./env.js"
import { SANDBOX_SLACK_TOKEN_PREFIX } from "./slack-assistant/protocol.js"
import { getInstallation } from "./slack-assistant/repository.js"
import { sandboxSlackAddresses } from "./slack-assistant/sandbox-api.js"

export const SANDBOX_SLACK_EXTERNAL_KEY = "sandbox-slack"
/** The name the sample app's bot goes by in the sample Slack: Proactive Mode sends "a DM from Workbot". */
const SANDBOX_SLACK_BOT_NAME = "Workbot"

export class SandboxSlackUnavailableError extends Error {}

const slackId = z.string().regex(/^[A-Z][A-Z0-9]{1,30}$/)
const registeredAppSchema = z.object({
  team_id: slackId,
  app_id: slackId,
  bot_user_id: slackId,
  bot_token: z.string().startsWith(SANDBOX_SLACK_TOKEN_PREFIX).max(500),
  signing_secret: z.string().min(16).max(500),
})

/**
 * Gives a sandbox its sample Slack: a per-person Slack connector at the sandbox's sample work apps,
 * and the Workbot Slack app installed against it with a sample bot token the workplace issues. Workbot's settings
 * then see the Slack app as installed, so Proactive Mode can be turned on; each member connects Slack once in their
 * own browser, which links them, and their agent's messages arrive on that browser's sample Slack page.
 *
 * Throws SandboxSlackUnavailableError when the workplace has no sample Slack (an older workshop) or can't be
 * reached; nothing is created then.
 */
export async function addSandboxSlack(input: {
  organizationId: DenTypeId<"organization">
  ownerMemberId: DenTypeId<"member">
  workplaceUrl: string
}) {
  const addresses = sandboxSlackAddresses(input.workplaceUrl)
  const existing = await getExternalMcpConnectionByExternalKey({ organizationId: input.organizationId, externalKey: SANDBOX_SLACK_EXTERNAL_KEY })
  if (existing && existing.url !== addresses.mcpUrl) throw new SandboxSlackUnavailableError("This organization already has a connector with the key sandbox-slack at another address. Remove it first.")
  // primary: a connector added moments ago by an earlier attempt may not have its app yet.
  if (existing && (await getInstallation(existing.id, db.$primary))) return existing

  if (!env.allowPrivateMcpUrls) await assertPublicUrl(addresses.appsUrl)
  let response: Response
  try {
    response = await fetch(addresses.appsUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ bot_name: SANDBOX_SLACK_BOT_NAME }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new SandboxSlackUnavailableError(`The sample work apps could not be reached to set up Slack (${error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : "unknown"}).`)
  }
  if (response.status === 404) throw new SandboxSlackUnavailableError("The sample work apps at this address don't offer Slack yet.")
  const registered = registeredAppSchema.safeParse(await response.json().catch(() => null))
  if (!response.ok || !registered.success) throw new SandboxSlackUnavailableError(`The sample work apps refused the Slack setup (HTTP ${response.status}).`)

  const connection = existing ?? await createExternalMcpConnection({
    organizationId: input.organizationId,
    name: "Slack",
    externalKey: SANDBOX_SLACK_EXTERNAL_KEY,
    url: addresses.mcpUrl,
    authType: "oauth",
    credentialMode: "per_member",
    exposeDirectly: true,
    oauthConfiguration: { version: 1, ...externalMcpOAuthConfigurationDefaults({ url: addresses.mcpUrl }) },
    createdByOrgMembershipId: input.ownerMemberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  await db.insert(SlackAssistantInstallationTable).values({
    connectionId: connection.id,
    organizationId: input.organizationId,
    enabled: true,
    signingSecret: registered.data.signing_secret,
    teamId: registered.data.team_id,
    appId: registered.data.app_id,
    botUserId: registered.data.bot_user_id,
    botToken: registered.data.bot_token,
  })
  return connection
}
