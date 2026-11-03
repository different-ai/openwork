import { CodeMode as OpencodeCodeMode, Tool as OpencodeTool, toolError as opencodeToolError } from "@opencode/codemode"
import { ToolError, type CodeMode, type Tool } from "@openwork/codemode"
import { Cause, Effect } from "effect"
import type { CodemodeToolTree } from "./codemode-tools.js"

export type StandardRunResult =
  | { ok: true; value: CodeMode.DataValue; logs: string[]; toolCalls: Array<{ name: string }> }
  | { ok: false; error: CodeMode.Diagnostic; logs: string[]; toolCalls: Array<{ name: string }> }

// Den's tools stay MCP-shaped: a description, a JSON Schema for input and an
// optional one for output (`codemode-tools.ts`). Only here, at the engine
// boundary, are they turned into the tool objects `@opencode/codemode` takes.
function engineTool(definition: Tool.Definition): OpencodeTool.Tool {
  return OpencodeTool.make({
    description: definition.description,
    input: definition.input,
    // In MCP a tool without an outputSchema still returns its result. The engine
    // returns nothing for a tool that declares no output schema, which is not
    // standard, so the adapter declares a permissive one.
    output: definition.output ?? {},
    // The engine shows a program every failure's message and cause. Only a Den
    // refusal's message crosses, as on OpenWork's Code Mode; anything unexpected
    // stays generic, so host error details never reach a program.
    execute: (input) => Effect.catchCause(definition.run(input), (cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
      const error = Cause.squash(cause)
      return Effect.fail(opencodeToolError(error instanceof ToolError ? error.message : "Tool execution failed"))
    }),
  })
}

function engineTools(tree: CodemodeToolTree): Record<string, Record<string, OpencodeTool.Tool>> {
  return Object.fromEntries(Object.entries(tree).map(([namespace, tools]) => [
    namespace,
    Object.fromEntries(Object.entries(tools).map(([name, definition]) => [name, engineTool(definition)])),
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
 * Runs a Workflow as standard JavaScript (ECMAScript, checked against test262),
 * on `@opencode/codemode` today. Script input is copied into the program, so the
 * program can change only its own copy; warnings, such as a rejection nothing
 * awaited, are kept as log lines.
 */
export async function runStandardCodeMode(input: {
  code: string
  tools: CodemodeToolTree
  bindings?: Record<string, CodeMode.DataValue>
  limits: { timeoutMs: number; maxToolCalls: number; maxOutputBytes: number }
}): Promise<StandardRunResult> {
  const result = await Effect.runPromise(OpencodeCodeMode.execute({
    code: input.code,
    tools: engineTools(input.tools),
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
