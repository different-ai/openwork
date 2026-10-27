import { bigint, index, mysqlEnum, mysqlTable, primaryKey, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { ORGANIZATION_BENEFITS, ORGANIZATION_GRANT_TYPES } from "@openwork/types/den/organization-grants"
import { denTypeIdColumn } from "../columns"

export const OrganizationBenefitSettingTable = mysqlTable("organization_benefit_setting", {
  organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
  feature: mysqlEnum("feature", ORGANIZATION_BENEFITS).notNull(),
  setting: mysqlEnum("setting", ["enabled", "disabled"]).notNull(),
  updatedByUserId: denTypeIdColumn("user", "updated_by_user_id").notNull(),
  updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.organizationId, table.feature] })])

/** Append-only awards. Revocation and consumption never erase the original amount or duration. */
export const OrganizationGrantTable = mysqlTable("organization_grant", {
  id: denTypeIdColumn("organizationGrant", "id").notNull().primaryKey(),
  organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
  requestId: varchar("request_id", { length: 36 }).notNull(),
  feature: mysqlEnum("feature", ORGANIZATION_BENEFITS).notNull(),
  kind: mysqlEnum("kind", ORGANIZATION_GRANT_TYPES).notNull(),
  /** Same integer usage units as Free Auto; a missing amount is access or unlimited, never zero. */
  amount: bigint("amount", { mode: "number" }),
  usedAmount: bigint("used_amount", { mode: "number" }).notNull().default(0),
  startsAt: timestamp("starts_at", { fsp: 3 }).notNull(),
  expiresAt: timestamp("expires_at", { fsp: 3 }),
  reason: varchar("reason", { length: 500 }).notNull(),
  createdByUserId: denTypeIdColumn("user", "created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { fsp: 3 }),
  revokedByUserId: denTypeIdColumn("user", "revoked_by_user_id"),
}, table => [
  uniqueIndex("organization_grant_request").on(table.organizationId, table.requestId),
  index("organization_grant_active").on(table.organizationId, table.feature, table.revokedAt, table.startsAt),
])

/** Receipt allocation, committed with the existing Free Auto receipt and counter updates. */
export const OrganizationGrantUsageTable = mysqlTable("organization_grant_usage", {
  grantId: denTypeIdColumn("organizationGrant", "grant_id").notNull(),
  requestId: varchar("request_id", { length: 64 }).notNull(),
  amount: bigint("amount", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.grantId, table.requestId] })])
