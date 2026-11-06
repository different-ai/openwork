/**
 * AI Gateway custom OpenAI-compatible providers (feature `gatewayCustomProviders`):
 * reading `GET {baseUrl}/models`, turning each entry into a models.dev-shaped
 * model record and matching it against the models.dev `openrouter` provider.
 *
 * Parsing, mapping and matching are pure. The fetch is egress-guarded (public
 * HTTPS or operator-allowlisted origins, guarded DNS, no redirects), time-boxed
 * and size-capped. Nothing here logs or returns the API key.
 */
import { createInferenceEgressFetch } from "@openwork-ee/utils/inference-egress"
import {
  GATEWAY_CUSTOM_MATCH_PROVIDER_ID,
  GATEWAY_CUSTOM_MAX_MODELS,
  gatewayCustomModelSchema,
  gatewayCustomReasoningOptionSchema,
  type GatewayCustomDiscoverResponse,
  type GatewayCustomDiscoveredModel,
  type GatewayCustomDiscoveryStatus,
  type GatewayCustomModality,
  type GatewayCustomModel,
  type GatewayCustomModelMatch,
  type GatewayCustomReasoningOption,
} from "@openwork/types/den/gateway-custom-providers"
import type { ModelsDevModel } from "./models-dev.js"

type JsonRecord = Record<string, unknown>

export const CUSTOM_DISCOVERY_TIMEOUT_MS = 10_000
export const CUSTOM_DISCOVERY_MAX_BYTES = 5 * 1024 * 1024
/** Used when neither /models nor a models.dev match says how large the context is. */
export const CUSTOM_DEFAULT_CONTEXT = 128_000
/** Used when nothing says how many tokens a reply may have (capped at the context). */
export const CUSTOM_DEFAULT_OUTPUT = 8_192

const DETAIL_KEYS = ["name", "context_length", "pricing", "architecture", "top_provider", "supported_parameters"] as const

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function readPositiveInt(value: unknown): number | null {
  const number = typeof value === "string" && value.trim() ? Number(value) : value
  return typeof number === "number" && Number.isFinite(number) && number >= 1 ? Math.floor(number) : null
}

function readStringList(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : null
}

/** `file` is OpenRouter's name for documents; models.dev calls it `pdf`. Unknown modalities are dropped. */
export function mapModalities(value: unknown): GatewayCustomModality[] | null {
  const list = readStringList(value)
  if (!list) return null
  const mapped: GatewayCustomModality[] = []
  for (const raw of list) {
    const name = raw.trim().toLowerCase()
    const modality: GatewayCustomModality | null = name === "text" ? "text" : name === "image" ? "image" : name === "audio" ? "audio"
      : name === "video" ? "video" : name === "pdf" || name === "file" ? "pdf" : null
    if (modality && !mapped.includes(modality)) mapped.push(modality)
  }
  return mapped
}

/**
 * OpenRouter-style prices are USD per token as strings; models.dev uses USD per
 * million tokens. Zero, negative (OpenRouter's "-1" for variable pricing) and
 * unparseable values are dropped. Rounded to 12 significant digits to remove
 * float noise (0.0000025 * 1e6 is 2.4999999999999996).
 */
export function perTokenToPerMillion(value: unknown): number | null {
  const number = typeof value === "string" && value.trim() ? Number(value) : value
  if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) return null
  return Number((number * 1_000_000).toPrecision(12))
}

export type CustomModelsEntry = {
  id: string
  canonicalSlug: string | null
  /** True when the entry carries any OpenRouter-style detail beyond its id. */
  detailed: boolean
  name: string | null
  context: number | null
  output: number | null
  input: GatewayCustomModality[] | null
  outputModalities: GatewayCustomModality[] | null
  /** Null when the entry has no supported_parameters list. */
  parameters: string[] | null
  cost: NonNullable<GatewayCustomModel["cost"]> | null
}

export type ParsedModelsResponse =
  | { status: "detailed" | "basic"; entries: CustomModelsEntry[] }
  | { status: "unavailable"; reason: string }

function readEntry(raw: JsonRecord): CustomModelsEntry | null {
  const id = readString(raw.id)
  if (!id || id.length > 255) return null
  const architecture = isRecord(raw.architecture) ? raw.architecture : {}
  const topProvider = isRecord(raw.top_provider) ? raw.top_provider : {}
  const pricing = isRecord(raw.pricing) ? raw.pricing : {}
  const cost: NonNullable<GatewayCustomModel["cost"]> = {}
  const input = perTokenToPerMillion(pricing.prompt)
  const output = perTokenToPerMillion(pricing.completion)
  const cacheRead = perTokenToPerMillion(pricing.input_cache_read)
  const cacheWrite = perTokenToPerMillion(pricing.input_cache_write)
  if (input !== null) cost.input = input
  if (output !== null) cost.output = output
  if (cacheRead !== null) cost.cache_read = cacheRead
  if (cacheWrite !== null) cost.cache_write = cacheWrite
  const inputModalities = mapModalities(architecture.input_modalities)
  const outputModalities = mapModalities(architecture.output_modalities)
  return {
    id,
    canonicalSlug: readString(raw.canonical_slug),
    detailed: DETAIL_KEYS.some((key) => raw[key] !== undefined && raw[key] !== null),
    name: readString(raw.name)?.slice(0, 255) ?? null,
    context: readPositiveInt(raw.context_length) ?? readPositiveInt(topProvider.context_length),
    output: readPositiveInt(topProvider.max_completion_tokens),
    input: inputModalities?.length ? inputModalities : null,
    outputModalities: outputModalities?.length ? outputModalities : null,
    parameters: readStringList(raw.supported_parameters),
    cost: Object.keys(cost).length ? cost : null,
  }
}

/** Reads an OpenAI-compatible `/models` body. At most GATEWAY_CUSTOM_MAX_MODELS distinct ids are kept. */
export function parseModelsResponse(body: unknown): ParsedModelsResponse {
  if (!isRecord(body) || !Array.isArray(body.data)) return { status: "unavailable", reason: "The provider's model list has no data list." }
  const entries: CustomModelsEntry[] = []
  const seen = new Set<string>()
  for (const raw of body.data) {
    if (entries.length >= GATEWAY_CUSTOM_MAX_MODELS) break
    const entry = isRecord(raw) ? readEntry(raw) : null
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
  }
  if (!entries.length) return { status: "unavailable", reason: "The provider's model list is empty." }
  return { status: entries.some((entry) => entry.detailed) ? "detailed" : "basic", entries }
}

function lastSegment(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1)
}

function loose(value: string): string {
  return value.toLowerCase().replace(/[-_.:]/g, "")
}

/**
 * Finds the models.dev OpenRouter model for an upstream id: exact id, then
 * canonical_slug, then the unique model with the same last path segment, then
 * the unique one with the same segment ignoring case and `-`, `_`, `.`, `:`.
 * Ambiguous matches return null.
 */
export function matchOpenRouterModel(entry: { id: string; canonicalSlug?: string | null }, catalog: readonly ModelsDevModel[]): { model: ModelsDevModel; by: GatewayCustomModelMatch["by"] } | null {
  const exact = catalog.find((model) => model.id === entry.id)
  if (exact) return { model: exact, by: "id" }
  const slug = entry.canonicalSlug
  if (slug) {
    const bySlug = catalog.find((model) => model.id === slug) ?? catalog.find((model) => model.config.canonical_model_id === slug)
    if (bySlug) return { model: bySlug, by: "canonical_slug" }
  }
  const suffix = lastSegment(entry.id)
  if (!suffix) return null
  const bySuffix = catalog.filter((model) => lastSegment(model.id) === suffix)
  if (bySuffix.length === 1 && bySuffix[0]) return { model: bySuffix[0], by: "suffix" }
  // A looser comparison only widens the candidates, so an ambiguous suffix stays ambiguous.
  if (bySuffix.length > 1) return null
  const key = loose(suffix)
  if (!key) return null
  const byLoose = catalog.filter((model) => loose(lastSegment(model.id)) === key)
  return byLoose.length === 1 && byLoose[0] ? { model: byLoose[0], by: "loose" } : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

function readCost(value: unknown): NonNullable<GatewayCustomModel["cost"]> | null {
  if (!isRecord(value)) return null
  const cost: NonNullable<GatewayCustomModel["cost"]> = {}
  for (const key of ["input", "output", "cache_read", "cache_write"] as const) {
    const number = value[key]
    if (typeof number === "number" && Number.isFinite(number) && number >= 0) cost[key] = number
  }
  return Object.keys(cost).length ? cost : null
}

function readReasoningOptions(value: unknown): GatewayCustomReasoningOption[] | null {
  if (!Array.isArray(value)) return null
  const options = value.flatMap((entry) => {
    const parsed = gatewayCustomReasoningOptionSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  }).slice(0, 4)
  return options.length ? options : null
}

function limits(context: number | null, output: number | null): GatewayCustomModel["limit"] {
  const resolvedContext = context ?? CUSTOM_DEFAULT_CONTEXT
  return { context: resolvedContext, output: Math.min(output ?? CUSTOM_DEFAULT_OUTPUT, resolvedContext) }
}

/** A models.dev model record as a custom model with the upstream id. Null when it is not usable. */
export function customModelFromModelsDev(id: string, record: JsonRecord): GatewayCustomModel | null {
  const modalities = isRecord(record.modalities) ? record.modalities : {}
  const input = mapModalities(modalities.input)
  const output = mapModalities(modalities.output)
  const limit = isRecord(record.limit) ? record.limit : {}
  const reasoning = readBoolean(record.reasoning) ?? false
  const reasoningOptions = reasoning ? readReasoningOptions(record.reasoning_options) : null
  const cost = readCost(record.cost)
  const candidate: GatewayCustomModel = {
    id,
    ...(readString(record.name) ? { name: readString(record.name)?.slice(0, 255) } : {}),
    attachment: readBoolean(record.attachment) ?? false,
    reasoning,
    ...(reasoningOptions ? { reasoning_options: reasoningOptions } : {}),
    tool_call: readBoolean(record.tool_call) ?? false,
    structured_output: readBoolean(record.structured_output) ?? false,
    temperature: readBoolean(record.temperature) ?? true,
    modalities: { input: input?.length ? input : ["text"], output: output?.length ? output : ["text"] },
    limit: limits(readPositiveInt(limit.context), readPositiveInt(limit.output)),
    ...(cost ? { cost } : {}),
  }
  const parsed = gatewayCustomModelSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

/**
 * Settings for one `/models` entry: the models.dev match as the base, with the
 * entry's own limits, modalities and cost on top. Without a match, settings
 * come from the entry alone when it is detailed, else null (only the id is known).
 */
export function suggestCustomModel(entry: CustomModelsEntry, match: ModelsDevModel | null): GatewayCustomModel | null {
  const base = match ? customModelFromModelsDev(entry.id, match.config) : null
  if (!base && !entry.detailed) return null
  const parameters = entry.parameters
  const has = (...names: string[]) => parameters ? names.some((name) => parameters.includes(name)) : null
  const input = entry.input ?? base?.modalities.input ?? ["text"]
  const output = entry.outputModalities ?? base?.modalities.output ?? ["text"]
  const cost = base?.cost || entry.cost ? { ...base?.cost, ...entry.cost } : null
  const reasoning = base ? base.reasoning : has("reasoning", "include_reasoning") ?? false
  const name = entry.name ?? base?.name
  const candidate: GatewayCustomModel = {
    id: entry.id,
    ...(name ? { name } : {}),
    attachment: entry.input ? input.some((modality) => modality !== "text") : base?.attachment ?? false,
    reasoning,
    ...(reasoning && base?.reasoning_options ? { reasoning_options: base.reasoning_options } : {}),
    tool_call: base ? base.tool_call : has("tools") ?? false,
    structured_output: base ? base.structured_output : has("response_format", "structured_outputs") ?? false,
    temperature: base ? base.temperature : has("temperature") ?? true,
    modalities: { input, output },
    limit: limits(entry.context ?? base?.limit.context ?? null, entry.output ?? base?.limit.output ?? null),
    ...(cost && Object.keys(cost).length ? { cost } : {}),
  }
  const parsed = gatewayCustomModelSchema.safeParse(candidate)
  return parsed.success ? parsed.data : base
}

/** Suggested settings and matches for every listed model. */
export function discoveredModels(entries: readonly CustomModelsEntry[], catalog: readonly ModelsDevModel[]): GatewayCustomDiscoveredModel[] {
  return entries.map((entry) => {
    const match = matchOpenRouterModel(entry, catalog)
    return {
      id: entry.id,
      model: suggestCustomModel(entry, match?.model ?? null),
      match: match ? { providerId: GATEWAY_CUSTOM_MATCH_PROVIDER_ID, modelId: match.model.id, by: match.by } : null,
    }
  })
}

type FetchOutcome =
  | { status: "ok"; upstreamStatus: number; body: unknown }
  | { status: "unavailable"; upstreamStatus: number | null; reason: string }

function upstreamStatusReason(status: number): string {
  if (status === 401 || status === 403) return "The provider refused the API key."
  if (status === 404) return "This address has no model list (/models)."
  if (status === 429) return "The provider is rate limiting requests. Try again in a moment."
  return `The provider answered with HTTP ${status}.`
}

async function readCappedText(response: Response, maxBytes: number): Promise<string | null> {
  const length = Number(response.headers.get("content-length"))
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel().catch(() => {})
    return null
  }
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

/** `GET {baseUrl}/models` with the key. Never throws for upstream problems; never includes the key in a reason. */
export async function fetchCustomProviderModels(input: { baseUrl: string; apiKey: string }, deps: { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {}): Promise<FetchOutcome> {
  const fetcher = deps.fetch ?? createInferenceEgressFetch()
  const maxBytes = deps.maxBytes ?? CUSTOM_DISCOVERY_MAX_BYTES
  let response: Response
  try {
    response = await fetcher(`${input.baseUrl.replace(/\/+$/, "")}/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${input.apiKey}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(deps.timeoutMs ?? CUSTOM_DISCOVERY_TIMEOUT_MS),
    })
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
    return { status: "unavailable", upstreamStatus: null, reason: timedOut ? "The provider took too long to list its models." : "Couldn't connect to the provider at this address." }
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    return { status: "unavailable", upstreamStatus: response.status, reason: upstreamStatusReason(response.status) }
  }
  let text: string | null
  try { text = await readCappedText(response, maxBytes) } catch {
    return { status: "unavailable", upstreamStatus: response.status, reason: "The provider's model list could not be read." }
  }
  if (text === null) return { status: "unavailable", upstreamStatus: response.status, reason: "The provider's model list is too large." }
  try {
    return { status: "ok", upstreamStatus: response.status, body: JSON.parse(text) }
  } catch {
    return { status: "unavailable", upstreamStatus: response.status, reason: "The provider's model list is not JSON." }
  }
}

/**
 * Fetches, parses and matches. `loadMatchCatalog` returns the models.dev
 * OpenRouter models; when it fails, models are returned without matches.
 * `baseUrl` must already be normalized and checked by the caller.
 */
export async function discoverCustomProviderModels(
  input: { baseUrl: string; apiKey: string },
  deps: { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number; loadMatchCatalog: () => Promise<readonly ModelsDevModel[]> },
): Promise<GatewayCustomDiscoverResponse> {
  const fetched = await fetchCustomProviderModels(input, deps)
  if (fetched.status === "unavailable") return { status: "unavailable", baseUrl: input.baseUrl, reason: fetched.reason, upstreamStatus: fetched.upstreamStatus, models: [] }
  const parsed = parseModelsResponse(fetched.body)
  if (parsed.status === "unavailable") return { status: "unavailable", baseUrl: input.baseUrl, reason: parsed.reason, upstreamStatus: fetched.upstreamStatus, models: [] }
  const catalog = await deps.loadMatchCatalog().catch((): readonly ModelsDevModel[] => [])
  const status: GatewayCustomDiscoveryStatus = parsed.status
  return { status, baseUrl: input.baseUrl, reason: null, upstreamStatus: fetched.upstreamStatus, models: discoveredModels(parsed.entries, catalog) }
}
