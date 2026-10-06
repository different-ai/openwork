import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { ConnectedAccountTable } from "@openwork-ee/den-db/schema"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: connect.nativeProviders.

coreHooks.registerTx({
  point: "member.removing",
  id: "legacy/connect-native-providers/delete-member-connected-accounts",
  registrant: "legacy",
  security: true,
  order: CORE_HOOK_ORDER.security + 1,
  handler: async ({ tx, organizationId, memberIds }) => {
    await tx
      .delete(ConnectedAccountTable)
      .where(and(
        eq(ConnectedAccountTable.organizationId, organizationId),
        inArray(ConnectedAccountTable.orgMembershipId, memberIds),
      ))
  },
})
