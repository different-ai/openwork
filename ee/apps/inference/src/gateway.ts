// Org provider gateway: `ANY /api/v1/providers/:inferenceProviderId/*`
// (plan §5.2). Forwards the desktop's native provider request to the org's
// configured upstream with the org/member credential, logging one row per
// request. Never translates protocols and never returns raw credentials.
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { InferenceProviderTable } from "@openwork-ee/den-db"
import { isDenTypeId } from "@openwork-ee/utils/typeid"
import type { InferenceRequestOutcome, InferenceRequestProtocol } from "@openwork/types/den/inference"
import type { Context, Hono } from "hono"
import { sanitizeIncomingHeaders } from "./inference-reporting.js"
import type { InferenceReporter } from "./inference-reporting.js"
import type { InferenceAuthVariables } from "./middleware/inference-auth.js"
import type { OrganizationVariables } from "./middleware/org-context.js"
import { bedrockRuntimeHost, bedrockService, signAwsRequest } from "./credentials/aws-sigv4.js"
import { createGcpServiceAccountTokenMinter } from "./credentials/gcp-service-account.js"
import type { MintGcpAccessToken } from "./credentials/gcp-service-account.js"
import { createDbGoogleOauthRefreshStore, createGoogleOauthRefresher } from "./credentials/google-oauth-refresh.js"
import type { RefreshGoogleOauthToken } from "./credentials/google-oauth-refresh.js"
import {
  buildAuthHeader,
  classifyProtocolFamily,
  classifyRequestProtocol,
  defaultBaseUrl,
  filterQuery,
  isAllowedRequestHeader,
  parseBedrockModelPath,
  parseGoogleModelPath,
  stripApiVersionPrefix,
  vertexPublisherBase,
} from "./protocols.js"
import type { AuthHeader, ProtocolFamily } from "./protocols.js"
import { hasProviderAccessFromDb } from "./provider-access.js"
import type { HasProviderAccess } from "./provider-access.js"
import { loadProviderCatalogFromFile } from "./provider-catalog.js"
import type { CatalogProvider, ProviderCatalog } from "./provider-catalog.js"
import { loadProviderCredentialFromDb, resolveUpstreamCredential } from "./provider-credentials.js"
import type { GatewayCredential, GatewayProvider, LoadProviderCredential, ResolvedUpstreamCredential } from "./provider-credentials.js"
import { buildRequestId, isEventStreamContentType, isJsonContentType, trackStream } from "./relay.js"
import { createRequestLogRecorder } from "./request-log.js"
import type { InsertRequestLog, RequestLogRecorder } from "./request-log.js"
import { createAnthropicMessagesSseUsageParser, parseAnthropicMessagesJsonUsage } from "./usage/anthropic-messages.js"
import {
  createBedrockConverseEventStreamUsageParser,
  isAwsEventStreamContentType,
  parseBedrockConverseJsonUsage,
} from "./usage/bedrock-converse.js"
import {
  createGoogleGenerateContentSseUsageParser,
  parseGoogleGenerateContentJsonUsage,
} from "./usage/google-generate-content.js"
import { createOpenAiChatSseUsageParser, parseOpenAiChatJsonUsage } from "./usage/openai-chat.js"
import { createOpenAiResponsesSseUsageParser, parseOpenAiResponsesJsonUsage } from "./usage/openai-responses.js"
import { createJsonBodyUsageParser, emptyUsage } from "./usage/shared.js"
import type { ParsedUsage, UsageParser } from "./usage/shared.js"

export type { GatewayCredential, GatewayProvider } from "./provider-credentials.js"

type GatewayEnv = { Variables: InferenceAuthVariables & OrganizationVariables }
type JsonObject = Record<string, unknown>

export type LoadInferenceProvider = (input: {
  inferenceProviderId: string
  organizationId: string
}) => Promise<GatewayProvider | null>

export type GatewayDependencies = {
  fetch: typeof fetch
  insertRequestLog: InsertRequestLog
  reporter: InferenceReporter
  loadInferenceProvider: LoadInferenceProvider
  hasProviderAccess: HasProviderAccess
  loadProviderCredential: LoadProviderCredential
  refreshGoogleOauthToken: RefreshGoogleOauthToken
  mintGcpAccessToken: MintGcpAccessToken
  catalog: ProviderCatalog
  now: () => Date
}

export type GatewayRouteDependencies =
  Pick<GatewayDependencies, "fetch" | "insertRequestLog" | "reporter">
  & Partial<GatewayDependencies>

type ResolvedUpstream = {
  family: ProtocolFamily
  protocol: InferenceRequestProtocol
  url: URL
}

type PreparedRequest = {
  body: string | null
  requestedModel: string | null
  stream: boolean
  url: URL
}

type UsableCredential = Extract<ResolvedUpstreamCredential, { kind: "secret" | "aws_keys" }>

// Static header auth, or a signer that must run on the final request (SigV4
// hashes the body, so it follows every body rewrite).
type UpstreamAuth =
  | { kind: "header"; header: AuthHeader }
  | { kind: "signer"; host: string; sign: (request: { method: string; url: URL; headers: Headers; body: string | null }) => void }

export const gatewayPathPrefix = "/api/v1/providers"

const droppedResponseHeaders = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"])
const bodylessMethods = new Set(["GET", "HEAD", "OPTIONS"])
const vertexAnthropicVersion = "vertex-2023-10-16"

export const loadInferenceProviderFromDb: LoadInferenceProvider = async (input) => {
  if (!isDenTypeId("inferenceProvider", input.inferenceProviderId) || !isDenTypeId("organization", input.organizationId)) {
    return null
  }
  const { db } = await import("./db.js")
  const [row] = await db
    .select({
      id: InferenceProviderTable.id,
      organization_id: InferenceProviderTable.organization_id,
      provider_id: InferenceProviderTable.provider_id,
      provider_config: InferenceProviderTable.provider_config,
      settings: InferenceProviderTable.settings,
      credential_mode: InferenceProviderTable.credential_mode,
      status: InferenceProviderTable.status,
      oauth_client_id: InferenceProviderTable.oauth_client_id,
      oauth_client_secret: InferenceProviderTable.oauth_client_secret,
    })
    .from(InferenceProviderTable)
    .where(and(
      eq(InferenceProviderTable.id, input.inferenceProviderId),
      eq(InferenceProviderTable.organization_id, input.organizationId),
      eq(InferenceProviderTable.status, "active"),
    ))
    .limit(1)
  return row ?? null
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function gatewayError(status: number, code: string, message: string, extra: JsonObject = {}) {
  return Response.json({ error: { message, type: status >= 500 ? "api_error" : "invalid_request_error", code, ...extra } }, { status })
}

function readBaseUrl(provider: GatewayProvider, catalog: CatalogProvider | null, family: ProtocolFamily) {
  // Org-configured override (regional host / compatible self-hosted endpoint,
  // plan §4.1). den-api validates it as a clean http(s) URL at write time.
  const override = provider.settings.upstreamBaseUrl
  if (typeof override === "string" && override) return override
  const config = provider.provider_config
  const options = isJsonObject(config.options) ? config.options : null
  if (options && typeof options.baseURL === "string" && options.baseURL) return options.baseURL
  if (typeof config.api === "string" && config.api) return config.api
  if (catalog?.api) return catalog.api
  return defaultBaseUrl(family, provider.settings)
}

function upstreamBase(provider: GatewayProvider, catalog: CatalogProvider | null, family: ProtocolFamily) {
  if (family === "google_vertex") return vertexPublisherBase(provider.settings, "google")
  if (family === "google_vertex_anthropic") return vertexPublisherBase(provider.settings, "anthropic")
  return readBaseUrl(provider, catalog, family)
}

function resolveUpstream(provider: GatewayProvider, catalog: CatalogProvider | null, rest: string, search: string): ResolvedUpstream | { error: string } {
  const family = classifyProtocolFamily(catalog)
  if (!family) return { error: `Provider ${provider.provider_id} has no supported SDK protocol in the models.dev catalog.` }
  const base = upstreamBase(provider, catalog, family)
  if (!base) {
    return {
      error: family === "google_vertex" || family === "google_vertex_anthropic"
        ? "Vertex providers require settings.project and settings.location."
        : `Provider ${provider.provider_id} has no upstream base URL.`,
    }
  }
  const forwardedRest = family === "google_vertex" || family === "google_vertex_anthropic" ? stripApiVersionPrefix(rest) : rest
  const protocol = classifyRequestProtocol(family, forwardedRest)
  let url: URL
  try {
    url = new URL(`${base.replace(/\/+$/, "")}${forwardedRest ? `/${forwardedRest}` : ""}${filterQuery(family, search)}`)
  } catch {
    return { error: `Provider ${provider.provider_id} has an invalid upstream base URL.` }
  }
  return { family, protocol, url }
}

function requestedModelFromPath(protocol: InferenceRequestProtocol, pathname: string) {
  if (protocol === "google_generate_content") return parseGoogleModelPath(pathname)?.model ?? null
  if (protocol === "bedrock_converse") return parseBedrockModelPath(pathname)?.model ?? null
  return null
}

function isStreamingPath(protocol: InferenceRequestProtocol, pathname: string) {
  if (protocol === "google_generate_content") return parseGoogleModelPath(pathname)?.operation === "streamGenerateContent"
  if (protocol === "bedrock_converse") return parseBedrockModelPath(pathname)?.stream === true
  return false
}

function materializeAuth(credential: UsableCredential, provider: GatewayProvider, family: ProtocolFamily, now: Date): UpstreamAuth | { error: string } {
  if (family !== "bedrock") {
    if (credential.kind === "aws_keys") return { error: `AWS credentials are only supported for Amazon Bedrock providers, not ${provider.provider_id}.` }
    return { kind: "header", header: buildAuthHeader(family, credential.secret) }
  }
  const settingsRegion = typeof provider.settings.region === "string" && provider.settings.region ? provider.settings.region : null
  const region = (credential.kind === "aws_keys" ? credential.awsKeys.region : undefined) ?? settingsRegion
  if (!region) return { error: "Bedrock providers require a region on the AWS credential or settings.region." }
  // A static key (Bedrock API key) keeps the settings.region host resolved earlier.
  if (credential.kind === "secret") return { kind: "header", header: buildAuthHeader(family, credential.secret) }
  const credentials = credential.awsKeys
  return {
    kind: "signer",
    host: bedrockRuntimeHost(region),
    sign(request) {
      signAwsRequest({ ...request, credentials, region, service: bedrockService, now })
    },
  }
}

async function prepareRequest(request: Request, upstream: ResolvedUpstream): Promise<PreparedRequest | { error: Response; errorCode: string }> {
  const url = new URL(upstream.url)
  const pathModel = requestedModelFromPath(upstream.protocol, url.pathname)
  if (bodylessMethods.has(request.method)) {
    return { body: null, requestedModel: pathModel, stream: isStreamingPath(upstream.protocol, url.pathname), url }
  }

  const text = await request.text()
  let json: unknown = null
  if (isJsonContentType(request.headers.get("content-type"))) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  if (!isJsonObject(json)) {
    return { body: text, requestedModel: pathModel, stream: isStreamingPath(upstream.protocol, url.pathname), url }
  }

  const requestedModel = typeof json.model === "string" ? json.model : pathModel
  const stream = json.stream === true || isStreamingPath(upstream.protocol, url.pathname)
  let modified = false

  if (upstream.protocol === "openai_chat" && json.stream === true) {
    json.stream_options = { ...(isJsonObject(json.stream_options) ? json.stream_options : {}), include_usage: true }
    modified = true
  }

  if (upstream.family === "google_vertex_anthropic" && upstream.protocol === "anthropic_messages") {
    if (!requestedModel) {
      return { error: gatewayError(400, "model_required", "JSON request body must include a string model."), errorCode: "model_required" }
    }
    delete json.model
    json.anthropic_version = vertexAnthropicVersion
    modified = true
    url.pathname = url.pathname.replace(/\/messages$/, `/models/${requestedModel}:${stream ? "streamRawPredict" : "rawPredict"}`)
  }

  return { body: modified ? JSON.stringify(json) : text, requestedModel, stream, url }
}

function buildUpstreamHeaders(request: Request, family: ProtocolFamily, openworkRequestId: string) {
  const headers = new Headers()
  request.headers.forEach((value, name) => {
    if (isAllowedRequestHeader(family, name)) headers.set(name, value)
  })
  headers.set("x-openwork-request-id", openworkRequestId)
  return headers
}

function relayHeaders(upstream: Response, openworkRequestId: string) {
  const headers = new Headers()
  upstream.headers.forEach((value, name) => {
    if (!droppedResponseHeaders.has(name.toLowerCase())) headers.append(name, value)
  })
  headers.set("x-openwork-request-id", openworkRequestId)
  return headers
}

function upstreamRequestId(headers: Headers) {
  return headers.get("x-request-id") ?? headers.get("request-id") ?? headers.get("x-goog-request-id")
}

function upstreamOutcome(upstream: Response): InferenceRequestOutcome {
  return upstream.ok ? "ok" : "upstream_error"
}

function parseJsonUsage(protocol: InferenceRequestProtocol, body: unknown): ParsedUsage | null {
  switch (protocol) {
    case "openai_chat":
      return parseOpenAiChatJsonUsage(body)
    case "openai_responses":
      return parseOpenAiResponsesJsonUsage(body)
    case "anthropic_messages":
      return parseAnthropicMessagesJsonUsage(body)
    case "google_generate_content":
      return parseGoogleGenerateContentJsonUsage(body)
    case "bedrock_converse":
      return parseBedrockConverseJsonUsage(body)
    case "passthrough":
      return null
  }
}

function createStreamUsageParser(protocol: InferenceRequestProtocol, contentType: string | null): UsageParser | null {
  if (protocol === "bedrock_converse") {
    return isAwsEventStreamContentType(contentType) ? createBedrockConverseEventStreamUsageParser() : null
  }
  if (isEventStreamContentType(contentType)) {
    switch (protocol) {
      case "openai_chat":
        return createOpenAiChatSseUsageParser()
      case "openai_responses":
        return createOpenAiResponsesSseUsageParser()
      case "anthropic_messages":
        return createAnthropicMessagesSseUsageParser()
      case "google_generate_content":
        return createGoogleGenerateContentSseUsageParser()
      case "passthrough":
        return null
    }
  }
  if (isJsonContentType(contentType) && parseJsonUsage(protocol, null)) {
    // Streamed non-SSE JSON (Google's array form): parse once at the end.
    return createJsonBodyUsageParser((body) => parseJsonUsage(protocol, body) ?? emptyUsage())
  }
  return null
}

function recordUsage(recorder: RequestLogRecorder, usage: ParsedUsage, source: "stream" | "json") {
  recorder.setUsage({
    usageSource: usage.found ? source : "missing",
    upstreamModel: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens ?? null,
    reasoningTokens: usage.reasoningTokens,
    costUsd: usage.costUsd ?? null,
  })
}

async function relayJsonResponse(upstream: Response, protocol: InferenceRequestProtocol, headers: Headers, recorder: RequestLogRecorder) {
  const text = await upstream.text()
  recorder.markFirstByte()
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  const usage = parseJsonUsage(protocol, body)
  if (usage) recordUsage(recorder, usage, "json")
  void recorder.finish({
    status: upstream.status,
    outcome: upstreamOutcome(upstream),
    upstreamRequestId: upstreamRequestId(upstream.headers),
    responseBytes: Buffer.byteLength(text),
  })
  return new Response(text, { status: upstream.status, statusText: upstream.statusText, headers })
}

function relayStreamResponse(upstream: Response, protocol: InferenceRequestProtocol, headers: Headers, recorder: RequestLogRecorder) {
  if (!upstream.body) {
    void recorder.finish({
      status: upstream.status,
      outcome: upstreamOutcome(upstream),
      upstreamRequestId: upstreamRequestId(upstream.headers),
      responseBytes: 0,
    })
    return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers })
  }

  const parser = createStreamUsageParser(protocol, upstream.headers.get("content-type"))
  const decoder = new TextDecoder()
  let responseBytes = 0
  const finish = (outcome: InferenceRequestOutcome) => {
    if (parser) recordUsage(recorder, parser.result(), "stream")
    void recorder.finish({
      status: upstream.status,
      outcome,
      upstreamRequestId: upstreamRequestId(upstream.headers),
      responseBytes,
    })
  }
  const body = trackStream(upstream.body, {
    chunk(value) {
      recorder.markFirstByte()
      responseBytes += value.byteLength
      if (parser?.pushBytes) parser.pushBytes(value)
      else if (parser) parser.push(decoder.decode(value, { stream: true }))
    },
    done() {
      finish(upstreamOutcome(upstream))
    },
    fail() {
      finish("client_aborted")
    },
  })
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers })
}

function refreshGoogleOauthTokenWithDb(fetchImpl: typeof fetch): RefreshGoogleOauthToken {
  let refresher: Promise<RefreshGoogleOauthToken> | null = null
  return (input) => {
    refresher ??= import("./db.js").then(({ db }) => createGoogleOauthRefresher({ fetch: fetchImpl, store: createDbGoogleOauthRefreshStore(db) }))
    return refresher.then((refresh) => refresh(input))
  }
}

function restOfPath(pathname: string, inferenceProviderId: string) {
  const prefix = `${gatewayPathPrefix}/${inferenceProviderId}`
  return pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length + 1) : ""
}

export function registerGatewayRoutes(api: Hono<GatewayEnv>, input: GatewayRouteDependencies) {
  const dependencies: GatewayDependencies = {
    fetch: input.fetch,
    insertRequestLog: input.insertRequestLog,
    reporter: input.reporter,
    loadInferenceProvider: input.loadInferenceProvider ?? loadInferenceProviderFromDb,
    hasProviderAccess: input.hasProviderAccess ?? hasProviderAccessFromDb,
    loadProviderCredential: input.loadProviderCredential ?? loadProviderCredentialFromDb,
    refreshGoogleOauthToken: input.refreshGoogleOauthToken ?? refreshGoogleOauthTokenWithDb(input.fetch),
    mintGcpAccessToken: input.mintGcpAccessToken ?? createGcpServiceAccountTokenMinter({ fetch: input.fetch }),
    catalog: input.catalog ?? loadProviderCatalogFromFile(),
    now: input.now ?? (() => new Date()),
  }

  async function handleGatewayRequest(c: Context<GatewayEnv>) {
    const identity = c.get("inference")
    const inferenceProviderId = c.req.param("inferenceProviderId")
    if (!inferenceProviderId) {
      return gatewayError(404, "provider_not_found", "Missing inference provider id.")
    }
    const requestUrl = new URL(c.req.url)
    const openworkRequestId = buildRequestId()
    const startedAt = dependencies.now()
    const method = c.req.method
    const incomingHeaders = sanitizeIncomingHeaders(c.req.raw.headers)

    const provider = await dependencies.loadInferenceProvider({ inferenceProviderId, organizationId: identity.organizationId })
    if (!provider) {
      return gatewayError(404, "provider_not_found", `Unknown inference provider: ${inferenceProviderId}.`)
    }

    const catalog = dependencies.catalog.getCatalogProvider(provider.provider_id)
    const rest = restOfPath(requestUrl.pathname, inferenceProviderId)
    const resolved = resolveUpstream(provider, catalog, rest, requestUrl.search)
    const recorder = createRequestLogRecorder({ insertRequestLog: dependencies.insertRequestLog, reporter: dependencies.reporter, now: dependencies.now })
    const startRecorder = (state: {
      protocol: InferenceRequestProtocol
      url: URL | null
      requestedModel: string | null
      stream: boolean
      credentialId?: GatewayCredential["id"] | null
      requestBytes?: number | null
    }) => {
      recorder.start({
        identity,
        openworkRequestId,
        route: "org_provider",
        protocol: state.protocol,
        upstreamProviderId: provider.provider_id,
        upstreamHost: state.url?.hostname ?? "",
        upstreamPath: state.url?.pathname ?? `/${rest}`,
        method,
        requestedModel: state.requestedModel,
        upstreamModel: null,
        stream: state.stream,
        inferenceProviderId: provider.id,
        inferenceProviderCredentialId: state.credentialId ?? null,
        requestBytes: state.requestBytes,
        startedAt,
      })
    }
    const reject = (response: Response, errorCode: string, reason: string) => {
      console.error(`[inference-gateway] ${reason}`, {
        openworkRequestId,
        organizationId: identity.organizationId,
        orgMembershipId: identity.orgMembershipId,
        inferenceProviderId: provider.id,
        upstreamProviderId: provider.provider_id,
        status: response.status,
      })
      dependencies.reporter.handledError({
        reason: errorCode,
        organizationId: identity.organizationId,
        orgMembershipId: identity.orgMembershipId,
        inferenceKeyId: identity.inferenceKeyId,
        openworkRequestId,
        route: c.req.path,
        method,
        headers: incomingHeaders,
        status: response.status,
      })
      void recorder.finish({ status: response.status, outcome: "rejected", errorCode })
      response.headers.set("x-openwork-request-id", openworkRequestId)
      return response
    }

    if ("error" in resolved) {
      startRecorder({ protocol: "passthrough", url: null, requestedModel: null, stream: false })
      return reject(gatewayError(502, "provider_misconfigured", resolved.error), "provider_misconfigured", "Misconfigured inference provider")
    }

    const allowed = await dependencies.hasProviderAccess({ inferenceProviderId: provider.id, orgMembershipId: identity.orgMembershipId })
    if (!allowed) {
      startRecorder({ protocol: resolved.protocol, url: resolved.url, requestedModel: null, stream: false })
      return reject(
        gatewayError(403, "provider_access_denied", "You do not have access to this inference provider.", { provider_id: provider.id }),
        "provider_access_denied",
        "Inference provider access denied",
      )
    }

    const credential = await resolveUpstreamCredential({
      provider,
      orgMembershipId: identity.orgMembershipId,
      envNames: catalog?.env ?? [],
      loadProviderCredential: dependencies.loadProviderCredential,
      refreshGoogleOauthToken: dependencies.refreshGoogleOauthToken,
      mintGcpAccessToken: dependencies.mintGcpAccessToken,
      now: startedAt,
    })
    if (credential.kind !== "secret" && credential.kind !== "aws_keys") {
      startRecorder({
        protocol: resolved.protocol,
        url: resolved.url,
        requestedModel: null,
        stream: false,
        credentialId: "credentialId" in credential ? credential.credentialId : null,
      })
      switch (credential.kind) {
        case "auth_required": {
          const response = gatewayError(
            401,
            "openwork_auth_required",
            `Connect your ${provider.provider_id} account in OpenWork to use this provider (${credential.reason === "missing" ? "no credential" : `credential ${credential.reason}`}).`,
            { provider_id: provider.id },
          )
          response.headers.set("x-openwork-auth-required", "1")
          return reject(response, "member_auth_required", "Member credential required")
        }
        case "org_credential_missing":
          return reject(
            gatewayError(502, "provider_credential_missing", "No active credential is configured for this inference provider.", { provider_id: provider.id }),
            "provider_credential_missing",
            "Missing org credential",
          )
        case "org_credential_expired":
          return reject(
            gatewayError(502, "provider_credential_expired", "The organization credential for this inference provider has expired.", { provider_id: provider.id }),
            "provider_credential_expired",
            "Expired org credential",
          )
        case "invalid_secret":
          return reject(
            gatewayError(502, "provider_credential_invalid", `The credential for this inference provider is malformed: ${credential.message}`, { provider_id: provider.id }),
            "provider_credential_invalid",
            "Invalid org credential",
          )
        case "token_mint_failed":
          return reject(
            gatewayError(502, "provider_token_mint_failed", `Could not mint an upstream token for this inference provider: ${credential.message}`, { provider_id: provider.id }),
            "provider_token_mint_failed",
            "Upstream token minting failed",
          )
      }
    }

    const auth = materializeAuth(credential, provider, resolved.family, startedAt)
    if ("error" in auth) {
      startRecorder({ protocol: resolved.protocol, url: resolved.url, requestedModel: null, stream: false, credentialId: credential.credentialId })
      return reject(gatewayError(502, "provider_misconfigured", auth.error, { provider_id: provider.id }), "provider_misconfigured", "Misconfigured inference provider")
    }

    const prepared = await prepareRequest(c.req.raw, resolved)
    if ("error" in prepared) {
      startRecorder({ protocol: resolved.protocol, url: resolved.url, requestedModel: null, stream: false, credentialId: credential.credentialId })
      return reject(prepared.error, prepared.errorCode, "Invalid gateway request body")
    }
    if (auth.kind === "signer") prepared.url.host = auth.host
    startRecorder({
      protocol: resolved.protocol,
      url: prepared.url,
      requestedModel: prepared.requestedModel,
      stream: prepared.stream,
      credentialId: credential.credentialId,
      requestBytes: prepared.body === null ? null : Buffer.byteLength(prepared.body),
    })

    const headers = buildUpstreamHeaders(c.req.raw, resolved.family, openworkRequestId)
    if (auth.kind === "header") headers.set(auth.header.name, auth.header.value)
    else auth.sign({ method, url: prepared.url, headers, body: prepared.body })

    let upstream: Response
    try {
      upstream = await dependencies.fetch(prepared.url, { method, headers, body: prepared.body })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("[inference-gateway] Failed to reach provider upstream", {
        openworkRequestId,
        organizationId: identity.organizationId,
        inferenceProviderId: provider.id,
        upstreamUrl: `${prepared.url.origin}${prepared.url.pathname}`,
        error: message,
      })
      dependencies.reporter.handledError({
        reason: "upstream_unreachable",
        organizationId: identity.organizationId,
        orgMembershipId: identity.orgMembershipId,
        inferenceKeyId: identity.inferenceKeyId,
        openworkRequestId,
        route: c.req.path,
        method,
        headers: incomingHeaders,
        incomingModel: prepared.requestedModel,
        status: 502,
        upstreamUrl: `${prepared.url.origin}${prepared.url.pathname}`,
        error: message,
        exception: error,
      })
      void recorder.finish({ status: 502, outcome: "upstream_unreachable", errorCode: "upstream_unreachable" })
      const response = gatewayError(502, "upstream_unreachable", "Failed to reach the inference provider upstream.", { provider_id: provider.id })
      response.headers.set("x-openwork-request-id", openworkRequestId)
      return response
    }

    if (!upstream.ok) {
      console.error("[inference-gateway] Upstream provider request failed", {
        openworkRequestId,
        organizationId: identity.organizationId,
        inferenceProviderId: provider.id,
        upstreamProviderId: provider.provider_id,
        upstreamUrl: `${prepared.url.origin}${prepared.url.pathname}`,
        status: upstream.status,
      })
    }

    const responseHeaders = relayHeaders(upstream, openworkRequestId)
    if (!prepared.stream && isJsonContentType(upstream.headers.get("content-type"))) {
      return relayJsonResponse(upstream, resolved.protocol, responseHeaders, recorder)
    }
    return relayStreamResponse(upstream, resolved.protocol, responseHeaders, recorder)
  }

  api.all(`${gatewayPathPrefix}/:inferenceProviderId`, handleGatewayRequest)
  api.all(`${gatewayPathPrefix}/:inferenceProviderId/*`, handleGatewayRequest)
}
