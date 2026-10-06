import { and, eq } from "@openwork-ee/den-db/drizzle"
import { ConnectorInstanceAccessGrantTable, ConnectorInstanceTable } from "@openwork-ee/den-db/schema"
import { db } from "../../../db.js"

type OrganizationId = typeof ConnectorInstanceTable.$inferSelect.organizationId
type ConnectorInstanceId = typeof ConnectorInstanceTable.$inferSelect.id

export async function connectorInstanceExistsInOrganization(organizationId: OrganizationId, connectorInstanceId: ConnectorInstanceId) {
  const rows = await db
    .select({ id: ConnectorInstanceTable.id })
    .from(ConnectorInstanceTable)
    .where(and(eq(ConnectorInstanceTable.organizationId, organizationId), eq(ConnectorInstanceTable.id, connectorInstanceId)))
    .limit(1)
  return Boolean(rows[0])
}

export async function listConnectorInstanceAccessGrants(input: { connectorInstanceId: ConnectorInstanceId; organizationId: OrganizationId }) {
  return db
    .select({
      orgMembershipId: ConnectorInstanceAccessGrantTable.orgMembershipId,
      orgWide: ConnectorInstanceAccessGrantTable.orgWide,
      removedAt: ConnectorInstanceAccessGrantTable.removedAt,
      role: ConnectorInstanceAccessGrantTable.role,
      teamId: ConnectorInstanceAccessGrantTable.teamId,
    })
    .from(ConnectorInstanceAccessGrantTable)
    .where(and(
      eq(ConnectorInstanceAccessGrantTable.connectorInstanceId, input.connectorInstanceId),
      eq(ConnectorInstanceAccessGrantTable.organizationId, input.organizationId),
    ))
}
