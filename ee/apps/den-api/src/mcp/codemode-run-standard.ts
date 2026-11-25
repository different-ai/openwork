import { StandardCodeMode, type CodeMode } from "@openwork/codemode"
import { Effect } from "effect"
import type { CodemodeToolTree } from "./codemode-tools.js"

export type StandardRunResult = StandardCodeMode.Result

export async function runStandardCodeMode(input: {
  code: string
  tools: CodemodeToolTree
  bindings?: Record<string, CodeMode.DataValue>
  limits: { timeoutMs: number; maxToolCalls: number; maxOutputBytes: number }
}): Promise<StandardRunResult> {
  return Effect.runPromise(StandardCodeMode.execute(input))
}
