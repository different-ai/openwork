import { and, eq, inArray, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import {
  MemberTable,
  SlackAssistantIdentityTable as Identity,
  SlackAssistantInstallationTable as Installation,
} from "@openwork-ee/den-db/schema"
import { isDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { db } from "../db.js"
import { isSandboxSlackToken, SlackApiError, slackClient, type SlackCall } from "./protocol.js"
import { logSlackBlocksRejected } from "./rich-delivery.js"
import { postSlackFollowUps, postSlackMessage, type SlackOutgoingMessage } from "./rich-message.js"

export type WorkbotDirectMessageFailure = "slack_app_not_installed" | "member_not_linked" | "slack_error"

export type WorkbotDirectMessageResult =
  | { ok: true; channelId: string; messageTs: string; permalink?: string | null; partial?: boolean }
  | { ok: false; reason: WorkbotDirectMessageFailure; code?: string; retryAfterMs?: number }

export type WorkbotDirectMessageTarget =
  | { ok: true; connectionId: DenTypeId<"externalMcpConnection">; slackUserId: string }
  | { ok: false; reason: Exclude<WorkbotDirectMessageFailure, "slack_error"> }

export type WorkbotSlackMember = Extract<WorkbotDirectMessageTarget, { ok: true }>

type ReadyInstallation = { connectionId: DenTypeId<"externalMcpConnection">; teamId: string }

export type WorkbotDirectMessageDeps = {
  installations: (organizationId: DenTypeId<"organization">) => Promise<ReadyInstallation[]>
  linkedSlackUser: (input: { organizationId: DenTypeId<"organization">; userId: DenTypeId<"user">; installation: ReadyInstallation }) => Promise<string | null>
  botToken: (connectionId: DenTypeId<"externalMcpConnection">) => Promise<string | null>
  slack: (token: string, baseUrl?: string) => SlackCall
  sandboxApiBase?: (connectionId: DenTypeId<"externalMcpConnection">) => Promise<string | null>
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

async function sandboxApiBase(connectionId: DenTypeId<"externalMcpConnection">) {
  const { sandboxSlackApiBase } = await import("./sandbox-api.js")
  return sandboxSlackApiBase(connectionId)
}

export const defaultWorkbotDirectMessageDeps: WorkbotDirectMessageDeps = {
  installations: readyInstallations,
  linkedSlackUser,
  botToken,
  slack: (token, baseUrl) => slackClient(token, fetch, baseUrl),
  sandboxApiBase,
}

export async function workbotSlackCall(
  connectionId: DenTypeId<"externalMcpConnection">,
  token: string,
  deps: Pick<WorkbotDirectMessageDeps, "slack" | "sandboxApiBase">,
): Promise<SlackCall | null> {
  if (!isSandboxSlackToken(token)) return deps.slack(token)
  const baseUrl = await (deps.sandboxApiBase ?? sandboxApiBase)(connectionId)
  return baseUrl ? deps.slack(token, baseUrl) : null
}

export async function workbotSlackAppReady(organizationId: string, deps: Pick<WorkbotDirectMessageDeps, "installations"> = defaultWorkbotDirectMessageDeps) {
  if (!isDenTypeId("organization", organizationId)) return false
  return (await deps.installations(organizationId)).length > 0
}

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

export async function sendWorkbotDirectMessage(
  input: { organizationId: string; userId: string; text: string; threadTs?: string; permalink?: boolean; rich?: readonly SlackOutgoingMessage[] },
  deps: WorkbotDirectMessageDeps = defaultWorkbotDirectMessageDeps,
): Promise<WorkbotDirectMessageResult> {
  const target = await resolveWorkbotDirectMessageTarget(input, deps)
  if (!target.ok) return target
  return sendWorkbotDirectMessageTo(target, input, deps)
}

export type WorkbotDirectMessageTurn = { at: number; from: "agent" | "member"; text: string }

const historyMessageSchema = z.object({
  ts: z.string(),
  text: z.string().optional(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  subtype: z.string().optional(),
  reply_count: z.number().optional(),
})
const historySchema = z.object({ messages: z.array(z.unknown()).default([]) })

function turnsOf(raw: readonly unknown[], slackUserId: string, skipTs?: string): WorkbotDirectMessageTurn[] {
  return raw.flatMap((entry) => {
    const message = historyMessageSchema.safeParse(entry)
    if (!message.success || message.data.ts === skipTs || !message.data.text?.trim()) return []
    if (message.data.subtype && message.data.subtype !== "bot_message" && message.data.subtype !== "thread_broadcast") return []
    const at = Math.round(Number(message.data.ts) * 1000)
    if (!Number.isFinite(at)) return []
    const from: WorkbotDirectMessageTurn["from"] = !message.data.bot_id && message.data.user === slackUserId ? "member" : "agent"
    return [{ at, from, text: message.data.text }]
  })
}

export async function readWorkbotDirectMessages(
  input: { organizationId: string; userId: string; since: number; limit?: number; threads?: number },
  deps: WorkbotDirectMessageDeps = defaultWorkbotDirectMessageDeps,
): Promise<WorkbotDirectMessageTurn[] | null> {
  const target = await resolveWorkbotDirectMessageTarget(input, deps)
  if (!target.ok) return null
  const token = await deps.botToken(target.connectionId)
  if (!token) return null
  const slack = await workbotSlackCall(target.connectionId, token, deps)
  if (!slack) return null
  const limit = input.limit ?? 20
  try {
    const opened = z.object({ channel: z.object({ id: z.string() }) }).safeParse(await slack("conversations.open", { users: target.slackUserId }))
    if (!opened.success) return null
    const channel = opened.data.channel.id
    const history = historySchema.parse(await slack("conversations.history", { channel, limit, oldest: String(Math.floor(input.since / 1000)) }))
    const turns = turnsOf(history.messages, target.slackUserId)
    const threaded = history.messages
      .flatMap((entry) => {
        const message = historyMessageSchema.safeParse(entry)
        return message.success && (message.data.reply_count ?? 0) > 0 ? [message.data.ts] : []
      })
      .sort((left, right) => Number(right) - Number(left))
      .slice(0, input.threads ?? 3)
    for (const ts of threaded) {
      const replies = historySchema.safeParse(await slack("conversations.replies", { channel, ts, limit: 10 }).catch(() => null))
      if (replies.success) turns.push(...turnsOf(replies.data.messages, target.slackUserId, ts))
    }
    return turns.filter((turn) => turn.at >= input.since).sort((left, right) => left.at - right.at).slice(-limit)
  } catch {
    return null
  }
}

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

export async function sendWorkbotDirectMessageTo(
  target: WorkbotSlackMember,
  message: { text: string; threadTs?: string; permalink?: boolean; rich?: readonly SlackOutgoingMessage[] },
  deps: Pick<WorkbotDirectMessageDeps, "botToken" | "slack" | "sandboxApiBase"> = defaultWorkbotDirectMessageDeps,
): Promise<WorkbotDirectMessageResult> {
  const token = await deps.botToken(target.connectionId)
  if (!token) return { ok: false, reason: "slack_app_not_installed" }
  const slack = await workbotSlackCall(target.connectionId, token, deps)
  if (!slack) return { ok: false, reason: "slack_error", code: "sandbox_slack_unavailable" }
  try {
    const opened = z.object({ channel: z.object({ id: z.string() }) }).safeParse(await slack("conversations.open", { users: target.slackUserId }))
    if (!opened.success) return { ok: false, reason: "slack_error", code: "dm_unavailable" }
    const place = { channel: opened.data.channel.id, ...(message.threadTs ? { thread_ts: message.threadTs } : {}) }
    const onRejected = (code: string) => logSlackBlocksRejected("direct_message", code)
    const [lead, ...rest] = message.rich ?? []
    const posted = z.object({ ts: z.string() }).safeParse(
      lead
        ? await postSlackMessage(slack, place, lead, { onRejected })
        : await slack("chat.postMessage", { ...place, text: message.text, unfurl_links: false, unfurl_media: false }),
    )
    if (!posted.success) return { ok: false, reason: "slack_error", code: "post_unconfirmed" }
    const complete = await postSlackFollowUps(slack, place, rest, onRejected)
    const sent: WorkbotDirectMessageResult = { ok: true, channelId: opened.data.channel.id, messageTs: posted.data.ts, ...(complete ? {} : { partial: true }) }
    if (!message.permalink) return sent
    const permalink = await slack("chat.getPermalink", { channel: opened.data.channel.id, message_ts: posted.data.ts }).then(slackPermalink, () => null)
    return { ...sent, permalink }
  } catch (error) {
    if (error instanceof SlackApiError) return { ok: false, reason: "slack_error", code: error.code, ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}) }
    return { ok: false, reason: "slack_error", code: "request_failed" }
  }
}
