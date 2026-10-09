import { sql } from "drizzle-orm"
import { index, json, mysqlEnum, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { AGENT_PERMISSION_DECISIONS } from "@openwork/types/den/agent-permissions"
import { denTypeIdColumn } from "../columns"

/**
 * Agent permissions an organization's admins set for everyone or for one team
 * (packages/types/src/den/agent-permissions.ts). An organization has at most
 * one policy per scope: `scope_key` is "everyone" or the team's id.
 */
export const AgentPermissionPolicyTable = mysqlTable(
  "agent_permission_policy",
  {
    id: denTypeIdColumn("agentPermissionPolicy", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    /** The team it applies to, or null for everyone. */
    teamId: denTypeIdColumn("team", "team_id"),
    scopeKey: varchar("scope_key", { length: 64 }).notNull(),
    updatedByOrgMemberId: denTypeIdColumn("member", "updated_by_org_member_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("agent_permission_policy_scope").on(table.organizationId, table.scopeKey),
    index("agent_permission_policy_team_id").on(table.teamId),
  ],
)

/**
 * One permission in one policy: its decision and its allowed and blocked
 * patterns. A permission without a row inherits (a team) or allows (everyone).
 */
export const AgentPermissionSettingTable = mysqlTable(
  "agent_permission_setting",
  {
    id: denTypeIdColumn("agentPermissionSetting", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    policyId: denTypeIdColumn("agentPermissionPolicy", "policy_id").notNull(),
    permissionKey: varchar("permission_key", { length: 64 }).notNull(),
    decision: mysqlEnum("decision", AGENT_PERMISSION_DECISIONS),
    allowPatterns: json("allow_patterns").$type<string[]>().notNull().default(sql`(json_array())`),
    blockPatterns: json("block_patterns").$type<string[]>().notNull().default(sql`(json_array())`),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("agent_permission_setting_policy_key").on(table.policyId, table.permissionKey),
    index("agent_permission_setting_organization_id").on(table.organizationId),
  ],
)

export const agentPermissionPolicy = AgentPermissionPolicyTable
export const agentPermissionSetting = AgentPermissionSettingTable
