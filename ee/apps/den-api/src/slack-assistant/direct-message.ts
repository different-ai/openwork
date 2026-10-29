import { and, eq, inArray, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import {
  MemberTable,
  SlackAssistantIdentityTable as Identity,
  SlackAssistantInstallationTable as Installation,
} from "@openwork-ee/den-db/schema"
import { isDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { db } from "../db.js"
import { SlackApiError, slackClient, type SlackCall } from "./protocol.js"

/**
 * Workbot messages a member in Slack from the Slack app's own bot identity: a DM in the app's Messages tab, which
 * notifies them like any DM. (Posting as the member never does: Slack doesn't notify you about your own messages.)
 * Anything that needs to tell a member something uses this. It needs the Slack assistant installed and on for the
 * organization (a bot token) and the member's Slack account linked to OpenWork, and answers with a typed reason
 * instead of throwing when either is missing.
 *
 * The bot can open a DM with someone who has never written to it (`im:write`, already in the app's scopes). When the
 * member replies in the message's thread, the Slack assistant reads that thread with their own token, so Workbot
 * sees what it sent.
 */

export type WorkbotDirectMessageFailure = "slack_app_not_installed" | "member_not_linked" | "slack_error"

export type WorkbotDirectMessageResult =
  /** `permalink` only when asked for: the message's Slack link, or null when Slack didn't give one. */
  | { ok: true; channelId: string; messageTs: string; permalink?: string | null }
  | { ok: false; reason: WorkbotDirectMessageFailure; code?: string; retryAfterMs?: number }

/** Where a DM to this member would go, without sending anything. */
export type WorkbotDirectMessageTarget =
  | { ok: true; connectionId: DenTypeId<"externalMcpConnection">; slackUserId: string }
  | { ok: false; reason: Exclude<WorkbotDirectMessageFailure, "slack_error"> }

/** The member's linked Slack user on an installation Workbot can send from. */
export type WorkbotSlackMember = Extract<WorkbotDirectMessageTarget, { ok: true }>

type ReadyInstallation = { connectionId: DenTypeId<"externalMcpConnection">; teamId: string }

export type WorkbotDirectMessageDeps = {
  /** The organization's Slack assistant installations that are on and have a bot token. */
  installations: (organizationId: DenTypeId<"organization">) => Promise<ReadyInstallation[]>
  /** The member's linked Slack user on one installation, when the assistant would still answer them as themselves. */
  linkedSlackUser: (input: { organizationId: DenTypeId<"organization">; userId: DenTypeId<"user">; installation: ReadyInstallation }) => Promise<string | null>
  botToken: (connectionId: DenTypeId<"externalMcpConnection">) => Promise<string | null>
  slack: (token: string) => SlackCall
}

async function readyInstallations(organizationId: DenTypeId<"organization">): Promise<ReadyInstallation[]> {
  const rows = await db
    .select({ connectionId: Installation.connectionId, teamId: Installation.teamId })
    .from(Installation)
    .where(and(eq(Installation.organizationId, organizationId), eq(Installation.enabled, true), isNotNull(Installation.botToken), isNotNull(Installation.teamId)))
  return rows.flatMap((row) => (row.teamId ? [{ connectionId: row.connectionId, teamId: row.teamId }] : []))
}

async function linkedSlackUser(input: { organizationId: DenTypeId<"organization">; userId: DenTypeId<"user">; installation: ReadyInstallation }) {
  const members = await db
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, input.organizationId), eq(MemberTable.userId, input.userId), isNull(MemberTable.removedAt)))
  if (!members.length) return null
  const identities = await db
    .select({ slackUserId: Identity.slackUserId })
    .from(Identity)
    .where(and(eq(Identity.connectionId, input.installation.connectionId), eq(Identity.teamId, input.installation.teamId), inArray(Identity.memberId, members.map((member) => member.id))))
  if (!identities.length) return null
  // The same gates as a reply: still connected, still granted, the assistant still on. Loaded lazily, since the
  // assistant's repository pulls in Connect and auth.
  const { getInstallation, resolveSlackActor } = await import("./repository.js")
  const installation = await getInstallation(input.installation.connectionId)
  if (!installation) return null
  for (const identity of identities) {
    const actor = await resolveSlackActor(installation, identity.slackUserId)
    if (actor?.userId === input.userId) return identity.slackUserId
  }
  return null
}

async function botToken(connectionId: DenTypeId<"externalMcpConnection">) {
  const [row] = await db.select({ botToken: Installation.botToken }).from(Installation).where(eq(Installation.connectionId, connectionId)).limit(1)
  return row?.botToken ?? null
}

export const defaultWorkbotDirectMessageDeps: WorkbotDirectMessageDeps = { installations: readyInstallations, linkedSlackUser, botToken, slack: slackClient }

/** True when the organization has the Slack app installed and on: Workbot has a bot to DM members from. */
export async function workbotSlackAppReady(organizationId: string, deps: Pick<WorkbotDirectMessageDeps, "installations"> = defaultWorkbotDirectMessageDeps) {
  if (!isDenTypeId("organization", organizationId)) return false
  return (await deps.installations(organizationId)).length > 0
}

/** Whether Workbot could DM this member now, and where. Sends nothing. */
export async function resolveWorkbotDirectMessageTarget(
  input: { organizationId: string; userId: string },
  deps: Pick<WorkbotDirectMessageDeps, "installations" | "linkedSlackUser"> = defaultWorkbotDirectMessageDeps,
): Promise<WorkbotDirectMessageTarget> {
  if (!isDenTypeId("organization", input.organizationId) || !isDenTypeId("user", input.userId)) return { ok: false, reason: "member_not_linked" }
  const installations = await deps.installations(input.organizationId)
  if (!installations.length) return { ok: false, reason: "slack_app_not_installed" }
  for (const installation of installations) {
    const slackUserId = await deps.linkedSlackUser({ organizationId: input.organizationId, userId: input.userId, installation })
    if (slackUserId) return { ok: true, connectionId: installation.connectionId, slackUserId }
  }
  return { ok: false, reason: "member_not_linked" }
}

/** DMs the member from the Workbot Slack app's bot. Plain text (Slack mrkdwn), links not unfurled. */
export async function sendWorkbotDirectMessage(
  input: { organizationId: string; userId: string; text: string; threadTs?: string; permalink?: boolean },
  deps: WorkbotDirectMessageDeps = defaultWorkbotDirectMessageDeps,
): Promise<WorkbotDirectMessageResult> {
  const target = await resolveWorkbotDirectMessageTarget(input, deps)
  if (!target.ok) return target
  return sendWorkbotDirectMessageTo(target, input, deps)
}

/** A Slack message link Den may show the member: https on a Slack host only. */
function slackPermalink(value: unknown): string | null {
  const parsed = z.object({ permalink: z.string() }).safeParse(value)
  if (!parsed.success) return null
  try {
    const url = new URL(parsed.data.permalink)
    return url.protocol === "https:" && (url.hostname === "slack.com" || url.hostname.endsWith(".slack.com")) ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * The same DM to a member already resolved, optionally as a reply in one of its threads. With `permalink`, also asks
 * Slack for the message's link (`chat.getPermalink`, no extra scope); a failure there never fails the send.
 */
export async function sendWorkbotDirectMessageTo(
  target: WorkbotSlackMember,
  message: { text: string; threadTs?: string; permalink?: boolean },
  deps: Pick<WorkbotDirectMessageDeps, "botToken" | "slack"> = defaultWorkbotDirectMessageDeps,
): Promise<WorkbotDirectMessageResult> {
  const token = await deps.botToken(target.connectionId)
  if (!token) return { ok: false, reason: "slack_app_not_installed" }
  const slack = deps.slack(token)
  try {
    const opened = z.object({ channel: z.object({ id: z.string() }) }).safeParse(await slack("conversations.open", { users: target.slackUserId }))
    if (!opened.success) return { ok: false, reason: "slack_error", code: "dm_unavailable" }
    const posted = z.object({ ts: z.string() }).safeParse(
      await slack("chat.postMessage", {
        channel: opened.data.channel.id,
        text: message.text,
        ...(message.threadTs ? { thread_ts: message.threadTs } : {}),
        unfurl_links: false,
        unfurl_media: false,
      }),
    )
    if (!posted.success) return { ok: false, reason: "slack_error", code: "post_unconfirmed" }
    const sent: WorkbotDirectMessageResult = { ok: true, channelId: opened.data.channel.id, messageTs: posted.data.ts }
    if (!message.permalink) return sent
    const permalink = await slack("chat.getPermalink", { channel: opened.data.channel.id, message_ts: posted.data.ts }).then(slackPermalink, () => null)
    return { ...sent, permalink }
  } catch (error) {
    if (error instanceof SlackApiError) return { ok: false, reason: "slack_error", code: error.code, ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}) }
    return { ok: false, reason: "slack_error", code: "request_failed" }
  }
}
