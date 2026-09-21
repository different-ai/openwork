import { AsyncLocalStorage } from "node:async_hooks"
import { CodeMode, toolError } from "@openwork/codemode"
import { Effect } from "effect"
import type { CodemodeToolTree } from "./codemode-tools.js"

// Shared across nested runs, including parallel branches. A nested Workflow
// cannot reset the outer deadline or multiply its capability-call allowance.
const executionScope = new AsyncLocalStorage<{
  depth: number
  budget: { remaining: number; deadline: number }
}>()

type CodemodeRunCommon = {
  logs: string[]
  toolCalls: Array<{ name: string }>
  durationMs: number
}

export type CodemodeRunResult = CodemodeRunCommon & (
  | { ok: true; value: CodeMode.DataValue }
  | { ok: false; error: CodeMode.Diagnostic }
)

function isJsonSafe(value: unknown, seen = new Set<object>()): value is CodeMode.DataValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object" || seen.has(value)) return false
  seen.add(value)
  const safe = Array.isArray(value)
    ? value.every((entry) => isJsonSafe(entry, seen))
    : (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
      && Object.values(value).every((entry) => isJsonSafe(entry, seen))
  seen.delete(value)
  return safe
}

export async function runCodemodeScript(input: {
  code: string
  scriptInput?: unknown
  readOnlyInput?: boolean
  tools: CodemodeToolTree
  timeoutMs: number
  maxToolCalls?: number
  maxOutputBytes?: number
}): Promise<CodemodeRunResult> {
  const startedAt = Date.now()
  if (input.scriptInput !== undefined && !isJsonSafe(input.scriptInput)) {
    return {
      ok: false,
      error: { kind: "InvalidDataValue", message: "Script input must be JSON-safe data." },
      logs: [],
      toolCalls: [],
      durationMs: Date.now() - startedAt,
    }
  }
  const bindings = input.scriptInput === undefined ? undefined : { input: input.scriptInput }
  const parent = executionScope.getStore()
  const depth = (parent?.depth ?? 0) + 1
  const budget = parent?.budget ?? {
    remaining: input.maxToolCalls ?? 50,
    deadline: startedAt + input.timeoutMs,
  }
  if (depth > 4 || budget.deadline <= startedAt) {
    return { ok: false, error: { kind: "InvalidDataValue", message: "Nested Workflow execution limit reached." },
      logs: [], toolCalls: [], durationMs: Date.now() - startedAt }
  }
  const tools: CodemodeToolTree = Object.fromEntries(Object.entries(input.tools).map(([namespace, definitions]) => [
    namespace,
    Object.fromEntries(Object.entries(definitions).map(([name, definition]) => [name, {
      ...definition,
      run: (args: unknown) => Effect.suspend(() => {
        if (budget.deadline <= Date.now() || budget.remaining-- <= 0) {
          return Effect.fail(toolError("Workflow execution call budget or deadline exceeded."))
        }
        return definition.run(args)
      }),
    }])),
  ]))
  const result = await executionScope.run({ depth, budget }, () => Effect.runPromise(CodeMode.execute({
    code: input.code,
    tools,
    ...(bindings ? { bindings } : {}),
    readonlyBindings: input.readOnlyInput,
    limits: {
      timeoutMs: Math.min(input.timeoutMs, budget.deadline - startedAt),
      maxToolCalls: input.maxToolCalls ?? 50,
      maxOutputBytes: input.maxOutputBytes ?? 65_536,
    },
  })))
  const common = {
    logs: [...(result.logs ?? [])],
    toolCalls: result.toolCalls.map((call) => ({ name: call.name })),
    durationMs: Date.now() - startedAt,
  }
  return result.ok
    ? { ok: true, value: result.value, ...common }
    : { ok: false, error: result.error, ...common }
}
