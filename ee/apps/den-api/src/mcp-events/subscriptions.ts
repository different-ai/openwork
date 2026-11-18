import { randomBytes } from "node:crypto"
import { and, eq, gt, inArray } from "@openwork-ee/den-db/drizzle"
import { McpEventSubscriptionTable as Subscription, MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { env } from "../env.js"
import { requestExternalMcpEvents } from "../capability-sources/enterprise-mcp-client-adapter.js"
import { validateExternalMcpToolArguments } from "../mcp/external-mcp-tool-arguments.js"
import { checkRateLimit } from "../utils/rate-limit.js"
import { markFeaturesUsed } from "../feature-usage.js"
import { canonicalArguments, eventListSchema, MAX_SUBSCRIPTION_TTL_MS, subscribedSchema } from "./protocol.js"
import { eventAccess, EventAccessError, requireEventThread, type EventThread } from "./context.js"
import { findSubscription, stopSubscription, type EventSubscription } from "./repository.js"

function publicOrigin() {
  if (!env.apiPublicUrl) throw new EventAccessError("Configure Den's public API URL before enabling MCP thread events.")
  const url = new URL(env.apiPublicUrl)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new EventAccessError("MCP thread events need a public HTTPS API URL.")
  return url.origin
}

async function connectionFor(actor: EventThread | EventSubscription, scopes: readonly string[], connectionId: string) {
  const access = await eventAccess(actor, scopes)
  const connection = access.connections.find((connection) => connection.id === connectionId)
  if (!connection) throw new EventAccessError("This MCP connection is not available to you in this chat.")
  return { ...access, connection }
}

export async function listEvents(thread: EventThread, scopes: readonly string[], input: { connectionId?: string; cursor?: string }) {
  if (!input.connectionId) {
    const { connections } = await eventAccess(thread, scopes)
    return { connections: connections.map(({ id, name }) => ({ id, name })), next: "Choose a connection to discover its webhook events." }
  }
  const { connection } = await connectionFor(thread, scopes, input.connectionId)
  const page = eventListSchema.parse(await requestExternalMcpEvents({ connection, member: { orgMembershipId: thread.memberId }, redirectUri: `${publicOrigin()}/v1/mcp-connections/${connection.id}/connect/callback`, method: "events/list", params: input.cursor ? { cursor: input.cursor } : {} }))
  return { ...page, events: page.events.filter((event) => event.delivery.includes("webhook")) }
}

export function subscriptionSummary(row: EventSubscription) {
  return { id: row.id, source: row.source, connectionId: row.connectionId, name: row.name, incomplete: row.incomplete, status: row.expiresAt.getTime() <= Date.now() ? "expired" : row.status, expiresAt: row.expiresAt.toISOString(), instruction: row.instruction }
}

export async function listSubscriptions(thread: EventThread) {
  const rows = await db.$primary.select().from(Subscription).where(and(eq(Subscription.organizationId, thread.organizationId), eq(Subscription.memberId, thread.memberId), eq(Subscription.sessionId, thread.sessionId))).limit(100)
  return rows.map(subscriptionSummary)
}

export async function subscribe(thread: EventThread, originalScopes: readonly string[], input: { connectionId: string; name: string; arguments: Record<string, unknown>; instruction: string; ttlMs: number }) {
  const { connection, scopes } = await connectionFor(thread, originalScopes, input.connectionId)
  await requireEventThread(thread, scopes)
  if (await checkRateLimit(`mcp-event-subscribe:${thread.organizationId}:${thread.memberId}`, 10, 60_000, Date.now()) !== null) throw new EventAccessError("Too many subscription requests. Try again in a minute.")
  const argumentsJson = canonicalArguments(input.arguments)
  if (Buffer.byteLength(argumentsJson) > 16_384) throw new EventAccessError("Event filters must fit within 16 KiB.")
  const redirectUri = `${publicOrigin()}/v1/mcp-connections/${connection.id}/connect/callback`
  const request = (method: "events/list" | "events/subscribe" | "events/unsubscribe", params: Record<string, unknown>) => requestExternalMcpEvents({ connection, member: { orgMembershipId: thread.memberId }, redirectUri, method, params })
  let cursor: string | undefined
  let descriptor: ReturnType<typeof eventListSchema.parse>["events"][number] | undefined
  for (let page = 0; page < 10; page++) {
    const result = eventListSchema.parse(await request("events/list", cursor ? { cursor } : {}))
    descriptor = result.events.find((event) => event.name === input.name && event.delivery.includes("webhook"))
    if (descriptor || !result.nextCursor || result.nextCursor === cursor) break
    cursor = result.nextCursor
  }
  if (!descriptor) throw new EventAccessError("This MCP server did not advertise that webhook event.")
  if (!validateExternalMcpToolArguments(descriptor.inputSchema, input.arguments).ok) throw new EventAccessError("The event filters do not match the server's advertised input schema.")
  const id = randomBytes(24).toString("hex")
  const now = new Date()
  const expiresAt = new Date(now.getTime() + Math.min(input.ttlMs, MAX_SUBSCRIPTION_TTL_MS))
  const row = await db.transaction(async (tx) => {
    // Serialize creation per member so repeated tool calls cannot create duplicate active watches.
    await tx.select({ id: MemberTable.id }).from(MemberTable).where(eq(MemberTable.id, thread.memberId)).for("update")
    const existing = await tx.select().from(Subscription).where(and(eq(Subscription.organizationId, thread.organizationId), eq(Subscription.memberId, thread.memberId), eq(Subscription.sessionId, thread.sessionId), inArray(Subscription.status, ["pending", "active"]), gt(Subscription.expiresAt, now)))
    const same = existing.find((entry) => entry.connectionId === connection.id && entry.name === input.name && entry.arguments === argumentsJson)
    if (same) {
      if (same.instruction !== input.instruction) throw new EventAccessError("Unsubscribe the existing watch before changing its instruction.")
      return same
    }
    if (existing.length >= 10) throw new EventAccessError("This chat already has ten active subscriptions. Unsubscribe one first.")
    const value = { id, source: "connection", organizationId: thread.organizationId, userId: thread.userId, memberId: thread.memberId, sessionId: thread.sessionId, connectionId: normalizeDenTypeId("externalMcpConnection", input.connectionId), name: input.name, arguments: argumentsJson, instruction: input.instruction, secret: `whsec_${randomBytes(32).toString("base64")}`, callbackUrl: `${publicOrigin()}/v1/mcp-events/webhooks/${id}`, remoteId: null, cursor: null, incomplete: false, model: thread.model, scopes, status: "pending", expiresAt, createdAt: now }
    await tx.insert(Subscription).values(value)
    return value
  })
  if (row.id !== id) return subscriptionSummary(row)
  try {
    const result = subscribedSchema.parse(await request("events/subscribe", { name: row.name, arguments: input.arguments, delivery: { mode: "webhook", url: row.callbackUrl, secret: row.secret }, cursor: null, ttlMs: expiresAt.getTime() - now.getTime() }))
    const grantedUntil = new Date(Math.min(expiresAt.getTime(), result.refreshBefore ? Date.parse(result.refreshBefore) : Infinity))
    if (grantedUntil.getTime() <= Date.now()) throw new Error("Subscription already expired")
    // Recheck after the network call. A kill switch or unsubscribe during verification wins.
    await connectionFor(thread, scopes, input.connectionId)
    await db.update(Subscription).set({ remoteId: result.id, expiresAt: grantedUntil, status: "active", cursor: result.cursor, incomplete: result.truncated }).where(and(eq(Subscription.id, row.id), eq(Subscription.status, "pending")))
    const saved = await findSubscription(row.id)
    if (!saved || saved.status !== "active") throw new Error("Subscription stopped")
    markFeaturesUsed({ organizationId: thread.organizationId, memberId: thread.memberId, keys: ["mcpThreadEvents"] })
    return { ...subscriptionSummary(saved), truncated: result.truncated }
  } catch {
    await stopSubscription(row.id)
    // Even an ambiguous subscribe failure might have created the remote subscription.
    await request("events/unsubscribe", { name: row.name, arguments: input.arguments, delivery: { mode: "webhook", url: row.callbackUrl } }).catch(() => undefined)
    throw new EventAccessError("The MCP subscription could not be activated. Check the connection and callback reachability, then try again.")
  }
}

export async function unsubscribe(thread: EventThread, scopes: readonly string[], id: string) {
  const row = await findSubscription(id)
  if (!row || row.organizationId !== thread.organizationId || row.memberId !== thread.memberId || row.sessionId !== thread.sessionId) throw new EventAccessError("That subscription does not belong to this chat.")
  await stopSubscription(id)
  if (row.source === "openwork") {
    if (row.remoteId) await (await import("../native-mcp-events/service.js")).stopNativeSubscription(row.remoteId)
    return { id, status: "stopped", remoteStopped: true }
  }
  let remoteStopped = false
  try {
    if (!row.connectionId) throw new Error("Missing connection")
    const { connection } = await connectionFor(thread, scopes, row.connectionId)
    await requestExternalMcpEvents({ connection, member: { orgMembershipId: thread.memberId }, redirectUri: `${publicOrigin()}/v1/mcp-connections/${connection.id}/connect/callback`, method: "events/unsubscribe", params: { name: row.name, arguments: JSON.parse(row.arguments), delivery: { mode: "webhook", url: row.callbackUrl } } })
    remoteStopped = true
  } catch { /* Local stop is authoritative even if the provider is unreachable or access was revoked. */ }
  return { id, status: "stopped", remoteStopped }
}
