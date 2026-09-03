// Refreshes a member's `oauth_google` credential under a per-row lock (plan
// §5.5 step 4). The lock is `refreshing_until`: the first request to claim it
// refreshes; others poll the row briefly and reuse the result, or fall back to
// the stale token (upstream 401 is passed through). `invalid_grant` marks the
// row `refresh_failed` so the next request takes the auth_required path.
import { and, eq, isNull, lt, or } from "@openwork-ee/den-db/drizzle"
import { InferenceProviderCredentialTable } from "@openwork-ee/den-db"
import type { InferenceOauthTokenSecret } from "@openwork/types/den/inference"
import { affectedRows } from "../rollups.js"

export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
export const REFRESH_WINDOW_MS = 60_000
const LOCK_MS = 30_000
const WAIT_MS = 5_000
const POLL_MS = 250
const TOKEN_REQUEST_TIMEOUT_MS = 15_000

type CredentialRow = typeof InferenceProviderCredentialTable.$inferSelect

export type OauthCredentialRow = Pick<CredentialRow, "id" | "secret" | "expires_at" | "status"> & { kind: "oauth_google" | "oauth_azure" }

export type OauthClient = { oauth_client_id: string | null; oauth_client_secret: string | null }

export type GoogleOauthRefreshStore = {
  // UPDATE … SET refreshing_until = until WHERE id = ? AND (refreshing_until IS NULL OR refreshing_until < now)
  tryAcquireRefreshLock(input: { credentialId: CredentialRow["id"]; now: Date; until: Date }): Promise<boolean>
  reloadCredential(credentialId: CredentialRow["id"]): Promise<OauthCredentialRow | null>
  // New secret + expiry; clears the lock and last_error, status active.
  saveRefreshedToken(input: { credentialId: CredentialRow["id"]; secret: string; expiresAt: Date; now: Date }): Promise<void>
  // Clears the lock; `permanent` (invalid_grant) also sets status refresh_failed.
  recordRefreshFailure(input: { credentialId: CredentialRow["id"]; error: string; permanent: boolean }): Promise<void>
}

export type GoogleOauthRefreshOutcome =
  | { kind: "refreshed"; credential: OauthCredentialRow }
  | { kind: "auth_required" }
  | { kind: "stale" }

export type RefreshGoogleOauthToken = (input: {
  credential: OauthCredentialRow
  token: InferenceOauthTokenSecret
  provider: OauthClient
  now: Date
}) => Promise<GoogleOauthRefreshOutcome>

export function needsGoogleOauthRefresh(credential: { expires_at: Date | null }, token: InferenceOauthTokenSecret, now: Date) {
  return credential.expires_at !== null
    && Boolean(token.refreshToken)
    && credential.expires_at.getTime() - now.getTime() <= REFRESH_WINDOW_MS
}

type TokenEndpointResult =
  | { kind: "ok"; accessToken: string; refreshToken: string | null; tokenType: string | null; expiresIn: number }
  | { kind: "invalid_grant"; error: string }
  | { kind: "transient"; error: string }

function readString(record: Record<string, unknown>, key: string) {
  return typeof record[key] === "string" && record[key] ? record[key] : null
}

async function requestRefresh(fetchImpl: typeof fetch, tokenUrl: string, params: URLSearchParams): Promise<TokenEndpointResult> {
  let response: Response
  try {
    response = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params,
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    return { kind: "transient", error: `token endpoint unreachable: ${error instanceof Error ? error.message : String(error)}` }
  }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  const record: Record<string, unknown> = typeof body === "object" && body !== null ? { ...body } : {}
  if (!response.ok) {
    const error = readString(record, "error") ?? `http_${response.status}`
    const description = readString(record, "error_description")
    const message = description ? `${error}: ${description}` : error
    return error === "invalid_grant" ? { kind: "invalid_grant", error: message } : { kind: "transient", error: message }
  }
  const accessToken = readString(record, "access_token")
  if (!accessToken) return { kind: "transient", error: "token endpoint returned no access_token" }
  const expiresIn = typeof record.expires_in === "number" && Number.isFinite(record.expires_in) ? record.expires_in : 3600
  return { kind: "ok", accessToken, refreshToken: readString(record, "refresh_token"), tokenType: readString(record, "token_type"), expiresIn }
}

export function createGoogleOauthRefresher(deps: {
  fetch: typeof fetch
  store: GoogleOauthRefreshStore
  tokenUrl?: string
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  waitMs?: number
}): RefreshGoogleOauthToken {
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const pollMs = deps.pollMs ?? POLL_MS
  const attempts = Math.ceil((deps.waitMs ?? WAIT_MS) / pollMs)

  async function waitForOtherRefresh(credentialId: CredentialRow["id"], now: Date): Promise<GoogleOauthRefreshOutcome> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await sleep(pollMs)
      const row = await deps.store.reloadCredential(credentialId)
      if (!row || row.status === "refresh_failed" || row.status === "revoked") return { kind: "auth_required" }
      if (row.expires_at !== null && row.expires_at.getTime() - now.getTime() > REFRESH_WINDOW_MS) return { kind: "refreshed", credential: row }
    }
    return { kind: "stale" }
  }

  return async (input) => {
    if (!input.provider.oauth_client_id || !input.provider.oauth_client_secret || !input.token.refreshToken) {
      return { kind: "stale" }
    }
    const acquired = await deps.store.tryAcquireRefreshLock({
      credentialId: input.credential.id,
      now: input.now,
      until: new Date(input.now.getTime() + LOCK_MS),
    })
    if (!acquired) return waitForOtherRefresh(input.credential.id, input.now)

    const result = await requestRefresh(deps.fetch, deps.tokenUrl ?? GOOGLE_OAUTH_TOKEN_URL, new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.token.refreshToken,
      client_id: input.provider.oauth_client_id,
      client_secret: input.provider.oauth_client_secret,
    }))
    if (result.kind === "invalid_grant") {
      await deps.store.recordRefreshFailure({ credentialId: input.credential.id, error: result.error, permanent: true })
      return { kind: "auth_required" }
    }
    if (result.kind === "transient") {
      await deps.store.recordRefreshFailure({ credentialId: input.credential.id, error: result.error, permanent: false })
      return { kind: "stale" }
    }
    const secret: InferenceOauthTokenSecret = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken ?? input.token.refreshToken,
      ...(result.tokenType ?? input.token.tokenType ? { tokenType: result.tokenType ?? input.token.tokenType } : {}),
    }
    const expiresAt = new Date(input.now.getTime() + result.expiresIn * 1000)
    const serialized = JSON.stringify(secret)
    await deps.store.saveRefreshedToken({ credentialId: input.credential.id, secret: serialized, expiresAt, now: input.now })
    return { kind: "refreshed", credential: { ...input.credential, secret: serialized, expires_at: expiresAt, status: "active" } }
  }
}

type Db = Pick<typeof import("../db.js").db, "select" | "update">

export function createDbGoogleOauthRefreshStore(db: Db): GoogleOauthRefreshStore {
  const table = InferenceProviderCredentialTable
  return {
    async tryAcquireRefreshLock(input) {
      const result = await db
        .update(table)
        .set({ refreshing_until: input.until })
        .where(and(eq(table.id, input.credentialId), or(isNull(table.refreshing_until), lt(table.refreshing_until, input.now))))
      return affectedRows(result) > 0
    },
    async reloadCredential(credentialId) {
      const [row] = await db
        .select({ id: table.id, kind: table.kind, secret: table.secret, expires_at: table.expires_at, status: table.status })
        .from(table)
        .where(eq(table.id, credentialId))
        .limit(1)
      if (!row || (row.kind !== "oauth_google" && row.kind !== "oauth_azure")) return null
      return { ...row, kind: row.kind }
    },
    async saveRefreshedToken(input) {
      await db
        .update(table)
        .set({ secret: input.secret, expires_at: input.expiresAt, last_refreshed_at: input.now, refreshing_until: null, last_error: null, status: "active" })
        .where(eq(table.id, input.credentialId))
    },
    async recordRefreshFailure(input) {
      const set: Partial<typeof table.$inferInsert> = { refreshing_until: null, last_error: input.error }
      if (input.permanent) set.status = "refresh_failed"
      await db.update(table).set(set).where(eq(table.id, input.credentialId))
    },
  }
}
