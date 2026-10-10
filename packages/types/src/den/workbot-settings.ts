import { z } from "zod"

/**
 * Organization settings for Workbot (Den › Manage › Workbot), behind the `workbotDefaultModel` feature.
 *
 * The model is the organization's default for its cloud agents: Workbot, the Slack assistant, and cloud Automations
 * set to the cloud default. It is a headless runner model id (the runner's `GET /v1/models`); null means the runner's
 * default. It is kept in the organization's metadata under `workbot.model`, next to the brand name Workbot already
 * reads there. One organization-wide value for now; per-team overrides can be layered on top of it later.
 */

export const workbotModelOptionSchema = z.object({ id: z.string(), name: z.string() })
export type WorkbotModelOption = z.infer<typeof workbotModelOptionSchema>

export const workbotSettingsSchema = z.object({
  /** The model the admin chose; null means the runner's default. */
  model: z.string().nullable(),
  /** The runner's default model, or null when the runner can't be reached. */
  defaultModel: z.string().nullable(),
  /** The models the runner can serve. Empty when the runner can't be reached. */
  models: z.array(workbotModelOptionSchema),
  /** False when the chosen model is no longer offered: everything uses the runner's default until it is changed. */
  modelAvailable: z.boolean(),
  /** The runner answered; when false, the model list is unknown. */
  runnerReachable: z.boolean(),
})
export type WorkbotSettings = z.infer<typeof workbotSettingsSchema>

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
