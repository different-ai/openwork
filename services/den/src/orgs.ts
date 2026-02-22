import { randomUUID } from "crypto"
import { eq } from "drizzle-orm"
import { db } from "./db/index.js"
import { OrgMembershipTable, OrgTable } from "./db/schema.js"

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
