import { relations, sql } from "drizzle-orm"
import { index, json, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import type { DesktopAppRestrictions } from "@openwork/types/den/desktop-app-restrictions"
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
    allowedEmailDomains: json("allowed_email_domains").$type<string[] | null>(),
    desktopAppRestrictions: json("desktop_app_restrictions").$type<DesktopAppRestrictions>().notNull().default(sql`(json_object())`),
    metadata: json("metadata").$type<Record<string, unknown> | null>(),
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
    userId: denTypeIdColumn("user", "user_id"),
    inviteId: denTypeIdColumn("invitation", "invite_id"),
    invitedByOrgMember: denTypeIdColumn("member", "invited_by_org_member"),
    role: varchar("role", { length: 255 }).notNull().default("member"),
    joinedAt: timestamp("joined_at", { fsp: 3 }).defaultNow(),
    removedAt: timestamp("removed_at", { fsp: 3 }),
    removedByOrgMember: denTypeIdColumn("member", "removed_by_org_member"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("member_organization_id").on(table.organizationId),
    index("member_user_id").on(table.userId),
    index("member_invite_id").on(table.inviteId),
    index("member_invited_by_org_member").on(table.invitedByOrgMember),
    index("member_removed_at").on(table.removedAt),
    index("member_removed_by_org_member").on(table.removedByOrgMember),
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
    orgMemberId: denTypeIdColumn("member", "org_member_id"),
    inviteToken: varchar("invite_token", { length: 64 }),
    expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("invitation_organization_id").on(table.organizationId),
    index("invitation_email").on(table.email),
    index("invitation_status").on(table.status),
    index("invitation_team_id").on(table.teamId),
    index("invitation_org_member_id").on(table.orgMemberId),
    uniqueIndex("invitation_invite_token").on(table.inviteToken),
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

export const organizationRelations = relations(OrganizationTable, ({ many }) => ({
  members: many(MemberTable),
  roles: many(OrganizationRoleTable),
}))

export const memberRelations = relations(MemberTable, ({ many, one }) => ({
  organization: one(OrganizationTable, {
    fields: [MemberTable.organizationId],
    references: [OrganizationTable.id],
  }),
}))

export const organizationRoleRelations = relations(OrganizationRoleTable, ({ one }) => ({
  organization: one(OrganizationTable, {
    fields: [OrganizationRoleTable.organizationId],
    references: [OrganizationTable.id],
  }),
}))

export const organization = OrganizationTable
export const member = MemberTable
export const invitation = InvitationTable
export const organizationRole = OrganizationRoleTable
