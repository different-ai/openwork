import { randomUUID } from "node:crypto"
import { inferenceBearerKey } from "@openwork-ee/utils/inference-bearer-key"
import type { Context, Hono } from "hono"
import { env } from "./env.js"
import type { findActiveInferenceKey as findActiveInferenceKeyFn, getOpenRouterProviderKey as getOpenRouterProviderKeyFn } from "./keys.js"
import type { ensureUsableBuckets as ensureUsableBucketsFn } from "./limits.js"
import {
  buildInferencePayloadLog,
  buildUnparsedPayloadLog,
  sanitizeIncomingHeaders,
  sentryInferenceReporter,
} from "./inference-reporting.js"
import type { InferenceReporter } from "./inference-reporting.js"
import { listModelCatalog, resolveModelAlias } from "./model-catalog.js"
import { INFERENCE_CATALOG_VERIFIED_AT } from "@openwork/types/den/inference"
import { prepareChatParameters, validateChatRequest } from "./chat-request.js"
import { completeChatResponse, inferenceError, readResponseJson, relayChatStream, upstreamError } from "./chat-response.js"

type JsonObject = Record<string, unknown>
type PreparedBody = {
  body: JsonObject
  incomingModel: string
  modelAlias: string
  upstreamModel: string | null
  stream: boolean
}
type PreparedBodyResult = PreparedBody | {
  error: Response
  incomingModel: string | null
  upstreamModel: string | null
}
type ProxyRequestInit = RequestInit & { duplex: "half" }

const chatCompletionsPath = "/api/v1/chat/completions"
const modelsPath = "/api/v1/models"
const topLevelModelSelectorFields = ["models", "fallbacks", "preset", "route"]
const pluginModelSelectorFields = ["model", "analysis_models", "allowed_models"]
const blockedServerToolTypes = new Set([
  "openrouter:advisor",
  "openrouter:subagent",
  "openrouter:fusion",
  "openrouter:image_generation",
])

const defaultProxyDependencies: ProxyDependencies = {
  async findActiveInferenceKey(key) {
    const keys = await import("./keys.js")
    return keys.findActiveInferenceKey(key)
  },
  async getOpenRouterProviderKey(organizationId) {
    const keys = await import("./keys.js")
    return keys.getOpenRouterProviderKey(organizationId)
  },
  async ensureUsableBuckets(organizationId) {
    const limits = await import("./limits.js")
    return limits.ensureUsableBuckets(organizationId)
  },
  fetch,
}

type ProxyDependencies = {
  findActiveInferenceKey: typeof findActiveInferenceKeyFn
  getOpenRouterProviderKey: typeof getOpenRouterProviderKeyFn
  ensureUsableBuckets: typeof ensureUsableBucketsFn
  fetch: typeof fetch
  reporter?: InferenceReporter
}

function readInferenceBearerKey(request: Request) {
  const auth = request.headers.get("authorization")
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const value = auth.slice(7).trim()
    return value ? inferenceBearerKey(value) : null
  }
  const value = request.headers.get("x-api-key")?.trim()
  return value ? inferenceBearerKey(value) : null
}

function isJsonRequest(request: Request) {
  return isJsonContentType(request.headers.get("content-type"))
}

function isJsonContentType(contentType: string | null) {
  if (!contentType) return false
  const mediaType = contentType.split(";")[0].trim().toLowerCase()
  if (mediaType === "application/json") return true
  const applicationPrefix = "application/"
  const jsonSuffix = "+json"
  return mediaType.startsWith(applicationPrefix)
    && mediaType.endsWith(jsonSuffix)
    && mediaType.length > applicationPrefix.length + jsonSuffix.length
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasOwnField(value: JsonObject, field: string) {
  return Object.prototype.hasOwnProperty.call(value, field)
}

function findPresentField(value: JsonObject, fields: string[]) {
  return fields.find((field) => hasOwnField(value, field)) ?? null
}

function normalizeOpenRouterToolType(type: string) {
  return type.trim().toLowerCase().replace(/-/g, "_")
}

function findBlockedPluginSelector(json: JsonObject) {
  const plugins = json.plugins
  if (!Array.isArray(plugins)) return null

  for (const plugin of plugins) {
    if (!isJsonObject(plugin)) continue

    if (typeof plugin.id === "string" && plugin.id.trim().toLowerCase() === "fusion") {
      return "plugins[].id"
    }

    const field = findPresentField(plugin, pluginModelSelectorFields)
    if (field) return `plugins[].${field}`

    if (isJsonObject(plugin.parameters)) {
      const parametersField = findPresentField(plugin.parameters, pluginModelSelectorFields)
      if (parametersField) return `plugins[].parameters.${parametersField}`
    }
  }

  return null
}

function findBlockedServerTool(json: JsonObject) {
  const tools = json.tools
  if (!Array.isArray(tools)) return null

  for (const tool of tools) {
    if (!isJsonObject(tool) || typeof tool.type !== "string") continue
    const type = normalizeOpenRouterToolType(tool.type)
    if (blockedServerToolTypes.has(type)) return tool.type
  }

  return null
}

function validateModelSelection(json: JsonObject) {
  const topLevelField = findPresentField(json, topLevelModelSelectorFields)
  if (topLevelField) return `top-level ${topLevelField}`

  const pluginSelector = findBlockedPluginSelector(json)
  if (pluginSelector) return pluginSelector

  const serverTool = findBlockedServerTool(json)
  if (serverTool) return `server tool ${serverTool}`

  return null
}

function sanitizeHeaders(request: Request, apiKey: string, openworkRequestId: string) {
  const headers = new Headers()
  const accept = request.headers.get("accept")
  if (accept) headers.set("accept", accept)
  headers.set("authorization", `Bearer ${apiKey}`)
  headers.set("content-type", "application/json")
  headers.set("x-openwork-request-id", openworkRequestId)
  if (env.proxyBaseUrl) {
    headers.set("http-referer", env.proxyBaseUrl)
  }
  headers.set("x-title", "OpenWork Inference")
  return headers
}

function openAiError(status: number, code: string, message: string) {
  return Response.json({ error: { message, type: "invalid_request_error", code } }, { status })
}

function logProxyError(message: string, details: Record<string, unknown>) {
  console.error(`[inference-proxy] ${message}`, details)
}

async function logUpstreamError(input: {
  upstream: Response
  upstreamUrl: URL
  openworkRequestId: string
  organizationId: string
  orgMembershipId: string
  inferenceKeyId: string
  route: string
  method: string
  headers: Record<string, string>
  modelAlias: string
  incomingModel: string
  upstreamModel: string | null
  reporter: InferenceReporter
}) {
  input.reporter.handledError({
    reason: "upstream_failure",
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    inferenceKeyId: input.inferenceKeyId,
    openworkRequestId: input.openworkRequestId,
    route: input.route,
    method: input.method,
    headers: input.headers,
    incomingModel: input.incomingModel,
    resolvedUpstreamModel: input.upstreamModel,
    status: input.upstream.status,
    statusText: "Upstream request failed",
    upstreamUrl: input.upstreamUrl.toString(),
  })
}

function buildRequestId() {
  return randomUUID().replaceAll("-", "")
}

function secondsUntil(date: Date) {
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000))
}

async function prepareBody(request: Request, input: {
  organizationId: string
  orgMembershipId: string
  inferenceKeyId: string
  openworkRequestId: string
  route: string
  method: string
  headers: Record<string, string>
  reporter: InferenceReporter
}): Promise<PreparedBodyResult> {
  if (!isJsonRequest(request)) {
    const payloadLog = buildUnparsedPayloadLog("unsupported_media_type", request.headers.get("content-type"))
    input.reporter.request({
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      inferenceKeyId: input.inferenceKeyId,
      openworkRequestId: input.openworkRequestId,
      route: input.route,
      method: input.method,
      headers: input.headers,
      incomingModel: null,
      resolvedUpstreamModel: null,
      payloadMode: payloadLog.mode,
      payload: payloadLog.payload,
    })
    input.reporter.handledError({
      reason: "unsupported_media_type",
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      inferenceKeyId: input.inferenceKeyId,
      openworkRequestId: input.openworkRequestId,
      route: input.route,
      method: input.method,
      headers: input.headers,
      incomingModel: null,
      resolvedUpstreamModel: null,
      status: 415,
    })
    return { error: openAiError(415, "unsupported_media_type", "Inference requests with a body must use a JSON Content-Type."), incomingModel: null, upstreamModel: null }
  }

  let json: unknown
  try {
    json = await request.json()
  } catch (error) {
    const errorMessage = "Invalid JSON request body"
    const payloadLog = buildUnparsedPayloadLog("invalid_json", request.headers.get("content-type"))
    input.reporter.request({
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      inferenceKeyId: input.inferenceKeyId,
      openworkRequestId: input.openworkRequestId,
      route: input.route,
      method: input.method,
      headers: input.headers,
      incomingModel: null,
      resolvedUpstreamModel: null,
      payloadMode: payloadLog.mode,
      payload: payloadLog.payload,
    })
    logProxyError("Invalid JSON inference request body", {
      openworkRequestId: input.openworkRequestId,
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      inferenceKeyId: input.inferenceKeyId,
      error: errorMessage,
    })
    input.reporter.handledError({
      reason: "invalid_json",
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      inferenceKeyId: input.inferenceKeyId,
      openworkRequestId: input.openworkRequestId,
      route: input.route,
      method: input.method,
      headers: input.headers,
      incomingModel: null,
      resolvedUpstreamModel: null,
      status: 400,
      error: errorMessage,
    })
    return { error: openAiError(400, "invalid_json", "JSON request body is invalid."), incomingModel: null, upstreamModel: null }
  }
  const requestedModel = isJsonObject(json) && typeof json.model === "string" ? json.model : null
  const model = requestedModel ? resolveModelAlias(requestedModel) : null
  const payloadLog = buildInferencePayloadLog(input.organizationId, json)
  input.reporter.request({
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    inferenceKeyId: input.inferenceKeyId,
    openworkRequestId: input.openworkRequestId,
    route: input.route,
    method: input.method,
    headers: input.headers,
    incomingModel: model ? model.alias : null,
    resolvedUpstreamModel: model ? model.upstreamModel : null,
    payloadMode: payloadLog.mode,
    payload: payloadLog.payload,
  })

  if (!isJsonObject(json)) {
    logProxyError("Missing model in JSON request body", {
      openworkRequestId: input.openworkRequestId,
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      inferenceKeyId: input.inferenceKeyId,
    })
    input.reporter.handledError({
      reason: "model_required",
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      inferenceKeyId: input.inferenceKeyId,
      openworkRequestId: input.openworkRequestId,
      route: input.route,
      method: input.method,
      headers: input.headers,
      incomingModel: null,
      resolvedUpstreamModel: null,
      status: 400,
    })
    return { error: openAiError(400, "model_required", "JSON request body must include a string model."), incomingModel: null, upstreamModel: null }
  }

  const blockedSelection = validateModelSelection(json)
  if (blockedSelection) {
    logProxyError("Unsupported OpenRouter model selection feature", {
      openworkRequestId: input.openworkRequestId,
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      blockedSelection,
    })
    input.reporter.handledError({
      reason: "unsupported_model_selection",
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      inferenceKeyId: input.inferenceKeyId,
      openworkRequestId: input.openworkRequestId,
      route: input.route,
      method: input.method,
      headers: input.headers,
      incomingModel: model ? model.alias : null,
      resolvedUpstreamModel: model ? model.upstreamModel : null,
      status: 400,
    })
    return { error: openAiError(400, "unsupported_model_selection", `OpenWork inference does not allow alternate model selection (${blockedSelection}).`), incomingModel: model ? model.alias : null, upstreamModel: model ? model.upstreamModel : null }
  }

  if (requestedModel === null) {
    logProxyError("Missing model in JSON request body", {
      openworkRequestId: input.openworkRequestId,
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      inferenceKeyId: input.inferenceKeyId,
    })
    input.reporter.handledError({
      reason: "model_required",
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      inferenceKeyId: input.inferenceKeyId,
      openworkRequestId: input.openworkRequestId,
      route: input.route,
      method: input.method,
      headers: input.headers,
      incomingModel: null,
      resolvedUpstreamModel: null,
      status: 400,
    })
    return { error: openAiError(400, "model_required", "JSON request body must include a string model."), incomingModel: null, upstreamModel: null }
  }

  const body = json
  if (!model) {
    logProxyError("Unknown OpenWork model alias", {
      openworkRequestId: input.openworkRequestId,
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      inferenceKeyId: input.inferenceKeyId,
      requestedModel: "unknown",
    })
    input.reporter.handledError({
      reason: "model_not_found",
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      inferenceKeyId: input.inferenceKeyId,
      openworkRequestId: input.openworkRequestId,
      route: input.route,
      method: input.method,
      headers: input.headers,
      incomingModel: null,
      resolvedUpstreamModel: null,
      status: 404,
    })
    return { error: openAiError(404, "model_not_found", `Unknown OpenWork model alias: ${requestedModel}`), incomingModel: null, upstreamModel: null }
  }

  const issue = validateChatRequest(body, model)
  if (issue) return { error: openAiError(400, "unsupported_request", issue), incomingModel: model ? model.alias : null, upstreamModel: model.upstreamModel }
  prepareChatParameters(body)

  body.model = model.upstreamModel
  body.user = input.orgMembershipId
  body.session_id = input.openworkRequestId
  body.trace = {
    trace_id: input.openworkRequestId,
    trace_name: "OpenWork Inference",
    generation_name: model.alias,
    usage_started_at: new Date().toISOString(),
    org_membership_id: input.orgMembershipId,
    inference_key_id: input.inferenceKeyId,
    openwork_request_id: input.openworkRequestId,
  }

  return {
    body,
    incomingModel: model.alias,
    modelAlias: model.alias,
    upstreamModel: model.upstreamModel,
    stream: body.stream === true,
  }
}

function listOpenAiModels() {
  return {
    object: "list",
    data: listModelCatalog().map((model) => ({
      id: model.alias,
      object: "model",
      created: 0,
      owned_by: "openwork",
      name: model.displayName,
      context_length: model.capabilities.contextTokens,
      top_provider: { context_length: model.capabilities.contextTokens, max_completion_tokens: model.capabilities.outputTokens },
      architecture: { input_modalities: model.capabilities.inputModalities, output_modalities: model.capabilities.outputModalities },
      supported_parameters: model.capabilities.supportedParameters,
      reasoning: {
        mandatory: model.capabilities.reasoning.mandatory,
        supported_efforts: model.capabilities.reasoning.supportedEfforts,
        default_effort: model.capabilities.reasoning.defaultEffort,
        default_enabled: model.capabilities.reasoning.defaultEnabled,
        supports_max_tokens: model.capabilities.reasoning.supportsTokenBudget,
      },
      openwork: { catalog_verified_at: INFERENCE_CATALOG_VERIFIED_AT, access: "organization", routing: "openrouter", realtime_audio: false },
    })),
  }
}

function localRouteRejection(path: string, method: string) {
  if (path === chatCompletionsPath) {
    return openAiError(405, "method_not_allowed", `Method ${method} is not allowed for ${path}. Use POST.`)
  }
  if (path === modelsPath) {
    return openAiError(405, "method_not_allowed", `Method ${method} is not allowed for ${path}. Use GET.`)
  }
  return openAiError(404, "not_found", `Unsupported OpenWork inference route: ${method} ${path}.`)
}

export function registerProxyRoutes(app: Hono, dependencies: ProxyDependencies = defaultProxyDependencies) {
  const reporter = dependencies.reporter ?? sentryInferenceReporter

  async function handleApiRequest(c: Context) {
    const openworkRequestId = buildRequestId()
    c.header("x-openwork-request-id", openworkRequestId)
    c.header("cache-control", "no-store")
    const bearerKey = readInferenceBearerKey(c.req.raw)
    if (!bearerKey) {
      logProxyError("Missing inference API key", { path: c.req.path, method: c.req.method })
      return c.json({ error: { message: "Missing OpenWork inference API key.", type: "authentication_error", code: "missing_api_key" } }, 401)
    }

    const inferenceKey = await dependencies.findActiveInferenceKey(bearerKey)
    if (!inferenceKey) {
      logProxyError("Invalid inference API key", { path: c.req.path, method: c.req.method })
      return c.json({ error: { message: "Invalid OpenWork inference API key.", type: "authentication_error", code: "invalid_api_key" } }, 401)
    }

    if (c.req.path === modelsPath && c.req.method === "GET") {
      const limits = await dependencies.ensureUsableBuckets(inferenceKey.organization_id)
      if (!limits.ok) return c.json({ ...listOpenAiModels(), data: [], error: { code: "model_access_unavailable", message: "OpenWork Models access is unavailable or its allowance is exhausted. Check Models in your organization settings." } })
      const provider = await dependencies.getOpenRouterProviderKey(inferenceKey.organization_id)
      if (!provider) return c.json({ ...listOpenAiModels(), data: [], error: { code: "missing_provider_key", message: "Ask your organization admin to reconnect OpenWork Models." } })
      return c.json(listOpenAiModels())
    }

    if (c.req.path !== chatCompletionsPath || c.req.method !== "POST") {
      return localRouteRejection(c.req.path, c.req.method)
    }

    const incomingHeaders = sanitizeIncomingHeaders(c.req.raw.headers)

    if (new URL(c.req.url).search) {
      const payloadLog = buildUnparsedPayloadLog("unsupported_query_parameters", c.req.raw.headers.get("content-type"))
      reporter.request({
        organizationId: inferenceKey.organization_id,
        orgMembershipId: inferenceKey.org_membership_id,
        inferenceKeyId: inferenceKey.id,
        openworkRequestId,
        route: c.req.path,
        method: c.req.method,
        headers: incomingHeaders,
        incomingModel: null,
        resolvedUpstreamModel: null,
        payloadMode: payloadLog.mode,
        payload: payloadLog.payload,
      })
      reporter.handledError({
        reason: "unsupported_query_parameters",
        organizationId: inferenceKey.organization_id,
        orgMembershipId: inferenceKey.org_membership_id,
        inferenceKeyId: inferenceKey.id,
        openworkRequestId,
        route: c.req.path,
        method: c.req.method,
        headers: incomingHeaders,
        incomingModel: null,
        resolvedUpstreamModel: null,
        status: 400,
      })
      return openAiError(400, "unsupported_query_parameters", "OpenWork chat completions does not accept query parameters.")
    }

    const prepared = await prepareBody(c.req.raw, {
      organizationId: inferenceKey.organization_id,
      orgMembershipId: inferenceKey.org_membership_id,
      inferenceKeyId: inferenceKey.id,
      openworkRequestId,
      route: c.req.path,
      method: c.req.method,
      headers: incomingHeaders,
      reporter,
    })
    if ("error" in prepared) {
      logProxyError("Invalid inference proxy request", {
        openworkRequestId,
        path: c.req.path,
        organizationId: inferenceKey.organization_id,
        orgMembershipId: inferenceKey.org_membership_id,
      })
      return prepared.error
    }

    const limits = await dependencies.ensureUsableBuckets(inferenceKey.organization_id)
    if (!limits.ok) {
      c.header("x-openwork-limit-bucket-id", limits.limitedBy)
      c.header("x-openwork-limit-window-type", limits.windowType)
      const limitedBucket = "limitedBucket" in limits ? limits.limitedBucket : null
      if (limitedBucket) {
        const retryAfter = secondsUntil(limitedBucket.windowEndAt)
        c.header("retry-after", String(retryAfter))
        c.header("x-ratelimit-limit-tokens", String(limitedBucket.limitAmount))
        c.header("x-ratelimit-remaining-tokens", "0")
        c.header("x-ratelimit-reset-tokens", `${retryAfter}s`)
      }
      if (!limitedBucket) return c.json({ error: { code: "inference_access_unavailable", type: "permission_error", message: "OpenWork Models access is not active. Ask your organization admin to check Models settings." } }, 403)
      return c.json({
        error: {
          message: `OpenWork Models ${limits.windowType.replaceAll("_", " ")} allowance is exhausted. Wait for its reset or choose another connected model.`,
          type: "tokens",
          param: null,
          code: "rate_limit_exceeded",
        },
      }, 429)
    }

    const providerKey = await dependencies.getOpenRouterProviderKey(inferenceKey.organization_id)
    if (!providerKey) {
      logProxyError("Missing active OpenRouter provider key", {
        path: c.req.path,
        organizationId: inferenceKey.organization_id,
        orgMembershipId: inferenceKey.org_membership_id,
        inferenceKeyId: inferenceKey.id,
        openworkRequestId,
      })
      reporter.handledError({
        reason: "missing_provider_key",
        organizationId: inferenceKey.organization_id,
        orgMembershipId: inferenceKey.org_membership_id,
        inferenceKeyId: inferenceKey.id,
        openworkRequestId,
        route: c.req.path,
        method: c.req.method,
        headers: incomingHeaders,
        incomingModel: prepared.incomingModel,
        resolvedUpstreamModel: prepared.upstreamModel,
        status: 400,
      })
      return c.json({ error: { message: "No active OpenRouter provider key configured for organization.", type: "invalid_request_error", code: "missing_provider_key" } }, 400)
    }

    if (isJsonObject(prepared.body.trace)) prepared.body.trace.usage_started_at = new Date().toISOString()
    const upstreamPath = c.req.path.replace(/^\/api\/v1/, "")
    const upstreamUrl = new URL(`${env.openRouterUpstreamUrl}${upstreamPath}`)
    let upstream: Response
    const startedAt = Date.now()
    const abort = new AbortController()
    const cancel = () => abort.abort()
    c.req.raw.signal.addEventListener("abort", cancel, { once: true })
    if (c.req.raw.signal.aborted) abort.abort()
    const headerTimeout = setTimeout(() => abort.abort(), env.upstreamTimeoutMs)
    try {
      const upstreamInit: ProxyRequestInit = {
        method: c.req.method,
        headers: sanitizeHeaders(c.req.raw, providerKey.encrypted_api_key, openworkRequestId),
        body: JSON.stringify(prepared.body),
        duplex: "half",
        signal: abort.signal,
        redirect: "error",
      }
      upstream = await dependencies.fetch(upstreamUrl, upstreamInit)
    } catch {
      clearTimeout(headerTimeout)
      c.req.raw.signal.removeEventListener("abort", cancel)
      logProxyError("Failed to reach OpenRouter upstream", {
        openworkRequestId,
        organizationId: inferenceKey.organization_id,
        orgMembershipId: inferenceKey.org_membership_id,
        inferenceKeyId: inferenceKey.id,
        upstreamUrl: upstreamUrl.toString(),
        modelAlias: prepared.modelAlias,
        upstreamModel: prepared.upstreamModel,
        error: "Upstream connection failed",
      })
      reporter.handledError({
        reason: "upstream_unreachable",
        organizationId: inferenceKey.organization_id,
        orgMembershipId: inferenceKey.org_membership_id,
        inferenceKeyId: inferenceKey.id,
        openworkRequestId,
        route: c.req.path,
        method: c.req.method,
        headers: incomingHeaders,
        incomingModel: prepared.incomingModel,
        resolvedUpstreamModel: prepared.upstreamModel,
        status: 502,
        upstreamUrl: upstreamUrl.toString(),
        error: "Upstream connection failed",
      })
      return c.json(inferenceError(abort.signal.aborted ? "upstream_timeout" : "upstream_unreachable", c.req.raw.signal.aborted ? "Request cancelled." : "The selected model could not be reached. Your work is preserved; retry when the provider recovers."), 502)
    }
    clearTimeout(headerTimeout)

    if (!upstream.ok) {
      await logUpstreamError({
        upstream,
        upstreamUrl,
        openworkRequestId,
        organizationId: inferenceKey.organization_id,
        orgMembershipId: inferenceKey.org_membership_id,
        inferenceKeyId: inferenceKey.id,
        route: c.req.path,
        method: c.req.method,
        headers: incomingHeaders,
        modelAlias: prepared.modelAlias,
        incomingModel: prepared.incomingModel,
        upstreamModel: prepared.upstreamModel,
        reporter,
      })
    }

    const headers = new Headers({ "x-openwork-request-id": openworkRequestId, "cache-control": "no-store" })
    const retryAfter = upstream.headers.get("retry-after")
    if (retryAfter && (/^\d+$/.test(retryAfter) || Number.isFinite(Date.parse(retryAfter)))) headers.set("retry-after", retryAfter)
    if (!upstream.ok) {
      let error = upstreamError(upstream.status)
      // Read only a bounded error envelope to classify context overflow. The
      // provider's message and metadata never leave this scope or enter logs.
      if (upstream.status === 400) {
        const timeout = setTimeout(() => abort.abort(), Math.min(env.upstreamTimeoutMs, 5000))
        try {
          const payload = await readResponseJson(upstream.body, 65536)
          if (isJsonObject(payload) && isJsonObject(payload.error) && (
            payload.error.code === "context_length_exceeded" ||
            (typeof payload.error.message === "string" && /maximum context length|context length.*exceed|too many tokens/i.test(payload.error.message))
          )) error = upstreamError(413)
        } catch { /* The safe status category remains sufficient. */ }
        finally { clearTimeout(timeout) }
      }
      c.req.raw.signal.removeEventListener("abort", cancel)
      abort.abort()
      await upstream.body?.cancel().catch(() => {})
      return Response.json(error, { status: upstream.status, headers })
    }
    const contentType = upstream.headers.get("content-type")?.split(";")[0].trim().toLowerCase()
    if (prepared.stream) {
      if (contentType !== "text/event-stream" || !upstream.body) {
        c.req.raw.signal.removeEventListener("abort", cancel)
        abort.abort()
        await upstream.body?.cancel().catch(() => {})
        return Response.json(inferenceError("upstream_malformed_stream", "The model did not return a response stream. Retry the selected model."), { status: 502, headers })
      }
      headers.set("content-type", "text/event-stream; charset=utf-8")
      headers.set("x-accel-buffering", "no")
      return new Response(relayChatStream({
        body: upstream.body, abort, startedAt, idleMs: env.streamIdleMs,
        onFinish(result) {
          c.req.raw.signal.removeEventListener("abort", cancel)
          reporter.completion?.({ ...result, openworkRequestId, organizationId: inferenceKey.organization_id, orgMembershipId: inferenceKey.org_membership_id, modelAlias: prepared.modelAlias })
        },
      }), { headers })
    }
    // Bound non-streaming bodies too. An HTTP 200 without a terminal choice is
    // not a completed inference response.
    const bodyTimeout = setTimeout(() => abort.abort(), env.upstreamTimeoutMs)
    try {
      const value = await readResponseJson(upstream.body)
      if (!completeChatResponse(value)) {
        return Response.json(inferenceError("upstream_incomplete", "The model returned an incomplete response. Review your work before retrying."), { status: 502, headers })
      }
      return Response.json(value, { headers })
    } catch {
      return Response.json(inferenceError("upstream_incomplete", "The model response was interrupted or malformed. Review your work before retrying."), { status: 502, headers })
    } finally {
      clearTimeout(bodyTimeout)
      c.req.raw.signal.removeEventListener("abort", cancel)
      abort.abort()
    }
  }

  app.all("/api/v1", handleApiRequest)
  app.all("/api/v1/*", handleApiRequest)
}
