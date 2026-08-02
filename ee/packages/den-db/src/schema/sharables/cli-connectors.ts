import { relations, sql } from "drizzle-orm"
import {
  boolean,
  index,
  mysqlTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../../columns"
import { MemberTable, OrganizationTable } from "../org"

/**
 * P0 hosted CLI connector registration. The executable command remains in a
 * reviewed, versioned Den manifest; rows only pin an org to that manifest.
 */
export const CliConnectorTable = mysqlTable(
  "cli_connector",
  {
    id: denTypeIdColumn("cliConnector", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    catalogKey: varchar("catalog_key", { length: 128 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    manifestVersion: varchar("manifest_version", { length: 64 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdByOrgMembershipId: denTypeIdColumn("member", "created_by_org_membership_id").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("cli_connector_organization_id").on(table.organizationId),
    uniqueIndex("cli_connector_org_catalog").on(table.organizationId, table.catalogKey),
  ],
)

export const cliConnectorRelations = relations(CliConnectorTable, ({ one }) => ({
  organization: one(OrganizationTable, {
    fields: [CliConnectorTable.organizationId],
    references: [OrganizationTable.id],
  }),
  createdByOrgMembership: one(MemberTable, {
    fields: [CliConnectorTable.createdByOrgMembershipId],
    references: [MemberTable.id],
  }),
}))
