import { z } from "zod"

/**
 * Auto Router (feature `autoRouter`): organization admins list AI Gateway
 * models, describe when each one should be used, and choose the one thinking
 * level it runs at. Members pick "Auto" in the desktop model picker; for
 * every prompt the gateway asks Jev (TypeSafe System One) which route fits,
 * then forwards the request as if the member had picked that model.
 *
 * A route names an AI Gateway model the way the default model does: the
 * `ipr_…` provider and the catalog model id. The gateway turns it into the
 * member's own Gateway alias per request, because aliases differ per member.
 *
 * No relative value imports: the Den web build cannot resolve relative `.js`
 * imports from this package.
 */

/** The model id desktops send for Auto, and the runtime provider id they register it under. */
export const AUTO_ROUTER_MODEL_ID = "openwork-auto"
export const AUTO_ROUTER_PROVIDER_ID = "openwork-auto"
export const AUTO_ROUTER_MODEL_NAME = "Auto"

/**
 * Response headers the gateway adds to an Auto response, and the same values
 * on the first streamed chunk under `openwork_route`.
 */
export const AUTO_ROUTER_RESPONSE_MODEL_HEADER = "x-openwork-auto-model"
export const AUTO_ROUTER_RESPONSE_PROVIDER_HEADER = "x-openwork-auto-provider"
export const AUTO_ROUTER_RESPONSE_THINKING_HEADER = "x-openwork-auto-thinking"
export const AUTO_ROUTER_RESPONSE_REASON_HEADER = "x-openwork-auto-reason"
/** The routed model's display name, URI-encoded so any name fits in a header. */
export const AUTO_ROUTER_RESPONSE_MODEL_NAME_HEADER = "x-openwork-auto-model-name"

/**
 * The desktop records each Auto turn's routing decision in the OpenCode
 * session's metadata under this key, so the chat can say which model answered.
 */
export const AUTO_ROUTER_SESSION_ROUTES_KEY = "openworkAutoRoutes"
/** Most routing decisions kept per session; older ones are dropped first. */
export const AUTO_ROUTER_SESSION_ROUTES_MAX = 50

/** One routing decision: when the gateway's response arrived and the model it chose. */
export type AutoRouterReplyRoute = {
  /** Milliseconds since the epoch, on the engine's clock. */
  at: number
  /** Catalog provider family, for example `anthropic`. */
  provider: string
  /** Catalog model id, for example `claude-haiku-5-5`. */
  model: string
  /** Display name, for example `Claude Haiku 5.5`, when the gateway sent one. */
  name?: string
  thinking: string
}

/** Reads recorded routing decisions, oldest first, dropping malformed entries. */
export function autoRouterReplyRoutes(value: unknown): AutoRouterReplyRoute[] {
  if (!Array.isArray(value)) return []
  const routes: AutoRouterReplyRoute[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const { at, provider, model, name, thinking } = item
    if (typeof at !== "number" || !Number.isFinite(at) || typeof model !== "string" || !model) continue
    routes.push({
      at,
      provider: typeof provider === "string" ? provider : "",
      model,
      ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
      thinking: typeof thinking === "string" ? thinking : "default",
    })
  }
  return routes.sort((a, b) => a.at - b.at)
}

/**
 * Thinking levels, in display order. `default` sends no reasoning setting, so
 * the provider's own default applies; every model allows it. The others are
 * the effort values the model's catalog entry declares.
 */
export const AUTO_ROUTER_THINKING_LEVELS = ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"] as const
export type AutoRouterThinkingLevel = (typeof AUTO_ROUTER_THINKING_LEVELS)[number]
export const autoRouterThinkingLevelSchema = z.enum(AUTO_ROUTER_THINKING_LEVELS)

export const AUTO_ROUTER_THINKING_LABELS: Record<AutoRouterThinkingLevel, string> = {
  default: "Default",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Xhigh",
  max: "Max",
}

/** Most routes an organization can have; each route is one Jev option. */
export const AUTO_ROUTER_MAX_ROUTES = 24
export const AUTO_ROUTER_PROMPT_MAX_LENGTH = 2000

/**
 * Provider SDKs whose protocol the gateway can translate an Auto request to:
 * Anthropic Messages, OpenAI Chat Completions, Gemini generateContent and
 * Bedrock Converse.
 */
export const AUTO_ROUTER_SUPPORTED_NPM = [
  "@ai-sdk/anthropic",
  "@ai-sdk/google-vertex/anthropic",
  "@ai-sdk/openai",
  "@ai-sdk/openai-compatible",
  "@openrouter/ai-sdk-provider",
  "@ai-sdk/mistral",
  "@ai-sdk/azure",
  "@ai-sdk/google",
  "@ai-sdk/google-vertex",
  "@ai-sdk/amazon-bedrock",
  "@ai-sdk/amazon-bedrock/mantle",
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isThinkingLevel(value: string): value is AutoRouterThinkingLevel {
  return AUTO_ROUTER_THINKING_LEVELS.some((level) => level === value)
}

/** Claude generations that only take a manual thinking budget, so no effort levels. */
function manualThinkingClaude(rawModelId: string) {
  // Snapshot dates (claude-3-7-sonnet-20250219) are not versions.
  const modelId = rawModelId.replace(/[-@]\d{8}(?=$|[-@:.])/g, "")
  const familyFirst = /(?:claude-)?(opus|sonnet|haiku)-(\d+)(?:[.-](\d+))?/i.exec(modelId)
  const versionFirst = /claude-(\d+)(?:[.-](\d+))?-(opus|sonnet|haiku)/i.exec(modelId)
  const major = Number(familyFirst?.[2] ?? versionFirst?.[1])
  const minor = Number(familyFirst?.[3] ?? versionFirst?.[2] ?? 0)
  return (major === 3 && minor === 7) || (major === 4 && minor < 6)
}

/**
 * The thinking levels a catalog model allows: `default` plus the effort values
 * its catalog entry declares (`reasoning_options`), in display order.
 */
export function autoRouterThinkingLevels(modelId: string, modelConfig: Record<string, unknown>): AutoRouterThinkingLevel[] {
  const levels = new Set<AutoRouterThinkingLevel>(["default"])
  if (modelConfig.reasoning !== false && !manualThinkingClaude(modelId)) {
    const options = Array.isArray(modelConfig.reasoning_options) ? modelConfig.reasoning_options : []
    for (const option of options) {
      if (!isRecord(option) || option.type !== "effort" || !Array.isArray(option.values)) continue
      for (const value of option.values) if (typeof value === "string" && isThinkingLevel(value)) levels.add(value)
    }
  }
  return AUTO_ROUTER_THINKING_LEVELS.filter((level) => levels.has(level))
}

/**
 * The first route is the default model: Auto uses it when no other route's
 * prompt matches, and whenever Jev cannot answer. Its prompt is fixed.
 */
export const AUTO_ROUTER_DEFAULT_PROMPT = "Use this model when no other prompts and models match the input"

export const autoRouterRouteSchema = z
  .object({
    id: z.string(),
    /** The `ipr_…` AI Gateway provider. */
    providerId: z.string(),
    /** The catalog model id within that provider, for example `claude-opus-5`. */
    modelId: z.string(),
    /** When to use this model, in the admin's words. Sent to Jev as the option's description. */
    prompt: z.string(),
    /** The one thinking level this route always runs at. */
    thinkingLevel: autoRouterThinkingLevelSchema,
    /** True for the first route: the default model, with the fixed prompt. */
    isDefault: z.boolean(),
  })
  .meta({ ref: "AutoRouterRoute" })
export type AutoRouterRoute = z.infer<typeof autoRouterRouteSchema>

/**
 * Whether the AI Gateway can route Auto requests: `ready` when it has its
 * TypeSafe (Jev) key, `missing_key` when it does not (Auto is then off and
 * cannot be enabled), `unknown` when Den could not reach the gateway to ask.
 */
export const AUTO_ROUTER_ROUTING_STATES = ["ready", "missing_key", "unknown"] as const
export type AutoRouterRoutingState = (typeof AUTO_ROUTER_ROUTING_STATES)[number]

export const autoRouterSettingsSchema = z
  .object({
    /** False until an admin enables the Auto Router for the organization. */
    enabled: z.boolean(),
    routing: z.enum(AUTO_ROUTER_ROUTING_STATES),
    /** Ordered; the first is the default model. */
    routes: z.array(autoRouterRouteSchema),
    canEdit: z.boolean(),
  })
  .meta({ ref: "AutoRouterSettings" })
export type AutoRouterSettings = z.infer<typeof autoRouterSettingsSchema>

export const autoRouterRouteWriteSchema = z
  .object({
    providerId: z.string().trim().min(1).max(128),
    modelId: z.string().trim().min(1).max(255),
    /** Required for every route but the first; the first (default) always gets AUTO_ROUTER_DEFAULT_PROMPT. */
    prompt: z.string().trim().max(AUTO_ROUTER_PROMPT_MAX_LENGTH).optional(),
    thinkingLevel: autoRouterThinkingLevelSchema,
  })
  .strict()
  .meta({ ref: "AutoRouterRouteWrite" })
export type AutoRouterRouteWrite = z.infer<typeof autoRouterRouteWriteSchema>

/**
 * Replaces the whole configuration. The first route is the default model;
 * enabling requires one.
 */
export const autoRouterWriteSchema = z
  .object({
    enabled: z.boolean(),
    routes: z.array(autoRouterRouteWriteSchema).max(AUTO_ROUTER_MAX_ROUTES),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.enabled && value.routes.length === 0) {
      context.addIssue({ code: "custom", path: ["routes"], message: "Choose a default model to turn on the Auto Router." })
    }
    value.routes.forEach((route, index) => {
      if (index > 0 && !route.prompt) context.addIssue({ code: "custom", path: ["routes", index, "prompt"], message: "Describe when to use this model." })
    })
  })
  .meta({ ref: "AutoRouterWrite" })
export type AutoRouterWrite = z.infer<typeof autoRouterWriteSchema>

export const autoRouterModelOptionSchema = z
  .object({
    providerId: z.string(),
    modelId: z.string(),
    providerName: z.string(),
    modelName: z.string(),
    /** The catalog provider family (for example `anthropic`) for the logo. */
    logoProviderId: z.string(),
    thinkingLevels: z.array(autoRouterThinkingLevelSchema),
  })
  .meta({ ref: "AutoRouterModelOption" })
export type AutoRouterModelOption = z.infer<typeof autoRouterModelOptionSchema>

export const autoRouterOptionsSchema = z
  .object({ options: z.array(autoRouterModelOptionSchema) })
  .meta({ ref: "AutoRouterOptions" })
export type AutoRouterOptions = z.infer<typeof autoRouterOptionsSchema>

/**
 * What a desktop needs to offer Auto: an OpenAI-compatible base URL on the
 * gateway and the member's own Gateway key.
 */
export const autoRouterConnectSchema = z
  .object({
    model: z.object({ id: z.literal(AUTO_ROUTER_MODEL_ID), name: z.string() }),
    baseURL: z.string(),
    apiKey: z.string(),
  })
  .meta({ ref: "AutoRouterConnect" })
export type AutoRouterConnect = z.infer<typeof autoRouterConnectSchema>

/** The Jev option key for a route. Jev never sees ids, only keys and descriptions. */
export function autoRouterOptionKey(routeIndex: number) {
  return `route_${routeIndex + 1}`
}
