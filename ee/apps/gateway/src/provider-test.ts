// Test a provider configuration before it is saved.
// Den sends the provider, its settings, an organization credential and one model;
// the gateway sends one short prompt the same way it would forward a member's
// request, and answers whether the provider replied. Nothing is stored or logged
// as usage, and the upstream body never reaches the caller.
import { BEDROCK_MANTLE_DEFAULT_API_PATH } from "@openwork-ee/utils/bedrock-mantle-catalog"
import { bedrockMantleHost, bedrockRuntimeHost, inferenceEgressAllowedOrigins, isAwsRegion, validateInferenceUrl } from "@openwork-ee/utils/inference-egress"
import { isInferenceCredentialKindSupported, pickInferenceApiKeyFromMap } from "@openwork-ee/utils/inference-credentials"
import { PROVIDER_TEST_SIGNATURE_HEADER, verifyProviderTestSignature } from "@openwork-ee/utils/provider-test-signature"
import { GATEWAY_PROVIDER_CREDENTIAL_KINDS, parseGatewayProviderSecret } from "@openwork/types/den/gateway"
import type { GatewayAwsKeysSecret, GatewayGcpServiceAccountSecret, GatewayProviderTestResult } from "@openwork/types/den/gateway"
import type { Context, Hono } from "hono"
import { z } from "zod"
import { bedrockMantleService, bedrockService, signAwsRequest } from "./credentials/aws-sigv4.js"
import type { AwsCredentials } from "./credentials/aws-sigv4.js"
import type { MintGcpAccessToken } from "./credentials/gcp-service-account.js"
import type { InferenceAuthVariables } from "./middleware/inference-auth.js"
import type { OrganizationVariables } from "./middleware/org-context.js"
import { buildAuthHeader, classifyProtocolFamily, defaultBaseUrl, vertexPublisherBase } from "./protocols.js"
import type { ProtocolFamily } from "./protocols.js"
import type { CatalogProvider, ProviderCatalog } from "./provider-catalog.js"

export const gatewayProviderTestPath = "/api/v1/provider-tests"

const TEST_PROMPT = "Reply with the single word OK."
const MAX_OUTPUT_TOKENS = 16
const TEST_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 16_384

const requestSchema = z.object({
  providerId: z.string().trim().min(1).max(255),
  model: z.string().trim().min(1).max(255),
  // Upstream destination settings. upstreamBaseUrl is only used when the operator allowlisted its origin.
  settings: z.object({
    project: z.string().trim().max(255).optional(),
    location: z.string().trim().max(63).optional(),
    resourceName: z.string().trim().max(63).optional(),
    apiVersion: z.string().trim().max(64).optional(),
    region: z.string().trim().max(63).optional(),
    upstreamBaseUrl: z.string().trim().max(2048).optional(),
  }).strict().default({}),
  credential: z.object({ kind: z.enum(GATEWAY_PROVIDER_CREDENTIAL_KINDS), secret: z.string().min(1).max(65535) }).strict(),
}).strict()

type TestRequest = z.infer<typeof requestSchema>
type Settings = TestRequest["settings"]
type UpstreamCall = { url: URL; headers: Headers; body: string }
type Credential =
  | { kind: "secret"; secret: string }
  | { kind: "aws_keys"; awsKeys: GatewayAwsKeysSecret }
  | { kind: "gcp_service_account"; serviceAccount: GatewayGcpServiceAccountSecret }

export type ProviderTestDependencies = {
  fetch: typeof fetch
  /** The database encryption key Den also holds; Den signs each test with a key derived from it. */
  signingSecret: string | undefined
  catalog: ProviderCatalog
  mintGcpAccessToken: MintGcpAccessToken
  now: () => Date
}

function failed(code: string, message: string, model: string, status: number | null = null): GatewayProviderTestResult {
  return { ok: false, model, status, code, message }
}

function readCredential(input: TestRequest, catalog: CatalogProvider): Credential | { error: string } {
  let parsed: ReturnType<typeof parseGatewayProviderSecret>
  try { parsed = parseGatewayProviderSecret(input.credential.kind, input.credential.secret) } catch {
    return { error: "The key isn't in the format this provider expects." }
  }
  if (!isInferenceCredentialKindSupported(parsed.kind, input.providerId)) return { error: "This kind of key isn't supported for this provider." }
  switch (parsed.kind) {
    case "api_key":
      return { kind: "secret", secret: parsed.apiKey }
    case "api_key_map": {
      const secret = pickInferenceApiKeyFromMap(parsed.apiKeys, catalog.env)
      return secret ? { kind: "secret", secret } : { error: "Paste the provider's API key." }
    }
    case "aws_keys":
      return { kind: "aws_keys", awsKeys: parsed.awsKeys }
    case "gcp_service_account":
      return { kind: "gcp_service_account", serviceAccount: parsed.serviceAccount }
    default:
      return { error: "Only a shared organization key can be tested." }
  }
}

/** Anthropic Messages and OpenAI Chat Completions share this shape. */
function messagesBody(model: string) {
  return { model, max_tokens: MAX_OUTPUT_TOKENS, messages: [{ role: "user", content: TEST_PROMPT }] }
}

/**
 * A saved provider's base URL override, honoured here only for an origin the
 * operator allowlisted (a private endpoint or proxy the deployment owns). Any
 * other address would let a caller aim a test at a host of their choosing.
 */
function operatorBaseUrl(settings: Settings): string | null | { error: string } {
  const override = settings.upstreamBaseUrl
  if (!override) return null
  try {
    if (inferenceEgressAllowedOrigins().has(new URL(override).origin)) return override
  } catch { /* Reported below. */ }
  return { error: "This provider address can't be tested. Remove the custom address or ask your operator to allow it." }
}

/** Where the prompt goes and what it says, in the provider's own API. */
function buildCall(family: ProtocolFamily, catalog: CatalogProvider, settings: Settings, model: string): { url: string; body: Record<string, unknown>; headers?: Record<string, string> } | { error: string } {
  const encoded = encodeURIComponent(model)
  const vertex = family === "google_vertex" || family === "google_vertex_anthropic"
  const override = vertex ? null : operatorBaseUrl(settings)
  if (override !== null && typeof override === "object") return override
  // Same order as the gateway's own forwarding: operator override, catalog address, family default.
  const root = (fallback: string | null) => (override ?? fallback)?.replace(/\/+$/, "") ?? null
  const missing = { error: "This provider has no address to test." }
  const generateContent = { contents: [{ role: "user", parts: [{ text: TEST_PROMPT }] }], generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS } }
  switch (family) {
    case "anthropic":
    case "microsoft_foundry": {
      const url = root(family === "anthropic" ? catalog.api ?? defaultBaseUrl(family, settings) : defaultBaseUrl(family, settings))
      if (!url) return family === "microsoft_foundry" ? { error: "Enter the Foundry resource name." } : missing
      return { url: `${url}/messages`, body: messagesBody(model), headers: { "anthropic-version": "2023-06-01" } }
    }
    case "google_vertex_anthropic": {
      const url = vertexPublisherBase(settings, "anthropic")
      if (!url) return { error: "Enter the Google Cloud project and location." }
      const { model: _model, ...body } = messagesBody(model)
      return { url: `${url}/models/${encoded}:rawPredict`, body: { ...body, anthropic_version: "vertex-2023-10-16" } }
    }
    case "google": {
      const url = root(catalog.api ?? defaultBaseUrl(family, settings))
      return url ? { url: `${url}/models/${encoded}:generateContent`, body: generateContent } : missing
    }
    case "google_vertex": {
      const url = vertexPublisherBase(settings, "google")
      return url ? { url: `${url}/models/${encoded}:generateContent`, body: generateContent } : { error: "Enter the Google Cloud project and location." }
    }
    case "openai": {
      const url = root(catalog.api ?? defaultBaseUrl(family, settings))
      // The Responses API takes every current OpenAI model, reasoning ones included.
      return url ? { url: `${url}/responses`, body: { model, input: TEST_PROMPT, max_output_tokens: MAX_OUTPUT_TOKENS } } : missing
    }
    case "azure": {
      const url = root(defaultBaseUrl(family, settings))
      if (!url) return { error: "Enter the Azure resource name." }
      const { model: _model, ...body } = messagesBody(model)
      return { url: `${url}/deployments/${encoded}/chat/completions?api-version=${encodeURIComponent(settings.apiVersion || "2024-10-21")}`, body }
    }
    case "mistral":
    case "openai_compatible": {
      const url = root(catalog.api ?? defaultBaseUrl(family, settings))
      return url ? { url: `${url}/chat/completions`, body: messagesBody(model) } : missing
    }
    case "bedrock_mantle": {
      if (!isAwsRegion(settings.region)) return { error: "Enter an AWS region code such as us-east-1." }
      const url = root(`https://${bedrockMantleHost(settings.region)}${catalog.modelApiPaths?.get(model) ?? BEDROCK_MANTLE_DEFAULT_API_PATH}`)
      return { url: `${url}/chat/completions`, body: messagesBody(model) }
    }
    case "bedrock": {
      if (!isAwsRegion(settings.region)) return { error: "Enter an AWS region code such as us-east-1." }
      const url = root(`https://${bedrockRuntimeHost(settings.region)}`)
      return { url: `${url}/model/${encoded}/converse`, body: { messages: [{ role: "user", content: [{ text: TEST_PROMPT }] }], inferenceConfig: { maxTokens: MAX_OUTPUT_TOKENS } } }
    }
  }
}

function isAwsFamily(family: ProtocolFamily) {
  return family === "bedrock" || family === "bedrock_mantle"
}

async function readErrorMessage(response: Response, secrets: string[]) {
  try {
    const reader = response.body?.getReader()
    if (!reader) return null
    const chunks: Uint8Array[] = []
    let size = 0
    while (size < ERROR_BODY_LIMIT) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
    }
    await reader.cancel().catch(() => {})
    const text = new TextDecoder().decode(Buffer.concat(chunks).subarray(0, ERROR_BODY_LIMIT))
    let message: unknown = null
    try {
      const json: unknown = JSON.parse(text)
      const pending: unknown[] = [json]
      while (pending.length && typeof message !== "string") {
        const value = pending.shift()
        if (Array.isArray(value)) { pending.push(...value); continue }
        if (typeof value !== "object" || value === null) continue
        const candidate = Reflect.get(value, "message")
        if (typeof candidate === "string" && candidate.trim()) message = candidate
        else for (const child of Object.values(value)) if (typeof child === "object" && child !== null) pending.push(child)
      }
    } catch { /* Not JSON: no message to show. */ }
    if (typeof message !== "string") return null
    let safe = message.trim().slice(0, 300)
    // Never echo the key back, even partly masked by the provider.
    for (const secret of secrets) if (secret.length >= 8) safe = safe.split(secret).join("…")
    return safe.replace(/\b(sk|key|AKIA|ASIA)[-_A-Za-z0-9]{12,}\b/g, "…")
  } catch { return null }
}

function statusMessage(status: number, providerMessage: string | null, model: string) {
  const detail = providerMessage ? ` The provider said: ${providerMessage}` : ""
  if (status === 401) return { code: "provider_authentication_failed", message: "The provider rejected this key. Check that it's correct and still active." }
  if (status === 403) return { code: "provider_permission_denied", message: `The provider denied access with this key. Check its permissions and that ${model} is enabled for it.${detail}` }
  if (status === 404) return { code: "model_not_found", message: `The provider couldn't find ${model} for this key or account.${detail}` }
  if (status === 429) return { code: "rate_limited", message: `The provider accepted the key but is rate limiting it or it has no credit left.${detail}` }
  if (status >= 500) return { code: "upstream_error", message: `The provider had a problem answering (${status}). Try again in a moment.` }
  return { code: "upstream_rejected", message: `The provider rejected the test prompt (${status}).${detail}` }
}

export async function runProviderTest(input: TestRequest, dependencies: ProviderTestDependencies): Promise<GatewayProviderTestResult> {
  const { model } = input
  const catalog = dependencies.catalog.getCatalogProvider(input.providerId)
  const family = classifyProtocolFamily(catalog)
  if (!catalog || !family) return failed("unsupported_provider", "AI Gateway can't test this provider.", model)
  const credential = readCredential(input, catalog)
  if ("error" in credential) return failed("invalid_credential", credential.error, model)
  let auth: { kind: "header"; name: string; value: string } | { kind: "aws"; credentials: AwsCredentials; region: string }
  const secrets: string[] = []
  if (credential.kind === "gcp_service_account") {
    if (family !== "google_vertex" && family !== "google_vertex_anthropic") return failed("invalid_credential", "A service account key only works with Google Vertex AI.", model)
    // Each test signs in afresh; the cache key never matches a saved credential.
    const minted = await dependencies.mintGcpAccessToken({ credentialId: `provider-test:${crypto.randomUUID()}`, serviceAccount: credential.serviceAccount, now: dependencies.now() })
    if (minted.kind === "error") return failed("provider_authentication_failed", "Google rejected the service account key. Check that it's current and belongs to this project.", model)
    auth = { kind: "header", ...buildAuthHeader(family, minted.accessToken) }
  } else if (credential.kind === "aws_keys") {
    if (!isAwsFamily(family)) return failed("invalid_credential", "AWS keys only work with Amazon Bedrock.", model)
    const { accessKeyId, secretAccessKey, sessionToken } = credential.awsKeys
    const region = credential.awsKeys.region ?? input.settings.region
    if (!isAwsRegion(region)) return failed("invalid_settings", "Enter an AWS region code such as us-east-1.", model)
    secrets.push(secretAccessKey, accessKeyId, ...(sessionToken ? [sessionToken] : []))
    auth = { kind: "aws", credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }, region }
  } else {
    secrets.push(credential.secret)
    auth = { kind: "header", ...buildAuthHeader(family, credential.secret) }
  }

  const settings = auth.kind === "aws" ? { ...input.settings, region: auth.region } : input.settings
  const call = buildCall(family, catalog, settings, model)
  if ("error" in call) return failed("invalid_settings", call.error, model)
  let upstream: UpstreamCall
  try {
    const url = validateInferenceUrl(call.url)
    const headers = new Headers({ "content-type": "application/json", accept: "application/json", ...call.headers })
    upstream = { url, headers, body: JSON.stringify(call.body) }
  } catch { return failed("invalid_settings", "These settings don't make a valid provider address.", model) }
  if (auth.kind === "header") upstream.headers.set(auth.name, auth.value)
  else signAwsRequest({ method: "POST", url: upstream.url, headers: upstream.headers, body: upstream.body, credentials: auth.credentials, region: auth.region, service: family === "bedrock_mantle" ? bedrockMantleService : bedrockService, now: dependencies.now() })

  let response: Response
  try {
    response = await dependencies.fetch(upstream.url, { method: "POST", headers: upstream.headers, body: upstream.body, redirect: "error", signal: AbortSignal.timeout(TEST_TIMEOUT_MS) })
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
    return failed(timedOut ? "upstream_timeout" : "upstream_unreachable", timedOut ? "The provider didn't answer within 30 seconds." : "AI Gateway couldn't reach the provider. Check the settings above.", model)
  }
  if (response.ok) {
    await response.body?.cancel().catch(() => {})
    return { ok: true, model, status: response.status, code: null, message: null }
  }
  // AWS signature errors can echo the canonical request, including the session token.
  const providerMessage = isAwsFamily(family) ? null : await readErrorMessage(response, secrets)
  if (isAwsFamily(family)) await response.body?.cancel().catch(() => {})
  const { code, message } = statusMessage(response.status, providerMessage, model)
  return failed(code, message, model, response.status)
}

export type ProviderTestEnv = { Variables: InferenceAuthVariables & OrganizationVariables }

export function registerProviderTestRoute(api: Hono<ProviderTestEnv>, dependencies: ProviderTestDependencies) {
  api.post(gatewayProviderTestPath, async (c: Context<ProviderTestEnv>) => {
    c.header("cache-control", "no-store")
    const identity = c.get("inference")
    if (identity.kind !== "gateway") return c.json({ error: { code: "invalid_api_key", message: "An OpenWork Gateway key is required." } }, 401)
    // Only Den, after checking that this member may manage providers, can ask for a test.
    const body = await c.req.text()
    const signature = c.req.header(PROVIDER_TEST_SIGNATURE_HEADER)
    if (!dependencies.signingSecret || !signature || !verifyProviderTestSignature(dependencies.signingSecret, { organizationId: identity.organizationId, memberId: identity.orgMembershipId, body }, signature, dependencies.now().getTime())) {
      return c.json({ error: { code: "provider_test_not_authorized", message: "Provider tests are started from AI Gateway in OpenWork." } }, 403)
    }
    let json: unknown
    try { json = JSON.parse(body) } catch { return c.json({ error: { code: "invalid_json", message: "The request body must be JSON." } }, 400) }
    const parsed = requestSchema.safeParse(json)
    if (!parsed.success) return c.json({ error: { code: "invalid_request", message: "Send providerId, model, settings and an organization credential." } }, 400)
    return c.json(await runProviderTest(parsed.data, dependencies))
  })
}
