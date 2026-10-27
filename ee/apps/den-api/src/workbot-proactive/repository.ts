import { createHash, randomUUID } from "node:crypto"
import { and, asc, count, eq, gte, inArray, isNull, lt, lte, or, sql } from "@openwork-ee/den-db/drizzle"
import { AgentCheckTable as Check, AgentDeliveryTable as Delivery, AgentInstanceTable as Instance } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { agentLedgerKey, type AgentItem } from "@openwork/automations/proactive"
import { db } from "../db.js"
import { automationAffectedRows, automationUpdateChangedRows } from "../automations/update-result.js"

/**
 * The only module that reads or writes the agent tables: each member's agent (template version, choices, state,
 * lease) and the delivery ledger that makes every item at most one message.
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

export type MemberChoiceChange = Partial<Pick<AgentInstanceRow, "status" | "overrides" | "snoozedUntil">>

/** Saves a member's own choice. Turning on or resuming makes the agent due now. */
export async function saveMemberChoices(organizationId: DenTypeId<"organization">, memberId: DenTypeId<"member">, change: MemberChoiceChange, now = new Date()) {
  const wake = change.status === "on" || change.snoozedUntil === null
  const set = { ...change, ...(wake ? { nextWakeAt: now } : {}), updatedAt: now }
  await db.insert(Instance).values({ memberId, organizationId, nextWakeAt: now, createdAt: now, ...set }).onDuplicateKeyUpdate({ set })
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
    responsibility: input.item.responsibility,
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
