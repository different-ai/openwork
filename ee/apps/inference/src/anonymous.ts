// Request validation, routing, and conservative response accounting reused from
// #4621 (401267fc). The desktop proof/status layer is specific to this follow-up.
import { createHash, randomUUID } from "node:crypto"
import type { Context, Hono } from "hono"
import { z } from "zod"
import {
  DESKTOP_FREE_MODEL_ID as anonymousModel,
  DESKTOP_FREE_PROVIDER_ID,
  DESKTOP_FREE_SESSION_PATH as sessionPath,
  DESKTOP_FREE_STATUS_PATH as statusPath,
  DESKTOP_FREE_MODELS_PATH as modelsPath,
  DESKTOP_FREE_CHAT_PATH as chatPath,
  type DesktopFreeAccessStatus,
} from "@openwork/types/desktop-free-access"
import { managedModelCatalog } from "@openwork/types/den/inference"
import type {
  consumeAnonymousSessionIssuance, reserveAnonymousInference, settleAnonymousInference,
  validateAnonymousDispatch, readAnonymousAllowance, TrustedAnonymousUsage,
} from "./anonymous-limits.js"
import { createAnonymousIdentities, issueAnonymousToken, resolveAnonymousClientAddress, verifyAnonymousToken } from "./anonymous-identity.js"
import { checkDesktopFreeRequest, desktopFreeVersionResponse, type DesktopFreeGateDependencies } from "./desktop-free-access.js"
import { desktopFreeHash } from "./desktop-free-proof.js"
import { env } from "./env.js"

const sessionSchema = z.object({ installationId: z.string().uuid() }).strict()
const policyFields = new Set([
  "models", "fallbacks", "preset", "route", "provider", "plugins", "transforms", "reasoning",
  "web_search_options", "user", "session_id", "trace", "service_tier",
])
const allowedTopLevelFields = new Set([
  "model", "messages", "stream", "max_tokens", "max_completion_tokens", "temperature", "top_p",
  "frequency_penalty", "presence_penalty", "stop", "seed", "n", "tools", "tool_choice",
  "response_format", "parallel_tool_calls", "usage", "reasoningEffort", "textVerbosity",
])
const sdkTextVerbosityValues = new Set(["low", "medium", "high"])
type JsonObject = Record<string, unknown>
type PreparedAnonymousRequest = { body: string; stream: boolean }

type AnonymousRouteDependencies = {
  fetch: typeof fetch
  clientAddress: (context: Context) => string | null
  consumeSessionIssuance: typeof consumeAnonymousSessionIssuance
  reserve: typeof reserveAnonymousInference
  settle: typeof settleAnonymousInference
  validateDispatch: typeof validateAnonymousDispatch
  readAllowance: typeof readAnonymousAllowance
  gate?: DesktopFreeGateDependencies
}

const defaultDependencies: AnonymousRouteDependencies = {
  fetch,
  clientAddress: resolveAnonymousClientAddress,
  async consumeSessionIssuance(...args) { return (await import("./anonymous-limits.js")).consumeAnonymousSessionIssuance(...args) },
  async reserve(...args) { return (await import("./anonymous-limits.js")).reserveAnonymousInference(...args) },
  async settle(...args) { return (await import("./anonymous-limits.js")).settleAnonymousInference(...args) },
  async validateDispatch(...args) { return (await import("./anonymous-limits.js")).validateAnonymousDispatch(...args) },
  async readAllowance(...args) { return (await import("./anonymous-limits.js")).readAnonymousAllowance(...args) },
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function openAiError(status: number, code: string, message: string, type = "invalid_request_error") {
  return Response.json({ error: { code, message, type } }, { status, headers: { "cache-control": "no-store" } })
}

function unavailable() {
  return openAiError(503, "anonymous_unavailable", "OpenWork's free allowance is temporarily unavailable. Please try again later.", "api_error")
}

function invalidToken() {
  return openAiError(401, "invalid_anonymous_token", "This OpenWork free allowance token is invalid or expired.", "authentication_error")
}

function modelNotAllowed(message = "OpenWork's free allowance only supports GPT-5.6 Luna and does not allow alternate routing.") {
  return openAiError(403, "anonymous_model_not_allowed", message)
}

function admissionError(result: { reason: "limit" | "capacity" | "unavailable"; retryAfterSeconds?: number }) {
  if (result.reason === "unavailable") return unavailable()
  const capacity = result.reason === "capacity"
  const response = openAiError(429, capacity ? "anonymous_capacity_exceeded" : "anonymous_limit_exceeded",
    capacity ? "OpenWork's free allowance is at capacity. Please try again later."
      : "This request's safety reservation does not fit, or a free allowance rate limit was reached. Please try again after the limit resets.",
    "rate_limit_error")
  if (result.retryAfterSeconds) response.headers.set("retry-after", String(result.retryAfterSeconds))
  return response
}

export async function readBoundedJson(request: Request, maxBytes: number, deadlineAt: number): Promise<
  { error: Response } | { value: unknown; size: number; bodyHash: string }
> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (contentType !== "application/json" || request.headers.get("content-encoding")) {
    return { error: openAiError(400, "invalid_request", "OpenWork's free allowance accepts uncompressed JSON requests only.") }
  }
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { error: openAiError(400, "invalid_request", "The request is too large for the OpenWork free allowance.") }
  }
  if (!request.body) return { error: openAiError(400, "invalid_request", "A JSON request body is required for the OpenWork free allowance.") }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    if (request.signal.aborted || Date.now() >= deadlineAt) {
      void reader.cancel().catch(() => undefined)
      return { error: unavailable() }
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    let abortListener: (() => void) | undefined
    const chunk = await Promise.race([
      reader.read().then((result) => ({ result })),
      new Promise<{ timedOut: true }>((resolve) => {
        timeout = setTimeout(() => resolve({ timedOut: true }), Math.max(1, deadlineAt - Date.now()))
      }),
      new Promise<{ aborted: true }>((resolve) => {
        abortListener = () => resolve({ aborted: true })
        if (request.signal.aborted) { resolve({ aborted: true }); return }
        request.signal.addEventListener("abort", abortListener, { once: true })
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout)
      if (abortListener) request.signal.removeEventListener("abort", abortListener)
    })
    if ("timedOut" in chunk || "aborted" in chunk) {
      void reader.cancel().catch(() => undefined)
      return { error: unavailable() }
    }
    const { result } = chunk
    if (result.done) break
    size += result.value.byteLength
    if (size > maxBytes) {
      void reader.cancel().catch(() => undefined)
      return { error: openAiError(400, "invalid_request", "The request is too large for the OpenWork free allowance.") }
    }
    chunks.push(result.value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    return { value, size, bodyHash: desktopFreeHash(bytes) }
  } catch {
    return { error: openAiError(400, "invalid_request", "The JSON request is invalid for the OpenWork free allowance.") }
  }
}

function hasOnlyFields(value: JsonObject, fields: Set<string>) {
  return Object.keys(value).every((field) => fields.has(field))
}

function isBoundedString(value: unknown, max = 65_536): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= max
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 24) return false
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, depth + 1))
  if (!isObject(value)) return false
  if (Object.prototype.hasOwnProperty.call(value, "$ref")) return false
  return Object.values(value).every((entry) => isJsonValue(entry, depth + 1))
}

function validContent(value: unknown) {
  if (typeof value === "string" || value === null) return true
  if (!Array.isArray(value)) return false
  return value.every((part) => isObject(part) && hasOnlyFields(part, new Set(["type", "text"]))
    && (part.type === "text" || part.type === "input_text") && isBoundedString(part.text))
}

function validToolCalls(value: unknown) {
  if (value === undefined) return true
  if (!Array.isArray(value) || value.length > 64) return false
  return value.every((call) => isObject(call)
    && hasOnlyFields(call, new Set(["id", "type", "function", "index"]))
    && isBoundedString(call.id, 256) && call.type === "function"
    && (call.index === undefined || (Number.isInteger(call.index) && Number(call.index) >= 0))
    && isObject(call.function) && hasOnlyFields(call.function, new Set(["name", "arguments"]))
    && isBoundedString(call.function.name, 256) && isBoundedString(call.function.arguments))
}

function validMessages(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) return false
  const roles = new Set(["system", "developer", "user", "assistant", "tool"])
  const fields = new Set(["role", "content", "name", "tool_call_id", "tool_calls", "refusal"])
  return value.every((message) => isObject(message) && hasOnlyFields(message, fields)
    && typeof message.role === "string" && roles.has(message.role) && validContent(message.content)
    && (message.name === undefined || isBoundedString(message.name, 256))
    && (message.tool_call_id === undefined || isBoundedString(message.tool_call_id, 256))
    && (message.refusal === undefined || isBoundedString(message.refusal)) && validToolCalls(message.tool_calls))
}

function validTools(value: unknown) {
  if (value === undefined) return true
  if (!Array.isArray(value) || value.length > 64) return false
  return value.every((tool) => isObject(tool) && hasOnlyFields(tool, new Set(["type", "function"]))
    && tool.type === "function" && isObject(tool.function)
    && hasOnlyFields(tool.function, new Set(["name", "description", "parameters", "strict"]))
    && isBoundedString(tool.function.name, 256)
    && (tool.function.description === undefined || isBoundedString(tool.function.description, 8_192))
    && (tool.function.parameters === undefined || (isObject(tool.function.parameters) && isJsonValue(tool.function.parameters)))
    && (tool.function.strict === undefined || typeof tool.function.strict === "boolean"))
}

function validToolChoice(value: unknown) {
  if (value === undefined || value === "none" || value === "auto" || value === "required") return true
  return isObject(value) && hasOnlyFields(value, new Set(["type", "function"])) && value.type === "function"
    && isObject(value.function) && hasOnlyFields(value.function, new Set(["name"])) && isBoundedString(value.function.name, 256)
}

function validUsage(value: unknown) {
  return value === undefined || (isObject(value) && hasOnlyFields(value, new Set(["include"])) && value.include === true)
}

function validResponseFormat(value: unknown) {
  if (value === undefined) return true
  if (!isObject(value) || !hasOnlyFields(value, new Set(["type", "json_schema"]))) return false
  if (value.type === "text" || value.type === "json_object") return value.json_schema === undefined
  if (value.type !== "json_schema" || !isObject(value.json_schema)) return false
  return hasOnlyFields(value.json_schema, new Set(["name", "description", "schema", "strict"]))
    && isBoundedString(value.json_schema.name, 256)
    && (value.json_schema.description === undefined || isBoundedString(value.json_schema.description, 8_192))
    && isObject(value.json_schema.schema) && isJsonValue(value.json_schema.schema)
    && (value.json_schema.strict === undefined || typeof value.json_schema.strict === "boolean")
}

function optionalInteger(value: unknown, min: number, max: number) {
  return value === undefined || (Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max)
}

function prepareAnonymousBody(value: unknown): PreparedAnonymousRequest | Response {
  if (!isObject(value)) return openAiError(400, "invalid_request", "The OpenWork free allowance request must be a JSON object.")
  const policyField = Object.keys(value).find((field) => policyFields.has(field))
  if (policyField) return modelNotAllowed(`OpenWork's free allowance does not allow ${policyField} overrides.`)
  const unknownField = Object.keys(value).find((field) => !allowedTopLevelFields.has(field))
  if (unknownField) return openAiError(400, "invalid_request", `The field ${unknownField} is not supported by the OpenWork free allowance.`)
  if (value.model !== anonymousModel) return modelNotAllowed()
  if (!validMessages(value.messages)) return openAiError(400, "invalid_request", "Messages must contain bounded text-only content for the OpenWork free allowance.")
  if (!validTools(value.tools)) return modelNotAllowed("OpenWork's free allowance permits client-side function tools only; server tools and remote media are not allowed.")
  if (!validToolChoice(value.tool_choice) || !validResponseFormat(value.response_format)) {
    return openAiError(400, "invalid_request", "The requested response or tool format is invalid for the OpenWork free allowance.")
  }
  if (!validUsage(value.usage)) return openAiError(400, "invalid_request", "The requested usage format is invalid for the OpenWork free allowance.")
  if (value.stream !== undefined && typeof value.stream !== "boolean") return openAiError(400, "invalid_request", "stream must be a boolean.")
  if (value.n !== undefined && value.n !== 1) return modelNotAllowed("OpenWork's free allowance supports exactly one completion per request.")
  if (!optionalInteger(value.max_tokens, 1, env.anonymous.maxCompletionTokens)
    || !optionalInteger(value.max_completion_tokens, 1, env.anonymous.maxCompletionTokens)
    || (value.max_tokens !== undefined && value.max_completion_tokens !== undefined)) {
    return openAiError(400, "invalid_request", `OpenWork's free allowance allows at most ${env.anonymous.maxCompletionTokens} billable completion tokens.`)
  }
  if (value.reasoningEffort !== undefined && typeof value.reasoningEffort !== "string") {
    return openAiError(400, "invalid_request", "reasoningEffort must be the fixed none compatibility value.")
  }
  if (value.reasoningEffort !== undefined && value.reasoningEffort !== "none") {
    return modelNotAllowed("OpenWork's free allowance fixes reasoning effort to none and mode to standard.")
  }
  if (value.textVerbosity !== undefined && (typeof value.textVerbosity !== "string" || !sdkTextVerbosityValues.has(value.textVerbosity))) {
    return openAiError(400, "invalid_request", "textVerbosity must be low, medium, or high.")
  }
  const unsupportedGenerationField = ["temperature", "top_p", "frequency_penalty", "presence_penalty", "stop", "parallel_tool_calls"].find((field) => value[field] !== undefined)
  if (unsupportedGenerationField) return openAiError(400, "invalid_request", `The field ${unsupportedGenerationField} is not supported by GPT-5.6 Luna.`)
  if (!optionalInteger(value.seed, -2_147_483_648, 2_147_483_647)) return openAiError(400, "invalid_request", "A numeric generation setting is outside the OpenWork free allowance bounds.")

  const stream = value.stream === true
  const maxTokens = typeof value.max_tokens === "number" ? value.max_tokens
    : typeof value.max_completion_tokens === "number" ? value.max_completion_tokens : env.anonymous.maxCompletionTokens
  const forwarded: JsonObject = {
    model: anonymousModel, messages: value.messages, stream, max_tokens: maxTokens,
    reasoning: { effort: "none", mode: "standard", exclude: true }, usage: { include: true },
    provider: {
      order: [env.anonymous.provider], only: [env.anonymous.provider], allow_fallbacks: false,
      require_parameters: true, data_collection: "deny", zdr: true,
      max_price: {
        prompt: env.anonymous.maxInputPriceMicroUsdPerMillion / 1_000_000,
        completion: env.anonymous.maxCompletionPriceMicroUsdPerMillion / 1_000_000, request: 0, image: 0,
      },
    },
  }
  // Luna does not advertise n. Omit its default; n !== 1 was rejected above.
  for (const field of ["seed", "tool_choice", "response_format"]) {
    if (value[field] !== undefined) forwarded[field] = value[field]
  }
  if (value.textVerbosity !== undefined) forwarded.verbosity = value.textVerbosity
  if (stream) forwarded.stream_options = { include_usage: true }
  // Canonical byte cap leaves an explicit allowance for provider framing.
  // Trusted usage overruns trip the durable kill switch rather than refunding.
  const canonicalPayloadLimit = env.anonymous.maxInputTokens - env.anonymous.chatWrappingTokenAllowance
  if (value.tools !== undefined) forwarded.tools = value.tools
  const body = JSON.stringify(forwarded)
  if (canonicalPayloadLimit <= 0 || Buffer.byteLength(body, "utf8") > canonicalPayloadLimit) {
    return openAiError(400, "invalid_request", "The canonical chat and tool context is too large for the OpenWork free allowance.")
  }
  return { body, stream }
}

function readTrustedUsage(value: unknown): TrustedAnonymousUsage | null {
  if (!isObject(value) || !isObject(value.usage)) return null
  const usage = value.usage
  if (typeof usage.cost !== "number" || !Number.isFinite(usage.cost) || usage.cost < 0) return null
  if (typeof usage.is_byok !== "boolean") return null
  if (!Number.isSafeInteger(usage.prompt_tokens) || Number(usage.prompt_tokens) < 0) return null
  if (!Number.isSafeInteger(usage.completion_tokens) || Number(usage.completion_tokens) < 0) return null
  const completionTokens = Number(usage.completion_tokens)
  let reasoningTokens = 0
  if (isObject(usage.completion_tokens_details) && usage.completion_tokens_details.reasoning_tokens !== undefined) {
    if (!Number.isSafeInteger(usage.completion_tokens_details.reasoning_tokens) || Number(usage.completion_tokens_details.reasoning_tokens) < 0) return null
    reasoningTokens = Number(usage.completion_tokens_details.reasoning_tokens)
  }
  if (reasoningTokens > completionTokens) return null
  // BYOK fee alone is not the principal cost. Missing/non-BYOK usage retains
  // the full reservation, never refunding from an incomplete receipt.
  if (!usage.is_byok || !isObject(usage.cost_details)
    || typeof usage.cost_details.upstream_inference_cost !== "number"
    || !Number.isFinite(usage.cost_details.upstream_inference_cost) || usage.cost_details.upstream_inference_cost < 0) return null
  const totalCost = usage.cost + usage.cost_details.upstream_inference_cost
  if (!Number.isFinite(totalCost)) return null
  const costMicroUsd = Math.ceil(totalCost * 1_000_000)
  if (!Number.isSafeInteger(costMicroUsd)) return null
  return { costMicroUsd, inputTokens: Number(usage.prompt_tokens), billableCompletionTokens: completionTokens }
}

async function readBoundedResponseJson(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    bytes += chunk.value.byteLength
    if (bytes > env.anonymous.maxResponseBytes) { await reader.cancel(); return null }
    chunks.push(chunk.value)
  }
  const body = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))
    if (!isObject(parsed)) return null
    const usage = readTrustedUsage(parsed)
    const publicBody = new TextEncoder().encode(JSON.stringify(publicAnonymousResponse(parsed)))
    if (publicBody.byteLength > env.anonymous.maxResponseBytes) return null
    return { body: publicBody, usage }
  } catch { return null }
}

function publicAnonymousUsage(value: unknown) {
  if (!isObject(value)) return null
  const usage: JsonObject = {}
  for (const field of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
    if (Number.isSafeInteger(value[field]) && Number(value[field]) >= 0) usage[field] = value[field]
  }
  if (isObject(value.prompt_tokens_details) && Number.isSafeInteger(value.prompt_tokens_details.cached_tokens) && Number(value.prompt_tokens_details.cached_tokens) >= 0) {
    usage.prompt_tokens_details = { cached_tokens: value.prompt_tokens_details.cached_tokens }
  }
  if (isObject(value.completion_tokens_details) && Number.isSafeInteger(value.completion_tokens_details.reasoning_tokens) && Number(value.completion_tokens_details.reasoning_tokens) >= 0) {
    usage.completion_tokens_details = { reasoning_tokens: value.completion_tokens_details.reasoning_tokens }
  }
  return usage
}

function publicAnonymousResponse(value: JsonObject) {
  const usage = publicAnonymousUsage(value.usage)
  return usage ? { ...value, usage } : value
}

function trackAnonymousStream(input: {
  body: ReadableStream<Uint8Array>
  controller: AbortController
  finalize: (usage: TrustedAnonymousUsage | null) => Promise<void>
}) {
  const reader = input.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  let bytes = 0
  let usage: TrustedAnonymousUsage | null = null
  const transform = (text: string) => {
    buffer += text.replaceAll("\r\n", "\n")
    let output = ""
    while (true) {
      const boundary = buffer.indexOf("\n\n")
      if (boundary < 0) break
      const frame = buffer.slice(0, boundary).replaceAll("\r", "")
      buffer = buffer.slice(boundary + 2)
      const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")
      if (!data || data === "[DONE]") { output += `${frame}\n\n`; continue }
      try {
        const parsed: unknown = JSON.parse(data)
        const found = readTrustedUsage(parsed)
        if (found) usage = found
        output += isObject(parsed) && publicAnonymousUsage(parsed.usage)
          ? `data: ${JSON.stringify(publicAnonymousResponse(parsed))}\n\n` : `${frame}\n\n`
      } catch { output += `${frame}\n\n` }
    }
    if (Buffer.byteLength(buffer, "utf8") > 262_144) buffer = ""
    return output
  }
  return new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) {
            const output = transform(decoder.decode()) + buffer
            buffer = ""
            if (output) stream.enqueue(encoder.encode(output))
            await input.finalize(usage)
            stream.close()
            return
          }
          bytes += chunk.value.byteLength
          if (bytes > env.anonymous.maxResponseBytes) {
            input.controller.abort()
            await input.finalize(null)
            stream.error(new Error("Anonymous inference response exceeded its safety bound"))
            return
          }
          const output = transform(decoder.decode(chunk.value, { stream: true }))
          if (output) { stream.enqueue(encoder.encode(output)); return }
        }
      } catch (error) { await input.finalize(null); stream.error(error) }
    },
    async cancel(reason) { input.controller.abort(); await input.finalize(null); await reader.cancel(reason) },
  })
}

function requestId() {
  return createHash("sha256").update(`${Date.now()}:${randomUUID()}`, "utf8").digest("hex")
}

function readBearer(request: Request) {
  const header = request.headers.get("authorization")
  if (!header?.toLowerCase().startsWith("bearer ")) return null
  return header.slice(7).trim() || null
}

export function registerAnonymousInferenceRoutes(app: Hono, dependencies: AnonymousRouteDependencies = defaultDependencies) {
  app.use("/api/anonymous/*", async (c, next) => { c.header("cache-control", "no-store"); await next() })
  app.post(sessionPath, async (c) => {
    const requestDeadline = Date.now() + env.anonymous.requestTimeoutMs
    if (new URL(c.req.url).search) return modelNotAllowed()
    const parsedBody = await readBoundedJson(c.req.raw, 4_096, requestDeadline)
    if ("error" in parsedBody) return parsedBody.error
    const parsed = sessionSchema.safeParse(parsedBody.value)
    if (!parsed.success) return openAiError(400, "invalid_request", "A valid installationId UUID is required for the OpenWork free allowance.")
    const gate = await checkDesktopFreeRequest(c.req.raw, parsedBody.bodyHash, undefined, dependencies.gate)
    if ("error" in gate) return gate.error
    if (gate.versionError) return desktopFreeVersionResponse(gate.versionError)
    if (!env.anonymous.enabled) return unavailable()
    try {
      const address = dependencies.clientAddress(c)
      if (!address) return unavailable()
      const identities = createAnonymousIdentities(gate.proof, address)
      if (c.req.raw.signal.aborted || Date.now() >= requestDeadline) return unavailable()
      const admitted = await dependencies.consumeSessionIssuance(identities, { deadlineAt: requestDeadline, signal: c.req.raw.signal })
      if (!admitted.ok) return admissionError(admitted)
      if (c.req.raw.signal.aborted || Date.now() >= requestDeadline) return unavailable()
      return c.json({ ...issueAnonymousToken(identities, gate.proof), model: anonymousModel })
    } catch { return unavailable() }
  })

  async function authenticate(c: Context, bodyHash: string): Promise<{ error: Response } | (
    Extract<Awaited<ReturnType<typeof checkDesktopFreeRequest>>, { proof: unknown }>
    & { identities: NonNullable<ReturnType<typeof verifyAnonymousToken>> }
  )> {
    try {
      const address = dependencies.clientAddress(c)
      const bearer = readBearer(c.req.raw)
      if (!address || !bearer) return { error: invalidToken() }
      const token = verifyAnonymousToken(bearer, address)
      if (!token) return { error: invalidToken() }
      const gate = await checkDesktopFreeRequest(c.req.raw, bodyHash, token, dependencies.gate)
      if ("error" in gate) return gate
      return { ...gate, identities: token }
    } catch { return { error: unavailable() } }
  }

  app.get(statusPath, async (c) => {
    const authentication = await authenticate(c, desktopFreeHash(""))
    if ("error" in authentication) return authentication.error
    if (new URL(c.req.url).search) return modelNotAllowed()
    const status: DesktopFreeAccessStatus = {
      state: "unavailable", code: "anonymous_unavailable", currentVersion: authentication.proof.appVersion,
      minimumVersion: authentication.minimumVersion, providerID: DESKTOP_FREE_PROVIDER_ID, modelID: anonymousModel, allowance: null,
      // Discovery only: paid recommendations do not extend this route's model
      // allowlist or create connected provider credentials for a guest.
      catalog: managedModelCatalog({ freeModelID: anonymousModel }),
    }
    if (authentication.versionError) {
      status.state = authentication.versionError.code === "desktop_update_required" ? "update_required" : "unavailable"
      status.code = authentication.versionError.code
    } else if (env.anonymous.enabled) {
      try { Object.assign(status, await dependencies.readAllowance(authentication.identities)) } catch { /* Remain unavailable; never generate. */ }
    }
    return c.json(status)
  })

  app.get(modelsPath, async (c) => {
    const authentication = await authenticate(c, desktopFreeHash(""))
    if ("error" in authentication) return authentication.error
    if (authentication.versionError) return desktopFreeVersionResponse(authentication.versionError)
    if (!env.anonymous.enabled) return unavailable()
    if (new URL(c.req.url).search) return modelNotAllowed("OpenWork's free allowance does not allow model query overrides.")
    return c.json({ object: "list", data: [{ id: anonymousModel, object: "model", created: 0, owned_by: "openwork" }] })
  })

  app.post(chatPath, async (c) => {
    const requestDeadline = Date.now() + env.anonymous.requestTimeoutMs
    const parsedBody = await readBoundedJson(c.req.raw, env.anonymous.maxBodyBytes, requestDeadline)
    if ("error" in parsedBody) return parsedBody.error
    const authentication = await authenticate(c, parsedBody.bodyHash)
    if ("error" in authentication) return authentication.error
    if (authentication.versionError) return desktopFreeVersionResponse(authentication.versionError)
    if (!env.anonymous.enabled) return unavailable()
    if (new URL(c.req.url).search) return modelNotAllowed("OpenWork's free allowance does not allow routing query parameters.")
    const prepared = prepareAnonymousBody(parsedBody.value)
    if (prepared instanceof Response) return prepared
    if (c.req.raw.signal.aborted || Date.now() >= requestDeadline) return unavailable()
    const id = requestId()
    let admitted: Awaited<ReturnType<typeof dependencies.reserve>>
    try {
      admitted = await dependencies.reserve({ id, identities: authentication.identities, deadlineAt: requestDeadline, signal: c.req.raw.signal })
    } catch { return unavailable() }
    if (!admitted.ok) return admissionError(admitted)

    const controller = new AbortController()
    let retainedSettlement: Promise<void> | null = null
    let usageSettlement: Promise<void> | null = null
    const finalize = (usage: TrustedAnonymousUsage | null) => {
      if (usage) {
        usageSettlement ??= dependencies.settle(admitted.reservationId, usage).then(() => undefined).catch(() => undefined)
        return usageSettlement
      }
      if (usageSettlement) return usageSettlement
      retainedSettlement ??= dependencies.settle(admitted.reservationId, null).then(() => undefined).catch(() => undefined)
      return retainedSettlement
    }
    const abort = () => { controller.abort(); void finalize(null) }
    c.req.raw.signal.addEventListener("abort", abort, { once: true })
    if (c.req.raw.signal.aborted) abort()
    let dispatchable = false
    try {
      dispatchable = !controller.signal.aborted
        && await dependencies.validateDispatch(admitted.reservationId, admitted.dispatchDeadline, controller.signal)
        && !controller.signal.aborted && Date.now() < admitted.dispatchDeadline
    } catch { dispatchable = false }
    if (!dispatchable) { c.req.raw.signal.removeEventListener("abort", abort); await finalize(null); return unavailable() }
    const timeoutMs = admitted.dispatchDeadline - Date.now()
    if (timeoutMs <= 0) { c.req.raw.signal.removeEventListener("abort", abort); await finalize(null); return unavailable() }
    const timeout = setTimeout(() => { controller.abort(); void finalize(null) }, timeoutMs)
    if (controller.signal.aborted || Date.now() >= admitted.dispatchDeadline) {
      clearTimeout(timeout); c.req.raw.signal.removeEventListener("abort", abort); await finalize(null); return unavailable()
    }

    let upstream: Response
    try {
      upstream = await dependencies.fetch(`${env.openRouterUpstreamUrl}/chat/completions`, {
        method: "POST", redirect: "error",
        headers: {
          accept: prepared.stream ? "text/event-stream" : "application/json", authorization: `Bearer ${env.anonymous.apiKey}`,
          "content-type": "application/json", "x-openwork-request-id": id,
          ...(env.proxyBaseUrl ? { "http-referer": env.proxyBaseUrl } : {}), "x-title": "OpenWork Free Allowance",
        },
        body: prepared.body, signal: controller.signal,
      })
    } catch {
      clearTimeout(timeout); c.req.raw.signal.removeEventListener("abort", abort); await finalize(null); return unavailable()
    }
    if (!upstream.ok || !upstream.body) {
      clearTimeout(timeout); c.req.raw.signal.removeEventListener("abort", abort)
      await upstream.body?.cancel().catch(() => undefined); await finalize(null); return unavailable()
    }
    const upstreamContentType = upstream.headers.get("content-type")?.toLowerCase() ?? ""
    if ((prepared.stream && !upstreamContentType.startsWith("text/event-stream")) || (!prepared.stream && !upstreamContentType.startsWith("application/json"))) {
      clearTimeout(timeout); c.req.raw.signal.removeEventListener("abort", abort); controller.abort()
      await upstream.body.cancel().catch(() => undefined); await finalize(null); return unavailable()
    }
    const headers = new Headers({
      "cache-control": "no-store", "content-type": upstream.headers.get("content-type") ?? (prepared.stream ? "text/event-stream" : "application/json"),
      "x-openwork-request-id": id,
    })
    if (!prepared.stream) {
      let result: Awaited<ReturnType<typeof readBoundedResponseJson>> = null
      try { result = await readBoundedResponseJson(upstream) } catch { /* Unknown/partial usage retains the reservation. */ }
      clearTimeout(timeout); c.req.raw.signal.removeEventListener("abort", abort)
      if (!result) { controller.abort(); await finalize(null); return unavailable() }
      await finalize(result.usage)
      return new Response(result.body, { status: upstream.status, headers })
    }
    const body = trackAnonymousStream({ body: upstream.body, controller,
      finalize: async (usage) => { clearTimeout(timeout); c.req.raw.signal.removeEventListener("abort", abort); await finalize(usage) },
    })
    return new Response(body, { status: upstream.status, headers })
  })

  app.all("/api/anonymous", (c) => modelNotAllowed(`OpenWork's free allowance does not support ${c.req.method} ${c.req.path}.`))
  app.all("/api/anonymous/*", (c) => modelNotAllowed(`OpenWork's free allowance does not support ${c.req.method} ${c.req.path}.`))
}
