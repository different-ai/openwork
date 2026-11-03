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

function withinBudget<T>(work: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), INITIAL_LOAD_BUDGET_MS) })
  return Promise.race([work.catch(() => null), expired]).finally(() => clearTimeout(timer))
}

/**
 * What the App's read-only tools that need no input return as it opens. Each
 * runs through the same checked call as when the App calls it; one that fails,
 * needs approval, or runs past the budget is left for the App to call itself.
 */
export async function loadInitialResults(input: {
  tools: McpAppToolBinding[]
  scopes: ReadonlySet<string>
  timeZone: string | undefined
  callTool: (binding: McpAppToolBinding, args: Record<string, unknown>) => Promise<ExecuteCapabilityToolResult>
}): Promise<InitialResult[]> {
  const loads = input.tools.flatMap((binding) => {
    const args = loadsWithLaunch(binding) && input.scopes.has(requiredScope(binding)) ? initialArguments(binding, input.timeZone) : null
    return args ? [{ binding, args }] : []
  }).slice(0, MAX_INITIAL_LOADS)
  const settled = await Promise.all(loads.map(async ({ binding, args }): Promise<InitialResult | null> => {
    const result = await withinBudget(input.callTool(binding, args))
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
