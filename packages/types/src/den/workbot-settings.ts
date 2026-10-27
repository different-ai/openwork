import { z } from "zod"

/**
 * Organization settings for Workbot (Den › Manage › Workbot), available while the `workbot` feature is on.
 *
 * The model is the organization's default for its cloud agents: Workbot, the Slack assistant, and cloud Automations
 * set to the cloud default. It is a headless runner model id (the runner's `GET /v1/models`); null means the runner's
 * default. It is kept in the organization's metadata under `workbot.model`, next to the brand name Workbot already
 * reads there. One organization-wide value for now; per-team overrides can be layered on top of it later.
 */

export const WORKBOT_DEFAULT_MODEL_ID = "openai/gpt-6-luna"
export const WORKBOT_DEFAULT_MODEL_NAME = "GPT-6 Luna"
/** Distinct selections preserve free/paid charging when an accepted turn is retried. */
export const WORKBOT_FREE_LUNA_ID = "openwork-free/openai/gpt-6-luna"
export const WORKBOT_PAID_LUNA_ID = "openwork/openai/gpt-6-luna"
export function isWorkbotManagedLuna(model: string | null | undefined): boolean {
  return model === WORKBOT_FREE_LUNA_ID || model === WORKBOT_PAID_LUNA_ID
}

export const workbotAccessReasonSchema = z.enum([
  "gateway_not_configured", "gateway_provider_missing", "gateway_member_access_missing",
  "gateway_model_unavailable", "gateway_authentication_required", "gateway_credentials_unavailable",
  "oauth_scope_missing", "model_access_unavailable", "managed_models_setup_required", "rate_limited",
])
export type WorkbotAccessReason = z.infer<typeof workbotAccessReasonSchema>
/** Closed vocabulary only. Unknown Den/provider fields never cross Workbot's browser boundary. */
export const workbotAccessFailureSchema = z.object({
  error: z.literal("workbot_turn_access_denied"),
  reason: workbotAccessReasonSchema,
  retryAfter: z.number().int().min(1).max(3600).optional(),
})

/** Navigation hints for the signed-in member. Destinations recheck policy, permissions and billing. */
export const workbotModelRecoverySchema = z.object({
  canUpgrade: z.boolean(),
  purchaseEligible: z.boolean().default(false),
  managedLuna: z.boolean().default(false),
  hasModelsSubscription: z.boolean().default(false),
  /** Existing member access, or the managed Luna route activated by Models checkout. */
  paidContinuation: z.enum(["unavailable", "after_upgrade", "authorized"]).default("unavailable"),
  upgradeBlockedReason: z.literal("paid_workbot_route_unavailable").nullable().default("paid_workbot_route_unavailable"),
  canManageModels: z.boolean(),
  canManageBilling: z.boolean(),
  freeExhausted: z.boolean(),
  freeResetsAt: z.iso.datetime().nullable(),
})
export type WorkbotModelRecovery = z.infer<typeof workbotModelRecoverySchema>

/** Resolve only an exact Luna identity from the runner's own authorized route; never guess another provider. */
export function workbotLunaAlias(catalog: { defaultModel: string; models: { id: string; name: string }[] }): string | null {
  const candidates = catalog.models.filter((model) => model.id === WORKBOT_DEFAULT_MODEL_ID || model.name === WORKBOT_DEFAULT_MODEL_NAME || model.name === `OpenWork: ${WORKBOT_DEFAULT_MODEL_NAME}`)
  const canonical = candidates.find((model) => model.id === WORKBOT_DEFAULT_MODEL_ID)
  if (canonical) return canonical.id
  const configured = candidates.find((model) => model.id === catalog.defaultModel)
  if (configured) return configured.id
  return candidates.length === 1 ? candidates[0]?.id ?? null : null
}

export const workbotModelOptionSchema = z.object({ id: z.string(), name: z.string(), provider: z.string().optional() })
export type WorkbotModelOption = z.infer<typeof workbotModelOptionSchema>

export const workbotSettingsSchema = z.object({
  /** The model the admin chose; null uses the explicit Luna default for Workbot. */
  model: z.string().nullable(),
  /** The effective default for Workbot; legacy mode returns the runner's default or null when unreachable. */
  defaultModel: z.string().nullable(),
  /** The models the runner can serve. Empty when the runner can't be reached. */
  models: z.array(workbotModelOptionSchema),
  /** False when a saved model is no longer offered. The explicit Luna rollout refuses new Workbot turns instead of falling back. */
  modelAvailable: z.boolean(),
  /** The runner answered; when false, the model list is unknown. */
  runnerReachable: z.boolean(),
  /** The catalog is scoped to this member’s usable model access, including managed Luna and AI Gateway assignments. */
  gatewayModels: z.boolean().optional(),
  /** Present only during the explicit Luna rollout. Catalog readiness is not a paid completion probe. */
  defaultReadiness: z.enum(["available", "unavailable", "unverified"]).optional(),
})
export type WorkbotSettings = z.infer<typeof workbotSettingsSchema>

/** A paid, synthetic diagnostic result, never a catalog-derived readiness claim. No answer text or credentials. */
export const workbotModelTestSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("answered"), errorCode: z.null(), requestedModel: z.string(), reportedModel: z.string().nullable() }),
  z.strictObject({ status: z.literal("failed"), errorCode: z.enum(["model_unavailable", "runner_unavailable", "credentials_unavailable", "authentication_failed", "payment_required", "provider_unavailable", "timed_out", "invalid_response", "busy"]), requestedModel: z.string(), reportedModel: z.null() }),
])
export type WorkbotModelTest = z.infer<typeof workbotModelTestSchema>

/**
 * Whether Workbot can get a model for the organization's members, without naming any provider (`GET /v1/org/workbot-readiness`).
 * Custom Workbot models need an active AI Gateway provider; the managed Luna default uses the member’s Models access.
 * Den web checks this before sending people to Workbot. A provider existing does not mean every member has a usable model.
 */
export const workbotReadinessSchema = z.object({
  /** Workbot’s selected default requires the organization’s AI Gateway; managed Luna needs no custom provider. */
  gatewayRequired: z.boolean(),
  /** The organization has at least one active AI Gateway provider. Checked only when gatewayRequired is true. */
  hasGatewayProvider: z.boolean(),
})
export type WorkbotReadiness = z.infer<typeof workbotReadinessSchema>

export const workbotSettingsInputSchema = z.strictObject({
  /** A model id from `models`, or null for the runner's default. */
  model: z.string().trim().min(1).max(255).nullable(),
})
export type WorkbotSettingsInput = z.infer<typeof workbotSettingsInputSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function metadataRecord(metadata: unknown): Record<string, unknown> {
  if (typeof metadata !== "string") return isRecord(metadata) ? metadata : {}
  try {
    const parsed: unknown = JSON.parse(metadata)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** The organization's default model for its cloud agents, or null for the runner's default. */
export function readWorkbotModel(metadata: unknown): string | null {
  const workbot = metadataRecord(metadata).workbot
  if (!isRecord(workbot)) return null
  const model = workbot.model
  return typeof model === "string" && model.trim() ? model.trim() : null
}

/** Metadata with the default model set (or cleared with null); everything else is kept. */
export function withWorkbotModel(metadata: Record<string, unknown>, model: string | null): Record<string, unknown> {
  const current = metadata.workbot
  const workbot: Record<string, unknown> = { ...(isRecord(current) ? current : {}) }
  if (model) workbot.model = model
  else delete workbot.model
  return { ...metadata, workbot }
}
