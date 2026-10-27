import { index, int, mysqlTable, primaryKey, timestamp, varchar } from "drizzle-orm/mysql-core"
import { compatJsonColumn, denTypeIdColumn, encryptedMediumTextColumn } from "../columns"

/** A member's own choices for their agent, within what the organization allows. */
export type AgentInstanceOverrides = {
  /** Responsibilities the member turned off. */
  muted?: string[]
}

/**
 * "Your agent": one row per member. It points at the template version it runs (null: the built-in default), holds
 * the member's allowed overrides and status, when it wakes next, and a lease so several Den replicas never run one
 * agent twice. Its notes live in the agent's own runner session (`memory/`), not here.
 */
export const AgentInstanceTable = mysqlTable(
  "agent_instance",
  {
    memberId: denTypeIdColumn("member", "member_id").primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    /** The agent config object version it last ran; null is the built-in "Your agent" template. */
    templateVersionId: denTypeIdColumn("configObjectVersion", "template_version_id"),
    /** Null follows the organization's starting choice; `on` or `off` is the member's own. */
    status: varchar("status", { length: 8 }),
    overrides: compatJsonColumn<AgentInstanceOverrides>("overrides"),
    snoozedUntil: timestamp("snoozed_until", { fsp: 3 }),
    /** The event source's calendar checkpoint, last looks and schedule. Member content, so encrypted. */
    state: encryptedMediumTextColumn("state"),
    /** The member's calendar time zone, from the last look. */
    timeZone: varchar("time_zone", { length: 64 }),
    nextWakeAt: timestamp("next_wake_at", { fsp: 3 }).notNull().defaultNow(),
    failures: int("failures").notNull().default(0),
    leaseOwner: varchar("lease_owner", { length: 64 }),
    leaseUntil: timestamp("lease_until", { fsp: 3 }),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("agent_instance_due").on(t.nextWakeAt),
    index("agent_instance_org").on(t.organizationId),
  ],
)

/**
 * One row per item a member was told about (or deliberately not, past the daily limit): what makes every message
 * at most once per item. The id is a hash of member, responsibility and the item's ref, reserved before sending.
 * No content.
 */
export const AgentDeliveryTable = mysqlTable(
  "agent_delivery",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    memberId: denTypeIdColumn("member", "member_id").notNull(),
    responsibility: varchar("responsibility", { length: 32 }).notNull(),
    /** `pending` until delivered; then `sent`, `capped` or `failed`. */
    outcome: varchar("outcome", { length: 16 }).notNull().default("pending"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (t) => [index("agent_delivery_member").on(t.memberId, t.createdAt)],
)

/**
 * Daily counters per organization and responsibility, for the admin's health view: how many passes asked about it,
 * how many of those stayed quiet for it, and how many messages it produced. Counts only, no member or content.
 * `day` is the UTC date.
 */
export const AgentCheckTable = mysqlTable(
  "agent_check",
  {
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    day: varchar("day", { length: 10 }).notNull(),
    responsibility: varchar("responsibility", { length: 32 }).notNull(),
    checks: int("checks").notNull().default(0),
    quiet: int("quiet").notNull().default(0),
    sent: int("sent").notNull().default(0),
    updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "agent_check_pk", columns: [t.organizationId, t.day, t.responsibility] })],
)
