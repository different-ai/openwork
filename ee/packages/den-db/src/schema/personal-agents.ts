import { relations, sql } from "drizzle-orm"
import { bigint, boolean, index, int, mysqlEnum, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import type { PersonalAgentChange, PersonalAgentEventDetail } from "@openwork/types/den/personal-agents"
import { compatJsonColumn, denTypeIdColumn, encryptedMediumTextColumn, timestamps } from "../columns"

/**
 * A member's own agent. The brief lives in its revisions, so a routine (an
 * Automation with `agent_id`) can pin the exact brief it runs with. What the
 * agent may use is in `tool_permission_rule`, read when a tool is called.
 */
export const PersonalAgentTable = mysqlTable(
  "personal_agent",
  {
    id: denTypeIdColumn("personalAgent", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    owner_member_id: denTypeIdColumn("member", "owner_member_id").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    state: mysqlEnum("state", ["active", "archived"]).notNull().default("active"),
    current_revision_id: denTypeIdColumn("personalAgentRevision", "current_revision_id").notNull(),
    archived_at: timestamp("archived_at", { fsp: 3 }),
    paused_at: timestamp("paused_at", { fsp: 3 }),
    paused_by_member_id: denTypeIdColumn("member", "paused_by_member_id"),
    admin_monthly_budget_micros: bigint("admin_monthly_budget_micros", { mode: "number", unsigned: true }),
    created_by_member_id: denTypeIdColumn("member", "created_by_member_id"),
    idempotency_key: varchar("idempotency_key", { length: 128 }),
    ...timestamps,
  },
  (table) => [
    index("personal_agent_org_owner_state").on(table.organization_id, table.owner_member_id, table.state),
    uniqueIndex("personal_agent_idempotency").on(table.organization_id, table.created_by_member_id, table.idempotency_key),
  ],
)

/** Who else may use an agent, and how far. The owner is not listed here. */
export const PersonalAgentShareTable = mysqlTable(
  "personal_agent_share",
  {
    id: denTypeIdColumn("personalAgentShare", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    agent_id: denTypeIdColumn("personalAgent", "agent_id").notNull(),
    member_id: denTypeIdColumn("member", "member_id").notNull(),
    role: mysqlEnum("role", ["manager", "collaborator"]).notNull(),
    created_by_member_id: denTypeIdColumn("member", "created_by_member_id").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("personal_agent_share_member").on(table.agent_id, table.member_id),
    index("personal_agent_share_org_member").on(table.organization_id, table.member_id),
  ],
)

/**
 * A change to an agent that waits for its owner: a collaborator's or a
 * manager's change to the job, a routine, the tool settings or the memory.
 * A tool that waits for a yes is a `tool_approval`.
 */
export const PersonalAgentRequestTable = mysqlTable(
  "personal_agent_request",
  {
    id: denTypeIdColumn("personalAgentRequest", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    agent_id: denTypeIdColumn("personalAgent", "agent_id").notNull(),
    status: mysqlEnum("status", ["pending", "denied", "approved"]).notNull().default("pending"),
    requested_by_member_id: denTypeIdColumn("member", "requested_by_member_id").notNull(),
    summary: varchar("summary", { length: 500 }),
    change: compatJsonColumn<PersonalAgentChange>("change").notNull(),
    decided_by_member_id: denTypeIdColumn("member", "decided_by_member_id"),
    decided_at: timestamp("decided_at", { fsp: 3 }),
    ...timestamps,
  },
  (table) => [
    index("personal_agent_request_agent_status").on(table.agent_id, table.status),
  ],
)

/** Which desktop chat a member uses for an agent, per workspace, so it follows them. A pointer, never a transcript. */
export const PersonalAgentChatTable = mysqlTable(
  "personal_agent_chat",
  {
    id: denTypeIdColumn("personalAgentChat", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    agent_id: denTypeIdColumn("personalAgent", "agent_id").notNull(),
    member_id: denTypeIdColumn("member", "member_id").notNull(),
    workspace_id: varchar("workspace_id", { length: 240 }).notNull(),
    session_id: varchar("session_id", { length: 240 }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("personal_agent_chat_member_workspace").on(table.agent_id, table.member_id, table.workspace_id),
  ],
)

/**
 * A whole organization or one of its teams that may use an agent as
 * collaborators, next to the people it is shared with one by one. `auto_add`
 * puts the agent in those people's sidebar without them opening it first.
 */
export const PersonalAgentAudienceTable = mysqlTable(
  "personal_agent_audience",
  {
    id: denTypeIdColumn("personalAgentAudience", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    agent_id: denTypeIdColumn("personalAgent", "agent_id").notNull(),
    team_id: denTypeIdColumn("team", "team_id"),
    audience_key: varchar("audience_key", { length: 80 }).notNull(),
    auto_add: boolean("auto_add").notNull().default(false),
    created_by_member_id: denTypeIdColumn("member", "created_by_member_id").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("personal_agent_audience_key").on(table.agent_id, table.audience_key),
    index("personal_agent_audience_org_team").on(table.organization_id, table.team_id),
  ],
)

/**
 * One person's own account on a connection, lent to an agent so that everyone
 * who runs the agent acts through it on that connection. Only where the
 * organization allows shared logins.
 */
export const PersonalAgentSharedLoginTable = mysqlTable(
  "personal_agent_shared_login",
  {
    id: denTypeIdColumn("personalAgentSharedLogin", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    agent_id: denTypeIdColumn("personalAgent", "agent_id").notNull(),
    connection_id: varchar("connection_id", { length: 160 }).notNull(),
    member_id: denTypeIdColumn("member", "member_id").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("personal_agent_shared_login_connection").on(table.agent_id, table.connection_id),
    index("personal_agent_shared_login_member").on(table.organization_id, table.member_id),
  ],
)

/**
 * What an organization decides for every agent: who may share agents, whether
 * a person may lend their own login to an agent, and the most one agent may
 * spend in a month. Tool rules and written rules are the organization's tool
 * permissions (`tool_permission_rule`, `tool_permission_org_policy`).
 */
export const PersonalAgentOrgPolicyTable = mysqlTable(
  "personal_agent_org_policy",
  {
    organization_id: denTypeIdColumn("organization", "organization_id").notNull().primaryKey(),
    monthly_budget_micros: bigint("monthly_budget_micros", { mode: "number", unsigned: true }),
    share_mode: mysqlEnum("share_mode", ["everyone", "admins"]).notNull().default("everyone"),
    shared_logins: boolean("shared_logins").notNull().default(false),
    updated_by_member_id: denTypeIdColumn("member", "updated_by_member_id").notNull(),
    ...timestamps,
  },
)

/**
 * What an agent keeps between runs: notes the owner and managers can read and
 * edit, and the agent adds to while it runs for its owner. Encrypted like the
 * brief. `version` goes up on every write so two edits cannot overwrite each
 * other unseen.
 */
export const PersonalAgentMemoryTable = mysqlTable(
  "personal_agent_memory",
  {
    agent_id: denTypeIdColumn("personalAgent", "agent_id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    notes: encryptedMediumTextColumn("notes").notNull(),
    version: int("version").notNull().default(1),
    updated_by_member_id: denTypeIdColumn("member", "updated_by_member_id"),
    updated_by_run_id: denTypeIdColumn("automationRun", "updated_by_run_id"),
    ...timestamps,
  },
  (table) => [
    index("personal_agent_memory_org").on(table.organization_id),
  ],
)

/** What a routine's last run for the owner did, so the next run does not do it again. One row per routine. */
export const PersonalAgentRoutineStateTable = mysqlTable(
  "personal_agent_routine_state",
  {
    automation_id: denTypeIdColumn("automation", "automation_id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    agent_id: denTypeIdColumn("personalAgent", "agent_id").notNull(),
    state: encryptedMediumTextColumn("state").notNull(),
    run_id: denTypeIdColumn("automationRun", "run_id").notNull(),
    written_by_agent: boolean("written_by_agent").notNull().default(false),
    ...timestamps,
  },
  (table) => [
    index("personal_agent_routine_state_agent").on(table.agent_id),
  ],
)

/** Who changed what about an agent. Never holds a brief, tool arguments or credentials. */
export const PersonalAgentEventTable = mysqlTable(
  "personal_agent_event",
  {
    id: denTypeIdColumn("personalAgentEvent", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    agent_id: denTypeIdColumn("personalAgent", "agent_id"),
    actor_member_id: denTypeIdColumn("member", "actor_member_id").notNull(),
    action: varchar("action", { length: 64 }).notNull(),
    detail: compatJsonColumn<PersonalAgentEventDetail>("detail").notNull(),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("personal_agent_event_org_created").on(table.organization_id, table.created_at),
    index("personal_agent_event_agent").on(table.agent_id, table.created_at),
  ],
)

export const PersonalAgentRevisionTable = mysqlTable(
  "personal_agent_revision",
  {
    id: denTypeIdColumn("personalAgentRevision", "id").notNull().primaryKey(),
    agent_id: denTypeIdColumn("personalAgent", "agent_id").notNull(),
    version: int("version").notNull(),
    brief: encryptedMediumTextColumn("brief").notNull(),
    default_execution_target: mysqlEnum("default_execution_target", ["desktop", "cloud"]).notNull().default("cloud"),
    monthly_budget_micros: bigint("monthly_budget_micros", { mode: "number", unsigned: true }),
    digest: varchar("digest", { length: 128 }).notNull(),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("personal_agent_revision_version").on(table.agent_id, table.version),
  ],
)

export const personalAgentRelations = relations(PersonalAgentTable, ({ one, many }) => ({
  currentRevision: one(PersonalAgentRevisionTable, {
    fields: [PersonalAgentTable.current_revision_id],
    references: [PersonalAgentRevisionTable.id],
  }),
  revisions: many(PersonalAgentRevisionTable),
}))

export const personalAgentRevisionRelations = relations(PersonalAgentRevisionTable, ({ one }) => ({
  agent: one(PersonalAgentTable, {
    fields: [PersonalAgentRevisionTable.agent_id],
    references: [PersonalAgentTable.id],
  }),
}))
