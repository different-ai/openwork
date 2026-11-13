import { randomBytes } from "node:crypto"
import { and, asc, eq, lt, lte } from "@openwork-ee/den-db/drizzle"
import { McpNativeSubscriptionTable as Subscription, McpNativeDeliveryTable as Delivery } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"
import { organizationFeatureEnabled } from "../features.js"
import { acceptControl, acceptEvent, findSubscription, RECEIPT_RETENTION_MS } from "../mcp-events/repository.js"
import { deliverySchema } from "../mcp-events/protocol.js"
import { appLogger } from "../observability/logger.js"
import { fingerprint, NativeEventError } from "./protocol.js"
import { readNativeSource } from "./sources.js"
import { stopNativeSubscription, type NativeSubscription } from "./service.js"
import { postWebhook } from "./webhook.js"

async function terminate(row: NativeSubscription, error = new NativeEventError(-32024, "Event source no longer available")) {
  await db.transaction(async tx => {
    const [live] = await tx.select().from(Subscription).where(eq(Subscription.id, row.id)).for("update").limit(1)
    if (live?.status !== "active") return
    await tx.update(Subscription).set({ status: "terminated" }).where(eq(Subscription.id, row.id))
    await tx.update(Delivery).set({ status: "skipped", payload: null }).where(and(eq(Delivery.subscriptionId, row.id), eq(Delivery.status, "pending")))
    await tx.insert(Delivery).values({ id: randomBytes(24).toString("hex"), subscriptionId: row.id, organizationId: row.organizationId, payload: JSON.stringify({ type: "terminated", error: { code: error.code, message: error.message, data: error.data } }) })
  })
}

/** One leased observation per watch. The state and pending occurrence commit together. */
export async function observeNativeEvent() {
  const row = await db.transaction(async tx => {
    const [watch] = await tx.select().from(Subscription).where(and(eq(Subscription.status, "active"), lte(Subscription.availableAt, new Date()))).orderBy(asc(Subscription.availableAt)).limit(1).for("update", { skipLocked: true })
    if (watch) await tx.update(Subscription).set({ availableAt: new Date(Date.now() + 120_000) }).where(eq(Subscription.id, watch.id))
    return watch
  })
  if (!row) return false
  try {
    if (row.expiresAt.getTime() <= Date.now() || !await organizationFeatureEnabled(row.organizationId, "nativeMcpEvents", { userId: row.userId })) { await stopNativeSubscription(row.id); return true }
    const watch = row.threadWatchId ? await findSubscription(row.threadWatchId) : null
    if (watch?.status === "pending") {
      await db.update(Subscription).set({ availableAt: new Date(Date.now() + 5000) }).where(eq(Subscription.id, row.id))
      return true
    }
    if (row.threadWatchId && (!watch || watch.status !== "active")) { await stopNativeSubscription(row.id); return true }
    const source = await readNativeSource(row, row.name, JSON.parse(row.arguments), watch?.sessionId)
    await db.transaction(async tx => {
      const [live] = await tx.select().from(Subscription).where(eq(Subscription.id, row.id)).for("update").limit(1)
      if (!live || live.status !== "active" || live.expiresAt.getTime() <= Date.now()) return
      const observation = fingerprint(source.data)
      const changed = observation !== live.observation
      const sequence = live.sequence + (changed && source.emit ? 1 : 0)
      if (changed && source.emit) {
        // Finite watches bound retained traffic. Backpressure leaves the last observation unadvanced.
        if (sequence > 100) throw new NativeEventError(-32025, "Subscription event limit reached", { limit: "events", max: 100 })
        const id = randomBytes(24).toString("hex")
        await tx.insert(Delivery).values({ id, subscriptionId: row.id, organizationId: row.organizationId,
          payload: JSON.stringify({ eventId: id, name: row.name, timestamp: new Date().toISOString(), data: source.data, cursor: null }) })
      }
      await tx.update(Subscription).set({ observation, sequence, availableAt: new Date(Date.now() + 5000) }).where(eq(Subscription.id, row.id))
    })
  } catch (error) {
    if (error instanceof NativeEventError) await terminate(row, error)
    else await db.update(Subscription).set({ availableAt: new Date(Date.now() + 15_000) }).where(eq(Subscription.id, row.id))
  }
  return true
}

export async function deliverNativeEvent() {
  const receipt = await db.transaction(async tx => {
    const [row] = await tx.select().from(Delivery).where(and(eq(Delivery.status, "pending"), lte(Delivery.availableAt, new Date()))).orderBy(asc(Delivery.availableAt)).limit(1).for("update", { skipLocked: true })
    if (row) await tx.update(Delivery).set({ attempts: row.attempts + 1, availableAt: new Date(Date.now() + 120_000) }).where(eq(Delivery.id, row.id))
    return row ? { ...row, attempts: row.attempts + 1 } : null
  })
  if (!receipt) return false
  try {
    const [row] = await db.$primary.select().from(Subscription).where(eq(Subscription.id, receipt.subscriptionId)).limit(1)
    if (!row || !receipt.payload) throw new NativeEventError(-32024, "Subscription unavailable")
    const payload = deliverySchema.parse(JSON.parse(receipt.payload))
    const notice = "type" in payload
    const watch = row.threadWatchId ? await findSubscription(row.threadWatchId) : null
    if (!notice) await readNativeSource(row, row.name, JSON.parse(row.arguments), watch?.sessionId)
    await db.transaction(async tx => {
      const [live] = await tx.select().from(Subscription).where(eq(Subscription.id, row.id)).for("update").limit(1)
      const [pending] = await tx.select().from(Delivery).where(eq(Delivery.id, receipt.id)).for("update").limit(1)
      if (pending?.status !== "pending") return
      if (live?.status === "verifying") {
        await tx.update(Delivery).set({ availableAt: new Date(Date.now() + 5000), attempts: Math.max(0, receipt.attempts - 1) }).where(eq(Delivery.id, receipt.id))
        return
      }
      if (!live || !["active", ...(notice ? ["terminated"] : [])].includes(live.status) || live.expiresAt.getTime() <= Date.now()
        || !await organizationFeatureEnabled(row.organizationId, "nativeMcpEvents", { userId: row.userId, database: tx, lock: "share" })) {
        await tx.update(Delivery).set({ status: "skipped", payload: null }).where(eq(Delivery.id, receipt.id)); return
      }
      if (row.threadWatchId) {
        if (!watch) throw new NativeEventError(-32024, "Chat watch unavailable")
        if (notice) await acceptControl(watch, payload, receipt.id)
        else await acceptEvent(watch, payload)
      } else {
        if (!row.callbackUrl || !row.secret) throw new Error("Missing callback")
        const response = await postWebhook(row.callbackUrl, live.secret ?? row.secret, row.id, receipt.id, payload, live.rotateUntil && live.rotateUntil.getTime() > Date.now() ? live.previousSecret : null)
        if (response.status === 410 || response.status === 413) {
          await tx.update(Delivery).set({ status: "failed", payload: null }).where(eq(Delivery.id, receipt.id)); return
        }
        if (response.status < 200 || response.status >= 300) throw new Error("Callback did not accept event")
      }
      await tx.update(Delivery).set({ status: "delivered", payload: null }).where(eq(Delivery.id, receipt.id))
    })
  } catch (error) {
    if (error instanceof NativeEventError) {
      await db.update(Delivery).set({ status: "skipped", payload: null }).where(and(eq(Delivery.id, receipt.id), eq(Delivery.status, "pending")))
      const [row] = await db.$primary.select().from(Subscription).where(eq(Subscription.id, receipt.subscriptionId)).limit(1)
      if (row) await terminate(row)
    } else if (receipt.attempts >= 10) await db.update(Delivery).set({ status: "failed", payload: null }).where(and(eq(Delivery.id, receipt.id), eq(Delivery.status, "pending")))
    else await db.update(Delivery).set({ availableAt: new Date(Date.now() + Math.min(300_000, 1000 * 2 ** receipt.attempts)) }).where(and(eq(Delivery.id, receipt.id), eq(Delivery.status, "pending")))
  }
  return true
}

export function startNativeEventWorker() {
  let running: Promise<void> | null = null
  let stopped = false
  let prunedAt = 0
  const timer = setInterval(() => {
    if (stopped || running) return
    running = (async () => {
      if (Date.now() - prunedAt > 60_000) {
        const before = new Date(Date.now() - RECEIPT_RETENTION_MS)
        await db.delete(Delivery).where(lt(Delivery.createdAt, before))
        await db.delete(Subscription).where(lt(Subscription.expiresAt, before))
        prunedAt = Date.now()
      }
      for (let count = 0; count < 10 && !stopped; count++) {
        const observed = await observeNativeEvent()
        const delivered = await deliverNativeEvent()
        if (!observed && !delivered) break
      }
    })().catch(() => appLogger.warn("Native MCP event queue unavailable", { component: "native_mcp_events" })).finally(() => { running = null })
  }, 1000)
  timer.unref()
  return async () => { stopped = true; clearInterval(timer); await running }
}
