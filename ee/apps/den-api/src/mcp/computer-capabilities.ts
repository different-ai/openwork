import { projectComputer } from "@openwork/computers"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { computerToolCallSchema, type ComputerToolName } from "@openwork/types/den/computers"
import { z } from "zod"
import { DEN_MCP_WRITE_SCOPE } from "./scopes.js"
import { AuditUnavailableError, auditUnavailableToolResult, runMcpServiceAction, serviceAuditResourceId, toolResultStatus } from "../audit/mcp-service-audit.js"
import { followComputerCommand, listComputers, runComputerTool } from "../computers/service.js"
import { markFeaturesUsed } from "../feature-usage.js"
import { organizationFeatureEnabled } from "../features.js"
import type { CapabilitySource, ExecuteCapabilityToolResult } from "./capability-registry.js"
import { resolveComputerSource } from "../computers/source.js"
import { scoreText, tokenize, type CapabilityMatch } from "./search.js"

const listBody = z.strictObject({})
const waitMs = z.number().int().min(0).max(20_000).default(15_000)
const followBody = z.strictObject({ id: z.string().min(1), waitMs })
const verbs: Record<ComputerToolName, string> = {
  shell: "Run a shell command in a shared folder",
  read: "Read a file in a shared folder",
  write: "Write a file in an editable shared folder",
  edit: "Edit a file in an editable shared folder",
  glob: "Find files by name in a shared folder",
  grep: "Search file contents in a shared folder",
}
const tools = computerToolCallSchema.options.map(({ shape: { tool, input } }) => ({
  tool: tool.value,
  name: `computers:${tool.value}`,
  summary: `${verbs[tool.value]} on one of your computers, or check the result of work you've already sent.`,
  schema: z.union([z.strictObject({ ...input.shape, computerId: z.string().min(1), waitMs }), followBody]),
}))
const definitions = [
  { name: "computers:list", summary: "List your computers and whether they can take work from this Workbot chat.", schema: listBody },
  ...tools,
]

function result(payload: Record<string, unknown>, isError = false): ExecuteCapabilityToolResult {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload }
}

function unknown() {
  return result({ error: "unknown_capability", message: "That tool isn't available to your account." }, true)
}

export const computerSource: CapabilitySource = {
  kind: "computers",
  parseName: (name) => definitions.some((entry) => entry.name === name) ? { kind: "computers", name } : null,
  async search(ctx, query, limit) {
    if (!ctx.sourceFilter.api || !ctx.member || !await organizationFeatureEnabled(ctx.organizationId, "computers", { userId: ctx.principal.userId })) return []
    return definitions.flatMap<CapabilityMatch>(({ name, summary, schema }) => {
      const score = scoreText(tokenize(name), tokenize(summary), tokenize(query))
      return score > 0 ? [{ name, path: name, method: "COMPUTER", kind: "computer", summary, score, pathParams: [], queryParams: [], hasBody: true,
        readOnly: name === "computers:list", argumentsSchema: z.toJSONSchema(schema, { unrepresentable: "any" }), invocation: { argumentsField: "body" } }] : []
    }).sort((a, b) => b.score - a.score).slice(0, limit)
  },
  enumerate: () => Promise.resolve([]),
  async execute(ctx, parsed, input) {
    if (parsed.kind !== "computers" || !ctx.member) return unknown()
    const actor = { organizationId: ctx.organizationId, memberId: ctx.member.orgMembershipId }
    const source = await resolveComputerSource(ctx.principal, actor)
    const caller = { ...actor, userId: normalizeDenTypeId("user", ctx.principal.userId),
      source: source ? { id: source.row.id, computer: projectComputer({ ...source.device, ownerMemberId: source.row.ownerMemberId }) } : null,
    }
    const invalid = () => result({ error: "invalid_request", message: "This tool didn't get the information it needs." }, true)
    if (parsed.name === "computers:list") {
      return listBody.safeParse(input.body ?? {}).success ? result(await listComputers(caller)) : invalid()
    }
    if (!ctx.principal.scopes.has(DEN_MCP_WRITE_SCOPE)) return result({ error: "insufficient_scope", message: "This sign-in doesn't have permission to use this tool." }, true)
    const definition = tools.find(({ name }) => name === parsed.name)
    if (!definition) return unknown()
    const body = definition.schema.safeParse(input.body)
    if (!body.success) return invalid()
    const args = body.data
    markFeaturesUsed({ organizationId: ctx.organizationId, memberId: caller.memberId, keys: ["computers"] })
    if ("id" in args) {
      const execution = await followComputerCommand(caller, args.id, args.waitMs)
      return execution ? result(execution, execution.state !== "running" && execution.state !== "done") : result({ error: "unknown_command", message: "That computer command could not be found." }, true)
    }
    const { computerId, waitMs: wait, ...fields } = args
    const call = computerToolCallSchema.safeParse({ tool: definition.tool, input: fields })
    if (!call.success) return invalid()
    const run = async () => {
      const execution = await runComputerTool(caller, computerId, call.data, wait)
      return result(execution, !("state" in execution) || (execution.state !== "running" && execution.state !== "done"))
    }
    if (!ctx.audit) return run()
    try {
      return await runMcpServiceAction(`computers.${definition.tool}`, ctx.audit, serviceAuditResourceId(computerId), run, { result: toolResultStatus })
    } catch (error) {
      if (error instanceof AuditUnavailableError) return auditUnavailableToolResult()
      throw error
    }
  },
}
