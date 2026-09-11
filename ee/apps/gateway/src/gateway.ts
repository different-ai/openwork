// Org provider gateway: model-granted POST invocations and local GET models.
// (plan §5.2). Forwards the desktop's native provider request to the org's
// configured upstream with the org/member credential, logging one row per
// request. Never translates protocols and never returns raw credentials.
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { GatewayProviderTable } from "@openwork-ee/den-db"
import { isDenTypeId } from "@openwork-ee/utils/typeid"
import { validateInferenceUrl } from "@openwork-ee/utils/inference-egress"
import { GATEWAY_GRANT_HEADER, type GatewayRequestOutcome, type GatewayRequestProtocol } from "@openwork/types/den/gateway"
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
import { accessibleGatewayModels, loadGatewayAccessFromDb, sameGatewaySelection, selectGatewayGrant } from "./provider-access.js"
import type { GatewayGrantSelection, LoadGatewayAccess } from "./provider-access.js"
import { hasAlternateModelSelection } from "./model-selection.js"
import { loadProviderCatalogFromFile } from "./provider-catalog.js"
import type { CatalogProvider, ProviderCatalog } from "./provider-catalog.js"
import { loadProviderCredentialFromDb, resolveUpstreamCredential } from "./provider-credentials.js"
import type { GatewayCredential, GatewayProvider, LoadProviderCredential, ResolvedUpstreamCredential } from "./provider-credentials.js"
import { isEventStreamContentType, isJsonContentType, trackStream, readBoundedBody, RequestBodyLimitError, upstreamLifetime } from "./relay.js"
import { env } from "./env.js"
import { createRequestLogRecorder } from "./request-log.js"
import type { InsertRequestLog, RequestLogRecorder, RequestLogRecorderDependencies } from "./request-log.js"
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

export type LoadGatewayProvider = (input: {
  inferenceProviderId: string
  organizationId: string
}) => Promise<GatewayProvider | null>

export type GatewayDependencies = {
  fetch: typeof fetch
  insertRequestLog: InsertRequestLog
  updateRequestLog?: RequestLogRecorderDependencies["updateRequestLog"]
  reporter: InferenceReporter
  loadGatewayProvider: LoadGatewayProvider
  loadGatewayAccess: LoadGatewayAccess
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
  protocol: GatewayRequestProtocol
  url: URL
}

type PreparedRequest = {
  body: string | Uint8Array<ArrayBuffer> | null
  requestedModel: string | null
  stream: boolean
  url: URL
  json: JsonObject | null
  pathModel: string | null
}

type UsableCredential = Extract<ResolvedUpstreamCredential, { kind: "secret" | "aws_keys" }>

// Static header auth, or a signer that must run on the final request (SigV4
// hashes the body, so it follows every body rewrite).
type UpstreamAuth =
  | { kind: "header"; header: AuthHeader }
  | { kind: "signer"; host: string; sign: (request: { method: string; url: URL; headers: Headers; body: string | Uint8Array<ArrayBuffer> | null }) => void }

export const gatewayPathPrefix = "/api/v1/providers"

const droppedResponseHeaders = new Set(["content-length", "transfer-encoding", "connection"])
const vertexAnthropicVersion = "vertex-2023-10-16"

export const loadGatewayProviderFromDb: LoadGatewayProvider = async (input) => {
  if (!isDenTypeId("inferenceProvider", input.inferenceProviderId) || !isDenTypeId("organization", input.organizationId)) {
    return null
  }
  const { db } = await import("./db.js")
  const [row] = await db
    .select({
      id: GatewayProviderTable.id,
      organization_id: GatewayProviderTable.organization_id,
      provider_id: GatewayProviderTable.provider_id,
      provider_config: GatewayProviderTable.provider_config,
      settings: GatewayProviderTable.settings,
      status: GatewayProviderTable.status,
    })
    .from(GatewayProviderTable)
    .where(and(
      eq(GatewayProviderTable.id, input.inferenceProviderId),
      eq(GatewayProviderTable.organization_id, input.organizationId),
      eq(GatewayProviderTable.status, "active"),
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
  // Revalidate persisted overrides at runtime; self-hosted origins require an
  // explicit operator allowlist even when den-api accepted the configuration.
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
  // Check before URL normalization can move an operation to another path.
  if (rest.includes("\\") || rest.split("/").some((part) => /^(?:\.|%2e){1,2}$/i.test(part))) return { error: "Invalid upstream path." }
  const protocol = classifyRequestProtocol(family, forwardedRest)
  let url: URL
  try {
    validateInferenceUrl(base, { base: true })
    url = new URL(`${base.replace(/\/+$/, "")}${forwardedRest ? `/${forwardedRest}` : ""}${filterQuery(family, search)}`)
    validateInferenceUrl(url)
    if (url.origin !== new URL(base).origin) return { error: "Invalid upstream origin." }
  } catch {
    return { error: `Provider ${provider.provider_id} has an invalid upstream base URL.` }
  }
  return { family, protocol, url }
}

function requestedModelFromPath(pathname: string) {
  const match = /\/(?:models|model|deployments)\/([^/]+?)(?::[a-zA-Z]+|\/[^/].*)?$/.exec(pathname)
  return match ? decodeURIComponent(match[1]) : null
}

function isStreamingPath(protocol: GatewayRequestProtocol, pathname: string) {
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
  if (!region || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)) return { error: "Bedrock providers require a valid AWS region." }
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

function unsupportedGatewayPayload(body: JsonObject, family: ProtocolFamily, providerId: string): "resource" | "model" | null {
  // Grants cover models, not ownership of provider-side state. Walk protocol
  // envelopes, never interpret user text or client function schemas/arguments.
  const pending: unknown[] = [body]
  const resourceFields = new Set([
    "previousresponseid", "responseid", "conversation", "conversationid", "threadid", "assistantid",
    "fileid", "fileids", "fileuri", "fileurl", "vectorstoreid", "vectorstoreids", "container", "containerid",
    "cachedcontent", "cachename", "s3location", "s3uri", "gcsuri", "toolresources", "datasources",
    "mcpservers", "connectorid", "promptarn", "sessionid", "guardrailidentifier",
  ])
  while (pending.length) {
    const value = pending.pop()
    if (Array.isArray(value)) { for (const item of value) pending.push(item); continue }
    if (!isJsonObject(value)) continue
    if ((value !== body && Object.hasOwn(value, "model")) || hasAlternateModelSelection(value, providerId)) return "model"
    if (value.type === "item_reference") return "resource"
    for (const [key, child] of Object.entries(value)) {
      if (value !== body && ((value.type === "tool_use" && key === "input" && ["anthropic", "google_vertex_anthropic", "bedrock"].includes(family)) || (value.type === "function_call" && key === "arguments"))) continue
      if (resourceFields.has(key.replace(/_/g, "").toLowerCase())) return "resource"
      if (key === "prompt" && isJsonObject(child)) return "resource" // Saved OpenAI prompt templates.
      if (key === "audio" && isJsonObject(child) && Object.hasOwn(child, "id")) return "resource"
      if (key === "input" && Array.isArray(child) && child.some((item) => isJsonObject(item) && Object.hasOwn(item, "id")
        && !(item.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string" && typeof item.arguments === "string"))) return "resource"
      if (key === "tool_choice" && isJsonObject(child) && (typeof child.type !== "string" || !["auto", "none", "required", "any", "tool", "function", "custom", "allowed_tools"].includes(child.type))) return "resource"
      if (key === "tools") {
        if (!Array.isArray(child)) return "resource"
        for (const tool of child) {
          if (!isJsonObject(tool)) return "resource"
          switch (family) {
            case "google":
            case "google_vertex":
              if (!Object.keys(tool).every((name) => name === "functionDeclarations" || name === "function_declarations")) return "resource"
              break
            case "bedrock":
              if (isJsonObject(tool.toolSpec) && Object.keys(tool).every((name) => name === "toolSpec")) break
              // Bedrock InvokeModel also accepts Anthropic's native client tools.
            case "anthropic":
            case "google_vertex_anthropic":
              if (tool.type !== undefined && tool.type !== "custom") return "resource"
              if (typeof tool.name !== "string" || !isJsonObject(tool.input_schema)) return "resource"
              break
            default:
              if (tool.type !== "function" && tool.type !== "custom") return "resource"
          }
        }
        continue
      }
      if (key === "functionResponse" || key === "function_response") {
        // Function result JSON is client data, but multimodal result parts can
        // still ask Google to read a provider-owned file.
        if (isJsonObject(child)) pending.push(child.parts)
        continue
      }
      if ([
        "metadata", "schema", "input_schema", "output_schema", "response_format",
        "responseSchema", "response_schema", "responseJsonSchema", "response_json_schema",
        "functions", "functionCall", "function_call", "tool_calls", "toolUse", "json",
      ].includes(key)) continue
      pending.push(child)
    }
  }
  return null
}

async function prepareRequest(request: Request, upstream: ResolvedUpstream, providerId: string, rest: string): Promise<PreparedRequest | { error: Response; errorCode: string }> {
  const url = new URL(upstream.url)
  const invalid = (status: number, code: string, message: string) => ({ error: gatewayError(status, code, message), errorCode: code })
  let pathModel: string | null
  try { pathModel = requestedModelFromPath(url.pathname) } catch { return invalid(400, "invalid_model_path", "Invalid model path encoding.") }
  // No account/file management, deferred inference, or arbitrary provider RPCs.
  // GET models is generated locally before reaching this upstream-only path.
  const operation = stripApiVersionPrefix(rest)
  const modelOperation = (() => {
    switch (upstream.family) {
      case "google":
      case "google_vertex":
        return /^models\/[^/]+:(?:generateContent|streamGenerateContent|embedContent|countTokens)$/.test(operation)
      case "bedrock":
        return /^model\/[^/]+\/(?:converse|converse-stream|invoke|invoke-with-response-stream)$/.test(operation)
      case "anthropic":
        return /^messages(?:\/count_tokens)?$/.test(operation)
      case "google_vertex_anthropic":
        return operation === "messages"
      case "openai":
      case "openai_compatible":
      case "azure":
        return /^(?:deployments\/[^/]+\/)?(?:chat\/completions|completions|responses|embeddings|rerank|moderations|images\/(?:generations|edits|variations)|audio\/(?:speech|transcriptions|translations))$/.test(operation)
    }
  })()
  if (request.method !== "POST" || !modelOperation) return invalid(400, "unsupported_gateway_operation", "Gateway grants allow only supported POST model invocations and local GET /models metadata, not provider account or file management.")
  if (["openai-organization", "openai-project", "x-amzn-bedrock-guardrailidentifier", "x-amzn-bedrock-guardrailversion"].some((name) => request.headers.has(name))) {
    return invalid(400, "unsupported_gateway_resource", "Caller-selected provider accounts and resources are not authorized by a Gateway model grant.")
  }
  if ([...url.searchParams.keys()].some((name) => name.toLowerCase() === GATEWAY_GRANT_HEADER || /model|deployment|preset|fallback|route/i.test(name))) {
    return invalid(400, "unsupported_model_selection", "Model selection in query parameters is not supported.")
  }
  let bytes: Uint8Array<ArrayBuffer>
  try { bytes = await readBoundedBody(request) } catch (error) {
    const limited = error instanceof RequestBodyLimitError
    const code = limited ? "request_too_large" : "request_body_failed"
    return { error: gatewayError(limited ? 413 : 400, code, "Could not read the request body within gateway limits."), errorCode: code }
  }
  let json: unknown = null
  if (bytes.length && isJsonContentType(request.headers.get("content-type"))) {
    try {
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    } catch {
      return invalid(400, "invalid_json", "Invalid JSON request body.")
    }
  }
  if (!isJsonObject(json)) {
    return invalid(415, "unsupported_media_type", "Model invocation bodies must be JSON objects; multipart and file uploads are not supported.")
  }
  const unsupported = unsupportedGatewayPayload(json, upstream.family, providerId)
  if (unsupported === "model") return invalid(400, "unsupported_model_selection", "Alternate or nested model selection is not supported.")
  if (unsupported === "resource") return invalid(400, "unsupported_gateway_resource", "Provider-stored resources and hosted tools are not supported: Gateway model grants do not establish resource ownership. Send inline content and client-executed tools instead.")
  if (Object.hasOwn(json, "model") && (typeof json.model !== "string" || !json.model)) return invalid(400, "model_required", "model must be a nonempty string.")
  if (pathModel && typeof json.model === "string" && json.model !== pathModel) return invalid(400, "conflicting_model_selection", "Body and path must select the same model.")
  const requestedModel = typeof json.model === "string" ? json.model : pathModel
  if (!requestedModel) return invalid(400, "model_required", "This operation requires a configured model.")
  const stream = json.stream === true || isStreamingPath(upstream.protocol, url.pathname)
  return { body: bytes, json, pathModel, requestedModel, stream, url }
}

function rewriteSelectedModel(prepared: PreparedRequest, upstream: ResolvedUpstream, model: string | null) {
  const { json, url, stream } = prepared
  let modified = false
  if (model !== null && prepared.pathModel !== null) {
    url.pathname = url.pathname.replace(/(\/(?:models|model|deployments)\/)([^/]+?)(?=:[a-zA-Z]+(?:$|\/)|\/|$)/,
      (_match, prefix: string) => `${prefix}${encodeURIComponent(model)}`)
  }
  if (!json) return
  if (model !== null && typeof json.model === "string" && json.model !== model) {
    json.model = model
    modified = true
  }
  // Wire aliases hide Claude's identity from clients' model-specific options.
  // Apply the same legacy-thinking compatibility as the desktop plugin, but
  // only after the model grant has resolved the authorized upstream model.
  const claudeVersion = model?.match(/claude-[a-z]+-(\d+)(?:[.@-]|$)/i)
  if (upstream.protocol === "anthropic_messages" && claudeVersion && Number(claudeVersion[1]) >= 5
    && isJsonObject(json.thinking) && json.thinking.type === "enabled") {
    const { budget_tokens, ...thinking } = json.thinking
    json.thinking = { ...thinking, type: "adaptive" }
    const outputConfig = isJsonObject(json.output_config) ? json.output_config : {}
    json.output_config = {
      ...outputConfig,
      effort: outputConfig.effort ?? (typeof budget_tokens === "number" && budget_tokens > 16000 ? "max" : "high"),
    }
    modified = true
  }
  if (upstream.protocol === "openai_chat" && json.stream === true) {
    json.stream_options = { ...(isJsonObject(json.stream_options) ? json.stream_options : {}), include_usage: true }
    modified = true
  }

  if (upstream.family === "google_vertex_anthropic" && upstream.protocol === "anthropic_messages") {
    if (model === null) throw new Error("Missing authorized Vertex model")
    delete json.model
    json.anthropic_version = vertexAnthropicVersion
    modified = true
    url.pathname = url.pathname.replace(/\/messages$/, `/models/${encodeURIComponent(model)}:${stream ? "streamRawPredict" : "rawPredict"}`)
  }

  if (modified) prepared.body = JSON.stringify(json)
}

function buildUpstreamHeaders(request: Request, family: ProtocolFamily, openworkRequestId: string) {
  const headers = new Headers()
  request.headers.forEach((value, name) => {
    if (name.toLowerCase() !== GATEWAY_GRANT_HEADER && isAllowedRequestHeader(family, name)) headers.set(name, value)
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
  return headers.get("x-request-id") ?? headers.get("request-id") ?? headers.get("x-goog-request-id") ?? headers.get("x-amzn-requestid")
}

function upstreamOutcome(upstream: Response): GatewayRequestOutcome {
  return upstream.ok ? "ok" : "upstream_error"
}

function parseJsonUsage(protocol: GatewayRequestProtocol, body: unknown): ParsedUsage | null {
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

function createStreamUsageParser(protocol: GatewayRequestProtocol, contentType: string | null): UsageParser | null {
  if (protocol === "bedrock_converse" && isAwsEventStreamContentType(contentType)) {
    return createBedrockConverseEventStreamUsageParser()
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
      case "bedrock_converse":
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
    upstreamRequestId: usage.upstreamRequestId,
    streamError: usage.streamError,
  })
}

function relayStreamResponse(upstream: Response, protocol: GatewayRequestProtocol, headers: Headers, recorder: RequestLogRecorder, lifetime: ReturnType<typeof upstreamLifetime>) {
  if (!upstream.body) {
    lifetime.dispose()
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
  const finish = (outcome: GatewayRequestOutcome) => {
    try {
      if (parser) recordUsage(recorder, parser.result(), isJsonContentType(upstream.headers.get("content-type")) ? "json" : "stream")
    } catch { /* Malformed accounting must not suppress completion. */ }
    void recorder.finish({
      status: upstream.status,
      outcome,
      upstreamRequestId: upstreamRequestId(upstream.headers),
      responseBytes,
    })
  }
  const body = trackStream(upstream.body, {
    chunk(value) {
      if (value.byteLength) recorder.markFirstByte()
      responseBytes += value.byteLength
      if (parser?.pushBytes) parser.pushBytes(value)
      else if (parser) parser.push(decoder.decode(value, { stream: true }))
    },
    done() {
      finish(upstreamOutcome(upstream))
    },
    fail() {
      finish(lifetime.signal.aborted && !lifetime.timedOut ? "client_aborted" : "upstream_error")
    },
  }, lifetime)
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers })
}

function refreshGoogleOauthTokenWithDb(): RefreshGoogleOauthToken {
  let refresher: Promise<RefreshGoogleOauthToken> | null = null
  return (input) => {
    refresher ??= import("./db.js").then(({ db }) => createGoogleOauthRefresher({ store: createDbGoogleOauthRefreshStore(db) }))
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
    updateRequestLog: input.updateRequestLog,
    reporter: input.reporter,
    loadGatewayProvider: input.loadGatewayProvider ?? loadGatewayProviderFromDb,
    loadGatewayAccess: input.loadGatewayAccess ?? loadGatewayAccessFromDb,
    loadProviderCredential: input.loadProviderCredential ?? loadProviderCredentialFromDb,
    refreshGoogleOauthToken: input.refreshGoogleOauthToken ?? refreshGoogleOauthTokenWithDb(),
    mintGcpAccessToken: input.mintGcpAccessToken ?? createGcpServiceAccountTokenMinter(),
    catalog: input.catalog ?? loadProviderCatalogFromFile(),
    now: input.now ?? (() => new Date()),
  }

  async function handleGatewayRequest(c: Context<GatewayEnv>) {
    const identity = c.get("inference")
    if (identity.kind !== "gateway") return gatewayError(401, "invalid_api_key", "An OpenWork Gateway key is required.")
    const inferenceProviderId = c.req.param("inferenceProviderId")
    if (!inferenceProviderId) {
      return gatewayError(404, "provider_not_found", "Missing inference provider id.")
    }
    const requestUrl = new URL(c.req.url)
    const openworkRequestId = c.get("openworkRequestId")
    const startedAt = dependencies.now()
    const method = c.req.method
    const incomingHeaders = sanitizeIncomingHeaders(c.req.raw.headers)

    const provider = await dependencies.loadGatewayProvider({ inferenceProviderId, organizationId: identity.organizationId })
    if (!provider) {
      return gatewayError(404, "provider_not_found", `Unknown inference provider: ${inferenceProviderId}.`)
    }

    const catalog = dependencies.catalog.getCatalogProvider(provider.provider_id)
    const rest = restOfPath(requestUrl.pathname, inferenceProviderId)
    const scope = { ...identity, gatewayProviderId: provider.id }
    const accessRows = await dependencies.loadGatewayAccess(scope)
    if (method === "GET" && /^(?:v1(?:beta|alpha)?\/)?models\/?$/.test(rest)) {
      if (!accessRows.length) return gatewayError(403, "provider_access_denied", "No current Gateway access grants.")
      const grantId = c.req.header(GATEWAY_GRANT_HEADER)
      if (grantId !== undefined && (!isDenTypeId("inferenceProviderAccess", grantId) || !accessRows.some((row) => row.grant.id === grantId))) {
        return gatewayError(403, "invalid_gateway_selection", "The selected grant is not currently authorized.")
      }
      c.header("cache-control", "no-store")
      return c.json({ object: "list", data: accessibleGatewayModels(grantId === undefined ? accessRows : accessRows.filter((row) => row.grant.id === grantId)) })
    }
    const resolved = resolveUpstream(provider, catalog, rest, requestUrl.search)
    let selection: GatewayGrantSelection | null = null
    const recorder = createRequestLogRecorder({ insertRequestLog: dependencies.insertRequestLog, updateRequestLog: dependencies.updateRequestLog, reporter: dependencies.reporter, now: dependencies.now })
    const startRecorder = (state: {
      protocol: GatewayRequestProtocol
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
        upstreamModel: selection?.upstreamModel ?? null,
        stream: state.stream,
        gatewayProviderId: provider.id,
        gatewayProviderCredentialId: state.credentialId ?? null,
        modelGroupId: selection?.row.group.id ?? null,
        credentialSetId: selection?.row.credentialSet.id ?? null,
        accessGrantId: selection?.row.grant.id ?? null,
        requestBytes: state.requestBytes,
        startedAt,
      })
    }
    const reject = (response: Response, errorCode: string, reason: string) => {
      console.error(`[gateway] ${reason}`, {
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
        gatewayKeyId: identity.gatewayKeyId,
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

    if (!accessRows.length) {
      startRecorder({ protocol: resolved.protocol, url: resolved.url, requestedModel: null, stream: false })
      return reject(
        gatewayError(403, "provider_access_denied", "You do not have access to this inference provider.", { provider_id: provider.id }),
        "provider_access_denied",
        "Inference provider access denied",
      )
    }

    const prepared = await prepareRequest(c.req.raw, resolved, provider.provider_id, rest)
    if ("error" in prepared) {
      startRecorder({ protocol: resolved.protocol, url: resolved.url, requestedModel: null, stream: false })
      return reject(prepared.error, prepared.errorCode, "Unsupported or invalid gateway request")
    }
    const selected = selectGatewayGrant(accessRows, prepared.requestedModel, c.req.header(GATEWAY_GRANT_HEADER) ?? null)
    if (selected.kind !== "selected") {
      startRecorder({ protocol: resolved.protocol, url: resolved.url, requestedModel: prepared.requestedModel, stream: prepared.stream })
      if (selected.kind === "conflict") return reject(Response.json(selected.conflict, { status: 409 }), "gateway_selection_required", "Gateway selection required")
      return reject(gatewayError(403, selected.code, "No current grant authorizes this model and selection."), selected.code, "Gateway model access denied")
    }
    selection = selected.selection
    rewriteSelectedModel(prepared, resolved, selection.upstreamModel)

    const credential = await resolveUpstreamCredential({
      provider,
      scope,
      selection,
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
        requestedModel: prepared.requestedModel,
        stream: prepared.stream,
        credentialId: "credentialId" in credential ? credential.credentialId : null,
      })
      switch (credential.kind) {
        case "retry": {
          const response = gatewayError(503, "provider_credential_retry", "The provider credential is temporarily unavailable. Retry shortly.", { provider_id: provider.id })
          response.headers.set("retry-after", "5")
          return reject(response, credential.reason, "Provider credential retry required")
        }
        case "auth_required": {
          const response = gatewayError(
            401,
            "openwork_auth_required",
            `Connect your ${provider.provider_id} account in OpenWork to use this provider (${credential.reason === "missing" ? "no credential" : `credential ${credential.reason}`}).`,
            { provider_id: provider.id, credential_set_id: selection.row.credentialSet.id },
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
      startRecorder({ protocol: resolved.protocol, url: resolved.url, requestedModel: prepared.requestedModel, stream: prepared.stream, credentialId: credential.credentialId })
      return reject(gatewayError(502, "provider_misconfigured", auth.error, { provider_id: provider.id }), "provider_misconfigured", "Misconfigured inference provider")
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

    if (await recorder.whenStarted?.() === false) {
      return reject(gatewayError(503, "request_log_unavailable", "Inference accounting is temporarily unavailable."), "request_log_unavailable", "Request log unavailable")
    }

    // Recheck after accounting awaits. Never reselect or materialize a fallback.
    const currentSelection = selectGatewayGrant(await dependencies.loadGatewayAccess(scope), prepared.requestedModel, selection.row.grant.id)
    if (currentSelection.kind !== "selected" || !sameGatewaySelection(selection, currentSelection.selection)) {
      return reject(gatewayError(403, "gateway_selection_revoked", "The selected Gateway access is no longer available."), "gateway_selection_revoked", "Gateway selection revoked")
    }
    if (!await credential.isCurrent()) {
      return reject(gatewayError(503, "provider_credential_retry", "The selected credential changed before dispatch. Retry the same selection."), "credential_changed", "Gateway credential changed")
    }

    const lifetime = upstreamLifetime(c.req.raw.signal, env.upstreamTimeoutMs)
    let upstream: Response
    try {
      validateInferenceUrl(prepared.url)
      lifetime.signal.throwIfAborted()
      upstream = await dependencies.fetch(prepared.url, { method, headers, body: prepared.body, signal: lifetime.signal, redirect: "error" })
    } catch {
      lifetime.dispose()
      console.error("[gateway] Failed to reach provider upstream", {
        openworkRequestId,
        organizationId: identity.organizationId,
        inferenceProviderId: provider.id,
        upstreamUrl: `${prepared.url.origin}${prepared.url.pathname}`,
      })
      dependencies.reporter.handledError({
        reason: "upstream_unreachable",
        organizationId: identity.organizationId,
        orgMembershipId: identity.orgMembershipId,
        gatewayKeyId: identity.gatewayKeyId,
        openworkRequestId,
        route: c.req.path,
        method,
        headers: incomingHeaders,
        incomingModel: prepared.requestedModel,
        status: 502,
        upstreamUrl: `${prepared.url.origin}${prepared.url.pathname}`,
      })
      void recorder.finish({ status: 502, outcome: lifetime.signal.aborted && !lifetime.timedOut ? "client_aborted" : "upstream_unreachable", errorCode: lifetime.timedOut ? "upstream_timeout" : "upstream_unreachable" })
      const response = gatewayError(502, "upstream_unreachable", "Failed to reach the inference provider upstream.", { provider_id: provider.id })
      response.headers.set("x-openwork-request-id", openworkRequestId)
      return response
    }

    if (!upstream.ok) {
      console.error("[gateway] Upstream provider request failed", {
        openworkRequestId,
        organizationId: identity.organizationId,
        inferenceProviderId: provider.id,
        upstreamProviderId: provider.provider_id,
        upstreamUrl: `${prepared.url.origin}${prepared.url.pathname}`,
        status: upstream.status,
      })
    }

    const responseHeaders = relayHeaders(upstream, openworkRequestId)
    return relayStreamResponse(upstream, resolved.protocol, responseHeaders, recorder, lifetime)
  }

  api.all(`${gatewayPathPrefix}/:inferenceProviderId`, handleGatewayRequest)
  api.all(`${gatewayPathPrefix}/:inferenceProviderId/*`, handleGatewayRequest)
}
