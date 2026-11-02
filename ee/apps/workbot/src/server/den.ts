import { createHash } from "node:crypto"
import { z } from "zod"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { skillCreatedPayloadSchema } from "@openwork/types/skill-created-app"
import { headlessModelAccessSchema } from "@openwork-ee/headless-protocol"
import { workbotAccessFailureSchema, type WorkbotAccessReason } from "@openwork/types/den/workbot-settings"
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
  computer: z.boolean().default(false),
  browser: z.boolean().default(false),
  browserDemonstrations: z.boolean().default(false),
  /** Workbot's computers run through the runner's sandbox gateway. Older Dens omit it: the runner's own provider. */
  sandboxGateway: z.boolean().default(false),
  /** Workbot's Calendar tab is on (while Workbot is on). Older Dens omit it: off. */
  calendar: z.boolean().optional(),
  documents: z.boolean().default(false),
  documentEditing: z.boolean().default(false),
  nativeDictation: z.boolean().default(false),
  workspaceAssistant: z.boolean().default(false),
  guidedNavigation: z.boolean().default(false),
  usageRecovery: z.boolean().default(false),
  /** The Get set up checklist. A Den from before it doesn't say: off. */
  activationChecklist: z.boolean().default(true),
  /** Side chats are on for this person. A Den from before side chats doesn't say: off. */
  sideChats: z.boolean().default(false),
  /** The Cmd+K / Ctrl+K command palette. A Den from before it doesn't say: off. */
  /** The organization's default model for Workbot's turns. Null, or a Den from before it, means the runner's default. */
  model: z.string().nullable().default(null),
  verifyModel: z.boolean().default(false),
  /** Den validates the exact gateway alias and mints model access for each turn. Older Dens stay on runner credentials. */
  gatewayModels: z.boolean().default(false),
  /** Turns run one step at a time on the runner (saved step turns). A Den from before it doesn't say: off. */
  stepTurns: z.boolean().default(false),
  /** New chats get their own session cell on the runner (per-chat session cells). A Den from before it doesn't say: off. */
  sessionCells: z.boolean().default(false),
})

const runTokenSchema = z.object({
  token: z.string(),
  resumeGrant: z.string().optional(),
  modelAccess: headlessModelAccessSchema.optional(),
  /** Den's session index capability: passed to the runner with the turn, never to the browser. */
  indexCapability: z.string().optional(),
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

/** Den's token endpoint asked Workbot to wait this many seconds before asking again. */
export class DenRateLimitedError extends Error {
  constructor(readonly retryAfter: number) {
    super("den_token_rate_limited")
    this.name = "DenRateLimitedError"
  }
}

/** Bounds Den's Retry-After: a missing or unreadable value waits a little, a huge one never strands a sign-in for long. */
const DEFAULT_TOKEN_RETRY_AFTER_S = 30
const MAX_TOKEN_RETRY_AFTER_S = 300

export function tokenRetryAfterSeconds(header: string | null) {
  const value = header?.trim() ?? ""
  if (!/^\d{1,9}$/.test(value)) return DEFAULT_TOKEN_RETRY_AFTER_S
  return Math.min(Math.max(Number(value), 1), MAX_TOKEN_RETRY_AFTER_S)
}

/** Only this allowlisted refusal survives a failed credential mint. Never retain Den's raw payload. */
export class WorkbotTurnAccessError extends Error {
  constructor(readonly reason: WorkbotAccessReason, readonly status: 403 | 429 | 503, readonly retryAfter?: number) {
    super(`workbot_turn_access_denied:${reason}`)
    this.name = "WorkbotTurnAccessError"
  }
  response(): Response {
    return Response.json({ error: "workbot_turn_access_denied", reason: this.reason, ...(this.retryAfter ? { retryAfter: this.retryAfter } : {}) },
      { status: this.status, headers: { "Cache-Control": "no-store", ...(this.retryAfter ? { "Retry-After": String(this.retryAfter) } : {}) } })
  }
}

export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url")

async function getJson(url: string) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!response.ok) throw new Error(`den_discovery_${response.status}`)
  return response.json()
}

export function createDen(options: { apiUrl: string; publicUrl: string; serviceToken?: string }) {
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
    if (response.status === 429) throw new DenRateLimitedError(tokenRetryAfterSeconds(response.headers.get("retry-after")))
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
    modelRecovery: (accessToken: string) => authorized("GET", "/v1/workbot/model-recovery", accessToken),
    /** The member's Get set up checklist; Den computes every step and enforces the feature. */
    activation: (accessToken: string) => authorized("GET", "/v1/workbot/activation", accessToken),
    activationEvent: (accessToken: string, body: unknown) => authorized("POST", "/v1/workbot/activation/events", accessToken, body),
    /** Where to send the browser to sign in; Den returns it to /auth/callback with a code. */
    async authorizeUrl(input: { state: string; verifier: string; chooseWorkspace?: boolean }) {
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
        // Explicit workspace changes must not silently reuse the active workspace's existing grant.
        ...(input.chooseWorkspace ? { prompt: "consent" } : {}),
        resource,
      }).toString()
      return url.toString()
    },
    /** Successful cookie write, not merely a session read. Never awaited by sign-in. */
    async recordSignIn(accessToken: string, id: string) {
      if (!options.serviceToken) return
      try {
        const response = await fetch(`${options.apiUrl}/v1/workbot/telemetry`, {
          method: "POST", redirect: "error",
          headers: { authorization: `Bearer ${accessToken}`, "x-openwork-workbot-service": options.serviceToken, "content-type": "application/json" },
          body: JSON.stringify({ event: "signed_in", id, timestamp: Date.now() }), signal: AbortSignal.timeout(2_000),
        })
        if (!response.ok) console.warn("[workbot] telemetry_delivery_failed", { status: response.status })
      } catch {
        // Analytics is never a sign-in dependency; do not log credentials or response bodies.
        console.warn("[workbot] telemetry_delivery_failed")
      }
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
    /** The normal private Cloud-skill path: Den owns permissions, audit, and persistence. */
    async saveBrowserSkill(accessToken: string, pluginName: string, skillMarkdown: string) {
      const client = new Client({ name: "openwork-workbot", version: "1" })
      const transport = new StreamableHTTPClientTransport(new URL(`${options.apiUrl}/mcp/agent`), {
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      })
      try {
        await client.connect(transport, { timeout: TIMEOUT_MS })
        const result = await client.callTool({ name: "create_skill", arguments: { pluginName, skillMarkdown } }, undefined, { timeout: TIMEOUT_MS })
        if (result.isError) throw new Error("The skill could not be saved. Check your skill-creation permission or choose a different name.")
        return skillCreatedPayloadSchema.parse(result.structuredContent)
      } finally { await client.close() }
    },
    async session(accessToken: string): Promise<DenSession> {
      const { status, payload } = await authorized("GET", "/v1/workbot/session", accessToken)
      const parsed = denSessionSchema.safeParse(payload)
      if (status !== 200 || !parsed.success) throw new Error(`den_session_${status}`)
      return parsed.data
    },
    /**
     * A token for one turn. With the turn's runner `sessionId` and `messageId`, Den also returns a resume grant where
     * turns keep going on their own (saved step turns); older Dens ignore both and never return one.
     */
    async runToken(
      accessToken: string,
      input: { readOnly?: boolean; sessionId?: string; messageId?: string; model?: string; gatewayModels?: boolean; modelAccessRequired?: boolean } = {},
    ): Promise<z.infer<typeof runTokenSchema>> {
      const body = {
        ...(input.readOnly !== undefined ? { readOnly: input.readOnly } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.messageId ? { messageId: input.messageId } : {}),
        ...((input.gatewayModels || input.modelAccessRequired) && input.model ? { model: input.model } : {}),
        ...(input.modelAccessRequired ? { modelAccessRequired: true } : {}),
      }
      const { status, payload } = await authorized("POST", "/v1/workbot/run-token", accessToken, body)
      const parsed = runTokenSchema.safeParse(payload)
      // Never include the response body or validation issues: they may contain model credentials.
      if (status !== 200) {
        const refusal = workbotAccessFailureSchema.safeParse(payload)
        if (refusal.success) throw new WorkbotTurnAccessError(refusal.data.reason, status === 429 ? 429 : status === 403 ? 403 : 503, refusal.data.retryAfter)
        // Compatibility with older Dens is deliberately generic, never an upgrade signal.
        const rateLimited = status === 429
        const missingScope = status === 403 && typeof payload === "object" && payload !== null && "error" in payload && payload.error === "insufficient_scope"
        throw new WorkbotTurnAccessError(rateLimited ? "rate_limited" : missingScope ? "oauth_scope_missing" : "model_access_unavailable", status === 429 ? 429 : status === 403 ? 403 : 503)
      }
      if (!parsed.success) throw new Error("den_run_token_200")
      return parsed.data
    },
    /** The Gmail, Slack and Microsoft 365 connections the person's admins set up, and whether each is ready for them. */
    async connections(accessToken: string) {
      const { status, payload } = await authorized("GET", "/v1/workbot/connections", accessToken)
      const parsed = workbotConnectionsSchema.safeParse(payload)
      if (status !== 200 || !parsed.success) throw new Error(`den_connections_${status}`)
      return parsed.data.connections
    },
    async connect(accessToken: string, connectionId: string, body: unknown) {
      return authorized("POST", `/v1/workbot/connections/${encodeURIComponent(connectionId)}/connect/start`, accessToken, body)
    },
    /**
     * One request Workbot's Calendar makes for the person (their Automations, runs and calendar meetings), through
     * Den's allowlisted `/v1/workbot/calendar/*`. Den's status and body come back as they are.
     */
    async calendar(accessToken: string, input: { method: "GET" | "POST" | "PATCH"; path: string; body?: unknown }) {
      return authorized(input.method, `/v1/workbot/calendar${input.path}`, accessToken, input.body)
    },
    /** Documents reads and explicit editor actions; Den enforces the feature and exact route allowlist. */
    async documents(accessToken: string, path: string, method: "GET" | "POST" = "GET", body?: unknown) {
      return authorized(method, `/v1/workbot/documents${path}`, accessToken, body)
    },
    async documentContent(accessToken: string, path: string) {
      const response = await fetch(`${options.apiUrl}/v1/workbot/documents${path}`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (response.status === 401) throw new DenSignedOutError()
      return response
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
    nativeProviderKey: z.string().nullable().optional(),
    connectMode: z.enum(["inline", "external", "admin"]).optional(),
  })),
})

export type Den = ReturnType<typeof createDen>
