import { computerState, decide, ownerWholeVmScope, projectComputer, signedInApp } from "@openwork/computers"
import type { ComputerAccessSetting, ComputerAction, ComputerAuthorizeResponse, ComputerListResponse, ComputerPolicy, ListedComputer } from "@openwork/types/den/computers"
import { and, eq, isNull, or } from "@openwork-ee/den-db/drizzle"
import { AutomationRunnerTable, RemoteDeviceTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { listMemberRemoteDeviceRows, readMemberRemoteDeviceRow, type RemoteDeviceActor } from "../remote-devices.js"
import { withDeadlockRetry } from "../utils/deadlock-retry.js"
import { recordAcceptedComputerWork } from "./activity.js"
import { incomingComputerWorkRefusal, loadComputerPolicy } from "./policy.js"
import { replaceRegisteredVmAccess } from "./store.js"

type MemberComputer = Awaited<ReturnType<typeof listMemberRemoteDeviceRows>>[number]
type ComputerId = DenTypeId<"remoteDevice">

function isRegisteredVm(row: MemberComputer["row"]) {
  return row.kind === "vm" && row.source === "manual"
}

const reachAction: ComputerAction = { type: "shell", command: "true" }

type ComputerView = Pick<MemberComputer, "row" | "device"> & { capabilities?: readonly string[] | null }

function listedComputer(actor: RemoteDeviceActor, { row, device, capabilities }: ComputerView, policy: ComputerPolicy): ListedComputer {
  const computer = projectComputer({ ...device, ownerMemberId: row.ownerMemberId })
  const ownerSetting = row.ownerMemberId === actor.memberId && isRegisteredVm(row)
  const scope = ownerSetting ? ownerWholeVmScope(computer.id, policy) : null
  const access = !ownerSetting ? null : scope
    ? { choice: "allow" as const, scope: scope.surface, folders: scope.folders }
    : { choice: policy.owner.choice === null ? null : "off" as const, folders: [] }
  return {
    ...computer,
    state: computerState(computer),
    lastSeenAt: device.lastSeenAt,
    access,
    reach: incomingComputerWorkRefusal(computer, capabilities) ?? decide(signedInApp(actor.memberId), computer, reachAction, policy),
  }
}

export async function listMemberComputers(actor: RemoteDeviceActor): Promise<ComputerListResponse> {
  const devices = await listMemberRemoteDeviceRows(actor, { canManageShared: false })
  return { computers: await Promise.all(devices.map(async ({ row, device, runner }) =>
    listedComputer(actor, { row, device, capabilities: runner?.capabilities }, await loadComputerPolicy(actor.organizationId, row.id)),
  )) }
}

export async function setMemberComputerAccess(actor: RemoteDeviceActor, id: ComputerId, setting: ComputerAccessSetting) {
  const item = await readMemberRemoteDeviceRow(actor, id)
  if (!item || item.row.ownerMemberId !== actor.memberId) return "computer_not_found"
  if (item.row.kind === "desktop") return "choose_on_that_computer"
  if (!isRegisteredVm(item.row)) return "not_configurable"
  await replaceRegisteredVmAccess(item.row, actor.memberId, setting)
  return listedComputer(actor, item, await loadComputerPolicy(actor.organizationId, item.row.id))
}

export async function authorizeMemberComputer(actor: RemoteDeviceActor, id: ComputerId, action: ComputerAction): Promise<ComputerAuthorizeResponse | null> {
  const item = await readMemberRemoteDeviceRow(actor, id)
  if (!item) return null
  const { row } = item
  const { provider, externalId } = row
  const d = RemoteDeviceTable
  return withDeadlockRetry(() => db.transaction(async (tx) => {
    const [visible] = await tx.select({ id: d.id }).from(d).where(and(
      eq(d.id, id), eq(d.organizationId, actor.organizationId), isNull(d.removedAt), or(eq(d.ownerMemberId, actor.memberId), isNull(d.ownerMemberId)),
    )).limit(1).for("update")
    if (!visible) return null
    const policy = await loadComputerPolicy(actor.organizationId, row.id, tx)
    const [runner] = row.kind === "desktop" && row.ownerMemberId ? await tx
      .select({ capabilities: AutomationRunnerTable.capabilities }).from(AutomationRunnerTable).where(and(
        eq(AutomationRunnerTable.id, externalId), eq(AutomationRunnerTable.organization_id, actor.organizationId),
        eq(AutomationRunnerTable.owner_member_id, row.ownerMemberId),
      )).limit(1) : []
    const computer = listedComputer(actor, { ...item, capabilities: runner?.capabilities }, policy)
    const decision = incomingComputerWorkRefusal(computer, runner?.capabilities) ?? decide(signedInApp(actor.memberId), computer, action, policy)
    if (decision.outcome === "allow" && decision.route === "checked") {
      await recordAcceptedComputerWork(tx, { actor, deviceId: id, action, scope: decision.scope, source: "owner_app", now: new Date() })
    }
    return { decision, computer, connection: decision.outcome === "allow" && decision.scope?.surface === "whole_vm" && isRegisteredVm(row) ? { provider, externalId } : null }
  }))
}
