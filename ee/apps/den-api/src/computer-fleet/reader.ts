import type { AdminComputerDetail, AdminComputerFleet, ComputerFleetSourceKind } from "@openwork/types/den/admin-computer-fleet"
import type { HeadlessRunnerClient, RunnerComputerFleet, RunnerResult } from "../headless-runner/client.js"
import { computerDetailFrom, computerFleetFrom, notConfiguredComputerFleet, unreadableComputerFleet, type ComputerConversation, type ComputerOwner, type ComputerReports } from "./state.js"

export type ComputerFleetClient = Pick<HeadlessRunnerClient, "listComputers">
export type ComputerFleetDeps = {
  client: ComputerFleetClient | null
  owners: (keys: readonly string[]) => Promise<ReadonlyMap<string, ComputerOwner>>
  now: () => Date
}

export async function readComputerFleet(deps: ComputerFleetDeps, listed?: RunnerResult<RunnerComputerFleet>, organization: string | null = null): Promise<AdminComputerFleet> {
  if (!deps.client) return notConfiguredComputerFleet(deps.now())
  const list = listed ?? await deps.client.listComputers()
  if (!list.ok) return unreadableComputerFleet(deps.now(), list.error)
  const keys = list.value.sandboxes.flatMap((sandbox) => (sandbox.key ? [sandbox.key] : []))
  const owners = await deps.owners(keys).catch(() => new Map<string, ComputerOwner>())
  return computerFleetFrom(list.value, owners, deps.now(), organization)
}

export type ComputerDetailClient = Pick<HeadlessRunnerClient, "readComputer">
export type ComputerDetailDeps = {
  client: ComputerDetailClient | null
  known: (key: string) => Promise<{ owner: ComputerOwner | null; conversation: ComputerConversation | null; reports: ComputerReports } | null>
  now: () => Date
}
export type ComputerDetailRead = { status: "ok"; detail: AdminComputerDetail } | { status: "unknown" } | { status: "unavailable"; code: string }

const NOTHING_REPORTED: ComputerReports = { reported: null, events: [] }

export async function readComputerDetail(deps: ComputerDetailDeps, source: ComputerFleetSourceKind, id: string): Promise<ComputerDetailRead> {
  if (!deps.client) return { status: "unavailable", code: "not_configured" }
  const read = await deps.client.readComputer(source, id)
  if (!read.ok) return read.error === "unknown_computer" || read.error === "invalid_computer" ? { status: "unknown" } : { status: "unavailable", code: read.error.slice(0, 40) }
  const key = read.value.computer.key
  const known = key ? await deps.known(key).catch(() => null) : null
  return { status: "ok", detail: computerDetailFrom(read.value, known?.owner ?? null, known?.conversation ?? null, known?.reports ?? NOTHING_REPORTED, deps.now()) }
}
