// Pure helpers for Skill usage, kept free of database imports so they can be unit tested.

/** Loads of the same skill by the same member inside this window count once. */
export const SKILL_USE_DEDUPE_WINDOW_MS = 15 * 60_000

export function skillUseDedupeKey(use: { orgMembershipId: string; configObjectId: string; at?: Date }): string {
  const at = use.at ?? new Date()
  return `skill:${use.orgMembershipId}:${use.configObjectId}:${Math.floor(at.getTime() / SKILL_USE_DEDUPE_WINDOW_MS)}`
}

export type SkillUsageRow = {
  skillId: string
  skillName: string
  pluginId: string
  pluginName: string
  uses: number
  people: number
  lastUsedAt: string | null
}

export type SkillUsageReport = {
  days: number
  /** When the organization's first recorded use happened; null before any. */
  trackingSince: string | null
  skills: SkillUsageRow[]
}

export type SkillRef = { skillId: string; skillName: string; pluginId: string; pluginName: string }
export type UsageAggregate = { skillId: string; uses: number; people: number; lastUsedAt: Date | null }

/** Joins every live skill with its usage; unused skills come back with zeros. Most used first. */
export function buildSkillUsageRows(skills: readonly SkillRef[], usage: readonly UsageAggregate[]): SkillUsageRow[] {
  const bySkill = new Map(usage.map((row) => [row.skillId, row]))
  return skills
    .map((skill) => {
      const used = bySkill.get(skill.skillId)
      return {
        ...skill,
        uses: used?.uses ?? 0,
        people: used?.people ?? 0,
        lastUsedAt: used?.lastUsedAt ? used.lastUsedAt.toISOString() : null,
      }
    })
    .sort((a, b) => b.uses - a.uses || b.people - a.people || a.skillName.localeCompare(b.skillName))
}
