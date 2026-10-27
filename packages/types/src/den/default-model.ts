import { z } from "zod"

/**
 * The model new desktop chats start with, chosen by organization admins for
 * everyone and optionally per team (OpenCode v2 engine only).
 * Members can still change the model in each chat.
 *
 * A choice names a provider the way the desktop does: `openwork` for OpenWork
 * Models, an `lpr_…` organization provider, or an `ipr_…` AI Gateway provider.
 * For the AI Gateway the model is the catalog model id (for example
 * `claude-sonnet-4-5`); Den turns it into the member's own Gateway alias when it
 * sends the member their desktop config, because aliases differ per member.
 *
 * Resolution, for one member:
 *   1. The member's teams that override the model, by team name. When they all
 *      choose the same model, that model applies.
 *   2. When two of those teams choose different models, the organization
 *      default applies instead (a conflict never picks one team over another).
 *   3. With no team override, the organization default applies.
 *   4. With no organization default, the desktop keeps its own behaviour.
 *
 * No relative value imports: the Den web build cannot resolve relative `.js`
 * imports from this package.
 */

export const DEFAULT_MODEL_EVERYONE_SCOPE = "everyone"

export const defaultModelChoiceSchema = z
  .object({
    providerId: z.string().trim().min(1).max(128),
    modelId: z.string().trim().min(1).max(255),
  })
  .strict()
  .meta({ ref: "DefaultModelChoice" })
export type DefaultModelChoice = z.infer<typeof defaultModelChoiceSchema>

/** Where a model comes from, as admins know it. */
export const DEFAULT_MODEL_SOURCES = ["openwork", "gateway", "provider"] as const
export type DefaultModelSource = (typeof DEFAULT_MODEL_SOURCES)[number]
export const defaultModelSourceSchema = z.enum(DEFAULT_MODEL_SOURCES)

export const DEFAULT_MODEL_SOURCE_LABELS: Record<DefaultModelSource, string> = {
  openwork: "OpenWork Models",
  gateway: "AI Gateway",
  provider: "Organization providers",
}

export const defaultModelOptionSchema = z
  .object({
    providerId: z.string(),
    modelId: z.string(),
    providerName: z.string(),
    modelName: z.string(),
    /** The catalog provider family (for example `anthropic`) for the logo; the provider id is often opaque. */
    logoProviderId: z.string(),
    source: defaultModelSourceSchema,
  })
  .meta({ ref: "DefaultModelOption" })
export type DefaultModelOption = z.infer<typeof defaultModelOptionSchema>

export const defaultModelOptionsSchema = z
  .object({
    options: z.array(defaultModelOptionSchema),
    /** Sources whose models could not be read just now; their models are missing from options. */
    unavailableSources: z.array(defaultModelSourceSchema),
  })
  .meta({ ref: "DefaultModelOptions" })
export type DefaultModelOptions = z.infer<typeof defaultModelOptionsSchema>

export const defaultModelTeamSchema = z
  .object({
    teamId: z.string(),
    name: z.string(),
    memberCount: z.number().int().nonnegative(),
    /** The team's own model, or null when the team uses the organization default. */
    model: defaultModelChoiceSchema.nullable(),
    /**
     * Members of this team who are also on another team that overrides the
     * model differently; they start on the organization default.
     */
    conflictingMemberCount: z.number().int().nonnegative(),
  })
  .meta({ ref: "DefaultModelTeam" })
export type DefaultModelTeam = z.infer<typeof defaultModelTeamSchema>

export const defaultModelSettingsSchema = z
  .object({
    /** The organization default, or null for none. */
    everyone: defaultModelChoiceSchema.nullable(),
    teams: z.array(defaultModelTeamSchema),
    /** Whether the caller can change them (inference.manage). */
    canEdit: z.boolean(),
  })
  .meta({ ref: "DefaultModelSettings" })
export type DefaultModelSettings = z.infer<typeof defaultModelSettingsSchema>

export const defaultModelWriteSchema = z
  .object({
    /** The model, or null: no organization default, or (for a team) use the organization default. */
    model: defaultModelChoiceSchema.nullable(),
  })
  .strict()
  .meta({ ref: "DefaultModelWrite" })
export type DefaultModelWrite = z.infer<typeof defaultModelWriteSchema>

export type ResolvedDefaultModel = {
  model: DefaultModelChoice
  /** Where it came from: one team's override, or the organization default. */
  from: { kind: "team"; teamName: string } | { kind: "organization"; teamConflict: boolean }
}

export function sameDefaultModel(left: DefaultModelChoice | null | undefined, right: DefaultModelChoice | null | undefined): boolean {
  if (!left || !right) return !left && !right
  return left.providerId === right.providerId && left.modelId === right.modelId
}

/**
 * One member's effective default model (see the rules at the top of this
 * file). `teams` are the member's teams; their order does not matter.
 */
export function resolveDefaultModel(input: {
  everyone: DefaultModelChoice | null
  teams: ReadonlyArray<{ name: string; model: DefaultModelChoice | null }>
}): ResolvedDefaultModel | null {
  const overriding = input.teams
    .flatMap((team) => team.model ? [{ name: team.name, model: team.model }] : [])
    .sort((left, right) => left.name.localeCompare(right.name))
  const first = overriding[0]
  const conflict = overriding.some((team) => !sameDefaultModel(team.model, first?.model))
  if (first && !conflict) return { model: first.model, from: { kind: "team", teamName: first.name } }
  return input.everyone ? { model: input.everyone, from: { kind: "organization", teamConflict: conflict } } : null
}

/**
 * For each team, how many of its members are also on a team that overrides
 * the model differently. Those members start on the organization default.
 */
export function countDefaultModelConflicts(input: {
  teams: ReadonlyArray<{ teamId: string; model: DefaultModelChoice | null }>
  memberships: ReadonlyArray<{ teamId: string; memberId: string }>
}): Map<string, number> {
  const modelByTeam = new Map(input.teams.map((team) => [team.teamId, team.model]))
  const overridesByMember = new Map<string, DefaultModelChoice[]>()
  for (const membership of input.memberships) {
    const model = modelByTeam.get(membership.teamId)
    if (!model) continue
    overridesByMember.set(membership.memberId, [...overridesByMember.get(membership.memberId) ?? [], model])
  }
  const conflicted = new Set<string>()
  for (const [memberId, models] of overridesByMember) {
    if (models.some((model) => !sameDefaultModel(model, models[0]))) conflicted.add(memberId)
  }
  const counts = new Map<string, number>(input.teams.map((team) => [team.teamId, 0]))
  for (const membership of input.memberships) {
    if (conflicted.has(membership.memberId) && counts.has(membership.teamId)) {
      counts.set(membership.teamId, (counts.get(membership.teamId) ?? 0) + 1)
    }
  }
  return counts
}
