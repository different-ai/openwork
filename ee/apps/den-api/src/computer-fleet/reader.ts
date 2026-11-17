import type { AdminComputerDetail, AdminComputerFleet, ComputerFleetSourceKind } from "@openwork/types/den/admin-computer-fleet"
import type { HeadlessRunnerClient, RunnerComputerFleet, RunnerResult } from "../headless-runner/client.js"
import { computerDetailFrom, computerFleetFrom, notConfiguredComputerFleet, unreadableComputerFleet, type ComputerConversation, type ComputerOwner, type ComputerReports } from "./state.js"

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

/**
 * The fleet from one read of the runner's list (`listed`, when a caller already has it). Never throws: every failure
 * is a status the page shows. `organization` narrows the list to one organization's computers, or to `unknown`.
 */
export async function readComputerFleet(deps: ComputerFleetDeps, listed?: RunnerResult<RunnerComputerFleet>, organization: string | null = null): Promise<AdminComputerFleet> {
  if (!deps.client) return notConfiguredComputerFleet(deps.now())
  const list = listed ?? await deps.client.listComputers()
  if (!list.ok) return unreadableComputerFleet(deps.now(), list.error)
  const keys = list.value.sandboxes.flatMap((sandbox) => (sandbox.key ? [sandbox.key] : []))
  // Names are a help, not the reading: without them the computers are still listed.
  const owners = await deps.owners(keys).catch(() => new Map<string, ComputerOwner>())
  return computerFleetFrom(list.value, owners, deps.now(), organization)
}

export type ComputerDetailClient = Pick<HeadlessRunnerClient, "readComputer">
export type ComputerDetailDeps = {
  client: ComputerDetailClient | null
  /** What Den knows of the computer with this key: whose it is, its conversation, and what was reported about it. */
  known: (key: string) => Promise<{ owner: ComputerOwner | null; conversation: ComputerConversation | null; reports: ComputerReports } | null>
  now: () => Date
}
/**
 * `unknown`: no such computer at the provider, or not one of this runner's. `unavailable`: it could not be read
 * (`code` says why: `provider_http_503` the provider, `http_404` a runner from before it could, `timeout`).
 */
export type ComputerDetailRead = { status: "ok"; detail: AdminComputerDetail } | { status: "unknown" } | { status: "unavailable"; code: string }

const NOTHING_REPORTED: ComputerReports = { reported: null, events: [] }

/** One computer in full. Never throws: what Den knows is a help, and without it the provider's record is still shown. */
export async function readComputerDetail(deps: ComputerDetailDeps, source: ComputerFleetSourceKind, id: string): Promise<ComputerDetailRead> {
  if (!deps.client) return { status: "unavailable", code: "not_configured" }
  const read = await deps.client.readComputer(source, id)
  if (!read.ok) return read.error === "unknown_computer" || read.error === "invalid_computer" ? { status: "unknown" } : { status: "unavailable", code: read.error.slice(0, 40) }
  const key = read.value.computer.key
  const known = key ? await deps.known(key).catch(() => null) : null
  return { status: "ok", detail: computerDetailFrom(read.value, known?.owner ?? null, known?.conversation ?? null, known?.reports ?? NOTHING_REPORTED, deps.now()) }
}
