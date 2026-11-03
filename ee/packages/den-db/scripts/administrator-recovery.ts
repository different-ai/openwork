import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import mysql from "mysql2/promise"
import { isDenTypeId } from "@openwork-ee/utils/typeid"
import { parseFeatureEnvironment, resolveFeature, type FeatureRollouts, type FeatureOverrides } from "@openwork/features"
import { parseMySqlConnectionConfig } from "../src/mysql-config.ts"

type Organization = { id: string; slug: string; name: string }
type Target = { organization: Organization; selector: string }
type RecoveryMode = "check" | "apply"
const stable = (prefix: string, value: string) => `${prefix}_0${createHash("sha256").update(`admin-recovery-0155:${value}`).digest("hex").slice(0, 25)}`
const safeText = (value: string) => value.replace(/\S+@\S+/gu, "[email omitted]")
const log = (value: unknown) => console.log(JSON.stringify(value, (_key: string, part: unknown) => typeof part === "string" ? safeText(part) : part))

/** The detailed refusal is already printed with its roster and next steps. */
export class AdministratorRecoveryRefusedError extends Error {}

function expectedMembersFromEnv(): number | undefined {
  const raw = process.env.DEN_ADMINISTRATOR_RECOVERY_EXPECTED_MEMBERS?.trim()
  if (!raw) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("expectedMembers must be a non-negative integer")
  return value
}

function printRoster(people: mysql.RowDataPacket[]) {
  for (const person of people) log({ event: "administrator_recovery_recipient", memberId: person.id, name: person.name, role: person.role, viaTeam: true, connected: person.user_id !== null, setupAgent: person.is_setup_agent === 1, ownerUnchanged: person.role === "owner" })
}

function requireMemberCount(expected: number | undefined, people: mysql.RowDataPacket[], team: { id: string; name: string }) {
  if (expected === undefined || expected === people.length) return
  const message = `ADMIN RECOVERY REFUSED — nothing was changed. Expected ${expected} members in team ${safeText(team.name)} (${team.id}), found ${people.length}.`
  console.log(message)
  printRoster(people)
  console.log(`Next step 1: If this list is right, set expectedMembers to ${people.length} and run again.`)
  console.log("Next step 2: Otherwise, ask the owner to remove the person from the team first, then run again.")
  throw new AdministratorRecoveryRefusedError(message)
}

export function administratorRecoveryModeFromEnv(): RecoveryMode {
  const mode = process.env.DEN_ADMINISTRATOR_RECOVERY_MODE?.trim() || "check"
  if (mode !== "check" && mode !== "apply") throw new Error("Administrator recovery mode must be check or apply")
  return mode
}

function teamEntriesFromEnv(): Array<[string, unknown]> {
  const raw: unknown = JSON.parse(process.env.DEN_ADMINISTRATOR_RECOVERY_TEAMS || "{}")
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Recovery teams must be an organization-to-team map")
  return Object.entries(raw)
}

function organizationFor(organizations: Organization[], selector: string): Organization {
  const matches = organizations.filter((org) => isDenTypeId("organization", selector) ? org.id === selector : org.slug === selector)
  if (matches.length === 0) throw new Error(`Recovery organization ${JSON.stringify(selector)} was not found; use its ID or exact slug`)
  if (matches.length !== 1) throw new Error(`Recovery organization ${JSON.stringify(selector)} is ambiguous; use its ID`)
  const organization = matches[0]
  if (!organization) throw new Error("Recovery organization was not found")
  return organization
}

function targetsFromEnv(organizations: Organization[]): Target[] {
  const entries = teamEntriesFromEnv()
  const team = process.env.DEN_ADMINISTRATOR_RECOVERY_TEAM?.trim()
  const selector = process.env.DEN_ADMINISTRATOR_RECOVERY_ORGANIZATION?.trim()
  if (entries.length && (team || selector)) throw new Error("Use recovery team/organization or the teams map, not both")
  const targets: Target[] = []
  if (entries.length) {
    for (const [org, value] of entries) {
      if (typeof value !== "string" || !value.trim()) throw new Error("Recovery team IDs or names must be non-empty strings")
      targets.push({ organization: organizationFor(organizations, org), selector: value.trim() })
    }
  } else {
    if (!team) throw new Error("An enabled recovery requires an explicit team ID or name")
    let organization: Organization | undefined
    if (selector) organization = organizationFor(organizations, selector)
    else {
      if (organizations.length !== 1) throw new Error("Recovery organization is required when the database does not contain exactly one organization; set its ID or slug")
      organization = organizations[0]
    }
    if (!organization) throw new Error("Recovery organization was not found")
    targets.push({ organization, selector: team })
  }
  if (new Set(targets.map((target) => target.organization.id)).size !== targets.length) throw new Error("Recovery organization selected more than once; use one ID or slug per organization")
  return targets
}

async function featureEnabled(connection: mysql.Connection, organizationId: string, environment: ReturnType<typeof parseFeatureEnvironment>, lock: boolean) {
  const suffix = lock ? " LOCK IN SHARE MODE" : ""
  const [rolloutRows] = await connection.query<mysql.RowDataPacket[]>("SELECT enabled,killed FROM feature_rollout WHERE feature_key='administratorRecovery'" + suffix)
  const [overrideRows] = await connection.query<mysql.RowDataPacket[]>("SELECT enabled FROM organization_feature WHERE organization_id=? AND feature_key='administratorRecovery'" + suffix, [organizationId])
  const rollouts: FeatureRollouts = {}
  const overrides: FeatureOverrides = {}
  if (rolloutRows[0]) rollouts.administratorRecovery = { enabled: rolloutRows[0].enabled === 1, killed: rolloutRows[0].killed === 1 }
  if (overrideRows[0]) {
    // An explicit organization denial is a recovery safety stop, even when
    // the installation operator enabled the flag in Helm.
    if (overrideRows[0].enabled !== 1) return false
    overrides.administratorRecovery = true
  }
  return resolveFeature("administratorRecovery", { ...environment, rollouts, overrides }).enabled
}

/** Probe only flag state, never target/mode configuration. A disabled install
 * follows normal database bootstrap without recovery output or extra writes. */
export async function administratorRecoveryRequestedFromEnv(): Promise<boolean> {
  const environment = parseFeatureEnvironment(process.env)
  if (environment.locks.administratorRecovery === false) return false
  if (environment.problems.some((problem) => problem.fatal)) throw new Error("Invalid feature environment")
  const explicitlyEnabled = environment.locks.administratorRecovery === true
  const url = process.env.DATABASE_URL?.trim()
  if (!url) {
    if (explicitlyEnabled) throw new Error("Deploy-time recovery requires the bootstrap TCP DATABASE_URL")
    return false
  }
  const connection = await mysql.createConnection(parseMySqlConnectionConfig(url))
  try {
    const [rows] = await connection.query<mysql.RowDataPacket[]>("SHOW TABLES")
    const tables = new Set(rows.flatMap((row) => Object.values(row).filter((value): value is string => typeof value === "string")))
    if (!["organization", "feature_rollout", "organization_feature"].every((table) => tables.has(table))) return explicitlyEnabled
    const [organizations] = await connection.query<mysql.RowDataPacket[]>("SELECT id FROM organization")
    if (organizations.length === 0) return explicitlyEnabled
    for (const org of organizations) {
      if (typeof org.id === "string" && await featureEnabled(connection, org.id, environment, false)) return true
    }
    return false
  } finally { await connection.end() }
}

async function scimManaged(connection: mysql.Connection, teamId: string) {
  const [rows] = await connection.query<mysql.RowDataPacket[]>("SELECT id FROM scim_group WHERE team_id=? UNION ALL SELECT id FROM scim_group_member WHERE team_member_id IN (SELECT id FROM team_member WHERE team_id=?) LIMIT 1", [teamId, teamId])
  return rows.length > 0
}

async function resolveTeam(connection: mysql.Connection, target: Target, lock: boolean) {
  const byId = isDenTypeId("team", target.selector)
  if (!byId) {
    const [candidates] = await connection.query<mysql.RowDataPacket[]>("SELECT id,name FROM team WHERE organization_id=? AND grants_organization_admin=1 ORDER BY id" + (lock ? " FOR UPDATE" : ""), [target.organization.id])
    const adminTeams: Array<{ id: string; name: string; scimManaged: boolean }> = []
    for (const candidate of candidates) {
      if (typeof candidate.id !== "string" || typeof candidate.name !== "string") throw new Error("Invalid recovery team record")
      adminTeams.push({ id: candidate.id, name: candidate.name, scimManaged: await scimManaged(connection, candidate.id) })
    }
    if (adminTeams.length !== 1 || adminTeams.some((team) => team.scimManaged)) {
      const message = "ADMIN RECOVERY REFUSED — nothing was changed. A team name requires exactly one designated non-SCIM Admin team in the organization. Use a team ID. SCIM-managed teams are excluded."
      console.log(message)
      for (const team of adminTeams) log({ event: "administrator_recovery_admin_team", ...team })
      throw new AdministratorRecoveryRefusedError(message)
    }
  }
  const statement = byId
    ? "SELECT id,name,grants_organization_admin FROM team WHERE organization_id=? AND id=?"
    : "SELECT id,name,grants_organization_admin FROM team WHERE organization_id=? AND name=?"
  const [rows] = await connection.query<mysql.RowDataPacket[]>(statement + (lock ? " FOR UPDATE" : ""), [target.organization.id, target.selector])
  if (rows.length === 0) throw new Error(`No recovery team ${JSON.stringify(target.selector)} in organization ${JSON.stringify(target.organization.slug)}`)
  if (rows.length !== 1) throw new Error(`Recovery team name ${JSON.stringify(target.selector)} is ambiguous in this organization; use a team ID`)
  const row = rows[0]
  if (!row || typeof row.id !== "string" || typeof row.name !== "string") throw new Error("Invalid recovery team record")
  if (row.grants_organization_admin !== 1) throw new Error("Recovery target must be a designated Admin team, not an ordinary team")
  if (await scimManaged(connection, row.id)) throw new Error("SCIM-managed recovery team is not supported")
  return { id: row.id, name: row.name }
}

async function roster(connection: mysql.Connection, organizationId: string, teamId: string) {
  const [people] = await connection.query<mysql.RowDataPacket[]>("SELECT DISTINCT m.id,m.role,m.user_id,m.is_setup_agent,u.name FROM team_member tm JOIN member m ON m.id=tm.org_membership_id AND m.organization_id=? LEFT JOIN user u ON u.id=m.user_id WHERE tm.team_id=? AND m.removed_at IS NULL ORDER BY m.id", [organizationId, teamId])
  return people
}

async function printCheck(connection: mysql.Connection, target: Target, expected: number | undefined) {
  const team = await resolveTeam(connection, target, false)
  const people = await roster(connection, target.organization.id, team.id)
  requireMemberCount(expected, people, team)
  const [fence] = await connection.query<mysql.RowDataPacket[]>("SELECT archived_at FROM permission_set WHERE id=?", [stable("pms", target.organization.id)])
  const [roles] = await connection.query<mysql.RowDataPacket[]>("SELECT p.id,p.name FROM permission_set_team l JOIN permission_set p ON p.id=l.permission_set_id AND p.organization_id=l.organization_id WHERE l.organization_id=? AND l.team_id=? AND l.removed_at IS NULL AND p.archived_at IS NULL ORDER BY p.id", [target.organization.id, team.id])
  const action = fence.length ? "already_consumed_no_recreation" : "would_apply"
  // Display labels are redacted too; no email column is selected.
  log({ event: "administrator_recovery_check", organization: target.organization, team, existingRoles: roles.map((role) => ({ id: role.id, name: role.name })), featureEnabled: true, action, recoveryPermissionCount: 14, peopleCount: people.length, note: "Existing Admin default decisions remain in force; owners already have all permissions. This is not a roster fingerprint." })
  printRoster(people)
}

/** Deploy bootstrap only. Disabled recovery is silent and does not resolve
 * targets. Check is read-only; apply respects the permanent archived-set fence.
 */
export async function recoverAdministratorsFromEnv() {
  if (!await administratorRecoveryRequestedFromEnv()) return 0
  const environment = parseFeatureEnvironment(process.env)
  const url = process.env.DATABASE_URL?.trim()
  if (!url) throw new Error("Deploy-time recovery requires the bootstrap TCP DATABASE_URL")
  const connection = await mysql.createConnection(parseMySqlConnectionConfig(url))
  let changed = 0
  let checking = false
  try {
    const [rows] = await connection.query<mysql.RowDataPacket[]>("SELECT id,slug,name FROM organization ORDER BY id")
    const organizations: Organization[] = rows.map((row) => {
      if (typeof row.id !== "string" || typeof row.slug !== "string" || typeof row.name !== "string") throw new Error("Invalid recovery organization record")
      return { id: row.id, slug: row.slug, name: row.name }
    })
    let enabled = false
    for (const org of organizations) if (await featureEnabled(connection, org.id, environment, false)) enabled = true
    if (!enabled) return 0
    const mode = administratorRecoveryModeFromEnv()
    const expected = expectedMembersFromEnv()
    const targets = targetsFromEnv(organizations)
    if (mode === "check") {
      await connection.query("START TRANSACTION READ ONLY")
      checking = true
      let shown = 0
      for (const target of targets) {
        if (!await featureEnabled(connection, target.organization.id, environment, false)) continue
        await printCheck(connection, target, expected)
        shown++
      }
      if (shown) console.log("[den-db] administrator recovery check complete; no database changes")
      return 0
    }
    const grants = readFileSync(new URL("./administrator-recovery.sql", import.meta.url), "utf8")
    for (const target of targets) {
      const org = target.organization.id
      await connection.beginTransaction()
      try {
        await connection.query("SELECT id FROM organization WHERE id=? FOR UPDATE", [org])
        if (!await featureEnabled(connection, org, environment, true)) { await connection.rollback(); continue }
        const team = await resolveTeam(connection, target, true)
        const people = await roster(connection, org, team.id)
        requireMemberCount(expected, people, team)
        const set = stable("pms", org)
        const [fence] = await connection.query<mysql.RowDataPacket[]>("SELECT id,name,archived_at FROM permission_set WHERE id=?", [set])
        if (fence.length) {
          await connection.rollback()
          console.log(`ALREADY APPLIED — no permissions were recreated or replayed for ${safeText(target.organization.name)} (${org}).`)
          log({ event: "administrator_recovery_no_replay", organization: target.organization, team, roleId: set, archived: fence[0]?.archived_at !== null })
          continue
        }
        await connection.query("SET @den_admin_recovery_org = ?", [org])
        await connection.query("INSERT INTO permission_set(id,organization_id,default_key,name) VALUES(?,?,NULL,'Restored administrator permissions')", [set, org])
        await connection.query(grants)
        await connection.query("INSERT INTO permission_set_team(id,organization_id,permission_set_id,team_id) VALUES(?,?,?,?)", [stable("pst", org), org, set, team.id])
        await connection.query("UPDATE organization SET team_membership_revision=UUID() WHERE id=?", [org])
        await connection.commit()
        changed++
        console.log(`APPLIED — these ${people.length} members now have the 14 permissions`)
        log({ event: "administrator_recovery_applied", organization: target.organization, team, role: { id: set, name: "Restored administrator permissions" }, peopleCount: people.length })
        printRoster(people)
        console.log(`UNDO — Members > Roles: unlink or delete Restored administrator permissions (${set}). Disabling or removing the recovery setting stops future runs; it does not revoke these permissions.`)
        console.log("Existing Admin-role user decisions remain in force; owners already had all permissions.")
      } catch (error) { await connection.rollback(); throw error }
      finally { await connection.query("SET @den_admin_recovery_org = NULL") }
    }
  } finally {
    if (checking) await connection.rollback()
    await connection.end()
  }
  return changed
}
