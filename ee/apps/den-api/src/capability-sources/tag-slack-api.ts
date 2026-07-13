const DEFAULT_SLACK_TIMEOUT_MS = 15_000
export const SLACK_MESSAGE_LIMIT = 40_000
export const TAG_RESPONSE_LIMIT = 30_000

type SlackEnvelope = {
  ok: boolean
  error?: string
  needed?: string
  provided?: string
}

export class SlackApiError extends Error {
  readonly retryAfterMs: number | null
  readonly status: number

  constructor(status: number, message: string, retryAfterMs: number | null = null) {
    super(message)
    this.name = "SlackApiError"
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

export function isRetryableSlackApiError(error: unknown): boolean {
  return error instanceof SlackApiError
    && (error.status === 408 || error.status === 429 || error.status >= 500)
}

function apiRoot(explicit?: string): string {
  return (explicit?.trim() || process.env.DEN_SLACK_API_ROOT?.trim() || "https://slack.com/api").replace(/\/+$/, "")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function slackApiCall<T extends SlackEnvelope>(input: {
  apiRoot?: string
  botToken: string
  body?: Record<string, unknown>
  fetchImpl?: typeof fetch
  method: string
  timeoutMs?: number
}): Promise<T> {
  const fetchImpl = input.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(`${apiRoot(input.apiRoot)}/${input.method}`, {
      body: JSON.stringify(input.body ?? {}),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      method: "POST",
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_SLACK_TIMEOUT_MS),
    })
  } catch (error) {
    throw new SlackApiError(502, error instanceof Error ? error.message : String(error))
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  const retryAfter = response.headers.get("retry-after")
  const retryAfterMs = retryAfter && Number.isFinite(Number(retryAfter))
    ? Math.max(0, Number(retryAfter) * 1_000)
    : null
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    const errorCode = isRecord(payload) && typeof payload.error === "string"
      ? payload.error
      : `http_${response.status}`
    const scopeHint = isRecord(payload) && typeof payload.needed === "string"
      ? ` Required Slack scope: ${payload.needed}.`
      : ""
    throw new SlackApiError(response.status || 502, `Slack API ${input.method} failed: ${errorCode}.${scopeHint}`, retryAfterMs)
  }
  return payload as T
}

export type SlackBotIdentity = {
  botUserId: string
  teamId: string
  teamName: string
  userName: string
}

export async function validateSlackBot(input: {
  apiRoot?: string
  botToken: string
  fetchImpl?: typeof fetch
}): Promise<SlackBotIdentity> {
  const payload = await slackApiCall<SlackEnvelope & {
    team?: string
    team_id?: string
    user?: string
    user_id?: string
  }>({ ...input, method: "auth.test" })
  if (!payload.team_id?.trim() || !payload.user_id?.trim()) {
    throw new SlackApiError(502, "Slack auth.test did not return a team and bot user id.")
  }
  return {
    botUserId: payload.user_id,
    teamId: payload.team_id,
    teamName: payload.team?.trim() || payload.team_id,
    userName: payload.user?.trim() || "OpenWork",
  }
}

export type SlackChannel = {
  id: string
  isShared: boolean
  name: string | null
}

export async function getSlackChannel(input: {
  apiRoot?: string
  botToken: string
  channelId: string
  fetchImpl?: typeof fetch
}): Promise<SlackChannel> {
  const payload = await slackApiCall<SlackEnvelope & { channel?: unknown }>({
    ...input,
    body: { channel: input.channelId },
    method: "conversations.info",
  })
  if (!isRecord(payload.channel) || typeof payload.channel.id !== "string") {
    throw new SlackApiError(502, "Slack conversations.info returned an invalid channel.")
  }
  return {
    id: payload.channel.id,
    isShared: payload.channel.is_ext_shared === true || payload.channel.is_org_shared === true,
    name: typeof payload.channel.name === "string" ? payload.channel.name : null,
  }
}

export type SlackUser = {
  deleted: boolean
  guest: boolean
  id: string
  name: string
}

export async function getSlackUser(input: {
  apiRoot?: string
  botToken: string
  fetchImpl?: typeof fetch
  userId: string
}): Promise<SlackUser> {
  const payload = await slackApiCall<SlackEnvelope & { user?: unknown }>({
    ...input,
    body: { user: input.userId },
    method: "users.info",
  })
  if (!isRecord(payload.user) || typeof payload.user.id !== "string") {
    throw new SlackApiError(502, "Slack users.info returned an invalid user.")
  }
  const profile = isRecord(payload.user.profile) ? payload.user.profile : null
  return {
    deleted: payload.user.deleted === true,
    guest: payload.user.is_restricted === true || payload.user.is_ultra_restricted === true,
    id: payload.user.id,
    name: profile && typeof profile.display_name === "string" && profile.display_name.trim()
      ? profile.display_name.trim()
      : typeof payload.user.real_name === "string" && payload.user.real_name.trim()
        ? payload.user.real_name.trim()
        : typeof payload.user.name === "string" ? payload.user.name : payload.user.id,
  }
}

export async function postSlackMessage(input: {
  apiRoot?: string
  botToken: string
  channelId: string
  fetchImpl?: typeof fetch
  text: string
  threadTs: string
}): Promise<{ ts: string }> {
  const payload = await slackApiCall<SlackEnvelope & { ts?: string }>({
    ...input,
    body: {
      channel: input.channelId,
      text: truncateSlackText(input.text),
      thread_ts: input.threadTs,
      unfurl_links: false,
      unfurl_media: false,
    },
    method: "chat.postMessage",
  })
  if (!payload.ts) throw new SlackApiError(502, "Slack chat.postMessage did not return a message timestamp.")
  return { ts: payload.ts }
}

export async function updateSlackMessage(input: {
  apiRoot?: string
  botToken: string
  channelId: string
  fetchImpl?: typeof fetch
  text: string
  ts: string
}): Promise<void> {
  await slackApiCall({
    ...input,
    body: { channel: input.channelId, text: truncateSlackText(input.text), ts: input.ts },
    method: "chat.update",
  })
}

export async function revokeSlackToken(input: {
  apiRoot?: string
  botToken: string
  fetchImpl?: typeof fetch
}): Promise<void> {
  await slackApiCall({
    ...input,
    method: "auth.revoke",
  })
}

export function truncateSlackText(text: string, limit = TAG_RESPONSE_LIMIT): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  const suffix = "\n\n_Response truncated. Open the linked OpenWork session for the complete result._"
  if (limit <= suffix.length) return suffix.slice(0, limit)
  return `${trimmed.slice(0, Math.max(0, limit - suffix.length))}${suffix}`
}
