import { isDenTypeId } from "@openwork-ee/utils/typeid"
import type { RunnerMessage } from "../headless-runner/client.js"
import { EXECUTE_CAPABILITY_TOOL_NAME } from "../mcp/search.js"

export type RunStepOutcome = "done" | "failed" | "blocked" | "asked"

type ToolCall = Pick<Extract<RunnerMessage, { role: "assistant" }>["toolCalls"][number], "name" | "input">
type ToolReply = Pick<Extract<RunnerMessage, { role: "tool" }>, "isError" | "output">

export function runStepConnector(
  { name, input }: ToolCall,
  parseCapability: (name: string) => { connectionId: string; toolName: string } | null,
) {
  if (name !== EXECUTE_CAPABILITY_TOOL_NAME || typeof input.name !== "string") return undefined
  const parsed = parseCapability(input.name)
  if (!parsed || !isDenTypeId("externalMcpConnection", parsed.connectionId) || !parsed.toolName.trim() || parsed.toolName === "*") return undefined
  return { connectionId: parsed.connectionId, tool: cappedName(parsed.toolName, 128) }
}

function cappedName(name: string, length: number): string {
  return name.slice(0, length).replace(/[\uD800-\uDFFF]/gu, "�")
}

export function runStepConnectionName(name: string): string {
  return cappedName(name, 160)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function refusalOutcome(value: unknown): RunStepOutcome | undefined {
  if (typeof value !== "object" || value === null || !("error" in value)) return undefined
  if (value.error === "needs_approval") return "asked"
  if (value.error === "policy_blocked") return "blocked"
  return undefined
}

function textRefusalOutcome(value: unknown): RunStepOutcome | undefined {
  if (typeof value !== "object" || value === null || !("text" in value) || typeof value.text !== "string") return undefined
  if ("type" in value && value.type !== "text") return undefined
  return refusalOutcome(parseJson(value.text))
}

export function runStepOutcome(reply: ToolReply | undefined): RunStepOutcome | undefined {
  if (!reply) return undefined
  const value = reply.output === undefined ? undefined : parseJson(reply.output)
  const direct = refusalOutcome(value) ?? textRefusalOutcome(value)
  if (direct) return direct
  if (typeof value === "object" && value !== null && "content" in value && Array.isArray(value.content)) {
    for (const part of value.content) {
      const outcome = textRefusalOutcome(part)
      if (outcome) return outcome
    }
  }
  return reply.isError ? "failed" : "done"
}
