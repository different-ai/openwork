import { and, desc, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable, RemoteDeviceEventTable, RemoteDeviceTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { db } from "../db.js"
import { organizationFeatureEnabled } from "../features.js"
import { readRemoteSessionEventStatus } from "../mcp/remote-session-capabilities.js"
import { SESSION_EVENT, computerArguments, denied, NativeEventError, nativeNameSchema, sessionArguments } from "./protocol.js"

export type NativeActor = { organizationId: string; userId: string; memberId: string }
export async function nativeAccess(actor: NativeActor) {
  const [member] = await db.$primary.select({ id: MemberTable.id }).from(MemberTable).where(and(
    eq(MemberTable.id, normalizeDenTypeId("member", actor.memberId)), eq(MemberTable.organizationId, normalizeDenTypeId("organization", actor.organizationId)),
    eq(MemberTable.userId, normalizeDenTypeId("user", actor.userId)), isNull(MemberTable.removedAt),
  )).limit(1)
  if (!member || !await organizationFeatureEnabled(actor.organizationId, "nativeMcpEvents", { userId: actor.userId })) throw denied()
}
const statusSchema = z.object({ threads: z.array(z.object({ state: z.enum(["starting", "running", "waiting", "idle", "error"]).optional(), stale: z.boolean().optional(), sessionId: z.string().nullable().optional(), waitingFor: z.string().nullable().optional(), pending: z.object({ requestId: z.string() }).nullable().optional(), error: z.object({ code: z.string() }).nullable().optional() })) })

/** Reuse the existing authorization paths. Reading a source never starts a session or provisions a computer. */
export async function readNativeSource(actor: NativeActor, name: string, args: unknown, originSessionId?: string) {
  if (!nativeNameSchema.safeParse(name).success) throw new NativeEventError(-32023, "Unknown event", { kind: "event" })
  await nativeAccess(actor)
  if (name === SESSION_EVENT) {
    const input = sessionArguments.parse(args)
    if (originSessionId && input.sessionId === originSessionId) throw denied()
    const result = await readRemoteSessionEventStatus({ organizationId: normalizeDenTypeId("organization", actor.organizationId), userId: actor.userId }, input)
    if (result.isError) throw denied()
    const state = statusSchema.parse(result.structuredContent ?? JSON.parse(result.content[0]?.text ?? "{}")).threads[0]
    if (!state || state.stale || !state.state) throw new Error("Source temporarily unavailable")
    if (state.error && ["unknown_command", "unknown_session", "session_access_denied", "remote_access_off", "computer_disconnected", "openwork_web_access_required"].includes(state.error.code)) throw denied()
    if (originSessionId && state.sessionId === originSessionId) throw denied()
    return { data: { commandId: input.commandId ?? null, sessionId: state.sessionId ?? input.sessionId ?? null, state: state.state, waitingFor: state.waitingFor ?? null, requestId: state.pending?.requestId ?? null }, emit: (input.states ?? ["waiting", "idle", "error"]).includes(state.state) }
  }
  const { deviceId } = computerArguments.parse(args)
  const [device] = await db.$primary.select().from(RemoteDeviceTable).where(and(
    eq(RemoteDeviceTable.id, normalizeDenTypeId("remoteDevice", deviceId)), eq(RemoteDeviceTable.organizationId, normalizeDenTypeId("organization", actor.organizationId)),
    eq(RemoteDeviceTable.ownerMemberId, normalizeDenTypeId("member", actor.memberId)), isNull(RemoteDeviceTable.removedAt),
  )).limit(1)
  if (!device || (originSessionId && device.externalId === originSessionId)) throw denied()
  const [activity] = await db.$primary.select({ id: RemoteDeviceEventTable.id, type: RemoteDeviceEventTable.type }).from(RemoteDeviceEventTable)
    .where(and(eq(RemoteDeviceEventTable.deviceId, device.id), eq(RemoteDeviceEventTable.organizationId, device.organizationId), inArray(RemoteDeviceEventTable.type, ["registered", "restored", "disconnected", "state_changed", "computer_changed", "paused", "resumed", "rebuilt", "failed"])))
    .orderBy(desc(RemoteDeviceEventTable.createdAt), desc(RemoteDeviceEventTable.id)).limit(1)
  return { data: { deviceId, state: device.state, activityId: activity?.id ?? null, activity: activity?.type ?? null }, emit: true }
}
