import { and, eq, inArray, max, sql } from "@openwork-ee/den-db/drizzle"
import { SlackAssistantEventTable, SlackAssistantInstallationTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { listExternalMcpConnections } from "../capability-sources/external-mcp-connections.js"
import { getValidAccessToken } from "../capability-sources/generic-oauth.js"
import { getOrgOAuthClient } from "../capability-sources/oauth-credentials.js"
import { clientSelectedFeatures, getNativeOAuthProvider, type NativeOAuthProviderConfig } from "../capability-sources/provider-registry.js"
import { db } from "../db.js"
import { env } from "../env.js"
import { checkGoogleConnectorApis, requiredGoogleApis, type GoogleApiCheck } from "../routes/org/google-api-check.js"
import { slackRunnerAvailable } from "../slack-assistant/headless.js"
import { slackClient } from "../slack-assistant/protocol.js"
import { isSlackConnection, slackAssistantMetrics } from "../slack-assistant/repository.js"
import { classifySlackAuthTest, slackNeedsLiveCheck, type SlackConnectorInput, type SlackLiveResult } from "./connector-checks.js"

type OrganizationId = DenTypeId<"organization">
type MemberId = DenTypeId<"member">
type ConnectionId = DenTypeId<"externalMcpConnection">

const GOOGLE_WORKSPACE = "google-workspace"

export type SlackConnectorTarget = Omit<SlackConnectorInput, "live"> & {
  connectionId: ConnectionId
  /** Fingerprint of the stored bot token (ciphertext hash): a reinstall invalidates cached checks. */
  version: string
  needsLiveCheck: boolean
}

export type GoogleConnectorTarget = {
  id: string
  name: string
  /** Connection id, or the provider id for an organization OAuth app saved before connections existed. */
  credentialProviderId: string
  features: string[]
  apis: Array<{ id: string; name: string }>
}

export type ConnectorTargets = { slack: SlackConnectorTarget[]; google: GoogleConnectorTarget[] }

async function slackTargets(organizationId: OrganizationId, connections: Awaited<ReturnType<typeof listExternalMcpConnections>>): Promise<SlackConnectorTarget[]> {
  const slack = connections.filter((connection) => {
    try {
      return connection.kind === "external_mcp" && isSlackConnection(connection)
    } catch {
      // A malformed stored URL is not a Slack connection; never fail the section for it.
      return false
    }
  })
  if (!slack.length) return []
  const ids = slack.map((connection) => connection.id)
  const installations = await db.select({
    connectionId: SlackAssistantInstallationTable.connectionId,
    enabled: SlackAssistantInstallationTable.enabled,
    hasBotToken: sql<number>`${SlackAssistantInstallationTable.botToken} is not null`,
    tokenVersion: sql<string | null>`left(sha2(${SlackAssistantInstallationTable.botToken}, 256), 16)`,
  }).from(SlackAssistantInstallationTable)
    .where(and(eq(SlackAssistantInstallationTable.organizationId, organizationId), inArray(SlackAssistantInstallationTable.connectionId, ids)))
  // A Slack connection whose assistant was never set up is not a diagnostics row.
  if (!installations.length) return []
  const installed = installations.map((row) => row.connectionId)
  const [lastEvents, metrics] = await Promise.all([
    db.select({ connectionId: SlackAssistantEventTable.connectionId, lastEventAt: max(SlackAssistantEventTable.createdAt) })
      .from(SlackAssistantEventTable).where(inArray(SlackAssistantEventTable.connectionId, installed))
      .groupBy(SlackAssistantEventTable.connectionId),
    Promise.all(installed.map(async (connectionId) => [connectionId, await slackAssistantMetrics(connectionId).catch(() => null)] as const)),
  ])
  const runnerAvailable = slackRunnerAvailable()
  return installations.flatMap((installation) => {
    const connection = slack.find((entry) => entry.id === installation.connectionId)
    if (!connection) return []
    const state = {
      runnerAvailable,
      enabled: installation.enabled,
      hasBotToken: Boolean(Number(installation.hasBotToken)),
    }
    const lastEventAt = lastEvents.find((row) => row.connectionId === installation.connectionId)?.lastEventAt ?? null
    return [{
      ...state,
      id: `slack:${installation.connectionId}`,
      name: connection.name.trim().slice(0, 255) || "Slack",
      connectionId: installation.connectionId,
      version: installation.tokenVersion ?? "none",
      needsLiveCheck: slackNeedsLiveCheck(state),
      lastEventAt,
      completed24h: metrics.find(([connectionId]) => connectionId === installation.connectionId)?.[1]?.completed ?? null,
    }]
  })
}

async function googleTargets(organizationId: OrganizationId, connections: Awaited<ReturnType<typeof listExternalMcpConnections>>): Promise<GoogleConnectorTarget[]> {
  const provider = getNativeOAuthProvider(GOOGLE_WORKSPACE)
  if (!provider) return []
  const native = connections.filter((connection) => connection.kind === "native_provider" && connection.nativeProviderKey === GOOGLE_WORKSPACE)
  const sources = native.length
    ? native.map((connection) => ({ id: `google:${connection.id}`, name: connection.name.trim().slice(0, 255) || "Google Workspace", credentialProviderId: connection.id }))
    : [{ id: `google:${GOOGLE_WORKSPACE}`, name: "Google Workspace", credentialProviderId: GOOGLE_WORKSPACE }]
  const targets = await Promise.all(sources.map(async (source) => {
    const client = await getOrgOAuthClient(organizationId, source.credentialProviderId)
    // An organization OAuth app saved before connections existed only counts when it is configured.
    if (!client && !native.length) return null
    const features = clientSelectedFeatures(provider, client?.extra ?? null)
    return { ...source, features, apis: requiredGoogleApis(features).map((api) => ({ id: api.id, name: api.name })) }
  }))
  return targets.flatMap((target) => target ? [target] : [])
}

/** The organization's Slack assistant and Google Workspace connector rows. No network, no secrets. */
export async function loadConnectorTargets(organizationId: OrganizationId): Promise<ConnectorTargets> {
  const connections = await listExternalMcpConnections(organizationId)
  const [slack, google] = await Promise.all([slackTargets(organizationId, connections), googleTargets(organizationId, connections)])
  return { slack, google }
}

/** auth.test with the stored bot token; it must answer for the installed workspace. */
export async function checkSlackAssistantToken(connectionId: ConnectionId, fetchImpl: typeof fetch = fetch): Promise<{ result: SlackLiveResult; version: string }> {
  const [installation] = await db.select({
    botToken: SlackAssistantInstallationTable.botToken,
    teamId: SlackAssistantInstallationTable.teamId,
    tokenVersion: sql<string | null>`left(sha2(${SlackAssistantInstallationTable.botToken}, 256), 16)`,
  }).from(SlackAssistantInstallationTable).where(eq(SlackAssistantInstallationTable.connectionId, connectionId)).limit(1)
  if (!installation?.botToken) return { result: "rejected", version: installation?.tokenVersion ?? "none" }
  try {
    const response = await slackClient(installation.botToken, fetchImpl)("auth.test", {})
    return { result: classifySlackAuthTest({ ok: true, teamId: response.team_id }, installation.teamId), version: installation.tokenVersion ?? "none" }
  } catch (error) {
    return { result: classifySlackAuthTest({ ok: false, error }, installation.teamId), version: installation.tokenVersion ?? "none" }
  }
}

/**
 * The caller's own check of the Google APIs a connector needs, with their own
 * sign-in on it. Null when the caller has no usable sign-in.
 */
export async function checkGoogleConnectorForMember(input: {
  organizationId: OrganizationId
  orgMembershipId: MemberId
  target: GoogleConnectorTarget
  fetchImpl?: typeof fetch
}): Promise<GoogleApiCheck[] | null> {
  const provider: NativeOAuthProviderConfig | null = getNativeOAuthProvider(GOOGLE_WORKSPACE)
  if (!provider) return null
  const token = await getValidAccessToken({
    provider,
    credentialProviderId: input.target.credentialProviderId,
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
  }).catch(() => null)
  if (!token || "error" in token) return null
  return checkGoogleConnectorApis({ accessToken: token.accessToken, features: input.target.features, baseUrl: env.googleApiBaseUrl, fetch: input.fetchImpl })
}
