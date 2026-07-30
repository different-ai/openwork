/**
 * One-time data migration for removing the legacy Skill Hub / skill tables.
 *
 * Run this BEFORE applying the drop-tables migration. It reads plaintext rows
 * from the legacy `skill` tables and writes encrypted plugin-arch config object
 * versions, so it requires DATABASE_URL or DATABASE_HOST/DATABASE_USERNAME/
 * DATABASE_PASSWORD plus DEN_DB_ENCRYPTION_KEY. The den-db-migrate GitHub
 * workflow cannot run this script because it does not have the encryption key
 * secret; this is a manual pre-deploy step.
 *
 * Usage:
 *   pnpm --filter @openwork-ee/den-api migrate:skills-to-plugins        # dry run
 *   pnpm --filter @openwork-ee/den-api migrate:skills-to-plugins -- --yes
 *
 * Incident recovery after the legacy tables have already been dropped:
 *   1. Restore a PlanetScale backup to a branch.
 *   2. Copy skill, skill_hub, skill_hub_skill, and skill_hub_member into main
 *      under a prefix such as recovered_ (for example, recovered_skill).
 *   3. Run against production using the PlanetScale serverless driver over HTTPS
 *      (DATABASE_URL is NOT reachable externally):
 *      DATABASE_HOST=... DATABASE_USERNAME=... DATABASE_PASSWORD=... DEN_DB_ENCRYPTION_KEY=... \
 *        pnpm --filter @openwork-ee/den-api migrate:skills-to-plugins -- --table-prefix recovered_ --yes
 *   4. Drop the recovered_* tables after verifying the migrated plugins.
 */
import { createDenDb, type DenDbMode } from "@openwork-ee/den-db"
import { and, asc, eq, isNull, sql } from "@openwork-ee/den-db/drizzle"
import {
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  DEFAULT_OPENWORK_MARKETPLACE_DESCRIPTION,
  DEFAULT_OPENWORK_MARKETPLACE_LOGO_URL,
  DEFAULT_OPENWORK_MARKETPLACE_NAME,
} from "../src/routes/org/plugin-system/default-marketplaces.js"

const tablePrefix = resolveTablePrefix()
const { db } = createDenDb(resolveDbConfig())

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type ConfigObjectId = DenTypeId<"configObject">
type MemberId = DenTypeId<"member">
type OrganizationId = DenTypeId<"organization">
type PluginId = DenTypeId<"plugin">
type TeamId = DenTypeId<"team">
type LegacySkillRow = {
  createdAt: Date
  createdByOrgMembershipId: string
  description: string | null
  id: string
  organizationId: string
  shared: "org" | "public" | null
  skillText: string
  title: string
  updatedAt: Date
}
type LegacyHubRow = { id: string }
type LegacyHubSkillRow = {
  id: string
  skillHubId: string
  skillId: string
}
type LegacyHubMemberRow = {
  id: string
  orgMembershipId: string | null
  skillHubId: string
  teamId: string | null
}
type Summary = {
  backfilled: number
  downgrades: number
  migrated: number
  skipped: number
}

type LegacyTableName = "skill" | "skill_hub" | "skill_hub_skill" | "skill_hub_member"

function parseDbMode(value: string | undefined): DenDbMode | undefined {
  if (value === "mysql" || value === "planetscale") return value
  return undefined
}

function cliValue(flag: string) {
  const index = process.argv.indexOf(flag)
  if (index === -1) return null
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value.`)
  return value
}

function resolveTablePrefix() {
  const prefix = cliValue("--table-prefix") ?? process.env.SKILL_MIGRATION_TABLE_PREFIX ?? ""
  if (!/^[a-z0-9_]*$/.test(prefix)) {
    throw new Error("--table-prefix/SKILL_MIGRATION_TABLE_PREFIX may only contain lowercase letters, digits, and underscores.")
  }
  return prefix
}

function legacyTable(name: LegacyTableName) {
  return sql.raw(`${tablePrefix}${name}`)
}

function resolveDbConfig() {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  const mode = parseDbMode(process.env.DB_MODE)
  const host = process.env.DATABASE_HOST?.trim()
  const username = process.env.DATABASE_USERNAME?.trim()
  const password = process.env.DATABASE_PASSWORD ?? ""

  if (!process.env.DEN_DB_ENCRYPTION_KEY?.trim()) {
    throw new Error("DEN_DB_ENCRYPTION_KEY is required to decrypt and write encrypted config object versions.")
  }
  if (!databaseUrl && (!host || !username)) {
    throw new Error("Provide DATABASE_URL, or DATABASE_HOST/DATABASE_USERNAME/DATABASE_PASSWORD.")
  }

  return {
    databaseUrl,
    mode,
    planetscale: host && username ? { host, username, password } : null,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function queryRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    const first = result[0]
    if (Array.isArray(first) && first.every(isRecord)) return first
    if (result.every(isRecord)) return result
  }
  if (isRecord(result)) {
    const rows = result.rows
    if (Array.isArray(rows) && rows.every(isRecord)) return rows
  }
  return []
}

function requiredString(row: Record<string, unknown>, key: string) {
  const value = row[key]
  if (typeof value !== "string") throw new Error(`Expected ${key} to be a string.`)
  return value
}

function optionalStringField(row: Record<string, unknown>, key: string) {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value !== "string") throw new Error(`Expected ${key} to be a string or null.`)
  return value
}

function requiredDate(row: Record<string, unknown>, key: string) {
  const value = row[key]
  if (value instanceof Date) return value
  if (typeof value === "string" || typeof value === "number") return new Date(value)
  throw new Error(`Expected ${key} to be a date.`)
}

function sharedValue(row: Record<string, unknown>) {
  const value = row.shared
  if (value === "org" || value === "public" || value === null || value === undefined) return value ?? null
  throw new Error("Expected shared to be org, public, or null.")
}

async function legacyRows(query: ReturnType<typeof sql>) {
  return queryRows(await db.execute(query))
}

async function legacySkills(): Promise<LegacySkillRow[]> {
  const rows = await legacyRows(sql`
    select id, organization_id, created_by_org_membership_id, title, description, skill_text, shared, created_at, updated_at
    from ${legacyTable("skill")}
    order by created_at asc, id asc
  `)
  return rows.map((row) => ({
    createdAt: requiredDate(row, "created_at"),
    createdByOrgMembershipId: requiredString(row, "created_by_org_membership_id"),
    description: optionalStringField(row, "description"),
    id: requiredString(row, "id"),
    organizationId: requiredString(row, "organization_id"),
    shared: sharedValue(row),
    skillText: requiredString(row, "skill_text"),
    title: requiredString(row, "title"),
    updatedAt: requiredDate(row, "updated_at"),
  }))
}

async function legacyHubs(): Promise<LegacyHubRow[]> {
  const rows = await legacyRows(sql`select id from ${legacyTable("skill_hub")}`)
  return rows.map((row) => ({ id: requiredString(row, "id") }))
}

async function legacyHubSkills(): Promise<LegacyHubSkillRow[]> {
  const rows = await legacyRows(sql`select id, skill_hub_id, skill_id from ${legacyTable("skill_hub_skill")}`)
  return rows.map((row) => ({
    id: requiredString(row, "id"),
    skillHubId: requiredString(row, "skill_hub_id"),
    skillId: requiredString(row, "skill_id"),
  }))
}

async function legacyHubMembers(): Promise<LegacyHubMemberRow[]> {
  const rows = await legacyRows(sql`select id, skill_hub_id, org_membership_id, team_id from ${legacyTable("skill_hub_member")}`)
  return rows.map((row) => ({
    id: requiredString(row, "id"),
    orgMembershipId: optionalStringField(row, "org_membership_id"),
    skillHubId: requiredString(row, "skill_hub_id"),
    teamId: optionalStringField(row, "team_id"),
  }))
}

function readString(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function applyMigration() {
  return process.argv.includes("--yes")
}

function orgSummary(summaries: Map<string, Summary>, organizationId: string) {
  const current = summaries.get(organizationId)
  if (current) return current
  const next = { backfilled: 0, downgrades: 0, migrated: 0, skipped: 0 }
  summaries.set(organizationId, next)
  return next
}

function collectMigratedSkillIds(rows: { normalizedPayloadJson: Record<string, unknown> | null }[]) {
  const migrated = new Set<string>()
  for (const row of rows) {
    const skillId = readString(row.normalizedPayloadJson, "migratedFromSkillId")
    if (skillId) migrated.add(skillId)
  }
  return migrated
}

async function ensureDefaultOpenWorkMarketplace(input: {
  createdByOrgMembershipId: MemberId
  database: DbTransaction
  organizationId: OrganizationId
}) {
  const existing = (await input.database
    .select()
    .from(MarketplaceTable)
    .where(and(
      eq(MarketplaceTable.organizationId, input.organizationId),
      eq(MarketplaceTable.name, DEFAULT_OPENWORK_MARKETPLACE_NAME),
      isNull(MarketplaceTable.deletedAt),
    ))
    .limit(1))[0]

  const marketplaceId = existing?.id ?? createDenTypeId("marketplace")
  if (!existing) {
    await input.database.insert(MarketplaceTable).values({
      id: marketplaceId,
      organizationId: input.organizationId,
      name: DEFAULT_OPENWORK_MARKETPLACE_NAME,
      description: DEFAULT_OPENWORK_MARKETPLACE_DESCRIPTION,
      logoUrl: DEFAULT_OPENWORK_MARKETPLACE_LOGO_URL,
      status: "active",
      createdByOrgMembershipId: input.createdByOrgMembershipId,
      deletedAt: null,
    })
  }

  const existingGrant = (await input.database
    .select()
    .from(MarketplaceAccessGrantTable)
    .where(and(eq(MarketplaceAccessGrantTable.marketplaceId, marketplaceId), eq(MarketplaceAccessGrantTable.orgWide, true)))
    .limit(1))[0]
  if (existingGrant) {
    if (existingGrant.removedAt || existingGrant.role !== "viewer") {
      await input.database.update(MarketplaceAccessGrantTable).set({
        createdByOrgMembershipId: input.createdByOrgMembershipId,
        removedAt: null,
        role: "viewer",
      }).where(eq(MarketplaceAccessGrantTable.id, existingGrant.id))
    }
  } else {
    await input.database.insert(MarketplaceAccessGrantTable).values({
      id: createDenTypeId("marketplaceAccessGrant"),
      organizationId: input.organizationId,
      marketplaceId,
      orgMembershipId: null,
      teamId: null,
      orgWide: true,
      role: "viewer",
      createdByOrgMembershipId: input.createdByOrgMembershipId,
    })
  }

  return marketplaceId
}

async function attachPluginToDefaultMarketplace(input: {
  createdByOrgMembershipId: MemberId
  database: DbTransaction
  organizationId: OrganizationId
  pluginId: PluginId
}) {
  const marketplaceId = await ensureDefaultOpenWorkMarketplace(input)
  const existing = (await input.database
    .select()
    .from(MarketplacePluginTable)
    .where(and(eq(MarketplacePluginTable.marketplaceId, marketplaceId), eq(MarketplacePluginTable.pluginId, input.pluginId)))
    .limit(1))[0]

  if (existing) {
    if (existing.removedAt) {
      await input.database.update(MarketplacePluginTable).set({ removedAt: null }).where(eq(MarketplacePluginTable.id, existing.id))
    }
    return
  }

  await input.database.insert(MarketplacePluginTable).values({
    id: createDenTypeId("marketplacePlugin"),
    organizationId: input.organizationId,
    marketplaceId,
    pluginId: input.pluginId,
    membershipSource: "manual",
    createdByOrgMembershipId: input.createdByOrgMembershipId,
    removedAt: null,
  })
}

async function appendSkillRawSourceVersion(input: {
  apply: boolean
  createdByOrgMembershipId: MemberId | null
  createdVia: "cloud" | "import" | "connector" | "system"
  configObjectId: ConfigObjectId
  organizationId: OrganizationId
  skill: LegacySkillRow
}) {
  if (!input.apply) return
  await db.insert(ConfigObjectVersionTable).values({
    id: createDenTypeId("configObjectVersion"),
    organizationId: input.organizationId,
    configObjectId: input.configObjectId,
    normalizedPayloadJson: { migratedFromSkillId: input.skill.id },
    rawSourceText: input.skill.skillText,
    schemaVersion: null,
    createdVia: input.createdVia,
    createdByOrgMembershipId: input.createdByOrgMembershipId,
    connectorSyncEventId: null,
    sourceRevisionRef: null,
    isDeletedVersion: false,
    createdAt: new Date(),
  })
}

function skillAccess(input: {
  creatorMemberId: MemberId
  hubMembers: LegacyHubMemberRow[]
  shared: LegacySkillRow["shared"]
}) {
  const orgWide = input.shared === "org" || input.shared === "public"
  const memberIds = new Set<MemberId>()
  const teamIds = new Set<TeamId>()
  if (!orgWide) {
    for (const member of input.hubMembers) {
      if (member.orgMembershipId && member.orgMembershipId !== input.creatorMemberId) {
        memberIds.add(normalizeDenTypeId("member", member.orgMembershipId))
      }
      if (member.teamId) {
        teamIds.add(normalizeDenTypeId("team", member.teamId))
      }
    }
  }
  return { memberIds, orgWide, teamIds }
}

async function migrateStandaloneSkill(input: {
  apply: boolean
  hubMembers: LegacyHubMemberRow[]
  skill: LegacySkillRow
}) {
  const organizationId = normalizeDenTypeId("organization", input.skill.organizationId)
  const creatorMemberId = normalizeDenTypeId("member", input.skill.createdByOrgMembershipId)
  const pluginId = createDenTypeId("plugin")
  const configObjectId = createDenTypeId("configObject")
  const access = skillAccess({ creatorMemberId, hubMembers: input.hubMembers, shared: input.skill.shared })
  if (!input.apply) return

  await db.transaction(async (tx) => {
    await tx.insert(PluginTable).values({
      id: pluginId,
      organizationId,
      name: input.skill.title,
      description: input.skill.description,
      status: "active",
      createdByOrgMembershipId: creatorMemberId,
      deletedAt: null,
    })

    await tx.insert(ConfigObjectTable).values({
      id: configObjectId,
      organizationId,
      objectType: "skill",
      sourceMode: "cloud",
      title: input.skill.title,
      description: input.skill.description,
      searchText: [input.skill.title, input.skill.description, input.skill.skillText].filter(Boolean).join("\n"),
      currentFileName: null,
      currentFileExtension: null,
      currentRelativePath: null,
      status: "active",
      createdByOrgMembershipId: creatorMemberId,
      connectorInstanceId: null,
      deletedAt: null,
    })

    await tx.insert(ConfigObjectVersionTable).values({
      id: createDenTypeId("configObjectVersion"),
      organizationId,
      configObjectId,
      normalizedPayloadJson: { migratedFromSkillId: input.skill.id },
      rawSourceText: input.skill.skillText,
      schemaVersion: null,
      createdVia: "cloud",
      createdByOrgMembershipId: creatorMemberId,
      connectorSyncEventId: null,
      sourceRevisionRef: null,
      isDeletedVersion: false,
    })

    await tx.insert(PluginConfigObjectTable).values({
      id: createDenTypeId("pluginConfigObject"),
      organizationId,
      pluginId,
      configObjectId,
      membershipSource: "manual",
      connectorMappingId: null,
      createdByOrgMembershipId: creatorMemberId,
    })

    const pluginGrants: (typeof PluginAccessGrantTable.$inferInsert)[] = [{
      id: createDenTypeId("pluginAccessGrant"),
      organizationId,
      pluginId,
      orgMembershipId: creatorMemberId,
      teamId: null,
      orgWide: false,
      role: "manager",
      createdByOrgMembershipId: creatorMemberId,
    }]
    const objectGrants: (typeof ConfigObjectAccessGrantTable.$inferInsert)[] = [{
      id: createDenTypeId("configObjectAccessGrant"),
      organizationId,
      configObjectId,
      orgMembershipId: creatorMemberId,
      teamId: null,
      orgWide: false,
      role: "manager",
      createdByOrgMembershipId: creatorMemberId,
    }]

    if (access.orgWide) {
      pluginGrants.push({
        id: createDenTypeId("pluginAccessGrant"),
        organizationId,
        pluginId,
        orgMembershipId: null,
        teamId: null,
        orgWide: true,
        role: "viewer",
        createdByOrgMembershipId: creatorMemberId,
      })
      objectGrants.push({
        id: createDenTypeId("configObjectAccessGrant"),
        organizationId,
        configObjectId,
        orgMembershipId: null,
        teamId: null,
        orgWide: true,
        role: "viewer",
        createdByOrgMembershipId: creatorMemberId,
      })
    }

    for (const memberId of access.memberIds) {
      pluginGrants.push({
        id: createDenTypeId("pluginAccessGrant"),
        organizationId,
        pluginId,
        orgMembershipId: memberId,
        teamId: null,
        orgWide: false,
        role: "viewer",
        createdByOrgMembershipId: creatorMemberId,
      })
      objectGrants.push({
        id: createDenTypeId("configObjectAccessGrant"),
        organizationId,
        configObjectId,
        orgMembershipId: memberId,
        teamId: null,
        orgWide: false,
        role: "viewer",
        createdByOrgMembershipId: creatorMemberId,
      })
    }

    for (const teamId of access.teamIds) {
      pluginGrants.push({
        id: createDenTypeId("pluginAccessGrant"),
        organizationId,
        pluginId,
        orgMembershipId: null,
        teamId,
        orgWide: false,
        role: "viewer",
        createdByOrgMembershipId: creatorMemberId,
      })
      objectGrants.push({
        id: createDenTypeId("configObjectAccessGrant"),
        organizationId,
        configObjectId,
        orgMembershipId: null,
        teamId,
        orgWide: false,
        role: "viewer",
        createdByOrgMembershipId: creatorMemberId,
      })
    }

    await tx.insert(PluginAccessGrantTable).values(pluginGrants)
    await tx.insert(ConfigObjectAccessGrantTable).values(objectGrants)
    await attachPluginToDefaultMarketplace({
      createdByOrgMembershipId: creatorMemberId,
      database: tx,
      organizationId,
      pluginId,
    })
  })
}

async function main() {
  const apply = applyMigration()
  const summaries = new Map<string, Summary>()

  const skills = await legacySkills()
  const skillById = new Map(skills.map((skill) => [skill.id, skill]))
  const existingVersions = await db
    .select({ normalizedPayloadJson: ConfigObjectVersionTable.normalizedPayloadJson })
    .from(ConfigObjectVersionTable)
  const migratedSkillIds = collectMigratedSkillIds(existingVersions)
  const pointerSkillIds = new Set<string>()

  const pointerVersions = await db
    .select({
      configObjectId: ConfigObjectVersionTable.configObjectId,
      createdByOrgMembershipId: ConfigObjectVersionTable.createdByOrgMembershipId,
      createdVia: ConfigObjectVersionTable.createdVia,
      normalizedPayloadJson: ConfigObjectVersionTable.normalizedPayloadJson,
      organizationId: ConfigObjectVersionTable.organizationId,
    })
    .from(ConfigObjectVersionTable)
    .where(eq(ConfigObjectVersionTable.schemaVersion, "openwork.den_skill.v1"))
    .orderBy(asc(ConfigObjectVersionTable.createdAt), asc(ConfigObjectVersionTable.id))

  for (const version of pointerVersions) {
    const skillId = readString(version.normalizedPayloadJson, "denSkillId")
    if (!skillId) continue
    pointerSkillIds.add(skillId)
    const skill = skillById.get(skillId)
    if (!skill || migratedSkillIds.has(skillId)) {
      if (skill) orgSummary(summaries, skill.organizationId).skipped += 1
      continue
    }
    await appendSkillRawSourceVersion({
      apply,
      configObjectId: version.configObjectId,
      createdByOrgMembershipId: version.createdByOrgMembershipId,
      createdVia: version.createdVia,
      organizationId: version.organizationId,
      skill,
    })
    migratedSkillIds.add(skillId)
    orgSummary(summaries, skill.organizationId).backfilled += 1
  }

  const hubs = await legacyHubs()
  const hubIds = new Set(hubs.map((hub) => hub.id))
  const hubSkillLinks = await legacyHubSkills()
  const hubMembers = await legacyHubMembers()
  const hubMembersByHubId = new Map<string, LegacyHubMemberRow[]>()
  for (const member of hubMembers) {
    const existing = hubMembersByHubId.get(member.skillHubId) ?? []
    existing.push(member)
    hubMembersByHubId.set(member.skillHubId, existing)
  }
  const accessBySkillId = new Map<string, LegacyHubMemberRow[]>()
  for (const link of hubSkillLinks) {
    if (!hubIds.has(link.skillHubId)) continue
    const existing = accessBySkillId.get(link.skillId) ?? []
    existing.push(...(hubMembersByHubId.get(link.skillHubId) ?? []))
    accessBySkillId.set(link.skillId, existing)
  }

  for (const skill of skills) {
    const summary = orgSummary(summaries, skill.organizationId)
    if (pointerSkillIds.has(skill.id) || migratedSkillIds.has(skill.id)) {
      summary.skipped += 1
      continue
    }
    await migrateStandaloneSkill({
      apply,
      hubMembers: accessBySkillId.get(skill.id) ?? [],
      skill,
    })
    migratedSkillIds.add(skill.id)
    summary.migrated += 1
    if (skill.shared === "public") summary.downgrades += 1
  }

  console.log(apply ? "Applied skill-to-plugin migration." : "Dry run: no writes performed. Re-run with --yes to apply.")
  for (const [organizationId, summary] of [...summaries.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`${organizationId}: migrated=${summary.migrated} backfilled=${summary.backfilled} skipped=${summary.skipped} publicDowngrades=${summary.downgrades}`)
  }
  if (summaries.size === 0) {
    console.log("No legacy skills found.")
  }
  if ([...summaries.values()].some((summary) => summary.downgrades > 0)) {
    console.log("Note: legacy shared=public skills were downgraded to org-wide viewer grants; plugin marketplaces have no public-sharing equivalent.")
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
