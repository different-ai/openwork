import {
  mcpAppToolBindingSchema,
  type McpAppToolBinding,
  type McpAppToolDeclaration,
} from "@openwork/types/mcp-app"
import { McpAppError } from "../mcp-apps.js"
import {
  buildCapabilityToolTree,
  CAPABILITY_SOURCE_KINDS,
  CAPABILITY_SOURCES,
  executeCapability,
  type CapabilityRegistryContext,
  type ExecuteCapabilityToolResult,
  type ParsedCapability,
} from "./capability-registry.js"
import { codemodeScriptPath, type BuiltCodemodeTools } from "./codemode-tools.js"
import { externalMcpToolSchemaDigest } from "./external-mcp-tool-arguments.js"
import { executeMarketplaceCapability, listAccessibleWorkflows } from "./marketplace-capabilities.js"

/** Live Workflow tools accept only the caller's time zone; Den supplies every other input. */
export const LIVE_WORKFLOW_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    timeZone: { type: "string", description: "Optional IANA time zone for the Workflow's runtime dates. Defaults to UTC." },
  },
  additionalProperties: false,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseCapability(name: string): ParsedCapability | null {
  for (const kind of CAPABILITY_SOURCE_KINDS) {
    const parsed = CAPABILITY_SOURCES[kind].parseName(name)
    if (parsed) return parsed
  }
  return null
}

/** A serializable object schema, or null for validators that are not JSON Schema documents. */
function objectJsonSchema(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  let copy: unknown
  try {
    copy = JSON.parse(JSON.stringify(value))
  } catch {
    return null
  }
  return isRecord(copy) && copy.type === "object" ? copy : null
}

function unavailable(tool: McpAppToolDeclaration, reason: string): McpAppError {
  return new McpAppError(422, "mcp_app_tool_unavailable", `Tool ${tool.name}: ${reason} No revision was published.`)
}

/**
 * Resolves declared App tools as their author. Each binding records how its
 * arguments reach the capability, the schema the App's server advertises,
 * and whether Den verified the capability as read-only.
 */
export async function resolveMcpAppTools(ctx: CapabilityRegistryContext, declarations: McpAppToolDeclaration[]): Promise<McpAppToolBinding[]> {
  let tree: Promise<BuiltCodemodeTools> | undefined
  let workflows: ReturnType<typeof listAccessibleWorkflows> | undefined
  const bindings: McpAppToolBinding[] = []
  for (const tool of declarations) {
    const parsed = parseCapability(tool.capability)
    const mode = tool.mode ?? "input"
    if (!parsed) throw unavailable(tool, `${tool.capability} is not a capability name. Use an exact name returned by search_capabilities.`)
    // Checked against the stored binding contract before anything is published.
    let binding: unknown
    if (parsed.kind === "marketplace") {
      if (!ctx.member) throw unavailable(tool, "an active organization membership is required.")
      const member = ctx.member
      workflows ??= listAccessibleWorkflows({ member, organizationId: ctx.organizationId })
      const workflow = (await workflows).find((candidate) => candidate.pluginId === parsed.pluginId && candidate.configObjectId === parsed.configObjectId)
      if (!workflow) throw unavailable(tool, `${tool.capability} is not a saved Workflow you can use. Apps can bind Workflows, connection tools, and OpenWork actions.`)
      const inputSchema = mode === "live" ? LIVE_WORKFLOW_TOOL_INPUT_SCHEMA : objectJsonSchema(workflow.inputSchema ?? { type: "object" })
      if (!inputSchema) throw unavailable(tool, "the Workflow input schema must describe an object. Use mode live for Workflows that read input.runtime.")
      binding = {
        name: tool.name,
        description: tool.description,
        capability: tool.capability,
        kind: "workflow",
        mode,
        inputSchema,
        // Den runs live Workflows read-only; ordinary runs may call write tools.
        readOnly: mode === "live",
      }
    } else if (parsed.kind === "catalog" || parsed.kind === "native" || parsed.kind === "externalMcp") {
      if (mode === "live") throw unavailable(tool, "mode live applies only to saved Workflows.")
      tree ??= buildCapabilityToolTree(ctx)
      const built = await tree
      const entry = built.manifest.find((candidate) => candidate.capabilityName === tool.capability)
      const definition = entry && Object.entries(built.tools).flatMap(([namespace, tools]) => Object.entries(tools)
        .filter(([toolName]) => codemodeScriptPath(namespace, toolName) === entry.scriptPath)
        .map(([, candidate]) => candidate))[0]
      if (!entry || !definition) throw unavailable(tool, `${tool.capability} is not available to you. Use an exact name returned by search_capabilities, and connect the service first if needed.`)
      const inputSchema = objectJsonSchema(definition.input) ?? { type: "object" }
      const external = parsed.kind === "externalMcp"
      binding = {
        name: tool.name,
        description: tool.description,
        capability: tool.capability,
        kind: external ? "mcp" : "api",
        mode,
        inputSchema,
        // Den's own reads are GET routes; connection tools report their provider's annotations.
        readOnly: entry.readOnly === true && entry.authority === (external ? "external" : "den"),
        ...(external ? { schemaDigest: externalMcpToolSchemaDigest(inputSchema) } : {}),
      }
    } else {
      throw unavailable(tool, "Apps can bind saved Workflows, connection tools, and OpenWork actions, not skills, remote sessions, or admin tools.")
    }
    const checked = mcpAppToolBindingSchema.safeParse(binding)
    if (!checked.success) throw unavailable(tool, "its input schema is too large or is not an object schema.")
    bindings.push(checked.data)
  }
  return bindings
}

function errorResult(error: string, message: string): ExecuteCapabilityToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error, message }) }] }
}

/** Runs one App tool as the caller, with the caller's own authorization and connections. */
export async function callMcpAppTool(
  ctx: CapabilityRegistryContext,
  binding: McpAppToolBinding,
  args: Record<string, unknown>,
): Promise<ExecuteCapabilityToolResult> {
  if (binding.kind === "workflow" && binding.mode === "live") {
    const parsed = parseCapability(binding.capability)
    if (parsed?.kind !== "marketplace") return errorResult("unknown_capability", "This App tool is no longer available.")
    const timeZone = typeof args.timeZone === "string" ? args.timeZone : undefined
    const result = await executeMarketplaceCapability({
      buildTools: () => buildCapabilityToolTree(ctx),
      organizationId: ctx.organizationId,
      member: ctx.member,
      pluginId: parsed.pluginId,
      configObjectId: parsed.configObjectId,
      enabled: ctx.externalMcpConnectionsEnabled,
      redirectUriBase: ctx.redirectUriBase,
      liveRuntime: timeZone ? { timeZone } : {},
    })
    if (!result.ok) {
      const payload = Object.fromEntries(Object.entries(result).filter(([key]) => key !== "ok"))
      return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] }
    }
    return { content: [{ type: "text", text: JSON.stringify(result.result, null, 2) }], structuredContent: result.result }
  }
  if (binding.kind === "api") {
    return executeCapability(ctx, { name: binding.capability, path: args.path, query: args.query, body: args.body })
  }
  return executeCapability(ctx, {
    name: binding.capability,
    body: args,
    ...(binding.schemaDigest ? { schemaDigest: binding.schemaDigest } : {}),
  })
}
