import { and, desc, eq, lt, or } from "@openwork-ee/den-db/drizzle"
import { RemoteDeviceEventTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  REMOTE_DEVICE_EVENT_LIMIT,
  REMOTE_DEVICE_EVENT_RETENTION_MS,
  type RemoteDeviceEventActor,
  type RemoteDeviceEventLevel,
  type RemoteDeviceEventType,
} from "@openwork/types/den/remote-devices"
import { db } from "./db.js"

/** A device's activity log: what remote-devices.ts and computer-disconnect.ts both append to. */
export type RemoteDeviceDatabase = typeof db | typeof db.$primary | Parameters<Parameters<typeof db["transaction"]>[0]>[0]
export type RemoteDeviceEventData = Record<string, string | number | boolean | null>

/** Appends one event and bounds storage in the same transaction as its writer. */
export async function recordRemoteDeviceEvent(database: RemoteDeviceDatabase, input: {
  organizationId: DenTypeId<"organization">
  deviceId: DenTypeId<"remoteDevice">
  type: RemoteDeviceEventType
  level?: RemoteDeviceEventLevel
  message: string
  actor: RemoteDeviceEventActor
  actorId?: string | null
  data?: RemoteDeviceEventData | null
  now: Date
}) {
  await database.insert(RemoteDeviceEventTable).values({
    id: createDenTypeId("remoteDeviceEvent"),
    organizationId: input.organizationId,
    deviceId: input.deviceId,
    type: input.type,
    level: input.level ?? "info",
    message: input.message.slice(0, 300),
    actor: input.actor,
    actorId: input.actorId ?? null,
    data: input.data ?? null,
    createdAt: input.now,
  })
  await pruneRemoteDeviceEvents(input.deviceId, input.now, database)
}

/** Keeps a device's newest REMOTE_DEVICE_EVENT_LIMIT events from the last REMOTE_DEVICE_EVENT_RETENTION_MS. */
export async function pruneRemoteDeviceEvents(deviceId: DenTypeId<"remoteDevice">, now = new Date(), database: RemoteDeviceDatabase = db) {
  await database.delete(RemoteDeviceEventTable).where(and(
    eq(RemoteDeviceEventTable.deviceId, deviceId),
    lt(RemoteDeviceEventTable.createdAt, new Date(now.getTime() - REMOTE_DEVICE_EVENT_RETENTION_MS)),
  ))
  const [oldestKept] = await database.select({ id: RemoteDeviceEventTable.id, createdAt: RemoteDeviceEventTable.createdAt }).from(RemoteDeviceEventTable)
    .where(eq(RemoteDeviceEventTable.deviceId, deviceId))
    .orderBy(desc(RemoteDeviceEventTable.createdAt), desc(RemoteDeviceEventTable.id)).limit(1).offset(REMOTE_DEVICE_EVENT_LIMIT - 1)
  if (!oldestKept) return
  await database.delete(RemoteDeviceEventTable).where(and(
    eq(RemoteDeviceEventTable.deviceId, deviceId),
    or(lt(RemoteDeviceEventTable.createdAt, oldestKept.createdAt), and(
      eq(RemoteDeviceEventTable.createdAt, oldestKept.createdAt), lt(RemoteDeviceEventTable.id, oldestKept.id),
    )),
  ))
}
