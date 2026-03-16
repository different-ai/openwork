import { eq } from "./db/drizzle.js"
import { db } from "./db/index.js"
import { AuthUserTable, OrgMembershipTable, OrgTable } from "./db/schema.js"
import { createDenTypeId } from "./db/typeid.js"

type UserId = typeof AuthUserTable.$inferSelect.id
type OrgId = typeof OrgTable.$inferSelect.id

export async function ensureDefaultOrg(userId: UserId, name: string): Promise<OrgId> {
  const existing = await db
    .select()
    .from(OrgMembershipTable)
    .where(eq(OrgMembershipTable.user_id, userId))
    .limit(1)

  if (existing.length > 0) {
    return existing[0].org_id
  }

  const orgId = createDenTypeId("org")
  const slug = `personal-${orgId.slice(0, 8)}`
  await db.insert(OrgTable).values({
    id: orgId,
    name,
    slug,
    owner_user_id: userId,
  })
  await db.insert(OrgMembershipTable).values({
    id: createDenTypeId("orgMembership"),
    org_id: orgId,
    user_id: userId,
    role: "owner",
  })
  return orgId
}
