import { CodeMode as OpencodeCodeMode, Tool as OpencodeTool, toolError as opencodeToolError } from "@opencode/codemode"
import { ToolError, type CodeMode, type Tool } from "@openwork/codemode"
import { Cause, Effect, Exit, Schema } from "effect"
import { Effect as OpencodeEffect } from "effect-opencode-codemode"
import type { CodemodeToolTree } from "./codemode-tools.js"

export type OpencodeRunResult =
  | { ok: true; value: CodeMode.DataValue; logs: string[]; toolCalls: Array<{ name: string }> }
  | { ok: false; error: CodeMode.Diagnostic; logs: string[]; toolCalls: Array<{ name: string }> }

type ToolOutcome = { ok: true; value: unknown } | { ok: false; message: string }

// OpenCode's Code Mode runs on its own copy of Effect, so a Den tool runs on Den's
// Effect and only its outcome crosses, as data. The abort signal carries
// interruption (the execution timeout) into the Den call.
async function runDenTool(definition: Tool.Definition, input: unknown, signal: AbortSignal): Promise<ToolOutcome> {
  const decoded = Schema.isSchema(definition.input) ? Schema.decodeUnknownEffect(definition.input)(input) : Effect.succeed(input)
  const run = Effect.flatMap(decoded, (value) => definition.run(value))
  const output = definition.output
  const exit = await Effect.runPromiseExit(
    output !== undefined && Schema.isSchema(output) ? Effect.flatMap(run, Schema.decodeUnknownEffect(output)) : run,
    { signal },
  )
  if (Exit.isSuccess(exit)) return { ok: true, value: exit.value }
  const error = Cause.squash(exit.cause)
  return { ok: false, message: error instanceof ToolError ? error.message : "Tool execution failed" }
}

function opencodeTool(definition: Tool.Definition): OpencodeTool.Tool {
  return OpencodeTool.make({
    description: definition.description,
    input: Schema.isSchema(definition.input) ? {} : definition.input,
    // OpenCode's Code Mode hands a tool without an output schema back as void, so
    // every Den tool declares one: its own JSON Schema, or any value.
    output: definition.output === undefined || Schema.isSchema(definition.output) ? {} : definition.output,
    execute: (input) => OpencodeEffect.flatMap(
      OpencodeEffect.promise((signal) => runDenTool(definition, input, signal)),
      (outcome) => outcome.ok ? OpencodeEffect.succeed(outcome.value) : OpencodeEffect.fail(opencodeToolError(outcome.message)),
    ),
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
  const result = await OpencodeEffect.runPromise(OpencodeCodeMode.execute({
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
