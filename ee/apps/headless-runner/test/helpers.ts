import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { McpConnector } from "../src/mcp.js"
import type { ModelClient, ModelRequest, ModelStep } from "../src/model.js"
import { Runner, type RunnerOptions } from "../src/runner.js"
import { Store } from "../src/store.js"
import type { ToolCall } from "../src/types.js"

export function tempDbPath() {
  return join(mkdtempSync(join(tmpdir(), "headless-runner-")), "state.sqlite")
}

export const text = (value: string): ModelStep => ({ text: value, toolCalls: [], usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 5 } })
export const calls = (...toolCalls: ToolCall[]): ModelStep => ({ text: "", toolCalls, usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 5 } })

/** A model that replays scripted steps and records every request it receives. */
export function scriptedModel(steps: Array<ModelStep | ((request: ModelRequest) => Promise<ModelStep>)>) {
  const requests: ModelRequest[] = []
  const model: ModelClient = {
    async complete(request) {
      requests.push(request)
      const next = steps.shift()
      if (!next) throw new Error("scripted model ran out of steps")
      return typeof next === "function" ? next(request) : next
    },
  }
  return { model, requests }
}

export function fakeMcp(handlers: Record<string, (input: Record<string, unknown>) => string>) {
  const seen: Array<{ token: string; name: string; input: Record<string, unknown> }> = []
  const connector: McpConnector = async ({ token }) => ({
    tools: Object.keys(handlers).map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
    async call(name, input) {
      seen.push({ token, name, input })
      const handler = handlers[name]
      return handler ? { output: handler(input), isError: false } : { output: "unknown", isError: true }
    },
    async close() {},
  })
  return { connector, seen }
}

export function makeRunner(input: { store?: Store; model: ModelClient; mcp?: McpConnector } & Partial<RunnerOptions>) {
  const store = input.store ?? new Store(tempDbPath())
  const runner = new Runner({
    store,
    defaultModel: "gwm_test",
    limits: { maxConcurrentTurns: 4, maxSteps: 8, turnTimeoutMs: 60_000, contextCharBudget: 100_000 },
    ...input,
  })
  return { store, runner }
}

export function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
}
