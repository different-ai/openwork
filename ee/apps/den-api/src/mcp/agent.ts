import { StreamableHTTPTransport } from "@hono/mcp"
import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  EXECUTE_CAPABILITY_ANNOTATIONS,
  EXECUTE_CAPABILITY_TOOL_NAME,
  SEARCH_CAPABILITIES_ANNOTATIONS,
  SEARCH_CAPABILITIES_OUTPUT_SCHEMA,
  SEARCH_CAPABILITIES_TOOL_NAME,
  capabilitySearchToolResult,
  createConnectMcpServer,
  createConnectRuntime,
  executeCapabilityWithBudget as executeCapabilityWithSharedBudget,
  registerConnectTools,
  textContent,
  type ConnectCapabilitySource,
  type ConnectToolResult,
} from "@openwork/connect-core"
import type { Hono } from "hono"
import { memberFacingMcpConnectionsEnabled } from "../capability-sources/external-mcp-rollout.js"
import { publicRoute, tokenRoute } from "../middleware/index.js"
import { db } from "../db.js"
import { getMcpResourceContext, verifyMcpRequest } from "./auth.js"
import { invokeMcpOperation, normalizeToolBody, normalizeToolRecord } from "./invoke.js"
import { getCatalog, protectedResourceMetadata } from "./index.js"
import { preflightMcpJsonRpcRequest } from "./json-rpc-preflight.js"
import { searchCapabilities } from "./search.js"
import { executeExternalCapability, externalMcpSearchCoverageHint, parseExternalCapabilityName, resolveMcpMemberIdentity, searchExternalCapabilities, type ExternalCapabilityExecuteResult } from "./external-capabilities.js"
import { executeMarketplaceCapability, parseMarketplaceCapabilityName, searchMarketplaceCapabilities, type MarketplaceCapabilityObjectType } from "./marketplace-capabilities.js"
import { executeSkillCapability, parseSkillCapabilityName, searchSkillCapabilities } from "./skill-capabilities.js"
import { resolvePublicOrigin } from "../capability-sources/generic-oauth.js"
import { env } from "../env.js"
import { isPlatformAdminUserId } from "../middleware/admin.js"
import { executeAvailableAdminCapability, parseAdminCapabilityName, searchAvailableAdminCapabilities } from "./admin-capabilities.js"

const skillMarketplaceObjectTypes: MarketplaceCapabilityObjectType[] = ["skill"]
export const EXECUTE_CAPABILITY_TIMEOUT_MS = 180_000
export {
  EXECUTE_CAPABILITY_ANNOTATIONS,
  EXECUTE_CAPABILITY_TOOL_NAME,
  SEARCH_CAPABILITIES_ANNOTATIONS,
  SEARCH_CAPABILITIES_OUTPUT_SCHEMA,
  SEARCH_CAPABILITIES_TOOL_NAME,
  capabilitySearchToolResult,
}

export const AGENT_MCP_INSTRUCTIONS = [
  "This OpenWork Cloud connection intentionally exposes exactly two tools: search_capabilities and execute_capability.",
  "Capabilities include native Google Workspace operations (Gmail read/search, Calendar list/create, Drive search/read, and Gmail draft creation) executed with the signed-in member's organization credentials, plus any MCP connections the organization has added.",
  "Allowlisted platform admins can also discover namespaced OpenWork Admin capabilities through this same connection; other members cannot discover or execute them.",
  "Always call search_capabilities first with 2-4 keyword variants before concluding something is unavailable. Use execute_capability only with exact names returned by search_capabilities.",
  "Do not tell users to configure OAuth clients or local extensions for these capabilities; organization connections are managed in the OpenWork Cloud dashboard / Settings > Connect.",
  "A successful search_capabilities call proves this OpenWork Cloud MCP connection is authorized. Never tell the user to reconnect OpenWork Cloud because a downstream connector failed.",
  "When a match has kind connection_status, name connectionStatus.connectionName and relay connectionStatus.action exactly. Distinguish the member's Your Connections page, the organization Connections dashboard, and the provider's own admin console.",
  "Connection probes are live. After the requested human fixes that connector, search again in the same task; otherwise do not retry unchanged or improvise workarounds through other tools.",
].join("\n")

const EXECUTE_CAPABILITY_TIMEOUT_MESSAGE = `The capability call exceeded ${EXECUTE_CAPABILITY_TIMEOUT_MS / 1_000}s. Retry once; if it times out again, narrow the request (fewer results, tighter query) and tell the user the service is slow — do NOT tell them to reconfigure or reconnect.`

export type ExecuteCapabilityToolResult = ConnectToolResult

export function externalCapabilityErrorToolResult(
  result: Exclude<ExternalCapabilityExecuteResult, { ok: true }>,
): ExecuteCapabilityToolResult {
  return {
    isError: true,
    content: textContent(JSON.stringify({
      error: result.error,
      message: result.message,
      ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
      ...(result.actionOwner ? { actionOwner: result.actionOwner } : {}),
      ...(result.operatorAction ? { operatorAction: result.operatorAction } : {}),
      ...(result.connectionStatus ? { connectionStatus: result.connectionStatus } : {}),
    })),
  }
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

export async function executeCapabilityWithBudget<T extends ExecuteCapabilityToolResult>(input: {
  capability: string
  timeoutMs?: number
  invoke: () => Promise<T>
}): Promise<T | ExecuteCapabilityToolResult> {
  return executeCapabilityWithSharedBudget({
    ...input,
    timeoutMessage: EXECUTE_CAPABILITY_TIMEOUT_MESSAGE,
  })
}

export function createAgentMcpServer() {
  return createConnectMcpServer({
    name: "openwork-den-api-agent",
    version: "1.0.0",
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
    c.json(protectedResourceMetadata(c.req.raw, "agent")))
  app.get("/mcp/agent/.well-known/oauth-protected-resource", publicRoute, (c) =>
    c.json(protectedResourceMetadata(c.req.raw, "agent")))

  app.all("/mcp/agent", tokenRoute, async (c) => {
    const requestIdValue = c.get("requestId")
    const requestId = typeof requestIdValue === "string" ? requestIdValue : "unknown"
    const principal = await verifyMcpRequest(
      c.req.raw.headers,
      getMcpResourceContext(c.req.raw, "agent", requestId),
    )
    if (principal instanceof Response) {
      return principal
    }

    const preflightResponse = await preflightMcpJsonRpcRequest(c.req.raw, requestId)
    if (preflightResponse) {
      return preflightResponse
    }

    const catalog = await getCatalog(app as unknown as Hono, c.env)
    // External MCP connections are scoped to the calling MEMBER (grants +
    // per-member credentials), not just the org — resolve who this token's
    // user is within the org once per request.
    const memberIdentity = await resolveMcpMemberIdentity({
      userId: principal.userId,
      organizationId: principal.organizationId,
    })
    let platformAdmin: Promise<boolean> | undefined
    const resolvePlatformAdmin = () => {
      platformAdmin ??= isPlatformAdminUserId(principal.userId)
      return platformAdmin
    }
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
    const sources: ConnectCapabilitySource[] = [
      {
        id: "den-api",
        types: ["api"],
        search: ({ query, limit }) => ({ matches: searchCapabilities(catalog, query, limit) }),
        canExecute: (name) => catalog.some((candidate) => candidate.name === name),
        execute: async ({ name, path, query, body }) => {
          const operation = catalog.find((candidate) => candidate.name === name)
          if (!operation) {
            return { isError: true, content: textContent(unknownCapabilityText(name)) }
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
      },
      {
        id: "den-admin",
        types: ["admin"],
        search: async ({ query, limit }) => ({
          matches: await searchAvailableAdminCapabilities(await resolvePlatformAdmin(), query, limit),
        }),
        canExecute: (name) => Boolean(parseAdminCapabilityName(name)),
        execute: async ({ name, body }) => {
          const result = await executeAvailableAdminCapability(await resolvePlatformAdmin(), name, body)
          return result ?? { isError: true, content: textContent(unknownCapabilityText(name)) }
        },
      },
      {
        id: "den-external-mcp",
        types: ["mcp"],
        search: async ({ query, limit }) => {
          if (!externalMcpConnectionsEnabled) return { matches: [] }
          let coverageHint: string | undefined
          const matches = await searchExternalCapabilities({
            organizationId: principal.organizationId,
            member: memberIdentity,
            query,
            redirectUriBase: resolvePublicOrigin(c.req.raw, env.apiPublicUrl),
            limit,
            reportCoverage: (coverage) => {
              coverageHint = externalMcpSearchCoverageHint(coverage)
            },
          })
          return { matches, ...(coverageHint ? { hint: coverageHint } : {}) }
        },
        canExecute: (name) => externalMcpConnectionsEnabled && Boolean(parseExternalCapabilityName(name)),
        execute: async ({ name, body }) => {
          const external = parseExternalCapabilityName(name)
          if (!external || !externalMcpConnectionsEnabled) {
            return { isError: true, content: textContent(unknownCapabilityText(name)) }
          }
          const result = await executeExternalCapability({
            organizationId: principal.organizationId,
            member: memberIdentity,
            connectionId: external.connectionId,
            toolName: external.toolName,
            args: normalizedExternalArgs(body),
            redirectUriBase: resolvePublicOrigin(c.req.raw, env.apiPublicUrl),
          })
          if (!result.ok) return externalCapabilityErrorToolResult(result)
          return { content: externalToolContent(result.result) }
        },
      },
      {
        id: "den-marketplace",
        types: ["marketplace", "skills"],
        search: async ({ query, limit, type }) => ({
          matches: externalMcpConnectionsEnabled
            ? await searchMarketplaceCapabilities({
              organizationId: principal.organizationId,
              member: memberIdentity,
              objectTypes: type === "skills" ? skillMarketplaceObjectTypes : undefined,
              query,
              limit,
              enabled: externalMcpConnectionsEnabled,
            })
            : [],
        }),
        canExecute: (name) => externalMcpConnectionsEnabled && Boolean(parseMarketplaceCapabilityName(name)),
        execute: async ({ name, body }) => {
          const marketplace = parseMarketplaceCapabilityName(name)
          if (!marketplace) {
            return { isError: true, content: textContent(unknownCapabilityText(name)) }
          }
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
        },
      },
      {
        id: "den-skills",
        types: ["skills"],
        search: async ({ query, limit }) => ({
          matches: await searchSkillCapabilities({
            organizationId: principal.organizationId,
            member: memberIdentity,
            query,
            limit,
          }),
        }),
        canExecute: (name) => Boolean(parseSkillCapabilityName(name)),
        execute: async ({ name }) => {
          const skillId = parseSkillCapabilityName(name)
          if (!skillId) {
            return { isError: true, content: textContent(unknownCapabilityText(name)) }
          }
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
        },
      },
    ]
    const runtime = createConnectRuntime({
      sources,
      executeTimeoutMs: EXECUTE_CAPABILITY_TIMEOUT_MS,
      executeTimeoutMessage: EXECUTE_CAPABILITY_TIMEOUT_MESSAGE,
    })
    registerConnectTools(server, runtime, {
      searchDescription: [
        "Search for a capability by keyword. This connection only exposes this tool and execute_capability —",
        "there is no list of individually-named tools to browse. Always search first.",
        "Search covers native Google Workspace capabilities, org-connected external MCPs, marketplace objects, skills, and namespaced OpenWork Admin tools for allowlisted platform admins.",
        "Try 2-4 keyword variants before deciding a capability is unavailable.",
        "Each match includes pathParams/queryParams/hasBody describing exactly what execute_capability needs.",
      ].join(" "),
      executeDescription: [
        "Call a capability found via search_capabilities by its exact name.",
        "Pass path/query/body only as described by that match's pathParams/queryParams/hasBody.",
        "For skill:<id> matches, this returns that skill's stored SKILL.md content.",
      ].join(" "),
    })

    const transport = new StreamableHTTPTransport()
    await server.connect(transport)
    const response = await transport.handleRequest(c)
    return response ?? new Response(null, { status: 204 })
  })
}
