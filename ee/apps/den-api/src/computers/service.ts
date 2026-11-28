import { createComputers, decide, projectComputer, refusal } from "@openwork/computers"
import { COMPUTER_REFUSAL_CODES, type ComputerAction, type ComputerExecution, type ComputerRefusal } from "@openwork/types/den/computers"
import { isDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { listMemberRemoteDeviceRows } from "../remote-devices.js"
import { createSignalWaiter, onComputerCommandUpdated } from "../remote-sessions/work-signal.js"
import type { CapabilityRegistryContext } from "../mcp/capability-registry.js"
import { incomingComputerWorkRefusal, loadComputerPolicy } from "./policy.js"
import { resolveComputerSource } from "./source.js"
import { enqueueComputerCommand, pruneCallerComputerCommands, readComputerCommand, type ComputerCommand } from "./store.js"

const refusalCodeSchema = z.enum(COMPUTER_REFUSAL_CODES)

type Caller = Pick<CapabilityRegistryContext, "organizationId" | "principal"> & { memberId: DenTypeId<"member"> }

async function memberComputers(caller: Caller) {
  const actor = { organizationId: caller.organizationId, memberId: caller.memberId }
  const devices = await listMemberRemoteDeviceRows(actor, { canManageShared: false })
  const source = await resolveComputerSource(caller.principal, actor, devices)
  return {
    source: source ? { id: source.row.id, computer: projectComputer({ ...source.device, ownerMemberId: source.row.ownerMemberId }) } : null,
    computers: devices.map(({ row, device, runner }) => {
      const computer = projectComputer({ ...device, ownerMemberId: row.ownerMemberId })
      return { id: row.id, computer, unavailable: incomingComputerWorkRefusal(computer, runner?.capabilities) }
    }),
  }
}

export async function listComputers(caller: Caller) {
  const { source, computers } = await memberComputers(caller)
  const items = await Promise.all(computers.map(async ({ id, computer, unavailable }) => {
    if (source?.id === id) return { ...computer, reach: { outcome: "allow", route: "direct", scope: null } }
    const reach = unavailable ?? (source
      ? decide(source.computer, computer, { type: "shell", command: "true" }, await loadComputerPolicy(caller.organizationId, id))
      : null)
    return { ...computer, reach }
  }))
  return { self: source?.computer ?? null, computers: items }
}

function refusedExecution({ layer, code, message, changeableBy }: ComputerRefusal): ComputerExecution {
  return { state: "refused", layer, code, message, changeableBy }
}

export async function runComputerShell(caller: Caller, computerId: string, action: ComputerAction, waitMs: number) {
  const { source, computers } = await memberComputers(caller)
  const target = computers.find(({ id }) => id === computerId)
  if (!target) return { error: "unknown_computer", message: "That computer isn't available to your account.", retryable: false }
  if (target.unavailable && source?.id !== target.id) return refusedExecution(target.unavailable)
  if (target.computer.kind === "registered_vm") return refusedExecution(refusal("owner_app_only", target.computer))
  if (!source) return { error: "source_unverified", message: "This tool only accepts new commands from a Workbot chat.", retryable: false }
  const policy = await loadComputerPolicy(caller.organizationId, target.id)
  return createComputers({
    self: source.computer,
    computers: [target.computer],
    policyFor: () => policy,
    async run({ scope }) {
      const command = await enqueueComputerCommand({
        organizationId: caller.organizationId, createdByUserId: normalizeDenTypeId("user", caller.principal.userId),
        sourceDeviceId: source.id, targetDeviceId: target.id, action, scope,
      })
      const result = await followComputerCommand(caller, command.id, waitMs)
      return result ?? { state: "failed", id: command.id, error: { code: "unknown_command", message: "That computer command could not be found." } }
    },
  }).execute(target.computer, action)
}

async function commandTarget(caller: Caller, command: ComputerCommand) {
  const { computers } = await memberComputers(caller)
  return computers.find((computer) => computer.id === command.targetDeviceId)?.computer
}

async function commandExecution(caller: Caller, command: ComputerCommand): Promise<ComputerExecution> {
  const { id, status } = command
  if (status === "done") return { state: "done", id, exitCode: command.exitCode ?? 0, output: command.output ?? "", truncated: command.truncated ?? false }
  const failed = (code = "command_failed", message = "The computer could not finish this command."): ComputerExecution => ({ state: "failed", id, error: { code, message } })
  if (status === "failed") return failed(command.errorCode ?? undefined, command.errorMessage ?? undefined)
  if (status === "refused") {
    const parsed = refusalCodeSchema.safeParse(command.errorCode)
    if (!parsed.success) return failed()
    const target = await commandTarget(caller, command)
    return refusedExecution(refusal(parsed.data, target ?? { label: "That computer" }))
  }
  if (status === "expired" || command.expiresAt.getTime() <= Date.now()) {
    const label = (await commandTarget(caller, command))?.label ?? "That computer"
    if (command.claimedAt) {
      return { state: "unknown", id, message: `${label} started handling this command but hasn't reported back. It may have run. Ask again later with this command's ID, or check on that computer before running it again.` }
    }
    return { state: "failed", id, error: { code: "not_picked_up", message: `${label} didn't pick this up in time. Nothing ran.` } }
  }
  return { state: "running", id, expiresAt: command.expiresAt.toISOString() }
}

export async function followComputerCommand(caller: Caller, id: string, waitMs: number): Promise<ComputerExecution | null> {
  if (!isDenTypeId("computerCommand", id)) return null
  const userId = normalizeDenTypeId("user", caller.principal.userId)
  const deadline = Date.now() + waitMs
  await pruneCallerComputerCommands(caller.organizationId, userId)
  const waiter = createSignalWaiter((wake) => onComputerCommandUpdated(id, wake))
  try {
    for (;;) {
      const command = await readComputerCommand(caller.organizationId, userId, id)
      if (!command) return null
      const result = await commandExecution(caller, command)
      const remaining = deadline - Date.now()
      if (result.state !== "running" || remaining <= 0) return result
      await waiter.wait(Math.min(remaining, 500, Math.max(1, command.expiresAt.getTime() - Date.now())))
    }
  } finally {
    waiter.dispose()
  }
}
