import { and, eq } from "@openwork-ee/den-db/drizzle"
import { McpEventReceiptTable } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"
import { markFeaturesUsed } from "../feature-usage.js"
import { appLogger } from "../observability/logger.js"
import { eventAccess, EventAccessError, requireEventThread } from "./context.js"
import { eventPrompt, eventSchema } from "./protocol.js"
import { claimEvent, findSubscription, finishEvent, pruneEvents, retryEvent, stopSubscription } from "./repository.js"

export async function dispatchMcpEvent() {
  const receipt = await claimEvent()
  if (!receipt) return false
  try {
    const subscription = await findSubscription(receipt.subscriptionId)
    if (!subscription || subscription.status !== "active" || subscription.expiresAt.getTime() <= Date.now() || !receipt.payload) {
      await finishEvent(receipt.id, "skipped")
      return true
    }
    const { connections, scopes } = await eventAccess(subscription, subscription.scopes)
    if (!connections.some((connection) => connection.id === subscription.connectionId)) throw new EventAccessError("Connection no longer available")
    const { runner } = await requireEventThread(subscription, scopes)
    const event = eventSchema.parse(JSON.parse(receipt.payload))
    // Recheck after remote reads, so a concurrent unsubscribe cannot revive a cancelled pending receipt.
    const [live] = await db.$primary.select({ id: McpEventReceiptTable.id }).from(McpEventReceiptTable).where(and(eq(McpEventReceiptTable.id, receipt.id), eq(McpEventReceiptTable.status, "pending"))).limit(1)
    if (!live) return true
    const sent = await runner.sendTurn(subscription, {
      sessionId: subscription.sessionId, messageId: receipt.id,
      prompt: eventPrompt(subscription.instruction, subscription, event), model: subscription.model,
      execution: "steps",
    })
    if (!sent.ok) throw new Error("Runner did not accept event")
    await finishEvent(receipt.id, "delivered")
    markFeaturesUsed({ organizationId: subscription.organizationId, memberId: subscription.memberId, keys: ["mcpThreadEvents"] })
  } catch (error) {
    if (error instanceof EventAccessError) {
      await stopSubscription(receipt.subscriptionId)
      await finishEvent(receipt.id, "skipped")
    } else {
      await retryEvent(receipt.id, receipt.attempts)
    }
  }
  return true
}

export function startMcpEventWorker() {
  let running: Promise<void> | null = null
  let stopped = false
  let lastPrune = 0
  const tick = () => {
    if (running || stopped) return
    running = (async () => {
      if (Date.now() - lastPrune > 60_000) { await pruneEvents(); lastPrune = Date.now() }
      for (let i = 0; i < 20 && !stopped && await dispatchMcpEvent(); i++) { /* Bounded drain, leases shared by replicas. */ }
    })().catch(() => { appLogger.warn("MCP event queue unavailable", { component: "mcp_events" }) }).finally(() => { running = null })
  }
  const timer = setInterval(tick, 1000)
  timer.unref()
  return async () => { stopped = true; clearInterval(timer); await running }
}
