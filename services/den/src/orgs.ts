import { eq } from "./db/drizzle.js"
import { db } from "./db/index.js"
import { AuthUserTable, OrgMembershipTable, OrgTable } from "./db/schema.js"
import { createDenTypeId } from "./db/typeid.js"

type UserId = typeof AuthUserTable.$inferSelect.id
type OrgId = typeof OrgTable.$inferSelect.id

function personalSlugFromOrgId(orgId: OrgId) {
  return orgId
}

function isDuplicateSlugError(error: unknown) {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()
  return message.includes("duplicate entry") && message.includes("org.org_slug")
}

export async function ensureDefaultOrg(userId: UserId, name: string): Promise<OrgId> {
  const existing = await db
    .select()
    .from(OrgMembershipTable)
    .where(eq(OrgMembershipTable.user_id, userId))
    .limit(1)

  if (existing.length > 0) {
    return existing[0].org_id
  }

  let orgId: OrgId | null = null

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidateOrgId = createDenTypeId("org")
    const slug = personalSlugFromOrgId(candidateOrgId)

    try {
      await db.insert(OrgTable).values({
        id: candidateOrgId,
        name,
        slug,
        owner_user_id: userId,
      })
      orgId = candidateOrgId
      break
    } catch (error) {
      if (isDuplicateSlugError(error) && attempt < 4) {
        continue
      }
      throw error
    }
  }

  if (!orgId) {
    throw new Error("failed to create default org")
  }

  await db.insert(OrgMembershipTable).values({
    id: createDenTypeId("orgMembership"),
    org_id: orgId,
    user_id: userId,
    role: "owner",
  })
  return orgId
}

export async function listUserOrgs(userId: UserId) {
  const memberships = await db
    .select({
      membershipId: OrgMembershipTable.id,
      role: OrgMembershipTable.role,
      org: {
        id: OrgTable.id,
        name: OrgTable.name,
        slug: OrgTable.slug,
        ownerUserId: OrgTable.owner_user_id,
        createdAt: OrgTable.created_at,
        updatedAt: OrgTable.updated_at,
      },
    })
    .from(OrgMembershipTable)
    .innerJoin(OrgTable, eq(OrgMembershipTable.org_id, OrgTable.id))
    .where(eq(OrgMembershipTable.user_id, userId))

  return memberships.map((row) => ({
    id: row.org.id,
    name: row.org.name,
    slug: row.org.slug,
    ownerUserId: row.org.ownerUserId,
    role: row.role,
    membershipId: row.membershipId,
    createdAt: row.org.createdAt,
    updatedAt: row.org.updatedAt,
  }))
}
