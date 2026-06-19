import { and, asc, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { DesktopPolicyTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { normalizeDesktopAppRestrictions } from "@openwork/types/den/desktop-app-restrictions"
import type { DesktopPolicyValue } from "@openwork/types/den/desktop-policies"
import { db } from "../src/db.js"

const DEFAULT_DESKTOP_POLICY_NAME = "Default desktop policy"
const dryRun = process.argv.includes("--dry-run")

function roleIncludesOwner(roleValue: string) {
  return roleValue.split(",").map((entry) => entry.trim()).includes("owner")
}

function legacyRestrictionsToPolicy(value: unknown): Required<DesktopPolicyValue> {
  const restrictions = normalizeDesktopAppRestrictions(value)
  return {
    allowCustomProviders: restrictions.disallowNonCloudModels !== true,
    allowZenModel: restrictions.blockZenModel !== true,
    allowMultipleWorkspaces: restrictions.blockMultipleWorkspaces !== true,
  }
}

const organizations = await db
  .select({
    id: OrganizationTable.id,
    desktopAppRestrictions: OrganizationTable.desktopAppRestrictions,
  })
  .from(OrganizationTable)
  .orderBy(asc(OrganizationTable.createdAt))

const existingDefaultPolicies = await db
  .select({ organizationId: DesktopPolicyTable.organizationId })
  .from(DesktopPolicyTable)
  .where(and(eq(DesktopPolicyTable.isDefault, true), isNull(DesktopPolicyTable.deletedAt)))

const organizationsWithDefaultPolicy = new Set(existingDefaultPolicies.map((policy) => policy.organizationId))
const organizationsToBackfill = organizations.filter((organization) => !organizationsWithDefaultPolicy.has(organization.id))

if (organizationsToBackfill.length === 0) {
  console.log("No organizations need desktop policy backfill.")
  process.exit(0)
}

const members = await db
  .select({
    id: MemberTable.id,
    organizationId: MemberTable.organizationId,
    role: MemberTable.role,
    createdAt: MemberTable.createdAt,
  })
  .from(MemberTable)
  .orderBy(asc(MemberTable.createdAt))

const memberByOrganization = new Map<string, typeof members[number]>()
for (const member of members) {
  const current = memberByOrganization.get(member.organizationId)
  if (!current || roleIncludesOwner(member.role)) {
    memberByOrganization.set(member.organizationId, member)
  }
}

const now = new Date()
const rows = organizationsToBackfill.flatMap((organization) => {
  const owner = memberByOrganization.get(organization.id)
  if (!owner || !roleIncludesOwner(owner.role)) {
    console.warn(`Skipping organization ${organization.id}: owner member not found.`)
    return []
  }

  return [{
    id: createDenTypeId("desktopPolicy"),
    organizationId: organization.id,
    policyName: DEFAULT_DESKTOP_POLICY_NAME,
    isDefault: true,
    isEnabled: true,
    policy: legacyRestrictionsToPolicy(organization.desktopAppRestrictions),
    createdByOrgMemberId: owner.id,
    createdAt: now,
    updatedAt: now,
  }]
})

if (rows.length === 0) {
  console.log("No desktop policies were created.")
  process.exit(0)
}

if (dryRun) {
  console.log(`Dry run: would create ${rows.length} default desktop policies.`)
  process.exit(0)
}

await db.insert(DesktopPolicyTable).values(rows)
console.log(`Created ${rows.length} default desktop policies.`)
process.exit(0)
