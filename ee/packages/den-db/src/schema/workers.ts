import { index, json, mysqlEnum, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn, timestamps } from "../columns"

export const WorkerDestination = ["local", "cloud"] as const
export const WorkerStatus = ["provisioning", "healthy", "failed", "stopped"] as const
export const TokenScope = ["client", "host", "activity"] as const

export const WorkerTable = mysqlTable(
  "worker",
  {
    id: denTypeIdColumn("worker", "id").notNull().primaryKey(),
    org_id: denTypeIdColumn("org", "org_id").notNull(),
    created_by_user_id: denTypeIdColumn("user", "created_by_user_id"),
    name: varchar("name", { length: 255 }).notNull(),
    description: varchar("description", { length: 1024 }),
    destination: mysqlEnum("destination", WorkerDestination).notNull(),
    status: mysqlEnum("status", WorkerStatus).notNull(),
    image_version: varchar("image_version", { length: 128 }),
    workspace_path: varchar("workspace_path", { length: 1024 }),
    sandbox_backend: varchar("sandbox_backend", { length: 64 }),
    last_heartbeat_at: timestamp("last_heartbeat_at", { fsp: 3 }),
    last_active_at: timestamp("last_active_at", { fsp: 3 }),
    ...timestamps,
  },
  (table) => [
    index("worker_org_id").on(table.org_id),
    index("worker_created_by_user_id").on(table.created_by_user_id),
    index("worker_status").on(table.status),
    index("worker_last_heartbeat_at").on(table.last_heartbeat_at),
    index("worker_last_active_at").on(table.last_active_at),
  ],
)

export const WorkerInstanceTable = mysqlTable(
  "worker_instance",
  {
    id: denTypeIdColumn("workerInstance", "id").notNull().primaryKey(),
    worker_id: denTypeIdColumn("worker", "worker_id").notNull(),
    provider: varchar("provider", { length: 64 }).notNull(),
    region: varchar("region", { length: 64 }),
    url: varchar("url", { length: 2048 }).notNull(),
    status: mysqlEnum("status", WorkerStatus).notNull(),
    ...timestamps,
  },
  (table) => [index("worker_instance_worker_id").on(table.worker_id)],
)

export const DaytonaSandboxTable = mysqlTable(
  "daytona_sandbox",
  {
    id: denTypeIdColumn("daytonaSandbox", "id").notNull().primaryKey(),
    worker_id: denTypeIdColumn("worker", "worker_id").notNull(),
    sandbox_id: varchar("sandbox_id", { length: 128 }).notNull(),
    workspace_volume_id: varchar("workspace_volume_id", { length: 128 }).notNull(),
    data_volume_id: varchar("data_volume_id", { length: 128 }).notNull(),
    signed_preview_url: varchar("signed_preview_url", { length: 2048 }).notNull(),
    signed_preview_url_expires_at: timestamp("signed_preview_url_expires_at", { fsp: 3 }).notNull(),
    region: varchar("region", { length: 64 }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("daytona_sandbox_worker_id").on(table.worker_id),
    uniqueIndex("daytona_sandbox_sandbox_id").on(table.sandbox_id),
  ],
)

export const WorkerTokenTable = mysqlTable(
  "worker_token",
  {
    id: denTypeIdColumn("workerToken", "id").notNull().primaryKey(),
    worker_id: denTypeIdColumn("worker", "worker_id").notNull(),
    scope: mysqlEnum("scope", TokenScope).notNull(),
    token: varchar("token", { length: 128 }).notNull(),
    created_at: timestamps.created_at,
    revoked_at: timestamp("revoked_at", { fsp: 3 }),
  },
  (table) => [index("worker_token_worker_id").on(table.worker_id), uniqueIndex("worker_token_token").on(table.token)],
)

export const WorkerBundleTable = mysqlTable(
  "worker_bundle",
  {
    id: denTypeIdColumn("workerBundle", "id").notNull().primaryKey(),
    worker_id: denTypeIdColumn("worker", "worker_id").notNull(),
    storage_url: varchar("storage_url", { length: 2048 }).notNull(),
    status: varchar("status", { length: 64 }).notNull(),
    created_at: timestamps.created_at,
  },
  (table) => [index("worker_bundle_worker_id").on(table.worker_id)],
)

export const AuditEventTable = mysqlTable(
  "audit_event",
  {
    id: denTypeIdColumn("auditEvent", "id").notNull().primaryKey(),
    org_id: denTypeIdColumn("org", "org_id").notNull(),
    worker_id: denTypeIdColumn("worker", "worker_id"),
    actor_user_id: denTypeIdColumn("user", "actor_user_id").notNull(),
    action: varchar("action", { length: 128 }).notNull(),
    payload: json("payload"),
    created_at: timestamps.created_at,
  },
  (table) => [index("audit_event_org_id").on(table.org_id), index("audit_event_worker_id").on(table.worker_id)],
)
