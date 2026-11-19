import { sql } from "drizzle-orm"
import { boolean, index, int, mysqlTable, primaryKey, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { compatJsonColumn, denTypeIdColumn, encryptedMediumTextColumn } from "../columns"

const updatedAt = () => timestamp("updated_at", { fsp: 3 })
  .notNull()
  .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`)

/**
 * A Smart Router (packages/types/src/den/auto-router.ts). An organization can
 * have many; each is named and assigned to people through
 * `auto_router_access`.
 */
export const AutoRouterTable = mysqlTable(
  "auto_router",
  {
    id: denTypeIdColumn("autoRouter", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    createdByOrgMemberId: denTypeIdColumn("member", "created_by_org_member_id"),
    updatedByOrgMemberId: denTypeIdColumn("member", "updated_by_org_member_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (table) => [index("auto_router_organization").on(table.organizationId)],
)

/**
 * Who a router applies to, following the assignment pattern of other
 * organization items: everyone (`org_wide`), one member, or one team per row.
 */
export const AutoRouterAccessTable = mysqlTable(
  "auto_router_access",
  {
    id: denTypeIdColumn("autoRouterAccess", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    autoRouterId: denTypeIdColumn("autoRouter", "auto_router_id").notNull(),
    orgWide: boolean("org_wide").notNull().default(false),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id"),
    teamId: denTypeIdColumn("team", "team_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("auto_router_access_organization").on(table.organizationId),
    index("auto_router_access_router").on(table.autoRouterId),
    index("auto_router_access_member").on(table.orgMembershipId),
    index("auto_router_access_team").on(table.teamId),
  ],
)

/**
 * One AI Gateway model a router may send prompts to. `position` orders the
 * models; the first wins ties and is used whenever Jev cannot answer.
 */
export const AutoRouterModelTable = mysqlTable(
  "auto_router_model",
  {
    id: denTypeIdColumn("autoRouterModel", "id").notNull().primaryKey(),
    autoRouterId: denTypeIdColumn("autoRouter", "auto_router_id").notNull(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    /** The `ipr_…` AI Gateway provider. */
    gatewayProviderId: denTypeIdColumn("inferenceProvider", "gateway_provider_id").notNull(),
    /** The catalog model id within the provider (not a member's `gwm_…` alias). */
    modelId: varchar("model_id", { length: 255 }).notNull(),
    position: int("position", { unsigned: true }).notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("auto_router_model_router").on(table.autoRouterId, table.position),
    index("auto_router_model_organization").on(table.organizationId),
  ],
)

/**
 * A task models handle ("code review", "translation"), shared by every router
 * of the organization. One row per name, compared case-insensitively through
 * `name_key`; removed once no model uses it.
 */
export const AutoRouterTaskTable = mysqlTable(
  "auto_router_task",
  {
    id: denTypeIdColumn("autoRouterTask", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    /** `autoRouterTaskKey(name)`: trimmed, spaces collapsed, lowercase. */
    nameKey: varchar("name_key", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("auto_router_task_organization_name").on(table.organizationId, table.nameKey)],
)

/** Which tasks a router model handles; `position` keeps the admin's order. */
export const AutoRouterModelTaskTable = mysqlTable(
  "auto_router_model_task",
  {
    autoRouterModelId: denTypeIdColumn("autoRouterModel", "auto_router_model_id").notNull(),
    taskId: denTypeIdColumn("autoRouterTask", "task_id").notNull(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    position: int("position", { unsigned: true }).notNull(),
  },
  (table) => [
    primaryKey({ name: "auto_router_model_task_pk", columns: [table.autoRouterModelId, table.taskId] }),
    index("auto_router_model_task_task").on(table.taskId),
    index("auto_router_model_task_organization").on(table.organizationId),
  ],
)

/**
 * Provider reasoning state a Smart response produced before a tool call, kept
 * so the next request of the turn can replay it: Claude's signed thinking
 * blocks, Gemini's thought signatures, Bedrock reasoning blocks; and each
 * turn's chosen model and thinking level. Chat Completions clients cannot carry these back, so every gateway instance
 * reads them here. Encrypted (it can quote the conversation) and short-lived.
 */
export const AutoRouterReasoningTable = mysqlTable(
  "auto_router_reasoning",
  {
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    /** The tool call id the client echoes back. */
    toolCallId: varchar("tool_call_id", { length: 191 }).notNull(),
    /** JSON, encrypted. */
    payload: encryptedMediumTextColumn("payload").notNull(),
    expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "auto_router_reasoning_call", columns: [table.organizationId, table.toolCallId] }),
    index("auto_router_reasoning_expires").on(table.expiresAt),
  ],
)
