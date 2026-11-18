import { z } from "zod"
import { isDeepStrictEqual } from "node:util"
import type { McpAppToolBinding } from "@openwork/types/mcp-app"
import type { ExecuteCapabilityToolResult } from "./capability-registry.js"
import { DEN_MCP_READ_SCOPE, DEN_MCP_WRITE_SCOPE } from "./scopes.js"

/**
 * The reads an App built in OpenWork makes as it opens, run by its launch so
 * the App can show them without another round trip.
 *
 * Kept free of database and environment imports so it can be unit tested.
 */

/** At most this many reads run as an App opens, each within the budget. */
const MAX_INITIAL_LOADS = 4
const INITIAL_LOAD_BUDGET_MS = 4_000
const MAX_INITIAL_RESULTS_BYTES = 256 * 1024

export type InitialResult = {
  name: string
  arguments: Record<string, unknown>
  loadedAt: string
  result: { content: unknown[]; structuredContent?: Record<string, unknown> }
  /** Matches this member's earlier snapshot, confirmed by this open's checked read. */
  kept?: true
}

const keptLaunchDataSchema = z.array(z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  loadedAt: z.string(),
  result: z.object({ content: z.array(z.unknown()), structuredContent: z.record(z.string(), z.unknown()).optional() }),
}))

/**
 * Where an App's launch data waits for the same member's next open. `open`
 * names one slot for this open, or null when nothing may be kept, and the slot
 * keeps its name for the save. The slot is an optimization hint, never proof
 * that the caller may still read its contents.
 */
export type McpAppLaunchDataStore = {
  open(timeZone: string | undefined): Promise<{ kept: unknown; save(results: InitialResult[]): Promise<void> } | null>
}

/** A connection tool always needs mcp:write, whatever its label, because external dispatch requires it. */
export function requiredScope(binding: McpAppToolBinding): string {
  return binding.readOnly && binding.kind !== "mcp" ? DEN_MCP_READ_SCOPE : DEN_MCP_WRITE_SCOPE
}

/**
 * Only a tool with a current read-only verdict loads with the launch, and only
 * a kind whose every call rechecks that verdict: a Den read, a connection tool
 * its provider marks read-only, or a live Workflow. A tool its author chose to
 * load on open without that verdict waits for the App to call it.
 */
function loadsWithLaunch(binding: McpAppToolBinding): boolean {
  return binding.readOnly && (binding.kind === "api" || binding.kind === "mcp" || (binding.kind === "workflow" && binding.mode === "live"))
}

/** A tool that runs with no input from the person; a live Workflow takes only their time zone. */
function initialArguments(binding: McpAppToolBinding, timeZone: string | undefined): Record<string, unknown> | null {
  const schema = binding.inputSchema
  if (Array.isArray(schema.required) && schema.required.length > 0) return null
  if (binding.kind === "workflow" && binding.mode === "live") return timeZone ? { timeZone } : {}
  const properties = typeof schema.properties === "object" && schema.properties !== null ? Object.values(schema.properties) : []
  // A default the App would send makes its arguments differ from an empty call.
  return properties.some((property) => typeof property === "object" && property !== null && "default" in property) ? null : {}
}

/** The work's result, or null when it fails or the budget runs out first; then `onOverrun` hears that it is still running. */
function withinBudget<T>(work: Promise<T>, onOverrun: () => void): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<null>((resolve) => { timer = setTimeout(() => { onOverrun(); resolve(null) }, INITIAL_LOAD_BUDGET_MS) })
  return Promise.race([work.catch(() => null), expired]).finally(() => clearTimeout(timer))
}

/** How long a held read that has finished still waits for the App's own call. */
const HELD_READ_GRACE_MS = 10_000
const MAX_HELD_READS = 256

type HeldRead = {
  binding: McpAppToolBinding
  args: Record<string, unknown>
  result: Promise<ExecuteCapabilityToolResult | null>
}

/** Launch reads in this process that ran past the budget, by caller and tool. */
const heldReads = new Map<string, HeldRead>()

/**
 * Hands a launch read that ran past its budget to the App's own call for the
 * same read, so the tool runs once per open rather than twice. The launch
 * stops waiting, but the read keeps running in this process.
 */
export type LaunchReadHandoff = {
  hold(binding: McpAppToolBinding, args: Record<string, unknown>, work: Promise<ExecuteCapabilityToolResult>): void
  /** The held read of exactly this call, taken once, or else a new run. */
  call(binding: McpAppToolBinding, args: Record<string, unknown>, run: () => Promise<ExecuteCapabilityToolResult>): Promise<ExecuteCapabilityToolResult>
}

/**
 * `caller` names everything that decides what a call may return to this
 * caller: member, teams, credential, scopes and App revision. A held read was
 * authorized when it started, as any call still running was, and only the
 * same binding and arguments can take it. A failed read is not handed over,
 * so the App's call runs it again, and a finished read is dropped after a
 * short grace.
 */
export function launchReadHandoff(caller: string, graceMs = HELD_READ_GRACE_MS): LaunchReadHandoff {
  const keyOf = (binding: McpAppToolBinding) => JSON.stringify([caller, binding.name])
  return {
    hold(binding, args, work) {
      const key = keyOf(binding)
      const held: HeldRead = { binding, args, result: work.then((result) => result.isError ? null : result, () => null) }
      heldReads.delete(key)
      const oldest = heldReads.size >= MAX_HELD_READS ? heldReads.keys().next().value : undefined
      if (oldest !== undefined) heldReads.delete(oldest)
      heldReads.set(key, held)
      void held.result.then(() => {
        setTimeout(() => { if (heldReads.get(key) === held) heldReads.delete(key) }, graceMs).unref()
      })
    },
    async call(binding, args, run) {
      const key = keyOf(binding)
      const held = heldReads.get(key)
      if (!held || !isDeepStrictEqual(held.binding, binding) || !isDeepStrictEqual(held.args, args)) return run()
      heldReads.delete(key)
      return (await held.result) ?? run()
    },
  }
}

/**
 * What the App's read-only tools that need no input return as it opens. Each
 * runs through the same checked call as when the App calls it; one that fails
 * or needs approval is left for the App to call itself, and one that runs past
 * the budget is held for the App's call to take.
 */
export async function loadInitialResults(input: {
  tools: McpAppToolBinding[]
  scopes: ReadonlySet<string>
  timeZone: string | undefined
  callTool: (binding: McpAppToolBinding, args: Record<string, unknown>) => Promise<ExecuteCapabilityToolResult>
  handoff?: LaunchReadHandoff
}): Promise<InitialResult[]> {
  const loads = input.tools.flatMap((binding) => {
    const args = loadsWithLaunch(binding) && input.scopes.has(requiredScope(binding)) ? initialArguments(binding, input.timeZone) : null
    return args ? [{ binding, args }] : []
  }).slice(0, MAX_INITIAL_LOADS)
  const settled = await Promise.all(loads.map(async ({ binding, args }): Promise<InitialResult | null> => {
    const work = input.callTool(binding, args)
    const result = await withinBudget(work, () => input.handoff?.hold(binding, args, work))
    if (!result || result.isError) return null
    return {
      name: binding.name,
      arguments: args,
      loadedAt: new Date().toISOString(),
      result: { content: result.content, ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}) },
    }
  }))
  const kept: InitialResult[] = []
  let bytes = 0
  for (const entry of settled) {
    if (!entry) continue
    bytes += Buffer.byteLength(JSON.stringify(entry))
    if (bytes > MAX_INITIAL_RESULTS_BYTES) break
    kept.push(entry)
  }
  return kept
}

/**
 * The launch data for this open. Every read runs through its current route
 * authorization and filtering, even when a snapshot exists: the inventory
 * revision is best effort and cannot authorize a cached response. Only a
 * snapshot identical to that checked result is marked kept. Denials, changed
 * visibility, failed reads and timeouts never fall back to stored data.
 */
export async function launchInitialResults(input: Parameters<typeof loadInitialResults>[0] & {
  store?: McpAppLaunchDataStore
  canKeep?: (binding: McpAppToolBinding) => boolean
}): Promise<InitialResult[]> {
  const { canKeep } = input
  const keepable = new Set(canKeep ? input.tools.filter((binding) => canKeep(binding)).map((binding) => binding.name) : [])
  const [fresh, slot] = await Promise.all([
    loadInitialResults(input),
    input.store && keepable.size > 0 ? input.store.open(input.timeZone).catch(() => null) : null,
  ])
  const parsed = keptLaunchDataSchema.safeParse(slot?.kept ?? null)
  const snapshots = new Map(parsed.success ? parsed.data.filter((entry) => keepable.has(entry.name)).map((entry) => [entry.name, entry]) : [])
  // Replacing or clearing the slot is best effort; serving data is always
  // gated by the fresh read above, including when this save fails.
  if (slot) void slot.save(fresh.filter((entry) => keepable.has(entry.name))).catch(() => undefined)
  return fresh.map((entry): InitialResult => {
    const saved = snapshots.get(entry.name)
    return saved && isDeepStrictEqual(saved.arguments, entry.arguments) && isDeepStrictEqual(saved.result, entry.result)
      ? { ...entry, kept: true }
      : entry
  })
}
