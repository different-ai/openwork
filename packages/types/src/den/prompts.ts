import { z } from "zod"

/**
 * Prompts: system prompts organization admins write to steer the work agents
 * carry out on members' desktops. Like other organization items, a prompt can
 * be assigned to everyone, to members and to teams. The Den web UI creates one
 * prompt per scope for now: the Everyone page's prompt is assigned to
 * everyone, and a team page's prompt to that team.
 *
 * Desktops append the prompts that apply to a member to OpenWork's own
 * instructions, in this order (resolveMemberPrompts):
 *   1. Prompts assigned to everyone.
 *   2. Prompts assigned to the member's teams, by team name.
 *   3. Prompts assigned to the member directly.
 * A prompt that applies more than once is added once, at its first place.
 *
 * No relative value imports: the Den web build cannot resolve relative `.js`
 * imports from this package.
 */

export const ORG_PROMPT_MAX_LENGTH = 20_000

export const orgPromptAssignmentSchema = z
  .object({
    everyone: z.boolean(),
    teamIds: z.array(z.string()),
    memberIds: z.array(z.string()),
  })
  .meta({ ref: "OrgPromptAssignment" })
export type OrgPromptAssignment = z.infer<typeof orgPromptAssignmentSchema>

export const orgPromptSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    content: z.string(),
    assignment: orgPromptAssignmentSchema,
    updatedAt: z.string().datetime(),
  })
  .meta({ ref: "OrgPrompt" })
export type OrgPrompt = z.infer<typeof orgPromptSchema>

export const orgPromptTeamSchema = z
  .object({
    teamId: z.string(),
    name: z.string(),
    /** The team's own prompt, or null when it has none. */
    prompt: orgPromptSchema.nullable(),
  })
  .meta({ ref: "OrgPromptTeam" })
export type OrgPromptTeam = z.infer<typeof orgPromptTeamSchema>

export const orgPromptSettingsSchema = z
  .object({
    /** The prompt for everyone, or null when there is none. */
    everyone: orgPromptSchema.nullable(),
    /** Every team, by name. */
    teams: z.array(orgPromptTeamSchema),
    /** Whether the caller can change prompts. */
    canEdit: z.boolean(),
  })
  .meta({ ref: "OrgPromptSettings" })
export type OrgPromptSettings = z.infer<typeof orgPromptSettingsSchema>

export const orgPromptWriteSchema = z
  .object({
    content: z.string().max(ORG_PROMPT_MAX_LENGTH).refine((value) => value.trim().length > 0, { message: "Write a prompt before saving." }),
  })
  .strict()
  .meta({ ref: "OrgPromptWrite" })
export type OrgPromptWrite = z.infer<typeof orgPromptWriteSchema>

export const ORG_PROMPT_SOURCES = ["organization", "team", "member"] as const
export type OrgPromptSource = (typeof ORG_PROMPT_SOURCES)[number]

export const memberPromptSchema = z
  .object({
    id: z.string(),
    source: z.enum(ORG_PROMPT_SOURCES),
    /** The team it applies through, for team prompts. */
    teamName: z.string().optional(),
    content: z.string(),
  })
  .meta({ ref: "MemberPrompt" })
export type MemberPrompt = z.infer<typeof memberPromptSchema>

export const memberPromptsSchema = z
  .object({
    /** In the order desktops append them. */
    prompts: z.array(memberPromptSchema),
  })
  .meta({ ref: "MemberPrompts" })
export type MemberPrompts = z.infer<typeof memberPromptsSchema>

export type ResolvablePrompt = {
  id: string
  content: string
  createdAt: Date
  assignment: OrgPromptAssignment
}

/** The prompts that apply to one member, in the order desktops append them. */
export function resolveMemberPrompts(input: {
  prompts: readonly ResolvablePrompt[]
  memberId: string
  teams: readonly { id: string; name: string }[]
}): MemberPrompt[] {
  const byAge = [...input.prompts].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
  const teams = [...input.teams].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  const seen = new Set<string>()
  const resolved: MemberPrompt[] = []
  const add = (prompt: ResolvablePrompt, entry: Omit<MemberPrompt, "id" | "content">) => {
    if (seen.has(prompt.id) || prompt.content.trim().length === 0) return
    seen.add(prompt.id)
    resolved.push({ id: prompt.id, content: prompt.content, ...entry })
  }
  for (const prompt of byAge) if (prompt.assignment.everyone) add(prompt, { source: "organization" })
  for (const team of teams) {
    for (const prompt of byAge) if (prompt.assignment.teamIds.includes(team.id)) add(prompt, { source: "team", teamName: team.name })
  }
  for (const prompt of byAge) if (prompt.assignment.memberIds.includes(input.memberId)) add(prompt, { source: "member" })
  return resolved
}

/** The text desktops append to OpenWork's instructions, or "" when no prompt applies. */
export function composeMemberPromptText(prompts: readonly Pick<MemberPrompt, "content">[]): string {
  return prompts.map((prompt) => prompt.content.trim()).filter(Boolean).join("\n\n")
}
