import { computerActionSchema } from "@openwork/types/den/computers"
import { z } from "zod"
import { DEN_MCP_WRITE_SCOPE } from "./scopes.js"
import { AuditUnavailableError, auditUnavailableToolResult, runMcpServiceAction, serviceAuditResourceId, toolResultStatus } from "../audit/mcp-service-audit.js"
import { followComputerCommand, listComputers, runComputerShell } from "../computers/service.js"
import { markFeaturesUsed } from "../feature-usage.js"
import { organizationFeatureEnabled } from "../features.js"
import type { CapabilitySource, ExecuteCapabilityToolResult } from "./capability-registry.js"
import { scoreText, tokenize, type CapabilityMatch } from "./search.js"

const listBody = z.strictObject({})
const waitMs = z.number().int().min(0).max(20_000).default(15_000)
const shellBody = z.union([
  computerActionSchema.options[0].omit({ type: true }).extend({ computerId: z.string().min(1), waitMs }).strict(),
  z.strictObject({ id: z.string().min(1), waitMs }),
])
const definitions = [
  { name: "computers:list", summary: "List your computers and whether they can take work from this Workbot chat.", schema: listBody },
  { name: "computers:shell", summary: "Check the result of a computer shell command by its ID. This tool can't send new work to your computers yet.", schema: shellBody },
]

function result(payload: Record<string, unknown>, isError = false): ExecuteCapabilityToolResult {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload }
}

function unknown() {
  return result({ error: "unknown_capability", message: "That tool isn't available to your account." }, true)
}

export const computerSource: CapabilitySource = {
  kind: "computers",
  parseName: (name) => name === "computers:list" || name === "computers:shell" ? { kind: "computers", name } : null,
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
    const caller = { organizationId: ctx.organizationId, principal: ctx.principal, memberId: ctx.member.orgMembershipId }
    const invalid = () => result({ error: "invalid_request", message: "This tool didn't get the information it needs." }, true)
    if (parsed.name === "computers:list") {
      return listBody.safeParse(input.body ?? {}).success ? result(await listComputers(caller)) : invalid()
    }
    if (!ctx.principal.scopes.has(DEN_MCP_WRITE_SCOPE)) return result({ error: "insufficient_scope", message: "This sign-in doesn't have permission to use this tool." }, true)
    const body = shellBody.safeParse(input.body)
    if (!body.success) return invalid()
    const args = body.data
    markFeaturesUsed({ organizationId: ctx.organizationId, memberId: caller.memberId, keys: ["computers"] })
    if ("id" in args) {
      const execution = await followComputerCommand(caller, args.id, args.waitMs)
      return execution ? result(execution, execution.state !== "running" && execution.state !== "done") : result({ error: "unknown_command", message: "That computer command could not be found." }, true)
    }
    const run = async () => {
      const { computerId, waitMs, ...fields } = args
      const execution = await runComputerShell(caller, computerId, { type: "shell", ...fields }, waitMs)
      return result(execution, !("state" in execution) || (execution.state !== "running" && execution.state !== "done"))
    }
    if (!ctx.audit) return run()
    try {
      return await runMcpServiceAction("computers.shell", ctx.audit, serviceAuditResourceId(args.computerId), run, { result: toolResultStatus })
    } catch (error) {
      if (error instanceof AuditUnavailableError) return auditUnavailableToolResult()
      throw error
    }
  },
}
