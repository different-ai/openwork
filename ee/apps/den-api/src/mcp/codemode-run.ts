import { CodeMode } from "@openwork/codemode"
import { Effect } from "effect"
import type { CodemodeToolTree } from "./codemode-tools.js"

type CodemodeRunCommon = {
  logs: string[]
  toolCalls: Array<{ name: string }>
  durationMs: number
}

export type CodemodeRunResult = CodemodeRunCommon & (
  // tooLargeBytes: the returned value exceeded the output limit, so `value` is truncated text.
  | { ok: true; value: CodeMode.DataValue; tooLargeBytes?: number }
  | { ok: false; error: CodeMode.Diagnostic }
)

// CodeMode's `truncated` flag also covers dropped logs; only this marker means the value itself was cut.
const TRUNCATED_VALUE_MARKER = / \[result truncated: (\d+) bytes exceeds the \d+-byte output limit; return a smaller value\]$/u

function truncatedValueBytes(result: { truncated?: boolean; value: CodeMode.DataValue }): number | undefined {
  if (!result.truncated || typeof result.value !== "string") return undefined
  const match = TRUNCATED_VALUE_MARKER.exec(result.value)
  return match ? Number(match[1]) : undefined
}

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
const DEFAULT_MAX_OUTPUT_BYTES = 65_536

/** Replaces the outputSchema mismatch a truncated result otherwise causes. */
export function resultTooLargeMessage(bytes: number, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES): string {
  const size = (value: number, round: (kb: number) => number) => value < 1024 ? `${value} bytes` : `${round(value / 1024)} KB`
  return `The result is ${size(bytes, Math.ceil)}, over the ${size(maxOutputBytes, Math.floor)} limit. Return only the fields the Workflow needs.`
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
      maxToolCalls: input.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
      maxOutputBytes: input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    },
  }))
  const common = {
    logs: [...(result.logs ?? [])],
    toolCalls: result.toolCalls.map((call) => ({ name: call.name })),
    durationMs: Date.now() - startedAt,
  }
  if (!result.ok) return { ok: false, error: result.error, ...common }
  const tooLargeBytes = truncatedValueBytes(result)
  return { ok: true, value: result.value, ...(tooLargeBytes === undefined ? {} : { tooLargeBytes }), ...common }
}
