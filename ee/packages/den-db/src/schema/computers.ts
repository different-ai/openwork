import { sql } from "drizzle-orm"
import { boolean, index, int, mediumtext, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import type {
  ComputerAction,
  ComputerCommandStatus,
  ComputerDecisionLayer,
  ComputerFolder,
  ComputerGrantScope,
  ComputerOwnerChoice,
} from "@openwork/types/den/computers"
import { compatJsonColumn, denTypeIdColumn } from "../columns"

/** The last access choice the owner reported for this computer. */
export const ComputerAccessTable = mysqlTable(
  "computer_access",
  {
    id: denTypeIdColumn("computerAccess", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    deviceId: denTypeIdColumn("remoteDevice", "device_id").notNull(),
    ownerChoice: varchar("owner_choice", { length: 8 }).$type<ComputerOwnerChoice>(),
    reportedByRunnerId: varchar("reported_by_runner_id", { length: 160 }).notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [uniqueIndex("computer_access_device").on(table.deviceId)],
)

/** Personal sandbox folders or the working folder for an explicit registered VM grant. */
export const ComputerGrantTable = mysqlTable(
  "computer_grant",
  {
    id: denTypeIdColumn("computerGrant", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    targetDeviceId: denTypeIdColumn("remoteDevice", "target_device_id").notNull(),
    sourceKey: varchar("source_key", { length: 64 }).notNull(),
    folders: compatJsonColumn<ComputerFolder[]>("folders").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("computer_grant_target_source").on(table.targetDeviceId, table.sourceKey),
    index("computer_grant_organization").on(table.organizationId),
  ],
)

/**
 * A queued command and its result for the caller, including command text and up
 * to 32,000 bytes of output. The row is eligible for pruning 15 minutes after
 * completion, or 15 minutes after its deadline if not completed. Den prunes
 * eligible rows every 15 minutes and when queue requests arrive.
 */
export const ComputerCommandTable = mysqlTable(
  "computer_command",
  {
    id: denTypeIdColumn("computerCommand", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    createdByUserId: denTypeIdColumn("user", "created_by_user_id").notNull(),
    sourceDeviceId: denTypeIdColumn("remoteDevice", "source_device_id").notNull(),
    targetDeviceId: denTypeIdColumn("remoteDevice", "target_device_id").notNull(),
    action: compatJsonColumn<ComputerAction>("action").notNull(),
    scope: compatJsonColumn<ComputerGrantScope>("scope").notNull(),
    status: varchar("status", { length: 16 }).$type<ComputerCommandStatus>().notNull().default("pending"),
    exitCode: int("exit_code"),
    output: mediumtext("output"),
    truncated: boolean("truncated"),
    errorCode: varchar("error_code", { length: 64 }),
    errorMessage: varchar("error_message", { length: 300 }),
    refusedLayer: varchar("refused_layer", { length: 16 }).$type<ComputerDecisionLayer>(),
    expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
    claimedByRunnerId: varchar("claimed_by_runner_id", { length: 160 }),
    claimedAt: timestamp("claimed_at", { fsp: 3 }),
    completedAt: timestamp("completed_at", { fsp: 3 }),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("computer_command_target_status_created").on(table.targetDeviceId, table.status, table.createdAt),
    index("computer_command_organization_created").on(table.organizationId, table.createdAt),
  ],
)
