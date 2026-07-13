import { createHash, randomBytes, randomUUID } from "node:crypto"
import { z } from "zod"
import type { EnterpriseMcpScenario } from "../contracts/scenario.js"
import type { HandshakePhase } from "../contracts/phases.js"
import { scenarioSchema } from "../contracts/scenario.js"
import { getProviderProfile } from "../profiles/profiles.js"
import { getFaultDefinition } from "../faults/catalog.js"
import { toolInputSchemaSchema, type MockTool, type ToolInputSchema, type ToolSchemaNode } from "../contracts/tool.js"

export interface ProbeCredentials {
  readonly clientSecret: string
}

export interface ProbeEnterpriseMcpMockServerOptions {
  readonly baseUrl: string
  readonly scenario: EnterpriseMcpScenario
  readonly credentials?: ProbeCredentials
  readonly mode?: ProbeMode
  readonly timeoutMs?: number
  readonly callTool?: {
    readonly name: string
    readonly arguments: Readonly<Record<string, unknown>>
  }
}

export type ProbeMode = "connection-readiness" | "fixture-conformance" | "safe-read"

export interface ProbePhaseResult {
  readonly phase: HandshakePhase
  readonly status: "passed" | "failed" | "skipped"
  readonly elapsedMs: number
  readonly summary: string
}

export interface ProbeError {
  readonly phase: HandshakePhase
  readonly category: string
  readonly messageSafe: string
}

export interface ProbeResult {
  readonly ok: boolean
  readonly diagnosticId: string
  readonly mode: ProbeMode
  readonly expected: EnterpriseMcpScenario["expected"]
  readonly observed: {
    readonly outcome: "success" | "failure"
    readonly firstFailedPhase: HandshakePhase | null
    readonly category: string | null
  }
  readonly phases: readonly ProbePhaseResult[]
  readonly negotiatedProtocolVersion: string | null
  readonly toolCount: number
  readonly error: ProbeError | null
}

const protectedResourceMetadataSchema = z.object({
  resource: z.url(),
  authorization_servers: z.array(z.url()).min(1),
  scopes_supported: z.array(z.string()).min(1),
})

const authorizationServerMetadataSchema = z.object({
  issuer: z.url(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  registration_endpoint: z.url().optional(),
  revocation_endpoint: z.url().optional(),
  code_challenge_methods_supported: z.array(z.string()).min(1),
})

const registrationResponseSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().optional(),
  token_endpoint_auth_method: z.enum(["none", "client_secret_post"]),
})

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.literal("Bearer"),
})

const rpcEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
})

const initializeResultSchema = z.object({
  protocolVersion: z.string(),
  capabilities: z.record(z.string(), z.unknown()),
  serverInfo: z.object({ name: z.string(), version: z.string() }),
})

const toolsListResultSchema = z.object({
  tools: z.array(
    z.object({
      name: z.string().min(1),
      title: z.string().optional(),
      description: z.string(),
      inputSchema: z.unknown(),
    }),
  ),
  nextCursor: z.string().optional(),
})

const maximumProbeResponseBytes = 1024 * 1024
const responseDeadlines = new WeakMap<Response, number>()

class ProbeFailure extends Error {
  readonly phase: HandshakePhase
  readonly category: string

  constructor(phase: HandshakePhase, category: string, message: string) {
    super(message)
    this.name = "ProbeFailure"
    this.phase = phase
    this.category = category
  }
}

function assertLocalProbeBase(baseUrl: URL): void {
  if (
    baseUrl.protocol !== "http:" ||
    (baseUrl.hostname !== "127.0.0.1" && baseUrl.hostname !== "[::1]" && baseUrl.hostname !== "::1") ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.hash
  ) {
    throw new ProbeFailure("CONFIGURATION", "configuration", "Mock probes are restricted to literal loopback HTTP origins")
  }
}

function assertPinnedOrigin(urlValue: string | URL, baseUrl: URL, phase: HandshakePhase): URL {
  const url = new URL(urlValue)
  if (url.origin !== baseUrl.origin || url.username || url.password || url.hash) {
    throw new ProbeFailure(phase, defaultCategory(phase), "Discovered endpoint escaped the expected local mock origin")
  }
  return url
}

async function fetchStep(
  input: string | URL,
  init: RequestInit | undefined,
  phase: HandshakePhase,
  overallDeadline: number,
): Promise<Response> {
  const remainingMs = overallDeadline - Date.now()
  if (remainingMs <= 0) throw new ProbeFailure(phase, defaultCategory(phase), `Probe exceeded its overall deadline at ${phase}`)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.min(5_000, remainingMs))
  try {
    const response = await fetch(input, { ...init, redirect: init?.redirect ?? "manual", signal: controller.signal })
    responseDeadlines.set(response, Math.min(overallDeadline, Date.now() + 5_000))
    return response
  } catch (error) {
    if (controller.signal.aborted) throw new ProbeFailure(phase, defaultCategory(phase), `Probe step ${phase} timed out`)
    throw new ProbeFailure(
      "NETWORK_TCP",
      "network_tcp",
      `The loopback MCP endpoint closed or refused the TCP connection before ${phase} returned an HTTP response`,
    )
  } finally {
    clearTimeout(timeout)
  }
}

async function boundedResponseText(response: Response, phase: HandshakePhase, category: string): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const deadline = responseDeadlines.get(response) ?? Date.now() + 5_000
  const decoder = new TextDecoder()
  let byteCount = 0
  let text = ""
  try {
    for (;;) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) throw new ProbeFailure(phase, category, `Response body timed out at ${phase}`)
      let timeout: ReturnType<typeof setTimeout> | undefined
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new ProbeFailure(phase, category, `Response body timed out at ${phase}`)), remainingMs)
            timeout.unref()
          }),
        ])
      } finally {
        if (timeout) clearTimeout(timeout)
      }
      if (result.done) break
      byteCount += result.value.byteLength
      if (byteCount > maximumProbeResponseBytes) {
        throw new ProbeFailure(phase, category, `Response body exceeded the ${maximumProbeResponseBytes}-byte probe limit`)
      }
      text += decoder.decode(result.value, { stream: true })
    }
    return text + decoder.decode()
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}

async function discardResponseBody(response: Response, phase: HandshakePhase, category = defaultCategory(phase)): Promise<void> {
  await boundedResponseText(response, phase, category)
}

interface MutableProbeState {
  negotiatedProtocolVersion: string | null
  toolCount: number
}

async function parseJson(response: Response, phase: HandshakePhase, category: string): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  const text = await boundedResponseText(response, phase, category)
  if (contentType !== "application/json") throw new ProbeFailure(phase, category, `Expected JSON but received '${contentType || "no content type"}'`)
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    throw new ProbeFailure(phase, category, "Response body was not valid JSON")
  }
}

async function parseRpc(response: Response, phase: HandshakePhase): Promise<z.infer<typeof rpcEnvelopeSchema>> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  let value: unknown
  if (contentType === "text/event-stream") {
    const text = await boundedResponseText(response, phase, "mcp_transport")
    const dataLine = text
      .split("\n")
      .find((line) => line.startsWith("data: "))
    if (!dataLine) throw new ProbeFailure("MCP_TRANSPORT", "mcp_transport", "SSE response did not contain a complete data frame")
    try {
      value = JSON.parse(dataLine.slice("data: ".length))
    } catch {
      throw new ProbeFailure("MCP_TRANSPORT", "mcp_transport", "SSE data frame did not contain valid JSON")
    }
  } else if (contentType === "application/json") {
    value = await parseJson(response, phase, "mcp_transport")
  } else {
    throw new ProbeFailure("MCP_TRANSPORT", "mcp_transport", `Unexpected MCP response content type '${contentType || "none"}'`)
  }
  const envelope = rpcEnvelopeSchema.safeParse(value)
  if (!envelope.success) throw new ProbeFailure(phase, "mcp_transport", "Response was not a valid JSON-RPC envelope")
  return envelope.data
}

function defaultCategory(phase: HandshakePhase): string {
  if (phase === "AUTH_RESOURCE_DISCOVERY") return "oauth_discovery_resource"
  if (phase === "AUTH_ISSUER_DISCOVERY") return "oauth_discovery_issuer"
  if (phase === "AUTH_CLIENT_REGISTRATION") return "oauth_client_registration"
  if (phase === "AUTH_USER_OR_WORKLOAD") return "oauth_authorization"
  if (phase === "AUTH_TOKEN_ACQUISITION") return "oauth_token"
  if (phase === "AUTH_RESOURCE_VALIDATION") return "resource_token_validation"
  if (phase === "MCP_VERSION") return "mcp_version"
  if (phase === "MCP_INITIALIZE") return "mcp_initialize"
  if (phase === "MCP_INITIALIZED") return "mcp_lifecycle"
  if (phase === "MCP_TOOL_DISCOVERY") return "mcp_tools_discovery"
  if (phase === "CONTINUITY_SESSION") return "mcp_session"
  if (phase === "PROVIDER_AUTHORIZATION") return "provider_authorization_denied"
  if (phase === "PROVIDER_EXECUTION") return "provider_api"
  return "mcp_transport"
}

function redactProbeMessage(message: string, secretValues: readonly string[]): string {
  let safe = message
  for (const secret of secretValues) {
    if (secret) safe = safe.replaceAll(secret, "[REDACTED]")
  }
  return safe
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
    .replace(/(client[_ -]?secret|authorization[_ -]?code|code[_ -]?verifier|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 500)
}

async function expectOk(response: Response, phase: HandshakePhase): Promise<Response> {
  if (response.ok) return response
  let message = `HTTP ${response.status}`
  let category = defaultCategory(phase)
  try {
    const body = await boundedResponseText(response, phase, category)
    const parsed: unknown = JSON.parse(body)
    const errorBody = z.object({ error: z.string(), error_description: z.string().optional(), message: z.string().optional() }).safeParse(parsed)
    if (errorBody.success) {
      message = errorBody.data.error_description ?? errorBody.data.message ?? errorBody.data.error
      if (errorBody.data.error === "invalid_client") category = "oauth_client_registration"
      if (errorBody.data.error === "invalid_grant") category = "oauth_token"
    }
  } catch {
    // Status and phase remain sufficient safe evidence.
  }
  throw new ProbeFailure(phase, category, message)
}

function recordPassed(phases: ProbePhaseResult[], phase: HandshakePhase, startedAt: number, summary: string): void {
  phases.push({ phase, status: "passed", elapsedMs: Date.now() - startedAt, summary })
}

function parseAt<Output>(
  schema: z.ZodType<Output>,
  value: unknown,
  phase: HandshakePhase,
  category: string,
  message: string,
): Output {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new ProbeFailure(phase, category, message)
  return parsed.data
}

function defaultArguments(schema: ToolInputSchema): Readonly<Record<string, unknown>> {
  const value: Record<string, unknown> = {}
  for (const name of schema.required) {
    const property = schema.properties[name]
    if (!property) continue
    if (name === "approved") value[name] = true
    else if (name === "idempotency_key") value[name] = "probe-idempotency-key"
    else value[name] = defaultArgumentValue(property, name)
  }
  return value
}

function defaultArgumentValue(schema: ToolSchemaNode, name: string): unknown {
  if ("oneOf" in schema) return defaultArgumentValue(schema.oneOf[0] ?? { type: "null" }, name)
  if ("anyOf" in schema) return defaultArgumentValue(schema.anyOf[0] ?? { type: "null" }, name)
  if (schema.type === "string") return schema.enum?.[0] ?? (name === "number" ? "INC0000001" : "synthetic-probe-value")
  if (schema.type === "number" || schema.type === "integer") return schema.minimum ?? 1
  if (schema.type === "boolean") return true
  if (schema.type === "null") return null
  if (schema.type === "array") {
    const count = Math.max(1, schema.minItems ?? 0)
    return Array.from({ length: count }, () => defaultArgumentValue(schema.items, name))
  }
  if (schema.type !== "object") return null
  const value: Record<string, unknown> = {}
  for (const requiredName of schema.required) {
    const property = schema.properties[requiredName]
    if (property) value[requiredName] = defaultArgumentValue(property, requiredName)
  }
  return value
}

function classifyProviderToolError(value: unknown): ProbeFailure {
  const parsed = z
    .object({
      error: z.object({ code: z.string(), message: z.string().optional() }),
    })
    .safeParse(value)
  if (!parsed.success) {
    return new ProbeFailure("MCP_TOOL_EXECUTION", "mcp_tool", "Provider returned an unclassified MCP tool error")
  }
  const code = parsed.data.error.code
  if (code === "PROVIDER_ACL_DENIED") {
    return new ProbeFailure("PROVIDER_AUTHORIZATION", "provider_authorization_denied", "Provider ACL denied the tool operation")
  }
  if (code === "PROVIDER_POLICY_DENIED") {
    return new ProbeFailure("PROVIDER_AUTHORIZATION", "provider_policy_denied", "Provider policy denied the tool operation")
  }
  if (code === "PROVIDER_THROTTLED") {
    return new ProbeFailure("PROVIDER_EXECUTION", "provider_throttled", "Provider throttled the tool operation")
  }
  if (code === "PROVIDER_UNAVAILABLE") {
    return new ProbeFailure("PROVIDER_EXECUTION", "provider_unavailable", "Provider was unavailable during the tool operation")
  }
  return new ProbeFailure("MCP_TOOL_EXECUTION", "mcp_tool", `Provider returned tool error '${code}'`)
}

export async function probeEnterpriseMcpMockServer(options: ProbeEnterpriseMcpMockServerOptions): Promise<ProbeResult> {
  const diagnosticId = randomUUID()
  const scenario = scenarioSchema.parse(options.scenario)
  const profile = getProviderProfile(scenario.profileId)
  const mode = options.mode ?? "fixture-conformance"
  const baseUrl = new URL(options.baseUrl)
  assertLocalProbeBase(baseUrl)
  const mcpUrl = new URL(profile.endpointPath, baseUrl).href
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 120_000) {
    throw new ProbeFailure("CONFIGURATION", "configuration", "Probe timeout must be an integer from 50 through 120000 milliseconds")
  }
  const overallDeadline = Date.now() + timeoutMs
  const phases: ProbePhaseResult[] = []
  const mutable: MutableProbeState = { negotiatedProtocolVersion: null, toolCount: 0 }
  const sensitiveValues = [options.credentials?.clientSecret ?? ""]
  let sessionId = ""
  let accessToken = ""
  let refreshToken = ""
  let revocationClientId = scenario.oauth.clientId
  let revocationClientSecret = options.credentials?.clientSecret ?? ""
  let negotiatedProtocolHeader = ""
  let revocationEndpoint: URL | null = null
  const cleanup = async (requireValidDelete: boolean): Promise<void> => {
    const cleanupDeadline = Date.now() + 2_000
    if (sessionId && accessToken && negotiatedProtocolHeader) {
      try {
        const deleteResponse = await fetchStep(mcpUrl, {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${accessToken}`,
            origin: baseUrl.origin,
            "mcp-session-id": sessionId,
            "mcp-protocol-version": negotiatedProtocolHeader,
          },
        }, "SHUTDOWN", cleanupDeadline)
        await discardResponseBody(deleteResponse, "SHUTDOWN", "mcp_session")
        if (requireValidDelete && deleteResponse.status !== 204) {
          throw new ProbeFailure("SHUTDOWN", "mcp_session", `Session DELETE returned HTTP ${deleteResponse.status}`)
        }
      } catch (error) {
        if (requireValidDelete) throw error
      }
    }
    if (revocationEndpoint && accessToken) {
      try {
        const revocationResponse = await fetchStep(revocationEndpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: accessToken,
            client_id: revocationClientId,
            ...(revocationClientSecret ? { client_secret: revocationClientSecret } : {}),
          }),
        }, "SHUTDOWN", cleanupDeadline)
        await discardResponseBody(revocationResponse, "SHUTDOWN", "oauth_token")
      } catch {
        // Cleanup never replaces the primary diagnostic failure.
      }
    }
    if (revocationEndpoint && refreshToken) {
      try {
        const revocationResponse = await fetchStep(revocationEndpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: refreshToken,
            client_id: revocationClientId,
            ...(revocationClientSecret ? { client_secret: revocationClientSecret } : {}),
          }),
        }, "SHUTDOWN", cleanupDeadline)
        await discardResponseBody(revocationResponse, "SHUTDOWN", "oauth_token")
      } catch {
        // Cleanup never replaces the primary diagnostic failure.
      }
    }
  }
  try {
    let startedAt = Date.now()
    const challengeResponse = await fetchStep(
      mcpUrl,
      {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          origin: baseUrl.origin,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: scenario.protocol.version,
            capabilities: {},
            clientInfo: { name: "enterprise-mcp-probe", version: "0.1.0" },
          },
        }),
      },
      "AUTH_RESOURCE_DISCOVERY",
      overallDeadline,
    )
    await discardResponseBody(challengeResponse, "AUTH_RESOURCE_DISCOVERY", "oauth_discovery_resource")
    if (challengeResponse.status !== 401) {
      throw new ProbeFailure("AUTH_RESOURCE_DISCOVERY", "oauth_discovery_resource", `Unauthenticated MCP probe returned HTTP ${challengeResponse.status}, not 401`)
    }
    const challengeHeader = challengeResponse.headers.get("www-authenticate") ?? ""
    const metadataMatch = /resource_metadata="([^"]+)"/.exec(challengeHeader)
    const metadataUrlValue = metadataMatch?.[1]
    if (!metadataUrlValue) {
      throw new ProbeFailure("AUTH_RESOURCE_DISCOVERY", "oauth_discovery_resource", "MCP 401 challenge did not provide resource_metadata")
    }
    const resourceMetadataUrl = assertPinnedOrigin(metadataUrlValue, baseUrl, "AUTH_RESOURCE_DISCOVERY")
    const expectedMetadataPath = `/.well-known/oauth-protected-resource${profile.endpointPath}`
    if (resourceMetadataUrl.pathname !== expectedMetadataPath) {
      throw new ProbeFailure("AUTH_RESOURCE_DISCOVERY", "oauth_discovery_resource", "MCP challenge pointed to unexpected protected-resource metadata")
    }
    const resourceResponse = await expectOk(
      await fetchStep(resourceMetadataUrl, undefined, "AUTH_RESOURCE_DISCOVERY", overallDeadline),
      "AUTH_RESOURCE_DISCOVERY",
    )
    const resourceMetadata = parseAt(
      protectedResourceMetadataSchema,
      await parseJson(resourceResponse, "AUTH_RESOURCE_DISCOVERY", "oauth_discovery_resource"),
      "AUTH_RESOURCE_DISCOVERY",
      "oauth_discovery_resource",
      "Protected-resource metadata did not match the required shape",
    )
    if (resourceMetadata.resource !== mcpUrl) {
      throw new ProbeFailure("AUTH_RESOURCE_DISCOVERY", "oauth_discovery_resource", "Protected-resource metadata did not identify this MCP endpoint")
    }
    recordPassed(phases, "AUTH_RESOURCE_DISCOVERY", startedAt, "Protected-resource metadata is coherent")

    startedAt = Date.now()
    const authorizationServerValue = resourceMetadata.authorization_servers[0]
    if (!authorizationServerValue) {
      throw new ProbeFailure("AUTH_ISSUER_DISCOVERY", "oauth_discovery_issuer", "Protected-resource metadata had no authorization server")
    }
    const issuerMetadataResponse = await expectOk(
      await fetchStep(
        new URL("/.well-known/oauth-authorization-server", assertPinnedOrigin(authorizationServerValue, baseUrl, "AUTH_ISSUER_DISCOVERY")),
        undefined,
        "AUTH_ISSUER_DISCOVERY",
        overallDeadline,
      ),
      "AUTH_ISSUER_DISCOVERY",
    )
    const issuerMetadata = parseAt(
      authorizationServerMetadataSchema,
      await parseJson(issuerMetadataResponse, "AUTH_ISSUER_DISCOVERY", "oauth_discovery_issuer"),
      "AUTH_ISSUER_DISCOVERY",
      "oauth_discovery_issuer",
      "Authorization-server metadata did not match the required shape",
    )
    if (issuerMetadata.issuer !== baseUrl.href.replace(/\/$/, "")) {
      throw new ProbeFailure("AUTH_ISSUER_DISCOVERY", "oauth_discovery_issuer", "Authorization-server metadata issuer did not match")
    }
    const authorizationEndpoint = assertPinnedOrigin(issuerMetadata.authorization_endpoint, baseUrl, "AUTH_ISSUER_DISCOVERY")
    const tokenEndpoint = assertPinnedOrigin(issuerMetadata.token_endpoint, baseUrl, "AUTH_ISSUER_DISCOVERY")
    const registrationEndpoint = issuerMetadata.registration_endpoint
      ? assertPinnedOrigin(issuerMetadata.registration_endpoint, baseUrl, "AUTH_CLIENT_REGISTRATION")
      : undefined
    revocationEndpoint = issuerMetadata.revocation_endpoint
      ? assertPinnedOrigin(issuerMetadata.revocation_endpoint, baseUrl, "AUTH_ISSUER_DISCOVERY")
      : null
    if (!issuerMetadata.code_challenge_methods_supported.includes("S256")) {
      throw new ProbeFailure("AUTH_ISSUER_DISCOVERY", "oauth_pkce_unsupported", "Authorization server did not advertise PKCE S256")
    }
    recordPassed(phases, "AUTH_ISSUER_DISCOVERY", startedAt, "Authorization-server metadata and PKCE S256 are usable")

    let clientId = scenario.oauth.clientId
    let clientSecret = options.credentials?.clientSecret ?? ""
    let tokenAuthMethod: "none" | "client_secret_post" = profile.oauth.defaultClientAuthenticationMethod
    startedAt = Date.now()
    if (scenario.oauth.registration === "dynamic") {
      if (!registrationEndpoint) {
        throw new ProbeFailure("AUTH_CLIENT_REGISTRATION", "oauth_client_registration", "Authorization server did not advertise dynamic registration")
      }
      tokenAuthMethod = profile.oauth.defaultClientAuthenticationMethod
      const registrationResponse = await expectOk(
        await fetchStep(registrationEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            redirect_uris: scenario.oauth.redirectUris,
            token_endpoint_auth_method: tokenAuthMethod,
            client_name: "OpenWork enterprise MCP probe",
          }),
        }, "AUTH_CLIENT_REGISTRATION", overallDeadline),
        "AUTH_CLIENT_REGISTRATION",
      )
      const registration = parseAt(
        registrationResponseSchema,
        await parseJson(registrationResponse, "AUTH_CLIENT_REGISTRATION", "oauth_client_registration"),
        "AUTH_CLIENT_REGISTRATION",
        "oauth_client_registration",
        "Dynamic registration response did not match the required shape",
      )
      clientId = registration.client_id
      clientSecret = registration.client_secret ?? ""
      if (clientSecret) sensitiveValues.push(clientSecret)
      tokenAuthMethod = registration.token_endpoint_auth_method
    } else if (tokenAuthMethod === "client_secret_post" && !clientSecret) {
      throw new ProbeFailure("AUTH_CLIENT_REGISTRATION", "oauth_client_registration", "Manual OAuth profile requires a client secret")
    }
    revocationClientId = clientId
    revocationClientSecret = tokenAuthMethod === "client_secret_post" ? clientSecret : ""
    recordPassed(phases, "AUTH_CLIENT_REGISTRATION", startedAt, "OAuth client identification is ready")

    const verifier = randomBytes(32).toString("base64url")
    const pkceChallengeValue = createHash("sha256").update(verifier).digest("base64url")
    const oauthState = randomBytes(16).toString("base64url")
    sensitiveValues.push(verifier, oauthState)
    const redirectUri = scenario.oauth.redirectUris[0]
    if (!redirectUri) throw new ProbeFailure("CONFIGURATION", "configuration", "Scenario has no redirect URI")
    const authorizeUrl = new URL(authorizationEndpoint)
    authorizeUrl.searchParams.set("response_type", "code")
    authorizeUrl.searchParams.set("client_id", clientId)
    authorizeUrl.searchParams.set("redirect_uri", redirectUri)
    authorizeUrl.searchParams.set("scope", scenario.oauth.authorizationScopes.join(" "))
    authorizeUrl.searchParams.set("resource", mcpUrl)
    authorizeUrl.searchParams.set("state", oauthState)
    authorizeUrl.searchParams.set("code_challenge", pkceChallengeValue)
    authorizeUrl.searchParams.set("code_challenge_method", "S256")
    startedAt = Date.now()
    const authorizeResponse = await fetchStep(authorizeUrl, { redirect: "manual" }, "AUTH_USER_OR_WORKLOAD", overallDeadline)
    if (authorizeResponse.status !== 302) await expectOk(authorizeResponse, "AUTH_USER_OR_WORKLOAD")
    else await discardResponseBody(authorizeResponse, "AUTH_USER_OR_WORKLOAD", "oauth_authorization")
    const location = authorizeResponse.headers.get("location")
    if (!location) throw new ProbeFailure("AUTH_USER_OR_WORKLOAD", "oauth_authorization", "Authorization response had no redirect location")
    const callback = new URL(location)
    const callbackWithoutResponse = new URL(callback)
    callbackWithoutResponse.searchParams.delete("code")
    callbackWithoutResponse.searchParams.delete("state")
    if (callbackWithoutResponse.href !== redirectUri) {
      throw new ProbeFailure("AUTH_USER_OR_WORKLOAD", "oauth_authorization", "Authorization callback did not exactly match the registered redirect URI")
    }
    if (callback.searchParams.get("state") !== oauthState || !callback.searchParams.get("code")) {
      throw new ProbeFailure("AUTH_USER_OR_WORKLOAD", "oauth_authorization", "Authorization callback state or code was invalid")
    }
    sensitiveValues.push(callback.searchParams.get("code") ?? "")
    recordPassed(phases, "AUTH_USER_OR_WORKLOAD", startedAt, "Synthetic user authorization and state binding passed")

    startedAt = Date.now()
    const tokenForm = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code: callback.searchParams.get("code") ?? "",
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: mcpUrl,
    })
    if (tokenAuthMethod === "client_secret_post") tokenForm.set("client_secret", clientSecret)
    const tokenResponse = await expectOk(
      await fetchStep(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenForm,
      }, "AUTH_TOKEN_ACQUISITION", overallDeadline),
      "AUTH_TOKEN_ACQUISITION",
    )
    const token = parseAt(
      tokenResponseSchema,
      await parseJson(tokenResponse, "AUTH_TOKEN_ACQUISITION", "oauth_token"),
      "AUTH_TOKEN_ACQUISITION",
      "oauth_token",
      "Token response did not match the required shape",
    )
    accessToken = token.access_token
    refreshToken = token.refresh_token
    sensitiveValues.push(accessToken, refreshToken)
    recordPassed(phases, "AUTH_TOKEN_ACQUISITION", startedAt, "Authorization code and PKCE token exchange passed")

    const rpcHeaders = {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      origin: baseUrl.origin,
    }
    startedAt = Date.now()
    const initializeRawResponse = await fetchStep(mcpUrl, {
        method: "POST",
        headers: rpcHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: scenario.protocol.version,
            capabilities: {},
            clientInfo: { name: "enterprise-mcp-probe", version: "0.1.0" },
          },
        }),
      }, "MCP_INITIALIZE", overallDeadline)
    if (initializeRawResponse.status === 401 || initializeRawResponse.status === 403) {
      throw new ProbeFailure(
        "AUTH_RESOURCE_VALIDATION",
        initializeRawResponse.status === 403 ? "oauth_insufficient_scope" : "oauth_wrong_audience",
        `MCP resource rejected the synthetic access token with HTTP ${initializeRawResponse.status}`,
      )
    }
    const initializeResponse = await expectOk(initializeRawResponse, "MCP_INITIALIZE")
    sessionId = initializeResponse.headers.get("mcp-session-id") ?? ""
    negotiatedProtocolHeader = initializeResponse.headers.get("mcp-protocol-version") ?? scenario.protocol.version
    const initializeEnvelope = await parseRpc(initializeResponse, "MCP_INITIALIZE")
    if (initializeEnvelope.error) {
      const versionEvidence = z.object({ supportedVersions: z.array(z.string()).min(1) }).safeParse(initializeEnvelope.error.data)
      throw versionEvidence.success || initializeEnvelope.error.message === "Unsupported MCP protocol version"
        ? new ProbeFailure("MCP_VERSION", "mcp_version", initializeEnvelope.error.message)
        : new ProbeFailure("MCP_INITIALIZE", "mcp_initialize", initializeEnvelope.error.message)
    }
    if (initializeEnvelope.id !== 1) {
      throw new ProbeFailure("MCP_INITIALIZE", "mcp_initialize", "Initialize response JSON-RPC id did not match the request")
    }
    const initialize = parseAt(
      initializeResultSchema,
      initializeEnvelope.result,
      "MCP_INITIALIZE",
      "mcp_initialize",
      "Initialize result did not match the required shape",
    )
    if (initialize.protocolVersion !== scenario.protocol.version) {
      throw new ProbeFailure("MCP_VERSION", "mcp_version", "Server selected an unexpected MCP protocol version")
    }
    mutable.negotiatedProtocolVersion = initialize.protocolVersion
    if (scenario.protocol.requireSession && !sessionId) {
      throw new ProbeFailure("MCP_INITIALIZE", "mcp_initialize", "Initialize response omitted required MCP-Session-Id")
    }
    recordPassed(phases, "MCP_INITIALIZE", startedAt, "MCP version, capabilities, and session negotiated")

    const sessionHeaders = {
      ...rpcHeaders,
      "mcp-session-id": sessionId,
      "mcp-protocol-version": initialize.protocolVersion,
    }
    startedAt = Date.now()
    const initializedResponse = await fetchStep(mcpUrl, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }, "MCP_INITIALIZED", overallDeadline)
    await discardResponseBody(initializedResponse, "MCP_INITIALIZED", "mcp_lifecycle")
    if (initializedResponse.status === 404) {
      throw new ProbeFailure("CONTINUITY_SESSION", "mcp_session_expired", "MCP session expired after initialize")
    }
    if (initializedResponse.status !== 202) {
      throw new ProbeFailure("MCP_INITIALIZED", "mcp_lifecycle", `Initialized notification returned HTTP ${initializedResponse.status}`)
    }
    recordPassed(phases, "MCP_INITIALIZED", startedAt, "Initialized notification received HTTP 202")

    startedAt = Date.now()
    const toolNames = new Set<string>()
    const discoveredTools: MockTool[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    let catalogComplete = false
    for (let page = 0; page < 25; page += 1) {
      if (cursor) {
        if (cursors.has(cursor)) throw new ProbeFailure("MCP_TOOL_DISCOVERY", "mcp_pagination_loop", "Tool catalog repeated a cursor")
        cursors.add(cursor)
      }
      const listResponse = await expectOk(
        await fetchStep(mcpUrl, {
          method: "POST",
          headers: sessionHeaders,
          body: JSON.stringify({ jsonrpc: "2.0", id: 10 + page, method: "tools/list", params: cursor ? { cursor } : {} }),
        }, "MCP_TOOL_DISCOVERY", overallDeadline),
        "MCP_TOOL_DISCOVERY",
      )
      const envelope = await parseRpc(listResponse, "MCP_TOOL_DISCOVERY")
      if (envelope.id !== 10 + page) {
        throw new ProbeFailure("MCP_TOOL_DISCOVERY", "mcp_tools_discovery", "tools/list response JSON-RPC id did not match the request")
      }
      if (envelope.error) throw new ProbeFailure("MCP_TOOL_DISCOVERY", "mcp_tools_discovery", envelope.error.message)
      const result = parseAt(
        toolsListResultSchema,
        envelope.result,
        "MCP_TOOL_DISCOVERY",
        "mcp_tools_discovery",
        "tools/list result did not match the required shape",
      )
      if (result.nextCursor && cursors.has(result.nextCursor)) {
        throw new ProbeFailure("MCP_TOOL_DISCOVERY", "mcp_pagination_loop", "Tool catalog repeated a cursor")
      }
      for (const rawTool of result.tools) {
        if (toolNames.has(rawTool.name)) throw new ProbeFailure("MCP_TOOL_DISCOVERY", "mcp_duplicate_tool", `Tool '${rawTool.name}' was duplicated`)
        const inputSchema = toolInputSchemaSchema.safeParse(rawTool.inputSchema)
        if (!inputSchema.success) throw new ProbeFailure("MCP_TOOL_DISCOVERY", "mcp_invalid_tool_schema", `Tool '${rawTool.name}' has an invalid input schema`)
        toolNames.add(rawTool.name)
        const sourceTool = profile.tools.find((tool) => tool.name === rawTool.name)
        if (sourceTool) discoveredTools.push(sourceTool)
      }
      if (!result.nextCursor) {
        catalogComplete = true
        break
      }
      cursor = result.nextCursor
    }
    if (!catalogComplete) {
      throw new ProbeFailure("MCP_TOOL_DISCOVERY", "mcp_pagination_limit", "Tool catalog exceeded the 25-page safety limit")
    }
    mutable.toolCount = toolNames.size
    if (toolNames.size === 0) throw new ProbeFailure("MCP_TOOL_DISCOVERY", "catalog_empty", "Tool catalog was protocol-valid but did not satisfy enterprise readiness because it was empty")
    if (mode !== "connection-readiness") {
      const expectedToolNames = new Set(profile.tools.map((tool) => tool.name))
      const missing = [...expectedToolNames].filter((name) => !toolNames.has(name))
      const unexpected = [...toolNames].filter((name) => !expectedToolNames.has(name))
      if (missing.length > 0 || unexpected.length > 0) {
        throw new ProbeFailure(
          "MCP_TOOL_DISCOVERY",
          "profile_fixture_mismatch",
          `Catalog does not match pinned profile fixture ${profile.fixtureVersion}`,
        )
      }
    }
    recordPassed(phases, "MCP_TOOL_DISCOVERY", startedAt, `Retrieved ${toolNames.size} unique tools with bounded pagination`)

    const fault = scenario.activeFault ? getFaultDefinition(scenario.activeFault.id) : undefined
    const shouldCall = options.callTool !== undefined || mode === "safe-read" || fault?.phase === "PROVIDER_AUTHORIZATION" || fault?.phase === "PROVIDER_EXECUTION"
    if (shouldCall) {
      const selected = options.callTool
        ? { name: options.callTool.name, arguments: options.callTool.arguments }
        : (() => {
            const mutationRequired = fault?.effect === "commit-then-disconnect"
            const tool = discoveredTools.find((candidate) => candidate.kind === (mutationRequired ? "mutation" : "read"))
            if (!tool) throw new ProbeFailure("MCP_TOOL_EXECUTION", "mcp_tool", "No suitable tool was available for the requested probe")
            return { name: tool.name, arguments: defaultArguments(tool.inputSchema) }
          })()
      const selectedTool = profile.tools.find((tool) => tool.name === selected.name)
      if (mode === "safe-read" && selectedTool?.kind !== "read") {
        throw new ProbeFailure("CONFIGURATION", "configuration", "safe-read mode accepts only a declared read-only tool")
      }
      startedAt = Date.now()
      let toolResponse: Response
      try {
        toolResponse = await fetchStep(mcpUrl, {
          method: "POST",
          headers: sessionHeaders,
          body: JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/call", params: selected }),
        }, "MCP_TOOL_EXECUTION", overallDeadline)
      } catch {
        throw new ProbeFailure(
          selectedTool?.kind === "mutation" ? "PROVIDER_EXECUTION" : "MCP_TOOL_EXECUTION",
          selectedTool?.kind === "mutation" ? "mutation_indeterminate" : "mcp_tool",
          "Connection closed before the tool response completed",
        )
      }
      const envelope = await parseRpc(await expectOk(toolResponse, "MCP_TOOL_EXECUTION"), "MCP_TOOL_EXECUTION")
      if (envelope.id !== 100) {
        throw new ProbeFailure("MCP_TOOL_EXECUTION", "mcp_tool", "tools/call response JSON-RPC id did not match the request")
      }
      if (envelope.error) throw new ProbeFailure("MCP_TOOL_EXECUTION", "mcp_tool", envelope.error.message)
      const toolResult = parseAt(
        z.object({ isError: z.boolean(), structuredContent: z.unknown().optional() }),
        envelope.result,
        "MCP_TOOL_EXECUTION",
        "mcp_tool",
        "Tool response did not match the MCP result shape",
      )
      if (toolResult.isError) {
        throw classifyProviderToolError(toolResult.structuredContent)
      }
      recordPassed(phases, "MCP_TOOL_EXECUTION", startedAt, "Safe synthetic tool execution passed")
    }

    await cleanup(true)
    const observed: ProbeResult["observed"] = { outcome: "success", firstFailedPhase: null, category: null }
    const ok = scenario.expected.outcome === "success"
    return {
      ok,
      diagnosticId,
      mode,
      expected: scenario.expected,
      observed,
      phases,
      negotiatedProtocolVersion: mutable.negotiatedProtocolVersion,
      toolCount: mutable.toolCount,
      error: null,
    }
  } catch (unknownError) {
    const failure = unknownError instanceof ProbeFailure
      ? unknownError
      : new ProbeFailure("HTTP_ROUTING", "mcp_transport", unknownError instanceof Error ? unknownError.message : "Unknown probe failure")
    await cleanup(false)
    const safeFailureMessage = redactProbeMessage(failure.message, sensitiveValues)
    phases.push({ phase: failure.phase, status: "failed", elapsedMs: 0, summary: safeFailureMessage })
    const observed: ProbeResult["observed"] = {
      outcome: "failure",
      firstFailedPhase: failure.phase,
      category: failure.category,
    }
    const ok =
      scenario.expected.outcome === "failure" &&
      scenario.expected.firstFailedPhase === failure.phase &&
      scenario.expected.category === failure.category
    return {
      ok,
      diagnosticId,
      mode,
      expected: scenario.expected,
      observed,
      phases,
      negotiatedProtocolVersion: mutable.negotiatedProtocolVersion,
      toolCount: mutable.toolCount,
      error: { phase: failure.phase, category: failure.category, messageSafe: safeFailureMessage },
    }
  }
}
