import { CodeMode as Engine, Tool as EngineTool, toolError as engineToolError } from "@opencode/codemode"
import { Cause, Effect } from "effect"
import type { DataValue, Diagnostic } from "./codemode.js"
import type { Definition } from "./tool.js"
import { ToolError } from "./tool-error.js"

/** OpenWork tools by namespace, as a program calls them: `tools.<namespace>.<name>`. */
export type Tools = Record<string, Record<string, Definition>>

export type Result =
  | { ok: true; value: DataValue; logs: string[]; toolCalls: Array<{ name: string }> }
  | { ok: false; error: Diagnostic; logs: string[]; toolCalls: Array<{ name: string }> }

export type Limits = { timeoutMs: number; maxToolCalls: number; maxOutputBytes: number }

// OpenWork's tools stay MCP-shaped: a description, a schema for input and an
// optional one for output. Only here, at the engine boundary, are they turned
// into the tool objects the standard engine takes.
function engineTool(definition: Definition): EngineTool.Tool {
  return EngineTool.make({
    description: definition.description,
    input: definition.input,
    // In MCP a tool without an outputSchema still returns its result. The engine
    // returns nothing for a tool that declares no output schema, which is not
    // standard, so the bridge declares a permissive one.
    output: definition.output ?? {},
    // The engine shows a program every failure's message and cause. Only a
    // ToolError's message crosses, as on OpenWork's Code Mode; anything
    // unexpected stays generic, so host error details never reach a program.
    execute: (input) => Effect.catchCause(definition.run(input), (cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
      const error = Cause.squash(cause)
      return Effect.fail(engineToolError(error instanceof ToolError ? error.message : "Tool execution failed"))
    }),
  })
}

function engineTools(tools: Tools): Record<string, Record<string, EngineTool.Tool>> {
  return Object.fromEntries(Object.entries(tools).map(([namespace, group]) => [
    namespace,
    Object.fromEntries(Object.entries(group).map(([name, definition]) => [name, engineTool(definition)])),
  ]))
}

function diagnostic(error: Engine.Diagnostic): Diagnostic {
  return {
    // Truncated only ever marks a warning; a failure never carries it.
    kind: error.kind === "Truncated" ? "ExecutionFailure" : error.kind,
    message: error.message,
    ...(error.location ? { location: error.location } : {}),
    ...(error.suggestions ? { suggestions: [...error.suggestions] } : {}),
  }
}

/**
 * Runs a program as standard JavaScript (ECMAScript, checked against test262)
 * over OpenWork's tools, on `@opencode/codemode` today. Bindings are JSON copied
 * into the program. Warnings, such as a rejection nothing awaited, are kept as
 * `warning: Kind: message` log lines. Workflows and computer-use programs both
 * run here, so engine departures are handled once.
 */
export function execute(input: {
  code: string
  tools: Tools
  bindings?: Readonly<Record<string, DataValue>>
  limits: Limits
}): Effect.Effect<Result> {
  return Engine.execute({
    code: input.code,
    tools: engineTools(input.tools),
    ...(input.bindings ? { bindings: input.bindings } : {}),
    limits: input.limits,
  }).pipe(Effect.map((result): Result => {
    const warnings = result.ok ? (result.warnings ?? []).map((warning) => `warning: ${warning.kind}: ${warning.message}`) : []
    const logs = [...(result.logs ?? []), ...warnings]
    const toolCalls = result.toolCalls.map((call) => ({ name: call.name }))
    return result.ok
      ? { ok: true, value: result.value, logs, toolCalls }
      : { ok: false, error: diagnostic(result.error), logs, toolCalls }
  }))
}
