import { createHash } from "node:crypto"
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

type JsonObject = Record<string, unknown>
type PreparedBody = {
  body: BodyInit | null
  incomingModel: string
  modelAlias: string
  upstreamModel: string | null
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
  async findActiveInferenceKey(rawKey) {
    const keys = await import("./keys.js")
    return keys.findActiveInferenceKey(rawKey)
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

function readApiKey(request: Request) {
  const auth = request.headers.get("authorization")
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim()
  }
  return request.headers.get("x-api-key")?.trim() ?? null
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
  let bodySnippet: string | null = null
  try {
    const text = await input.upstream.clone().text()
    bodySnippet = text.slice(0, 2000)
  } catch (error) {
    bodySnippet = `Failed to read upstream error body: ${error instanceof Error ? error.message : String(error)}`
  }

  logProxyError("Upstream OpenRouter request failed", {
    openworkRequestId: input.openworkRequestId,
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    inferenceKeyId: input.inferenceKeyId,
    upstreamUrl: input.upstreamUrl.toString(),
    status: input.upstream.status,
    statusText: input.upstream.statusText,
    modelAlias: input.modelAlias,
    upstreamModel: input.upstreamModel,
    bodySnippet,
  })
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
    statusText: input.upstream.statusText,
    upstreamUrl: input.upstreamUrl.toString(),
  })
}

function buildRequestId() {
  return createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 32)
}

function secondsUntil(date: Date) {
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000))
}

function trackStream(body: ReadableStream<Uint8Array> | null, done: () => Promise<void>, fail: () => Promise<void>) {
  if (!body) return body
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          await done()
          controller.close()
          return
        }
        controller.enqueue(chunk.value)
      } catch (error) {
        await fail()
        controller.error(error)
      }
    },
    async cancel(reason) {
      await fail()
      await reader.cancel(reason)
    },
  })
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
    const errorMessage = error instanceof Error ? error.message : String(error)
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
    incomingModel: requestedModel,
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
      incomingModel: requestedModel,
      resolvedUpstreamModel: model ? model.upstreamModel : null,
      status: 400,
    })
    return { error: openAiError(400, "unsupported_model_selection", `OpenWork inference does not allow alternate model selection (${blockedSelection}).`), incomingModel: requestedModel, upstreamModel: model ? model.upstreamModel : null }
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
      requestedModel,
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
      incomingModel: requestedModel,
      resolvedUpstreamModel: null,
      status: 404,
    })
    return { error: openAiError(404, "model_not_found", `Unknown OpenWork model alias: ${requestedModel}`), incomingModel: requestedModel, upstreamModel: null }
  }

  body.model = model.upstreamModel
  body.user = input.orgMembershipId
  body.session_id = input.openworkRequestId
  body.trace = {
    trace_id: input.openworkRequestId,
    trace_name: "OpenWork Inference",
    generation_name: model.alias,
    org_membership_id: input.orgMembershipId,
    inference_key_id: input.inferenceKeyId,
    openwork_request_id: input.openworkRequestId,
  }

  return {
    body: JSON.stringify(body),
    incomingModel: requestedModel,
    modelAlias: model.alias,
    upstreamModel: model.upstreamModel,
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
    const rawKey = readApiKey(c.req.raw)
    if (!rawKey) {
      logProxyError("Missing inference API key", { path: c.req.path, method: c.req.method })
      return c.json({ error: { message: "Missing OpenWork inference API key.", type: "authentication_error", code: "missing_api_key" } }, 401)
    }

    const inferenceKey = await dependencies.findActiveInferenceKey(rawKey)
    if (!inferenceKey) {
      logProxyError("Invalid inference API key", { path: c.req.path, method: c.req.method })
      return c.json({ error: { message: "Invalid OpenWork inference API key.", type: "authentication_error", code: "invalid_api_key" } }, 401)
    }

    if (c.req.path === modelsPath && c.req.method === "GET") {
      return c.json(listOpenAiModels())
    }

    if (c.req.path !== chatCompletionsPath || c.req.method !== "POST") {
      return localRouteRejection(c.req.path, c.req.method)
    }

    const openworkRequestId = buildRequestId()
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
      return c.json({
        error: {
          message: `Rate limit reached for organization ${inferenceKey.organization_id}.`,
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

    const upstreamPath = c.req.path.replace(/^\/api\/v1/, "")
    const upstreamUrl = new URL(`${env.openRouterUpstreamUrl}${upstreamPath}`)
    let upstream: Response
    try {
      const upstreamInit: ProxyRequestInit = {
        method: c.req.method,
        headers: sanitizeHeaders(c.req.raw, providerKey.encrypted_api_key, openworkRequestId),
        body: prepared.body,
        duplex: "half",
      }
      upstream = await dependencies.fetch(upstreamUrl, upstreamInit)
    } catch (error) {
      logProxyError("Failed to reach OpenRouter upstream", {
        openworkRequestId,
        organizationId: inferenceKey.organization_id,
        orgMembershipId: inferenceKey.org_membership_id,
        inferenceKeyId: inferenceKey.id,
        upstreamUrl: upstreamUrl.toString(),
        modelAlias: prepared.modelAlias,
        upstreamModel: prepared.upstreamModel,
        error: error instanceof Error ? error.message : String(error),
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
        error: error instanceof Error ? error.message : String(error),
        exception: error,
      })
      return c.json({ error: { message: "Failed to reach OpenRouter upstream.", type: "api_error", code: "upstream_unreachable" } }, 502)
    }

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

    const headers = new Headers(upstream.headers)
    headers.set("x-openwork-request-id", openworkRequestId)
    return new Response(trackStream(
      upstream.body,
      async () => {},
      async () => {},
    ), { status: upstream.status, statusText: upstream.statusText, headers })
  }

  app.all("/api/v1", handleApiRequest)
  app.all("/api/v1/*", handleApiRequest)
}
