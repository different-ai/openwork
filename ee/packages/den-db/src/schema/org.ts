import { sql } from "drizzle-orm"
import { index, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

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
export const organizationRole = OrganizationRoleTable
export const tempTemplateSharing = TempTemplateSharingTable

export const OrgTable = OrganizationTable
export const OrgMembershipTable = MemberTable
