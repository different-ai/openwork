import { createHash } from "node:crypto"
import { posix } from "node:path"
import { and, desc, eq, gt, inArray, sql } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, MemberTable, RemoteDeviceEventTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import type { ComputerAction, ComputerGrantScope } from "@openwork/types/den/computers"
import { recordRemoteDeviceEvent, type RemoteDeviceDatabase } from "../remote-device-events.js"
import type { RemoteDeviceActor } from "../remote-devices.js"

const COALESCE_MS = 10 * 60_000
const VERBS: Record<ComputerAction["type"], string> = {
  shell: "ran a command", read: "read a file", write: "changed a file", list: "listed files", search: "searched files",
}

export async function computerMemberNames(database: RemoteDeviceDatabase, organizationId: RemoteDeviceActor["organizationId"], ids: DenTypeId<"member">[]) {
  if (ids.length === 0) return new Map<DenTypeId<"member">, string>()
  const rows = await database.select({ id: MemberTable.id, name: AuthUserTable.name, email: AuthUserTable.email })
    .from(MemberTable).innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(and(eq(MemberTable.organizationId, organizationId), inArray(MemberTable.id, ids))).limit(ids.length)
  return new Map(rows.map(({ id, name, email }) => [id, name.trim() || email]))
}

function workingPlace(action: ComputerAction, scope: ComputerGrantScope) {
  const requested = action.type === "shell" ? action.cwd
    : action.type === "read" || action.type === "write" ? posix.dirname(action.path) : action.path
  return requested ?? (scope.surface === "whole_vm" ? scope.folders[0] : undefined)
}

export async function recordAcceptedComputerWork(database: RemoteDeviceDatabase, input: {
  actor: RemoteDeviceActor; deviceId: DenTypeId<"remoteDevice">; action: ComputerAction; scope: ComputerGrantScope; source: "workbot" | "owner_app"; now: Date
}) {
  const { actor, deviceId, action, scope, source, now } = input
  const place = workingPlace(action, scope)
  const fingerprint = createHash("sha256").update(JSON.stringify([source, actor.memberId, action.type, place ?? null])).digest("hex")
  if (source === "owner_app") {
    const e = RemoteDeviceEventTable
    const [recent] = await database.select({ id: e.id }).from(e).where(and(
      eq(e.deviceId, deviceId), eq(e.organizationId, actor.organizationId), eq(e.type, "computer_work_accepted"),
      gt(e.createdAt, new Date(now.getTime() - COALESCE_MS)), sql`json_unquote(json_extract(${e.data}, '$.fingerprint')) = ${fingerprint}`,
    )).orderBy(desc(e.createdAt), desc(e.id)).limit(1)
    if (recent) return
  }
  const name = (await computerMemberNames(database, actor.organizationId, [actor.memberId])).get(actor.memberId)
  const who = source === "workbot" ? "Workbot" : name ? `${name.slice(0, 60)}'s OpenWork app` : "An OpenWork app"
  const location = place ? place.length > 140 ? `${place.slice(0, 137)}...` : place : "its sandbox"
  await recordRemoteDeviceEvent(database, {
    organizationId: actor.organizationId, deviceId, type: "computer_work_accepted", now,
    actor: source === "workbot" ? "workbot" : "member", actorId: actor.memberId, data: { fingerprint },
    message: `${who} ${VERBS[action.type]} in ${location} for ${name?.slice(0, 60) ?? "the computer's owner"}`,
  })
}
