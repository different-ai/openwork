import { workbotMaxStepsSchema } from "@openwork/types/den/workbot-settings"
import { z } from "zod"

/**
 * Workbot settings chosen by organization admins for one team (Den › Members ›
 * Teams › a team › Workbot), on top of the organization's own: the default
 * model, Workbot's name, whether Workbot is on at all, and its step limit
 * (only while `workbotStepLimit` is on too). Available while the
 * `workbotTeamSettings` feature is on.
 *
 * A team stores only what it overrides. In its settings a key that is absent
 * means "use the organization's"; a key that is present is the team's own
 * value. Later groups of settings are added as more keys.
 *
 * Resolution, for one member and for each setting on its own:
 *   1. The member's teams that override the setting. When they all hold the
 *      same value, that value applies.
 *   2. When two of those teams hold different values, the organization's
 *      applies instead (a conflict never picks one team over another).
 *   3. With no team override, the organization's applies.
 *
 * No relative value imports: the Den web build cannot resolve relative `.js`
 * imports from this package.
 */

export const WORKBOT_TEAM_NAME_MAX_LENGTH = 40

/** A headless runner model id, or null for the deployment's default model (as for the organization). */
export const workbotTeamModelSchema = z.string().trim().min(1).max(255).nullable()
export const workbotTeamNameSchema = z.string().trim().min(1).max(WORKBOT_TEAM_NAME_MAX_LENGTH)
/** Model calls per request: 0 is no limit, null the deployment's default (as for the organization). */
export const workbotTeamMaxStepsSchema = workbotMaxStepsSchema.nullable()

/**
 * What a team's row holds. Unknown keys are kept, so a server that does not
 * know a later group never drops it; a value that cannot be read counts as no
 * override.
 */
export const workbotTeamStoredSettingsSchema = z.looseObject({
  model: workbotTeamModelSchema.optional().catch(undefined),
  name: workbotTeamNameSchema.optional().catch(undefined),
  enabled: z.boolean().optional().catch(undefined),
  maxSteps: workbotTeamMaxStepsSchema.optional().catch(undefined),
})
export type WorkbotTeamStoredSettings = { model?: string | null; name?: string; enabled?: boolean; maxSteps?: number | null }

/** A team's overrides from its stored settings; nothing when they cannot be read. */
export function readWorkbotTeamSettings(value: unknown): WorkbotTeamStoredSettings {
  let stored = value
  if (typeof value === "string") {
    try {
      stored = JSON.parse(value)
    } catch {
      return {}
    }
  }
  const parsed = workbotTeamStoredSettingsSchema.safeParse(stored)
  if (!parsed.success) return {}
  return {
    ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
    ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
    ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
    ...(parsed.data.maxSteps !== undefined ? { maxSteps: parsed.data.maxSteps } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Whether Workbot is on for the organization's members (organization metadata
 * `workbot.enabled`). On unless an admin turned it off: an absent key is on.
 */
export function readWorkbotEnabled(metadata: unknown): boolean {
  let stored = metadata
  if (typeof metadata === "string") {
    try {
      stored = JSON.parse(metadata)
    } catch {
      return true
    }
  }
  const workbot = isRecord(stored) ? stored.workbot : undefined
  return !(isRecord(workbot) && workbot.enabled === false)
}

/** Metadata with Workbot turned on or off for the organization; on removes the key, everything else is kept. */
export function withWorkbotEnabled(metadata: Record<string, unknown>, enabled: boolean): Record<string, unknown> {
  const current = metadata.workbot
  const workbot: Record<string, unknown> = { ...(isRecord(current) ? current : {}) }
  if (enabled) delete workbot.enabled
  else workbot.enabled = false
  return { ...metadata, workbot }
}

const inheritSchema = z.strictObject({ inherit: z.literal(true) })

/** A team's default model: the organization's, or its own (null is the deployment's default model). */
export const workbotTeamModelSettingSchema = z
  .discriminatedUnion("inherit", [inheritSchema, z.strictObject({ inherit: z.literal(false), value: workbotTeamModelSchema })])
  .meta({ ref: "WorkbotTeamModelSetting" })
export type WorkbotTeamModelSetting = z.infer<typeof workbotTeamModelSettingSchema>

/** A team's Workbot name: the organization's, or its own. */
export const workbotTeamNameSettingSchema = z
  .discriminatedUnion("inherit", [inheritSchema, z.strictObject({ inherit: z.literal(false), value: workbotTeamNameSchema })])
  .meta({ ref: "WorkbotTeamNameSetting" })
export type WorkbotTeamNameSetting = z.infer<typeof workbotTeamNameSettingSchema>

/** Whether Workbot is on for a team's members: the organization's choice, or the team's own. */
export const workbotTeamEnabledSettingSchema = z
  .discriminatedUnion("inherit", [inheritSchema, z.strictObject({ inherit: z.literal(false), value: z.boolean() })])
  .meta({ ref: "WorkbotTeamEnabledSetting" })
export type WorkbotTeamEnabledSetting = z.infer<typeof workbotTeamEnabledSettingSchema>

/** A team's step limit: the organization's, or its own (0 is no limit, null the deployment's default). */
export const workbotTeamMaxStepsSettingSchema = z
  .discriminatedUnion("inherit", [inheritSchema, z.strictObject({ inherit: z.literal(false), value: workbotTeamMaxStepsSchema })])
  .meta({ ref: "WorkbotTeamMaxStepsSetting" })
export type WorkbotTeamMaxStepsSetting = z.infer<typeof workbotTeamMaxStepsSettingSchema>

/** One team's change. A setting left out is kept as it is. */
export const workbotTeamSettingsWriteSchema = z
  .strictObject({
    model: workbotTeamModelSettingSchema.optional(),
    name: workbotTeamNameSettingSchema.optional(),
    enabled: workbotTeamEnabledSettingSchema.optional(),
    /** Needs `workbotStepLimit` as well. */
    maxSteps: workbotTeamMaxStepsSettingSchema.optional(),
  })
  .meta({ ref: "WorkbotTeamSettingsWrite" })
export type WorkbotTeamSettingsWrite = z.infer<typeof workbotTeamSettingsWriteSchema>

/** A change for everyone in the organization. A setting left out is kept as it is. */
export const workbotEveryoneSettingsWriteSchema = z
  .strictObject({
    /** Whether Workbot is on for members whose teams do not say otherwise. */
    enabled: z.boolean().optional(),
  })
  .meta({ ref: "WorkbotEveryoneSettingsWrite" })
export type WorkbotEveryoneSettingsWrite = z.infer<typeof workbotEveryoneSettingsWriteSchema>

export const workbotTeamSettingsTeamSchema = z
  .object({
    teamId: z.string(),
    teamName: z.string(),
    memberCount: z.number().int().nonnegative(),
    model: workbotTeamModelSettingSchema,
    name: workbotTeamNameSettingSchema,
    enabled: workbotTeamEnabledSettingSchema,
    /** Present only while `workbotStepLimit` is on. */
    maxSteps: workbotTeamMaxStepsSettingSchema.optional(),
    /**
     * Members of this team who are also on another team that overrides a
     * setting differently; they get the organization's value for it.
     */
    conflictingMemberCount: z.number().int().nonnegative(),
  })
  .meta({ ref: "WorkbotTeamSettingsTeam" })
export type WorkbotTeamSettingsTeam = z.infer<typeof workbotTeamSettingsTeamSchema>

export const workbotTeamSettingsViewSchema = z
  .object({
    /**
     * The organization's values, which teams without their own use: null is the deployment's default model, or no
     * name set; `enabled` is whether Workbot is on for everyone; `maxSteps` is the step limit (0 is no limit, null
     * the deployment's default), present only while `workbotStepLimit` is on.
     */
    organization: z.object({
      model: z.string().nullable(),
      name: z.string().nullable(),
      enabled: z.boolean(),
      maxSteps: workbotTeamMaxStepsSchema.optional(),
    }),
    teams: z.array(workbotTeamSettingsTeamSchema),
    /** Whether the caller can change them (inference.manage). */
    canEdit: z.boolean(),
  })
  .meta({ ref: "WorkbotTeamSettings" })
export type WorkbotTeamSettingsView = z.infer<typeof workbotTeamSettingsViewSchema>

/** The stored settings after one change; an empty result means the team overrides nothing. */
export function applyWorkbotTeamSettingsWrite(stored: Record<string, unknown>, write: WorkbotTeamSettingsWrite): Record<string, unknown> {
  const readable = readWorkbotTeamSettings(stored)
  const next: Record<string, unknown> = { ...stored }
  // A value that could not be read was never an override; do not keep it.
  if (readable.model === undefined) delete next.model
  if (readable.name === undefined) delete next.name
  if (readable.enabled === undefined) delete next.enabled
  if (readable.maxSteps === undefined) delete next.maxSteps
  if (write.model) {
    if (write.model.inherit) delete next.model
    else next.model = write.model.value
  }
  if (write.name) {
    if (write.name.inherit) delete next.name
    else next.name = write.name.value
  }
  if (write.enabled) {
    if (write.enabled.inherit) delete next.enabled
    else next.enabled = write.enabled.value
  }
  if (write.maxSteps) {
    if (write.maxSteps.inherit) delete next.maxSteps
    else next.maxSteps = write.maxSteps.value
  }
  return next
}

/** Where a member's value came from: the teams that hold it, or the organization. */
export type WorkbotSettingSource =
  | { kind: "team"; teamNames: string[] }
  | { kind: "organization"; teamConflict: boolean }

export type ResolvedWorkbotTeamSettings = {
  model: { value: string | null; from: WorkbotSettingSource }
  name: { value: string | null; from: WorkbotSettingSource }
  enabled: { value: boolean; from: WorkbotSettingSource }
  maxSteps: { value: number | null; from: WorkbotSettingSource }
}

function resolveSetting<T>(organization: T, overrides: ReadonlyArray<{ name: string; value: T }>): { value: T; from: WorkbotSettingSource } {
  const first = overrides[0]
  if (!first) return { value: organization, from: { kind: "organization", teamConflict: false } }
  if (overrides.some((team) => team.value !== first.value)) return { value: organization, from: { kind: "organization", teamConflict: true } }
  return { value: first.value, from: { kind: "team", teamNames: overrides.map((team) => team.name).sort((left, right) => left.localeCompare(right)) } }
}

/**
 * One member's effective Workbot settings (see the rules at the top of this
 * file). `teams` are the member's teams; their order does not matter.
 */
export function resolveWorkbotTeamSettings(input: {
  organization: { model: string | null; name: string | null; enabled: boolean; maxSteps: number | null }
  teams: ReadonlyArray<{ name: string; settings: WorkbotTeamStoredSettings }>
}): ResolvedWorkbotTeamSettings {
  return {
    model: resolveSetting(
      input.organization.model,
      input.teams.flatMap((team) => team.settings.model !== undefined ? [{ name: team.name, value: team.settings.model }] : []),
    ),
    name: resolveSetting<string | null>(
      input.organization.name,
      input.teams.flatMap((team) => team.settings.name !== undefined ? [{ name: team.name, value: team.settings.name }] : []),
    ),
    enabled: resolveSetting(
      input.organization.enabled,
      input.teams.flatMap((team) => team.settings.enabled !== undefined ? [{ name: team.name, value: team.settings.enabled }] : []),
    ),
    maxSteps: resolveSetting(
      input.organization.maxSteps,
      input.teams.flatMap((team) => team.settings.maxSteps !== undefined ? [{ name: team.name, value: team.settings.maxSteps }] : []),
    ),
  }
}

/**
 * For each team, how many of its members are also on a team that overrides a
 * setting differently. Those members get the organization's value for it.
 */
export function countWorkbotTeamConflicts(input: {
  teams: ReadonlyArray<{ teamId: string; settings: WorkbotTeamStoredSettings }>
  memberships: ReadonlyArray<{ teamId: string; memberId: string }>
}): Map<string, number> {
  const settingsByTeam = new Map(input.teams.map((team) => [team.teamId, team.settings]))
  const overridesByMember = new Map<string, WorkbotTeamStoredSettings[]>()
  for (const membership of input.memberships) {
    const settings = settingsByTeam.get(membership.teamId)
    if (!settings) continue
    overridesByMember.set(membership.memberId, [...overridesByMember.get(membership.memberId) ?? [], settings])
  }
  const conflicted = new Set<string>()
  for (const [memberId, settings] of overridesByMember) {
    const models = settings.flatMap((entry) => entry.model !== undefined ? [entry.model] : [])
    const names = settings.flatMap((entry) => entry.name !== undefined ? [entry.name] : [])
    const switches = settings.flatMap((entry) => entry.enabled !== undefined ? [entry.enabled] : [])
    const limits = settings.flatMap((entry) => entry.maxSteps !== undefined ? [entry.maxSteps] : [])
    if (
      models.some((model) => model !== models[0])
      || names.some((name) => name !== names[0])
      || switches.some((enabled) => enabled !== switches[0])
      || limits.some((maxSteps) => maxSteps !== limits[0])
    ) conflicted.add(memberId)
  }
  const counts = new Map<string, number>(input.teams.map((team) => [team.teamId, 0]))
  for (const membership of input.memberships) {
    if (conflicted.has(membership.memberId) && counts.has(membership.teamId)) {
      counts.set(membership.teamId, (counts.get(membership.teamId) ?? 0) + 1)
    }
  }
  return counts
}
