import { CodeMode as OpencodeCodeMode, Tool as OpencodeTool, toolError as opencodeToolError } from "@opencode/codemode"
import { ToolError, type CodeMode, type Tool } from "@openwork/codemode"
import { Cause, Effect } from "effect"
import type { CodemodeToolTree } from "./codemode-tools.js"

export type OpencodeRunResult =
  | { ok: true; value: CodeMode.DataValue; logs: string[]; toolCalls: Array<{ name: string }> }
  | { ok: false; error: CodeMode.Diagnostic; logs: string[]; toolCalls: Array<{ name: string }> }

// Den builds its tools with OpenWork's Tool.make. OpenCode's Code Mode shows a
// program every failure's message and cause, so only a Den refusal's message
// crosses, as on OpenWork's Code Mode; anything unexpected stays generic.
function opencodeTool(definition: Tool.Definition): OpencodeTool.Tool {
  return OpencodeTool.make({
    description: definition.description,
    input: definition.input,
    // OpenCode's Code Mode hands a tool without an output schema back as void, so
    // every Den tool declares one: its own, or any value.
    output: definition.output ?? {},
    execute: (input) => Effect.catchCause(definition.run(input), (cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
      const error = Cause.squash(cause)
      return Effect.fail(opencodeToolError(error instanceof ToolError ? error.message : "Tool execution failed"))
    }),
  })
}

function opencodeTools(tree: CodemodeToolTree): Record<string, Record<string, OpencodeTool.Tool>> {
  return Object.fromEntries(Object.entries(tree).map(([namespace, tools]) => [
    namespace,
    Object.fromEntries(Object.entries(tools).map(([name, definition]) => [name, opencodeTool(definition)])),
  ]))
}

function diagnostic(error: OpencodeCodeMode.Diagnostic): CodeMode.Diagnostic {
  return {
    // Truncated only ever marks a warning; a failure never carries it.
    kind: error.kind === "Truncated" ? "ExecutionFailure" : error.kind,
    message: error.message,
    ...(error.location ? { location: error.location } : {}),
    ...(error.suggestions ? { suggestions: [...error.suggestions] } : {}),
  }
}

/**
 * Runs a Workflow on OpenCode's Code Mode (`@opencode/codemode`). Script input is
 * copied into the program, so the program can change only its own copy; warnings,
 * such as a rejection nothing awaited, are kept as log lines.
 */
export async function runOnOpencodeCodeMode(input: {
  code: string
  tools: CodemodeToolTree
  bindings?: Record<string, CodeMode.DataValue>
  limits: { timeoutMs: number; maxToolCalls: number; maxOutputBytes: number }
}): Promise<OpencodeRunResult> {
  const result = await Effect.runPromise(OpencodeCodeMode.execute({
    code: input.code,
    tools: opencodeTools(input.tools),
    ...(input.bindings ? { bindings: input.bindings } : {}),
    limits: input.limits,
  }))
  const warnings = result.ok ? (result.warnings ?? []).map((warning) => `warning: ${warning.kind}: ${warning.message}`) : []
  const logs = [...(result.logs ?? []), ...warnings]
  const toolCalls = result.toolCalls.map((call) => ({ name: call.name }))
  return result.ok
    ? { ok: true, value: result.value, logs, toolCalls }
    : { ok: false, error: diagnostic(result.error), logs, toolCalls }
}
