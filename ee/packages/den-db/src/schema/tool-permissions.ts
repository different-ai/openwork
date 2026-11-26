import { index, mysqlEnum, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn, timestamps } from "../columns"

/**
 * One Allow, Ask or Block for one tool of one connection, set for everyone in
 * the organization, one team, one member or one agent. `tool_name` "*" means
 * every tool of the connection and only ever holds a block. Every layer that
 * applies to a call is read together: a block wins, then ask, then allow; with
 * no rule a tool that only reads is allowed and any other tool asks first.
 */
export const ToolPermissionRuleTable = mysqlTable(
  "tool_permission_rule",
  {
    id: denTypeIdColumn("toolPermissionRule", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    subject_kind: mysqlEnum("subject_kind", ["organization", "team", "member", "agent"]).notNull(),
    subject_id: varchar("subject_id", { length: 64 }).notNull(),
    connection_id: varchar("connection_id", { length: 160 }).notNull(),
    tool_name: varchar("tool_name", { length: 128 }).notNull(),
    rule: mysqlEnum("rule", ["allow", "ask", "block"]).notNull(),
    updated_by_member_id: denTypeIdColumn("member", "updated_by_member_id"),
    ...timestamps,
  },
  (table) => [
    index("tool_permission_rule_subject").on(table.organization_id, table.subject_kind, table.subject_id, table.connection_id),
    index("tool_permission_rule_connection").on(table.organization_id, table.connection_id),
  ],
)

/** What an organization writes for every run to follow first. Guidance for the model; tool rules are what is enforced. */
export const ToolPermissionOrgPolicyTable = mysqlTable(
  "tool_permission_org_policy",
  {
    organization_id: denTypeIdColumn("organization", "organization_id").notNull().primaryKey(),
    rules: text("rules"),
    updated_by_member_id: denTypeIdColumn("member", "updated_by_member_id").notNull(),
    ...timestamps,
  },
)

/**
 * A tool call that was refused until a person says yes. The person it was
 * made for decides (for an agent, also its owner). "Allow once" covers the
 * next run of the same agent or Automation, or the next call from a chat.
 * Never holds tool arguments or results.
 */
export const ToolApprovalTable = mysqlTable(
  "tool_approval",
  {
    id: denTypeIdColumn("toolApproval", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    requested_by_member_id: denTypeIdColumn("member", "requested_by_member_id").notNull(),
    context_kind: mysqlEnum("context_kind", ["agent", "automation", "chat"]).notNull(),
    context_id: varchar("context_id", { length: 64 }),
    context_label: varchar("context_label", { length: 160 }),
    run_id: denTypeIdColumn("automationRun", "run_id"),
    connection_id: varchar("connection_id", { length: 160 }).notNull(),
    connection_name: varchar("connection_name", { length: 160 }).notNull(),
    tool_name: varchar("tool_name", { length: 128 }).notNull(),
    tool_title: varchar("tool_title", { length: 240 }).notNull(),
    status: mysqlEnum("status", ["pending", "denied", "allowed_once", "always_allowed", "used"]).notNull().default("pending"),
    decided_by_member_id: denTypeIdColumn("member", "decided_by_member_id"),
    decided_at: timestamp("decided_at", { fsp: 3 }),
    used_by_run_id: denTypeIdColumn("automationRun", "used_by_run_id"),
    used_at: timestamp("used_at", { fsp: 3 }),
    ...timestamps,
  },
  (table) => [
    index("tool_approval_member_status").on(table.organization_id, table.requested_by_member_id, table.status),
    index("tool_approval_context_status").on(table.organization_id, table.context_kind, table.context_id, table.status),
  ],
)
