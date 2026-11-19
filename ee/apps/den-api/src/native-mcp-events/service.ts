import { randomBytes } from "node:crypto"
import { and, eq, gt, inArray, sql } from "@openwork-ee/den-db/drizzle"
import { McpNativeSubscriptionTable as Subscription, McpNativeDeliveryTable as Delivery, MemberTable, McpEventSubscriptionTable as ThreadWatch } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { db } from "../db.js"
import { canonicalArguments, MAX_SUBSCRIPTION_TTL_MS } from "../mcp-events/protocol.js"
import { checkRateLimit } from "../utils/rate-limit.js"
import { markFeaturesUsed } from "../feature-usage.js"
import { fingerprint, NativeEventError } from "./protocol.js"
import { nativeAccess, readNativeSource, type NativeActor } from "./sources.js"
import { verifyCallback } from "./webhook.js"

export type NativeSubscription = typeof Subscription.$inferSelect
export const signingSecretSchema = z.string().max(94).regex(/^whsec_[A-Za-z0-9+/]+={0,2}$/).refine(value => {
  const encoded = value.slice(6)
  const bytes = Buffer.from(encoded, "base64")
  return bytes.length >= 24 && bytes.length <= 64 && bytes.toString("base64") === encoded
}, "Use a Standard Webhooks secret containing 24–64 random bytes")
export const subscribeSchema = z.object({
  name: z.string().min(1).max(256), arguments: z.record(z.string(), z.json()),
  delivery: z.object({ mode: z.literal("webhook"), url: z.string().url().max(2048), secret: signingSecretSchema }),
  cursor: z.string().max(8192).nullable().optional(), ttlMs: z.number().int().positive().nullable().optional(),
})
export const unsubscribeSchema = z.object({ name: z.string().min(1).max(256), arguments: z.record(z.string(), z.json()), delivery: z.object({ mode: z.literal("webhook"), url: z.string().url().max(2048) }) })
export const subscriptionIdentity = (actor: NativeActor, name: string, args: unknown, destination: string) => fingerprint([actor.organizationId, actor.userId, name, args, destination])
const summary = (row: NativeSubscription) => ({ resultType: "complete" as const, id: row.id, refreshBefore: row.expiresAt.toISOString(), cursor: null, truncated: false })
type SubscribeInput = Omit<z.infer<typeof subscribeSchema>, "delivery"> & {
  delivery: z.infer<typeof subscribeSchema>["delivery"] | { mode: "thread"; watchId: string; sessionId: string }
}

export async function createNativeSubscription(actor: NativeActor, input: SubscribeInput) {
  await nativeAccess(actor)
  if (Buffer.byteLength(canonicalArguments(input.arguments)) > 16_384) throw new NativeEventError(-32602, "Event filters are too large")
  if (await checkRateLimit(`native-mcp-event:${actor.organizationId}:${actor.memberId}`, 20, 60_000, Date.now()) !== null) throw new NativeEventError(-32025, "Too many subscription requests", { limit: "requests", max: 20 })
  const delivery = input.delivery
  const source = await readNativeSource(actor, input.name, input.arguments, delivery.mode === "thread" ? delivery.sessionId : undefined)
  const destination = delivery.mode === "thread" ? `thread:${delivery.sessionId}` : delivery.url
  const identity = subscriptionIdentity(actor, input.name, input.arguments, destination)
  const expiresAt = new Date(Date.now() + Math.max(60_000, Math.min(input.ttlMs ?? MAX_SUBSCRIPTION_TTL_MS, MAX_SUBSCRIPTION_TTL_MS)))
  const verificationToken = randomBytes(24).toString("hex")
  const verificationUntil = new Date(Date.now() + 15_000)
  const { row, previous, values } = await db.transaction(async tx => {
    await tx.select({ id: MemberTable.id }).from(MemberTable).where(eq(MemberTable.id, normalizeDenTypeId("member", actor.memberId))).for("update")
    const [existing] = await tx.select().from(Subscription).where(eq(Subscription.id, identity)).for("update").limit(1)
    if (existing?.verificationUntil && existing.verificationUntil.getTime() > Date.now()) throw new NativeEventError(-32025, "Subscription verification is in progress")
    const active = existing?.status === "active" && existing.expiresAt.getTime() > Date.now()
    const [count] = await tx.select({ total: sql<number>`count(*)` }).from(Subscription).where(and(eq(Subscription.memberId, normalizeDenTypeId("member", actor.memberId)), inArray(Subscription.status, ["active", "verifying"]), gt(Subscription.expiresAt, new Date())))
    if (!active && Number(count?.total) >= 20) throw new NativeEventError(-32025, "Too many active subscriptions", { limit: "subscriptions", max: 20 })
    const rotating = active && delivery.mode === "webhook" && existing.secret !== delivery.secret
    const values = {
      identity, organizationId: normalizeDenTypeId("organization", actor.organizationId), userId: normalizeDenTypeId("user", actor.userId), memberId: normalizeDenTypeId("member", actor.memberId),
      name: input.name, arguments: canonicalArguments(input.arguments), callbackUrl: delivery.mode === "thread" ? null : delivery.url,
      secret: delivery.mode === "thread" ? null : delivery.secret, threadWatchId: delivery.mode === "thread" ? delivery.watchId : null,
      previousSecret: rotating ? existing.secret : active ? existing.previousSecret : null,
      rotateUntil: rotating ? new Date(Date.now() + 5 * 60_000) : active ? existing.rotateUntil : null,
      verifiedAt: existing?.verifiedAt ?? null,
      observation: active ? existing.observation : fingerprint(source.data), sequence: active ? existing.sequence : 0, status: "verifying", expiresAt,
    }
    if (existing) {
      if (!active) await tx.update(Delivery).set({ status: "skipped", payload: null }).where(and(eq(Delivery.subscriptionId, existing.id), eq(Delivery.status, "pending")))
      // Keep a live watch and its old credentials usable while a replacement proves itself.
      await tx.update(Subscription).set({ ...(active ? {} : values), verificationToken, verificationUntil }).where(eq(Subscription.id, existing.id))
      return { row: existing, previous: active ? existing : null, values }
    }
    const value = { id: identity, ...values, verificationToken, verificationUntil, availableAt: new Date(), createdAt: new Date() }
    await tx.insert(Subscription).values(value)
    return { row: value, previous: null, values }
  })
  try {
    // Cache verification for unchanged credentials for five minutes. A replacement key proves itself first.
    const verify = delivery.mode === "webhook" && (!previous || previous.secret !== delivery.secret || !previous.verifiedAt || previous.verifiedAt.getTime() < Date.now() - 300_000)
    if (verify && delivery.mode === "webhook") {
      await verifyCallback(delivery.url, delivery.secret, row.id)
    }
    await nativeAccess(actor)
    await db.update(Subscription).set({ ...values, ...(previous ? { observation: sql`${Subscription.observation}`, sequence: sql`${Subscription.sequence}` } : {}), status: "active", availableAt: new Date(), verifiedAt: verify ? new Date() : previous?.verifiedAt ?? null, verificationToken: null, verificationUntil: null }).where(and(eq(Subscription.id, row.id), eq(Subscription.verificationToken, verificationToken), inArray(Subscription.status, ["active", "verifying"])))
    const [live] = await db.$primary.select().from(Subscription).where(eq(Subscription.id, row.id)).limit(1)
    if (live?.status !== "active" || live.secret !== values.secret || live.expiresAt.getTime() !== expiresAt.getTime()) throw new NativeEventError(-32000, "Subscription cancelled")
    markFeaturesUsed({ organizationId: actor.organizationId, memberId: actor.memberId, keys: ["nativeMcpEvents"] })
    return summary(live)
  } catch (error) {
    // A failed rotation must not destroy a healthy watch; cancellation during verification still wins.
    await db.update(Subscription).set({ ...(previous ? {} : { status: "stopped" }), verificationToken: null, verificationUntil: null }).where(and(eq(Subscription.id, row.id), eq(Subscription.verificationToken, verificationToken), inArray(Subscription.status, ["active", "verifying"])))
    if (error instanceof NativeEventError) throw error
    throw new NativeEventError(-32027, "Callback verification failed", { reason: "challenge_failed" })
  }
}

export async function stopNativeSubscription(id: string) {
  await db.transaction(async tx => {
    const [row] = await tx.select().from(Subscription).where(eq(Subscription.id, id)).for("update").limit(1)
    if (!row) return
    await tx.update(Subscription).set({ status: "stopped" }).where(eq(Subscription.id, id))
    await tx.update(Delivery).set({ status: "skipped", payload: null }).where(and(eq(Delivery.subscriptionId, id), eq(Delivery.status, "pending")))
    if (row.threadWatchId) await tx.update(ThreadWatch).set({ status: "stopped" }).where(eq(ThreadWatch.id, row.threadWatchId))
  })
}
export async function unsubscribeNative(actor: NativeActor, input: z.infer<typeof unsubscribeSchema>) {
  await nativeAccess(actor)
  await stopNativeSubscription(subscriptionIdentity(actor, input.name, input.arguments, input.delivery.url))
  return { resultType: "complete" as const }
}
