import { createHash } from "node:crypto"
import { z } from "zod"
import type { Tokens } from "./sealed.js"

/**
 * Workbot signs people in with Den, as Den's first-party OAuth client `openwork-workbot` (no consent screen, one
 * return address, PKCE, no secret). It finds Den's sign-in the way MCP clients do: the `/mcp/agent` resource names
 * its authorization server. The tokens are for that resource, which is also what lets Den tell Workbot who someone
 * is (`/v1/workbot/session`) and mint each turn's short-lived app token (`/v1/workbot/run-token`).
 */
export const WORKBOT_CLIENT_ID = "openwork-workbot"
const SCOPES = "openid profile email offline_access mcp:read mcp:write"
const TIMEOUT_MS = 20_000

const protectedResourceSchema = z.object({ resource: z.string(), authorization_servers: z.array(z.string()).min(1) })
const metadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  revocation_endpoint: z.string().optional(),
})
const tokenSchema = z.object({ access_token: z.string(), refresh_token: z.string().optional(), expires_in: z.number().optional() })
export const denSessionSchema = z.object({
  user: z.object({ id: z.string(), name: z.string().nullable(), email: z.string() }),
  organization: z.object({ id: z.string(), name: z.string(), brandAppName: z.string().nullable() }),
  memberId: z.string(),
  enabled: z.boolean(),
  canSchedule: z.boolean(),
  /** Workbot's Calendar tab is on (Workbot and workbotCalendar). Older Dens omit it: off. */
  calendar: z.boolean().optional(),
  /** Side chats are on for this person. A Den from before side chats doesn't say: off. */
  sideChats: z.boolean().default(false),
  calendarPolish: z.boolean().default(false),
  /** The organization's default model for Workbot's turns. Null, or a Den from before it, means the runner's default. */
  model: z.string().nullable().default(null),
})
export type DenSession = z.infer<typeof denSessionSchema>

type Discovery = { resource: string; issuer: string; authorizationEndpoint: string; tokenEndpoint: string; revocationEndpoint: string | null }

/** Den said the token or grant is no longer good: the person signs in again. */
export class DenSignedOutError extends Error {
  constructor() {
    super("signed_out")
    this.name = "DenSignedOutError"
  }
}

export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url")

async function getJson(url: string) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!response.ok) throw new Error(`den_discovery_${response.status}`)
  return response.json()
}

export function createDen(options: { apiUrl: string; publicUrl: string }) {
  const redirectUri = `${options.publicUrl}/auth/callback`
  let discovered: Promise<Discovery> | null = null

  const discover = () => {
    discovered ??= (async () => {
      const resource = protectedResourceSchema.parse(await getJson(`${options.apiUrl}/.well-known/oauth-protected-resource/mcp/agent`))
      const issuer = new URL(resource.authorization_servers[0] ?? "")
      const path = issuer.pathname === "/" ? "" : issuer.pathname
      // RFC 8414's path-inserted form first, then the forms older servers use.
      const candidates = [
        `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
        `${issuer.origin}${path}/.well-known/oauth-authorization-server`,
        `${issuer.origin}/.well-known/openid-configuration${path}`,
        `${issuer.origin}${path}/.well-known/openid-configuration`,
      ]
      for (const candidate of candidates) {
        const metadata = metadataSchema.safeParse(await getJson(candidate).catch(() => null))
        if (metadata.success) {
          return {
            resource: resource.resource,
            issuer: metadata.data.issuer,
            authorizationEndpoint: metadata.data.authorization_endpoint,
            tokenEndpoint: metadata.data.token_endpoint,
            revocationEndpoint: metadata.data.revocation_endpoint ?? null,
          }
        }
      }
      throw new Error("den_discovery_failed")
    })().catch((error: unknown) => {
      discovered = null
      throw error
    })
    return discovered
  }

  const tokenRequest = async (body: Record<string, string>): Promise<Tokens> => {
    const { tokenEndpoint, resource } = await discover()
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ ...body, client_id: WORKBOT_CLIENT_ID, resource }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const payload: unknown = await response.json().catch(() => null)
    if (response.status === 400 || response.status === 401) throw new DenSignedOutError()
    const tokens = tokenSchema.safeParse(payload)
    if (!response.ok || !tokens.success) throw new Error(`den_token_${response.status}`)
    return {
      accessToken: tokens.data.access_token,
      refreshToken: tokens.data.refresh_token ?? body.refresh_token ?? null,
      expiresAt: Date.now() + (tokens.data.expires_in ?? 900) * 1000,
    }
  }

  const authorized = async (method: "GET" | "POST" | "PATCH", path: string, accessToken: string, body?: unknown) => {
    const response = await fetch(`${options.apiUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (response.status === 401) throw new DenSignedOutError()
    const payload: unknown = await response.json().catch(() => null)
    return { status: response.status, payload }
  }

  return {
    discover,
    /** Where to send the browser to sign in; Den returns it to /auth/callback with a code. */
    async authorizeUrl(input: { state: string; verifier: string }) {
      const { authorizationEndpoint, resource } = await discover()
      const url = new URL(authorizationEndpoint)
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: WORKBOT_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: SCOPES,
        state: input.state,
        code_challenge: pkceChallenge(input.verifier),
        code_challenge_method: "S256",
        resource,
      }).toString()
      return url.toString()
    },
    exchangeCode: (code: string, verifier: string) =>
      tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }),
    refresh: (refreshToken: string) => tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }),
    /** Best effort: ends the refresh token's grant family at Den when the person signs out. */
    async revoke(refreshToken: string) {
      const { revocationEndpoint } = await discover()
      if (!revocationEndpoint) return
      await fetch(revocationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token", client_id: WORKBOT_CLIENT_ID }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch(() => undefined)
    },
    async session(accessToken: string): Promise<DenSession> {
      const { status, payload } = await authorized("GET", "/v1/workbot/session", accessToken)
      const parsed = denSessionSchema.safeParse(payload)
      if (status !== 200 || !parsed.success) throw new Error(`den_session_${status}`)
      return parsed.data
    },
    async runToken(accessToken: string, input: { readOnly?: boolean } = {}): Promise<string> {
      const { status, payload } = await authorized("POST", "/v1/workbot/run-token", accessToken, input)
      const parsed = z.object({ token: z.string() }).safeParse(payload)
      if (status !== 200 || !parsed.success) throw new Error(`den_run_token_${status}`)
      return parsed.data.token
    },
    /** The Gmail, Slack and Microsoft 365 connections the person's admins set up, and whether each is ready for them. */
    async connections(accessToken: string) {
      const { status, payload } = await authorized("GET", "/v1/workbot/connections", accessToken)
      const parsed = workbotConnectionsSchema.safeParse(payload)
      if (status !== 200 || !parsed.success) throw new Error(`den_connections_${status}`)
      return parsed.data.connections
    },
    /**
     * One request Workbot's Calendar makes for the person (their Automations, runs and calendar meetings), through
     * Den's allowlisted `/v1/workbot/calendar/*`. Den's status and body come back as they are.
     */
    async calendar(accessToken: string, input: { method: "GET" | "POST" | "PATCH"; path: string; body?: unknown }) {
      return authorized(input.method, `/v1/workbot/calendar${input.path}`, accessToken, input.body)
    },
    /** Den's web app, from its sign-in issuer, for links back to OpenWork and app logos. */
    async webUrl() {
      return new URL((await discover()).issuer).origin
    },
  }
}

const workbotConnectionsSchema = z.object({
  connections: z.array(z.object({
    id: z.string(),
    name: z.string(),
    app: z.enum(["gmail", "googleCalendar", "slack", "microsoft"]),
    ready: z.boolean(),
    connectUrl: z.string().nullable(),
  })),
})

export type Den = ReturnType<typeof createDen>
