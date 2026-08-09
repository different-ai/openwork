const SENSITIVE_RESPONSE_KEY = /token|secret|password|assertion|code|key|authorization/i
const SENSITIVE_JSON_VALUE = /("(?:[^"\\]|\\.)*(?:token|secret|password|assertion|code|key|authorization)(?:[^"\\]|\\.)*"\s*:\s*)("(?:[^"\\]|\\.)*(?:"|$)|[^,}\]]*)/gi
const SENSITIVE_TEXT_PAIR = /((?:token|secret|password|assertion|code|key|authorization)[\w-]*\s*[=:]\s*)[^\s&"',;)]+/gi
const SENSITIVE_QUOTED_TEXT_PAIR = /(["'][\w-]*(?:token|secret|password|assertion|code|key|authorization)[\w-]*["']\s*:\s*["'])[^"']*(["'])/gi
const JWT_CREDENTIAL = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g
const SLACK_CREDENTIAL = /\bxox[a-z]-[A-Za-z0-9-]+|\bxoxe(?:-\d)?-[A-Za-z0-9-]+/gi
const BEARER_CREDENTIAL = /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi
const GITHUB_CREDENTIAL = /\bgh[pousr]_[A-Za-z0-9]{20,}/gi
const LONG_OPAQUE_CREDENTIAL = /[A-Za-z0-9_~+/=-]{40,}/g

export const ENTERPRISE_MCP_RESPONSE_BODY_EXCERPT_CHARS = 2_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function redactedSensitiveResponseString(value: string): string {
  return value
    .replace(SENSITIVE_QUOTED_TEXT_PAIR, "$1[redacted]$2")
    .replace(SENSITIVE_TEXT_PAIR, "$1[redacted]")
    .replace(JWT_CREDENTIAL, "[redacted]")
    .replace(SLACK_CREDENTIAL, "[redacted]")
    .replace(BEARER_CREDENTIAL, "$1[redacted]")
    .replace(GITHUB_CREDENTIAL, "[redacted]")
    .replace(LONG_OPAQUE_CREDENTIAL, "[redacted]")
}

function redactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJsonValue)
  if (typeof value === "string") return redactedSensitiveResponseString(value)
  if (!isRecord(value)) return value

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    SENSITIVE_RESPONSE_KEY.test(key) ? "[redacted]" : redactJsonValue(entry),
  ]))
}

export function redactedResponseBodyExcerpt(text: string, limit = ENTERPRISE_MCP_RESPONSE_BODY_EXCERPT_CHARS): string {
  let redacted = redactedSensitiveResponseString(text.replace(SENSITIVE_JSON_VALUE, '$1"[redacted]"'))
  try {
    const parsed: unknown = JSON.parse(text)
    const serialized = JSON.stringify(redactJsonValue(parsed))
    if (serialized !== undefined) redacted = serialized
  } catch {
    // A bounded excerpt may end mid-JSON. The conservative regex above still
    // removes values whose sensitive key is visible in the excerpt.
  }
  return redacted.slice(0, limit)
}

async function responseTextExcerpt(response: Response, limit: number): Promise<string | null> {
  if (!response.body) return null
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  try {
    while (text.length < limit) {
      const next = await reader.read()
      if (next.done) {
        text += decoder.decode()
        return text.slice(0, limit)
      }
      text += decoder.decode(next.value, { stream: true })
      if (text.length >= limit) {
        void reader.cancel().catch(() => undefined)
        return text.slice(0, limit)
      }
    }
    return text.slice(0, limit)
  } catch {
    return null
  }
}

export async function boundedRedactedResponseBodyExcerpt(
  response: Response,
  limit = ENTERPRISE_MCP_RESPONSE_BODY_EXCERPT_CHARS,
): Promise<string | undefined> {
  try {
    const text = await responseTextExcerpt(response.clone(), limit)
    return text === null ? undefined : redactedResponseBodyExcerpt(text, limit)
  } catch {
    return undefined
  }
}
