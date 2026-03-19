import { sql } from "drizzle-orm"
import {
  boolean,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "./columns.js"

const timestamps = {
  created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
}

export const OrgRole = ["owner", "member"] as const
export const WorkerDestination = ["local", "cloud"] as const
export const WorkerStatus = ["provisioning", "healthy", "failed", "stopped"] as const
export const TokenScope = ["client", "host"] as const

export const AuthUserTable = mysqlTable(
  "user",
  {
    id: denTypeIdColumn("user", "id").notNull().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [uniqueIndex("user_email").on(table.email)],
)

export const AuthSessionTable = mysqlTable(
  "session",
  {
    id: denTypeIdColumn("session", "id").notNull().primaryKey(),
    userId: denTypeIdColumn("user", "user_id").notNull(),
    token: varchar("token", { length: 255 }).notNull(),
    expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("session_token").on(table.token),
    index("session_user_id").on(table.userId),
  ],
)

export const AuthAccountTable = mysqlTable(
  "account",
  {
    id: denTypeIdColumn("account", "id").notNull().primaryKey(),
    userId: denTypeIdColumn("user", "user_id").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { fsp: 3 }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { fsp: 3 }),
    scope: text("scope"),
    idToken: text("id_token"),
    password: text("password"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [index("account_user_id").on(table.userId)],
)

export const AuthVerificationTable = mysqlTable(
  "verification",
  {
    id: denTypeIdColumn("verification", "id").notNull().primaryKey(),
    identifier: varchar("identifier", { length: 255 }).notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [index("verification_identifier").on(table.identifier)],
)

export const user = AuthUserTable
export const session = AuthSessionTable
export const account = AuthAccountTable
export const verification = AuthVerificationTable

export const DesktopHandoffGrantTable = mysqlTable(
  "desktop_handoff_grant",
  {
    id: varchar("id", { length: 64 }).notNull().primaryKey(),
    user_id: denTypeIdColumn("user", "user_id").notNull(),
    session_token: text("session_token").notNull(),
    expires_at: timestamp("expires_at", { fsp: 3 }).notNull(),
    consumed_at: timestamp("consumed_at", { fsp: 3 }),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("desktop_handoff_grant_user_id").on(table.user_id),
    index("desktop_handoff_grant_expires_at").on(table.expires_at),
  ],
)

export const OrgTable = mysqlTable(
  "org",
  {
    id: denTypeIdColumn("org", "id").notNull().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 255 }).notNull(),
    owner_user_id: denTypeIdColumn("user", "owner_user_id").notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("org_slug").on(table.slug), index("org_owner_user_id").on(table.owner_user_id)],
)

export const OrgMembershipTable = mysqlTable(
  "org_membership",
  {
    id: denTypeIdColumn("orgMembership", "id").notNull().primaryKey(),
    org_id: denTypeIdColumn("org", "org_id").notNull(),
    user_id: denTypeIdColumn("user", "user_id").notNull(),
    role: mysqlEnum("role", OrgRole).notNull(),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [index("org_membership_org_id").on(table.org_id), index("org_membership_user_id").on(table.user_id)],
)

export const AdminAllowlistTable = mysqlTable(
  "admin_allowlist",
  {
    id: denTypeIdColumn("adminAllowlist", "id").notNull().primaryKey(),
    email: varchar("email", { length: 255 }).notNull(),
    note: varchar("note", { length: 255 }),
    ...timestamps,
  },
  (table) => [uniqueIndex("admin_allowlist_email").on(table.email)],
)

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
    ...timestamps,
  },
  (table) => [
    index("worker_org_id").on(table.org_id),
    index("worker_created_by_user_id").on(table.created_by_user_id),
    index("worker_status").on(table.status),
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
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    revoked_at: timestamp("revoked_at", { fsp: 3 }),
  },
  (table) => [
    index("worker_token_worker_id").on(table.worker_id),
    uniqueIndex("worker_token_token").on(table.token),
  ],
)

export const WorkerBundleTable = mysqlTable(
  "worker_bundle",
  {
    id: denTypeIdColumn("workerBundle", "id").notNull().primaryKey(),
    worker_id: denTypeIdColumn("worker", "worker_id").notNull(),
    storage_url: varchar("storage_url", { length: 2048 }).notNull(),
    status: varchar("status", { length: 64 }).notNull(),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
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
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [index("audit_event_org_id").on(table.org_id), index("audit_event_worker_id").on(table.worker_id)],
)
