import { z } from "zod"

/**
 * Den's resume-token exchange: a turn's resume grant for a fresh member-scoped MCP token for that turn (or one of its
 * tasks and reports). `POST {HEADLESS_DEN_API_URL}/v1/headless/resume-token`, authenticated with the runner's
 * callback token. Neither the grant nor the token is ever logged or reported.
 */
export type ResumeExchangeInput = { grant: string; sessionId: string; messageId: string }
export type ResumeExchangeResult =
  | { ok: true; mcpToken: string; expiresAt: string; readOnly: boolean }
  /** This grant will never work again (revoked, expired, member left, feature off): stop trying it. */
  | { ok: false; kind: "permanent"; code: string; status: number }
  /** Den is busy or unreachable: try again later, not before `retryAfterMs` when Den says so. */
  | { ok: false; kind: "retryable"; code: string; status?: number; retryAfterMs?: number }
  /** The runner's settings are wrong (callback token refused, endpoint not set up on Den): nothing will work. */
  | { ok: false; kind: "config"; code: string; status: number }
export type ResumeExchange = (input: ResumeExchangeInput) => Promise<ResumeExchangeResult>

export const RESUME_EXCHANGE_PATH = "/v1/headless/resume-token"
const DEFAULT_TIMEOUT_MS = 10_000
const PERMANENT_CODES = new Set(["grant_invalid", "grant_expired", "grant_revoked", "grant_mismatch", "membership_inactive", "feature_disabled"])

const issued = z.object({ mcpToken: z.string().min(1), expiresAt: z.string().min(1), readOnly: z.boolean() })
const refused = z.object({ error: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/), retryAfterMs: z.number().nonnegative().optional() })

export function denResumeClient(input: { url: string; token: string; fetch?: typeof fetch; timeoutMs?: number }): ResumeExchange {
  // A native Workers fetch needs its global receiver.
  const send = input.fetch ?? ((request, init) => fetch(request, init))
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return async ({ grant, sessionId, messageId }) => {
    let response: Response
    try {
      response = await send(`${input.url}${RESUME_EXCHANGE_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
        body: JSON.stringify({ grant, sessionId, messageId }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      return { ok: false, kind: "retryable", code: "den_unreachable" }
    }
    const body: unknown = await response.json().catch(() => null)
    const { status } = response
    if (status === 200) {
      const parsed = issued.safeParse(body)
      return parsed.success ? { ok: true, ...parsed.data } : { ok: false, kind: "retryable", code: "invalid_response", status }
    }
    const error = refused.safeParse(body)
    const code = error.success ? error.data.error : `den_http_${status}`
    if (status === 401) return { ok: false, kind: "config", code: "unauthorized", status }
    if (status === 404) return { ok: false, kind: "config", code: "not_configured", status }
    if (status === 429) {
      const header = Number(response.headers.get("retry-after"))
      const retryAfterMs = error.success && error.data.retryAfterMs !== undefined ? error.data.retryAfterMs : Number.isFinite(header) && header > 0 ? header * 1000 : undefined
      return { ok: false, kind: "retryable", code: "rate_limited", status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }
    }
    if (status >= 500) return { ok: false, kind: "retryable", code: `den_http_${status}`, status }
    // 403 with one of Den's grant codes, or anything else that a retry won't change (a 400 for this grant).
    return { ok: false, kind: "permanent", code: status === 403 && PERMANENT_CODES.has(code) ? code : status === 403 ? "forbidden" : code, status }
  }
}
