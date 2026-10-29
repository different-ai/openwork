import { createHash, randomUUID } from "node:crypto"
import { and, asc, count, countDistinct, desc, eq, gte, inArray, isNull, lt, lte, max, or, sql } from "@openwork-ee/den-db/drizzle"
import {
  AgentCheckTable as Check,
  AgentDeliveryTable as Delivery,
  AgentInstanceTable as Instance,
  AgentMemberCheckTable as MemberCheck,
} from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { agentLedgerKey, type AgentItem } from "@openwork/automations/proactive"
import { db } from "../db.js"
import { automationAffectedRows, automationUpdateChangedRows } from "../automations/update-result.js"
import { memberCheckId, type AgentCheckRecord, type MemberCheckRow } from "./checks.js"

/**
 * The only module that reads or writes the agent tables: each member's agent (template version, choices, state,
 * lease), the delivery ledger that makes every item at most one message, and each member's check records.
 */

export type AgentInstanceRow = typeof Instance.$inferSelect
/** `folded`: an item carried by a message whose first item is `sent`, so the daily limit counts messages. */
export type DeliveryOutcome = "pending" | "sent" | "folded" | "capped" | "failed"

const LEASE_MS = 10 * 60_000

export async function readAgentInstance(memberId: DenTypeId<"member">): Promise<AgentInstanceRow | null> {
  return (await db.select().from(Instance).where(eq(Instance.memberId, memberId)).limit(1))[0] ?? null
}

/**
 * Gives these members an agent (new rows are due now); existing rows are left alone. Times are always written from
 * here, never left to the database's `now()`, so leases never depend on the server's time zone.
 */
export async function ensureAgentInstances(organizationId: DenTypeId<"organization">, memberIds: readonly DenTypeId<"member">[], now = new Date()) {
  if (!memberIds.length) return
  await db.insert(Instance).ignore().values(memberIds.map((memberId) => ({ memberId, organizationId, nextWakeAt: now, createdAt: now, updatedAt: now })))
}

export type MemberChoiceChange = Partial<Pick<AgentInstanceRow, "status" | "overrides" | "snoozedUntil" | "preferences">>

function choiceSet(change: MemberChoiceChange, now: Date, wakeNow = false) {
  const wake = wakeNow || change.status === "on" || change.snoozedUntil === null
  return { ...change, ...(wake ? { nextWakeAt: now } : {}), updatedAt: now }
}

/** Saves a member's own choice. Turning on or resuming makes the agent due now. */
export async function saveMemberChoices(organizationId: DenTypeId<"organization">, memberId: DenTypeId<"member">, change: MemberChoiceChange, now = new Date()) {
  const set = choiceSet(change, now)
  await db.insert(Instance).values({ memberId, organizationId, nextWakeAt: now, createdAt: now, ...set }).onDuplicateKeyUpdate({ set })
}

/**
 * A member's change that depends on what they have now (their words, the change log, undo): read and written under
 * the row's lock, so two saves at once never lose a change. `decide` returns the change (null for none), whether the
 * agent should look again now, and the caller's result.
 */
export async function changeMemberAgent<Result>(
  organizationId: DenTypeId<"organization">,
  memberId: DenTypeId<"member">,
  decide: (row: AgentInstanceRow | null) => { change: MemberChoiceChange | null; wake: boolean; result: Result },
  now = new Date(),
): Promise<Result> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(Instance).where(eq(Instance.memberId, memberId)).limit(1).for("update")
    const decided = decide(row ?? null)
    if (decided.change) {
      const set = choiceSet(decided.change, now, decided.wake)
      await tx.insert(Instance).values({ memberId, organizationId, nextWakeAt: now, createdAt: now, ...set }).onDuplicateKeyUpdate({ set })
    }
    return decided.result
  })
}

/** Claims up to `limit` due agents for this instance. */
export async function claimDueAgents(limit: number, now: Date): Promise<AgentInstanceRow[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(Instance)
      .where(and(lte(Instance.nextWakeAt, now), or(isNull(Instance.leaseUntil), lte(Instance.leaseUntil, now))))
      .orderBy(asc(Instance.nextWakeAt))
      .limit(limit)
      .for("update", { skipLocked: true })
    if (!rows.length) return []
    const leaseOwner = randomUUID()
    const leaseUntil = new Date(now.getTime() + LEASE_MS)
    await tx.update(Instance).set({ leaseOwner, leaseUntil }).where(inArray(Instance.memberId, rows.map((row) => row.memberId)))
    return rows.map((row) => ({ ...row, leaseOwner, leaseUntil }))
  })
}

export type AgentSettle = Partial<Pick<AgentInstanceRow, "state" | "timeZone" | "templateVersionId" | "failures" | "overrides">> & { nextWakeAt: Date }

/** Releases a claimed agent; false when another instance took the lease meanwhile. */
export async function settleAgent(row: AgentInstanceRow, changes: AgentSettle, now = new Date()) {
  const result = await db
    .update(Instance)
    .set({ ...changes, leaseOwner: null, leaseUntil: null, updatedAt: now })
    .where(and(eq(Instance.memberId, row.memberId), eq(Instance.leaseOwner, row.leaseOwner ?? "")))
  return automationUpdateChangedRows(result)
}

/** True while this instance still holds the agent's lease: checked right before anything is sent. */
export async function holdsAgentLease(row: AgentInstanceRow, now = new Date()) {
  const [current] = await db
    .select({ leaseOwner: Instance.leaseOwner, leaseUntil: Instance.leaseUntil })
    .from(Instance)
    .where(eq(Instance.memberId, row.memberId))
    .limit(1)
  return Boolean(current && current.leaseOwner === row.leaseOwner && current.leaseUntil && current.leaseUntil > now)
}

// ---- Ledger --------------------------------------------------------------------------------------------------------

export function deliveryId(memberId: string, item: AgentItem) {
  return createHash("sha256").update(`${memberId}\u0000${agentLedgerKey(item)}`).digest("hex")
}

/** Which of these items the member was already told about (or deliberately not), as ledger keys. */
export async function toldAgentItems(memberId: DenTypeId<"member">, items: readonly AgentItem[]) {
  const ids = new Map(items.map((item) => [deliveryId(memberId, item), agentLedgerKey(item)]))
  if (!ids.size) return new Set<string>()
  const rows = await db.select({ id: Delivery.id }).from(Delivery).where(inArray(Delivery.id, [...ids.keys()]))
  return new Set(rows.flatMap((row) => {
    const key = ids.get(row.id)
    return key ? [key] : []
  }))
}

/** Reserves one ledger row; only the caller whose insert wins may send. */
export async function reserveAgentDelivery(input: {
  organizationId: DenTypeId<"organization">
  memberId: DenTypeId<"member">
  item: AgentItem
  outcome?: DeliveryOutcome
  now?: Date
}) {
  const id = deliveryId(input.memberId, input.item)
  const result = await db.insert(Delivery).ignore().values({
    id,
    organizationId: input.organizationId,
    memberId: input.memberId,
    // The preset it fell under, or "anything_else" (a column name kept from before sources).
    responsibility: input.item.preset ?? "anything_else",
    outcome: input.outcome ?? "pending",
    createdAt: input.now ?? new Date(),
  })
  return automationAffectedRows(result) > 0 ? id : null
}

export async function finishAgentDelivery(id: string, outcome: DeliveryOutcome) {
  await db.update(Delivery).set({ outcome }).where(eq(Delivery.id, id))
}

/** Messages actually sent to the member since `since` (the start of their local day): the daily limit. */
export async function agentSentSince(memberId: DenTypeId<"member">, since: Date) {
  const [row] = await db
    .select({ sent: count() })
    .from(Delivery)
    .where(and(eq(Delivery.memberId, memberId), eq(Delivery.outcome, "sent"), gte(Delivery.createdAt, since)))
  return row?.sent ?? 0
}

/** Ledger rows only matter while their items can still come up; keep a month. */
export async function pruneAgentDeliveries(before: Date) {
  await db.delete(Delivery).where(lt(Delivery.createdAt, before))
}

// ---- Health counters ----------------------------------------------------------------------------------------------

export type AgentCheckCount = { responsibility: string; checks: number; quiet: number; sent: number }

/** Adds one pass's counts to the organization's counters for the (UTC) day. */
export async function recordAgentChecks(input: { organizationId: DenTypeId<"organization">; day: string; counts: readonly AgentCheckCount[]; now?: Date }) {
  const now = input.now ?? new Date()
  for (const entry of input.counts) {
    await db
      .insert(Check)
      .values({ organizationId: input.organizationId, day: input.day, responsibility: entry.responsibility, checks: entry.checks, quiet: entry.quiet, sent: entry.sent, updatedAt: now })
      .onDuplicateKeyUpdate({
        set: {
          checks: sql`${Check.checks} + ${entry.checks}`,
          quiet: sql`${Check.quiet} + ${entry.quiet}`,
          sent: sql`${Check.sent} + ${entry.sent}`,
          updatedAt: now,
        },
      })
  }
}

/** The organization's counters per responsibility since `fromDay` (inclusive, UTC). */
export async function readAgentChecks(organizationId: DenTypeId<"organization">, fromDay: string): Promise<AgentCheckCount[]> {
  const rows = await db
    .select({
      responsibility: Check.responsibility,
      checks: sql<string>`sum(${Check.checks})`,
      quiet: sql<string>`sum(${Check.quiet})`,
      sent: sql<string>`sum(${Check.sent})`,
    })
    .from(Check)
    .where(and(eq(Check.organizationId, organizationId), gte(Check.day, fromDay)))
    .groupBy(Check.responsibility)
  return rows.map((row) => ({ responsibility: row.responsibility, checks: Number(row.checks ?? 0), quiet: Number(row.quiet ?? 0), sent: Number(row.sent ?? 0) }))
}

/** Members with an agent, and how many muted each responsibility. */
export async function readAgentMutes(organizationId: DenTypeId<"organization">): Promise<{ members: number; muted: Map<string, number> }> {
  const rows = await db.select({ overrides: Instance.overrides }).from(Instance).where(eq(Instance.organizationId, organizationId))
  const muted = new Map<string, number>()
  for (const row of rows) for (const responsibility of new Set(row.overrides?.muted ?? [])) muted.set(responsibility, (muted.get(responsibility) ?? 0) + 1)
  return { members: rows.length, muted }
}

// ---- Each member's checks (My agent) ---------------------------------------------------------------------------

/**
 * Records one check. A repeated skip with the same key (Google still disconnected at the same scheduled pass) stays
 * one row whose time and sentence move forward.
 */
export async function recordMemberCheck(record: AgentCheckRecord) {
  const checkedAt = new Date(record.at)
  await db
    .insert(MemberCheck)
    .values({
      id: memberCheckId(record.memberId, record.key),
      organizationId: record.organizationId,
      memberId: record.memberId,
      checkedAt,
      kind: record.kind,
      outcome: record.outcome,
      reason: record.reason,
      summary: record.summary,
      responsibilities: record.responsibilities,
      sources: record.sources,
      message: record.message,
    })
    .onDuplicateKeyUpdate({ set: { checkedAt, summary: record.summary } })
}

const memberCheckColumns = {
  id: MemberCheck.id,
  checkedAt: MemberCheck.checkedAt,
  kind: MemberCheck.kind,
  outcome: MemberCheck.outcome,
  reason: MemberCheck.reason,
  summary: MemberCheck.summary,
  responsibilities: MemberCheck.responsibilities,
  sources: MemberCheck.sources,
  message: MemberCheck.message,
}

/** The member's checks since `since`, newest first. */
export async function readMemberChecks(memberId: DenTypeId<"member">, since: Date, limit = 300): Promise<MemberCheckRow[]> {
  return db
    .select(memberCheckColumns)
    .from(MemberCheck)
    .where(and(eq(MemberCheck.memberId, memberId), gte(MemberCheck.checkedAt, since)))
    .orderBy(desc(MemberCheck.checkedAt))
    .limit(limit)
}

/** The member's most recent check, however long ago. */
export async function readLastMemberCheck(memberId: DenTypeId<"member">): Promise<MemberCheckRow | null> {
  const [row] = await db.select(memberCheckColumns).from(MemberCheck).where(eq(MemberCheck.memberId, memberId)).orderBy(desc(MemberCheck.checkedAt)).limit(1)
  return row ?? null
}

/** How long check records are kept: members read about this week's checks, and two weeks covers "Earlier this week" on any day. */
export const MEMBER_CHECK_RETENTION_MS = 14 * 24 * 3_600_000

/** Check records are for "what did it do this week": keep about two weeks. */
export async function pruneMemberChecks(before: Date) {
  await db.delete(MemberCheck).where(lt(MemberCheck.checkedAt, before))
}

// ---- Every organization, for /admin › Features (counts only) ---------------------------------------------------

/**
 * Checks members' agents ran and messages they sent, per organization and UTC day in [fromDay, toDay], from the
 * daily counters (every member's agent). Indexed: the organizations that have agents (agent_instance_org), then a
 * range on the counters' primary key (organization, day) for each.
 */
export async function readAgentCheckTotalsByDay(fromDay: string, toDay: string) {
  const organizations = await db.selectDistinct({ organizationId: Instance.organizationId }).from(Instance)
  if (!organizations.length) return []
  const rows = await db
    .select({
      organizationId: Check.organizationId,
      day: Check.day,
      checks: sql<string>`sum(${Check.checks})`,
      sent: sql<string>`sum(${Check.sent})`,
      lastAt: max(Check.updatedAt),
    })
    .from(Check)
    .where(and(inArray(Check.organizationId, organizations.map((row) => row.organizationId)), gte(Check.day, fromDay), lte(Check.day, toDay)))
    .groupBy(Check.organizationId, Check.day)
  return rows.map((row) => ({ organizationId: row.organizationId, day: row.day, checks: Number(row.checks ?? 0), sent: Number(row.sent ?? 0), lastAt: row.lastAt }))
}

/**
 * Checks that failed (why, as a reason code) per organization and UTC day in [since, until), from the members'
 * check records: only members with My agent have them, kept MEMBER_CHECK_RETENTION_MS. Indexed: a range on
 * agent_member_check_time. Never reads the sentence, sources or message reference.
 */
export async function readAgentCheckFailuresByDay(since: Date, until: Date) {
  // Drizzle writes timestamps as UTC wall-clock time, so formatting in the session's zone gives the UTC day.
  const day = sql<string>`date_format(${MemberCheck.checkedAt}, '%Y-%m-%d')`
  const rows = await db
    .select({ organizationId: MemberCheck.organizationId, day, reason: MemberCheck.reason, checks: count(), lastAt: max(MemberCheck.checkedAt) })
    .from(MemberCheck)
    .where(and(gte(MemberCheck.checkedAt, since), lt(MemberCheck.checkedAt, until), eq(MemberCheck.outcome, "failed")))
    .groupBy(MemberCheck.organizationId, day, MemberCheck.reason)
  return rows.map((row) => ({ organizationId: row.organizationId, day: String(row.day), reason: row.reason, checks: Number(row.checks), lastAt: row.lastAt }))
}

/** Members whose agent held a message at their daily limit in [since, until), per organization (check records, as above). */
export async function readAgentDailyLimitMembers(since: Date, until: Date): Promise<Map<string, number>> {
  const rows = await db
    .select({ organizationId: MemberCheck.organizationId, members: countDistinct(MemberCheck.memberId) })
    .from(MemberCheck)
    .where(and(gte(MemberCheck.checkedAt, since), lt(MemberCheck.checkedAt, until), eq(MemberCheck.reason, "daily_limit")))
    .groupBy(MemberCheck.organizationId)
  return new Map(rows.map((row) => [row.organizationId, Number(row.members)]))
}
