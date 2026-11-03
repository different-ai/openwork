import { StandardCodeMode, type CodeMode } from "@openwork/codemode"
import { Effect } from "effect"
import type { CodemodeToolTree } from "./codemode-tools.js"

export type StandardRunResult = StandardCodeMode.Result

/**
 * Runs a Workflow as standard JavaScript (ECMAScript, checked against test262).
 * Den's tools stay MCP-shaped (`codemode-tools.ts`); the shared bridge in
 * `@openwork/codemode` turns them into engine tools, as for computer-use
 * programs: a tool without an output schema still returns its result, and only
 * a ToolError's message reaches the program.
 */
export async function runStandardCodeMode(input: {
  code: string
  tools: CodemodeToolTree
  bindings?: Record<string, CodeMode.DataValue>
  limits: { timeoutMs: number; maxToolCalls: number; maxOutputBytes: number }
}): Promise<StandardRunResult> {
  return Effect.runPromise(StandardCodeMode.execute(input))
}
