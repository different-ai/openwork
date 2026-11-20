/**
 * How much output a request may ask a model for.
 *
 * Clients send a cap (`max_tokens` and its relatives) that they work out from
 * the model's known output limit, or from a default when they know none. A
 * provider rejects the whole request when the cap is above what the model
 * allows. Two rules keep that from reaching people:
 *
 *   1. A cap above the model's known limit is lowered to it before sending.
 *   2. When the provider still rejects the cap, the request is sent once more
 *      with the limit the provider named, or with no cap where the protocol
 *      allows that, and the named limit is remembered for the model.
 *
 * A cap is only ever lowered or removed, never raised or added.
 */
import type { GatewayRequestProtocol } from "@openwork/types/den/gateway"

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null
}

type CapField = { holder: JsonObject; key: string; value: number }

/** Where each protocol carries its output cap. */
function capFields(json: JsonObject, protocol: GatewayRequestProtocol): CapField[] {
  const read = (holder: unknown, keys: readonly string[]): CapField[] => isJsonObject(holder)
    ? keys.flatMap((key) => { const value = positiveInt(holder[key]); return value === null ? [] : [{ holder, key, value }] })
    : []
  switch (protocol) {
    case "openai_chat": return read(json, ["max_tokens", "max_completion_tokens"])
    case "openai_responses": return read(json, ["max_output_tokens"])
    case "anthropic_messages": return read(json, ["max_tokens"])
    case "google_generate_content": return read(json.generationConfig, ["maxOutputTokens"])
    case "bedrock_converse": return read(json.inferenceConfig, ["maxTokens"])
    case "passthrough": return []
  }
}

/** The output limit saved with a model (models.dev shape), or null when none is known. */
export function modelOutputLimit(config: unknown): number | null {
  return isJsonObject(config) && isJsonObject(config.limit) ? positiveInt(config.limit.output) : null
}

/** The largest output cap in the request, or null when it sets none. */
export function requestedOutputCap(json: JsonObject, protocol: GatewayRequestProtocol): number | null {
  const values = capFields(json, protocol).map((field) => field.value)
  return values.length ? Math.max(...values) : null
}

/** Lowers every cap above `limit` to it. Returns whether the request changed. */
export function fitOutputCap(json: JsonObject, protocol: GatewayRequestProtocol, limit: number | null): boolean {
  if (limit === null) return false
  let changed = false
  for (const field of capFields(json, protocol)) {
    if (field.value <= limit) continue
    field.holder[field.key] = limit
    changed = true
  }
  return changed
}

const CAP_NAME = /max(?:imum)?[_ ]?(?:completion[_ ]|output[_ ])?tokens|maxOutputTokens|maxTokens|output tokens|completion tokens/i
const CAP_REFUSED = /too large|too high|exceed|at most|maximum|must be (?:less|<=|at most|between)|greater than|out of range|>\s*\d/i
/** How providers name the limit they enforce, most specific first. */
const NAMED_LIMIT = [/at most (\d+)/i, /limit of (\d+)/i, /(?:<=|less than or equal to|maximum (?:value )?(?:is|of)) (\d+)/i, /\d+\s*>\s*(\d+)/]

function errorText(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body)
    const texts: string[] = []
    const pending: unknown[] = [parsed]
    while (pending.length && texts.length < 20) {
      const value = pending.pop()
      if (typeof value === "string") texts.push(value)
      else if (Array.isArray(value)) pending.push(...value)
      else if (isJsonObject(value)) pending.push(...Object.values(value))
    }
    return texts.join("\n")
  } catch {
    return body
  }
}

/**
 * Whether a provider's 400 answer refuses the request's output cap, and the
 * limit it named. A refusal about the context window names no output limit:
 * the room left depends on the prompt.
 */
export function rejectedOutputCap(status: number, body: string, requested: number): { limit: number | null } | null {
  if (status !== 400 && status !== 422) return null
  const text = errorText(body).slice(0, 4000)
  if (!CAP_NAME.test(text) || !CAP_REFUSED.test(text)) return null
  if (/context (?:length|window)/i.test(text)) return { limit: null }
  for (const pattern of NAMED_LIMIT) {
    const limit = Number(text.match(pattern)?.[1])
    if (Number.isInteger(limit) && limit > 0 && limit < requested) return { limit }
  }
  return { limit: null }
}

/**
 * Rewrites a refused cap for one more attempt: to the limit the provider
 * named, else removed. Anthropic Messages requires a cap, so without a named
 * limit there is nothing to send. Returns whether the request changed.
 */
export function relaxOutputCap(json: JsonObject, protocol: GatewayRequestProtocol, limit: number | null): boolean {
  if (limit !== null) return fitOutputCap(json, protocol, limit)
  if (protocol === "anthropic_messages") return false
  const fields = capFields(json, protocol)
  for (const field of fields) delete field.holder[field.key]
  return fields.length > 0
}

/**
 * Output limits providers named, kept per model for this process. An entry
 * expires so a model that later points at a larger one is asked again, and
 * the oldest entries leave first.
 */
export function createLearnedOutputLimits(options: { capacity?: number; ttlMs?: number } = {}) {
  const capacity = options.capacity ?? 2000
  const ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1000
  const limits = new Map<string, { limit: number; at: number }>()
  return {
    get(modelKey: string, now: number): number | null {
      const entry = limits.get(modelKey)
      if (!entry) return null
      if (now - entry.at < ttlMs) return entry.limit
      limits.delete(modelKey)
      return null
    },
    learn(modelKey: string, limit: number, now: number) {
      limits.delete(modelKey)
      limits.set(modelKey, { limit, at: now })
      if (limits.size > capacity) for (const oldest of limits.keys()) { limits.delete(oldest); break }
    },
  }
}

export type LearnedOutputLimits = ReturnType<typeof createLearnedOutputLimits>

/** The tighter of the saved and the learned limit. */
export function knownOutputLimit(saved: number | null, learned: number | null): number | null {
  if (saved === null) return learned
  return learned === null ? saved : Math.min(saved, learned)
}
