import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ErrorCode, McpError, type ToolAnnotations } from "@modelcontextprotocol/sdk/types.js"
import { StreamableHTTPTransport } from "@hono/mcp"
import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { openworkCloudMcpConnectionActionSchema } from "@openwork/types/den/mcp-connection-action"
import type { Hono } from "hono"
import { z } from "zod"
import { memberFacingMcpConnectionsEnabled } from "../capability-sources/external-mcp-rollout.js"
import { EXTERNAL_MCP_DIAGNOSTIC_PHASES } from "../capability-sources/external-mcp-diagnostics.js"
import { publicRoute, tokenRoute } from "../middleware/index.js"
import { db } from "../db.js"
import { getMcpResourceContext, verifyMcpRequest } from "./auth.js"
import { invokeMcpOperation, normalizeToolBody, normalizeToolRecord } from "./invoke.js"
import { getCatalog, protectedResourceMetadata } from "./index.js"
import { preflightMcpJsonRpcRequest } from "./json-rpc-preflight.js"
import { compareCapabilityMatches, SEARCH_CAPABILITIES_TOOL_NAME, searchCapabilities, searchCapabilitySourceFilter, type CapabilityMatch } from "./search.js"
import { executeExternalCapability, externalMcpSearchCoverageHint, parseExternalCapabilityName, resolveMcpMemberIdentity, searchExternalCapabilities, type ExternalCapabilityExecuteResult } from "./external-capabilities.js"
import { executeMarketplaceCapability, parseMarketplaceCapabilityName, searchMarketplaceCapabilities, type MarketplaceCapabilityObjectType } from "./marketplace-capabilities.js"
import { executeSkillCapability, parseSkillCapabilityName, searchSkillCapabilities } from "./skill-capabilities.js"
import { resolvePublicOrigin } from "../capability-sources/generic-oauth.js"
import { env } from "../env.js"
import { isPlatformAdminUserId } from "../middleware/admin.js"
import { executeAvailableAdminCapability, parseAdminCapabilityName, searchAvailableAdminCapabilities } from "./admin-capabilities.js"

export const EXECUTE_CAPABILITY_TOOL_NAME = "execute_capability"
const searchCapabilityTypeSchema = z.enum(["all", "api", "admin", "mcp", "marketplace", "skills"])
const skillMarketplaceObjectTypes: MarketplaceCapabilityObjectType[] = ["skill"]
export const EXECUTE_CAPABILITY_TIMEOUT_MS = 180_000
export const SEARCH_CAPABILITIES_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
}
export const EXECUTE_CAPABILITY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
}

const externalMcpDiagnosticOutputSchema = z.object({
  referenceId: z.string(),
  phase: z.enum(EXTERNAL_MCP_DIAGNOSTIC_PHASES),
  category: z.string(),
  code: z.string(),
  highestPassed: z.enum(["configured", "reachable", "authorized", "protocol_ready", "catalog_ready", "operation_ready"]),
  retryable: z.boolean(),
  actionOwner: z.enum(["openwork", "network_admin", "provider_admin", "organization_admin", "member"]),
  operatorAction: z.string(),
  message: z.string(),
  httpStatus: z.number().int().optional(),
  operationPhase: z.enum(EXTERNAL_MCP_DIAGNOSTIC_PHASES).optional(),
  outbound: z.object({ origin: z.string(), pathHash: z.string() }).optional(),
  providerRequestId: z.string().optional(),
  providerStatus: z.number().int().optional(),
  providerCode: z.string().optional(),
  payloadBytes: z.number().int().optional(),
  jsonRpcCode: z.number().int().optional(),
})

const connectionStatusOutputSchema = openworkCloudMcpConnectionActionSchema.extend({
  layer: z.enum(["mcp_connection", "downstream_provider"]),
  errorCode: z.enum(["not_connected", "invalid_refresh_token", "invalid_grant", "unauthorized", "provider_error"]),
  message: z.string(),
  action: z.object({
    type: z.enum(["connect", "reconnect", "update_credentials", "inspect_connection", "fix_provider", "fix_network", "contact_openwork"]),
    label: z.string(),
    surface: z.enum(["openwork_your_connections", "openwork_organization_connections", "provider_admin_console", "network_infrastructure", "openwork_support"]),
    retry: z.literal("search_capabilities"),
    url: z.string().url().optional(),
  }),
  diagnostic: externalMcpDiagnosticOutputSchema.optional(),
})

const capabilityMatchOutputSchema = z.object({
  name: z.string(),
  method: z.string(),
  path: z.string(),
  score: z.number(),
  summary: z.string(),
  pathParams: z.array(z.string()),
  queryParams: z.array(z.string()),
  hasBody: z.boolean(),
  bodySchema: z.unknown().optional(),
  argumentsSchema: z.unknown().optional(),
  schemaDigest: z.string().optional(),
  invocation: z.object({ argumentsField: z.literal("body") }).optional(),
  kind: z.string().optional(),
  status: z.string().optional(),
  hint: z.string().optional(),
  connectionStatus: connectionStatusOutputSchema.optional(),
}).passthrough()

export const SEARCH_CAPABILITIES_OUTPUT_SCHEMA = z.object({
  matches: z.array(capabilityMatchOutputSchema),
  hint: z.string().optional(),
})

export const AGENT_MCP_INSTRUCTIONS = [
  "This OpenWork Cloud connection intentionally exposes exactly two tools: search_capabilities and execute_capability.",
  "Capabilities include native Google Workspace operations (Gmail read/search, Calendar list/create, Drive search/read, and Gmail draft creation) executed with the signed-in member's organization credentials, plus any MCP connections the organization has added.",
  "Allowlisted platform admins can also discover namespaced OpenWork Admin capabilities through this same connection; other members cannot discover or execute them.",
  "Always call search_capabilities first with 2-4 keyword variants before concluding something is unavailable. Use execute_capability only with exact names returned by search_capabilities.",
  "For a request to add a public GitHub plugin to an organization marketplace, search for the marketplace list, GitHub plugin import preview, GitHub plugin marketplace import, and resolved marketplace detail capabilities. Preview first; do not recreate the plugin by hand.",
  "Before importing, confirm the target marketplace, selected skill/server keys, and who can use them. Do not choose one authentication type for every server: the import route resolves known presets and plugin declarations, while the request authType is only a fallback for unknown servers.",
  "After importing, retrieve the resolved marketplace detail and report each plugin's cloudReadiness. An import or plugin binding is not proof that an MCP connection is usable. Relay needs_admin_setup or needs_signin as the next human action instead of claiming the connection is ready.",
  "Do not invent OAuth-client, credential, or local-extension setup. Organization connections are managed in the OpenWork Cloud dashboard / Settings > Connect. When a returned connection or marketplace readiness state requires administrator setup or member sign-in, relay that exact action.",
  "A successful search_capabilities call proves this OpenWork Cloud MCP connection is authorized. Never tell the user to reconnect OpenWork Cloud because a downstream connector failed.",
  "External MCP matches include the provider-advertised argumentsSchema, schemaDigest, and invocation.argumentsField. Put an object matching argumentsSchema in execute_capability.body and copy schemaDigest into execute_capability.schemaDigest.",
  "OpenWork always attempts the downstream provider call when local schema checks find a mismatch. schemaGuidance is advisory and appears alongside the provider result: if the provider succeeded, accept that result and do not retry solely because of the warning; if it failed, use the warning to correct the arguments or search again.",
  "If the provider returns invalid_capability_arguments, correct the listed issues and retry once with changed arguments; never retry the same arguments unchanged. If it returns unknown_capability, call search_capabilities again before retrying.",
  "When a match has kind connection_status, name connectionStatus.connectionName and relay connectionStatus.action exactly. Distinguish the member's Your Connections page, the organization Connections dashboard, and the provider's own admin console.",
  "Connection probes are live. After the requested human fixes that connector, search again in the same task; otherwise do not retry unchanged or improvise workarounds through other tools.",
].join("\n")

const EXECUTE_CAPABILITY_TIMEOUT_MESSAGE = `The capability call exceeded ${EXECUTE_CAPABILITY_TIMEOUT_MS / 1_000}s. Retry once; if it times out again, narrow the request (fewer results, tighter query) and tell the user the service is slow — do NOT tell them to reconfigure or reconnect.`

export type ExecuteCapabilityToolResult = {
  isError?: boolean
  content: { text: string; type: "text" }[]
}

function textContent(text: string): { text: string; type: "text" }[] {
  return [{ type: "text", text }]
}

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
      ...(result.capability ? { capability: result.capability } : {}),
      ...(result.issues ? { issues: result.issues } : {}),
      ...(result.schemaDigest ? { schemaDigest: result.schemaDigest } : {}),
      ...(result.sameArgumentsRetryable === false ? { sameArgumentsRetryable: false } : {}),
      ...(result.retry ? { retry: result.retry } : {}),
      ...(result.schemaGuidance ? { schemaGuidance: result.schemaGuidance } : {}),
    })),
  }
}

export function capabilitySearchToolResult<T extends CapabilityMatch>(matches: T[], coverageHint?: string) {
  const hint = [
    ...(matches.length === 0 ? ["No matches. Try broader or different keywords."] : []),
    ...(coverageHint ? [coverageHint] : []),
  ].join(" ")
  const result = hint ? { matches, hint } : { matches }
  return {
    content: textContent(JSON.stringify(result, null, 2)),
    structuredContent: result,
  }
}

function unknownCapabilityText(name: string): string {
  return JSON.stringify({
    error: "unknown_capability",
    message: `No capability named "${name}". Call search_capabilities to find a valid name.`,
  })
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

export function externalCapabilitySuccessToolResult(
  result: Extract<ExternalCapabilityExecuteResult, { ok: true }>,
): ExecuteCapabilityToolResult {
  const content = externalToolContent(result.result)
  if (!result.schemaGuidance) return { content }
  return {
    content: [
      ...content,
      ...textContent(JSON.stringify({ schemaGuidance: result.schemaGuidance })),
    ],
  }
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

    server.registerTool(
      SEARCH_CAPABILITIES_TOOL_NAME,
      {
        title: "Search capabilities",
        description: [
          "Search for a capability by keyword. This connection only exposes this tool and execute_capability —",
          "there is no list of individually-named tools to browse. Always search first.",
          "Search covers native Google Workspace capabilities (Gmail, Calendar, Drive, Gmail drafts), org-connected external MCPs, and namespaced OpenWork Admin tools for allowlisted platform admins.",
          "Try 2-4 keyword variants before deciding a capability is unavailable.",
          "Native API matches include pathParams, queryParams, hasBody, and bodySchema. External MCP matches include argumentsSchema, schemaDigest, and invocation.argumentsField.",
          "Skill matches use method SKILL and return stored SKILL.md content when executed.",
        ].join(" "),
        annotations: SEARCH_CAPABILITIES_ANNOTATIONS,
        inputSchema: z.object({
          query: z.string().min(1).describe("Keywords describing the capability you need, e.g. \"create organization\" or \"list workers\"."),
          limit: z.number().int().min(1).max(20).optional().describe("Max number of matches to return. Defaults to 5."),
          type: searchCapabilityTypeSchema.optional().describe("Optional source filter. all searches every available source; api searches Den API capabilities; admin searches allowlisted platform-admin tools; mcp searches connected external MCP tools; marketplace searches marketplace plugin capabilities; skills searches native skills and marketplace skill objects. Defaults to all."),
        }),
        outputSchema: SEARCH_CAPABILITIES_OUTPUT_SCHEMA,
      },
      async ({ query, limit, type }) => {
        const boundedLimit = limit ?? 5
        const sourceFilter = searchCapabilitySourceFilter(type)
        const marketplaceObjectTypes = type === "skills" ? skillMarketplaceObjectTypes : undefined
        const restMatches = sourceFilter.api ? searchCapabilities(catalog, query, boundedLimit) : []
        const adminMatches = sourceFilter.admin
          ? await searchAvailableAdminCapabilities(await resolvePlatformAdmin(), query, boundedLimit)
          : []
        // Merged in from each connected External MCP Connection's live
        // tools/list (capability-sources/external-mcp-client.ts) — a
        // Notion/Linear/Stripe/... connection an admin added in Den shows
        // up here exactly like any native capability, ranked together.
        let externalCoverageHint: string | undefined
        const externalMatches = sourceFilter.mcp && externalMcpConnectionsEnabled
          ? await searchExternalCapabilities({
            organizationId: principal.organizationId,
            member: memberIdentity,
            query,
            redirectUriBase: resolvePublicOrigin(c.req.raw, env.apiPublicUrl),
            limit: boundedLimit,
            reportCoverage: (coverage) => {
              externalCoverageHint = externalMcpSearchCoverageHint(coverage)
            },
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
        const matches = [...restMatches, ...adminMatches, ...externalMatches, ...marketplaceMatches, ...skillMatches]
          .sort(compareCapabilityMatches)
          .slice(0, boundedLimit)
        return capabilitySearchToolResult(matches, externalCoverageHint)
      },
    )

    server.registerTool(
      EXECUTE_CAPABILITY_TOOL_NAME,
      {
        title: "Execute capability",
        description: [
          "Call a capability found via search_capabilities, by its exact name.",
          "Pass path/query/body only as described by that match's pathParams/queryParams/hasBody.",
          "For external MCP capabilities, provider-advertised schema mismatches are returned as advisory schemaGuidance alongside the provider result; they do not block the downstream call.",
          "For skill:<id> matches, this returns that skill's stored SKILL.md content.",
          "Returns unknown_capability if name doesn't match a current capability — call search_capabilities again.",
        ].join(" "),
        annotations: EXECUTE_CAPABILITY_ANNOTATIONS,
        inputSchema: z.object({
          name: z.string().min(1).describe("The exact tool name returned by search_capabilities."),
          schemaDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional().describe("For an external MCP match, copy the exact schemaDigest returned by search_capabilities so schema drift can be reported as advisory guidance without blocking the provider call."),
          path: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().describe("Path parameters, only if the match's pathParams is non-empty."),
          query: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().describe("Query parameters, only if the match's queryParams is non-empty."),
          body: z.unknown().optional().describe("For native API capabilities, the JSON body. For external MCP capabilities, the arguments object matching argumentsSchema."),
        }),
      },
      async ({ name, schemaDigest, path, query, body }) => {
        return executeCapabilityWithBudget({
          capability: name,
          invoke: async (): Promise<ExecuteCapabilityToolResult> => {
            const adminResult = parseAdminCapabilityName(name)
              ? await executeAvailableAdminCapability(await resolvePlatformAdmin(), name, body)
              : null
            if (adminResult) return adminResult

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
                args: normalizeToolBody(body),
                schemaDigest,
                redirectUriBase: resolvePublicOrigin(c.req.raw, env.apiPublicUrl),
              })
              if (!result.ok) {
                return externalCapabilityErrorToolResult(result)
              }
              // The SDK's callTool() can return either the standard {content:[...]}
              // shape or a legacy-compatibility {toolResult} shape; normalize to
              // what McpServer's own tool callback contract requires.
              return externalCapabilitySuccessToolResult(result)
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
