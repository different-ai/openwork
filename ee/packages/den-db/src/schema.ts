import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  int,
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

export const WorkerDestination = ["local", "cloud"] as const
export const WorkerStatus = ["provisioning", "healthy", "failed", "stopped"] as const
export const TokenScope = ["client", "host", "activity"] as const

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
    activeOrganizationId: denTypeIdColumn("organization", "active_organization_id"),
    activeTeamId: denTypeIdColumn("team", "active_team_id"),
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

export const RateLimitTable = mysqlTable(
  "rate_limit",
  {
    id: denTypeIdColumn("rateLimit", "id").notNull().primaryKey(),
    key: varchar("key", { length: 512 }).notNull(),
    count: int("count").notNull().default(0),
    lastRequest: bigint("last_request", { mode: "number" }).notNull(),
  },
  (table) => [uniqueIndex("rate_limit_key").on(table.key)],
)

export const user = AuthUserTable
export const session = AuthSessionTable
export const account = AuthAccountTable
export const verification = AuthVerificationTable
export const rateLimit = RateLimitTable

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

export const OrganizationTable = mysqlTable(
  "organization",
  {
    id: denTypeIdColumn("organization", "id").notNull().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 255 }).notNull(),
    logo: varchar("logo", { length: 2048 }),
    metadata: text("metadata"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [uniqueIndex("organization_slug").on(table.slug)],
)

export const MemberTable = mysqlTable(
  "member",
  {
    id: denTypeIdColumn("member", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    userId: denTypeIdColumn("user", "user_id").notNull(),
    role: varchar("role", { length: 255 }).notNull().default("member"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("member_organization_id").on(table.organizationId),
    index("member_user_id").on(table.userId),
    uniqueIndex("member_organization_user").on(table.organizationId, table.userId),
  ],
)

export const InvitationTable = mysqlTable(
  "invitation",
  {
    id: denTypeIdColumn("invitation", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    role: varchar("role", { length: 255 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    teamId: denTypeIdColumn("team", "team_id"),
    inviterId: denTypeIdColumn("user", "inviter_id").notNull(),
    expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("invitation_organization_id").on(table.organizationId),
    index("invitation_email").on(table.email),
    index("invitation_status").on(table.status),
    index("invitation_team_id").on(table.teamId),
  ],
)

export const TeamTable = mysqlTable(
  "team",
  {
    id: denTypeIdColumn("team", "id").notNull().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("team_organization_id").on(table.organizationId),
    uniqueIndex("team_organization_name").on(table.organizationId, table.name),
  ],
)

export const TeamMemberTable = mysqlTable(
  "team_member",
  {
    id: denTypeIdColumn("teamMember", "id").notNull().primaryKey(),
    teamId: denTypeIdColumn("team", "team_id").notNull(),
    userId: denTypeIdColumn("user", "user_id").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("team_member_team_id").on(table.teamId),
    index("team_member_user_id").on(table.userId),
    uniqueIndex("team_member_team_user").on(table.teamId, table.userId),
  ],
)

export const OrganizationRoleTable = mysqlTable(
  "organization_role",
  {
    id: denTypeIdColumn("organizationRole", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    role: varchar("role", { length: 255 }).notNull(),
    permission: text("permission").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("organization_role_organization_id").on(table.organizationId),
    uniqueIndex("organization_role_name").on(table.organizationId, table.role),
  ],
)

export const TempTemplateSharingTable = mysqlTable(
  "temp_template_sharing",
  {
    id: denTypeIdColumn("tempTemplateSharing", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    creatorMemberId: denTypeIdColumn("member", "creator_member_id").notNull(),
    creatorUserId: denTypeIdColumn("user", "creator_user_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    templateJson: text("template_json").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("temp_template_sharing_org_id").on(table.organizationId),
    index("temp_template_sharing_creator_member_id").on(table.creatorMemberId),
    index("temp_template_sharing_creator_user_id").on(table.creatorUserId),
  ],
)

export const organization = OrganizationTable
export const member = MemberTable
export const invitation = InvitationTable
export const team = TeamTable
export const teamMember = TeamMemberTable
export const organizationRole = OrganizationRoleTable
export const tempTemplateSharing = TempTemplateSharingTable

export const OrgTable = OrganizationTable
export const OrgMembershipTable = MemberTable

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
