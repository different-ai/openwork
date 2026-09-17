import { GatewayRouterTable } from "@openwork-ee/den-db"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { isDenTypeId } from "@openwork-ee/utils/typeid"
import type { GatewayRouterDefinition } from "@openwork/types/den/gateway-router"
import { gatewayRouterDefinitionSchema } from "@openwork/types/den/gateway-router"

export type GatewayRouter = GatewayRouterDefinition & {
  id: string
  revision: number
  organizationId: string
  orgMembershipId: string
}
export type LoadGatewayRouter = (input: { routerId: string; organizationId: string; orgMembershipId: string }) => Promise<GatewayRouter | null>

export const loadGatewayRouterFromDb: LoadGatewayRouter = async (input) => {
  if (!isDenTypeId("gatewayRouter", input.routerId) || !isDenTypeId("organization", input.organizationId) || !isDenTypeId("member", input.orgMembershipId)) return null
  const { db } = await import("./db.js")
  const [row] = await db.select().from(GatewayRouterTable).where(and(
    eq(GatewayRouterTable.id, input.routerId),
    eq(GatewayRouterTable.organization_id, input.organizationId),
    eq(GatewayRouterTable.created_by_org_membership_id, input.orgMembershipId),
    eq(GatewayRouterTable.status, "active"),
  )).limit(1)
  if (!row) return null
  const definition = gatewayRouterDefinitionSchema.safeParse({ ...row.configuration, name: row.name, status: row.status })
  if (!definition.success) return null
  return { ...definition.data, id: row.id, revision: row.revision,
    organizationId: row.organization_id, orgMembershipId: row.created_by_org_membership_id }
}
