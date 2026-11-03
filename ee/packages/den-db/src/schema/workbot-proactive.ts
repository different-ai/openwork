import { index, int, mysqlTable, primaryKey, timestamp, varchar } from "drizzle-orm/mysql-core"
import { compatJsonColumn, denTypeIdColumn, encryptedMediumTextColumn } from "../columns"

/** A member's own choices for their agent, within what the organization allows. */
export type AgentInstanceOverrides = {
  /** Responsibilities the member turned off. */
  muted?: string[]
  /** Narrower working hours than the organization's (`workbotProactive`); read clamped to the organization's. */
  hours?: { startHour: number; endHour: number }
  /** A lower daily limit than the organization's (`workbotProactive`). */
  dailyCap?: number
  /** Inside the working day, only messages the agent marks urgent go out (`workbotProactive`). */
  quietWindow?: { startHour: number; endHour: number }
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
    /**
     * What the member told their agent in their own words (always, never, when, how) and the short log of changes
     * (field, value, chat or page, when) behind "Saved from chat" and Undo. Member content, so encrypted.
     */
    preferences: encryptedMediumTextColumn("preferences"),
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

/** The DM a check sent, so the member can open it in Slack. No message text. */
export type AgentMemberCheckMessage = { channelId: string; messageTs: string; permalink: string | null }

/** A source a check was about: what a message drew on, or what couldn't be read (and the connection to fix). */
export type AgentMemberCheckSource = { id: string; name: string; connectionId: string | null }

/**
 * One row per check of one member's agent, for the member only ("My agent", `workbotProactive`): when it looked,
 * what came of it (`sent`, `quiet`, `waited`, `failed`), a reason code and the sentence the member reads, which
 * responsibilities it was about, and a reference to the DM it sent. No email or message content. Written by the
 * wake; kept about 14 days. The id makes a repeated skip (Google still disconnected) one row whose time moves.
 */
export const AgentMemberCheckTable = mysqlTable(
  "agent_member_check",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    memberId: denTypeIdColumn("member", "member_id").notNull(),
    checkedAt: timestamp("checked_at", { fsp: 3 }).notNull(),
    /** What started it: `morning`, `scheduled` or `calendar`. */
    kind: varchar("kind", { length: 16 }).notNull(),
    outcome: varchar("outcome", { length: 8 }).notNull(),
    reason: varchar("reason", { length: 32 }).notNull(),
    summary: varchar("summary", { length: 400 }).notNull(),
    responsibilities: compatJsonColumn<string[]>("responsibilities"),
    /** The sources it was about (null on rows from before sources). */
    sources: compatJsonColumn<AgentMemberCheckSource[]>("sources"),
    message: compatJsonColumn<AgentMemberCheckMessage>("message"),
  },
  (t) => [
    index("agent_member_check_member").on(t.memberId, t.checkedAt),
    index("agent_member_check_time").on(t.checkedAt),
  ],
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
