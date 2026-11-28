import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import {
  defaultWorkbotDirectMessageDeps,
  type WorkbotDirectMessageDeps,
  type WorkbotDirectMessageFailure,
  type WorkbotSlackMember,
  workbotSlackCall,
} from "./direct-message.js"
import { isSandboxSlackToken, SlackApiError, slackClient, type SlackCall } from "./protocol.js"
import { logSlackBlocksRejected } from "./rich-delivery.js"
import { postSlackFollowUps, postSlackMessage, type SlackOutgoingMessage } from "./rich-message.js"
import { withoutSlackBroadcasts } from "./slack-text.js"

export type WorkbotChannelPostFailure = WorkbotDirectMessageFailure | "bot_not_in_channel" | "channel_access_denied"

export type WorkbotChannelPostResult =
  | { ok: true; channelId: string; messageTs: string; permalink?: string; partial?: boolean }
  | { ok: false; reason: WorkbotChannelPostFailure; code?: string; retryAfterMs?: number }

export type MemberChannelAccess = (input: {
  connectionId: DenTypeId<"externalMcpConnection">
  slackUserId: string
  channelId: string
}) => Promise<boolean | null>

export type WorkbotChannelPostDeps = WorkbotDirectMessageDeps & { memberCanReadChannel: MemberChannelAccess }

const BOT_NOT_IN_CHANNEL_CODES = new Set(["not_in_channel", "channel_not_found"])

async function memberCanReadChannel(
  input: { connectionId: DenTypeId<"externalMcpConnection">; slackUserId: string; channelId: string },
  slack: (token: string) => SlackCall = slackClient,
): Promise<boolean | null> {
  const { getInstallation, resolveSlackActor } = await import("./repository.js")
  const installation = await getInstallation(input.connectionId)
  if (!installation) return null
  const actor = await resolveSlackActor(installation, input.slackUserId)
  if (!actor) return null
  let call = isSandboxSlackToken(installation.botToken) ? null : slack(actor.userToken)
  if (!call) {
    const { sandboxSlackApiBase } = await import("./sandbox-api.js")
    const baseUrl = await sandboxSlackApiBase(input.connectionId)
    if (!baseUrl) return null
    call = slackClient(actor.userToken, fetch, baseUrl)
  }
  try {
    await call("conversations.history", { channel: input.channelId, limit: 1 })
    return true
  } catch (error) {
    if (error instanceof SlackApiError && BOT_NOT_IN_CHANNEL_CODES.has(error.code)) return false
    return null
  }
}

export const defaultWorkbotChannelPostDeps: WorkbotChannelPostDeps = { ...defaultWorkbotDirectMessageDeps, memberCanReadChannel }

export function workbotAttributionLine(slackUserId: string) {
  return `<@${slackUserId}>'s agent`
}

export { withoutSlackBroadcasts }

export const WORKBOT_ATTRIBUTION_BLOCKS = 1

export async function postWorkbotChannelMessage(
  member: WorkbotSlackMember,
  message: { channelId: string; text: string; threadTs?: string; rich?: readonly SlackOutgoingMessage[] },
  deps: Pick<WorkbotChannelPostDeps, "botToken" | "slack" | "sandboxApiBase" | "memberCanReadChannel"> = defaultWorkbotChannelPostDeps,
): Promise<WorkbotChannelPostResult> {
  const token = await deps.botToken(member.connectionId)
  if (!token) return { ok: false, reason: "slack_app_not_installed" }
  const access = await deps.memberCanReadChannel({ connectionId: member.connectionId, slackUserId: member.slackUserId, channelId: message.channelId })
  if (access === false) return { ok: false, reason: "channel_access_denied" }
  if (access === null) return { ok: false, reason: "slack_error", code: "channel_access_unverified" }
  const slack = await workbotSlackCall(member.connectionId, token, deps)
  if (!slack) return { ok: false, reason: "slack_error", code: "sandbox_slack_unavailable" }
  try {
    const attribution = workbotAttributionLine(member.slackUserId)
    const place = { channel: message.channelId, ...(message.threadTs ? { thread_ts: message.threadTs } : {}) }
    const onRejected = (code: string) => logSlackBlocksRejected("channel_post", code)
    const [lead, ...rest] = message.rich ?? []
    const posted = z.object({ channel: z.string().optional(), ts: z.string() }).safeParse(
      lead
        ? await postSlackMessage(slack, place, lead, { before: [{ type: "section", text: { type: "mrkdwn", text: attribution } }], textPrefix: `${attribution}\n`, onRejected })
        : await slack("chat.postMessage", { ...place, text: `${attribution}\n${withoutSlackBroadcasts(message.text)}`, unfurl_links: false, unfurl_media: false }),
    )
    if (!posted.success) return { ok: false, reason: "slack_error", code: "post_unconfirmed" }
    const complete = await postSlackFollowUps(slack, place, rest, onRejected)
    const channelId = posted.data.channel ?? message.channelId
    const permalink = await messagePermalink(slack, channelId, posted.data.ts)
    return { ok: true, channelId, messageTs: posted.data.ts, ...(permalink ? { permalink } : {}), ...(complete ? {} : { partial: true }) }
  } catch (error) {
    if (error instanceof SlackApiError) {
      if (BOT_NOT_IN_CHANNEL_CODES.has(error.code)) return { ok: false, reason: "bot_not_in_channel", code: error.code }
      return { ok: false, reason: "slack_error", code: error.code, ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}) }
    }
    return { ok: false, reason: "slack_error", code: "request_failed" }
  }
}

async function messagePermalink(slack: SlackCall, channelId: string, messageTs: string) {
  try {
    const result = z.object({ permalink: z.string().url() }).safeParse(await slack("chat.getPermalink", { channel: channelId, message_ts: messageTs }))
    return result.success ? result.data.permalink : undefined
  } catch {
    return undefined
  }
}
