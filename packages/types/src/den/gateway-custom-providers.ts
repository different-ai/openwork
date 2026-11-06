import { z } from "zod"

/**
 * AI Gateway custom OpenAI-compatible providers (feature `gatewayCustomProviders`).
 *
 * An admin enters a name, an OpenAI-compatible base URL and one API key. Den
 * calls `GET {baseUrl}/models`, maps the answer to models.dev-shaped model
 * records (matching against the models.dev `openrouter` provider), the admin
 * picks or adds models, tests one through AI Gateway, then saves.
 *
 * Stored as a `gateway_providers` row with `provider_id` =
 * GATEWAY_CUSTOM_PROVIDER_ID, `settings.upstreamBaseUrl` and
 * `settings.custom` (GatewayCustomProviderSettings). Keys are write-only.
 */

/** Synthetic catalog provider id shared by every custom provider row; rows differ by their own id. */
export const GATEWAY_CUSTOM_PROVIDER_ID = "openwork-custom"
export const GATEWAY_CUSTOM_PROVIDER_NPM = "@ai-sdk/openai-compatible"
/** models.dev provider whose models are matched against and offered as templates. */
export const GATEWAY_CUSTOM_MATCH_PROVIDER_ID = "openrouter"
export const GATEWAY_CUSTOM_MAX_MODELS = 500

export function isGatewayCustomProviderId(providerId: string): boolean {
  return providerId === GATEWAY_CUSTOM_PROVIDER_ID
}

/**
 * Removes a trailing `/chat/completions`, `/completions` or `/` and surrounding
 * whitespace. Returns null when the result is not an absolute http(s) URL
 * without credentials, query or fragment. Public-host checks happen server-side.
 */
export function normalizeGatewayCustomBaseUrl(input: string): string | null {
  let value = input.trim()
  for (;;) {
    const next = value.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "").replace(/\/completions$/i, "")
    if (next === value) break
    value = next
  }
  let url: URL
  try { url = new URL(value) } catch { return null }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  if (url.username || url.password || url.search || url.hash) return null
  return value
}

export const gatewayCustomModalitySchema = z.enum(["text", "image", "audio", "video", "pdf"])
export type GatewayCustomModality = z.infer<typeof gatewayCustomModalitySchema>

export const gatewayCustomReasoningOptionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("toggle") }),
  z.object({ type: z.literal("effort"), values: z.array(z.string().trim().min(1).max(32)).min(1).max(12) }),
])
export type GatewayCustomReasoningOption = z.infer<typeof gatewayCustomReasoningOptionSchema>

/** USD per million tokens (models.dev units). */
export const gatewayCustomCostSchema = z.object({
  input: z.number().min(0).optional(),
  output: z.number().min(0).optional(),
  cache_read: z.number().min(0).optional(),
  cache_write: z.number().min(0).optional(),
}).strict()

/** One model, models.dev-shaped, so the desktop and gateway read it like a catalog model. */
export const gatewayCustomModelSchema = z.object({
  id: z.string().trim().min(1).max(255),
  name: z.string().trim().min(1).max(255).optional(),
  attachment: z.boolean(),
  reasoning: z.boolean(),
  reasoning_options: z.array(gatewayCustomReasoningOptionSchema).max(4).optional(),
  tool_call: z.boolean(),
  structured_output: z.boolean(),
  temperature: z.boolean(),
  modalities: z.object({
    input: z.array(gatewayCustomModalitySchema).min(1),
    output: z.array(gatewayCustomModalitySchema).min(1),
  }),
  limit: z.object({
    context: z.number().int().positive(),
    output: z.number().int().positive(),
  }),
  cost: gatewayCustomCostSchema.optional(),
}).strict()
export type GatewayCustomModel = z.infer<typeof gatewayCustomModelSchema>

const modelListSchema = z.array(gatewayCustomModelSchema).min(1).max(GATEWAY_CUSTOM_MAX_MODELS)
  .refine((models) => new Set(models.map((model) => model.id)).size === models.length, "Model ids must be unique.")

export const gatewayCustomDiscoveryStatusSchema = z.enum(["detailed", "basic", "unavailable"])
export type GatewayCustomDiscoveryStatus = z.infer<typeof gatewayCustomDiscoveryStatusSchema>

/** Model ids the provider's /models listed at the last fetch; hand-added models are never in it. */
const listedModelIdsSchema = z.array(z.string().min(1).max(255)).max(GATEWAY_CUSTOM_MAX_MODELS)

export const gatewayCustomDiscoveryStateSchema = z.object({
  status: gatewayCustomDiscoveryStatusSchema,
  lastFetchedAt: z.string().nullable(),
  /** Only models in this list are flagged "no longer listed" after a re-fetch. Older rows omit it. */
  listedModelIds: listedModelIdsSchema.default([]),
})

/** Stored at gateway_providers.settings.custom. */
export const gatewayCustomProviderSettingsSchema = z.object({
  version: z.literal(1),
  catalog: modelListSchema,
  discovery: gatewayCustomDiscoveryStateSchema,
})
export type GatewayCustomProviderSettings = z.infer<typeof gatewayCustomProviderSettingsSchema>

// --- Discover models ---

export const gatewayCustomDiscoverRequestSchema = z.union([
  z.object({ baseUrl: z.string().trim().min(1).max(2048), apiKey: z.string().trim().min(1).max(8192) }).strict(),
  /** Re-fetch for a saved provider with its stored key; baseUrl overrides the saved URL when given. */
  z.object({ inferenceProviderId: z.string().min(1), baseUrl: z.string().trim().min(1).max(2048).optional() }).strict(),
])
export type GatewayCustomDiscoverRequest = z.infer<typeof gatewayCustomDiscoverRequestSchema>

export const gatewayCustomModelMatchSchema = z.object({
  providerId: z.literal(GATEWAY_CUSTOM_MATCH_PROVIDER_ID),
  modelId: z.string(),
  /** How the match was found: exact id, canonical_slug, last path segment, or loose (case/punctuation-insensitive). */
  by: z.enum(["id", "canonical_slug", "suffix", "loose"]),
})
export type GatewayCustomModelMatch = z.infer<typeof gatewayCustomModelMatchSchema>

export const gatewayCustomDiscoveredModelSchema = z.object({
  /** Upstream id, sent as `model`. */
  id: z.string(),
  /** Suggested settings: the match as base with /models values on top. Null when nothing is known beyond the id. */
  model: gatewayCustomModelSchema.nullable(),
  match: gatewayCustomModelMatchSchema.nullable(),
})
export type GatewayCustomDiscoveredModel = z.infer<typeof gatewayCustomDiscoveredModelSchema>

export const gatewayCustomDiscoverResponseSchema = z.object({
  status: gatewayCustomDiscoveryStatusSchema,
  /** Normalized base URL the request went to. */
  baseUrl: z.string(),
  /** Plain-words reason for "unavailable" (never contains the key). */
  reason: z.string().nullable(),
  /** HTTP status from /models, when one came back. */
  upstreamStatus: z.number().int().nullable(),
  models: z.array(gatewayCustomDiscoveredModelSchema),
})
export type GatewayCustomDiscoverResponse = z.infer<typeof gatewayCustomDiscoverResponseSchema>

// --- Test ---

export const gatewayCustomTestRequestSchema = z.object({
  baseUrl: z.string().trim().min(1).max(2048),
  /** Required for a new provider; omitted to use the saved key of inferenceProviderId. */
  apiKey: z.string().trim().min(1).max(8192).optional(),
  inferenceProviderId: z.string().min(1).optional(),
  model: gatewayCustomModelSchema,
}).strict()
export type GatewayCustomTestRequest = z.infer<typeof gatewayCustomTestRequestSchema>

/** Which wizard step a failure belongs to. */
export const gatewayCustomTestStepSchema = z.enum(["connection", "model"])
export type GatewayCustomTestStep = z.infer<typeof gatewayCustomTestStepSchema>

export const gatewayCustomTestResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), model: z.string(), status: z.number().int(), code: z.null(), message: z.null(), step: z.null() }),
  z.object({ ok: z.literal(false), model: z.string(), status: z.number().int().nullable(), code: z.string(), message: z.string(), step: gatewayCustomTestStepSchema.nullable() }),
])
export type GatewayCustomTestResponse = z.infer<typeof gatewayCustomTestResponseSchema>

/** Maps a failed test to the step to send the admin back to. Null means stay (rate limit, credit). */
export function gatewayCustomTestStep(result: { status: number | null; code: string }): GatewayCustomTestStep | null {
  if (result.code === "rate_limited" || result.code === "insufficient_credit" || result.status === 429 || result.status === 402) return null
  if (result.code === "model_not_found" || result.code === "unsupported_parameter") return "model"
  if (result.status === 401 || result.status === 403 || result.code === "unauthorized" || result.code === "forbidden") return "connection"
  if (result.status === 400 || result.status === 422) return "model"
  return "connection"
}

// --- Create / edit ---

export const gatewayCustomCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(255),
  baseUrl: z.string().trim().min(1).max(2048),
  apiKey: z.string().trim().min(1).max(8192),
  models: modelListSchema,
  discoveryStatus: gatewayCustomDiscoveryStatusSchema.optional(),
  /** Ids the fetch listed; sent with discoveryStatus. */
  listedModelIds: listedModelIdsSchema.optional(),
  allMembers: z.boolean().optional(),
  memberIds: z.array(z.string()).max(500).optional(),
  teamIds: z.array(z.string()).max(500).optional(),
}).strict()
export type GatewayCustomCreateRequest = z.infer<typeof gatewayCustomCreateRequestSchema>

/**
 * Edit. Changing baseUrl, apiKey or any model id needs a passing test first in
 * the UI; den-api does not re-test. Access is edited through the existing
 * access-grant routes.
 */
export const gatewayCustomUpdateRequestSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  baseUrl: z.string().trim().min(1).max(2048).optional(),
  apiKey: z.string().trim().min(1).max(8192).optional(),
  models: modelListSchema.optional(),
  discoveryStatus: gatewayCustomDiscoveryStatusSchema.optional(),
  /** Ids the re-fetch listed; sent with discoveryStatus. */
  listedModelIds: listedModelIdsSchema.optional(),
}).strict()
export type GatewayCustomUpdateRequest = z.infer<typeof gatewayCustomUpdateRequestSchema>

/** Manage-view details added to the provider summary for custom providers (`inferenceProvider.custom`). */
export const gatewayCustomProviderStatusSchema = z.object({
  baseUrl: z.string(),
  models: z.array(gatewayCustomModelSchema),
  discovery: gatewayCustomDiscoveryStateSchema,
  hasKey: z.boolean(),
})
export type GatewayCustomProviderStatus = z.infer<typeof gatewayCustomProviderStatusSchema>
