import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { loadUpgradePlan, upgradeHistoryPrefix } from "../scripts/migration-0097-compat.ts"
import { loadMigrationPlan, historyPrefix } from "../scripts/migration-baseline.ts"
import { receiptMatchesMigration } from "../scripts/superseded-migrations.ts"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { createHash } from "node:crypto"
import { PERMISSION_KEYS } from "@openwork/types/den/permissions"

const folder = new URL("../drizzle", import.meta.url).pathname
const releasedHash = "7f5625e613f866f03f179edacf824df64716ffb6ee0472d3d18aaf706aae4ed9"
const source = readFileSync(new URL("../drizzle/0138_deprecate_super_admin.sql", import.meta.url), "utf8")

describe("preserve current super-admins at deprecation", () => {
  test("the released 0138 hash remains a valid exact-prefix receipt in both startup paths", async () => {
    const plan = loadMigrationPlan(folder)
    const upgrade = loadUpgradePlan(folder)
    const migration = plan[137]
    expect(migration.tag).toBe("0138_deprecate_super_admin")
    expect(migration.folderMillis).toBe(1791533359673)
    expect(migration.hash).not.toBe(releasedHash)
    expect(receiptMatchesMigration(releasedHash, migration)).toBe(true)
    expect(receiptMatchesMigration("0".repeat(64), migration)).toBe(false)
    expect(receiptMatchesMigration(releasedHash, plan[136])).toBe(false)
    const receipts = plan.map((entry, index) => ({ hash: index === 137 ? releasedHash : entry.hash, created_at: entry.folderMillis }))
    expect(historyPrefix(plan, receipts)).toBe(plan.length)
    expect(await upgradeHistoryPrefix({ query: async () => receipts }, upgrade)).toBe(plan.length)
    expect(historyPrefix(plan, receipts.slice(0, 137))).toBe(137)
  })

  test("the original role/invitation/claim rewrite is byte-for-byte unchanged", () => {
    const original = source.slice(source.indexOf("-- Super-admin is deprecated and custom roles are removed"))
    expect(createHash("sha256").update(original).digest("hex")).toBe(releasedHash)
  })

  test("0137 creates all permission storage; no later column is used", () => {
    const permissions = readFileSync(new URL("../drizzle/0137_permissions.sql", import.meta.url), "utf8")
    for (const table of ["permission_set", "permission_set_permission", "permission_set_team"])
      expect(permissions).toContain(`CREATE TABLE \`${table}\``)
    const statements = source.replace(/--[^\n]*/g, "")
    expect(statements).not.toContain("team_membership_revision")
    expect(statements.indexOf("INSERT INTO `team_member`")).toBeLessThan(statements.indexOf("UPDATE `member`"))
    expect(statements).not.toMatch(/audit_event|workspace_claim.*JOIN|JOIN\s+`invitation`/i)
  })

  test("the preservation grants exactly the 14 comparable capabilities", () => {
    const grants = source.slice(source.indexOf("CROSS JOIN ("), source.indexOf(") k"))
    const keys = [...grants.matchAll(/SELECT '([^']+)'/g)].map((match) => match[1]).sort()
    expect(keys).toEqual([
      "organization.update", "branding.update", "web_origins.manage", "members.update",
      "teams.manage_admin", "permissions.manage", "sso.manage", "scim.manage", "api_keys.manage",
      "egress_diagnostics.manage", "desktop_policies.manage", "billing_portal.use",
      "connections.update", "connections.delete",
    ].sort())
    for (const key of keys) expect(PERMISSION_KEYS).toContain(key)
  })

  test("stable SQL identifiers are valid TypeIDs, not arbitrary text ids", () => {
    const digest = createHash("sha256").update("super-admin-preservation-0138:fixture").digest("hex").slice(0, 25)
    expect(normalizeDenTypeId("team", `tem_0${digest}`)).toBe(`tem_0${digest}`)
    expect(normalizeDenTypeId("teamMember", `tmb_0${digest}`)).toBe(`tmb_0${digest}`)
    expect(normalizeDenTypeId("permissionSet", `pms_0${digest}`)).toBe(`pms_0${digest}`)
    expect(normalizeDenTypeId("permissionSetPermission", `psp_0${digest}`)).toBe(`psp_0${digest}`)
    expect(normalizeDenTypeId("permissionSetTeam", `pst_0${digest}`)).toBe(`pst_0${digest}`)
  })
})
