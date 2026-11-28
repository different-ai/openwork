import { computerState, decide, ownerWholeVmScope, projectComputer, refusal, signedInApp } from "@openwork/computers"
import { isExecutableVmProvider, type Computer, type ComputerAccessSetting, type ComputerAction, type ComputerAuthorizeResponse, type ComputerDecision, type ComputerListResponse, type ComputerPolicy, type ListedComputer } from "@openwork/types/den/computers"
import { and, eq, isNull, or } from "@openwork-ee/den-db/drizzle"
import { AutomationRunnerTable, RemoteDeviceTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { listMemberRemoteDeviceRows, readMemberRemoteDeviceRow, type RemoteDeviceActor } from "../remote-devices.js"
import { withDeadlockRetry } from "../utils/deadlock-retry.js"
import { recordAcceptedComputerWork } from "./activity.js"
import { incomingComputerWorkRefusal, loadComputerPolicy } from "./policy.js"
import { projectStoredComputer, replaceRegisteredVmAccess } from "./store.js"
import type { VerifiedComputerSource } from "./service.js"

type MemberComputer = Awaited<ReturnType<typeof listMemberRemoteDeviceRows>>[number]
type ComputerId = DenTypeId<"remoteDevice">

function isRegisteredVm(row: MemberComputer["row"]) {
  return row.kind === "vm" && row.source === "manual" && isExecutableVmProvider(row.provider)
}

const reachAction: ComputerAction = { type: "shell", command: "true" }

export function projectMemberComputer({ row, device }: MemberComputer) {
  return projectComputer({ ...device, ownerMemberId: row.ownerMemberId })
}

function reach(source: Computer | null, target: Computer, action: ComputerAction, policy: ComputerPolicy, capabilities: readonly string[] | null | undefined): ComputerDecision {
  if (source?.id === target.id) return decide(source, target, action, policy)
  return incomingComputerWorkRefusal(target, capabilities) ?? (source ? decide(source, target, action, policy) : refusal(target.kind === "registered_vm" ? "owner_app_only" : "source_not_allowed", target))
}

export function listedComputer(actor: RemoteDeviceActor, item: MemberComputer, policy: ComputerPolicy, source: Computer | null, capabilities = item.runner?.capabilities): ListedComputer {
  const { row, device } = item
  const computer = projectMemberComputer(item)
  const ownerSetting = row.ownerMemberId === actor.memberId && isRegisteredVm(row)
  const scope = ownerSetting ? ownerWholeVmScope(computer.id, policy) : null
  const access: ListedComputer["access"] = !ownerSetting ? null : scope
    ? { choice: "allow", scope: scope.surface, folders: scope.folders }
    : { choice: policy.owner.choice === null ? null : "off", folders: [] }
  return { ...computer, state: computerState(computer), lastSeenAt: device.lastSeenAt, access, reach: reach(source, computer, reachAction, policy, capabilities) }
}

export async function listMemberComputers(actor: RemoteDeviceActor): Promise<ComputerListResponse> {
  const devices = await listMemberRemoteDeviceRows(actor, { canManageShared: false })
  const source = signedInApp(actor.memberId)
  return { computers: await Promise.all(devices.map(async (item) =>
    listedComputer(actor, item, await loadComputerPolicy(actor.organizationId, item.row.id), source),
  )) }
}

export async function setMemberComputerAccess(actor: RemoteDeviceActor, id: ComputerId, setting: ComputerAccessSetting) {
  const item = await readMemberRemoteDeviceRow(actor, id)
  if (!item || item.row.ownerMemberId !== actor.memberId) return "computer_not_found"
  if (item.row.kind === "desktop") return "choose_on_that_computer"
  if (!isRegisteredVm(item.row)) return "not_configurable"
  await replaceRegisteredVmAccess(item.row, actor.memberId, setting)
  return listedComputer(actor, item, await loadComputerPolicy(actor.organizationId, item.row.id), signedInApp(actor.memberId))
}

export async function authorizeMemberComputer(actor: RemoteDeviceActor, id: ComputerId, action: ComputerAction, verifiedSource: VerifiedComputerSource | null = null): Promise<ComputerAuthorizeResponse | null> {
  const item = await readMemberRemoteDeviceRow(actor, id)
  if (!item) return null
  const d = RemoteDeviceTable
  return withDeadlockRetry(() => db.transaction(async (tx) => {
    const [row] = await tx.select().from(d).where(and(
      eq(d.id, id), eq(d.organizationId, actor.organizationId), isNull(d.removedAt), or(eq(d.ownerMemberId, actor.memberId), isNull(d.ownerMemberId)),
    )).limit(1).for("update")
    if (!row) return null
    const [sourceRow] = verifiedSource ? await tx.select().from(d).where(and(
      eq(d.id, verifiedSource.id), eq(d.organizationId, actor.organizationId), eq(d.ownerMemberId, actor.memberId), isNull(d.removedAt),
    )).limit(1).for("share") : []
    if (verifiedSource && !sourceRow) return null
    const source = sourceRow ? projectStoredComputer(sourceRow) : null
    const caller = source ?? signedInApp(actor.memberId)
    const policy = await loadComputerPolicy(actor.organizationId, row.id, tx)
    const [runner] = row.kind === "desktop" && row.ownerMemberId ? await tx
      .select({ capabilities: AutomationRunnerTable.capabilities }).from(AutomationRunnerTable).where(and(
        eq(AutomationRunnerTable.id, row.externalId), eq(AutomationRunnerTable.organization_id, actor.organizationId),
        eq(AutomationRunnerTable.owner_member_id, row.ownerMemberId),
      )).limit(1) : []
    const current = { ...item, row, device: { ...item.device, label: row.label } }
    const capabilities = runner?.capabilities ?? []
    const computer = listedComputer(actor, current, policy, caller, capabilities)
    const decision = reach(caller, computer, action, policy, capabilities)
    if (decision.outcome === "allow" && decision.route === "checked") {
      await recordAcceptedComputerWork(tx, { actor, deviceId: id, targetLabel: computer.label, action, scope: decision.scope, source, coalesce: true, now: new Date() })
    }
    return { decision, computer, connection: decision.outcome === "allow" && decision.scope?.surface === "whole_vm" && isRegisteredVm(row) ? { provider: row.provider, externalId: row.externalId } : null }
  }))
}
