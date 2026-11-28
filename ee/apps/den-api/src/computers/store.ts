import { and, asc, eq, gt, inArray, isNull, lte, or, sql, type SQL } from "@openwork-ee/den-db/drizzle"
import { AutomationRunnerTable, ComputerAccessTable, ComputerCommandTable, ComputerGrantTable, RemoteDeviceTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, isDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { computerActionForToolCall, decide, projectComputer } from "@openwork/computers"
import { COMPUTER_COMMAND_PICKUP_MS, COMPUTER_COMMAND_RETENTION_MS, COMPUTER_OWNER_WHOLE_VM_SOURCE_KEY, COMPUTER_SHELL_RUNNER_CAPABILITY, type ComputerAccessSetting, type ComputerAccessReport, type ComputerRunnerAccessResponse, type ComputerToolCall, type ComputerCommandAssignment, type ComputerCommandCompleteRequest, type ComputerGrantScope } from "@openwork/types/den/computers"
import { remoteDeviceAvailability } from "@openwork/types/den/remote-devices"
import { db } from "../db.js"
import { withPrimaryReads } from "../read-routing.js"
import { latestDeviceContact, syncDesktopsFromRunners, type RemoteDeviceActor } from "../remote-devices.js"
import { createSignalWaiter, onComputerCommandAvailable, signalComputerCommandAvailable } from "../remote-sessions/work-signal.js"
import { withDeadlockRetry } from "../utils/deadlock-retry.js"
import { recordAcceptedComputerWork } from "./activity.js"
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
    const [device] = await db.$primary.select({ device: RemoteDeviceTable, runnerSeenAt: AutomationRunnerTable.last_seen_at }).from(RemoteDeviceTable)
      .innerJoin(AutomationRunnerTable, eq(AutomationRunnerTable.id, RemoteDeviceTable.externalId))
      .where(and(
        eq(RemoteDeviceTable.organizationId, runner.organizationId), eq(RemoteDeviceTable.ownerMemberId, runner.memberId),
        eq(RemoteDeviceTable.kind, "desktop"), eq(RemoteDeviceTable.provider, "openwork_desktop"),
        eq(RemoteDeviceTable.externalId, runner.runnerId), isNull(RemoteDeviceTable.removedAt),
        eq(AutomationRunnerTable.organization_id, runner.organizationId), eq(AutomationRunnerTable.owner_member_id, runner.memberId),
      )).limit(1)
    return device ? { ...device.device, lastSeenAt: latestDeviceContact(device.device.lastSeenAt, device.runnerSeenAt) } : null
  }
  const device = await lookup()
  if (device || !sync) return device
  await withPrimaryReads(() => syncDesktopsFromRunners(runner, new Date()))
  return lookup()
}

export async function readComputerAccess(device: DeviceRow): Promise<ComputerRunnerAccessResponse> {
  const { organizationId, id } = device
  const policy = await loadComputerPolicy(organizationId, id)
  const g = ComputerGrantTable
  const grants = await db.$primary.select().from(g).where(and(eq(g.organizationId, organizationId), eq(g.targetDeviceId, id))).orderBy(asc(g.sourceKey))
  return {
    organizationAllows: policy.organization.allowed,
    choice: policy.owner.choice,
    grants: grants.map(({ sourceKey, folders, writableFolders, revokedAt }) => ({
      source: sourceKey === "workbot" || sourceKey === "owner" ? { kind: sourceKey } : { kind: "computer", id: sourceKey },
      folders, writableFolders: writableFolders ?? [], revokedAt: revokedAt?.toISOString() ?? null,
    })),
  }
}

export async function replaceComputerAccess(device: DeviceRow, reportedByRunnerId: string, report: ComputerAccessReport) {
  const grants = report.grants.flatMap(({ source, folders, writableFolders }) => source.kind === "owner" ? [] : [{
    sourceKey: source.kind === "computer" ? source.id : source.kind, folders, writableFolders: writableFolders ?? [],
  }])
  return storeComputerAccess(device, reportedByRunnerId, report.choice, grants, {
    sources: report.grants.flatMap(({ source }) => source.kind === "computer" ? [source.id] : []),
  })
}

export async function replaceRegisteredVmAccess(device: DeviceRow, ownerMemberId: string, setting: ComputerAccessSetting) {
  return storeComputerAccess(device, ownerMemberId, setting.choice, setting.choice === "allow"
    ? [{ sourceKey: COMPUTER_OWNER_WHOLE_VM_SOURCE_KEY, folders: setting.folders, writableFolders: [] }]
    : [], { renewWholeComputer: setting.choice === "allow" })
}

async function storeComputerAccess(device: DeviceRow, reportedByRunnerId: string, ownerChoice: ComputerAccessReport["choice"],
  grants: { sourceKey: string; folders: string[]; writableFolders: string[] }[], options: { sources?: string[]; renewWholeComputer?: boolean },
) {
  const { organizationId, id: deviceId } = device
  return withDeadlockRetry(() => db.transaction(async (tx) => {
    if (options.sources?.length) {
      const ids = options.sources.filter((id): id is DenTypeId<"remoteDevice"> => id !== deviceId && isDenTypeId("remoteDevice", id))
      if (!device.ownerMemberId || ids.length !== options.sources.length) return false
      const d = RemoteDeviceTable
      const eligible = await tx.select({ id: d.id }).from(d).where(and(
        eq(d.organizationId, organizationId), eq(d.ownerMemberId, device.ownerMemberId), eq(d.kind, "desktop"),
        eq(d.provider, "openwork_desktop"), isNull(d.removedAt), inArray(d.id, ids),
      )).for("share")
      if (eligible.length !== ids.length) return false
    }
    const choice = { ownerChoice, reportedByRunnerId }
    await tx.insert(ComputerAccessTable).values({ id: createDenTypeId("computerAccess"), organizationId, deviceId, ...choice })
      .onDuplicateKeyUpdate({ set: choice })
    const g = ComputerGrantTable
    await tx.delete(g).where(and(
      eq(g.organizationId, organizationId), eq(g.targetDeviceId, deviceId), isNull(g.revokedAt),
      grants.length ? sql`not (${inArray(g.sourceKey, grants.map(({ sourceKey }) => sourceKey))})` : undefined,
    ))
    for (const { sourceKey, folders, writableFolders } of grants) {
      const renew = options.renewWholeComputer && sourceKey === COMPUTER_OWNER_WHOLE_VM_SOURCE_KEY
      const cleared = renew ? { revokedAt: null, revokedByMemberId: null } : {}
      await tx.insert(g).values({ id: createDenTypeId("computerGrant"), organizationId, targetDeviceId: deviceId, sourceKey, folders, writableFolders })
        .onDuplicateKeyUpdate({ set: { folders, writableFolders, ...cleared } })
    }
    return true
  }))
}

export async function pruneComputerCommands(scope?: SQL, now = Date.now()) {
  const cutoff = new Date(now - COMPUTER_COMMAND_RETENTION_MS)
  await db.delete(ComputerCommandTable).where(and(scope, or(
    lte(ComputerCommandTable.completedAt, cutoff),
    and(isNull(ComputerCommandTable.completedAt), or(lte(ComputerCommandTable.expiresAt, cutoff), and(
      eq(ComputerCommandTable.status, "pending"), lte(ComputerCommandTable.createdAt, new Date(cutoff.getTime() - COMPUTER_COMMAND_PICKUP_MS)),
    ))),
  ))).limit(100)
}

export async function enqueueComputerCommand(input: {
  organizationId: DenTypeId<"organization">
  createdByUserId: DenTypeId<"user">
  sourceDeviceId: DenTypeId<"remoteDevice">
  targetDeviceId: DenTypeId<"remoteDevice">
  call: ComputerToolCall
  scope: ComputerGrantScope
}) {
  await pruneComputerCommands(eq(ComputerCommandTable.organizationId, input.organizationId))
  const now = Date.now()
  const action = computerActionForToolCall(input.call)
  const timeoutMs = action.type === "shell" ? action.timeoutMs : undefined
  const command = { ...input, id: createDenTypeId("computerCommand"), action, createdAt: new Date(now), expiresAt: new Date(now + 120_000 + (timeoutMs ?? 30_000)) }
  await db.insert(ComputerCommandTable).values(command)
  signalComputerCommandAvailable(input.targetDeviceId)
  return command
}

function commandsForCaller(organizationId: DenTypeId<"organization">, userId: DenTypeId<"user">) {
  return and(eq(ComputerCommandTable.organizationId, organizationId), eq(ComputerCommandTable.createdByUserId, userId))
}

export async function pruneCallerComputerCommands(organizationId: DenTypeId<"organization">, userId: DenTypeId<"user">) {
  await pruneComputerCommands(commandsForCaller(organizationId, userId))
}

export async function readComputerCommand(organizationId: DenTypeId<"organization">, userId: DenTypeId<"user">, id: DenTypeId<"computerCommand">, desktopId: DenTypeId<"remoteDevice"> | null) {
  const cutoff = new Date(Date.now() - COMPUTER_COMMAND_RETENTION_MS)
  const c = ComputerCommandTable
  const d = RemoteDeviceTable
  const sources = desktopId ? eq(c.sourceDeviceId, desktopId) : inArray(c.sourceDeviceId, db.$primary.select({ id: d.id }).from(d).where(and(
    eq(d.organizationId, organizationId), eq(d.provider, "workbot"),
  )))
  const [command] = await db.$primary.select().from(c).where(and(
    eq(c.id, id), commandsForCaller(organizationId, userId), sources,
    or(gt(c.completedAt, cutoff), and(isNull(c.completedAt), gt(c.expiresAt, cutoff), or(
      sql`${c.status} <> 'pending'`, gt(c.createdAt, new Date(cutoff.getTime() - COMPUTER_COMMAND_PICKUP_MS)),
    ))),
  )).limit(1)
  return command ?? null
}

export function pickupDeadline(command: ComputerCommand) {
  return Math.min(command.createdAt.getTime() + COMPUTER_COMMAND_PICKUP_MS, command.expiresAt.getTime())
}

export async function pendingComputerCommands(organizationId: DenTypeId<"organization">, deviceId: DenTypeId<"remoteDevice">, waitMs: number, signal: AbortSignal) {
  const c = ComputerCommandTable
  const target = and(eq(c.organizationId, organizationId), eq(c.targetDeviceId, deviceId))
  const deadline = Date.now() + waitMs
  const waiter = createSignalWaiter((wake) => onComputerCommandAvailable(deviceId, wake))
  try {
    await pruneComputerCommands(target)
    for (;;) {
      const now = Date.now()
      const rows = await db.$primary.select({ id: c.id, expiresAt: c.expiresAt }).from(c).where(and(
        target, eq(c.status, "pending"), gt(c.expiresAt, new Date(now)), gt(c.createdAt, new Date(now - COMPUTER_COMMAND_PICKUP_MS)),
      )).orderBy(asc(c.createdAt), asc(c.id)).limit(20)
      const remaining = deadline - Date.now()
      if (rows.length || remaining <= 0 || signal.aborted) return rows.map(({ id, expiresAt }) => ({ id, expiresAt: expiresAt.toISOString() }))
      await waiter.wait(Math.min(remaining, 2_000), signal)
    }
  } finally {
    waiter.dispose()
  }
}

async function commandForUpdate(tx: Transaction, device: DeviceRow, id: DenTypeId<"computerCommand">) {
  const [command] = await tx.select().from(ComputerCommandTable).where(and(
    eq(ComputerCommandTable.id, id), eq(ComputerCommandTable.organizationId, device.organizationId), eq(ComputerCommandTable.targetDeviceId, device.id),
  )).limit(1).for("update")
  return command
}

export async function claimComputerCommand(runner: ComputerRunner, device: DeviceRow, id: DenTypeId<"computerCommand">): Promise<ComputerCommandAssignment | "command_not_found" | "command_conflict" | "command_refused"> {
  return withDeadlockRetry(() => db.transaction(async (tx) => {
    const command = await commandForUpdate(tx, device, id)
    if (!command) return "command_not_found"
    if (command.status !== "pending") return "command_conflict"
    const deadline = pickupDeadline(command)
    const expire = async (): Promise<"command_conflict"> => {
      await tx.update(ComputerCommandTable).set({ status: "expired", completedAt: new Date(deadline) }).where(eq(ComputerCommandTable.id, id))
      return "command_conflict"
    }
    if (Date.now() >= deadline) return expire()
    const [registration] = await tx.select({ capabilities: AutomationRunnerTable.capabilities }).from(AutomationRunnerTable).where(and(
      eq(AutomationRunnerTable.id, runner.runnerId), eq(AutomationRunnerTable.organization_id, runner.organizationId),
      eq(AutomationRunnerTable.owner_member_id, runner.memberId),
    )).limit(1).for("share")
    if (!registration?.capabilities?.includes(COMPUTER_SHELL_RUNNER_CAPABILITY)) return "command_conflict"
    const d = RemoteDeviceTable
    const rows = await tx.select().from(d).where(and(
      inArray(d.id, [command.sourceDeviceId, command.targetDeviceId]), eq(d.organizationId, runner.organizationId), isNull(d.removedAt),
    )).orderBy(asc(d.id)).for("share")
    const sourceRow = rows.find((row) => row.id === command.sourceDeviceId)
    const targetRow = rows.find((row) => row.id === device.id && row.ownerMemberId === runner.memberId && row.externalId === runner.runnerId)
    if (!sourceRow || !targetRow) return "command_conflict"
    const source = projectStoredComputer(sourceRow)
    const target = projectStoredComputer(targetRow)
    const action = command.call ? computerActionForToolCall(command.call) : command.action
    const decision = decide(source, target, action, await loadComputerPolicy(runner.organizationId, device.id, tx))
    const now = new Date()
    if (now.getTime() >= deadline) return expire()
    if (decision.outcome === "refuse") {
      await tx.update(ComputerCommandTable).set({ status: "refused", refusedLayer: decision.layer, errorCode: decision.code, completedAt: now })
        .where(eq(ComputerCommandTable.id, id))
      return "command_refused"
    }
    if (decision.route !== "checked" || decision.scope.surface !== "sandbox") return "command_conflict"
    await tx.update(ComputerCommandTable).set({ status: "claimed", claimedByRunnerId: runner.runnerId, claimedAt: now, scope: decision.scope })
      .where(eq(ComputerCommandTable.id, id))
    await recordAcceptedComputerWork(tx, { actor: runner, deviceId: device.id, targetLabel: target.label, action, scope: decision.scope, source, now })
    return { id, source, action, call: command.call ?? undefined, scope: decision.scope, expiresAt: command.expiresAt.toISOString() }
  }))
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
    await tx.update(ComputerCommandTable).set({ ...completionFields(body), completedAt: new Date() }).where(eq(ComputerCommandTable.id, id))
    return body.status
  })
}
