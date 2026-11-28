import { and, asc, eq, inArray, isNull, or } from "@openwork-ee/den-db/drizzle"
import { ComputerGrantTable, RemoteDeviceTable } from "@openwork-ee/den-db/schema"
import { isDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import type { ComputerSourceAccess } from "@openwork/types/den/computer-inventory"
import { COMPUTER_OWNER_WHOLE_VM_SOURCE_KEY } from "@openwork/types/den/computers"
import { db } from "../db.js"
import { recordRemoteDeviceEvent, type RemoteDeviceDatabase } from "../remote-device-events.js"
import type { RemoteDeviceActor } from "../remote-devices.js"
import { withDeadlockRetry } from "../utils/deadlock-retry.js"
import { computerMemberNames } from "./activity.js"

type Grant = Pick<typeof ComputerGrantTable.$inferSelect, "sourceKey" | "folders" | "writableFolders" | "revokedAt" | "revokedByMemberId">
type Viewer = { kind: "member" | "organization"; actor: RemoteDeviceActor }
type SourceTargets = { ownerMemberId: DenTypeId<"member"> | null; ids: DenTypeId<"remoteDevice">[] }

function groupSourceGrants(grants: Grant[]): Grant[] {
  const grouped = new Map<string, Grant[]>()
  for (const grant of grants) {
    const group = grouped.get(grant.sourceKey) ?? []
    group.push(grant)
    grouped.set(grant.sourceKey, group)
  }
  return [...grouped.values()].flatMap((group) => {
    const active = group.filter(({ revokedAt }) => !revokedAt)
    const displayed = active.length ? active : group
    const latest = displayed.reduce<Grant | undefined>((selected, grant) =>
      (selected?.revokedAt?.getTime() ?? 0) > (grant.revokedAt?.getTime() ?? 0) ? selected : grant, undefined)
    return latest ? [{
      ...latest,
      folders: [...new Set(displayed.flatMap(({ folders }) => folders))],
      writableFolders: [...new Set(displayed.flatMap(({ writableFolders }) => writableFolders ?? []))],
    }] : []
  })
}

export async function sourceViews(database: RemoteDeviceDatabase, viewer: Viewer, ownerName: string | null, rawGrants: Grant[]): Promise<ComputerSourceAccess[]> {
  const { organizationId, memberId } = viewer.actor
  const grants = groupSourceGrants(rawGrants)
  const ids = grants.flatMap(({ sourceKey }) => isDenTypeId("remoteDevice", sourceKey) ? [sourceKey] : [])
  const revokerIds = [...new Set(grants.flatMap(({ revokedAt, revokedByMemberId }) => revokedAt && revokedByMemberId ? [revokedByMemberId] : []))]
  const d = RemoteDeviceTable
  const rows = ids.length ? await database.select({ id: d.id, label: d.label }).from(d).where(and(
    eq(d.organizationId, organizationId), inArray(d.id, ids), isNull(d.removedAt),
    viewer.kind === "member" ? or(eq(d.ownerMemberId, memberId), isNull(d.ownerMemberId)) : undefined,
  )) : []
  const names = new Map<string, string>(rows.map(({ id, label }) => [id, label]))
  const revokers = await computerMemberNames(database, organizationId, revokerIds)
  return grants.map(({ sourceKey, folders, writableFolders, revokedAt, revokedByMemberId }) => {
    const whole = sourceKey === COMPUTER_OWNER_WHOLE_VM_SOURCE_KEY
    const label = sourceKey === "workbot" ? "Workbot" : whole || sourceKey === "owner"
      ? ownerName ? `${ownerName}'s OpenWork apps` : "The owner's OpenWork apps"
      : names.get(sourceKey) ?? "A removed computer"
    const revokedBy = revokedAt && revokedByMemberId ? revokers.get(revokedByMemberId) ?? null : null
    return { key: sourceKey, label, scope: whole ? "whole_computer" : "sandbox", folders, writableFolders: writableFolders ?? [], revokedAt: revokedAt?.toISOString() ?? null, revokedBy }
  })
}

export async function updateComputerSource(viewer: Viewer, id: DenTypeId<"remoteDevice">, targets: SourceTargets, sourceKey: string, change: "revoke" | "restore") {
  const { organizationId, memberId } = viewer.actor
  const { ownerMemberId } = targets
  if ((viewer.kind === "member" || change === "restore") && ownerMemberId !== memberId) return null
  const d = RemoteDeviceTable
  const g = ComputerGrantTable
  return withDeadlockRetry(() => db.transaction(async (tx) => {
    const devices = await tx.select({ id: d.id }).from(d).where(and(
      inArray(d.id, targets.ids), eq(d.organizationId, organizationId), isNull(d.removedAt),
      ownerMemberId ? eq(d.ownerMemberId, ownerMemberId) : isNull(d.ownerMemberId),
    )).orderBy(asc(d.id)).for("update")
    if (!devices.some((device) => device.id === id)) return null
    const grants = await tx.select().from(g).where(and(
      eq(g.organizationId, organizationId), inArray(g.targetDeviceId, devices.map((device) => device.id)), eq(g.sourceKey, sourceKey),
    )).orderBy(asc(g.targetDeviceId)).for("update")
    if (!grants.length) return null
    const revoking = change === "revoke"
    const changed = grants.filter(({ revokedAt }) => revoking !== (revokedAt !== null))
    const now = new Date()
    const values = { revokedAt: revoking ? now : null, revokedByMemberId: revoking ? memberId : null }
    const changedIds = new Set(changed.map((grant) => grant.id))
    if (changed.length) await tx.update(g).set(values).where(and(eq(g.organizationId, organizationId), inArray(g.id, [...changedIds])))
    const names = await computerMemberNames(tx, organizationId, [...new Set(ownerMemberId ? [memberId, ownerMemberId] : [memberId])])
    const ownerName = ownerMemberId ? names.get(ownerMemberId) ?? null : null
    const [source] = await sourceViews(tx, viewer, ownerName, grants.map((grant) => changedIds.has(grant.id) ? { ...grant, ...values } : grant))
    if (!source) return null
    const who = (names.get(memberId) ?? "An organization member").slice(0, 100)
    for (const grant of changed) {
      await recordRemoteDeviceEvent(tx, {
        organizationId, deviceId: grant.targetDeviceId, type: revoking ? "computer_source_revoked" : "computer_source_restored", now,
        actor: "member", actorId: memberId, message: `${who} ${revoking ? "revoked" : "restored"} access for ${source.label.slice(0, 150)}`,
      })
    }
    return { source, grantIds: grants.map((grant) => grant.id), ownerMemberId }
  }))
}
