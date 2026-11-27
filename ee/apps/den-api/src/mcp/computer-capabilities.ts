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
  { name: "computers:list", summary: "List your computers and what this Workbot computer can access.", schema: listBody },
  { name: "computers:shell", summary: "Run a shell command in a desktop computer's shared sandbox, or follow a command by id. Only Workbot can start a command.", schema: shellBody },
]

function result(payload: Record<string, unknown>, isError = false): ExecuteCapabilityToolResult {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload }
}

function unknown(name: string) {
  return result({ error: "unknown_capability", message: `No capability named "${name}". Call search_capabilities to find a valid name.` }, true)
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
    if (parsed.kind !== "computers" || !ctx.member) return unknown(input.name)
    const caller = { organizationId: ctx.organizationId, principal: ctx.principal, memberId: ctx.member.orgMembershipId }
    const invalid = () => result({ error: "invalid_request", message: "The computer capability arguments are invalid." }, true)
    if (parsed.name === "computers:list") {
      return listBody.safeParse(input.body ?? {}).success ? result(await listComputers(caller)) : invalid()
    }
    if (!ctx.principal.scopes.has(DEN_MCP_WRITE_SCOPE)) return result({ error: "insufficient_scope", message: "This capability requires the mcp:write scope." }, true)
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
