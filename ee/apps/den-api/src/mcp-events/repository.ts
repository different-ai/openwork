import { and, asc, eq, gt, inArray, lt, lte, sql } from "@openwork-ee/den-db/drizzle"
import { McpEventReceiptTable as Receipt, McpEventSubscriptionTable as Subscription } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"
import { eventMessageId, type McpEvent } from "./protocol.js"

export type EventSubscription = typeof Subscription.$inferSelect
export const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60_000

export async function findSubscription(id: string) {
  const [row] = await db.$primary.select().from(Subscription).where(eq(Subscription.id, id)).limit(1)
  return row ?? null
}

export async function acceptEvent(subscription: EventSubscription, event: McpEvent) {
  await db.transaction(async (tx) => {
    // Serialize receipt admission with unsubscribe and never acknowledge an event for a retired watch.
    const [live] = await tx.select({ status: Subscription.status }).from(Subscription).where(and(eq(Subscription.id, subscription.id), gt(Subscription.expiresAt, new Date()))).for("update").limit(1)
    if (live?.status !== "active") throw new Error("Subscription stopped")
    const id = eventMessageId(subscription.id, event.eventId)
    const [existing] = await tx.select({ id: Receipt.id }).from(Receipt).where(eq(Receipt.id, id)).limit(1)
    if (existing) return
    const [total] = await tx.select({ count: sql<number>`count(*)` }).from(Receipt).where(eq(Receipt.subscriptionId, subscription.id))
    // Bounded first rollout: backpressure, never acknowledge and silently drop overflow.
    if (Number(total?.count) >= 100) throw new Error("Subscription delivery limit reached")
    await tx.insert(Receipt).values({ id, subscriptionId: subscription.id, organizationId: subscription.organizationId, payload: JSON.stringify(event), status: "pending" })
  })
}

export async function stopSubscription(id: string) {
  await db.transaction(async (tx) => {
    await tx.update(Subscription).set({ status: "stopped" }).where(eq(Subscription.id, id))
    await tx.update(Receipt).set({ status: "skipped", payload: null }).where(and(eq(Receipt.subscriptionId, id), eq(Receipt.status, "pending")))
  })
}

export async function claimEvent() {
  const now = new Date()
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(Receipt).where(and(eq(Receipt.status, "pending"), lte(Receipt.availableAt, now))).orderBy(asc(Receipt.availableAt)).limit(1).for("update", { skipLocked: true })
    if (!row) return null
    await tx.update(Receipt).set({ availableAt: new Date(now.getTime() + 120_000), attempts: row.attempts + 1 }).where(eq(Receipt.id, row.id))
    return { ...row, attempts: row.attempts + 1 }
  })
}

export async function finishEvent(id: string, status: "delivered" | "skipped" | "failed") {
  await db.update(Receipt).set({ status, payload: null }).where(and(eq(Receipt.id, id), eq(Receipt.status, "pending")))
}
export async function retryEvent(id: string, attempts: number) {
  if (attempts >= 10) return finishEvent(id, "failed")
  await db.update(Receipt).set({ availableAt: new Date(Date.now() + Math.min(300_000, 1000 * 2 ** attempts)) }).where(and(eq(Receipt.id, id), eq(Receipt.status, "pending")))
}
export async function pruneEvents() {
  const before = new Date(Date.now() - RECEIPT_RETENTION_MS)
  await db.update(Subscription).set({ status: "expired" }).where(and(inArray(Subscription.status, ["pending", "active"]), lt(Subscription.expiresAt, new Date())))
  await db.delete(Receipt).where(lt(Receipt.createdAt, before))
  await db.delete(Subscription).where(lt(Subscription.expiresAt, before))
}
