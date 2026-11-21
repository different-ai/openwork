import { createHash } from "node:crypto"
import { and, gte, lte, sql } from "@openwork-ee/den-db/drizzle"
import { RateLimitTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { db } from "../db.js"
import {
  defaultWorkbotChannelPostDeps,
  postWorkbotChannelMessage,
  type WorkbotChannelPostFailure,
  type WorkbotChannelPostResult,
} from "../slack-assistant/bot-post.js"
import {
  resolveWorkbotDirectMessageTarget,
  sendWorkbotDirectMessageTo,
  type WorkbotDirectMessageResult,
  type WorkbotDirectMessageTarget,
  type WorkbotSlackMember,
} from "../slack-assistant/direct-message.js"
import { checkFixedWindowRateLimit } from "../utils/rate-limit.js"
import { scoreText, tokenize, type CapabilityMatch } from "./search.js"

export const SLACK_SEND_AS_BOT_CAPABILITY = "slack_send_as_bot"

export const SLACK_SEND_AS_BOT_SUMMARY =
  "Send a Slack message as the OpenWork bot instead of as you, so the user gets a real Slack notification. Use target me whenever they want something sent to themselves: \"send me…\", \"DM me\", \"message me\", \"notify me\", \"ping me when it's done\", \"remind me\", \"let me know\", also in Automations. Use target channel to post in a channel on OpenWork's behalf. To post as the user (\"as me\"), use slack_send_message; it never notifies them about their own message."

const TEXT_MAX = 4_000

export const SLACK_SEND_AS_BOT_ARGUMENTS_SCHEMA = {
  type: "object",
  properties: {
    target: {
      type: "string",
      enum: ["me", "channel"],
      description: "me: a DM to you from the OpenWork app, which notifies you. channel: a post in channelId that starts with a line naming your agent.",
    },
    channelId: { type: "string", description: "For target channel: the Slack channel ID, such as C0123ABCD (not its #name). The OpenWork app must be in that channel." },
    text: { type: "string", maxLength: TEXT_MAX, description: "The message, in Slack mrkdwn." },
    threadTs: { type: "string", description: "Optional: reply in this thread (the parent message's ts)." },
  },
  required: ["target", "text"],
  additionalProperties: false,
}

const SEARCH_EXTRA_TOKENS = "notify notified notification ping alert remind reminder tell bot openwork app done finished"

const SELF_WORDS = new Set(["me", "myself"])
const NOTIFY_WORDS = new Set(["dm", "dms", "notify", "notified", "notification", "notifications", "ping"])
const SEND_WORDS = new Set(["send", "message", "post", "remind", "reminder", "alert", "know", "tell"])
const OTHER_CHANNEL_WORDS = new Set(["email", "mail", "gmail", "inbox", "outlook", "sms", "teams", "discord", "whatsapp", "telegram"])
const SELF_NOTIFICATION_ALIASES = "notify notified notification ping dm remind reminder alert know myself"

function asTheUser(tokens: string[]) {
  return tokens.some((token, index) => (token === "as" || token === "from") && SELF_WORDS.has(tokens[index + 1] ?? ""))
}

function slackMessageToThemselves(tokens: string[]) {
  if (!tokens.some((token) => SELF_WORDS.has(token)) || tokens.some((token) => OTHER_CHANNEL_WORDS.has(token))) return false
  return tokens.some((token) => NOTIFY_WORDS.has(token)) || (tokens.includes("slack") && tokens.some((token) => SEND_WORDS.has(token)))
}

export const SLACK_SEND_AS_BOT_LIMITS = { perDay: 20, perMinute: 5 } as const
const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * 60_000

export function isSlackSendAsBotCapabilityName(name: string): boolean {
  return name === SLACK_SEND_AS_BOT_CAPABILITY
}

export function searchSlackSendAsBotCapability(query: string): CapabilityMatch[] {
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0 || asTheUser(queryTokens)) return []
  const exact = query.trim().toLowerCase() === SLACK_SEND_AS_BOT_CAPABILITY
  const toThemselves = slackMessageToThemselves(queryTokens)
  const nameTokens = [...tokenize(SLACK_SEND_AS_BOT_CAPABILITY), ...(toThemselves ? tokenize(SELF_NOTIFICATION_ALIASES) : [])]
  const score = scoreText(nameTokens, tokenize(SLACK_SEND_AS_BOT_SUMMARY), queryTokens, tokenize(SEARCH_EXTRA_TOKENS))
    + (toThemselves ? 6 + 2 + 1 : 0)
    + (exact ? queryTokens.length * (6 + 2 + 1) + 1 : 0)
  if (score <= 0) return []
  return [{
    name: SLACK_SEND_AS_BOT_CAPABILITY,
    method: "SLACK",
    path: SLACK_SEND_AS_BOT_CAPABILITY,
    score,
    summary: SLACK_SEND_AS_BOT_SUMMARY,
    pathParams: [],
    queryParams: [],
    hasBody: true,
    argumentsSchema: SLACK_SEND_AS_BOT_ARGUMENTS_SCHEMA,
    invocation: { argumentsField: "body" },
    readOnly: false,
    kind: "slack_send_as_bot",
  }]
}

const bodySchema = z.object({
  target: z.string().trim().min(1),
  channelId: z.string().trim().min(1).max(64).optional(),
  text: z.string().trim().min(1).max(TEXT_MAX),
  threadTs: z.string().trim().regex(/^\d{1,12}\.\d{1,8}$/, "threadTs is a Slack message ts, such as 1700000000.000100.").optional(),
}).strict()

const CHANNEL_ID = /^[CG][A-Z0-9]{8,}$/

export type SlackSendAsBotLimitStore = {
  peek: (key: string, max: number, windowMs: number, now: number) => Promise<number | null>
  take: (key: string, max: number, windowMs: number, now: number) => Promise<number | null>
  prune: (prefix: string, windowMs: number, now: number) => Promise<void>
}

export type SlackSendAsBotDeps = {
  resolveMember: (input: { organizationId: string; userId: string }) => Promise<WorkbotDirectMessageTarget>
  sendDirect: (member: WorkbotSlackMember, message: { text: string; threadTs?: string }) => Promise<WorkbotDirectMessageResult>
  postChannel: (member: WorkbotSlackMember, message: { channelId: string; text: string; threadTs?: string }) => Promise<WorkbotChannelPostResult>
  limits: SlackSendAsBotLimitStore
  now: () => number
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, "\\$&")
}

const rateLimitStore: SlackSendAsBotLimitStore = {
  peek: (key, max, windowMs, now) => checkFixedWindowRateLimit(key, max, windowMs, now, false),
  take: (key, max, windowMs, now) => checkFixedWindowRateLimit(key, max, windowMs, now),
  prune: async (prefix, windowMs, now) => {
    await db.delete(RateLimitTable).where(and(sql`${RateLimitTable.key} LIKE ${`${escapeLike(prefix)}%`}`, lte(RateLimitTable.lastRequest, now - windowMs)))
  },
}

export const DEFAULT_SLACK_SEND_AS_BOT_DEPS: SlackSendAsBotDeps = {
  resolveMember: (input) => resolveWorkbotDirectMessageTarget(input),
  sendDirect: (member, message) => sendWorkbotDirectMessageTo(member, message),
  postChannel: (member, message) => postWorkbotChannelMessage(member, message, defaultWorkbotChannelPostDeps),
  limits: rateLimitStore,
  now: Date.now,
}

export type SlackSendAsBotToolResult = {
  isError?: boolean
  content: { type: "text"; text: string }[]
  structuredContent: Record<string, unknown>
}

function result(payload: Record<string, unknown>, isError: boolean): SlackSendAsBotToolResult {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload }
}

function refusal(error: string, message: string, extra: Record<string, unknown> = {}): SlackSendAsBotToolResult {
  return result({ sent: false, error, message, ...extra }, true)
}

const FAILURE_MESSAGES: Record<Exclude<WorkbotChannelPostFailure, "slack_error">, string> = {
  slack_app_not_installed: "Not sent: the OpenWork app isn't set up in Slack for this organization. An organization admin can add it in the Slack connection's OpenWork in Slack section.",
  member_not_linked: "Not sent: your Slack account isn't linked to OpenWork yet. Connect Slack (or reconnect it once) in Your Connections, then try again.",
  bot_not_in_channel: "Not sent: the OpenWork app isn't in that channel. Invite it to the channel (for example, type /invite @openwork there), then try again.",
  channel_access_denied: "Not sent: you can't see that channel in Slack, so OpenWork won't post there for you.",
}

function sendFailure(failure: { reason: WorkbotChannelPostFailure; code?: string; retryAfterMs?: number }): SlackSendAsBotToolResult {
  if (failure.reason !== "slack_error") return refusal(failure.reason, FAILURE_MESSAGES[failure.reason])
  if (failure.code === "channel_access_unverified") {
    return refusal("slack_error", "Not sent: OpenWork couldn't confirm you can see that channel in Slack. Try again in a few minutes.", { code: failure.code })
  }
  const retryAfterSeconds = failure.retryAfterMs ? Math.ceil(failure.retryAfterMs / 1000) : undefined
  return refusal(
    "slack_error",
    `Not sent: Slack returned an error (${failure.code ?? "unknown_error"}).${retryAfterSeconds ? ` Try again in ${retryAfterSeconds} seconds.` : ""}`,
    { ...(failure.code ? { code: failure.code } : {}), ...(retryAfterSeconds ? { retryAfterSeconds } : {}) },
  )
}

type Destination = { target: "me"; threadTs?: string } | { target: "channel"; channelId: string; threadTs?: string }

const OTHER_TARGET_MESSAGE =
  "Not sent: slack_send_as_bot only messages you (target \"me\") or posts in a channel (target \"channel\" with channelId). It can't DM other people; to message someone as yourself, use slack_send_message."

function destinationFor(body: z.infer<typeof bodySchema>): Destination | string {
  const threadTs = body.threadTs ? { threadTs: body.threadTs } : {}
  if (body.target === "me") {
    if (body.channelId !== undefined) return "Not sent: channelId only goes with target \"channel\". Use target \"me\" alone to DM yourself."
    return { target: "me", ...threadTs }
  }
  if (body.target !== "channel") return OTHER_TARGET_MESSAGE
  if (!body.channelId) return "Not sent: target \"channel\" needs channelId, the Slack channel ID such as C0123ABCD."
  if (/^[DUW]/.test(body.channelId)) return OTHER_TARGET_MESSAGE
  if (!CHANNEL_ID.test(body.channelId)) {
    return "Not sent: channelId must be a Slack channel ID such as C0123ABCD, not a #name. Look it up with the Slack connection first."
  }
  return { target: "channel", channelId: body.channelId, ...threadTs }
}

const LIMIT_KEYS = { day: "slack-send-as-bot:day:", minute: "slack-send-as-bot:minute:", same: "slack-send-as-bot:same:" } as const

function limitKeys(input: { organizationId: string; userId: string; destination: Destination; text: string }) {
  const member = `${input.organizationId}:${input.userId}`
  const place = input.destination.target === "me" ? "me" : `channel:${input.destination.channelId}`
  const sameMessagePrefix = `${LIMIT_KEYS.same}${member}:`
  return {
    day: `${LIMIT_KEYS.day}${member}`,
    minute: `${LIMIT_KEYS.minute}${member}`,
    sameMessagePrefix,
    sameMessage: `${sameMessagePrefix}${createHash("sha256").update(JSON.stringify([place, input.destination.threadTs ?? "", input.text])).digest("hex")}`,
  }
}

export type SlackSendAsBotWindow = {
  organizationId: string
  userId: string
  start: number
  admitted: number
  delivered: number
  lastDeliveredAt: number | null
}

function keyMember(key: string, prefix: string, parts: number): { organizationId: string; userId: string } | null {
  if (!key.startsWith(prefix)) return null
  const [organizationId, userId, ...rest] = key.slice(prefix.length).split(":")
  return organizationId && userId && rest.length === parts - 2 ? { organizationId, userId } : null
}

export async function readSlackSendAsBotWindows(since: number): Promise<SlackSendAsBotWindow[]> {
  const prefixed = (prefix: string) => and(sql`${RateLimitTable.key} LIKE ${`${escapeLike(prefix)}%`}`, gte(RateLimitTable.lastRequest, since))
  const days = await db.select({ key: RateLimitTable.key, count: RateLimitTable.count, lastRequest: RateLimitTable.lastRequest })
    .from(RateLimitTable).where(prefixed(LIMIT_KEYS.day))
  const sent = await db.select({ key: RateLimitTable.key, lastRequest: RateLimitTable.lastRequest })
    .from(RateLimitTable).where(prefixed(LIMIT_KEYS.same))
  const deliveries = new Map<string, number[]>()
  for (const row of sent) {
    const member = keyMember(row.key, LIMIT_KEYS.same, 3)
    if (!member) continue
    const id = `${member.organizationId}:${member.userId}`
    deliveries.set(id, [...deliveries.get(id) ?? [], row.lastRequest])
  }
  return days.flatMap((row) => {
    const member = keyMember(row.key, LIMIT_KEYS.day, 2)
    if (!member) return []
    const inWindow = (deliveries.get(`${member.organizationId}:${member.userId}`) ?? []).filter((at) => at >= row.lastRequest && at < row.lastRequest + DAY_MS)
    return [{
      ...member,
      start: row.lastRequest,
      admitted: row.count,
      delivered: inWindow.length,
      lastDeliveredAt: inWindow.length ? Math.max(...inWindow) : null,
    }]
  })
}

export type SlackSendAsBotInput = {
  organizationId: DenTypeId<"organization">
  userId: string
  memberId: DenTypeId<"member"> | null
  hasWriteScope: boolean
  body: unknown
}

function normalizeToolBody(body: unknown): unknown {
  if (typeof body !== "string") return body
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

export async function executeSlackSendAsBot(
  input: SlackSendAsBotInput,
  deps: SlackSendAsBotDeps = DEFAULT_SLACK_SEND_AS_BOT_DEPS,
): Promise<SlackSendAsBotToolResult> {
  if (!input.memberId) return refusal("membership_required", "Not sent: Slack messages from the OpenWork app need an active organization membership.")
  if (!input.hasWriteScope) {
    return refusal("insufficient_mcp_scope", `Not sent: this run can only read, and ${SLACK_SEND_AS_BOT_CAPABILITY} requires the mcp:write scope.`, { requiredScope: "mcp:write" })
  }
  const parsed = bodySchema.safeParse(normalizeToolBody(input.body) ?? {})
  if (!parsed.success) {
    return refusal("invalid_capability_arguments", `Not sent: invalid arguments for ${SLACK_SEND_AS_BOT_CAPABILITY}.`, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    })
  }
  const destination = destinationFor(parsed.data)
  if (typeof destination === "string") return refusal("invalid_target", destination)

  const member = await deps.resolveMember({ organizationId: input.organizationId, userId: input.userId })
  if (!member.ok) return sendFailure(member)

  const { perDay, perMinute } = SLACK_SEND_AS_BOT_LIMITS
  const keys = limitKeys({ organizationId: input.organizationId, userId: input.userId, destination, text: parsed.data.text })
  const now = deps.now()
  if (await deps.limits.peek(keys.sameMessage, 1, DAY_MS, now) !== null) {
    return refusal("duplicate_message", "Not sent: the same message already went there in the last 24 hours.")
  }
  const burstWait = await deps.limits.peek(keys.minute, perMinute, MINUTE_MS, now)
  if (burstWait !== null) return burstRefusal(perMinute, burstWait)
  const dayWait = await deps.limits.take(keys.day, perDay, DAY_MS, now)
  if (dayWait !== null) return refusal("daily_limit_reached", `Not sent: daily limit reached (${perDay}/${perDay}).`, { retryAfterSeconds: dayWait })
  const minuteWait = await deps.limits.take(keys.minute, perMinute, MINUTE_MS, now)
  if (minuteWait !== null) return burstRefusal(perMinute, minuteWait)

  const sent = destination.target === "me"
    ? await deps.sendDirect(member, { text: parsed.data.text, ...(destination.threadTs ? { threadTs: destination.threadTs } : {}) })
    : await deps.postChannel(member, { channelId: destination.channelId, text: parsed.data.text, ...(destination.threadTs ? { threadTs: destination.threadTs } : {}) })
  if (!sent.ok) return sendFailure(sent)

  await deps.limits.take(keys.sameMessage, 1, DAY_MS, now)
  await deps.limits.prune(keys.sameMessagePrefix, DAY_MS, now).catch(() => undefined)
  return result({
    sent: true,
    target: destination.target,
    channelId: sent.channelId,
    messageTs: sent.messageTs,
    ...("permalink" in sent && sent.permalink ? { permalink: sent.permalink } : {}),
    message: destination.target === "me"
      ? "Sent to you as a DM from the OpenWork app."
      : "Posted in the channel from the OpenWork app, credited to your agent.",
  }, false)
}

function burstRefusal(perMinute: number, waitSeconds: number) {
  return refusal("rate_limited", `Not sent: too many messages in a minute (${perMinute}/${perMinute}). Try again in ${waitSeconds} seconds.`, { retryAfterSeconds: waitSeconds })
}
