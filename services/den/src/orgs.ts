import { randomUUID } from "crypto"
import { asc, eq } from "drizzle-orm"
import { db } from "./db/index.js"
import { OrgMembershipTable, OrgTable } from "./db/schema.js"

export type OrgSummary = {
  id: string
  name: string
  slug: string
  role: "owner" | "member"
}

export async function ensureDefaultOrg(userId: string, name: string) {
  const existing = await db
    .select()
    .from(OrgMembershipTable)
    .where(eq(OrgMembershipTable.user_id, userId))
    .limit(1)

  if (existing.length > 0) {
    return existing[0].org_id
  }

  const orgId = randomUUID()
  const slug = `personal-${orgId.slice(0, 8)}`
  await db.insert(OrgTable).values({
    id: orgId,
    name,
    slug,
    owner_user_id: userId,
  })
  await db.insert(OrgMembershipTable).values({
    id: randomUUID(),
    org_id: orgId,
    user_id: userId,
    role: "owner",
  })
  return orgId
}

export async function listUserOrgs(userId: string): Promise<OrgSummary[]> {
  const rows = await db
    .select({
      id: OrgTable.id,
      name: OrgTable.name,
      slug: OrgTable.slug,
      role: OrgMembershipTable.role,
      createdAt: OrgTable.created_at,
    })
    .from(OrgMembershipTable)
    .innerJoin(OrgTable, eq(OrgMembershipTable.org_id, OrgTable.id))
    .where(eq(OrgMembershipTable.user_id, userId))
    .orderBy(asc(OrgTable.created_at))

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    role: row.role,
  }))
}

export async function resolveUserOrg(userId: string, requestedOrgId?: string | null): Promise<OrgSummary | null> {
  const orgs = await listUserOrgs(userId)
  if (orgs.length === 0) {
    return null
  }

  const requested = requestedOrgId?.trim() ?? ""
  if (!requested) {
    return orgs[0]
  }

  return orgs.find((org) => org.id === requested) ?? null
}
