import { randomBytes } from "node:crypto"
import { and, eq, gt, inArray } from "@openwork-ee/den-db/drizzle"
import { McpEventSubscriptionTable as Subscription, MemberTable } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"
import { eventAccess, EventAccessError, requireEventThread, type EventThread } from "../mcp-events/context.js"
import { canonicalArguments } from "../mcp-events/protocol.js"
import { findSubscription, stopSubscription } from "../mcp-events/repository.js"
import { subscriptionSummary } from "../mcp-events/subscriptions.js"
import { createNativeSubscription, stopNativeSubscription } from "./service.js"
import { nativeNameSchema } from "./protocol.js"
import { readNativeSource } from "./sources.js"

export async function subscribeNativeThread(thread: EventThread, originalScopes: readonly string[], input: { name: string; arguments: Record<string, unknown>; instruction: string; ttlMs: number }) {
  const name = nativeNameSchema.parse(input.name)
  const { scopes } = await eventAccess(thread, originalScopes)
  await requireEventThread(thread, scopes)
  await readNativeSource(thread, name, input.arguments, thread.sessionId)
  const args = canonicalArguments(input.arguments)
  if (Buffer.byteLength(args) > 16_384) throw new EventAccessError("Event filters must fit within 16 KiB.")
  const id = randomBytes(24).toString("hex")
  const row = await db.transaction(async tx => {
    await tx.select({ id: MemberTable.id }).from(MemberTable).where(eq(MemberTable.id, thread.memberId)).for("update")
    const watches = await tx.select().from(Subscription).where(and(eq(Subscription.organizationId, thread.organizationId), eq(Subscription.memberId, thread.memberId), eq(Subscription.sessionId, thread.sessionId), inArray(Subscription.status, ["pending", "active"]), gt(Subscription.expiresAt, new Date())))
    const existing = watches.find(watch => watch.source === "openwork" && watch.name === name && watch.arguments === args)
    if (existing) {
      if (existing.instruction !== input.instruction) throw new EventAccessError("Unsubscribe the existing watch before changing its instruction.")
      return existing
    }
    if (watches.length >= 10) throw new EventAccessError("This chat already has ten watches.")
    const value = { id, source: "openwork", organizationId: thread.organizationId, userId: thread.userId, memberId: thread.memberId, sessionId: thread.sessionId, connectionId: null, name, arguments: args, instruction: input.instruction, secret: "", callbackUrl: "", remoteId: null, cursor: null, incomplete: false, model: thread.model, scopes, status: "pending", expiresAt: new Date(Date.now() + input.ttlMs), createdAt: new Date() }
    await tx.insert(Subscription).values(value)
    return value
  })
  if (row.id !== id) return subscriptionSummary(row)
  let remoteId: string | undefined
  try {
    const result = await createNativeSubscription(thread, {
      name, arguments: JSON.parse(args), ttlMs: input.ttlMs,
      delivery: { mode: "thread", watchId: id, sessionId: thread.sessionId },
    })
    remoteId = result.id
    await db.update(Subscription).set({ remoteId, status: "active" }).where(and(eq(Subscription.id, id), eq(Subscription.status, "pending")))
    const saved = await findSubscription(id)
    if (saved?.status !== "active") throw new Error("Watch cancelled")
    return subscriptionSummary(saved)
  } catch (error) {
    await stopSubscription(id)
    if (remoteId) await stopNativeSubscription(remoteId)
    throw error
  }
}
