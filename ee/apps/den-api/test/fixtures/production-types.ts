import { createDenDb } from "@openwork-ee/den-db"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { gatewayUsagePolicyWriteSchema } from "@openwork/types/den/gateway-usage-limits"
import type { z } from "zod"

const database = createDenDb({ mode: "mysql", databaseUrl: "mysql://localhost/type-probe" }).db
const query = database.select({ id: OrganizationTable.id }).from(OrganizationTable)
type Row = Awaited<typeof query>[number]
declare const row: Row
const selectedId: typeof OrganizationTable.$inferSelect.id = row.id
void selectedId

// @ts-expect-error A selected row does not include unselected columns.
row.nonexistentColumn
// @ts-expect-error Organization IDs retain their string type.
const invalidId: Row["id"] = 123
// @ts-expect-error Schema exports do not accept invented columns.
OrganizationTable.nonexistentColumn

type Policy = z.infer<typeof gatewayUsagePolicyWriteSchema>
declare const policy: Policy
const policyName: string = policy.name
void policyName
// @ts-expect-error Schema inference must reject invalid policy names.
const invalidName: Policy["name"] = 123
