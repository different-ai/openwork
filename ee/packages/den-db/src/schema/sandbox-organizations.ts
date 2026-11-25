import { int, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

/**
 * A try-it-out organization created by a platform admin. The organization itself is an ordinary organization;
 * this row only adds the shareable join link, its member limit and when it stops accepting people. Closing or
 * expiring a sandbox never deletes the organization or its members; it disables the sandbox's own model key.
 */
export const SandboxOrganizationTable = mysqlTable("sandbox_organization", {
  id: denTypeIdColumn("sandboxOrganization", "id").notNull().primaryKey(),
  organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
  joinToken: varchar("join_token", { length: 64 }).notNull(),
  connectorBaseUrl: varchar("connector_base_url", { length: 2048 }),
  memberLimit: int("member_limit").notNull(),
  modelKeyHash: varchar("model_key_hash", { length: 128 }),
  modelCreditUsd: int("model_credit_usd"),
  sponsoredSetId: denTypeIdColumn("gatewayCredentialSet", "sponsored_set_id"),
  expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
  closedAt: timestamp("closed_at", { fsp: 3 }),
  createdByUserId: denTypeIdColumn("user", "created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
}, table => [
  uniqueIndex("sandbox_organization_organization").on(table.organizationId),
  uniqueIndex("sandbox_organization_join_token").on(table.joinToken),
])
