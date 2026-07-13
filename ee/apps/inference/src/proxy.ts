import { createHash } from "node:crypto"
import type { Context, Hono } from "hono"
import { env } from "./env.js"
import type { findActiveInferenceKey as findActiveInferenceKeyFn, getOpenRouterProviderKey as getOpenRouterProviderKeyFn } from "./keys.js"
import type { ensureUsableBuckets as ensureUsableBucketsFn } from "./limits.js"
import { listModelCatalog, resolveModelAlias } from "./model-catalog.js"

type JsonObject = Record<string, unknown>
type PreparedBody = {
  body: BodyInit | null
  modelAlias: string
  upstreamModel: string | null
}
type PreparedBodyResult = PreparedBody | { error: Response }
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
  modelAlias: string
  upstreamModel: string | null
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
    upstreamUrl: input.upstreamUrl.toString(),
    status: input.upstream.status,
    statusText: input.upstream.statusText,
    modelAlias: input.modelAlias,
    upstreamModel: input.upstreamModel,
    bodySnippet,
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
}): Promise<PreparedBodyResult> {
  if (!isJsonRequest(request)) {
    return { error: openAiError(415, "unsupported_media_type", "Inference requests with a body must use a JSON Content-Type.") }
  }

  const json: unknown = await request.json()
  if (!isJsonObject(json)) {
    logProxyError("Missing model in JSON request body", {
      openworkRequestId: input.openworkRequestId,
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
    })
    return { error: openAiError(400, "model_required", "JSON request body must include a string model.") }
  }

  const blockedSelection = validateModelSelection(json)
  if (blockedSelection) {
    logProxyError("Unsupported OpenRouter model selection feature", {
      openworkRequestId: input.openworkRequestId,
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      blockedSelection,
    })
    return { error: openAiError(400, "unsupported_model_selection", `OpenWork inference does not allow alternate model selection (${blockedSelection}).`) }
  }

  if (typeof json.model !== "string") {
    logProxyError("Missing model in JSON request body", {
      openworkRequestId: input.openworkRequestId,
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
    })
    return { error: openAiError(400, "model_required", "JSON request body must include a string model.") }
  }

  const requestedModel = json.model
  const body = json
  const model = resolveModelAlias(requestedModel)
  if (!model) {
    logProxyError("Unknown OpenWork model alias", {
      openworkRequestId: input.openworkRequestId,
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      requestedModel,
    })
    return { error: openAiError(404, "model_not_found", `Unknown OpenWork model alias: ${requestedModel}`) }
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

    if (new URL(c.req.url).search) {
      return openAiError(400, "unsupported_query_parameters", "OpenWork chat completions does not accept query parameters.")
    }

    const openworkRequestId = buildRequestId()
    const prepared = await prepareBody(c.req.raw, {
      organizationId: inferenceKey.organization_id,
      orgMembershipId: inferenceKey.org_membership_id,
      inferenceKeyId: inferenceKey.id,
      openworkRequestId,
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
      logProxyError("Inference usage limit exceeded", {
        path: c.req.path,
        organizationId: inferenceKey.organization_id,
        orgMembershipId: inferenceKey.org_membership_id,
        limitedBy: limits.limitedBy,
      })
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
        upstreamUrl: upstreamUrl.toString(),
        modelAlias: prepared.modelAlias,
        upstreamModel: prepared.upstreamModel,
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: { message: "Failed to reach OpenRouter upstream.", type: "api_error", code: "upstream_unreachable" } }, 502)
    }

    if (!upstream.ok) {
      await logUpstreamError({
        upstream,
        upstreamUrl,
        openworkRequestId,
        modelAlias: prepared.modelAlias,
        upstreamModel: prepared.upstreamModel,
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
