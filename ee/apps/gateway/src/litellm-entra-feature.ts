import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db"
import { readFeatures } from "@openwork-ee/den-db/organization-features"
import type { FeatureMap } from "@openwork/features"
import type { GatewayContext } from "./middleware/gateway-auth.js"
import { env } from "./env.js"

export type CheckLiteLlmEntraFeature = (scope: GatewayContext) => Promise<boolean>

type FeatureReader = {
  loadActiveMember: (scope: GatewayContext) => Promise<{ userId: string | null } | null>
  readMemberFeatures: (organizationId: string, userId: string) => Promise<FeatureMap>
}

/** No cache: a kill or member override must also stop a request already preparing. */
export function createLiteLlmEntraFeatureCheck(reader: FeatureReader): CheckLiteLlmEntraFeature {
  return async (scope) => {
    try {
      const member = await reader.loadActiveMember(scope)
      if (!member?.userId) return false
      return (await reader.readMemberFeatures(scope.organizationId, member.userId)).litellmEntraMemberSignIn
    } catch {
      return false
    }
  }
}

export const checkLiteLlmEntraFeature = createLiteLlmEntraFeatureCheck({
  async loadActiveMember(scope) {
    const { db } = await import("./db.js")
    const [member] = await db.$primary.select({ userId: MemberTable.userId }).from(MemberTable).where(and(
      eq(MemberTable.id, scope.orgMembershipId), eq(MemberTable.organizationId, scope.organizationId), isNull(MemberTable.removedAt),
    )).limit(1)
    return member ?? null
  },
  async readMemberFeatures(organizationId, userId) {
    const { db } = await import("./db.js")
    return db.$primary.transaction((tx) => readFeatures(tx, organizationId, env.features, { userId }))
  },
})
