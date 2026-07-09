import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import { StreamableHTTPTransport } from "@hono/mcp"
import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { z } from "zod"
import { memberFacingMcpConnectionsEnabled } from "../capability-sources/external-mcp-rollout.js"
import { publicRoute, tokenRoute } from "../middleware/index.js"
import { db } from "../db.js"
import { getMcpResourceUrl, verifyMcpRequest } from "./auth.js"
import { invokeMcpOperation, normalizeToolBody, normalizeToolRecord } from "./invoke.js"
import { getCatalog, protectedResourceMetadata } from "./index.js"
import { SEARCH_CAPABILITIES_TOOL_NAME, searchCapabilities, searchCapabilitySourceFilter } from "./search.js"
import { executeExternalCapability, parseExternalCapabilityName, resolveMcpMemberIdentity, searchExternalCapabilities } from "./external-capabilities.js"
import { executeMarketplaceCapability, parseMarketplaceCapabilityName, searchMarketplaceCapabilities, type MarketplaceCapabilityObjectType } from "./marketplace-capabilities.js"
import { executeSkillCapability, parseSkillCapabilityName, searchSkillCapabilities } from "./skill-capabilities.js"
import { resolvePublicOrigin } from "../capability-sources/generic-oauth.js"
import { env } from "../env.js"

export const EXECUTE_CAPABILITY_TOOL_NAME = "execute_capability"
const searchCapabilityTypeSchema = z.enum(["all", "api", "mcp", "marketplace", "skills"])
const skillMarketplaceObjectTypes: MarketplaceCapabilityObjectType[] = ["skill"]
export const EXECUTE_CAPABILITY_TIMEOUT_MS = 45_000

export const AGENT_MCP_INSTRUCTIONS = [
  "This OpenWork Cloud connection intentionally exposes exactly two tools: search_capabilities and execute_capability.",
  "Capabilities include native Google Workspace operations (Gmail read/search, Calendar list/create, Drive search/read, and Gmail draft creation) executed with the signed-in member's organization credentials, plus any MCP connections the organization has added.",
  "Always call search_capabilities first with 2-4 keyword variants before concluding something is unavailable. Use execute_capability only with exact names returned by search_capabilities.",
  "Do not tell users to configure OAuth clients or local extensions for these capabilities; organization connections are managed in the OpenWork Cloud dashboard / Settings > Connect.",
].join("\n")

const EXECUTE_CAPABILITY_TIMEOUT_MESSAGE = "The capability call exceeded 45s. Retry once; if it times out again, narrow the request (fewer results, tighter query) and tell the user the service is slow — do NOT tell them to reconfigure or reconnect."

export type ExecuteCapabilityToolResult = {
  isError?: boolean
  content: { text: string; type: "text" }[]
}

function textContent(text: string): { text: string; type: "text" }[] {
  return [{ type: "text", text }]
}

function unknownCapabilityText(name: string): string {
  return JSON.stringify({
    error: "unknown_capability",
    message: `No capability named "${name}". Call search_capabilities to find a valid name.`,
  })
}

function normalizedExternalArgs(body: unknown): Record<string, unknown> {
  const normalizedBody = normalizeToolBody(body)
  if (typeof normalizedBody !== "object" || normalizedBody === null || Array.isArray(normalizedBody)) {
    return {}
  }
  const args: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(normalizedBody)) {
    args[key] = value
  }
  return args
}

function isTextContent(value: unknown): value is { type: "text"; text: string } {
  return typeof value === "object"
    && value !== null
    && "type" in value
    && value.type === "text"
    && "text" in value
    && typeof value.text === "string"
}

function externalToolContent(result: unknown): { type: "text"; text: string }[] {
  if (typeof result === "object" && result !== null && "content" in result && Array.isArray(result.content) && result.content.every(isTextContent)) {
    return result.content
  }
  return textContent(JSON.stringify(result))
}

function capabilityTimeoutResult(capability: string): ExecuteCapabilityToolResult {
  return {
    isError: true,
    content: textContent(JSON.stringify({
      error: "capability_timeout",
      capability,
      message: EXECUTE_CAPABILITY_TIMEOUT_MESSAGE,
    })),
  }
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
    return true
  }
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return true
  }
  return error instanceof Error && /\b(time(?:d)? out|timeout)\b/i.test(error.message)
}

export async function executeCapabilityWithBudget<T extends ExecuteCapabilityToolResult>(input: {
  capability: string
  timeoutMs?: number
  invoke: () => Promise<T>
}): Promise<T | ExecuteCapabilityToolResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutResult = new Promise<ExecuteCapabilityToolResult>((resolve) => {
    timeout = setTimeout(() => resolve(capabilityTimeoutResult(input.capability)), input.timeoutMs ?? EXECUTE_CAPABILITY_TIMEOUT_MS)
  })
  try {
    const invocation = input.invoke()
    void invocation.catch(() => undefined)
    return await Promise.race([invocation, timeoutResult])
  } catch (error) {
    if (isTimeoutError(error)) {
      return capabilityTimeoutResult(input.capability)
    }
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export function createAgentMcpServer(): McpServer {
  return new McpServer({
    name: "openwork-den-api-agent",
    version: "1.0.0",
  }, {
    instructions: AGENT_MCP_INSTRUCTIONS,
  })
}

/**
 * The minimal, harness-facing MCP surface: exactly two tools, full stop.
 *
 * `/mcp` (index.ts) stays exactly as it is — every catalog operation
 * individually registered, ~129 tools today. That's unchanged and still
 * useful for scripts/admin tooling that want to call a known operation by
 * name directly.
 *
 * `/mcp/agent` is a *different* endpoint for a *different* consumer: the
 * desktop app's "OpenWork Cloud Control" connection, which is what an
 * OpenCode/Claude Code/Codex-style harness actually sees. It registers only
 * `search_capabilities` and `execute_capability`, both backed by the exact
 * same catalog and the exact same `invokeMcpOperation` execute path used by
 * the rich endpoint — no new auth, no new policy, no new execution logic.
 * A harness connected here can only discover and call capabilities through
 * these two tools; the other ~127 operations are not individually callable
 * on this endpoint.
 */
export function registerAgentMcpRoutes<T extends { Variables: Record<string, unknown> }>(app: Hono<T>) {
  app.get("/.well-known/oauth-protected-resource/mcp/agent", publicRoute, (c) =>
    c.json(protectedResourceMetadata(c.req.raw)))
  app.get("/mcp/agent/.well-known/oauth-protected-resource", publicRoute, (c) =>
    c.json(protectedResourceMetadata(c.req.raw)))

  app.all("/mcp/agent", tokenRoute, async (c) => {
    const principal = await verifyMcpRequest(c.req.raw.headers, getMcpResourceUrl(c.req.raw))
    if (principal instanceof Response) {
      return principal
    }

    const catalog = await getCatalog(app as unknown as Hono, c.env)
    // External MCP connections are scoped to the calling MEMBER (grants +
    // per-member credentials), not just the org — resolve who this token's
    // user is within the org once per request.
    const memberIdentity = await resolveMcpMemberIdentity({
      userId: principal.userId,
      organizationId: principal.organizationId,
    })
    const organizationId = normalizeDenTypeId("organization", principal.organizationId)
    const organizationRows = await db
      .select({ metadata: OrganizationTable.metadata })
      .from(OrganizationTable)
      .where(eq(OrganizationTable.id, organizationId))
      .limit(1)
    const externalMcpConnectionsEnabled = memberFacingMcpConnectionsEnabled(organizationRows[0]?.metadata, {
      gatingEnabled: env.mcpConnectionsGatingEnabled,
    })
    const server = createAgentMcpServer()

    server.registerTool(
      SEARCH_CAPABILITIES_TOOL_NAME,
      {
        title: "Search capabilities",
        description: [
          "Search for a capability by keyword. This connection only exposes this tool and execute_capability —",
          "there is no list of individually-named tools to browse. Always search first.",
          "Search covers native Google Workspace capabilities (Gmail, Calendar, Drive, Gmail drafts) and org-connected external MCPs such as Notion, Linear, Slack, or other services added in the OpenWork Cloud dashboard / Settings > Connect.",
          "Try 2-4 keyword variants before deciding a capability is unavailable.",
          "Each match includes pathParams/queryParams/hasBody describing exactly what execute_capability needs.",
          "Skill matches use method SKILL and return stored SKILL.md content when executed.",
        ].join(" "),
        inputSchema: z.object({
          query: z.string().min(1).describe("Keywords describing the capability you need, e.g. \"create organization\" or \"list workers\"."),
          limit: z.number().int().min(1).max(20).optional().describe("Max number of matches to return. Defaults to 5."),
          type: searchCapabilityTypeSchema.optional().describe("Optional source filter. all searches every source; api searches Den API capabilities; mcp searches connected external MCP tools; marketplace searches marketplace plugin capabilities; skills searches native skills and marketplace skill objects. Defaults to all."),
        }),
      },
      async ({ query, limit, type }) => {
        const boundedLimit = limit ?? 5
        const sourceFilter = searchCapabilitySourceFilter(type)
        const marketplaceObjectTypes = type === "skills" ? skillMarketplaceObjectTypes : undefined
        const restMatches = sourceFilter.api ? searchCapabilities(catalog, query, boundedLimit) : []
        // Merged in from each connected External MCP Connection's live
        // tools/list (capability-sources/external-mcp-client.ts) — a
        // Notion/Linear/Stripe/... connection an admin added in Den shows
        // up here exactly like any native capability, ranked together.
        const externalMatches = sourceFilter.mcp && externalMcpConnectionsEnabled
          ? await searchExternalCapabilities({
            organizationId: principal.organizationId,
            member: memberIdentity,
            query,
            redirectUriBase: resolvePublicOrigin(c.req.raw, env.apiPublicUrl),
            limit: boundedLimit,
          })
          : []
        const marketplaceMatches = sourceFilter.marketplace && externalMcpConnectionsEnabled
          ? await searchMarketplaceCapabilities({
            organizationId: principal.organizationId,
            member: memberIdentity,
            objectTypes: marketplaceObjectTypes,
            query,
            limit: boundedLimit,
            enabled: externalMcpConnectionsEnabled,
          })
          : []
        const skillMatches = sourceFilter.skills
          ? await searchSkillCapabilities({
            organizationId: principal.organizationId,
            member: memberIdentity,
            query,
            limit: boundedLimit,
          })
          : []
        const matches = [...restMatches, ...externalMatches, ...marketplaceMatches, ...skillMatches]
          .sort((a, b) => b.score - a.score)
          .slice(0, boundedLimit)
        const text = matches.length > 0
          ? JSON.stringify({ matches }, null, 2)
          : JSON.stringify({ matches: [], hint: "No matches. Try broader or different keywords." }, null, 2)
        return { content: [{ type: "text" as const, text }] }
      },
    )

    server.registerTool(
      EXECUTE_CAPABILITY_TOOL_NAME,
      {
        title: "Execute capability",
        description: [
          "Call a capability found via search_capabilities, by its exact name.",
          "Pass path/query/body only as described by that match's pathParams/queryParams/hasBody.",
          "For skill:<id> matches, this returns that skill's stored SKILL.md content.",
          "Returns unknown_capability if name doesn't match a current capability — call search_capabilities again.",
        ].join(" "),
        inputSchema: z.object({
          name: z.string().min(1).describe("The exact tool name returned by search_capabilities."),
          path: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().describe("Path parameters, only if the match's pathParams is non-empty."),
          query: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().describe("Query parameters, only if the match's queryParams is non-empty."),
          body: z.unknown().optional().describe("JSON body, only if the match's hasBody is true."),
        }),
      },
      async ({ name, path, query, body }) => {
        return executeCapabilityWithBudget({
          capability: name,
          invoke: async (): Promise<ExecuteCapabilityToolResult> => {
            const external = parseExternalCapabilityName(name)
            if (external) {
              if (!externalMcpConnectionsEnabled) {
                return {
                  isError: true,
                  content: textContent(JSON.stringify({
                    error: "unknown_capability",
                    message: "No external MCP connection capabilities are available for this organization.",
                  })),
                }
              }
              const result = await executeExternalCapability({
                organizationId: principal.organizationId,
                member: memberIdentity,
                connectionId: external.connectionId,
                toolName: external.toolName,
                args: normalizedExternalArgs(body),
                redirectUriBase: resolvePublicOrigin(c.req.raw, env.apiPublicUrl),
              })
              if (!result.ok) {
                return {
                  isError: true,
                  content: textContent(JSON.stringify({ error: result.error, message: result.message })),
                }
              }
              // The SDK's callTool() can return either the standard {content:[...]}
              // shape or a legacy-compatibility {toolResult} shape; normalize to
              // what McpServer's own tool callback contract requires.
              return { content: externalToolContent(result.result) }
            }

            const marketplace = parseMarketplaceCapabilityName(name)
            if (marketplace) {
              const result = await executeMarketplaceCapability({
                organizationId: principal.organizationId,
                member: memberIdentity,
                pluginId: marketplace.pluginId,
                configObjectId: marketplace.configObjectId,
                body,
                enabled: externalMcpConnectionsEnabled,
              })
              if (!result.ok) {
                return {
                  isError: true,
                  content: textContent(result.error === "unknown_capability"
                    ? unknownCapabilityText(name)
                    : JSON.stringify({ error: result.error, message: result.message })),
                }
              }
              return { content: textContent(JSON.stringify(result.result, null, 2)) }
            }

            const skillId = parseSkillCapabilityName(name)
            if (skillId) {
              const result = await executeSkillCapability({
                organizationId: principal.organizationId,
                member: memberIdentity,
                skillId,
              })
              if (!result.ok) {
                return {
                  isError: true,
                  content: textContent(JSON.stringify({ error: result.error, message: result.message })),
                }
              }
              return {
                content: textContent(JSON.stringify({
                  skill: {
                    id: result.skill.id,
                    title: result.skill.title,
                    description: result.skill.description,
                    skillText: result.skill.skillText,
                    updatedAt: result.skill.updatedAt,
                  },
                }, null, 2)),
              }
            }

            const operation = catalog.find((candidate) => candidate.name === name)
            if (!operation) {
              return {
                isError: true,
                content: textContent(unknownCapabilityText(name)),
              }
            }

            return invokeMcpOperation({
              app: app as unknown as Hono,
              env: c.env,
              operation,
              principal,
              toolInput: {
                path: normalizeToolRecord(path),
                query: normalizeToolRecord(query),
                body: normalizeToolBody(body),
              },
            })
          },
        })
      },
    )

    const transport = new StreamableHTTPTransport()
    await server.connect(transport)
    const response = await transport.handleRequest(c)
    return response ?? new Response(null, { status: 204 })
  })
}
