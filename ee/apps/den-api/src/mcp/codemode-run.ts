import { CodeMode } from "@openwork/codemode"
import { Effect } from "effect"
import type { CodemodeToolTree } from "./codemode-tools.js"

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
  const result = await Effect.runPromise(CodeMode.execute({
    code: input.code,
    tools: input.tools,
    ...(bindings ? { bindings } : {}),
    readonlyBindings: input.readOnlyInput,
    limits: {
      timeoutMs: input.timeoutMs,
      maxToolCalls: input.maxToolCalls ?? 50,
      maxOutputBytes: input.maxOutputBytes ?? 65_536,
    },
  }))
  const common = {
    logs: [...(result.logs ?? [])],
    toolCalls: result.toolCalls.map((call) => ({ name: call.name })),
    durationMs: Date.now() - startedAt,
  }
  return result.ok
    ? { ok: true, value: result.value, ...common }
    : { ok: false, error: result.error, ...common }
}
