import { and, desc, eq, inArray, or } from "@openwork-ee/den-db/drizzle"
import { SkillHubMemberTable, SkillHubSkillTable, SkillHubTable, SkillTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { tokenize } from "./search.js"
import type { CapabilityMatch } from "./search.js"
import type { McpMemberIdentity } from "./external-capabilities.js"

const SKILL_CAPABILITY_PREFIX = "skill:"

type OrganizationId = DenTypeId<"organization">
type SkillId = DenTypeId<"skill">

type SkillSearchRow = {
  id: SkillId
  title: string
  description: string | null
  shared: "org" | "public" | null
  createdByOrgMembershipId: DenTypeId<"member">
  updatedAt: Date
}

type SkillReadRow = SkillSearchRow & {
  skillText: string
}

export type RemoteSkillDescriptor = {
  name: string
  description: string | null
  capability: string
  location: string
}

const AGENT_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function standardSkillName(title: string, skillId: string): string {
  const suffix = skillId.replace(/^skill_/, "").slice(-8).toLowerCase()
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
  const bounded = base.slice(0, Math.max(1, 64 - suffix.length - 1)).replace(/-+$/g, "")
  const name = `${bounded || "skill"}-${suffix}`
  return AGENT_SKILL_NAME_PATTERN.test(name) ? name : `skill-${suffix}`
}

export function buildSkillCapabilityName(skillId: string): string {
  return `${SKILL_CAPABILITY_PREFIX}${skillId}`
}

export function parseSkillCapabilityName(name: string): string | null {
  if (!name.startsWith(SKILL_CAPABILITY_PREFIX)) return null
  const skillId = name.slice(SKILL_CAPABILITY_PREFIX.length)
  return skillId.length > 0 ? skillId : null
}

function scoreText(nameTokens: string[], summaryTokens: string[], queryTokens: string[]): number {
  let score = 0
  for (const queryToken of queryTokens) {
    if (queryToken === "skill" || queryToken === "skills") {
      score += 1
      continue
    }
    if (nameTokens.includes(queryToken)) {
      score += 5
    } else if (nameTokens.some((token) => token.startsWith(queryToken) || queryToken.startsWith(token))) {
      score += 3
    }
    if (summaryTokens.includes(queryToken)) {
      score += 2
    }
  }
  return score
}

async function listHubAccessibleSkillIds(input: {
  organizationId: OrganizationId
  member: McpMemberIdentity
}): Promise<Set<SkillId>> {
  const grantCondition = input.member.teamIds.length > 0
    ? or(
        eq(SkillHubMemberTable.orgMembershipId, input.member.orgMembershipId),
        inArray(SkillHubMemberTable.teamId, input.member.teamIds),
      )
    : eq(SkillHubMemberTable.orgMembershipId, input.member.orgMembershipId)

  const rows = await db
    .select({ skillId: SkillHubSkillTable.skillId })
    .from(SkillHubSkillTable)
    .innerJoin(SkillHubTable, eq(SkillHubSkillTable.skillHubId, SkillHubTable.id))
    .innerJoin(SkillHubMemberTable, eq(SkillHubMemberTable.skillHubId, SkillHubTable.id))
    .where(and(
      eq(SkillHubTable.organizationId, input.organizationId),
      grantCondition,
    ))

  return new Set(rows.map((row) => row.skillId))
}

function canAccessSkill(input: {
  member: McpMemberIdentity
  skill: SkillSearchRow
  hubAccessibleSkillIds: Set<SkillId>
}) {
  return input.skill.createdByOrgMembershipId === input.member.orgMembershipId
    || input.skill.shared !== null
    || input.hubAccessibleSkillIds.has(input.skill.id)
}

async function listAccessibleSkills(input: {
  organizationId: string
  member: McpMemberIdentity | null
}): Promise<SkillSearchRow[]> {
  if (!input.member) return []
  const member = input.member
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const hubAccessibleSkillIds = await listHubAccessibleSkillIds({
    organizationId,
    member,
  })

  const skills = await db
    .select({
      id: SkillTable.id,
      title: SkillTable.title,
      description: SkillTable.description,
      shared: SkillTable.shared,
      createdByOrgMembershipId: SkillTable.createdByOrgMembershipId,
      updatedAt: SkillTable.updatedAt,
    })
    .from(SkillTable)
    .where(eq(SkillTable.organizationId, organizationId))
    .orderBy(desc(SkillTable.updatedAt))

  return skills.filter((skill) => canAccessSkill({
    member,
    skill,
    hubAccessibleSkillIds,
  }))
}

export async function listAccessibleSkillDescriptors(input: {
  organizationId: string
  member: McpMemberIdentity | null
}): Promise<RemoteSkillDescriptor[]> {
  const skills = await listAccessibleSkills(input)
  return skills
    .map((skill) => {
      const name = standardSkillName(skill.title, skill.id)
      return {
        name,
        description: skill.description,
        capability: buildSkillCapabilityName(skill.id),
        location: `skill://${name}/SKILL.md`,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.capability.localeCompare(b.capability))
}

async function getAccessibleSkill(input: {
  organizationId: string
  member: McpMemberIdentity | null
  skillId: string
}): Promise<SkillReadRow | null> {
  if (!input.member) return null
  const member = input.member
  let organizationId: OrganizationId
  let skillId: SkillId
  try {
    organizationId = normalizeDenTypeId("organization", input.organizationId)
    skillId = normalizeDenTypeId("skill", input.skillId)
  } catch {
    return null
  }

  const hubAccessibleSkillIds = await listHubAccessibleSkillIds({
    organizationId,
    member,
  })
  const rows = await db
    .select({
      id: SkillTable.id,
      title: SkillTable.title,
      description: SkillTable.description,
      shared: SkillTable.shared,
      createdByOrgMembershipId: SkillTable.createdByOrgMembershipId,
      updatedAt: SkillTable.updatedAt,
      skillText: SkillTable.skillText,
    })
    .from(SkillTable)
    .where(and(eq(SkillTable.id, skillId), eq(SkillTable.organizationId, organizationId)))
    .limit(1)
  const skill = rows[0]
  if (!skill) return null
  return canAccessSkill({ member, skill, hubAccessibleSkillIds }) ? skill : null
}

export async function searchSkillCapabilities(input: {
  organizationId: string
  member: McpMemberIdentity | null
  query: string
  limit?: number
}): Promise<CapabilityMatch[]> {
  const queryTokens = tokenize(input.query)
  if (queryTokens.length === 0) return []
  const skills = await listAccessibleSkills({
    organizationId: input.organizationId,
    member: input.member,
  })
  const matches = skills
    .map((skill) => {
      const summary = skill.description ?? skill.title
      return {
        name: buildSkillCapabilityName(skill.id),
        method: "SKILL",
        path: "SKILL.md",
        score: scoreText(tokenize(skill.title), tokenize(summary), queryTokens),
        summary: `[Skill] ${skill.title}${skill.description ? ` - ${skill.description}` : ""}`,
        pathParams: [],
        queryParams: [],
        hasBody: false,
      }
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name))

  return matches.slice(0, input.limit ?? 5)
}

export type SkillCapabilityExecuteResult =
  | { ok: true; skill: { id: SkillId; title: string; description: string | null; skillText: string; updatedAt: Date } }
  | { ok: false; error: "unknown_capability" | "forbidden"; message: string }

export async function executeSkillCapability(input: {
  organizationId: string
  member: McpMemberIdentity | null
  skillId: string
}): Promise<SkillCapabilityExecuteResult> {
  if (!input.member) {
    return { ok: false, error: "forbidden", message: "No active org membership for this token." }
  }
  const skill = await getAccessibleSkill(input)
  if (!skill) {
    return { ok: false, error: "unknown_capability", message: `No accessible skill "${input.skillId}" in this organization.` }
  }
  return {
    ok: true,
    skill: {
      id: skill.id,
      title: skill.title,
      description: skill.description,
      skillText: skill.skillText,
      updatedAt: skill.updatedAt,
    },
  }
}
