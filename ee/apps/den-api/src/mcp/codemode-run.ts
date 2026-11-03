import { CodeMode } from "@openwork/codemode"
import { Effect } from "effect"
import { runStandardCodeMode } from "./codemode-run-standard.js"
import type { CodemodeLanguage } from "./codemode-script-object.js"
import type { CodemodeToolTree } from "./codemode-tools.js"

/**
 * Which interpreter runs a script: OpenWork's original Code Mode, or the
 * standard one, which runs ECMAScript (today `@opencode/codemode`).
 */
export type CodemodeRuntime = "openwork" | "standard"

/**
 * Saved code keeps the interpreter it was written for: OpenWork's for
 * `codemode-js`, the standard one for `ecmascript` while the organization has
 * `standardCodeMode`. Turning the feature off runs everything on OpenWork's again.
 */
export function codemodeRuntimeFor(language: CodemodeLanguage, standardCodeMode: boolean): CodemodeRuntime {
  return language === "ecmascript" && standardCodeMode ? "standard" : "openwork"
}

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

// A runaway-loop guard, not a work budget: scripts call tools without a
// per-call approval, and the timeout and output cap bound everything else.
const DEFAULT_MAX_TOOL_CALLS = 1_024

export async function runCodemodeScript(input: {
  code: string
  scriptInput?: unknown
  readOnlyInput?: boolean
  tools: CodemodeToolTree
  timeoutMs: number
  maxToolCalls?: number
  maxOutputBytes?: number
  runtime?: CodemodeRuntime
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
  const limits = {
    timeoutMs: input.timeoutMs,
    maxToolCalls: input.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
    maxOutputBytes: input.maxOutputBytes ?? 65_536,
  }
  const result = input.runtime === "standard"
    ? await runStandardCodeMode({ code: input.code, tools: input.tools, ...(bindings ? { bindings } : {}), limits })
    : await Effect.runPromise(CodeMode.execute({
        code: input.code,
        tools: input.tools,
        ...(bindings ? { bindings } : {}),
        readonlyBindings: input.readOnlyInput,
        limits,
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
