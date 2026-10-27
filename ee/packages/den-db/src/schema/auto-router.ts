import { sql } from "drizzle-orm"
import { boolean, index, int, mysqlTable, primaryKey, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { compatJsonColumn, denTypeIdColumn, encryptedMediumTextColumn } from "../columns"

const updatedAt = () => timestamp("updated_at", { fsp: 3 })
  .notNull()
  .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`)

/**
 * An organization's Auto Router (packages/types/src/den/auto-router.ts). At
 * most one row per organization; no row means it was never enabled.
 */
export const AutoRouterTable = mysqlTable(
  "auto_router",
  {
    id: denTypeIdColumn("autoRouter", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updatedByOrgMemberId: denTypeIdColumn("member", "updated_by_org_member_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("auto_router_organization").on(table.organizationId)],
)

/**
 * One model the Auto Router may send prompts to: when to use it (`prompt`,
 * shown to Jev) and the thinking levels it may run at. `position` orders the
 * routes; when Jev cannot answer, the first route allowing `high` is used.
 */
export const AutoRouterRouteTable = mysqlTable(
  "auto_router_route",
  {
    id: denTypeIdColumn("autoRouterRoute", "id").notNull().primaryKey(),
    autoRouterId: denTypeIdColumn("autoRouter", "auto_router_id").notNull(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    /** The `ipr_…` AI Gateway provider. */
    gatewayProviderId: denTypeIdColumn("inferenceProvider", "gateway_provider_id").notNull(),
    /** The catalog model id within the provider (not a member's `gwm_…` alias). */
    modelId: varchar("model_id", { length: 255 }).notNull(),
    prompt: text("prompt").notNull(),
    thinkingLevels: compatJsonColumn<string[]>("thinking_levels").notNull(),
    position: int("position", { unsigned: true }).notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("auto_router_route_router").on(table.autoRouterId, table.position),
    index("auto_router_route_organization").on(table.organizationId),
  ],
)

/**
 * Provider reasoning state an Auto response produced before a tool call, kept
 * so the next request of the turn can replay it: Claude's signed thinking
 * blocks, Gemini's thought signatures, Bedrock reasoning blocks. Chat
 * Completions clients cannot carry these back, so every gateway instance
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
