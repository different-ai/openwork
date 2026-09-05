import { index, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

export const OrgCloudTrialTable = mysqlTable("org_cloud_trials", {
  organization_id: denTypeIdColumn("organization", "organization_id").notNull().primaryKey(),
  started_by_user_id: denTypeIdColumn("user", "started_by_user_id").notNull(),
  started_at: timestamp("started_at", { fsp: 3 }).notNull(),
  expires_at: timestamp("expires_at", { fsp: 3 }).notNull(),
  ending_sent_at: timestamp("ending_sent_at", { fsp: 3 }),
  expired_sent_at: timestamp("expired_sent_at", { fsp: 3 }),
  notification_lease_until: timestamp("notification_lease_until", { fsp: 3 }),
  notification_lease_token: varchar("notification_lease_token", { length: 64 }),
}, (table) => [
  uniqueIndex("org_cloud_trials_starter").on(table.started_by_user_id),
  index("org_cloud_trials_expiry").on(table.expires_at),
])
