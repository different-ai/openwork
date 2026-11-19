import { createHash, timingSafeEqual } from "node:crypto"
import { sql } from "@openwork-ee/den-db/drizzle"
import { TelemetryEventTable, TelemetrySessionDimensionTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { headlessRunnerConfig, telemetryFailureCode, telemetryModelId } from "@openwork-ee/headless-protocol"
import { z } from "zod"
import { db } from "../db.js"

/** Service-only facts. No text, names, email, prompts, tokens or arbitrary properties. */
export const workbotTelemetrySchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("signed_in"), id: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/), timestamp: z.number().int().nonnegative().optional() }).strict(),
  z.object({
    event: z.literal("accepted"), sessionId: z.string().regex(/^hs_wbs?_[a-f0-9]{40}$/),
    messageId: z.string().regex(/^(?:wb_hello|wb_[A-Za-z0-9_-]{8,64})$/),
    timestamp: z.number().int().nonnegative(), model: z.string().min(1).max(128),
    attachmentCount: z.number().int().min(0).max(20), hasContext: z.boolean(),
  }).strict(),
  z.object({
    event: z.enum(["completed", "failed", "aborted"]), sessionId: z.string().regex(/^hs_wbs?_[a-f0-9]{40}$/),
    messageId: z.string().regex(/^(?:wb_hello|wb_[A-Za-z0-9_-]{8,64})$/), timestamp: z.number().int().nonnegative(),
    attempt: z.number().int().nonnegative(), model: z.string().min(1).max(128),
    modelSource: z.enum(["response", "configured"]).default("configured"),
    errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(),
  }).strict(),
])
export type WorkbotTelemetry = z.infer<typeof workbotTelemetrySchema>
export type WorkbotTelemetryActor = { organizationId: string; memberId: string }

type Facts = {
  ready_count?: number | null
  attachment_count?: number
  chat?: "main" | "side"
  has_context?: boolean
  error_code?: string
  model?: string
  model_source?: "response" | "configured" | "unknown"
  connection_id?: string
  app_id?: string
}

/** The existing runner service credential proves these facts came from a service, not a member's browser. */
export function workbotTelemetryServiceAuthorized(value: string | undefined) {
  const expected = headlessRunnerConfig()?.token
  if (!expected || !value) return false
  const supplied = new TextEncoder().encode(value)
  const wanted = new TextEncoder().encode(expected)
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted)
}

export function workbotMainSession(actor: WorkbotTelemetryActor) {
  return `hs_wb_${createHash("sha256").update(`workbot:${actor.organizationId}:${actor.memberId}`).digest("hex").slice(0, 40)}`
}

/** Stable primary keys, including under parallel tabs and HTTP retries; no schema change or check-then-insert race. */
export function workbotEventIdentity(actor: WorkbotTelemetryActor, type: string, key: string) {
  const hash = createHash("sha256").update(JSON.stringify([actor.organizationId, actor.memberId, type, key])).digest("hex")
  return { id: eventIdFromHex(hash.slice(0, 32)), sessionId: `wb:${hash}` }
}

/** The same identity scheme for any at-most-once member fact (for example a Get set up step): one row per key. */
export function stableTelemetryEventId(actor: WorkbotTelemetryActor, type: string, key: string) {
  return workbotEventIdentity(actor, type, key).id
}

/** Encode 128 public identifier bits as a TypeID; this is not credential/password storage. */
function eventIdFromHex(hex: string) {
  let value = BigInt(`0x${hex}`)
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz"
  let suffix = ""
  for (let index = 0; index < 26; index += 1) {
    suffix = alphabet[Number(value & 31n)] + suffix
    value >>= 5n
  }
  return normalizeDenTypeId("telemetryEvent", `tev_${suffix}`)
}

/** Best effort, atomically paired with its bounded facts. First sightings never overwrite earlier counts. */
export async function recordWorkbotEvent(actor: WorkbotTelemetryActor, type: string, key: string, facts: Facts = {}, timestamp = Date.now()) {
  return writeWorkbotEvent(actor, type, workbotEventIdentity(actor, type, key), facts, timestamp)
}

async function writeWorkbotEvent(actor: WorkbotTelemetryActor, type: string, identity: ReturnType<typeof workbotEventIdentity>, facts: Facts, timestamp: number) {
  try {
    const { id, sessionId } = identity
    const at = new Date(timestamp)
    await db.transaction(async (tx) => {
      await tx.insert(TelemetryEventTable).values({
        id, org_id: normalizeDenTypeId("organization", actor.organizationId), member_id: normalizeDenTypeId("member", actor.memberId),
        event_type: type, event_timestamp: at, source: "workbot", session_id: sessionId,
        success: type.endsWith("_failed") ? false : true,
      }).onDuplicateKeyUpdate({ set: { id: sql`${TelemetryEventTable.id}` } })
      await tx.insert(TelemetrySessionDimensionTable).values({
        id: createDenTypeId("telemetrySessionDimension"), org_id: normalizeDenTypeId("organization", actor.organizationId),
        session_id: sessionId, source: "workbot", dimension_type: "workbot", dimension_value: type, dimension_label: type,
        metadata: facts, last_seen_at: at,
      }).onDuplicateKeyUpdate({ set: { id: sql`${TelemetrySessionDimensionTable.id}` } })
      if (facts.model) {
        await tx.insert(TelemetrySessionDimensionTable).values({
          id: createDenTypeId("telemetrySessionDimension"), org_id: normalizeDenTypeId("organization", actor.organizationId),
          session_id: sessionId, source: "workbot", dimension_type: "model", dimension_value: facts.model, dimension_label: facts.model,
          last_seen_at: at,
        }).onDuplicateKeyUpdate({ set: { id: sql`${TelemetrySessionDimensionTable.id}` } })
      }
    })
  } catch {
    // Product flows never depend on telemetry. No error payload (which can contain values) is logged.
    console.warn("[workbot] telemetry_not_recorded")
  }
}

export async function recordWorkbotTelemetry(actor: WorkbotTelemetryActor, event: WorkbotTelemetry, readyCount: () => Promise<number | null>) {
  if (event.event === "signed_in") {
    // Preserve the sign-in instant even when the readiness snapshot takes longer than the greeting.
    const at = event.timestamp ?? Date.now()
    return recordWorkbotEvent(actor, "workbot.signed_in", event.id, { ready_count: await readyCount().catch(() => null) }, at)
  }
  const greeting = event.messageId === "wb_hello"
  if (greeting && event.sessionId !== workbotMainSession(actor)) return
  const model = telemetryModelId(event.model)
  if (event.event === "accepted") {
    if (greeting) return recordWorkbotEvent(actor, "workbot.greeting_started", "first", { ready_count: await readyCount().catch(() => null), ...(model ? { model } : {}) }, event.timestamp)
    return recordWorkbotEvent(actor, "workbot.message_sent", `${event.sessionId}:${event.messageId}`, {
      attachment_count: event.attachmentCount, chat: event.sessionId.startsWith("hs_wbs_") ? "side" : "main", has_context: event.hasContext, ...(model ? { model } : {}),
    }, event.timestamp)
  }
  if (event.event === "completed") return recordWorkbotEvent(actor, greeting ? "workbot.greeting_completed" : "workbot.turn_completed", greeting ? "first" : `${event.sessionId}:${event.messageId}`, { ...(model ? { model } : {}), model_source: model ? event.modelSource : "unknown" }, event.timestamp)
  if (!greeting) return
  const errorCode = telemetryFailureCode(event.errorCode ?? (event.event === "aborted" ? "aborted" : "runner_error"))
  return recordWorkbotEvent(actor, "workbot.greeting_failed", `${event.attempt}:${event.timestamp}:${errorCode}`, {
    ...(model ? { model } : {}), error_code: errorCode,
  }, event.timestamp)
}

/** Only the public transaction nonce leaves OAuth. Never hash, store or accept its signed state/token. */
export async function recordWorkbotConnection(actor: WorkbotTelemetryActor, input: { attemptId: string; connectionId: string; appId: string }) {
  const nonce = z.uuid().safeParse(input.attemptId)
  if (!nonce.success) return
  const identity = { id: eventIdFromHex(nonce.data.replace(/-/g, "")), sessionId: `wb:oauth:${nonce.data}` }
  return writeWorkbotEvent(actor, "connection.connected", identity, { connection_id: input.connectionId, app_id: input.appId }, Date.now())
}
