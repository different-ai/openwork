import { int, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

/**
 * A try-it-out organization created by a platform admin. The organization itself is an ordinary organization;
 * this row only adds the shareable join link, its member limit and when it stops accepting people. Closing or
 * expiring a sandbox never deletes the organization or its members.
 */
export const SandboxOrganizationTable = mysqlTable("sandbox_organization", {
  id: denTypeIdColumn("sandboxOrganization", "id").notNull().primaryKey(),
  organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
  /** Bearer join secret; rotating it replaces the link. */
  joinToken: varchar("join_token", { length: 64 }).notNull(),
  /** Base URL of the fictional workplace service the connectors point at, e.g. https://workplace.example/. */
  connectorBaseUrl: varchar("connector_base_url", { length: 2048 }),
  memberLimit: int("member_limit").notNull(),
  expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
  closedAt: timestamp("closed_at", { fsp: 3 }),
  createdByUserId: denTypeIdColumn("user", "created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
}, table => [
  uniqueIndex("sandbox_organization_organization").on(table.organizationId),
  uniqueIndex("sandbox_organization_join_token").on(table.joinToken),
])
