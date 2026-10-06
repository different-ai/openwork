import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import type { CoreTx } from "./types.js"

export type { CoreDatabase, CoreReader, CoreTx } from "./types.js"

// Share this lock with invitations and SCIM teardown so a concurrent grant cannot
// turn an already-authorized routine membership edit into a role assignment.
export function withOrganizationRowLock<T>(
  organizationId: DenTypeId<"organization">,
  mutation: (tx: CoreTx) => Promise<T>,
) {
  return db.transaction(async (tx) => {
    await tx.select({ id: OrganizationTable.id }).from(OrganizationTable)
      .where(eq(OrganizationTable.id, organizationId)).for("update")
    return mutation(tx)
  })
}
