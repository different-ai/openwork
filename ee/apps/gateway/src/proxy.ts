import { ManagedModelsPolicyError } from "@openwork/types/den/managed-models-policy"
import type { InferenceRequestOutcome } from "@openwork/types/den/inference"
import { createInferenceEgressFetch, validateInferenceUrl } from "@openwork-ee/utils/inference-egress"
import { Hono } from "hono"
import type { Context } from "hono"
import { createMiddleware } from "hono/factory"
import { env } from "./env.js"
import type { assertOrganizationManagedModelsAllowed as assertOrganizationManagedModelsAllowedFn, findActiveInferenceKey as findActiveInferenceKeyFn, getOpenRouterProviderKey as getOpenRouterProviderKeyFn } from "./keys.js"
import type { ensureUsableBuckets as ensureUsableBucketsFn } from "./limits.js"
import {
  buildInferencePayloadLog,
  buildUnparsedPayloadLog,
  sanitizeIncomingHeaders,
  sentryInferenceReporter,
  safeInferenceReporter,
  safeAccessUrl,
} from "./inference-reporting.js"
import type { InferenceReporter } from "./inference-reporting.js"
import { inferenceAuth } from "./middleware/inference-auth.js"
import { gatewayAuth } from "./middleware/gateway-auth.js"
import type { findActiveGatewayKey } from "./keys.js"
import type { InferenceAuthEnv, InferenceAuthVariables } from "./middleware/inference-auth.js"
import { loadOrganizationFromDb, orgContext } from "./middleware/org-context.js"
import type { LoadOrganization, OrganizationVariables } from "./middleware/org-context.js"
import { listModelCatalog, resolveModelAlias } from "./model-catalog.js"
import type { AnalyticsObserver, beginModelAnalytics } from "./task-analytics.js"
import { completeChatResponse, inferenceError, readResponseJson, relayChatStream, upstreamError } from "./chat-response.js"
import { registerGatewayRoutes } from "./gateway.js"
import type { GatewayDependencies } from "./gateway.js"
import { isEventStreamContentType, isJsonContentType, trackStream, readBoundedBody, RequestBodyLimitError, upstreamLifetime } from "./relay.js"
import { createJsonBodyUsageParser } from "./usage/shared.js"
import { createRequestLogRecorder, insertRequestLogIntoDb } from "./request-log.js"
import type { InsertRequestLog, RequestLogRecorder, RequestLogRecorderDependencies } from "./request-log.js"
import { createOpenAiChatSseUsageParser, parseOpenAiChatJsonUsage } from "./usage/openai-chat.js"
import type { ParsedUsage } from "./usage/shared.js"

type JsonObject = Record<string, unknown>
type PreparedBody = {
  body: JsonObject & { trace: JsonObject }
  incomingModel: string
  modelAlias: string
  upstreamModel: string | null
  stream: boolean
}
type PreparedBodyResult = PreparedBody | {
  error: Response
  errorCode: string
  incomingModel: string | null
  upstreamModel: string | null
  stream: boolean
}
type ProxyRequestInit = RequestInit & { duplex: "half" }
export type InferenceEnv = { Variables: InferenceAuthVariables & OrganizationVariables }

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
  async assertOrganizationManagedModelsAllowed(organizationId) {
    const keys = await import("./keys.js")
    return keys.assertOrganizationManagedModelsAllowed(organizationId)
  },
  async getOpenRouterProviderKey(organizationId) {
    const keys = await import("./keys.js")
    return keys.getOpenRouterProviderKey(organizationId)
  },
  async ensureUsableBuckets(organizationId) {
    const limits = await import("./limits.js")
    return limits.ensureUsableBuckets(organizationId)
  },
  fetch: createInferenceEgressFetch(),
  async analytics(input) {
    const { beginModelAnalytics } = await import("./task-analytics.js")
    return beginModelAnalytics(input)
  },
  loadOrganization: loadOrganizationFromDb,
  insertRequestLog: insertRequestLogIntoDb,
}

type ProxyDependencies = {
  findActiveGatewayKey?: typeof findActiveGatewayKey
  findActiveInferenceKey: typeof findActiveInferenceKeyFn
  assertOrganizationManagedModelsAllowed: typeof assertOrganizationManagedModelsAllowedFn
  getOpenRouterProviderKey: typeof getOpenRouterProviderKeyFn
  ensureUsableBuckets: typeof ensureUsableBucketsFn
  fetch: typeof fetch
  loadOrganization?: LoadOrganization
  insertRequestLog?: InsertRequestLog
  updateRequestLog?: RequestLogRecorderDependencies["updateRequestLog"]
  reporter?: InferenceReporter
  analytics?: typeof beginModelAnalytics
  gateway?: Partial<GatewayDependencies>
}

function isJsonRequest(request: Request) {
  return isJsonContentType(request.headers.get("content-type"))
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
  headers.set("x-title", "OpenWork Gateway")
  return headers
}

function openAiError(status: number, code: string, message: string) {
  return Response.json({ error: { message, type: "invalid_request_error", code } }, { status })
}

function logProxyError(message: string, details: Record<string, unknown>) {
  console.error(`[gateway-proxy] ${message}`, details)
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
    upstreamUrl: safeAccessUrl(input.upstreamUrl.toString()),
  })
}

function secondsUntil(date: Date) {
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000))
}

function trackAnalyticsStream(body: ReadableStream<Uint8Array> | null, observer: AnalyticsObserver | null, ok: boolean) {
  const finish = (status: "completed" | "failed" | "cancelled") => {
    try { observer?.finish(status) } catch { /* Optional analytics cannot interrupt inference. */ }
  }
  const complete = () => finish(ok ? "completed" : "failed")
  if (!body) complete()
  if (!body) return body
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          complete()
          controller.close()
          return
        }
        try { observer?.chunk(chunk.value) } catch { /* Forward the original bytes even if observation fails. */ }
        controller.enqueue(chunk.value)
      } catch (error) {
        finish("failed")
        controller.error(error)
      }
    },
    async cancel(reason) {
      finish("cancelled")
      await reader.cancel(reason)
    },
  }, { highWaterMark: 0 })
}

function upstreamRequestId(headers: Headers) {
  return headers.get("x-request-id") ?? headers.get("request-id")
}

function upstreamOutcome(upstream: Response): InferenceRequestOutcome {
  return upstream.ok ? "ok" : "upstream_error"
}

function recordUsage(recorder: RequestLogRecorder, usage: ParsedUsage, source: "stream" | "json") {
  recorder.setUsage({
    usageSource: usage.found ? source : "missing",
    upstreamModel: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cacheReadTokens: usage.cacheReadTokens,
    reasoningTokens: usage.reasoningTokens,
    costUsd: usage.costUsd ?? null,
    upstreamRequestId: usage.upstreamRequestId,
    streamError: usage.streamError,
  })
}

function relayStreamResponse(upstream: Response, headers: Headers, recorder: RequestLogRecorder, lifetime: ReturnType<typeof upstreamLifetime>) {
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

  const json = isJsonContentType(upstream.headers.get("content-type"))
  const parser = json ? createJsonBodyUsageParser(parseOpenAiChatJsonUsage) : isEventStreamContentType(upstream.headers.get("content-type")) ? createOpenAiChatSseUsageParser() : null
  const decoder = new TextDecoder()
  let responseBytes = 0
  const finish = (outcome: InferenceRequestOutcome) => {
    try { if (parser) recordUsage(recorder, parser.result(), json ? "json" : "stream") } catch { /* Preserve completion when observation fails. */ }
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
      if (parser) parser.push(decoder.decode(value, { stream: true }))
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
    return { error: openAiError(415, "unsupported_media_type", "Inference requests with a body must use a JSON Content-Type."), errorCode: "unsupported_media_type", incomingModel: null, upstreamModel: null, stream: false }
  }

  let json: unknown
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBody(request)))
  } catch (error) {
    const errorMessage = "Invalid JSON request body"
    if (error instanceof RequestBodyLimitError) return { error: openAiError(413, "request_too_large", "Request exceeds the gateway body limit."), errorCode: "request_too_large", incomingModel: null, upstreamModel: null, stream: false }
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
    })
    return { error: openAiError(400, "invalid_json", "JSON request body is invalid."), errorCode: "invalid_json", incomingModel: null, upstreamModel: null, stream: false }
  }
  const requestedModel = isJsonObject(json) && typeof json.model === "string" ? json.model : null
  const model = requestedModel ? resolveModelAlias(requestedModel) : null
  const stream = isJsonObject(json) && json.stream === true
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
    return { error: openAiError(400, "model_required", "JSON request body must include a string model."), errorCode: "model_required", incomingModel: null, upstreamModel: null, stream }
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
    return { error: openAiError(400, "unsupported_model_selection", `OpenWork Gateway does not allow alternate model selection (${blockedSelection}).`), errorCode: "unsupported_model_selection", incomingModel: requestedModel, upstreamModel: model ? model.upstreamModel : null, stream }
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
    return { error: openAiError(400, "model_required", "JSON request body must include a string model."), errorCode: "model_required", incomingModel: null, upstreamModel: null, stream }
  }

  const body = json
  if (!model) {
    logProxyError("Unknown OpenWork model alias", {
      openworkRequestId: input.openworkRequestId,
      organizationId: input.organizationId,
      orgMembershipId: input.orgMembershipId,
      inferenceKeyId: input.inferenceKeyId,
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
    return { error: openAiError(404, "model_not_found", `Unknown OpenWork model alias: ${requestedModel}`), errorCode: "model_not_found", incomingModel: requestedModel, upstreamModel: null, stream }
  }

  body.model = model.upstreamModel
  body.user = input.orgMembershipId
  body.session_id = input.openworkRequestId
  const trace = {
    trace_id: input.openworkRequestId,
    trace_name: "OpenWork Gateway",
    generation_name: model.alias,
    org_membership_id: input.orgMembershipId,
    inference_key_id: input.inferenceKeyId,
    openwork_request_id: input.openworkRequestId,
  }
  if (stream) {
    body.stream_options = { ...(isJsonObject(body.stream_options) ? body.stream_options : {}), include_usage: true }
  }

  return {
    body: { ...body, trace },
    incomingModel: model.alias,
    modelAlias: model.alias,
    upstreamModel: model.upstreamModel,
    stream,
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
  return openAiError(404, "not_found", `Unsupported OpenWork Gateway route: ${method} ${path}.`)
}

export function registerProxyRoutes(app: Hono, dependencies: ProxyDependencies = defaultProxyDependencies) {
  const reporter = safeInferenceReporter(dependencies.reporter ?? sentryInferenceReporter)
  const insertRequestLog = dependencies.insertRequestLog ?? insertRequestLogIntoDb
  const api = new Hono<InferenceEnv>()

  async function managedModelsRejection(organizationId: string) {
    try {
      await dependencies.assertOrganizationManagedModelsAllowed(organizationId)
      return null
    } catch (error) {
      const policyError = error instanceof ManagedModelsPolicyError
        ? error
        : new ManagedModelsPolicyError("managed_models_policy_unavailable")
      return openAiError(policyError.status, policyError.code, policyError.message)
    }
  }

  async function handleApiRequest(c: Context<InferenceEnv>) {
    const openworkRequestId = c.get("openworkRequestId")
    c.header("x-openwork-request-id", openworkRequestId)
    c.header("cache-control", "no-store")
    const identity = c.get("inference")
    if (identity.kind !== "models") return openAiError(401, "invalid_api_key", "An OpenWork Models key is required.")
    const inferenceKey = identity.key
    const inference = c.get("organization")?.metadata?.inference
    if (!isJsonObject(inference) || inference.enabled !== true) {
      return openAiError(403, "inference_disabled", "OpenWork Models are not enabled for this organization.")
    }

    const policyRejection = await managedModelsRejection(inferenceKey.organization_id)
    if (policyRejection) return policyRejection

    if (c.req.path === modelsPath && c.req.method === "GET") {
      return c.json(listOpenAiModels())
    }

    if (c.req.path !== chatCompletionsPath || c.req.method !== "POST") {
      return localRouteRejection(c.req.path, c.req.method)
    }

    const incomingHeaders = sanitizeIncomingHeaders(c.req.raw.headers)
    const startedAt = new Date()
    const upstreamPath = c.req.path.replace(/^\/api\/v1/, "")
    const upstreamUrl = new URL(`${env.openRouterUpstreamUrl}${upstreamPath}`)
    const recorder = createRequestLogRecorder({ insertRequestLog, updateRequestLog: dependencies.updateRequestLog, reporter })
    const startRecorder = (input: { incomingModel: string | null; upstreamModel: string | null; stream: boolean; requestBytes?: number }) => {
      recorder.start({
        identity: c.get("inference"),
        openworkRequestId,
        route: "openwork_openrouter",
        protocol: "openai_chat",
        upstreamProviderId: "openrouter",
        upstreamHost: upstreamUrl.hostname,
        upstreamPath: upstreamUrl.pathname,
        method: c.req.method,
        requestedModel: input.incomingModel,
        upstreamModel: input.upstreamModel,
        stream: input.stream,
        requestBytes: input.requestBytes,
        startedAt,
      })
    }
    const reject = (response: Response, errorCode: string) => {
      void recorder.finish({ status: response.status, outcome: "rejected", errorCode })
      response.headers.set("x-openwork-request-id", openworkRequestId)
      return response
    }

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
      startRecorder({ incomingModel: null, upstreamModel: null, stream: false })
      return reject(openAiError(400, "unsupported_query_parameters", "OpenWork chat completions does not accept query parameters."), "unsupported_query_parameters")
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
      startRecorder(prepared)
      return reject(prepared.error, prepared.errorCode)
    }
    startRecorder({ ...prepared, requestBytes: Buffer.byteLength(JSON.stringify(prepared.body)) })
    if (await recorder.whenStarted?.() === false) {
      return reject(openAiError(503, "request_log_unavailable", "Inference accounting is temporarily unavailable."), "request_log_unavailable")
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
      return reject(c.json({
        error: {
          message: `Rate limit reached for organization ${inferenceKey.organization_id}.`,
          type: "tokens",
          param: null,
          code: "rate_limit_exceeded",
        },
      }, 429), "rate_limit_exceeded")
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
      return reject(c.json({ error: { message: "No active OpenRouter provider key configured for organization.", type: "invalid_request_error", code: "missing_provider_key" } }, 400), "missing_provider_key")
    }

    // The provider validates n; only a valid requested cardinality constrains responses.
    const choiceCount = typeof prepared.body.n === "number" && Number.isSafeInteger(prepared.body.n) && prepared.body.n > 0 ? prepared.body.n : 1
    const analyticsStartedAt = Date.now()
    // Fail closed and bound the optional analytics check; it cannot hold up
    // inference when the analytics store is unavailable.
    let timer: ReturnType<typeof setTimeout> | undefined
    const analytics = await Promise.race([
      (async () => {
        const begin = await dependencies.analytics?.({ key: inferenceKey, request: c.req.raw, requestId: openworkRequestId, model: prepared.upstreamModel, startedAt: analyticsStartedAt })
        return begin?.(prepared.stream) ?? null
      })().catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 250) }),
    ]).finally(() => { if (timer) clearTimeout(timer) })
    const observeChunk = (bytes: Uint8Array) => {
      try { analytics?.chunk(bytes) } catch { /* Optional analytics cannot interrupt inference. */ }
    }
    const finishAnalytics = (status: Parameters<AnalyticsObserver["finish"]>[0]) => {
      try { analytics?.finish(c.req.raw.signal.aborted ? "cancelled" : status) } catch { /* Optional analytics cannot interrupt inference. */ }
    }
    let upstream: Response
    const abort = new AbortController()
    const abortError = () => c.req.raw.signal.aborted
      ? inferenceError("request_cancelled", "Request cancelled.")
      : abort.signal.aborted ? upstreamError(504) : null
    const cancel = () => abort.abort()
    c.req.raw.signal.addEventListener("abort", cancel, { once: true })
    if (c.req.raw.signal.aborted) abort.abort()
    const headerTimeout = setTimeout(() => abort.abort(), env.upstreamTimeoutMs)
    try {
      validateInferenceUrl(env.openRouterUpstreamUrl, { base: true })
      abort.signal.throwIfAborted()
      const upstreamInit: ProxyRequestInit = {
        method: c.req.method,
        headers: sanitizeHeaders(c.req.raw, providerKey.encrypted_api_key, openworkRequestId),
        body: JSON.stringify({ ...prepared.body, trace: { ...prepared.body.trace, usage_started_at: limits.admittedAt.toISOString() } }),
        duplex: "half",
        signal: abort.signal,
        redirect: "error",
      }
      // Re-read after every preparation await, immediately before the only dispatch.
      const dispatchRejection = await managedModelsRejection(inferenceKey.organization_id)
      if (dispatchRejection) {
        clearTimeout(headerTimeout)
        c.req.raw.signal.removeEventListener("abort", cancel)
        abort.abort()
        finishAnalytics("failed")
        return reject(dispatchRejection, "managed_models_policy_rejected")
      }
      upstream = await dependencies.fetch(upstreamUrl, upstreamInit)
    } catch {
      clearTimeout(headerTimeout)
      c.req.raw.signal.removeEventListener("abort", cancel)
      finishAnalytics("failed")
      const error = abortError() ?? inferenceError("upstream_unreachable", "The selected model could not be reached. Your work is preserved; retry when the provider recovers.")
      logProxyError("Failed to reach OpenRouter upstream", {
        openworkRequestId,
        organizationId: inferenceKey.organization_id,
        orgMembershipId: inferenceKey.org_membership_id,
        inferenceKeyId: inferenceKey.id,
        upstreamUrl: safeAccessUrl(upstreamUrl.toString()),
        modelAlias: prepared.modelAlias,
        upstreamModel: prepared.upstreamModel,
      })
      reporter.handledError({
        reason: error.error.code,
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
        upstreamUrl: safeAccessUrl(upstreamUrl.toString()),
      })
      void recorder.finish({ status: 502, outcome: c.req.raw.signal.aborted ? "client_aborted" : "upstream_unreachable", errorCode: error.error.code })
      return c.json(error, 502)
    }
    clearTimeout(headerTimeout)

    if (!upstream.ok) {
      finishAnalytics("failed")
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
          const payload = await readResponseJson(upstream.body, abort.signal, 65536)
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
      void recorder.finish({ status: upstream.status, outcome: "upstream_error", errorCode: error.error.code, upstreamRequestId: upstreamRequestId(upstream.headers) })
      return Response.json(error, { status: upstream.status, headers })
    }
    const contentType = upstream.headers.get("content-type")?.split(";")[0].trim().toLowerCase()
    if (prepared.stream) {
      if (contentType !== "text/event-stream" || !upstream.body) {
        finishAnalytics("failed")
        c.req.raw.signal.removeEventListener("abort", cancel)
        abort.abort()
        await upstream.body?.cancel().catch(() => {})
        void recorder.finish({ status: 502, outcome: "upstream_error", errorCode: "upstream_malformed_stream" })
        return Response.json(inferenceError("upstream_malformed_stream", "The model did not return a response stream. Retry the selected model."), { status: 502, headers })
      }
      headers.set("content-type", "text/event-stream; charset=utf-8")
      headers.set("x-accel-buffering", "no")
      const usageParser = createOpenAiChatSseUsageParser()
      const usageDecoder = new TextDecoder()
      return new Response(relayChatStream({
        body: upstream.body, abort, startedAt: analyticsStartedAt, idleMs: env.streamIdleMs, choiceCount,
        onChunk(bytes) {
          observeChunk(bytes)
          recorder.markFirstByte()
          usageParser.push(usageDecoder.decode(bytes, { stream: true }))
        },
        onFinish(result) {
          c.req.raw.signal.removeEventListener("abort", cancel)
          finishAnalytics(result.outcome === "completed" ? "completed" : result.outcome === "cancelled" ? "cancelled" : "failed")
          recordUsage(recorder, usageParser.result(), "stream")
          void recorder.finish({ status: upstream.status, outcome: result.outcome === "completed" ? "ok" : result.outcome === "cancelled" ? "client_aborted" : "upstream_error", errorCode: result.code, responseBytes: result.responseBytes, upstreamRequestId: upstreamRequestId(upstream.headers) })
          try {
            reporter.completion?.({ ...result, openworkRequestId, organizationId: inferenceKey.organization_id, orgMembershipId: inferenceKey.org_membership_id, modelAlias: prepared.modelAlias })
          } catch { /* Completion reporting must not interrupt stream cleanup. */ }
        },
      }), { headers })
    }
    // Bound non-streaming bodies too. An HTTP 200 without a terminal choice is
    // not a completed inference response.
    const bodyTimeout = setTimeout(() => abort.abort(), env.upstreamTimeoutMs)
    try {
      const value = await readResponseJson(upstream.body, abort.signal)
      recorder.markFirstByte()
      recordUsage(recorder, parseOpenAiChatJsonUsage(value), "json")
      if (analytics) observeChunk(new TextEncoder().encode(JSON.stringify(value)))
      if (!completeChatResponse(value, choiceCount)) {
        finishAnalytics("failed")
        void recorder.finish({ status: 502, outcome: "upstream_error", errorCode: "upstream_incomplete" })
        return Response.json(inferenceError("upstream_incomplete", "The model returned an incomplete response. Review your work before retrying."), { status: 502, headers })
      }
      const response = Response.json(value, { headers })
      finishAnalytics("completed")
      void recorder.finish({ status: upstream.status, outcome: "ok", responseBytes: Buffer.byteLength(JSON.stringify(value)), upstreamRequestId: upstreamRequestId(upstream.headers) })
      return response
    } catch {
      finishAnalytics("failed")
      void recorder.finish({ status: 502, outcome: c.req.raw.signal.aborted ? "client_aborted" : "upstream_error", errorCode: abortError()?.error.code ?? "upstream_malformed_response" })
      return Response.json(abortError() ?? inferenceError("upstream_malformed_response", "The model response was interrupted or malformed. Review your work before retrying."), { status: 502, headers })
    } finally {
      clearTimeout(bodyTimeout)
      c.req.raw.signal.removeEventListener("abort", cancel)
      abort.abort()
    }
  }

  const authenticateModels = inferenceAuth({ findActiveInferenceKey: dependencies.findActiveInferenceKey })
  const authenticateGateway = gatewayAuth({ findActiveGatewayKey: dependencies.findActiveGatewayKey ?? (async (key) => (await import("./keys.js")).findActiveGatewayKey(key)) })
  api.use("/api/v1/*", createMiddleware<InferenceAuthEnv>((c, next) => c.req.path.startsWith("/api/v1/providers/")
    ? authenticateGateway(c, next) : authenticateModels(c, next)))
  api.use("/api/v1/*", orgContext({ loadOrganization: dependencies.loadOrganization ?? loadOrganizationFromDb }))
  registerGatewayRoutes(api, { fetch: dependencies.fetch, insertRequestLog, updateRequestLog: dependencies.updateRequestLog, reporter, ...dependencies.gateway })
  for (const path of ["/api/v1", "/api/v1/*"]) {
    api.all(path, handleApiRequest)
  }
  app.route("/", api)
}
