/**
 * Den (OpenWork Cloud API) calls the plugin makes. Every call uses the member's
 * Den session token as a bearer, plus the org headers the desktop sends
 * (apps/app/src/app/lib/den.ts requestJsonRaw), so Den resolves the same
 * organization the member approved at sign-in.
 */

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export interface DenSession {
  readonly apiBaseUrl: string
  readonly token: string
  readonly orgId: string | null
}

export class DenAuthError extends Error {
  readonly status: number
  constructor(status: number, path: string) {
    super(`OpenWork rejected the sign-in (${status} on ${path}). Sign in again: opencode auth login openwork`)
    this.name = "DenAuthError"
    this.status = status
  }
}

export class DenRequestError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, path: string, body: unknown) {
    super(`OpenWork request failed (${status} on ${path})`)
    this.name = "DenRequestError"
    this.status = status
    this.body = body
  }
}

const REQUEST_TIMEOUT_MS = 10_000

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function normalizeBaseUrl(value: string): string {
  let end = value.length
  while (end > 0 && /\s/.test(value[end - 1] ?? "")) end--
  while (end > 0 && value[end - 1] === "/") end--
  return value.slice(0, end).trim()
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

/**
 * Where the member's tokens may be sent: HTTPS, or plain HTTP only to a Den on
 * this machine (local development and self-hosted testing). Anything else
 * would let the network read the session.
 */
export function isAllowedApiBaseUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.username || url.password) return false
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
}

export class DenUrlError extends Error {
  constructor(value: string) {
    super(`Refusing to send the OpenWork sign-in to ${value}: use an https:// address.`)
    this.name = "DenUrlError"
  }
}

function assertAllowedApiBaseUrl(value: string): void {
  if (!isAllowedApiBaseUrl(value)) throw new DenUrlError(value)
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Unauthenticated JSON request (device authorization endpoints). */
export async function postPublic(fetcher: Fetch, apiBaseUrl: string, path: string, body: unknown) {
  // The device token arrives in this response, so the same transport rule applies.
  assertAllowedApiBaseUrl(apiBaseUrl)
  const response = await fetcher(`${normalizeBaseUrl(apiBaseUrl)}${path}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return { status: response.status, body: await readJson(response), retryAfter: response.headers.get("retry-after") }
}

/** Authenticated JSON request. 401/403 become DenAuthError; other non-2xx become DenRequestError. */
export async function denRequest(
  fetcher: Fetch,
  session: DenSession,
  path: string,
  init: { method?: "GET" | "POST" | "PUT"; body?: unknown; signal?: AbortSignal } = {},
): Promise<unknown> {
  assertAllowedApiBaseUrl(session.apiBaseUrl)
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${session.token}`,
  }
  if (session.orgId) {
    headers["x-openwork-org-id"] = session.orgId
    headers["x-openwork-legacy-org-id"] = session.orgId
  }
  if (init.body !== undefined) headers["content-type"] = "application/json"
  const response = await fetcher(`${normalizeBaseUrl(session.apiBaseUrl)}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: "error",
    signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const body = await readJson(response)
  if (response.status === 401) throw new DenAuthError(response.status, path)
  if (!response.ok) throw new DenRequestError(response.status, path, body)
  return body
}

export interface DenAccount {
  readonly userId: string
  readonly email: string
  readonly sessionExpiresAt: number | null
  readonly orgId: string | null
  readonly orgName: string | null
  readonly orgSlug: string | null
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function readTime(value: unknown): number | null {
  const text = readString(value)
  if (!text) return null
  const time = Date.parse(text)
  return Number.isFinite(time) ? time : null
}

/** GET /v1/me: the user and the session (whose expiry Den slides forward on use). */
export async function readMe(fetcher: Fetch, session: DenSession) {
  const body = await denRequest(fetcher, session, "/v1/me")
  if (!isRecord(body) || !isRecord(body.user)) throw new DenRequestError(200, "/v1/me", body)
  const session_ = isRecord(body.session) ? body.session : {}
  return {
    userId: readString(body.user.id) ?? "",
    email: readString(body.user.email) ?? "",
    sessionExpiresAt: readTime(session_.expiresAt),
    activeOrganizationId: readString(session_.activeOrganizationId),
  }
}

/** The member's account, with the organization the session is scoped to. */
export async function readAccount(fetcher: Fetch, session: DenSession): Promise<DenAccount> {
  const me = await readMe(fetcher, session)
  const orgId = session.orgId ?? me.activeOrganizationId
  const orgs = await denRequest(fetcher, { ...session, orgId }, "/v1/me/orgs")
  let org: Record<string, unknown> | null = null
  if (isRecord(orgs) && Array.isArray(orgs.orgs)) {
    const list = orgs.orgs.filter(isRecord)
    const activeId = readString(orgs.activeOrgId) ?? orgId
    org = list.find((entry) => entry.id === activeId) ?? list.find((entry) => entry.isActive === true) ?? null
  }
  return {
    userId: me.userId,
    email: me.email,
    sessionExpiresAt: me.sessionExpiresAt,
    orgId: (org && readString(org.id)) ?? orgId,
    orgName: org ? (readString(org.name) ?? readString(org.slug)) : null,
    orgSlug: org ? readString(org.slug) : null,
  }
}

/** POST /api/auth/sign-out: ends the Den session (and the MCP tokens minted from it). */
export async function signOut(fetcher: Fetch, apiBaseUrl: string, token: string): Promise<boolean> {
  if (!isAllowedApiBaseUrl(apiBaseUrl)) return false
  try {
    const response = await fetcher(`${normalizeBaseUrl(apiBaseUrl)}/api/auth/sign-out`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    return response.ok
  } catch {
    return false
  }
}
