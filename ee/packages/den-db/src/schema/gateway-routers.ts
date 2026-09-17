import { index, int, mysqlEnum, mysqlTable, varchar } from "drizzle-orm/mysql-core"
import type { GatewayRouterConfiguration } from "@openwork/types/den/gateway-router"
import { compatJsonColumn, denTypeIdColumn, timestamps } from "../columns"

export const GatewayRouterTable = mysqlTable("gateway_routers", {
  id: denTypeIdColumn("gatewayRouter", "id").notNull().primaryKey(),
  organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
  created_by_org_membership_id: denTypeIdColumn("member", "created_by_org_membership_id").notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  status: mysqlEnum("status", ["active", "disabled"]).notNull().default("active"),
  configuration: compatJsonColumn<GatewayRouterConfiguration>("configuration").notNull(),
  revision: int("revision").notNull().default(1),
  ...timestamps,
}, (table) => [index("gateway_routers_owner").on(table.organization_id, table.created_by_org_membership_id)])
