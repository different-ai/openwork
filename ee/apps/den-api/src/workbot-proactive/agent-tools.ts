import {
  decideAgentReadTool,
  decideNativeReadOperation,
  type AgentReadToolInput,
} from "@openwork/automations/agent-read-tools"
import type { AgentConnectionToolsView, AgentToolOverride, AgentToolDecisionView } from "@openwork/types/den/workbot-proactive"
import { nativeSourceKind } from "../mcp/agent-read-sources.js"
import type { MemberConnection, ResolvedSource } from "./sources.js"
import { readableConnections } from "./sources.js"

export type ToolOverrides = Readonly<Record<string, Readonly<Record<string, AgentToolOverride>>>>

export type NativeOperation = { name: string; method: string; path: string; summary?: string | null }

export const AGENT_CHECK_TOOLS_MAX = 1500

export type ConnectionToolPlan = {
  connection: MemberConnection
  status: "listed" | "unlisted" | "native"
  allowed: string[]
  denied: number
}

export type AgentToolPlan = {
  tools: { connectionId: string; names: string[] }[]
  nativeReads: { connectionId: string; denied: string[] }[]
  connections: ConnectionToolPlan[]
}

export function nativeOtherOperations(operations: readonly NativeOperation[]): NativeOperation[] {
  return operations.filter((operation) => nativeSourceKind(operation.path) === null)
}

export async function planAgentTools(input: {
  sources: readonly ResolvedSource[]
  overrides: ToolOverrides
  listTools: (connection: MemberConnection) => Promise<readonly AgentReadToolInput[] | null>
}): Promise<AgentToolPlan> {
  const mcp = new Map<string, MemberConnection>()
  const natives = new Map<string, MemberConnection>()
  for (const source of input.sources) {
    for (const connection of readableConnections(source)) {
      if (connection.native === null) mcp.set(connection.id, connection)
      else if (source.kind === "other") natives.set(connection.id, connection)
    }
  }
  const listed = await Promise.all([...mcp.values()].map(async (connection) => ({ connection, tools: await input.listTools(connection).catch(() => null) })))
  const plan: AgentToolPlan = { tools: [], nativeReads: [], connections: [] }
  let budget = AGENT_CHECK_TOOLS_MAX
  for (const { connection, tools } of listed) {
    if (!tools) {
      plan.connections.push({ connection, status: "unlisted", allowed: [], denied: 0 })
      continue
    }
    const overrides = input.overrides[connection.id] ?? {}
    const allowed = tools
      .filter((tool) => decideAgentReadTool({ connectionUrl: connection.url, tool, override: overrides[tool.name] ?? null }).allowed)
      .map((tool) => tool.name)
      .slice(0, Math.max(0, budget))
    budget -= allowed.length
    plan.tools.push({ connectionId: connection.id, names: allowed })
    plan.connections.push({ connection, status: "listed", allowed, denied: tools.length - allowed.length })
  }
  for (const connection of natives.values()) {
    const denied = Object.entries(input.overrides[connection.id] ?? {}).filter(([, value]) => value === "deny").map(([name]) => name)
    plan.nativeReads.push({ connectionId: connection.id, denied })
    plan.connections.push({ connection, status: "native", allowed: [], denied: denied.length })
  }
  return plan
}

export function sourceUsable(source: ResolvedSource, plan: AgentToolPlan): boolean {
  const ready = readableConnections(source)
  return ready.length > 0 && ready.every((connection) => {
    if (connection.native !== null) return true
    return (plan.tools.find((entry) => entry.connectionId === connection.id)?.names.length ?? 0) > 0
  })
}

export function unusableWhy(source: ResolvedSource, plan: AgentToolPlan): string {
  const unlisted = readableConnections(source).some((connection) => plan.connections.find((entry) => entry.connection.id === connection.id)?.status === "unlisted")
  return unlisted ? "its tools couldn't be listed" : "no read-only tools"
}

function decisionView(tool: AgentReadToolInput, decision: ReturnType<typeof decideAgentReadTool>, override: AgentToolOverride | null): AgentToolDecisionView {
  return {
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? null,
    allowed: decision.allowed,
    reason: decision.reason,
    override,
    locked: decision.locked,
  }
}

export function mcpConnectionToolsView(input: { connectionId: string; url: string; tools: readonly AgentReadToolInput[]; overrides: Readonly<Record<string, AgentToolOverride>> }): AgentConnectionToolsView {
  const tools = input.tools.map((tool) => {
    const override = input.overrides[tool.name] ?? null
    return decisionView(tool, decideAgentReadTool({ connectionUrl: input.url, tool, override }), override)
  })
  return { connectionId: input.connectionId, status: "ready", readTools: tools.filter((tool) => tool.allowed).length, tools, coreSourcesElsewhere: false }
}

export function nativeConnectionToolsView(input: { connectionId: string; operations: readonly NativeOperation[]; overrides: Readonly<Record<string, AgentToolOverride>> }): AgentConnectionToolsView {
  const tools = nativeOtherOperations(input.operations).map((operation) => {
    const override = input.overrides[operation.name] ?? null
    return decisionView({ name: operation.name, description: operation.summary ?? null }, decideNativeReadOperation({ method: operation.method, override }), override)
  })
  return { connectionId: input.connectionId, status: "ready", readTools: tools.filter((tool) => tool.allowed).length, tools, coreSourcesElsewhere: true }
}

export function unlistedConnectionToolsView(connectionId: string, status: "needs_connection" | "unavailable"): AgentConnectionToolsView {
  return { connectionId, status, readTools: 0, tools: [], coreSourcesElsewhere: false }
}

export async function sourceReadToolCounts(input: {
  sources: readonly ResolvedSource[]
  overrides: ToolOverrides
  listTools: (connection: MemberConnection) => Promise<readonly AgentReadToolInput[] | null>
  nativeOperations: (providerKey: string) => Promise<readonly NativeOperation[] | null>
}): Promise<Map<string, number | null>> {
  const counts = new Map<string, number | null>()
  await Promise.all(input.sources.filter((source) => source.kind === "other").map(async (source) => {
    const connection = source.connections[0]
    if (!connection) return counts.set(source.id, null)
    const overrides = input.overrides[connection.id] ?? {}
    if (connection.native !== null) {
      const operations = await input.nativeOperations(connection.native).catch(() => null)
      return counts.set(source.id, operations ? nativeConnectionToolsView({ connectionId: connection.id, operations, overrides }).readTools : null)
    }
    if (connection.state !== "connected") return counts.set(source.id, null)
    const tools = await input.listTools(connection).catch(() => null)
    return counts.set(source.id, tools ? mcpConnectionToolsView({ connectionId: connection.id, url: connection.url, tools, overrides }).readTools : null)
  }))
  return counts
}
