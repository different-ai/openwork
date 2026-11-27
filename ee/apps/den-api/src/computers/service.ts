import { createComputers, decide, projectComputer, refusal } from "@openwork/computers"
import { COMPUTER_REFUSAL_CODES, COMPUTER_SHELL_RUNNER_CAPABILITY, type ComputerAction, type ComputerExecution } from "@openwork/types/den/computers"
import { isDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { listMemberRemoteDeviceRows } from "../remote-devices.js"
import { createSignalWaiter, onComputerCommandUpdated } from "../remote-sessions/work-signal.js"
import type { CapabilityRegistryContext } from "../mcp/capability-registry.js"
import { loadComputerPolicy } from "./policy.js"
import { resolveComputerSource } from "./source.js"
import { enqueueComputerCommand, readComputerCommand, type ComputerCommand } from "./store.js"

const refusalCodeSchema = z.enum(COMPUTER_REFUSAL_CODES)

type Caller = Pick<CapabilityRegistryContext, "organizationId" | "principal"> & { memberId: DenTypeId<"member"> }

async function memberComputers(caller: Caller) {
  const actor = { organizationId: caller.organizationId, memberId: caller.memberId }
  const devices = await listMemberRemoteDeviceRows(actor, { canManageShared: false })
  const source = await resolveComputerSource(caller.principal, actor, devices)
  return {
    source: source ? { id: source.row.id, computer: projectComputer({ ...source.device, ownerMemberId: source.row.ownerMemberId }) } : null,
    computers: devices.map(({ row, device, runner }) => ({
      id: row.id,
      computer: projectComputer({ ...device, ownerMemberId: row.ownerMemberId }),
      supported: row.kind === "desktop" && row.provider === "openwork_desktop" && runner?.capabilities.includes(COMPUTER_SHELL_RUNNER_CAPABILITY) === true,
    })),
  }
}

export async function listComputers(caller: Caller) {
  const { source, computers } = await memberComputers(caller)
  const items = await Promise.all(computers.map(async ({ id, computer }) => ({
    ...computer,
    reach: source ? decide(source.computer, computer, { type: "shell", command: "true" }, await loadComputerPolicy(caller.organizationId, id)) : null,
  })))
  return { self: source?.computer ?? null, computers: items }
}

export async function runComputerShell(caller: Caller, computerId: string, action: ComputerAction, waitMs: number) {
  const { source, computers } = await memberComputers(caller)
  const target = computers.find(({ id }) => id === computerId)
  if (!target) return { error: "unknown_computer", message: "That computer isn't available to your account.", retryable: false }
  if (!source) return { error: "source_unverified", message: "Only Workbot's own computer can run work on another computer in this version.", retryable: false }
  if (!target.supported) {
    const execution: ComputerExecution = { state: "unsupported", message: `${target.computer.label} can't take work from other computers yet. It needs a newer OpenWork.` }
    return execution
  }
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

async function commandExecution(caller: Caller, command: ComputerCommand): Promise<ComputerExecution> {
  const { id, status } = command
  if (status === "done") return { state: "done", id, exitCode: command.exitCode ?? 0, output: command.output ?? "", truncated: command.truncated ?? false }
  if (status === "failed") return { state: "failed", id, error: { code: command.errorCode ?? "command_failed", message: command.errorMessage ?? "The computer could not finish this command." } }
  if (status === "refused") {
    const parsed = refusalCodeSchema.safeParse(command.errorCode)
    if (!parsed.success) return { state: "failed", id, error: { code: "command_failed", message: "The computer could not finish this command." } }
    const { computers } = await memberComputers(caller)
    const target = computers.find((computer) => computer.id === command.targetDeviceId)?.computer
    const { layer, code, message, changeableBy } = refusal(parsed.data, target ?? { label: "that computer" }, command.action)
    return { state: "refused", layer, code, message, changeableBy }
  }
  if (status === "expired" || command.expiresAt.getTime() <= Date.now()) {
    return { state: "failed", id, error: { code: "expired", message: "The computer command expired before it could finish." } }
  }
  return { state: "running", id, expiresAt: command.expiresAt.toISOString() }
}

export async function followComputerCommand(caller: Caller, id: string, waitMs: number): Promise<ComputerExecution | null> {
  if (!isDenTypeId("computerCommand", id)) return null
  const userId = normalizeDenTypeId("user", caller.principal.userId)
  const deadline = Date.now() + waitMs
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
