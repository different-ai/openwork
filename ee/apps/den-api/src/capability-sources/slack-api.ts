import { z } from "zod"
import { env } from "../env.js"

const conversationTypeSchema = z.enum(["public_channel", "private_channel", "im", "mpim"])
type ConversationType = z.infer<typeof conversationTypeSchema>
const conversationTypes = conversationTypeSchema.options
const searchScopes: Record<ConversationType, string> = {
  public_channel: "search:read.public", private_channel: "search:read.private", im: "search:read.im", mpim: "search:read.mpim",
}
const cursorSchema = z.string().min(1).max(2_048)
const channelIdSchema = z.string().regex(/^[CGD][A-Z0-9]{2,63}$/)
const timestampSchema = z.string().regex(/^\d{1,16}\.\d{1,16}$/)

export const slackSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(1_000).describe("Live Slack message search. Slack query filters are supported; file search is not."),
  conversationTypes: z.string().min(1).max(96).transform((value) => value.split(",").map((type) => type.trim())).pipe(z.array(conversationTypeSchema).min(1).max(4)).optional().describe("Comma-separated public_channel,private_channel,im,mpim. Omit to search granted categories. Explicit ungranted categories return missing_permission, never empty results."),
  cursor: cursorSchema.optional().describe("nextCursor from the same search. Reads one page only."),
  limit: z.coerce.number().int().min(1).max(20).default(10),
}).strict()

export const slackThreadInputSchema = z.object({
  channelId: channelIdSchema.describe("Slack conversation ID from a search result."),
  ts: timestampSchema.describe("Timestamp of a parent message or reply returned by Slack."),
  cursor: cursorSchema.optional().describe("nextCursor from the same thread lookup. Reads one page only."),
  limit: z.coerce.number().int().min(1).max(20).default(10),
}).strict()

const messageSchema = z.object({
  channelId: channelIdSchema,
  ts: timestampSchema,
  threadTs: timestampSchema.nullable(),
  userId: z.string().nullable(),
  text: z.string(),
  permalink: z.string(),
  truncated: z.boolean(),
})
const pageSchema = z.object({
  ok: z.literal(true),
  messages: z.array(messageSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean().describe("Whether Slack advertised another page. False does not establish complete context."),
  partial: z.literal(true).describe("A bounded live excerpt, never a complete conversation or archive."),
  truncated: z.boolean().describe("Message count or text was trimmed by OpenWork's bounds."),
  warnings: z.array(z.string()),
})
export const slackSearchResultSchema = pageSchema.extend({
  context: z.literal("search_results"),
  searchedConversationTypes: z.array(conversationTypeSchema),
  omittedConversationTypes: z.array(conversationTypeSchema).describe("Categories not searched because the connected member has not granted their search scopes."),
})
export const slackThreadResultSchema = pageSchema.extend({
  context: z.literal("thread_excerpt"),
  channelId: channelIdSchema,
  ts: timestampSchema,
  historyLimited: z.boolean().describe("Slack reported a history/plan limit. Absent accessible older messages cannot be recovered by paging."),
})
export const slackErrorSchema = z.object({
  error: z.enum(["needs_connection", "missing_permission", "policy_blocked", "rate_limited", "slack_api_error", "invalid_request", "not_found"]),
  message: z.string(),
  missingScopes: z.array(z.string()).optional(),
  retryAfterSeconds: z.number().int().min(1).max(3_600).optional(),
})

type SlackErrorBody = z.infer<typeof slackErrorSchema>
export class SlackCapabilityError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 429 | 502 | 504, readonly body: SlackErrorBody) {
    super(body.message)
  }
}

export function slackConnectionRequired(): SlackCapabilityError {
  return new SlackCapabilityError(409, { error: "needs_connection", message: "Connect or reconnect your Slack account in Your Connections, then retry." })
}

const envelopeSchema = z.object({ ok: z.boolean(), error: z.string().optional(), needed: z.string().optional() })
const metadataSchema = z.object({ next_cursor: z.string().max(2_048).optional() }).optional()
// Method contracts: https://docs.slack.dev/reference/methods/assistant.search.context/
const searchResponseSchema = z.object({
  results: z.object({ messages: z.array(z.object({
    channel_id: channelIdSchema, message_ts: timestampSchema, content: z.string(),
    author_user_id: z.string().max(64).optional(), permalink: z.string().max(2_048).optional(),
  })) }),
  response_metadata: metadataSchema,
})
// https://docs.slack.dev/reference/methods/conversations.replies/ accepts parent or reply ts.
const threadResponseSchema = z.object({
  messages: z.array(z.object({
    ts: timestampSchema, thread_ts: timestampSchema.optional(), text: z.string().default(""),
    user: z.string().max(64).optional(), reply_count: z.number().int().nonnegative().optional(),
  })),
  has_more: z.boolean().optional(), is_limited: z.boolean().optional(), response_metadata: metadataSchema,
})
const permalinkSchema = z.object({ permalink: z.string().max(2_048) })

type SlackSession = { accessToken: string; scopes: readonly string[] | null }
type ReadBudget = { signal: AbortSignal; remainingBytes: number }
const MAX_RESPONSE_BYTES = 512 * 1_024
const MAX_TEXT_CHARACTERS = 40_000
const MAX_MESSAGE_CHARACTERS = 4_000

function missingPermission(scopes: string[]) {
  return new SlackCapabilityError(409, {
    error: "missing_permission", missingScopes: scopes,
    message: "Your connected Slack account does not grant the requested conversation permissions. Grant those permissions in Slack and reconnect, or request only authorized conversation categories.",
  })
}

function invalidProviderResponse(): SlackCapabilityError {
  return new SlackCapabilityError(502, { error: "slack_api_error", message: "Slack returned an invalid or oversized response. Narrow the lookup and try again." })
}

function providerError(code: string | undefined, response: Response): SlackCapabilityError {
  if (response.status === 429 || code === "ratelimited" || code === "rate_limited") {
    const delay = Number(response.headers.get("retry-after"))
    return new SlackCapabilityError(429, {
      error: "rate_limited", message: "Slack rate-limited this lookup. No retry was attempted. Wait before making another request.",
      retryAfterSeconds: Number.isFinite(delay) && delay > 0 ? Math.min(3_600, Math.max(1, Math.ceil(delay))) : 60,
    })
  }
  if (response.status === 401 || ["invalid_auth", "token_revoked", "token_expired", "not_authed", "account_inactive", "not_allowed_token_type"].includes(code ?? "")) return slackConnectionRequired()
  if (response.status === 403 || ["missing_scope", "no_permission", "access_denied", "team_access_not_granted"].includes(code ?? "")) return missingPermission([])
  if (["channel_not_found", "thread_not_found", "message_not_found", "context_channel_not_found"].includes(code ?? "")) {
    return new SlackCapabilityError(404, { error: "not_found", message: "The Slack conversation or message is unavailable to your connected account, or no longer exists." })
  }
  if (code === "invalid_cursor") return new SlackCapabilityError(400, { error: "invalid_request", message: "Slack rejected the cursor. Start the lookup again without a cursor." })
  return new SlackCapabilityError(502, { error: "slack_api_error", message: "Slack could not complete this lookup. Search eligibility, workspace restrictions, or temporary availability may prevent this operation; no fallback was attempted." })
}

async function readBoundedJson(response: Response, budget: ReadBudget): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw invalidProviderResponse()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      budget.signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      budget.remainingBytes -= chunk.value.byteLength
      if (budget.remainingBytes < 0) {
        await reader.cancel()
        throw invalidProviderResponse()
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  const buffer = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder().decode(buffer)) } catch { throw invalidProviderResponse() }
}

// Private closed method set; caller input never controls a method, origin, token, or redirect.
async function callSlack(session: SlackSession, budget: ReadBudget, method: "assistant.search.context" | "conversations.replies" | "chat.getPermalink", params: Record<string, string | number | boolean | string[]>): Promise<unknown> {
  budget.signal.throwIfAborted()
  const url = new URL(`${env.slackApiBaseUrl.replace(/\/+$/, "")}/${method}`)
  const headers = { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json; charset=utf-8" }
  const init: RequestInit = { headers, redirect: "error", signal: budget.signal }
  if (method === "assistant.search.context") {
    init.method = "POST"
    init.body = JSON.stringify(params)
  } else {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  }
  const response = await fetch(url, init)
  if (!response.ok) {
    await response.body?.cancel()
    throw providerError(undefined, response)
  }
  const data = await readBoundedJson(response, budget)
  const envelope = envelopeSchema.safeParse(data)
  if (!envelope.success) throw invalidProviderResponse()
  if (!envelope.data.ok) {
    if (envelope.data.error === "missing_scope") {
      const knownScopes = new Set([...Object.values(searchScopes), "channels:history", "groups:history", "im:history", "mpim:history"])
      throw missingPermission([...(new Set((envelope.data.needed ?? "").split(/[\s,]+/).filter((scope) => knownScopes.has(scope))))])
    }
    throw providerError(envelope.data.error, response)
  }
  return data
}

function validPermalink(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === "https:" && (url.hostname === "slack.com" || url.hostname.endsWith(".slack.com")) && !url.username && !url.password && !url.port && url.pathname.startsWith("/archives/") ? value : null
  } catch { return null }
}

async function sourceLink(session: SlackSession, budget: ReadBudget, channelId: string, ts: string, supplied?: string): Promise<string> {
  const existing = validPermalink(supplied)
  if (existing) return existing
  const data = permalinkSchema.safeParse(await callSlack(session, budget, "chat.getPermalink", { channel: channelId, message_ts: ts }))
  const permalink = data.success ? validPermalink(data.data.permalink) : null
  if (!permalink) throw invalidProviderResponse()
  return permalink
}

async function boundedLookup<T>(lookup: (budget: ReadBudget) => Promise<T>): Promise<T> {
  const budget = { signal: AbortSignal.timeout(12_000), remainingBytes: MAX_RESPONSE_BYTES }
  try { return await lookup(budget) } catch (error) {
    if (error instanceof SlackCapabilityError) throw error
    if (budget.signal.aborted) throw new SlackCapabilityError(504, { error: "slack_api_error", message: "Slack lookup timed out. No automatic retry was attempted." })
    throw new SlackCapabilityError(502, { error: "slack_api_error", message: "Slack could not be reached. No automatic retry was attempted." })
  }
}

export async function readSlackThread(session: SlackSession, input: z.infer<typeof slackThreadInputSchema>): Promise<z.infer<typeof slackThreadResultSchema>> {
  // Slack conversation IDs do not reliably distinguish private channels from MPIMs.
  // Do not request metadata scopes to guess: the user-token replies endpoint enforces
  // the exact conversation's history scope and membership, including partial consent.
  const historyScopes = ["channels:history", "groups:history", "im:history", "mpim:history"]
  if (!historyScopes.some((scope) => session.scopes?.includes(scope))) throw missingPermission(historyScopes)
  return boundedLookup(async (budget) => {
    const parsed = threadResponseSchema.safeParse(await callSlack(session, budget, "conversations.replies", {
      channel: input.channelId, ts: input.ts, limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}),
    }))
    if (!parsed.success) throw invalidProviderResponse()
    const messages: z.infer<typeof messageSchema>[] = []
    let textBudget = MAX_TEXT_CHARACTERS
    let truncated = parsed.data.messages.length > input.limit
    for (const message of parsed.data.messages.slice(0, input.limit)) {
      const text = message.text.slice(0, Math.min(textBudget, MAX_MESSAGE_CHARACTERS))
      textBudget -= text.length
      const trimmed = text.length < message.text.length
      truncated ||= trimmed
      messages.push({ channelId: input.channelId, ts: message.ts, threadTs: message.thread_ts ?? null, userId: message.user ?? null, text, truncated: trimmed, permalink: await sourceLink(session, budget, input.channelId, message.ts) })
    }
    const nextCursor = parsed.data.response_metadata?.next_cursor || null
    const hasMore = Boolean(nextCursor || parsed.data.has_more)
    return {
      ok: true, context: "thread_excerpt", channelId: input.channelId, ts: input.ts, messages,
      nextCursor, hasMore, partial: true, truncated, historyLimited: parsed.data.is_limited ?? false,
      warnings: ["A bounded Slack thread excerpt, not a guarantee of complete conversation history.", ...(hasMore ? ["Slack has more thread context; request another page when a cursor is available."] : []), ...(input.cursor ? ["This is a continuation page; earlier messages may be omitted."] : []), ...(parsed.data.is_limited ? ["Slack restricted the available history."] : []), ...(truncated ? ["Message text or result count was truncated."] : [])],
    }
  })
}

export async function searchSlack(session: SlackSession, input: z.infer<typeof slackSearchInputSchema>): Promise<z.infer<typeof slackSearchResultSchema>> {
  const granted = new Set(session.scopes ?? [])
  const omittedConversationTypes = conversationTypes.filter((type) => !granted.has(searchScopes[type]))
  const searchedConversationTypes = [...new Set(input.conversationTypes ?? conversationTypes.filter((type) => granted.has(searchScopes[type])))]
  const missingScopes = [...new Set(["search:read.public", ...searchedConversationTypes.map((type) => searchScopes[type])])].filter((scope) => !granted.has(scope))
  if (missingScopes.length) throw missingPermission(missingScopes)
  return boundedLookup(async (budget) => {
    const parsed = searchResponseSchema.safeParse(await callSlack(session, budget, "assistant.search.context", {
      query: input.query, channel_types: searchedConversationTypes, content_types: ["messages"],
      include_context_messages: false, include_message_blocks: false, limit: input.limit,
      ...(input.cursor ? { cursor: input.cursor } : {}),
    }))
    if (!parsed.success) throw invalidProviderResponse()
    const messages: z.infer<typeof messageSchema>[] = []
    let textBudget = MAX_TEXT_CHARACTERS
    let truncated = parsed.data.results.messages.length > input.limit
    for (const message of parsed.data.results.messages.slice(0, input.limit)) {
      const text = message.content.slice(0, Math.min(textBudget, MAX_MESSAGE_CHARACTERS))
      textBudget -= text.length
      const trimmed = text.length < message.content.length
      truncated ||= trimmed
      messages.push({ channelId: message.channel_id, ts: message.message_ts, threadTs: null, userId: message.author_user_id ?? null, text, truncated: trimmed, permalink: await sourceLink(session, budget, message.channel_id, message.message_ts, message.permalink) })
    }
    const nextCursor = parsed.data.response_metadata?.next_cursor || null
    return {
      ok: true, context: "search_results", messages, partial: true, truncated,
      nextCursor, hasMore: Boolean(nextCursor), searchedConversationTypes, omittedConversationTypes,
      warnings: ["Search matches are excerpts, not complete Slack threads or an exhaustive history.", ...(omittedConversationTypes.length ? ["Some conversation categories were not searched because their permissions were not granted."] : []), ...(truncated ? ["Message text or result count was truncated."] : [])],
    }
  })
}
