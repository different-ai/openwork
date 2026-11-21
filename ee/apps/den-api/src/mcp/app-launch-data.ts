import { z } from "zod"
import { isDeepStrictEqual } from "node:util"
import type { McpAppToolBinding } from "@openwork/types/mcp-app"
import type { ExecuteCapabilityToolResult } from "./capability-registry.js"
import { DEN_MCP_READ_SCOPE, DEN_MCP_WRITE_SCOPE } from "./scopes.js"

const MAX_INITIAL_LOADS = 4
const INITIAL_LOAD_BUDGET_MS = 4_000
const MAX_INITIAL_RESULTS_BYTES = 256 * 1024

export type InitialResult = {
  name: string
  arguments: Record<string, unknown>
  loadedAt: string
  result: { content: unknown[]; structuredContent?: Record<string, unknown> }
  kept?: true
}

const keptLaunchDataSchema = z.array(z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  loadedAt: z.string(),
  result: z.object({ content: z.array(z.unknown()), structuredContent: z.record(z.string(), z.unknown()).optional() }),
}))

export type McpAppLaunchDataStore = {
  open(timeZone: string | undefined): Promise<{ kept: unknown; save(results: InitialResult[]): Promise<void> } | null>
}

export function requiredScope(binding: McpAppToolBinding): string {
  return binding.readOnly && binding.kind !== "mcp" ? DEN_MCP_READ_SCOPE : DEN_MCP_WRITE_SCOPE
}

function loadsWithLaunch(binding: McpAppToolBinding): boolean {
  return binding.readOnly && (binding.kind === "api" || binding.kind === "mcp" || (binding.kind === "workflow" && binding.mode === "live"))
}

function initialArguments(binding: McpAppToolBinding, timeZone: string | undefined): Record<string, unknown> | null {
  const schema = binding.inputSchema
  if (Array.isArray(schema.required) && schema.required.length > 0) return null
  if (binding.kind === "workflow" && binding.mode === "live") return timeZone ? { timeZone } : {}
  const properties = typeof schema.properties === "object" && schema.properties !== null ? Object.values(schema.properties) : []
  return properties.some((property) => typeof property === "object" && property !== null && "default" in property) ? null : {}
}

function withinBudget<T>(work: Promise<T>, onOverrun: () => void): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<null>((resolve) => { timer = setTimeout(() => { onOverrun(); resolve(null) }, INITIAL_LOAD_BUDGET_MS) })
  return Promise.race([work.catch(() => null), expired]).finally(() => clearTimeout(timer))
}

const HELD_READ_GRACE_MS = 10_000
const MAX_HELD_READS = 256

type HeldRead = {
  binding: McpAppToolBinding
  args: Record<string, unknown>
  result: Promise<ExecuteCapabilityToolResult | null>
}

const heldReads = new Map<string, HeldRead>()

export type LaunchReadHandoff = {
  hold(binding: McpAppToolBinding, args: Record<string, unknown>, work: Promise<ExecuteCapabilityToolResult>): void
  call(binding: McpAppToolBinding, args: Record<string, unknown>, run: () => Promise<ExecuteCapabilityToolResult>): Promise<ExecuteCapabilityToolResult>
}

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
  if (slot) void slot.save(fresh.filter((entry) => keepable.has(entry.name))).catch(() => undefined)
  return fresh.map((entry): InitialResult => {
    const saved = snapshots.get(entry.name)
    return saved && isDeepStrictEqual(saved.arguments, entry.arguments) && isDeepStrictEqual(saved.result, entry.result)
      ? { ...entry, kept: true }
      : entry
  })
}
