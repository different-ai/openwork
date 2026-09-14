import { z } from "zod"

export const OPENWORK_AFFORDANCE_SCHEMA_VERSION = 1

export const openworkAffordanceKindSchema = z.enum(["query", "command", "guidance"])
export type OpenworkAffordanceKind = z.infer<typeof openworkAffordanceKindSchema>

export const openworkProviderKindSchema = z.enum(["builtin", "extension", "mcp", "connect"])
export type OpenworkProviderKind = z.infer<typeof openworkProviderKindSchema>

export const openworkProviderRefSchema = z.object({
  id: z.string().trim().min(1),
  kind: openworkProviderKindSchema,
})
export type OpenworkProviderRef = z.infer<typeof openworkProviderRefSchema>

export const openworkAffordanceArgumentSchema = z.object({
  name: z.string().trim().min(1),
  type: z.enum(["string", "number", "boolean", "object", "array", "unknown"]),
  required: z.boolean(),
  description: z.string().trim().min(1).optional(),
})
export type OpenworkAffordanceArgument = z.infer<typeof openworkAffordanceArgumentSchema>

export const openworkAffordanceEffectsSchema = z.object({
  data: z.enum(["none", "read", "write"]),
  ui: z.enum(["none", "focus", "navigate", "layout", "dialog"]),
  external: z.boolean(),
})
export type OpenworkAffordanceEffects = z.infer<typeof openworkAffordanceEffectsSchema>

export const openworkAffordanceAvailabilitySchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().min(1).optional(),
})
export type OpenworkAffordanceAvailability = z.infer<typeof openworkAffordanceAvailabilitySchema>

export const openworkAffordanceExecutorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("openwork") }),
  z.object({
    kind: z.literal("tool"),
    tool: z.string().trim().min(1),
  }),
])
export type OpenworkAffordanceExecutor = z.infer<typeof openworkAffordanceExecutorSchema>

export const openworkAffordanceDescriptorSchema = z.object({
  id: z.string().trim().min(1),
  kind: openworkAffordanceKindSchema,
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  provider: openworkProviderRefSchema,
  arguments: z.array(openworkAffordanceArgumentSchema),
  effects: openworkAffordanceEffectsSchema,
  confirmation: z.enum(["never", "destructive", "always"]),
  availability: openworkAffordanceAvailabilitySchema,
  executor: openworkAffordanceExecutorSchema,
})
export type OpenworkAffordanceDescriptor = z.infer<typeof openworkAffordanceDescriptorSchema>

/**
 * The model a session is bound to, as agents pass it to `session.create`
 * (`model` argument) and read it back from `session.list_sessions` entries
 * and `session.read` results (`model` field). `variant` is the reasoning /
 * thinking effort the composer shows as its behavior pill (for example
 * `low`, `medium`, `high`); null means the provider default. The source is
 * the engine's session record: bound at creation, updated by every turn.
 * Results carry null instead of the object before any model is bound, and
 * the engine's literal "default" variant reads back as null.
 */
export const openworkSessionModelSchema = z.object({
  providerId: z.string().trim().min(1),
  modelId: z.string().trim().min(1),
  variant: z.string().trim().min(1).max(60).nullable(),
  displayName: z.string().optional(),
  providerName: z.string().optional(),
})
export type OpenworkSessionModel = z.infer<typeof openworkSessionModelSchema>

export const openworkModelRemovalImpactSchema = z.object({
  workspaceId: z.string(),
  removedModels: z.array(openworkSessionModelSchema),
  sessionIds: z.array(z.string()),
  inventoryComplete: z.boolean(),
})

export function isOpenworkModelRemovalNotification(event: { trigger?: { modelRemoval?: unknown } }) {
  return openworkModelRemovalImpactSchema.safeParse(event.trigger?.modelRemoval).success
}

export const openworkModelSelectorSchema = z.object({
  providerId: openworkSessionModelSchema.shape.providerId.optional(),
  modelId: openworkSessionModelSchema.shape.modelId.optional(),
  alias: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1).optional(),
  variant: openworkSessionModelSchema.shape.variant.optional(),
}).superRefine((value, context) => {
  const names = [value.alias, value.displayName].filter((name) => name !== undefined)
  if (value.alias && (value.displayName || value.modelId)) {
    context.addIssue({ code: "custom", message: "Use exactly one of modelId, alias or displayName." })
  }
  if (!names.length && !value.modelId) {
    context.addIssue({ code: "custom", path: ["modelId"], message: "Provide providerId/modelId, alias or displayName." })
  }
  if (value.modelId && !value.providerId) {
    context.addIssue({ code: "custom", path: ["providerId"], message: "providerId is required with modelId." })
  }
})

export const openworkSessionSetModelArgsSchema = z.object({
  sessionId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1).optional(),
  model: openworkModelSelectorSchema.optional(),
  alias: z.string().trim().min(1).optional(),
  dryRun: z.boolean().optional(),
}).refine((value) => Boolean(value.model) !== Boolean(value.alias), { message: "Provide model or alias, not both." })

export const openworkSessionRebindModelArgsSchema = z.object({
  workspaceId: z.string().trim().min(1),
  from: openworkSessionModelSchema.pick({ providerId: true, modelId: true }),
  to: openworkModelSelectorSchema,
  expectedSessionIds: z.array(z.string()).optional(),
  dryRun: z.boolean().optional(),
})

export const openworkSessionModelPreflightArgsSchema = z.object({
  workspaceId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  model: openworkSessionModelSchema.nullable(),
})

export const openworkSessionModelPreflightResultSchema = z.object({
  ok: z.literal(true),
  workspaceId: z.string(),
  sessionId: z.string(),
  model: openworkSessionModelSchema.nullable(),
})

export const openworkModelSessionSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  directory: z.string().optional(),
  time: z.object({ archived: z.number().optional() }).optional(),
  model: z.object({ providerID: z.string(), id: z.string(), variant: z.string().nullable().optional() }).nullable().optional(),
})

export function matchingOpenworkModelSessions(
  sessions: readonly z.infer<typeof openworkModelSessionSchema>[],
  from: Pick<OpenworkSessionModel, "providerId" | "modelId">,
  local: (sessionId: string) => OpenworkSessionModel | null,
) {
  return sessions.filter((session) => {
    if ((session.time?.archived ?? 0) > 0) return false
    const model = local(session.id) ?? (session.model ? { providerId: session.model.providerID, modelId: session.model.id } : null)
    return model?.providerId === from.providerId && model.modelId === from.modelId
  })
}

export function suggestOpenworkReplacement(from: OpenworkSessionModel, catalog: readonly OpenworkCatalogModel[], workspaceDefault: Pick<OpenworkSessionModel, "providerId" | "modelId"> | null) {
  return catalog.find((model) => model.providerId === from.providerId || (from.providerName && model.providerName === from.providerName))
    ?? catalog.find((model) => model.providerId === workspaceDefault?.providerId && model.modelId === workspaceDefault.modelId)
    ?? null
}

export const openworkModelsListArgsSchema = z.object({ workspaceId: z.string().trim().min(1) })
export const openworkModelsListResultSchema = z.object({
  ok: z.literal(true),
  workspaceId: openworkModelsListArgsSchema.shape.workspaceId,
  models: z.array(openworkSessionModelSchema.omit({ variant: true }).extend({
    displayName: z.string(), providerName: z.string(), available: z.literal(true),
  })),
})
export type OpenworkCatalogModel = Pick<OpenworkSessionModel, "providerId" | "modelId"> & {
  displayName: string
  providerName: string
}

export const openworkEngineModelCatalogSchema = z.object({
  connected: z.array(z.string()),
  all: z.array(z.object({
    id: z.string(),
    name: z.string(),
    models: z.record(z.string(), z.object({ name: z.string().optional() })),
  })),
})

export function openworkCatalogModels(value: z.infer<typeof openworkEngineModelCatalogSchema>): OpenworkCatalogModel[] {
  return value.all.filter((provider) => value.connected.includes(provider.id)).flatMap((provider) =>
    Object.entries(provider.models).map(([modelId, model]) => ({
      providerId: provider.id, modelId, displayName: model.name || modelId, providerName: provider.name,
    })),
  )
}

export function labelOpenworkSessionModel(model: OpenworkSessionModel | null, catalog: readonly OpenworkCatalogModel[]): OpenworkSessionModel | null {
  if (!model) return null
  const entry = catalog.find((entry) => entry.providerId === model.providerId && entry.modelId === model.modelId)
  return entry ? { ...model, displayName: entry.displayName, providerName: entry.providerName } : model
}

export function resolveOpenworkModel(selector: z.infer<typeof openworkModelSelectorSchema>, catalog: readonly OpenworkCatalogModel[]): OpenworkSessionModel {
  const name = selector.modelId ? undefined : selector.alias ?? selector.displayName
  const matches = catalog.filter((entry) => name !== undefined
    ? entry.displayName.toLowerCase() === name.toLowerCase() && (!selector.providerId || entry.providerId.toLowerCase() === selector.providerId.toLowerCase())
    : entry.providerId === selector.providerId && entry.modelId === selector.modelId)
  const match = matches[0]
  if (matches.length !== 1 || !match) {
    throw new Error(`${matches.length ? "Ambiguous" : "Unavailable"} model: ${name ?? `${selector.providerId}/${selector.modelId}`}. Use models.list with this workspaceId${matches.length ? " and qualify the name with providerId" : ""}.`)
  }
  return { providerId: match.providerId, modelId: match.modelId, displayName: match.displayName, providerName: match.providerName,
    variant: selector.variant && selector.variant !== "default" ? selector.variant : null }
}

export const openworkSessionActivityInventorySchema = z.object({
  working: z.boolean(),
  descendantActivity: z.object({
    busy: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  }),
  inventoryComplete: z.boolean(),
})
export type OpenworkSessionActivityInventory = z.infer<typeof openworkSessionActivityInventorySchema>

/**
 * Where a request came from: the conversation (session) whose agent issued
 * it. Set by the OpenWork bridge, never by the agent, so UI commands such as
 * opening a browser tab can act for the requesting conversation instead of
 * whichever one happens to be on screen.
 */
export const openworkAffordanceOriginSchema = z.object({
  sessionId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1).optional(),
})
export type OpenworkAffordanceOrigin = z.infer<typeof openworkAffordanceOriginSchema>

export const openworkAffordanceRequestSchema = z.object({
  id: z.string().trim().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  actor: z.string().trim().min(1).optional(),
  origin: openworkAffordanceOriginSchema.optional(),
})
export type OpenworkAffordanceRequest = z.infer<typeof openworkAffordanceRequestSchema>

const openworkAffordanceSuccessSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  result: z.unknown().optional(),
  revision: z.number().int().nonnegative().optional(),
  effects: openworkAffordanceEffectsSchema,
})

/**
 * Structured outcomes an action can report so the agent can decide instead of
 * retrying a transport-looking error. Warnings travel back through the channel
 * the request came from: an agent never gets a dialog, it gets one of these.
 * - `target_working`: the target session is still working; ask the person to
 *   stop it if they want it closed, otherwise leave it running.
 * - `self_archive_while_working`: a session asked to archive itself (or its
 *   parent) from inside its own running turn; finish the turn, the reviewer
 *   archives.
 */
export const openworkAffordanceFailureCodeSchema = z.enum([
  "unavailable",
  "model_unavailable",
  "invalid-args",
  "conflict",
  "failed",
  "target_working",
  "self_archive_while_working",
])
export type OpenworkAffordanceFailureCode = z.infer<typeof openworkAffordanceFailureCodeSchema>

const openworkAffordanceFailureSchema = z.object({
  ok: z.literal(false),
  id: z.string(),
  error: z.string(),
  code: openworkAffordanceFailureCodeSchema,
  hint: z.string().optional(),
  revision: z.number().int().nonnegative().optional(),
})

export const openworkAffordanceResultSchema = z.discriminatedUnion("ok", [
  openworkAffordanceSuccessSchema,
  openworkAffordanceFailureSchema,
])
export type OpenworkAffordanceResult = z.infer<typeof openworkAffordanceResultSchema>
