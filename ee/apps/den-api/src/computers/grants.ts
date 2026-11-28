import { and, eq, inArray, isNull, or } from "@openwork-ee/den-db/drizzle"
import { ComputerGrantTable, RemoteDeviceTable } from "@openwork-ee/den-db/schema"
import { isDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import type { ComputerSourceAccess } from "@openwork/types/den/computer-inventory"
import { COMPUTER_OWNER_WHOLE_VM_SOURCE_KEY } from "@openwork/types/den/computers"
import { db } from "../db.js"
import { recordRemoteDeviceEvent, type RemoteDeviceDatabase } from "../remote-device-events.js"
import type { RemoteDeviceActor } from "../remote-devices.js"
import { withDeadlockRetry } from "../utils/deadlock-retry.js"
import { computerMemberNames } from "./activity.js"

type Grant = Pick<typeof ComputerGrantTable.$inferSelect, "sourceKey" | "folders" | "revokedAt" | "revokedByMemberId">
type Viewer = { kind: "member" | "organization"; actor: RemoteDeviceActor }

export async function sourceViews(database: RemoteDeviceDatabase, viewer: Viewer, ownerName: string | null, grants: Grant[]): Promise<ComputerSourceAccess[]> {
  const { organizationId, memberId } = viewer.actor
  const ids = grants.flatMap(({ sourceKey }) => isDenTypeId("remoteDevice", sourceKey) ? [sourceKey] : [])
  const revokerIds = [...new Set(grants.flatMap(({ revokedAt, revokedByMemberId }) => revokedAt && revokedByMemberId ? [revokedByMemberId] : []))]
  const d = RemoteDeviceTable
  const rows = ids.length ? await database.select({ id: d.id, label: d.label }).from(d).where(and(
    eq(d.organizationId, organizationId), inArray(d.id, ids), isNull(d.removedAt),
    viewer.kind === "member" ? or(eq(d.ownerMemberId, memberId), isNull(d.ownerMemberId)) : undefined,
  )) : []
  const names = new Map<string, string>(rows.map(({ id, label }) => [id, label]))
  const revokers = await computerMemberNames(database, organizationId, revokerIds)
  return grants.map(({ sourceKey, folders, revokedAt, revokedByMemberId }) => {
    const whole = sourceKey === COMPUTER_OWNER_WHOLE_VM_SOURCE_KEY
    const label = sourceKey === "workbot" ? "Workbot" : whole || sourceKey === "owner"
      ? ownerName ? `${ownerName}'s OpenWork apps` : "The owner's OpenWork apps"
      : names.get(sourceKey) ?? "A removed computer"
    const revokedBy = revokedAt && revokedByMemberId ? revokers.get(revokedByMemberId) ?? null : null
    return { key: sourceKey, label, scope: whole ? "whole_computer" : "sandbox", folders, revokedAt: revokedAt?.toISOString() ?? null, revokedBy }
  })
}

export async function updateComputerSource(viewer: Viewer, id: DenTypeId<"remoteDevice">, sourceKey: string, change: "revoke" | "restore") {
  const { organizationId, memberId } = viewer.actor
  const ownerOnly = viewer.kind === "member" || change === "restore"
  const d = RemoteDeviceTable
  const g = ComputerGrantTable
  return withDeadlockRetry(() => db.transaction(async (tx) => {
    const [device] = await tx.select({ ownerMemberId: d.ownerMemberId }).from(d).where(and(
      eq(d.id, id), eq(d.organizationId, organizationId), isNull(d.removedAt), ownerOnly ? eq(d.ownerMemberId, memberId) : undefined,
    )).limit(1).for("update")
    if (!device) return null
    const match = and(eq(g.organizationId, organizationId), eq(g.targetDeviceId, id), eq(g.sourceKey, sourceKey))
    const [grant] = await tx.select().from(g).where(match).limit(1).for("update")
    if (!grant) return null
    const names = await computerMemberNames(tx, organizationId, [...new Set(device.ownerMemberId ? [memberId, device.ownerMemberId] : [memberId])])
    const ownerName = device.ownerMemberId ? names.get(device.ownerMemberId) ?? null : null
    const revoking = change === "revoke"
    const changed = revoking !== (grant.revokedAt !== null)
    const now = new Date()
    const values = changed ? { revokedAt: revoking ? now : null, revokedByMemberId: revoking ? memberId : null } : grant
    if (changed) await tx.update(g).set({ revokedAt: values.revokedAt, revokedByMemberId: values.revokedByMemberId }).where(match)
    const [source] = await sourceViews(tx, viewer, ownerName, [{ ...grant, ...values }])
    if (!source) return null
    if (changed) {
      const who = (names.get(memberId) ?? "An organization member").slice(0, 100)
      await recordRemoteDeviceEvent(tx, {
        organizationId, deviceId: id, type: revoking ? "computer_source_revoked" : "computer_source_restored", now,
        actor: "member", actorId: memberId, message: `${who} ${revoking ? "revoked" : "restored"} access for ${source.label.slice(0, 150)}`,
      })
    }
    return { source, grantId: grant.id, ownerMemberId: device.ownerMemberId }
  }))
}
