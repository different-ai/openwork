import { computerActionForToolCall, createComputers, notPickedUpMessage, refusal } from "@openwork/computers"
import { COMPUTER_REFUSAL_CODES, type Computer, type ComputerExecution, type ComputerRefusal, type ComputerSourceListResponse, type ComputerToolCall } from "@openwork/types/den/computers"
import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { RemoteDeviceTable } from "@openwork-ee/den-db/schema"
import { isDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { db } from "../db.js"
import { withPrimaryReads } from "../read-routing.js"
import { listMemberRemoteDeviceRows, readMemberRemoteDeviceRow, type RemoteDeviceActor } from "../remote-devices.js"
import { createSignalWaiter, onComputerCommandUpdated } from "../remote-sessions/work-signal.js"
import { listedComputer, projectMemberComputer } from "./member.js"
import { incomingComputerWorkRefusal, loadComputerPolicy } from "./policy.js"
import { enqueueComputerCommand, pickupDeadline, pruneCallerComputerCommands, readComputerCommand, type ComputerCommand } from "./store.js"

const refusalCodeSchema = z.enum(COMPUTER_REFUSAL_CODES)

export type VerifiedComputerSource = { id: DenTypeId<"remoteDevice">; computer: Computer }
export type ComputerCaller = RemoteDeviceActor & { userId: DenTypeId<"user">; source: VerifiedComputerSource | null }

export async function listComputers(caller: ComputerCaller): Promise<ComputerSourceListResponse> {
  const { source } = caller
  const devices = await listMemberRemoteDeviceRows(caller, { canManageShared: false })
  const computers = await Promise.all(devices.map(async (item) => listedComputer(
    caller, item, await loadComputerPolicy(caller.organizationId, item.row.id), source?.computer ?? null,
  )))
  return { self: source?.computer ?? null, computers }
}

function refusedExecution({ layer, code, message, changeableBy }: ComputerRefusal): ComputerExecution {
  return { state: "refused", layer, code, message, changeableBy }
}

async function isPrivateDesktop(caller: ComputerCaller, id: DenTypeId<"remoteDevice">) {
  const d = RemoteDeviceTable
  const [desktop] = await db.$primary.select({ id: d.id }).from(d).where(and(
    eq(d.id, id), eq(d.organizationId, caller.organizationId), eq(d.kind, "desktop"), eq(d.provider, "openwork_desktop"), isNull(d.removedAt),
  )).limit(1)
  return desktop !== undefined
}

export async function runComputerTool(caller: ComputerCaller, computerId: string, call: ComputerToolCall, waitMs: number, signal?: AbortSignal): Promise<ComputerExecution | { error: string; message: string; retryable: false }> {
  const { source } = caller
  const desktop = source?.computer.kind === "member_machine"
  const target = isDenTypeId("remoteDevice", computerId) ? await withPrimaryReads(() => readMemberRemoteDeviceRow(caller, computerId)) : null
  if (!target) {
    if (desktop && isDenTypeId("remoteDevice", computerId) && await isPrivateDesktop(caller, computerId)) {
      return refusedExecution(refusal("not_owner", { label: "That computer" }))
    }
    return { error: "unknown_computer", message: "That computer isn't available to your account.", retryable: false }
  }
  const computer = projectMemberComputer(target)
  if (source?.id === computerId) return { state: "unsupported", message: "Use this chat's own tools to work on this computer." }
  if (computer.kind === "registered_vm") {
    if (desktop) return { state: "unsupported", message: "Use your OpenWork app to reach this computer directly." }
    return refusedExecution(refusal("owner_app_only", computer))
  }
  const unavailable = incomingComputerWorkRefusal(computer, target.runner?.capabilities)
  if (unavailable) return refusedExecution(unavailable)
  if (!source) return { error: "source_unverified", message: "This tool only accepts new commands from a Workbot chat.", retryable: false }
  const policy = await loadComputerPolicy(caller.organizationId, target.row.id)
  return createComputers({
    self: source.computer,
    computers: [computer],
    policyFor: () => policy,
    lastSeenAt: () => target.device.lastSeenAt,
    now: Date.now,
    async run({ scope }) {
      const command = await enqueueComputerCommand({
        organizationId: caller.organizationId, createdByUserId: caller.userId,
        sourceDeviceId: source.id, targetDeviceId: target.row.id, call, scope,
      })
      const result = await followComputerCommand(caller, command.id, waitMs, signal)
      return result ?? { state: "failed", id: command.id, error: { code: "unknown_command", message: "That computer command could not be found." } }
    },
  }).execute(computer, computerActionForToolCall(call))
}

async function commandExecution(caller: ComputerCaller, command: ComputerCommand): Promise<ComputerExecution> {
  const { id, status } = command
  if (status === "done") return { state: "done", id, exitCode: command.exitCode ?? 0, output: command.output ?? "", truncated: command.truncated ?? false }
  const failed = (code = "command_failed", message = "The computer could not finish this command."): ComputerExecution => ({ state: "failed", id, error: { code, message } })
  if (status === "failed") return failed(command.errorCode ?? undefined, command.errorMessage ?? undefined)
  const target = async () => (await withPrimaryReads(() => readMemberRemoteDeviceRow(caller, command.targetDeviceId)))?.device
  if (status === "refused") {
    const parsed = refusalCodeSchema.safeParse(command.errorCode)
    return parsed.success ? refusedExecution(refusal(parsed.data, await target() ?? { label: "That computer" })) : failed()
  }
  const now = Date.now()
  if (command.claimedAt && command.expiresAt.getTime() <= now) {
    const label = (await target())?.label ?? "That computer"
    return { state: "unknown", id, message: `${label} started handling this command but hasn't reported back. It may have run. Ask again later with this command's ID, or check on that computer before running it again.` }
  }
  if (status === "expired" || (status === "pending" && pickupDeadline(command) <= now)) {
    const device = await target()
    return failed("not_picked_up", notPickedUpMessage(device?.label ?? "That computer", device?.lastSeenAt ?? null, now))
  }
  return { state: "running", id, expiresAt: command.expiresAt.toISOString() }
}

export async function followComputerCommand(caller: ComputerCaller, id: string, waitMs: number, signal?: AbortSignal): Promise<ComputerExecution | null> {
  if (!isDenTypeId("computerCommand", id)) return null
  const desktopId = caller.source?.computer.kind === "member_machine" ? caller.source.id : null
  const deadline = Date.now() + waitMs
  await pruneCallerComputerCommands(caller.organizationId, caller.userId)
  const waiter = createSignalWaiter((wake) => onComputerCommandUpdated(id, wake))
  try {
    for (;;) {
      const command = await readComputerCommand(caller.organizationId, caller.userId, id, desktopId)
      if (!command) return null
      const result = await commandExecution(caller, command)
      const remaining = deadline - Date.now()
      if (result.state !== "running" || remaining <= 0 || signal?.aborted) return result
      const timeout = command.status === "pending" ? pickupDeadline(command) : command.expiresAt.getTime()
      await waiter.wait(Math.min(remaining, 500, Math.max(1, timeout - Date.now())), signal)
    }
  } finally {
    waiter.dispose()
  }
}
