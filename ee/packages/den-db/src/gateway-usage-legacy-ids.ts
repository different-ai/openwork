import { and, asc, eq, gt, like, lte, or, sql, type SQL } from "drizzle-orm"
import { mysqlTable, varchar, type MySqlColumn } from "drizzle-orm/mysql-core"
import {
  denTypeIdFromLegacyUuid,
  isLegacyUuid,
  LEGACY_UUID_SQL_PATTERN,
} from "@openwork-ee/utils/typeid"
import { isGatewayUsageDeadlock } from "./gateway-usage-errors"
import type { GatewayUsageDb, UsageTx } from "./gateway-usage-read"

/*
 * Rewrites gateway usage rows created before policies, assignments, reset
 * requests and audit rows adopted TypeIDs. Each legacy UUID becomes the TypeID
 * with the same 128-bit value, so every process computes the same result and
 * the conversion can run on any number of instances at once, be interrupted at
 * any point, and be repeated.
 *
 * The app reads legacy UUIDs as TypeIDs (`legacyUuidDenTypeIdColumn`), but SQL
 * joins compare stored values: admission joins assignments, policies and limit
 * entries. A policy and the rows that join to it are therefore converted in one
 * transaction while the policy row is locked.
 *
 * The tables below are raw views with plain string columns, so the converter
 * reads and writes exactly what is stored, bypassing the TypeID column types.
 */

const key = (name: string) => varchar(name, { length: 64 }).notNull()

const Policy = mysqlTable("gateway_usage_limit_policy", { id: key("id") })
const Limit = mysqlTable("gateway_usage_limit_entry", { policyId: key("policy_id") })
const Assignment = mysqlTable("gateway_usage_limit_assignment", {
  id: key("id"),
  policyId: key("policy_id"),
})
const Reset = mysqlTable("gateway_usage_reset_request", { id: key("id"), policyId: key("policy_id") })
const Audit = mysqlTable("gateway_usage_audit", {
  id: key("id"),
  action: varchar("action", { length: 64 }).notNull(),
  subjectId: key("subject_id"),
})
// Tables holding a copied policy reference, scanned in primary-key order.
// `bucket_charge` grows with every request and has no index on policy_id, so
// these are converted in bounded batches outside the policy transaction.
const policyReferences = (table: string, keyColumn: string) =>
  mysqlTable(table, { key: key(keyColumn), policyId: key("policy_id") })
const PolicyReferenceTables = [
  policyReferences("gateway_usage_bucket", "id"),
  policyReferences("gateway_usage_bucket_charge", "event_id"),
  policyReferences("gateway_usage_reset_request", "id"),
]

const KEY_BATCH = 100
const REFERENCE_BATCH = 500
const MAX_ATTEMPTS = 4

export type GatewayUsageLegacyIdConversion = {
  /** Rows rewritten by this run. */
  converted: number
  /** Legacy UUIDs still present, e.g. rows locked by another transaction during this run. */
  remaining: boolean
}

function legacy(column: MySqlColumn): SQL {
  return sql`${column} regexp ${LEGACY_UUID_SQL_PATTERN}`
}

function isLockWaitTimeout(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 6; depth++) {
    if (typeof current !== "object" || current === null) return false
    if ("code" in current && current.code === "ER_LOCK_WAIT_TIMEOUT") return true
    if ("errno" in current && current.errno === 1205) return true
    current = "cause" in current ? current.cause : null
  }
  return false
}

async function retrying<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !(isGatewayUsageDeadlock(error) || isLockWaitTimeout(error)))
        throw error
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt))
    }
  }
}

/**
 * Rewrites one legacy policy ID in the policy row and in the limit entries and
 * assignments that admission joins to it. Callers hold the policy row lock when
 * it still exists; when it is already converted or gone, this only fixes the
 * stray references.
 */
async function convertPolicyGroup(tx: UsageTx, legacyId: string): Promise<number> {
  const next = denTypeIdFromLegacyUuid("gatewayUsagePolicy", legacyId)
  await tx.update(Limit).set({ policyId: next }).where(eq(Limit.policyId, legacyId))
  await tx.update(Assignment).set({ policyId: next }).where(eq(Assignment.policyId, legacyId))
  await tx.update(Policy).set({ id: next }).where(eq(Policy.id, legacyId))
  return 1
}

async function convertNextPolicy(db: GatewayUsageDb): Promise<number> {
  return retrying(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: Policy.id })
        .from(Policy)
        .where(legacy(Policy.id))
        .orderBy(asc(Policy.id))
        .limit(1)
        .for("update", { skipLocked: true })
      return row ? convertPolicyGroup(tx, row.id) : 0
    }),
  )
}

/** Limit entries or assignments still pointing at a legacy policy ID whose policy row was converted. */
async function convertStrayPolicyReferences(db: GatewayUsageDb): Promise<number> {
  const strays = new Set<string>()
  for (const column of [Limit.policyId, Assignment.policyId]) {
    const rows = await db
      .selectDistinct({ policyId: column })
      .from(column.table)
      .where(legacy(column))
      .limit(KEY_BATCH)
    for (const row of rows) strays.add(row.policyId)
  }
  let converted = 0
  for (const legacyId of strays) {
    converted += await retrying(() =>
      db.transaction(async (tx) => {
        // A policy row still holding this legacy ID is locked and converted with
        // its group. If another transaction holds it, leave the group for later.
        const [locked] = await tx
          .select({ id: Policy.id })
          .from(Policy)
          .where(eq(Policy.id, legacyId))
          .for("update", { skipLocked: true })
        if (!locked) {
          const [busy] = await tx.select({ id: Policy.id }).from(Policy).where(eq(Policy.id, legacyId))
          if (busy) return 0
        }
        return convertPolicyGroup(tx, legacyId)
      }),
    )
  }
  return converted
}

type KeyedTable = typeof Assignment | typeof Reset

async function convertKeys(
  db: GatewayUsageDb,
  table: KeyedTable,
  name: "gatewayUsageAssignment" | "gatewayUsageResetRequest",
): Promise<number> {
  return retrying(() =>
    db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: table.id })
        .from(table)
        .where(legacy(table.id))
        .orderBy(asc(table.id))
        .limit(KEY_BATCH)
        .for("update", { skipLocked: true })
      for (const row of rows)
        await tx
          .update(table)
          .set({ id: denTypeIdFromLegacyUuid(name, row.id) })
          .where(eq(table.id, row.id))
      return rows.length
    }),
  )
}

const POLICY_AUDIT_ACTIONS = like(Audit.action, "policy\\_%")
const RESET_AUDIT_ACTIONS = like(Audit.action, "reset\\_%")

/** Audit IDs, plus subjects of policy_* and reset_* actions (which name a policy or reset request). */
async function convertAudit(db: GatewayUsageDb): Promise<number> {
  return retrying(() =>
    db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: Audit.id, action: Audit.action, subjectId: Audit.subjectId })
        .from(Audit)
        .where(
          or(
            legacy(Audit.id),
            and(legacy(Audit.subjectId), or(POLICY_AUDIT_ACTIONS, RESET_AUDIT_ACTIONS)),
          ),
        )
        .orderBy(asc(Audit.id))
        .limit(KEY_BATCH)
        .for("update", { skipLocked: true })
      for (const row of rows) {
        const id = isLegacyUuid(row.id) ? denTypeIdFromLegacyUuid("gatewayUsageAudit", row.id) : row.id
        const subjectId = !isLegacyUuid(row.subjectId)
          ? row.subjectId
          : row.action.startsWith("policy_")
            ? denTypeIdFromLegacyUuid("gatewayUsagePolicy", row.subjectId)
            : row.action.startsWith("reset_")
              ? denTypeIdFromLegacyUuid("gatewayUsageResetRequest", row.subjectId)
              : row.subjectId
        await tx.update(Audit).set({ id, subjectId }).where(eq(Audit.id, row.id))
      }
      return rows.length
    }),
  )
}

/**
 * One primary-key-ordered pass over a table holding copied policy references.
 * Each batch rewrites matching rows by value within its key range, so it never
 * holds locks across batches.
 */
async function convertPolicyReferences(
  db: GatewayUsageDb,
  table: (typeof PolicyReferenceTables)[number],
): Promise<number> {
  let cursor: string | null = null
  let converted = 0
  for (;;) {
    const after: SQL | undefined = cursor === null ? undefined : gt(table.key, cursor)
    const rows = await db
      .select({ key: table.key, policyId: table.policyId })
      .from(table)
      .where(and(after, legacy(table.policyId)))
      .orderBy(asc(table.key))
      .limit(REFERENCE_BATCH)
    const last = rows.at(-1)
    if (!last) return converted
    const legacyIds = [...new Set(rows.map((row) => row.policyId))]
    await retrying(() =>
      db.transaction(async (tx) => {
        for (const legacyId of legacyIds)
          await tx
            .update(table)
            .set({ policyId: denTypeIdFromLegacyUuid("gatewayUsagePolicy", legacyId) })
            .where(and(after, lte(table.key, last.key), eq(table.policyId, legacyId)))
      }),
    )
    converted += rows.length
    cursor = last.key
  }
}

async function anyLegacy(db: GatewayUsageDb, columns: MySqlColumn[]): Promise<boolean> {
  for (const column of columns) {
    const [row] = await db.select({ found: sql`1` }).from(column.table).where(legacy(column)).limit(1)
    if (row) return true
  }
  return false
}

async function drain(step: () => Promise<number>): Promise<number> {
  let total = 0
  for (;;) {
    const converted = await step()
    if (converted === 0) return total
    total += converted
  }
}

/**
 * Converts every remaining legacy UUID in the gateway usage tables. Safe to
 * run concurrently and repeatedly; returns how many rows this run rewrote and
 * whether any legacy values are still present (for example rows another
 * transaction held locked).
 */
export async function convertGatewayUsageLegacyIds(
  db: GatewayUsageDb,
): Promise<GatewayUsageLegacyIdConversion> {
  let converted = 0
  converted += await drain(() => convertNextPolicy(db))
  converted += await drain(() => convertStrayPolicyReferences(db))
  converted += await drain(() => convertKeys(db, Assignment, "gatewayUsageAssignment"))
  converted += await drain(() => convertKeys(db, Reset, "gatewayUsageResetRequest"))
  converted += await drain(() => convertAudit(db))
  for (const table of PolicyReferenceTables) converted += await convertPolicyReferences(db, table)
  const remaining =
    (await anyLegacy(db, [Policy.id, Limit.policyId, Assignment.id, Assignment.policyId, Reset.id])) ||
    (await db
      .select({ id: Audit.id })
      .from(Audit)
      .where(
        or(
          legacy(Audit.id),
          and(legacy(Audit.subjectId), or(POLICY_AUDIT_ACTIONS, RESET_AUDIT_ACTIONS)),
        ),
      )
      .limit(1)).length > 0
  return { converted, remaining }
}
