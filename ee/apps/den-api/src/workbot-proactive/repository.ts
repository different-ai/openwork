import { createHash, randomUUID } from "node:crypto"
import { and, asc, count, countDistinct, desc, eq, gte, inArray, isNull, lt, lte, max, or, sql } from "@openwork-ee/den-db/drizzle"
import {
  AgentCheckTable as Check,
  AgentDeliveryTable as Delivery,
  AgentInstanceTable as Instance,
  AgentMemberCheckTable as MemberCheck,
} from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { agentLedgerKey, parseAgentState, type AgentItem, type AgentState } from "@openwork/automations/proactive"
import type { AgentCheckRequest } from "@openwork/automations/proactive-brief"
import { db } from "../db.js"
import { automationAffectedRows, automationUpdateChangedRows } from "../automations/update-result.js"
import { memberCheckId, type AgentCheckRecord, type MemberCheckRow } from "./checks.js"

export type AgentInstanceRow = typeof Instance.$inferSelect
export type DeliveryOutcome = "pending" | "sent" | "folded" | "capped" | "failed"

const LEASE_MS = 10 * 60_000

export async function readAgentInstance(memberId: DenTypeId<"member">): Promise<AgentInstanceRow | null> {
  return (await db.select().from(Instance).where(eq(Instance.memberId, memberId)).limit(1))[0] ?? null
}

export async function ensureAgentInstances(organizationId: DenTypeId<"organization">, memberIds: readonly DenTypeId<"member">[], now = new Date()) {
  if (!memberIds.length) return
  await db.insert(Instance).ignore().values(memberIds.map((memberId) => ({ memberId, organizationId, nextWakeAt: now, createdAt: now, updatedAt: now })))
}

export type MemberChoiceChange = Partial<Pick<AgentInstanceRow, "status" | "overrides" | "snoozedUntil" | "preferences">>

function choiceSet(change: MemberChoiceChange, now: Date, wakeNow = false) {
  const wake = wakeNow || change.status === "on" || change.snoozedUntil === null
  return { ...change, ...(wake ? { nextWakeAt: now } : {}), updatedAt: now }
}

export async function saveMemberChoices(organizationId: DenTypeId<"organization">, memberId: DenTypeId<"member">, change: MemberChoiceChange, now = new Date()) {
  const set = choiceSet(change, now)
  await db.insert(Instance).values({ memberId, organizationId, nextWakeAt: now, createdAt: now, ...set }).onDuplicateKeyUpdate({ set })
}

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

export async function settleAgent(row: AgentInstanceRow, changes: AgentSettle, now = new Date()) {
  const result = await db
    .update(Instance)
    .set({ ...changes, leaseOwner: null, leaseUntil: null, updatedAt: now })
    .where(and(eq(Instance.memberId, row.memberId), eq(Instance.leaseOwner, row.leaseOwner ?? "")))
  return automationUpdateChangedRows(result)
}

export async function holdsAgentLease(row: AgentInstanceRow, now = new Date()) {
  const [current] = await db.$primary
    .select({ leaseOwner: Instance.leaseOwner, leaseUntil: Instance.leaseUntil })
    .from(Instance)
    .where(eq(Instance.memberId, row.memberId))
    .limit(1)
  return Boolean(current && current.leaseOwner === row.leaseOwner && current.leaseUntil && current.leaseUntil > now)
}

export function deliveryId(memberId: string, item: AgentItem) {
  return createHash("sha256").update(`${memberId}\u0000${agentLedgerKey(item)}`).digest("hex")
}

export async function toldAgentItems(memberId: DenTypeId<"member">, items: readonly AgentItem[]) {
  const ids = new Map(items.map((item) => [deliveryId(memberId, item), agentLedgerKey(item)]))
  if (!ids.size) return new Set<string>()
  const rows = await db.select({ id: Delivery.id }).from(Delivery).where(inArray(Delivery.id, [...ids.keys()]))
  return new Set(rows.flatMap((row) => {
    const key = ids.get(row.id)
    return key ? [key] : []
  }))
}

export async function reserveAgentDelivery(input: {
  organizationId: DenTypeId<"organization">
  memberId: DenTypeId<"member">
  item: AgentItem
  outcome?: DeliveryOutcome
  kind?: string
  now?: Date
}) {
  const id = deliveryId(input.memberId, input.item)
  const result = await db.insert(Delivery).ignore().values({
    id,
    organizationId: input.organizationId,
    memberId: input.memberId,
    responsibility: input.kind ?? input.item.preset ?? "anything_else",
    outcome: input.outcome ?? "pending",
    createdAt: input.now ?? new Date(),
  })
  return automationAffectedRows(result) > 0 ? id : null
}

export async function finishAgentDelivery(id: string, outcome: DeliveryOutcome) {
  await db.update(Delivery).set({ outcome }).where(eq(Delivery.id, id))
}

export async function agentSentSince(memberId: DenTypeId<"member">, since: Date) {
  const [row] = await db.$primary
    .select({ sent: count() })
    .from(Delivery)
    .where(and(eq(Delivery.memberId, memberId), eq(Delivery.outcome, "sent"), gte(Delivery.createdAt, since)))
  return row?.sent ?? 0
}

export async function pruneAgentDeliveries(before: Date) {
  await db.delete(Delivery).where(lt(Delivery.createdAt, before))
}

export const AGENT_RHYTHM_COUNTER = "rhythm"

export type AgentCheckCount = { responsibility: string; checks: number; quiet: number; sent: number }

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

export async function readAgentMutes(organizationId: DenTypeId<"organization">): Promise<{ members: number; muted: Map<string, number> }> {
  const rows = await db.select({ overrides: Instance.overrides }).from(Instance).where(eq(Instance.organizationId, organizationId))
  const muted = new Map<string, number>()
  for (const row of rows) for (const responsibility of new Set(row.overrides?.muted ?? [])) muted.set(responsibility, (muted.get(responsibility) ?? 0) + 1)
  return { members: rows.length, muted }
}

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

export async function readMemberChecks(memberId: DenTypeId<"member">, since: Date, limit = 300): Promise<MemberCheckRow[]> {
  return db
    .select(memberCheckColumns)
    .from(MemberCheck)
    .where(and(eq(MemberCheck.memberId, memberId), gte(MemberCheck.checkedAt, since)))
    .orderBy(desc(MemberCheck.checkedAt))
    .limit(limit)
}

export async function readLastMemberCheck(memberId: DenTypeId<"member">): Promise<MemberCheckRow | null> {
  const [row] = await db.select(memberCheckColumns).from(MemberCheck).where(eq(MemberCheck.memberId, memberId)).orderBy(desc(MemberCheck.checkedAt)).limit(1)
  return row ?? null
}

export const MEMBER_CHECK_RETENTION_MS = 14 * 24 * 3_600_000

export async function pruneMemberChecks(before: Date) {
  await db.delete(MemberCheck).where(lt(MemberCheck.checkedAt, before))
}

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

export async function readAgentCheckFailuresByDay(since: Date, until: Date) {
  const day = sql<string>`date_format(${MemberCheck.checkedAt}, '%Y-%m-%d')`
  const rows = await db
    .select({ organizationId: MemberCheck.organizationId, day, reason: MemberCheck.reason, checks: count(), lastAt: max(MemberCheck.checkedAt) })
    .from(MemberCheck)
    .where(and(gte(MemberCheck.checkedAt, since), lt(MemberCheck.checkedAt, until), eq(MemberCheck.outcome, "failed")))
    .groupBy(MemberCheck.organizationId, day, MemberCheck.reason)
  return rows.map((row) => ({ organizationId: row.organizationId, day: String(row.day), reason: row.reason, checks: Number(row.checks), lastAt: row.lastAt }))
}

export async function readAgentDailyLimitMembers(since: Date, until: Date): Promise<Map<string, number>> {
  const rows = await db
    .select({ organizationId: MemberCheck.organizationId, members: countDistinct(MemberCheck.memberId) })
    .from(MemberCheck)
    .where(and(gte(MemberCheck.checkedAt, since), lt(MemberCheck.checkedAt, until), eq(MemberCheck.reason, "daily_limit")))
    .groupBy(MemberCheck.organizationId)
  return new Map(rows.map((row) => [row.organizationId, Number(row.members)]))
}

export async function readAgentCheckRequests(memberId: DenTypeId<"member">): Promise<AgentCheckRequest[]> {
  const [row] = await db.$primary.select({ state: Instance.state }).from(Instance).where(eq(Instance.memberId, memberId)).limit(1)
  return parseAgentState(row?.state).requests ?? []
}

export async function changeAgentCheckRequests<Result>(
  memberId: DenTypeId<"member">,
  decide: (row: AgentInstanceRow | null, state: AgentState) => { requests: AgentCheckRequest[] | null; result: Result },
  now = new Date(),
): Promise<Result> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(Instance).where(eq(Instance.memberId, memberId)).limit(1).for("update")
    const state = parseAgentState(row?.state)
    const decided = decide(row ?? null, state)
    if (row && decided.requests) {
      const next: AgentState = { ...state, requests: decided.requests }
      const soonest = decided.requests.filter((request) => !request.done).reduce((min, request) => Math.min(min, request.at), Number.POSITIVE_INFINITY)
      const nextWakeAt = Number.isFinite(soonest) && soonest < row.nextWakeAt.getTime() ? new Date(soonest) : row.nextWakeAt
      await tx.update(Instance).set({ state: JSON.stringify(next), nextWakeAt, updatedAt: now }).where(eq(Instance.memberId, memberId))
    }
    return decided.result
  })
}
