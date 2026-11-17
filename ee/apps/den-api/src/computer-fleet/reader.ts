import type { AdminComputerFleet } from "@openwork/types/den/admin-computer-fleet"
import type { HeadlessRunnerClient, RunnerComputerFleet, RunnerResult } from "../headless-runner/client.js"
import { computerFleetFrom, notConfiguredComputerFleet, unreadableComputerFleet, type ComputerOwner } from "./state.js"

/**
 * One reading of the computer fleet: the runner's list (`GET /v1/computers`, which asks the sandbox providers with
 * the runner's own keys) and whose each computer is. Nothing is written and no provider is contacted from Den.
 */
export type ComputerFleetClient = Pick<HeadlessRunnerClient, "listComputers">
export type ComputerFleetDeps = {
  /** Null when this deployment has no headless runner. */
  client: ComputerFleetClient | null
  /** Whose each of these computer keys is; computers it does not know stay unnamed. */
  owners: (keys: readonly string[]) => Promise<ReadonlyMap<string, ComputerOwner>>
  now: () => Date
}

/** The fleet from one read of the runner's list (`listed`, when a caller already has it). Never throws: every failure is a status the page shows. */
export async function readComputerFleet(deps: ComputerFleetDeps, listed?: RunnerResult<RunnerComputerFleet>): Promise<AdminComputerFleet> {
  if (!deps.client) return notConfiguredComputerFleet(deps.now())
  const list = listed ?? await deps.client.listComputers()
  if (!list.ok) return unreadableComputerFleet(deps.now(), list.error)
  const keys = list.value.sandboxes.flatMap((sandbox) => (sandbox.key ? [sandbox.key] : []))
  // Names are a help, not the reading: without them the computers are still listed.
  const owners = await deps.owners(keys).catch(() => new Map<string, ComputerOwner>())
  return computerFleetFrom(list.value, owners, deps.now())
}
