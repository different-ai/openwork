import { isDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import type { RunnerMessage } from "../headless-runner/client.js"
import { EXECUTE_CAPABILITY_TOOL_NAME } from "../mcp/search.js"

const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const CONNECTION_LOOKUP_TIMEOUT_MS = 1_500

type RunStepOutcome = "done" | "failed" | "blocked" | "asked"
type ConnectionId = DenTypeId<"externalMcpConnection">
export type RunStepCandidate = { connectionId: ConnectionId; tool: string; outcome?: RunStepOutcome }
type RunStepFacts = { tool: string; connectionName: string; outcome: RunStepOutcome }

type ToolCall = Pick<Extract<RunnerMessage, { role: "assistant" }>["toolCalls"][number], "name" | "input">
type ToolReply = Pick<Extract<RunnerMessage, { role: "tool" }>, "isError" | "output">

export function runStepConnector(
  { name, input }: ToolCall,
  parseCapability: (name: string) => { connectionId: string; toolName: string } | null,
) {
  if (name !== EXECUTE_CAPABILITY_TOOL_NAME || typeof input.name !== "string") return undefined
  const parsed = parseCapability(input.name)
  if (!parsed || !isDenTypeId("externalMcpConnection", parsed.connectionId) || !TOOL_NAME.test(parsed.toolName)) return undefined
  return { connectionId: parsed.connectionId, tool: parsed.toolName }
}

function cappedName(name: string, length: number): string {
  return name.slice(0, length).replace(/[\uD800-\uDFFF]/gu, "�")
}

export function runStepConnectionName(name: string): string {
  return cappedName(name, 160)
}

export async function collectRunStepFacts(
  steps: ReadonlyMap<number, RunStepCandidate>,
  loadConnections: (ids: ConnectionId[]) => Promise<readonly { id: ConnectionId; name: string }[]>,
): Promise<Map<number, RunStepFacts>> {
  const facts = new Map<number, RunStepFacts>()
  const ids = [...new Set([...steps.values()].flatMap(({ connectionId, outcome }) => outcome ? [connectionId] : []))]
  if (!ids.length) return facts

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), CONNECTION_LOOKUP_TIMEOUT_MS)
      timer.unref()
    })
    const rows = await Promise.race([loadConnections(ids), timeout])
    if (!rows) return facts
    const names = new Map(rows.map((row) => [row.id, runStepConnectionName(row.name)]))
    for (const [index, { connectionId, tool, outcome }] of steps) {
      const connectionName = names.get(connectionId)
      if (connectionName !== undefined && outcome !== undefined) facts.set(index, { tool, connectionName, outcome })
    }
    return facts
  } catch {
    return new Map()
  } finally {
    clearTimeout(timer)
  }
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
  if (!reply.isError) return "done"
  const value = reply.output === undefined ? undefined : parseJson(reply.output)
  const direct = refusalOutcome(value) ?? textRefusalOutcome(value)
  if (direct) return direct
  if (typeof value === "object" && value !== null && "content" in value && Array.isArray(value.content)) {
    for (const part of value.content) {
      const outcome = textRefusalOutcome(part)
      if (outcome) return outcome
    }
  }
  return "failed"
}
