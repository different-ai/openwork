import { and, asc, eq, gt, inArray, isNull, lt, or } from "@openwork-ee/den-db/drizzle"
import { AutomationRunnerTable, ComputerAccessTable, ComputerCommandTable, ComputerGrantTable, RemoteDeviceTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { decide, projectComputer } from "@openwork/computers"
import { COMPUTER_SHELL_RUNNER_CAPABILITY, type ComputerAccessReport, type ComputerAction, type ComputerCommandAssignment, type ComputerCommandCompleteRequest, type ComputerGrantScope } from "@openwork/types/den/computers"
import { remoteDeviceAvailability } from "@openwork/types/den/remote-devices"
import { db } from "../db.js"
import { syncDesktopsFromRunners, type RemoteDeviceActor } from "../remote-devices.js"
import { loadComputerPolicy } from "./policy.js"

export type ComputerCommand = typeof ComputerCommandTable.$inferSelect
type DeviceRow = typeof RemoteDeviceTable.$inferSelect
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type ComputerRunner = RemoteDeviceActor & { runnerId: string }

export function projectStoredComputer(row: DeviceRow) {
  return projectComputer({ ...row, availability: remoteDeviceAvailability({ ...row, now: Date.now(), lastSeenAt: row.lastSeenAt?.getTime() ?? null }) })
}

export async function runnerComputer(runner: ComputerRunner, sync = false) {
  const lookup = async () => {
    const [device] = await db.$primary.select({ device: RemoteDeviceTable }).from(RemoteDeviceTable)
      .innerJoin(AutomationRunnerTable, eq(AutomationRunnerTable.id, RemoteDeviceTable.externalId))
      .where(and(
        eq(RemoteDeviceTable.organizationId, runner.organizationId), eq(RemoteDeviceTable.ownerMemberId, runner.memberId),
        eq(RemoteDeviceTable.kind, "desktop"), eq(RemoteDeviceTable.provider, "openwork_desktop"),
        eq(RemoteDeviceTable.externalId, runner.runnerId), isNull(RemoteDeviceTable.removedAt),
        eq(AutomationRunnerTable.organization_id, runner.organizationId), eq(AutomationRunnerTable.owner_member_id, runner.memberId),
      )).limit(1)
    return device?.device ?? null
  }
  const device = await lookup()
  if (device || !sync) return device
  await syncDesktopsFromRunners(runner, new Date())
  return lookup()
}

export async function replaceComputerAccess(device: DeviceRow, reportedByRunnerId: string, report: ComputerAccessReport) {
  const { organizationId, id: deviceId } = device
  await db.transaction(async (tx) => {
    const choice = { ownerChoice: report.choice, reportedByRunnerId }
    await tx.insert(ComputerAccessTable).values({ id: createDenTypeId("computerAccess"), organizationId, deviceId, ...choice })
      .onDuplicateKeyUpdate({ set: choice })
    await tx.delete(ComputerGrantTable).where(and(eq(ComputerGrantTable.organizationId, organizationId), eq(ComputerGrantTable.targetDeviceId, deviceId)))
    if (report.grants.length > 0) {
      await tx.insert(ComputerGrantTable).values(report.grants.map(({ source, folders }) => ({
        id: createDenTypeId("computerGrant"), organizationId, targetDeviceId: deviceId,
        sourceKey: source.kind === "computer" ? source.id : source.kind, folders,
      })))
    }
  })
}

export async function enqueueComputerCommand(input: {
  organizationId: DenTypeId<"organization">
  createdByUserId: DenTypeId<"user">
  sourceDeviceId: DenTypeId<"remoteDevice">
  targetDeviceId: DenTypeId<"remoteDevice">
  action: ComputerAction
  scope: ComputerGrantScope
}) {
  const now = Date.now()
  const cutoff = new Date(now - 24 * 60 * 60_000)
  const timeoutMs = input.action.type === "shell" ? input.action.timeoutMs : undefined
  const command = { ...input, id: createDenTypeId("computerCommand"), expiresAt: new Date(now + 120_000 + (timeoutMs ?? 30_000)) }
  await db.delete(ComputerCommandTable).where(and(
    eq(ComputerCommandTable.organizationId, input.organizationId),
    or(lt(ComputerCommandTable.completedAt, cutoff), and(
      inArray(ComputerCommandTable.status, ["pending", "claimed", "expired"]), lt(ComputerCommandTable.expiresAt, cutoff),
    )),
  )).limit(100)
  await db.insert(ComputerCommandTable).values(command)
  return command
}

export async function readComputerCommand(organizationId: DenTypeId<"organization">, userId: DenTypeId<"user">, id: DenTypeId<"computerCommand">) {
  const [command] = await db.$primary.select().from(ComputerCommandTable).where(and(
    eq(ComputerCommandTable.id, id), eq(ComputerCommandTable.organizationId, organizationId), eq(ComputerCommandTable.createdByUserId, userId),
  )).limit(1)
  return command ?? null
}

export async function pendingComputerCommands(organizationId: DenTypeId<"organization">, deviceId: DenTypeId<"remoteDevice">) {
  const rows = await db.$primary.select({ id: ComputerCommandTable.id, expiresAt: ComputerCommandTable.expiresAt }).from(ComputerCommandTable).where(and(
    eq(ComputerCommandTable.organizationId, organizationId), eq(ComputerCommandTable.targetDeviceId, deviceId),
    eq(ComputerCommandTable.status, "pending"), gt(ComputerCommandTable.expiresAt, new Date()),
  )).orderBy(asc(ComputerCommandTable.createdAt), asc(ComputerCommandTable.id)).limit(20)
  return rows.map(({ id, expiresAt }) => ({ id, expiresAt: expiresAt.toISOString() }))
}

async function commandForUpdate(tx: Transaction, device: DeviceRow, id: DenTypeId<"computerCommand">) {
  const [command] = await tx.select().from(ComputerCommandTable).where(and(
    eq(ComputerCommandTable.id, id), eq(ComputerCommandTable.organizationId, device.organizationId), eq(ComputerCommandTable.targetDeviceId, device.id),
  )).limit(1).for("update")
  return command
}

export async function claimComputerCommand(runner: ComputerRunner, device: DeviceRow, id: DenTypeId<"computerCommand">): Promise<ComputerCommandAssignment | "command_not_found" | "command_conflict" | "command_refused"> {
  return db.transaction(async (tx) => {
    const command = await commandForUpdate(tx, device, id)
    if (!command) return "command_not_found"
    if (command.status !== "pending" || command.expiresAt.getTime() <= Date.now()) return "command_conflict"
    const [registration] = await tx.select({ capabilities: AutomationRunnerTable.capabilities }).from(AutomationRunnerTable).where(and(
      eq(AutomationRunnerTable.id, runner.runnerId), eq(AutomationRunnerTable.organization_id, runner.organizationId),
      eq(AutomationRunnerTable.owner_member_id, runner.memberId),
    )).limit(1).for("share")
    if (!registration?.capabilities?.includes(COMPUTER_SHELL_RUNNER_CAPABILITY)) return "command_conflict"
    const [sourceRow] = await tx.select().from(RemoteDeviceTable).where(and(
      eq(RemoteDeviceTable.id, command.sourceDeviceId), eq(RemoteDeviceTable.organizationId, runner.organizationId),
      eq(RemoteDeviceTable.provider, "workbot"), isNull(RemoteDeviceTable.removedAt),
    )).limit(1).for("share")
    if (!sourceRow) return "command_conflict"
    const source = projectStoredComputer(sourceRow)
    const decision = decide(source, projectStoredComputer(device), command.action, await loadComputerPolicy(runner.organizationId, device.id, tx))
    const now = new Date()
    if (command.expiresAt <= now) return "command_conflict"
    if (decision.outcome === "refuse") {
      await tx.update(ComputerCommandTable).set({ status: "refused", refusedLayer: decision.layer, errorCode: decision.code, completedAt: now })
        .where(eq(ComputerCommandTable.id, id))
      return "command_refused"
    }
    if (decision.route !== "checked") return "command_conflict"
    await tx.update(ComputerCommandTable).set({ status: "claimed", claimedByRunnerId: runner.runnerId, claimedAt: now, scope: decision.scope })
      .where(eq(ComputerCommandTable.id, id))
    return { id, source, action: command.action, scope: decision.scope, expiresAt: command.expiresAt.toISOString() }
  })
}

function completionFields(body: ComputerCommandCompleteRequest) {
  switch (body.status) {
    case "done": return { status: body.status, exitCode: body.exitCode, output: body.output, truncated: body.truncated }
    case "failed": return { status: body.status, errorCode: body.error.code, errorMessage: body.error.message }
    case "refused": return { status: body.status, refusedLayer: body.layer, errorCode: body.code }
  }
}

function sameCompletion(command: ComputerCommand, body: ComputerCommandCompleteRequest): boolean {
  if (command.status !== body.status) return false
  switch (body.status) {
    case "done": return command.exitCode === body.exitCode && command.output === body.output && command.truncated === body.truncated
    case "failed": return command.errorCode === body.error.code && command.errorMessage === body.error.message
    case "refused": return command.refusedLayer === body.layer && command.errorCode === body.code
  }
}

export async function completeComputerCommand(runner: ComputerRunner, device: DeviceRow, id: DenTypeId<"computerCommand">, body: ComputerCommandCompleteRequest) {
  return db.transaction(async (tx) => {
    const command = await commandForUpdate(tx, device, id)
    if (!command) return "command_not_found"
    if (command.claimedByRunnerId !== runner.runnerId) return "command_conflict"
    if (command.status !== "claimed") return sameCompletion(command, body) ? body.status : "command_conflict"
    const now = new Date()
    if (command.expiresAt <= now) return "command_conflict"
    await tx.update(ComputerCommandTable).set({ ...completionFields(body), completedAt: now }).where(eq(ComputerCommandTable.id, id))
    return body.status
  })
}
