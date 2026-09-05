import { relations, sql } from "drizzle-orm"
import { boolean, index, json, mysqlEnum, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"
import { MemberTable, OrganizationTable } from "./org"
import { accessRoleValues } from "./sharables/plugin-arch"
import { TeamTable } from "./teams"

/**
 * One MCP App tile on an organization-managed Dashboard. The shape mirrors the
 * desktop dashboard entry reference (`DashboardMcpAppEntry` in
 * `apps/app/src/react-app/domains/dashboard/dashboard-store.ts`) so granted
 * elements render as ordinary tiles. Per-user consent stays local to each
 * desktop user; an organization admin may separately set an explicit launch
 * policy on the managed element.
 */
export type DashboardElement = {
  serverName: string
  /** Present for Connect app-host apps: launched through this connection reference. */
  connectionId?: string
  toolName: string
  projectedToolName: string
  resourceUri: string
  title: string
  /** Optional launch arguments captured when the element was added; every launch reuses them. */
  launchArguments?: Record<string, unknown>
  /** True when the launch tool modifies data: tiles only run on request, never on mount. */
  requiresApproval?: boolean
  /** Explicit admin policy: run this exact element automatically, even when it modifies data. */
  organizationAutoLaunch?: boolean
}

export const DashboardTable = mysqlTable(
  "dashboard",
  {
    id: denTypeIdColumn("dashboard", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    /** Ordered MCP App elements; array order is the tile order. */
    elementsJson: json("elements_json").$type<DashboardElement[]>().notNull(),
    createdByOrgMembershipId: denTypeIdColumn("member", "created_by_org_membership_id").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
    deletedAt: timestamp("deleted_at", { fsp: 3 }),
  },
  (table) => [
    index("dashboard_organization_id").on(table.organizationId),
    index("dashboard_created_by_org_membership_id").on(table.createdByOrgMembershipId),
    index("dashboard_name").on(table.name),
  ],
)

export const DashboardAccessGrantTable = mysqlTable(
  "dashboard_access_grant",
  {
    id: denTypeIdColumn("dashboardAccessGrant", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    dashboardId: denTypeIdColumn("dashboard", "dashboard_id").notNull(),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id"),
    teamId: denTypeIdColumn("team", "team_id"),
    orgWide: boolean("org_wide").notNull().default(false),
    role: mysqlEnum("role", accessRoleValues).notNull(),
    createdByOrgMembershipId: denTypeIdColumn("member", "created_by_org_membership_id").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { fsp: 3 }),
  },
  (table) => [
    index("dashboard_access_grant_organization_id").on(table.organizationId),
    index("dashboard_access_grant_org_membership_id").on(table.orgMembershipId),
    index("dashboard_access_grant_team_id").on(table.teamId),
    index("dashboard_access_grant_org_wide").on(table.orgWide),
    uniqueIndex("dashboard_access_grant_dashboard_org_membership").on(table.dashboardId, table.orgMembershipId),
    uniqueIndex("dashboard_access_grant_dashboard_team").on(table.dashboardId, table.teamId),
  ],
)

export const dashboardRelations = relations(DashboardTable, ({ many, one }) => ({
  accessGrants: many(DashboardAccessGrantTable),
  createdByOrgMembership: one(MemberTable, {
    fields: [DashboardTable.createdByOrgMembershipId],
    references: [MemberTable.id],
  }),
  organization: one(OrganizationTable, {
    fields: [DashboardTable.organizationId],
    references: [OrganizationTable.id],
  }),
}))

export const dashboardAccessGrantRelations = relations(DashboardAccessGrantTable, ({ one }) => ({
  createdByOrgMembership: one(MemberTable, {
    fields: [DashboardAccessGrantTable.createdByOrgMembershipId],
    references: [MemberTable.id],
  }),
  dashboard: one(DashboardTable, {
    fields: [DashboardAccessGrantTable.dashboardId],
    references: [DashboardTable.id],
  }),
  orgMembership: one(MemberTable, {
    fields: [DashboardAccessGrantTable.orgMembershipId],
    references: [MemberTable.id],
  }),
  team: one(TeamTable, {
    fields: [DashboardAccessGrantTable.teamId],
    references: [TeamTable.id],
  }),
}))

export const dashboard = DashboardTable
export const dashboardAccessGrant = DashboardAccessGrantTable
