import { createHash } from "node:crypto"
import { z } from "zod"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { skillCreatedPayloadSchema } from "@openwork/types/skill-created-app"
import { headlessModelAccessSchema } from "@openwork-ee/headless-protocol"
import { remoteSessionStatusResultSchema, type RemoteSessionStatusRequest } from "@openwork/types/automations"
import { workbotAccessFailureSchema, type WorkbotAccessReason } from "@openwork/types/den/workbot-settings"
import type { RemoteDeviceWorkbotReport } from "@openwork/types/den/remote-devices"
import type { Tokens } from "./sealed.js"

export const WORKBOT_CLIENT_ID = "openwork-workbot"
export const SIGN_IN_ONLY_PARAM = "openwork_sign_in_only"
const SCOPES = "openid profile email offline_access mcp:read mcp:write"
const TIMEOUT_MS = 20_000
const REMOTE_STATUS_TIMEOUT_MS = 8_000
const DEVICE_REPORT_TIMEOUT_MS = 5_000
const remoteErrorCodeSchema = z.object({ error: z.string().max(120) })

export class DenRemoteSessionError extends Error {
  constructor(readonly reason: "signed_out" | "unavailable", readonly code: string) {
    super(`remote_session_${reason}:${code}`)
    this.name = "DenRemoteSessionError"
  }
}

export class DenAppError extends Error {
  constructor(readonly reason: "signed_out" | "unavailable", readonly code: string) {
    super(`app_${reason}:${code}`)
    this.name = "DenAppError"
  }
}

const MAX_APP_HTML_CHARS = 2_000_000
const appLaunchToolSchema = z.object({ _meta: z.object({ ui: z.object({ resourceUri: z.string().min(1) }) }) })

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
  browserRecovery: z.boolean().default(false),
  calendar: z.boolean().optional(),
  documents: z.boolean().default(false),
  workspaceAssistant: z.boolean().default(false),
  guidedNavigation: z.boolean().default(false),
  usageRecovery: z.boolean().default(false),
  activationChecklist: z.boolean().default(true),
  sideChats: z.boolean().default(false),
  calmChat: z.boolean().default(false),
  model: z.string().nullable().default(null),
  verifyModel: z.boolean().default(false),
  gatewayModels: z.boolean().default(false),
  stepTurns: z.boolean().default(false),
  sessionCells: z.boolean().default(false),
  mobile: z.boolean().default(false),
})

const runTokenSchema = z.object({
  token: z.string(),
  resumeGrant: z.string().optional(),
  modelAccess: headlessModelAccessSchema.optional(),
  indexCapability: z.string().optional(),
})
export type DenSession = z.infer<typeof denSessionSchema>

type Discovery = { resource: string; issuer: string; authorizationEndpoint: string; tokenEndpoint: string; revocationEndpoint: string | null }

export class DenSignedOutError extends Error {
  constructor() {
    super("signed_out")
    this.name = "DenSignedOutError"
  }
}

export class DenUnavailableError extends Error {
  constructor(code: string) {
    super(code)
    this.name = "DenUnavailableError"
  }
}

const unanswered = (error: unknown) => new DenUnavailableError(error instanceof Error && error.name === "TimeoutError" ? "den_timeout" : "den_unreachable")

export class DenRateLimitedError extends Error {
  constructor(readonly retryAfter: number) {
    super("den_token_rate_limited")
    this.name = "DenRateLimitedError"
  }
}

const DEFAULT_TOKEN_RETRY_AFTER_S = 30
const MAX_TOKEN_RETRY_AFTER_S = 300

export function tokenRetryAfterSeconds(header: string | null) {
  const value = header?.trim() ?? ""
  if (!/^\d{1,9}$/.test(value)) return DEFAULT_TOKEN_RETRY_AFTER_S
  return Math.min(Math.max(Number(value), 1), MAX_TOKEN_RETRY_AFTER_S)
}

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

  const authorized = async (method: "GET" | "POST" | "PATCH", path: string, accessToken: string, body?: unknown, timeoutMs = TIMEOUT_MS) => {
    const response = await fetch(`${options.apiUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((error: unknown) => { throw unanswered(error) })
    if (response.status === 401) throw new DenSignedOutError()
    const payload: unknown = await response.json().catch(() => null)
    return { status: response.status, payload }
  }

  const remoteCall = async (accessToken: string, action: "status" | "read" | "stop", body: unknown, timeoutMs = TIMEOUT_MS): Promise<unknown> => {
    const client = new Client({ name: "openwork-workbot", version: "1" })
    const transport = new StreamableHTTPClientTransport(new URL(`${options.apiUrl}/mcp/agent`), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    })
    try {
      let result: Awaited<ReturnType<Client["callTool"]>>
      try {
        await client.connect(transport, { timeout: timeoutMs })
        result = await client.callTool({ name: "execute_capability", arguments: { name: `remote-session:${action}`, body } }, undefined, { timeout: timeoutMs })
      } catch (error) {
        const status = typeof error === "object" && error !== null && "code" in error ? error.code : null
        throw new DenRemoteSessionError(status === 401 || status === 403 ? "signed_out" : "unavailable", typeof status === "number" ? `http_${status}` : error instanceof Error ? error.name : "transport")
      }
      if (result.isError) {
        const code = remoteErrorCodeSchema.safeParse(result.structuredContent)
        const error = code.success ? code.data.error : "remote_session_unavailable"
        throw new DenRemoteSessionError(error === "membership_required" || error === "insufficient_mcp_scope" ? "signed_out" : "unavailable", error)
      }
      if (result.structuredContent) return result.structuredContent
      const blocks = z.array(z.object({ type: z.string(), text: z.string().optional() })).safeParse(result.content)
      for (const block of blocks.success ? blocks.data : []) {
        if (block.type !== "text" || !block.text) continue
        try { return JSON.parse(block.text) } catch {}
      }
      throw new DenRemoteSessionError("unavailable", "not_json")
    } finally { await client.close().catch(() => undefined) }
  }

  const withApp = async <T>(accessToken: string, appId: string, run: (client: Client) => Promise<T>): Promise<T> => {
    const client = new Client({ name: "openwork-workbot", version: "1" })
    const transport = new StreamableHTTPClientTransport(new URL(`${options.apiUrl}/mcp/agent/connections/${encodeURIComponent(appId)}`), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    })
    try {
      await client.connect(transport, { timeout: TIMEOUT_MS })
      return await run(client)
    } catch (error) {
      if (error instanceof DenAppError) throw error
      const status = typeof error === "object" && error !== null && "code" in error ? error.code : null
      throw new DenAppError(status === 401 ? "signed_out" : "unavailable", typeof status === "number" ? `code_${status}` : error instanceof Error ? error.name : "transport")
    } finally { await client.close().catch(() => undefined) }
  }

  return {
    discover,
    openApp: (accessToken: string, appId: string) =>
      withApp(accessToken, appId, async (client) => {
        const listed = await client.listTools(undefined, { timeout: TIMEOUT_MS })
        const launch = appLaunchToolSchema.safeParse(listed.tools.find((tool) => tool.name === "open_app"))
        if (!launch.success) throw new DenAppError("unavailable", "no_launch")
        const result = await client.callTool({ name: "open_app", arguments: { input: {} } }, undefined, { timeout: TIMEOUT_MS })
        const resource = await client.readResource({ uri: launch.data._meta.ui.resourceUri }, { timeout: TIMEOUT_MS })
        const page = resource.contents.flatMap((entry) => ("text" in entry && typeof entry.text === "string" ? [entry.text] : []))[0]
        if (page === undefined || page.length > MAX_APP_HTML_CHARS) throw new DenAppError("unavailable", "no_page")
        return { html: page, result }
      }),
    callApp: (accessToken: string, appId: string, name: string, args: Record<string, unknown>) =>
      withApp(accessToken, appId, (client) => client.callTool({ name, arguments: args }, undefined, { timeout: TIMEOUT_MS })),
    modelRecovery: (accessToken: string) => authorized("GET", "/v1/workbot/model-recovery", accessToken),
    activation: (accessToken: string) => authorized("GET", "/v1/workbot/activation", accessToken),
    activationEvent: (accessToken: string, body: unknown) => authorized("POST", "/v1/workbot/activation/events", accessToken, body),
    devices: (accessToken: string) => authorized("GET", "/v1/workbot/devices", accessToken),
    reportComputer: (accessToken: string, report: RemoteDeviceWorkbotReport) => authorized("POST", "/v1/workbot/devices/computer", accessToken, report, DEVICE_REPORT_TIMEOUT_MS),
    async authorizeUrl(input: { state: string; chooseWorkspace?: boolean; signInOnly?: boolean } & ({ verifier: string } | { challenge: string })) {
      const { authorizationEndpoint, resource } = await discover()
      const url = new URL(authorizationEndpoint)
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: WORKBOT_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: SCOPES,
        state: input.state,
        code_challenge: "challenge" in input ? input.challenge : pkceChallenge(input.verifier),
        code_challenge_method: "S256",
        ...(input.chooseWorkspace ? { prompt: "consent" } : {}),
        ...(input.signInOnly ? { [SIGN_IN_ONLY_PARAM]: "true" } : {}),
        resource,
      }).toString()
      return url.toString()
    },
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
        console.warn("[workbot] telemetry_delivery_failed")
      }
    },
    exchangeCode: (code: string, verifier: string) =>
      tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }),
    refresh: (refreshToken: string) => tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }),
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
    async remoteStatus(accessToken: string, input: RemoteSessionStatusRequest) {
      const parsed = remoteSessionStatusResultSchema.safeParse(await remoteCall(accessToken, "status", input, REMOTE_STATUS_TIMEOUT_MS))
      if (!parsed.success) throw new DenRemoteSessionError("unavailable", "invalid_status")
      return parsed.data
    },
    remoteRead: (accessToken: string, input: { sessionId: string; workspaceId?: string; limit: number; from: "end" } | { requestId: string }) => remoteCall(accessToken, "read", input),
    remoteStop: (accessToken: string, input: { sessionId: string; workspaceId?: string; messageId: string }) => remoteCall(accessToken, "stop", input),
    async saveBrowserSkill(accessToken: string, pluginName: string, skillMarkdown: string, skillId?: string) {
      const client = new Client({ name: "openwork-workbot", version: "1" })
      const transport = new StreamableHTTPClientTransport(new URL(`${options.apiUrl}/mcp/agent`), {
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      })
      try {
        await client.connect(transport, { timeout: TIMEOUT_MS })
        const result = await client.callTool(skillId
          ? { name: "update_skill", arguments: { skillId, skillMarkdown, reason: "Edited after teaching in the browser" } }
          : { name: "create_skill", arguments: { pluginName, skillMarkdown } }, undefined, { timeout: TIMEOUT_MS })
        if (result.isError) throw new Error(skillId ? "The skill could not be updated. Check that you can still edit it." : "The skill could not be saved. Check your skill-creation permission or choose a different name.")
        return skillCreatedPayloadSchema.parse(result.structuredContent)
      } finally { await client.close() }
    },
    async session(accessToken: string): Promise<DenSession> {
      const { status, payload } = await authorized("GET", "/v1/workbot/session", accessToken)
      const parsed = denSessionSchema.safeParse(payload)
      if (status >= 500) throw new DenUnavailableError(`den_session_${status}`)
      if (status !== 200 || !parsed.success) throw new Error(`den_session_${status}`)
      return parsed.data
    },
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
      if (status !== 200) {
        const refusal = workbotAccessFailureSchema.safeParse(payload)
        if (refusal.success) throw new WorkbotTurnAccessError(refusal.data.reason, status === 429 ? 429 : status === 403 ? 403 : 503, refusal.data.retryAfter)
        const rateLimited = status === 429
        const missingScope = status === 403 && typeof payload === "object" && payload !== null && "error" in payload && payload.error === "insufficient_scope"
        throw new WorkbotTurnAccessError(rateLimited ? "rate_limited" : missingScope ? "oauth_scope_missing" : "model_access_unavailable", status === 429 ? 429 : status === 403 ? 403 : 503)
      }
      if (!parsed.success) throw new Error("den_run_token_200")
      return parsed.data
    },
    async connections(accessToken: string) {
      const { status, payload } = await authorized("GET", "/v1/workbot/connections", accessToken)
      const parsed = workbotConnectionsSchema.safeParse(payload)
      if (status !== 200 || !parsed.success) throw new Error(`den_connections_${status}`)
      return parsed.data
    },
    async connectors(accessToken: string) {
      const { status, payload } = await authorized("GET", "/v1/workbot/connections", accessToken)
      const parsed = workbotConnectionsSchema.safeParse(payload)
      if (status !== 200 || !parsed.success) throw new Error(`den_connections_${status}`)
      return parsed.data.connectors
    },
    async connect(accessToken: string, connectionId: string, body: unknown) {
      return authorized("POST", `/v1/workbot/connections/${encodeURIComponent(connectionId)}/connect/start`, accessToken, body)
    },
    async calendar(accessToken: string, input: { method: "GET" | "POST" | "PATCH"; path: string; body?: unknown }) {
      return authorized(input.method, `/v1/workbot/calendar${input.path}`, accessToken, input.body)
    },
    async documents(accessToken: string, path: string) {
      return authorized("GET", `/v1/workbot/documents${path}`, accessToken)
    },
    async documentContent(accessToken: string, path: string, range?: string) {
      const waiting = new AbortController()
      const timer = setTimeout(() => waiting.abort(new DOMException("Den did not answer in time.", "TimeoutError")), TIMEOUT_MS)
      const response = await fetch(`${options.apiUrl}/v1/workbot/documents${path}`, { headers: { authorization: `Bearer ${accessToken}`, ...(range ? { range } : {}) }, signal: waiting.signal })
        .catch((error: unknown) => { throw unanswered(error) })
        .finally(() => clearTimeout(timer))
      if (response.status === 401) throw new DenSignedOutError()
      return response
    },
    async webUrl() {
      return new URL((await discover()).issuer).origin
    },
  }
}

const workbotConnectionsSchema = z.object({
  connections: z.array(z.object({
    id: z.string(),
    name: z.string(),
    app: z.enum(["gmail", "googleCalendar", "slack", "microsoft", "other"]).catch("other"),
    ready: z.boolean(),
    connectUrl: z.string().nullable(),
    nativeProviderKey: z.string().nullable().optional(),
    connectMode: z.enum(["inline", "external", "admin"]).optional(),
  })),
  apps: z.array(z.object({
    id: z.string(),
    name: z.string(),
    iconCandidates: z.array(z.string()).optional(),
    nativeProviderKey: z.string().nullable(),
    authType: z.enum(["oauth", "apikey", "none"]),
    status: z.enum(["connected", "needs_sign_in", "not_connected", "needs_attention"]),
    managedBy: z.enum(["you", "organization"]),
    action: z.enum(["connect", "ask_admin", "admin_settings"]).nullable(),
    connectMode: z.enum(["inline", "external", "admin"]),
    connectUrl: z.string().nullable(),
    ready: z.boolean(),
  })).optional(),
  connectors: z.array(z.object({ id: z.string(), name: z.string(), site: z.string().nullable() })).default([]),
})

export type Den = ReturnType<typeof createDen>
