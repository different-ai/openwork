import { z } from "zod"

/**
 * Smart Model Router (feature `autoRouter`; internal names keep "auto"):
 * organization admins create any number of Smart Routers. Each has a name,
 * the people it applies to (everyone, teams, members), and AI Gateway models,
 * each tagged with the tasks it should handle. Tasks are shared across the
 * organization (one row per name, case-insensitive) and can sit on several
 * models of a router.
 *
 * Members pick "Smart: <name>" in the desktop model picker, one entry per
 * router that applies to them. For every prompt the gateway asks Jev
 * (TypeSafe System One) to score how well the prompt matches each task, sums
 * each model's task scores, sends the prompt to the highest-scoring model, and
 * lets Jev score how much reasoning it needs to choose the thinking level.
 *
 * A model names an AI Gateway model the way the default model does: the
 * `ipr_…` provider and the catalog model id. The gateway turns it into the
 * member's own Gateway alias per request, because aliases differ per member.
 *
 * No relative value imports: the Den web build cannot resolve relative `.js`
 * imports from this package.
 */

/** The runtime provider id desktops register every Smart Router model under. */
export const AUTO_ROUTER_PROVIDER_ID = "openwork-auto"
/** What people call the feature. */
export const AUTO_ROUTER_PRODUCT_NAME = "Smart Model Router"
/** Model ids desktops send: this prefix plus the router id. */
export const AUTO_ROUTER_MODEL_ID_PREFIX = "openwork-smart-"

export function autoRouterModelId(routerId: string) {
  return `${AUTO_ROUTER_MODEL_ID_PREFIX}${routerId}`
}

/** The router id in a Smart model id, or null when the model is not one. */
export function autoRouterIdFromModel(model: unknown): string | null {
  if (typeof model !== "string" || !model.startsWith(AUTO_ROUTER_MODEL_ID_PREFIX)) return null
  const id = model.slice(AUTO_ROUTER_MODEL_ID_PREFIX.length).trim()
  return id ? id : null
}

/** How a router appears in the desktop model picker: "Smart: Engineering". */
export function autoRouterModelName(routerName: string) {
  return `Smart: ${routerName.trim() || "Router"}`
}

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

/** Limits: every task of a router is one Jev Score question per request. */
export const AUTO_ROUTER_MAX_ROUTERS = 50
export const AUTO_ROUTER_MAX_MODELS = 24
export const AUTO_ROUTER_MAX_TASKS_PER_MODEL = 32
export const AUTO_ROUTER_MAX_TASKS = 64
export const AUTO_ROUTER_NAME_MAX_LENGTH = 80
export const AUTO_ROUTER_TASK_MAX_LENGTH = 120

/** How tasks are told apart: names that differ only in case or spacing are the same task. */
export function autoRouterTaskKey(name: string) {
  return name.trim().replace(/\s+/g, " ").toLowerCase()
}

/** A task's stored spelling: trimmed, inner whitespace collapsed. */
export function normalizeAutoRouterTaskName(name: string) {
  return name.trim().replace(/\s+/g, " ")
}

/** Who a router applies to, like other organization items: everyone, teams, members. */
export const autoRouterAssignmentSchema = z
  .object({
    everyone: z.boolean(),
    teamIds: z.array(z.string().trim().min(1).max(64)).max(200),
    memberIds: z.array(z.string().trim().min(1).max(64)).max(1000),
  })
  .strict()
  .meta({ ref: "AutoRouterAssignment" })
export type AutoRouterAssignment = z.infer<typeof autoRouterAssignmentSchema>

export const autoRouterModelSchema = z
  .object({
    id: z.string(),
    /** The `ipr_…` AI Gateway provider. */
    providerId: z.string(),
    /** The catalog model id within that provider, for example `claude-opus-5`. */
    modelId: z.string(),
    /** The tasks this model handles, in the order the admin added them. */
    tasks: z.array(z.string()),
  })
  .meta({ ref: "AutoRouterModel" })
export type AutoRouterModel = z.infer<typeof autoRouterModelSchema>

export const autoRouterSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    assignment: autoRouterAssignmentSchema,
    /** In the order the admin listed them; the first wins ties and is used when Jev cannot answer. */
    models: z.array(autoRouterModelSchema),
    updatedAt: z.string().datetime(),
  })
  .meta({ ref: "AutoRouter" })
export type AutoRouter = z.infer<typeof autoRouterSchema>

/**
 * Whether the AI Gateway can route Smart requests: `ready` when it has its
 * TypeSafe (Jev) key, `missing_key` when it does not (Smart is then off and
 * routers cannot be saved), `unknown` when Den could not reach the gateway.
 */
export const AUTO_ROUTER_ROUTING_STATES = ["ready", "missing_key", "unknown"] as const
export type AutoRouterRoutingState = (typeof AUTO_ROUTER_ROUTING_STATES)[number]

export const autoRouterListSchema = z
  .object({
    routing: z.enum(AUTO_ROUTER_ROUTING_STATES),
    canEdit: z.boolean(),
    routers: z.array(autoRouterSchema),
    /** Every task in the organization, by name, for the task picker. */
    tasks: z.array(z.string()),
  })
  .meta({ ref: "AutoRouterList" })
export type AutoRouterList = z.infer<typeof autoRouterListSchema>

/** A write's answer: the whole list, and the router that was saved. */
export const autoRouterSavedSchema = autoRouterListSchema
  .extend({ routerId: z.string() })
  .meta({ ref: "AutoRouterSaved" })
export type AutoRouterSaved = z.infer<typeof autoRouterSavedSchema>

/** Stored normalized (normalizeAutoRouterTaskName); no transform, so the API schema stays plain. */
const taskNameSchema = z.string().trim().min(1).max(AUTO_ROUTER_TASK_MAX_LENGTH)

export const autoRouterModelWriteSchema = z
  .object({
    providerId: z.string().trim().min(1).max(128),
    modelId: z.string().trim().min(1).max(255),
    tasks: z.array(taskNameSchema).min(1, "Add at least one task for this model.").max(AUTO_ROUTER_MAX_TASKS_PER_MODEL),
  })
  .strict()
  .meta({ ref: "AutoRouterModelWrite" })
export type AutoRouterModelWrite = z.infer<typeof autoRouterModelWriteSchema>

/**
 * Creates a router or replaces its name and models. Who it applies to is set
 * separately (autoRouterAssignmentWriteSchema), as the second step of
 * creating one; a new router applies to nobody until then.
 */
export const autoRouterWriteSchema = z
  .object({
    name: z.string().trim().min(1, "Name this Smart Router.").max(AUTO_ROUTER_NAME_MAX_LENGTH),
    models: z.array(autoRouterModelWriteSchema).min(1, "Add at least one model.").max(AUTO_ROUTER_MAX_MODELS),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>()
    const tasks = new Set<string>()
    value.models.forEach((model, index) => {
      const key = `${model.providerId}\u0000${model.modelId}`
      if (seen.has(key)) context.addIssue({ code: "custom", path: ["models", index, "modelId"], message: "This model is already in the router." })
      seen.add(key)
      for (const task of model.tasks) tasks.add(autoRouterTaskKey(task))
    })
    if (tasks.size > AUTO_ROUTER_MAX_TASKS) {
      context.addIssue({ code: "custom", path: ["models"], message: `A Smart Router can have at most ${AUTO_ROUTER_MAX_TASKS} different tasks.` })
    }
  })
  .meta({ ref: "AutoRouterWrite" })
export type AutoRouterWrite = z.infer<typeof autoRouterWriteSchema>

/** Sets who a router applies to: everyone, teams, members. */
export const autoRouterAssignmentWriteSchema = z
  .object({ assignment: autoRouterAssignmentSchema })
  .strict()
  .meta({ ref: "AutoRouterAssignmentWrite" })
export type AutoRouterAssignmentWrite = z.infer<typeof autoRouterAssignmentWriteSchema>

/** Who can use a model through the AI Gateway's access grants. */
export const autoRouterModelAccessSchema = z
  .object({
    everyone: z.boolean(),
    teamIds: z.array(z.string()),
    memberIds: z.array(z.string()),
  })
  .meta({ ref: "AutoRouterModelAccess" })
export type AutoRouterModelAccess = z.infer<typeof autoRouterModelAccessSchema>

export const autoRouterModelOptionSchema = z
  .object({
    providerId: z.string(),
    modelId: z.string(),
    providerName: z.string(),
    modelName: z.string(),
    /** The catalog provider family (for example `anthropic`) for the logo. */
    logoProviderId: z.string(),
    access: autoRouterModelAccessSchema,
  })
  .meta({ ref: "AutoRouterModelOption" })
export type AutoRouterModelOption = z.infer<typeof autoRouterModelOptionSchema>

export const autoRouterOptionsSchema = z
  .object({ options: z.array(autoRouterModelOptionSchema) })
  .meta({ ref: "AutoRouterOptions" })
export type AutoRouterOptions = z.infer<typeof autoRouterOptionsSchema>

/**
 * What a desktop needs to offer Smart: an OpenAI-compatible base URL on the
 * gateway, the member's own Gateway key, and one model per router that
 * applies to the member.
 */
export const autoRouterConnectSchema = z
  .object({
    baseURL: z.string(),
    apiKey: z.string(),
    models: z.array(z.object({ id: z.string(), name: z.string() })).min(1),
  })
  .meta({ ref: "AutoRouterConnect" })
export type AutoRouterConnect = z.infer<typeof autoRouterConnectSchema>

/** Whether an assignment reaches a member, given the member's teams. */
export function autoRouterAssignmentIncludes(assignment: AutoRouterAssignment, memberId: string, teamIds: readonly string[]) {
  return assignment.everyone || assignment.memberIds.includes(memberId) || assignment.teamIds.some((id) => teamIds.includes(id))
}

/** The Jev question key for a task. Jev never sees ids, only keys and descriptions. */
export function autoRouterTaskQuestionKey(index: number) {
  return `task_${index + 1}`
}
