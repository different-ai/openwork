import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import {
  defaultWorkbotDirectMessageDeps,
  type WorkbotDirectMessageDeps,
  type WorkbotDirectMessageFailure,
  type WorkbotSlackMember,
} from "./direct-message.js"
import { SlackApiError, slackClient, type SlackCall } from "./protocol.js"

/**
 * Workbot posts in a Slack channel from the Slack app's own bot, on a member's behalf. Every post starts with a line
 * naming whose agent sent it (`<@U…>'s agent`), added here so no caller can leave it out. The bot posts only where it
 * is a member (its token has `chat:write`, not `chat:write.public`), and only in channels the member can read in
 * Slack themselves, checked with their own Slack token first: inviting the app to a private channel never lets
 * someone outside it post there.
 *
 * Installation and identity lookups are direct-message.ts's: the same installation and linked Slack user a DM uses.
 */

export type WorkbotChannelPostFailure = WorkbotDirectMessageFailure | "bot_not_in_channel" | "channel_access_denied"

export type WorkbotChannelPostResult =
  | { ok: true; channelId: string; messageTs: string; permalink?: string }
  | { ok: false; reason: WorkbotChannelPostFailure; code?: string; retryAfterMs?: number }

/** Whether the member can read the channel in Slack themselves; null when that can't be checked now. */
export type MemberChannelAccess = (input: {
  connectionId: DenTypeId<"externalMcpConnection">
  slackUserId: string
  channelId: string
}) => Promise<boolean | null>

export type WorkbotChannelPostDeps = WorkbotDirectMessageDeps & { memberCanReadChannel: MemberChannelAccess }

/** Slack's answers when the bot isn't in a channel (or, for a private one, can't see it). */
const BOT_NOT_IN_CHANNEL_CODES = new Set(["not_in_channel", "channel_not_found"])

async function memberCanReadChannel(
  input: { connectionId: DenTypeId<"externalMcpConnection">; slackUserId: string; channelId: string },
  slack: (token: string) => SlackCall = slackClient,
): Promise<boolean | null> {
  // Loaded lazily, like direct-message.ts: the assistant's repository pulls in Connect and auth.
  const { getInstallation, resolveSlackActor } = await import("./repository.js")
  const installation = await getInstallation(input.connectionId)
  if (!installation) return null
  const actor = await resolveSlackActor(installation, input.slackUserId)
  if (!actor) return null
  try {
    await slack(actor.userToken)("conversations.history", { channel: input.channelId, limit: 1 })
    return true
  } catch (error) {
    if (error instanceof SlackApiError && BOT_NOT_IN_CHANNEL_CODES.has(error.code)) return false
    return null
  }
}

export const defaultWorkbotChannelPostDeps: WorkbotChannelPostDeps = { ...defaultWorkbotDirectMessageDeps, memberCanReadChannel }

/** The first line of every channel post: a Slack mention of the member whose agent sent it. */
export function workbotAttributionLine(slackUserId: string) {
  return `<@${slackUserId}>'s agent`
}

/** Keeps @here, @channel, @everyone and user-group mentions in agent text from notifying anyone. */
export function withoutSlackBroadcasts(text: string) {
  return text
    .replace(/<!(here|channel|everyone)(\|[^>]*)?>/gi, "@\u200b$1")
    .replace(/<!subteam\^[^>]*>/gi, "@\u200bgroup")
    .replace(/@(here|channel|everyone)\b/gi, "@\u200b$1")
}

/**
 * Posts in a channel from the Workbot Slack app's bot on behalf of a member resolved with
 * resolveWorkbotDirectMessageTarget, with the attribution line first.
 */
export async function postWorkbotChannelMessage(
  member: WorkbotSlackMember,
  message: { channelId: string; text: string; threadTs?: string },
  deps: Pick<WorkbotChannelPostDeps, "botToken" | "slack" | "memberCanReadChannel"> = defaultWorkbotChannelPostDeps,
): Promise<WorkbotChannelPostResult> {
  const token = await deps.botToken(member.connectionId)
  if (!token) return { ok: false, reason: "slack_app_not_installed" }
  const access = await deps.memberCanReadChannel({ connectionId: member.connectionId, slackUserId: member.slackUserId, channelId: message.channelId })
  if (access === false) return { ok: false, reason: "channel_access_denied" }
  if (access === null) return { ok: false, reason: "slack_error", code: "channel_access_unverified" }
  const slack = deps.slack(token)
  try {
    const posted = z.object({ channel: z.string().optional(), ts: z.string() }).safeParse(
      await slack("chat.postMessage", {
        channel: message.channelId,
        text: `${workbotAttributionLine(member.slackUserId)}\n${withoutSlackBroadcasts(message.text)}`,
        ...(message.threadTs ? { thread_ts: message.threadTs } : {}),
        unfurl_links: false,
        unfurl_media: false,
      }),
    )
    if (!posted.success) return { ok: false, reason: "slack_error", code: "post_unconfirmed" }
    const channelId = posted.data.channel ?? message.channelId
    const permalink = await messagePermalink(slack, channelId, posted.data.ts)
    return { ok: true, channelId, messageTs: posted.data.ts, ...(permalink ? { permalink } : {}) }
  } catch (error) {
    if (error instanceof SlackApiError) {
      if (BOT_NOT_IN_CHANNEL_CODES.has(error.code)) return { ok: false, reason: "bot_not_in_channel", code: error.code }
      return { ok: false, reason: "slack_error", code: error.code, ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}) }
    }
    return { ok: false, reason: "slack_error", code: "request_failed" }
  }
}

/** A link to the posted message, when Slack gives one; the post already happened either way. */
async function messagePermalink(slack: SlackCall, channelId: string, messageTs: string) {
  try {
    const result = z.object({ permalink: z.string().url() }).safeParse(await slack("chat.getPermalink", { channel: channelId, message_ts: messageTs }))
    return result.success ? result.data.permalink : undefined
  } catch {
    return undefined
  }
}
