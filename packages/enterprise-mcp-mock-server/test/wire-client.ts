import { createHash, randomBytes } from "node:crypto"
import { z } from "zod"
import type { EnterpriseMcpScenario } from "../src/index.js"
import { getProviderProfile } from "../src/index.js"

const tokenSchema = z.object({ access_token: z.string(), refresh_token: z.string() })
const rpcSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
})

export interface WireToken {
  readonly accessToken: string
  readonly refreshToken: string
}

export interface WireSession extends WireToken {
  readonly sessionId: string
  readonly protocolVersion: string
}

async function json(response: Response): Promise<unknown> {
  const parsed: unknown = JSON.parse(await response.text())
  return parsed
}

export async function authorizeManual(
  baseUrl: string,
  scenario: EnterpriseMcpScenario,
  clientSecret: string,
): Promise<WireToken> {
  return authorizeClient(baseUrl, scenario, scenario.oauth.clientId, clientSecret)
}

export async function authorizeClient(
  baseUrl: string,
  scenario: EnterpriseMcpScenario,
  clientId: string,
  clientSecret?: string,
): Promise<WireToken> {
  const profile = getProviderProfile(scenario.profileId)
  const mcpUrl = new URL(profile.endpointPath, baseUrl).href
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const redirectUri = scenario.oauth.redirectUris[0]
  if (!redirectUri) throw new Error("Scenario redirect URI missing")
  const authorize = new URL(profile.oauth.authorizationPath, baseUrl)
  authorize.searchParams.set("response_type", "code")
  authorize.searchParams.set("client_id", clientId)
  authorize.searchParams.set("redirect_uri", redirectUri)
  authorize.searchParams.set("scope", scenario.oauth.authorizationScopes.join(" "))
  authorize.searchParams.set("resource", mcpUrl)
  authorize.searchParams.set("state", "wire-state")
  authorize.searchParams.set("code_challenge", challenge)
  authorize.searchParams.set("code_challenge_method", "S256")
  const authorizeResponse = await fetch(authorize, { redirect: "manual" })
  if (authorizeResponse.status !== 302) throw new Error(`Authorize failed with ${authorizeResponse.status}`)
  const location = authorizeResponse.headers.get("location")
  if (!location) throw new Error("Authorize response omitted location")
  const code = new URL(location).searchParams.get("code")
  if (!code) throw new Error("Authorize response omitted code")
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code,
    code_verifier: verifier,
    resource: mcpUrl,
  })
  if (clientSecret) form.set("client_secret", clientSecret)
  const tokenResponse = await fetch(new URL(profile.oauth.tokenPath, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  })
  if (tokenResponse.status !== 200) throw new Error(`Token exchange failed with ${tokenResponse.status}`)
  const token = tokenSchema.parse(await json(tokenResponse))
  return { accessToken: token.access_token, refreshToken: token.refresh_token }
}

export async function initializeSession(
  baseUrl: string,
  scenario: EnterpriseMcpScenario,
  token: WireToken,
): Promise<WireSession> {
  const profile = getProviderProfile(scenario.profileId)
  const mcpUrl = new URL(profile.endpointPath, baseUrl)
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: rpcHeaders(baseUrl, token.accessToken),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: scenario.protocol.version,
        capabilities: {},
        clientInfo: { name: "wire-test", version: "1" },
      },
    }),
  })
  if (response.status !== 200) throw new Error(`Initialize failed with ${response.status}`)
  const envelope = rpcSchema.parse(await json(response))
  if (envelope.error) throw new Error(envelope.error.message)
  const sessionId = response.headers.get("mcp-session-id")
  const protocolVersion = response.headers.get("mcp-protocol-version")
  if (!sessionId || !protocolVersion) throw new Error("Initialize response omitted session headers")
  const initialized = await fetch(mcpUrl, {
    method: "POST",
    headers: sessionHeaders(baseUrl, token.accessToken, sessionId, protocolVersion),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  })
  if (initialized.status !== 202) throw new Error(`Initialized notification failed with ${initialized.status}`)
  return { ...token, sessionId, protocolVersion }
}

export function rpcHeaders(baseUrl: string, accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    origin: new URL(baseUrl).origin,
  }
}

export function sessionHeaders(
  baseUrl: string,
  accessToken: string,
  sessionId: string,
  protocolVersion: string,
): Record<string, string> {
  return {
    ...rpcHeaders(baseUrl, accessToken),
    "mcp-session-id": sessionId,
    "mcp-protocol-version": protocolVersion,
  }
}

export async function callRpc(
  baseUrl: string,
  scenario: EnterpriseMcpScenario,
  session: WireSession,
  id: number,
  method: string,
  params: unknown,
): Promise<{ readonly response: Response; readonly envelope: z.infer<typeof rpcSchema> }> {
  const profile = getProviderProfile(scenario.profileId)
  const response = await fetch(new URL(profile.endpointPath, baseUrl), {
    method: "POST",
    headers: sessionHeaders(baseUrl, session.accessToken, session.sessionId, session.protocolVersion),
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  })
  return { response, envelope: rpcSchema.parse(await json(response)) }
}
