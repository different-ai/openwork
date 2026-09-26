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
  type CapabilityLeaf,
  type CapabilityRegistryContext,
  type ExecuteCapabilityToolResult,
  type ParsedCapability,
} from "./capability-registry.js"
import { describeExternalCapability } from "./external-capabilities.js"
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

type ApiCapability = Extract<ParsedCapability, { kind: "catalog" | "native" }>

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

/**
 * Den's own routes read exactly when they are GETs, the same verdict Code Mode
 * trusts for live runs. Checked when a tool is bound and again on every call.
 */
function isDenRead(ctx: CapabilityRegistryContext, parsed: ApiCapability): boolean {
  const operationName = parsed.kind === "native" ? parsed.toolName : parsed.name
  return ctx.catalog.some((operation) => operation.name === operationName && operation.method === "GET")
}

function unavailable(tool: McpAppToolDeclaration, reason: string): McpAppError {
  return new McpAppError(422, "mcp_app_tool_unavailable", `Tool ${tool.name}: ${reason} No revision was published.`)
}

/**
 * Resolves declared App tools as their author, looking up only the
 * capabilities they name. Each binding records how its arguments reach the
 * capability, the schema the App's server advertises, and whether Den itself
 * verified it as read-only: OpenWork reads and live Workflows are; connection
 * tools and ordinary Workflow runs are not, so a host asks before each call.
 */
export async function resolveMcpAppTools(ctx: CapabilityRegistryContext, declarations: McpAppToolDeclaration[]): Promise<McpAppToolBinding[]> {
  const parsedDeclarations = declarations.map((tool) => ({ tool, parsed: parseCapability(tool.capability) }))
  const workflowIds = new Set(parsedDeclarations.flatMap(({ parsed }) => parsed?.kind === "marketplace" ? [parsed.configObjectId] : []))
  let workflows: ReturnType<typeof listAccessibleWorkflows> | undefined
  const leaves = new Map<ApiCapability["kind"], Promise<CapabilityLeaf[]>>()
  const apiLeaves = (kind: ApiCapability["kind"]) => {
    let pending = leaves.get(kind)
    if (!pending) {
      const enumerated = CAPABILITY_SOURCES[kind].enumerate(ctx)
      pending = "excluded" in enumerated ? Promise.resolve([]) : enumerated
      leaves.set(kind, pending)
    }
    return pending
  }

  const resolve = async ({ tool, parsed }: (typeof parsedDeclarations)[number]): Promise<McpAppToolBinding> => {
    const mode = tool.mode ?? "input"
    if (!parsed) throw unavailable(tool, `${tool.capability} is not a capability name. Use an exact name returned by search_capabilities.`)
    if (mode === "live" && parsed.kind !== "marketplace") throw unavailable(tool, "mode live applies only to saved Workflows.")
    // Checked against the stored binding contract before anything is published.
    let binding: unknown
    if (parsed.kind === "marketplace") {
      if (!ctx.member) throw unavailable(tool, "an active organization membership is required.")
      // Found by Workflow alone: create_app and update_app add it to the App's
      // own Plugin, so sharing that Plugin shares the Workflow.
      workflows ??= listAccessibleWorkflows({ member: ctx.member, organizationId: ctx.organizationId, configObjectIds: workflowIds })
      const workflow = (await workflows).find((candidate) => candidate.configObjectId === parsed.configObjectId)
      if (!workflow) throw unavailable(tool, `${tool.capability} is not a saved Workflow you can use. Apps can bind Workflows, connection tools, and OpenWork actions that read.`)
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
    } else if (parsed.kind === "catalog" || parsed.kind === "native") {
      const leaf = (await apiLeaves(parsed.kind)).find((candidate) => candidate.capabilityName === tool.capability)
      if (!leaf) throw unavailable(tool, `${tool.capability} is not available to you. Use an exact name returned by search_capabilities, and connect the service first if needed.`)
      if (leaf.readOnly !== true || leaf.authority !== "den" || !isDenRead(ctx, parsed)) {
        throw unavailable(tool, `${tool.capability} changes data. Apps can read with OpenWork actions; to change something, bind a saved Workflow that does it.`)
      }
      binding = {
        name: tool.name,
        description: tool.description,
        capability: tool.capability,
        kind: "api",
        mode,
        inputSchema: objectJsonSchema(leaf.definition.input) ?? { type: "object" },
        readOnly: true,
      }
    } else if (parsed.kind === "externalMcp") {
      if (!ctx.externalMcpConnectionsEnabled) throw unavailable(tool, "connection tools are not available in this organization.")
      const described = await describeExternalCapability({
        organizationId: ctx.organizationId,
        member: ctx.member,
        connectionId: parsed.connectionId,
        toolName: parsed.toolName,
        redirectUriBase: ctx.redirectUriBase,
      })
      if (!described.ok) throw unavailable(tool, described.message)
      binding = {
        name: tool.name,
        description: tool.description,
        capability: tool.capability,
        kind: "mcp",
        mode,
        inputSchema: objectJsonSchema(described.inputSchema) ?? { type: "object" },
        // A provider's own read-only hints are descriptive, so every call asks first.
        readOnly: false,
        schemaDigest: externalMcpToolSchemaDigest(described.inputSchema),
      }
    } else {
      throw unavailable(tool, "Apps can bind saved Workflows, connection tools, and OpenWork actions that read, not skills, remote sessions, or admin tools.")
    }
    const checked = mcpAppToolBindingSchema.safeParse(binding)
    if (!checked.success) throw unavailable(tool, "its input schema is too large or is not an object schema.")
    return checked.data
  }

  // Resolved together, so one slow connection bounds the whole publish; the
  // first failing declaration in order is the one reported.
  const settled = await Promise.allSettled(parsedDeclarations.map(resolve))
  const failed = settled.find((result) => result.status === "rejected")
  if (failed) throw failed.reason
  return settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])
}

function errorResult(error: string, message: string): ExecuteCapabilityToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error, message }) }] }
}

// Launch hints name tools and resources on /mcp/agent, which an App's own server does not serve.
const AGENT_SERVER_META_KEYS = new Set(["openwork/mcpApp", "openwork/serverTools"])

function withoutAgentServerMeta(result: ExecuteCapabilityToolResult): ExecuteCapabilityToolResult {
  if (!result._meta) return result
  const { _meta: meta, ...rest } = result
  const kept = Object.entries(meta).filter(([key]) => !AGENT_SERVER_META_KEYS.has(key))
  return kept.length > 0 ? { ...rest, _meta: Object.fromEntries(kept) } : rest
}

/** Runs one App tool as the caller, with the caller's own authorization and connections. */
export async function callMcpAppTool(
  ctx: CapabilityRegistryContext,
  binding: McpAppToolBinding,
  args: Record<string, unknown>,
): Promise<ExecuteCapabilityToolResult> {
  const parsed = parseCapability(binding.capability)
  if (binding.kind === "workflow" && binding.mode === "live") {
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
  if (binding.kind === "workflow") {
    if (parsed?.kind !== "marketplace") return errorResult("unknown_capability", "This App tool is no longer available.")
    return withoutAgentServerMeta(await executeCapability(ctx, { name: binding.capability, body: args }))
  }
  if (binding.kind === "api") {
    if ((parsed?.kind !== "catalog" && parsed?.kind !== "native") || !isDenRead(ctx, parsed)) {
      return errorResult("policy_blocked", `${binding.name} no longer only reads data, so OpenWork blocked it. An editor of this App can bind a saved Workflow instead.`)
    }
    return withoutAgentServerMeta(await executeCapability(ctx, { name: binding.capability, path: args.path, query: args.query, body: args.body }))
  }
  if (parsed?.kind !== "externalMcp") return errorResult("unknown_capability", "This App tool is no longer available.")
  // The provider must still advertise the schema the App was published against.
  return withoutAgentServerMeta(await executeCapability(ctx, {
    name: binding.capability,
    body: args,
    ...(binding.schemaDigest ? { schemaDigest: binding.schemaDigest, requireSchemaMatch: true } : {}),
  }))
}
