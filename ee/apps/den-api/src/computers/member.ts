import { computerState, decide, ownerWholeVmScope, projectComputer, signedInApp } from "@openwork/computers"
import type { ComputerAccessSetting, ComputerAction, ComputerAuthorizeResponse, ComputerListResponse, ComputerPolicy, ListedComputer } from "@openwork/types/den/computers"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { listMemberRemoteDeviceRows, readMemberRemoteDeviceRow, type RemoteDeviceActor } from "../remote-devices.js"
import { loadComputerPolicy } from "./policy.js"
import { replaceRegisteredVmAccess } from "./store.js"

type MemberComputer = Awaited<ReturnType<typeof listMemberRemoteDeviceRows>>[number]
type ComputerId = DenTypeId<"remoteDevice">

function isRegisteredVm(row: MemberComputer["row"]) {
  return row.kind === "vm" && row.source === "manual"
}

function listedComputer(actor: RemoteDeviceActor, { row, device }: Pick<MemberComputer, "row" | "device">, policy: ComputerPolicy): ListedComputer {
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
    reach: decide(signedInApp(actor.memberId), computer, { type: "shell", command: "true" }, policy),
  }
}

export async function listMemberComputers(actor: RemoteDeviceActor): Promise<ComputerListResponse> {
  const devices = await listMemberRemoteDeviceRows(actor, { canManageShared: false })
  return { computers: await Promise.all(devices.map(async (item) => listedComputer(actor, item, await loadComputerPolicy(actor.organizationId, item.row.id)))) }
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
  const policy = await db.transaction((tx) => loadComputerPolicy(actor.organizationId, item.row.id, tx))
  const computer = listedComputer(actor, item, policy)
  const decision = decide(signedInApp(actor.memberId), computer, action, policy)
  const { provider, externalId } = item.row
  return { decision, computer, connection: decision.outcome === "allow" && decision.scope?.surface === "whole_vm" && isRegisteredVm(item.row) ? { provider, externalId } : null }
}
