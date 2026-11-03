import { z } from "zod"
import { SlackApiError, slackFileSchema, type SlackCall, type SlackEvent } from "./protocol.js"

export const SLACK_CONTEXT_MESSAGES = 20
export const SLACK_CONTEXT_CHARS = 40_000
const PAGE_SIZE = 100
const MAX_PAGES = 4
const MAX_USERS = 12
const MAX_TEXT = 4_000
const messageSchema = z.object({
  ts: z.string().max(32).regex(/^\d+\.\d+$/),
  user: z.string().max(100).optional(),
  bot_id: z.string().max(100).optional(),
  text: z.string().optional(),
  files: z.array(slackFileSchema).optional(),
})
const pageSchema = z.object({
  messages: z.array(messageSchema),
  has_more: z.boolean().optional(),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
})
const userSchema = z.object({ user: z.object({
  id: z.string(),
  name: z.string().optional(),
  real_name: z.string().optional(),
  profile: z.object({ display_name: z.string().optional(), real_name: z.string().optional() }).optional(),
}) })

export function slackContextFailure(error: unknown) {
  // Never log provider bodies, exception messages, tokens or message content.
  return error instanceof SlackApiError && /^[a-z_]{1,80}$/.test(error.code) ? error.code : "context_fetch_failed"
}

export const unavailableSlackContext = () => ({
  unavailable: true,
  instruction: "Read the relevant thread using your Slack connection.",
})

/** Compare Slack's decimal timestamps without losing microsecond precision. */
function compareTs(left: string, right: string) {
  const [ls = "", lm = ""] = left.split(".")
  const [rs = "", rm = ""] = right.split(".")
  return ls.length - rs.length || ls.localeCompare(rs) || lm.padEnd(6, "0").localeCompare(rm.padEnd(6, "0"))
}

/**
 * Only the already authenticated member's client belongs here, never the bot's client. Reads stay in the event's
 * channel/thread, end at the invocation, and never follow links, mentioned channels, app_context or file URLs.
 */
export async function loadSlackContext(input: {
  slack: SlackCall
  event: SlackEvent
  channelId: string
  log: (fields: { stage: string; reason: string }) => void
}) {
  const { slack, event, channelId, log } = input
  const threaded = Boolean(event.thread_ts && event.thread_ts !== event.ts)
  try {
    if (!event.ts || !/^\d+\.\d+$/.test(event.ts)) throw new Error("invalid_context_timestamp")
    const invocationTs = event.ts
    const method = threaded ? "conversations.replies" : "conversations.history"
    const messages: z.infer<typeof messageSchema>[] = []
    let cursor: string | undefined
    let truncated = false
    // Replies are oldest first, so keep a rolling tail across bounded pages, not just the first 30 replies.
    // Extremely long threads stop after MAX_PAGES; truncated explicitly says this is only a partial view.
    for (let page = 0; page < (threaded ? MAX_PAGES : 1); page += 1) {
      const result = pageSchema.parse(await slack(method, {
        channel: channelId,
        ...(threaded ? { ts: event.thread_ts } : {}),
        latest: invocationTs,
        inclusive: threaded,
        limit: threaded ? PAGE_SIZE : SLACK_CONTEXT_MESSAGES,
        ...(cursor ? { cursor } : {}),
      }))
      for (const message of result.messages) {
        if (compareTs(message.ts, invocationTs) >= 0) continue
        if (messages.some((existing) => existing.ts === message.ts)) continue
        messages.push(message)
      }
      messages.sort((a, b) => compareTs(a.ts, b.ts))
      if (messages.length > SLACK_CONTEXT_MESSAGES) {
        truncated = true
        // Keep the parent plus the most recent replies; channel history keeps only the recent window.
        if (threaded && messages[0]?.ts === event.thread_ts) messages.splice(1, messages.length - SLACK_CONTEXT_MESSAGES)
        else messages.splice(0, messages.length - SLACK_CONTEXT_MESSAGES)
      }
      cursor = result.response_metadata?.next_cursor || undefined
      if (!cursor) {
        if (result.has_more) truncated = true
        break
      }
      if (!threaded || page === MAX_PAGES - 1) {
        truncated = true
        if (threaded) log({ stage: "messages", reason: "page_limit" })
      }
    }
    // Names are optional enrichment. IDs remain authoritative, including mentions in invocation.text.
    const users = new Map<string, string>()
    const ids = new Set<string>()
    const collect = (text: string) => {
      for (const match of text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g)) if (match[1]) ids.add(match[1])
    }
    collect((event.text ?? "").slice(0, 40_000))
    for (const message of messages) {
      if (message.user) ids.add(message.user)
      collect((message.text ?? "").slice(0, MAX_TEXT))
    }
    const selectedIds = [...ids].slice(0, MAX_USERS)
    let namesUnavailable = false
    // Small batches avoid a long serial chain and bound concurrent Slack calls.
    for (let start = 0; start < selectedIds.length && !namesUnavailable; start += 4) {
      await Promise.all(selectedIds.slice(start, start + 4).map(async (id) => {
        try {
          const { user } = userSchema.parse(await slack("users.info", { user: id }))
          if (user.id !== id) return
          const name = user.profile?.display_name || user.profile?.real_name || user.real_name || user.name
          if (name) users.set(id, name.slice(0, 120))
        } catch (error) {
          if (!namesUnavailable) log({ stage: "users", reason: slackContextFailure(error) })
          namesUnavailable = true
        }
      }))
    }
    const context = {
      kind: threaded ? "thread" : "channel_history",
      truncated: truncated || ids.size > MAX_USERS,
      users: Object.fromEntries(users),
      messages: messages.map((message) => {
        const text = (message.text ?? "").slice(0, MAX_TEXT)
        const files = message.files?.slice(0, 10).map((file) => ({
          id: file.id.slice(0, 100),
          name: file.name?.slice(0, 250),
          filetype: file.filetype?.slice(0, 100),
          mimetype: file.mimetype?.slice(0, 100),
        }))
        return {
          ts: message.ts,
          user: message.user,
          display_name: message.user ? users.get(message.user) : undefined,
          bot_id: message.bot_id,
          // Workspace-independent Slack deep links avoid one chat.getPermalink request per message.
          permalink: `https://app.slack.com/archives/${encodeURIComponent(channelId)}/p${message.ts.replace(".", "")}`,
          text,
          files,
          ...(text.length !== (message.text ?? "").length || (message.files?.length ?? 0) > 10 ? { truncated: true } : {}),
        }
      }),
    }
    if (context.messages.some((message) => message.truncated)) context.truncated = true
    // Account for JSON escaping, names and file metadata, retaining valid JSON and the thread parent.
    while (JSON.stringify(context).length > SLACK_CONTEXT_CHARS) {
      context.truncated = true
      if (context.messages.length > 1) {
        context.messages.splice(threaded && context.messages[0]?.ts === event.thread_ts ? 1 : 0, 1)
        continue
      }
      // Even one message can exceed the budget when control characters expand during JSON escaping.
      const only = context.messages[0]
      if (only?.files?.length) only.files.pop()
      else if (only?.text) only.text = only.text.slice(0, Math.floor(only.text.length / 2))
      else break
    }
    return context
  } catch (error) {
    log({ stage: "messages", reason: slackContextFailure(error) })
    return unavailableSlackContext()
  }
}
