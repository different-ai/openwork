import { and, eq, gt, isNull } from "@openwork-ee/den-db/drizzle"
import { McpEventTurnTable, MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { workbotOwner } from "@openwork-ee/headless-protocol/workbot-routing"
import { db } from "../db.js"
import { getOrganizationFeatures, organizationFeatureEnabled } from "../features.js"
import { createHeadlessRunnerClient, defaultHeadlessRunnerDeps } from "../headless-runner/client.js"
import { headlessRunTokenId } from "../mcp/headless-run-token.js"
import { resolveMcpMemberIdentity } from "../mcp/external-capabilities.js"
import { connectionsWithheld, workbotTurnLimitScopes } from "../mcp/workbot-turn-limits.js"
import { listUsableExternalMcpConnections, readyExternalMcpConnectionsForMember } from "../capability-sources/external-mcp-connections.js"
import { resolveMemberAgentPolicy, resolveMemberWorkbotSettings } from "../workbot/team-settings.js"
import type { McpPrincipal } from "../mcp/auth.js"

export type EventThread = typeof McpEventTurnTable.$inferSelect
export class EventAccessError extends Error {}

export async function bindEventTurn(input: { tokenId: string; resumeGrantId?: string | null; organizationId: string; userId: string; memberId?: string; sessionId?: string; model?: string; readOnly?: boolean; expiresAt: Date }) {
  if (input.readOnly || !input.memberId || !input.sessionId || !input.model || !await organizationFeatureEnabled(input.organizationId, "mcpThreadEvents", { userId: input.userId })) return
  await db.insert(McpEventTurnTable).values({
    tokenId: normalizeDenTypeId("oauthAccessToken", input.tokenId),
    resumeGrantId: input.resumeGrantId ? normalizeDenTypeId("headlessResumeGrant", input.resumeGrantId) : null,
    organizationId: normalizeDenTypeId("organization", input.organizationId), userId: normalizeDenTypeId("user", input.userId),
    memberId: normalizeDenTypeId("member", input.memberId), sessionId: input.sessionId, model: input.model, expiresAt: input.expiresAt,
  })
}

/** Restore only an explicitly bound grant. Its tasks inherit the same chat, as with the initial MCP token. */
export async function rebindEventTurn(input: { tokenId: string; resumeGrantId: string; organizationId: string; userId: string; memberId: string; sessionId: string; expiresAt: Date }) {
  const [binding] = await db.$primary.select().from(McpEventTurnTable).where(and(
    eq(McpEventTurnTable.resumeGrantId, normalizeDenTypeId("headlessResumeGrant", input.resumeGrantId)), eq(McpEventTurnTable.organizationId, normalizeDenTypeId("organization", input.organizationId)),
    eq(McpEventTurnTable.userId, normalizeDenTypeId("user", input.userId)), eq(McpEventTurnTable.memberId, normalizeDenTypeId("member", input.memberId)),
    eq(McpEventTurnTable.sessionId, input.sessionId), gt(McpEventTurnTable.expiresAt, new Date()),
  )).limit(1)
  if (binding) await bindEventTurn({ ...input, model: binding.model })
}

export async function eventThreadForPrincipal(principal: McpPrincipal): Promise<EventThread | null> {
  const id = headlessRunTokenId(principal.payload)
  if (!id || !principal.scopes.has("mcp:write")) return null
  const [thread] = await db.$primary.select().from(McpEventTurnTable).where(and(
    eq(McpEventTurnTable.tokenId, normalizeDenTypeId("oauthAccessToken", id)),
    eq(McpEventTurnTable.organizationId, normalizeDenTypeId("organization", principal.organizationId)),
    eq(McpEventTurnTable.userId, normalizeDenTypeId("user", principal.userId)), gt(McpEventTurnTable.expiresAt, new Date()),
  )).limit(1)
  return thread ?? null
}

type Actor = Pick<EventThread, "organizationId" | "memberId" | "userId" | "sessionId">
/** Recheck current membership, rollout, Workbot policy, grants and connected credentials at every use. */
export async function eventAccess(actor: Actor, originalScopes: readonly string[]) {
  const [member] = await db.$primary.select({ id: MemberTable.id }).from(MemberTable).where(and(
    eq(MemberTable.id, actor.memberId), eq(MemberTable.organizationId, actor.organizationId), eq(MemberTable.userId, actor.userId), isNull(MemberTable.removedAt),
  )).limit(1)
  if (!member) throw new EventAccessError("Your membership is no longer active.")
  const features = await getOrganizationFeatures(actor.organizationId, { userId: actor.userId })
  if (!features.mcpThreadEvents) throw new EventAccessError("MCP thread events are turned off.")
  const settings = await resolveMemberWorkbotSettings({ ...actor, featureOn: features.workbotTeamSettings })
  if (!settings.enabled) throw new EventAccessError("Workbot is turned off for this member.")
  const policy = features.workbotProactive ? await resolveMemberAgentPolicy({ ...actor, workbot: settings, featureOn: features.workbotTeamSettings }) : null
  const scopes = [...new Set([...originalScopes, ...(policy ? workbotTurnLimitScopes(policy.settings.sources) : [])])]
  const identity = await resolveMcpMemberIdentity(actor)
  if (!identity) throw new EventAccessError("Your membership is no longer active.")
  const usable = await listUsableExternalMcpConnections({ organizationId: actor.organizationId, ...identity, withheldConnectionIds: connectionsWithheld(new Set(scopes)) })
  const connections = await readyExternalMcpConnectionsForMember(usable.filter((connection) => connection.kind === "external_mcp"), actor.memberId)
  return { connections, scopes, features }
}

export function eventRunner(actor: Actor, scopes: readonly string[]) {
  const deps = defaultHeadlessRunnerDeps(process.env, { indexKind: "workbot", memberId: actor.memberId })
  if (!deps) throw new Error("The hosted thread runner is unavailable.")
  return createHeadlessRunnerClient({
    ...deps, config: { ...deps.config, owner: workbotOwner(actor.organizationId, actor.memberId) },
    mintToken: (input) => deps.mintToken({ ...input, scopes }),
  })
}

/** A client cannot turn an arbitrary run-token session id into a subscription target. The runner owns this check. */
export async function requireEventThread(actor: Actor, scopes: readonly string[]) {
  const runner = eventRunner(actor, scopes)
  const snapshot = await runner.readSession(actor.sessionId, { expectedOwner: workbotOwner(actor.organizationId, actor.memberId), turns: 1, limit: 1, outputs: "none" })
  if (!snapshot.ok) {
    if ([403, 404].includes(snapshot.status)) throw new EventAccessError("This hosted chat no longer exists or belongs to another member.")
    throw new Error("The hosted chat could not be checked. Try again.")
  }
  return { runner, snapshot: snapshot.value }
}
