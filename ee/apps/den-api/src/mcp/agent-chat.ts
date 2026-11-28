import { StreamableHTTPTransport } from "@hono/mcp"
import { McpServer } from "@modelcontextprotocol/server"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import type { RequestIdVariables } from "hono/request-id"
import { z } from "zod"
import { mcpAuditPrincipal } from "../audit/mcp-service-audit.js"
import { env } from "../env.js"
import { cachedOrganizationFeatureContext } from "../features.js"
import { tokenRoute } from "../middleware/index.js"
import { OPENWORK_CONNECTION_ID, OPENWORK_CONNECTION_NAME, SKILLS_TOOL } from "../personal-agents/builtin-connection.js"
import { personalAgentChatDispatchContext, personalAgentRunDispatchRefusal } from "../personal-agents/permissions-dispatch.js"
import { readSkillFileBytes } from "../skill-file-blobs.js"
import { skillFileText } from "../skill-files.js"
import { toolPermissionRefusal } from "../tool-permissions/dispatch.js"
import { primaryReadsMiddleware } from "../read-routing.js"
import { resolvePublicOrigin } from "../capability-sources/generic-oauth.js"
import { executeCapabilityWithBudget, readRemoteSkillSource, type ExecuteCapabilityToolResult } from "./agent.js"
import { registerAgentConnectorRequestTool, searchOffAgentTools, searchWords, wordScore } from "./agent-connector-request.js"
import { listBuiltinSkillDescriptors } from "./builtin-skills.js"
import { getMcpResourceContext, mcpPrincipalCredentialId, verifyMcpRequest } from "./auth.js"
import { createCapabilityRegistryContext, executeCapability, searchCapabilityRegistry, type CapabilitySourceKind } from "./capability-registry.js"
import { mcpMemberForToken, resolveMcpMemberIdentity } from "./external-capabilities.js"
import type { InternalApp } from "./catalog.js"
import { getCatalog } from "./index.js"
import { listAccessibleMarketplaceSkillDescriptors, type RemoteSkillDescriptor } from "./marketplace-capabilities.js"
import { findRemoteSkill, standardSkillMarkdown, supportingFilesNote } from "./skill-tools.js"
import { preflightMcpJsonRpcRequest } from "./json-rpc-preflight.js"
import { rejectStandaloneSseResponse } from "./standalone-sse.js"
import { personalAgentChatTurnId } from "./workbot-turn-limits.js"

const AGENT_CHAT_SOURCES: readonly CapabilitySourceKind[] = ["catalog", "native", "externalMcp"]

function textResult(value: unknown, isError = false) {
  const part: { type: "text"; text: string } = { type: "text", text: JSON.stringify(value) }
  return { content: [part], isError }
}

export function registerAgentChatMcpRoutes<T extends { Variables: RequestIdVariables & Record<string, unknown> }>(app: Hono<T>) {
  app.all("/mcp/agent-chat", tokenRoute, primaryReadsMiddleware, async (c) => {
    const requestId = c.get("requestId")
    const raw = c.req.raw
    const principal = await verifyMcpRequest(raw.headers, { ...getMcpResourceContext(raw, "agent", requestId), agentChatOnly: true })
    if (principal instanceof Response) return principal
    if (raw.method === "GET") return rejectStandaloneSseResponse()
    const preflight = await preflightMcpJsonRpcRequest(raw, requestId)
    if (preflight) return preflight
    const turnId = personalAgentChatTurnId(principal.scopes)
    if (!turnId) return c.json({ error: "forbidden" }, 403)
    const organizationId = normalizeDenTypeId("organization", principal.organizationId)
    const identity = await resolveMcpMemberIdentity(principal)
    const context = identity && await personalAgentChatDispatchContext(turnId, organizationId, identity.orgMembershipId, principal.userId)
    if (!identity || !context || context.paused) return c.json({ error: "personal_agent_chat_inactive" }, 403)
    const member = mcpMemberForToken(identity, principal.scopes)
    const scopes = principal.scopes
    const redirectUriBase = resolvePublicOrigin(raw, env.apiPublicUrl)
    const internalApp: InternalApp = app
    const [catalog, { features: organizationFeatures, organizationToolPermissions }] = await Promise.all([
      getCatalog<unknown>(internalApp, c.env),
      cachedOrganizationFeatureContext(organizationId, principal.userId),
    ])
    const capabilityContext = createCapabilityRegistryContext({
      app: internalApp,
      env: c.env,
      catalog,
      principal,
      organizationId,
      member,
      redirectUriBase,
      generatedArtifactViewsEnabled: env.generatedArtifactViewsEnabled,
      organizationFeatures,
      organizationToolPermissions,
      audit: mcpAuditPrincipal({ organizationId, userId: principal.userId, memberId: member.orgMembershipId, credentialId: mcpPrincipalCredentialId(principal) }),
      usageSource: "agent",
      sourceKinds: AGENT_CHAT_SOURCES,
    })
    const server = new McpServer({ name: "openwork-agent-chat", version: "1.0.0" })
    let skillList: Promise<RemoteSkillDescriptor[]> | undefined
    const skills = () => skillList ??= (async () => [
      ...listBuiltinSkillDescriptors(),
      ...await listAccessibleMarketplaceSkillDescriptors({ organizationId, member: identity }),
    ])()
    const skillsReachable = async () => Boolean((await capabilityContext.agentToolFilter(OPENWORK_CONNECTION_ID))?.(SKILLS_TOOL.name))
    server.registerTool("search_capabilities", {
      description: "Search every tool this agent could use: OpenWork's own tools (its routines, memory and requests, the person's OpenWork data and their skills) and the person's connected apps. matches are tools you can call now, with the exact name, and pathParams, queryParams and bodySchema, or argumentsSchema and schemaDigest for a connected app. skills are the person's skills you can read now. offTools are tools that fit the query but are off for this agent: ask for exactly that one with request_agent_connector_access, passing its connector and tool. offConnectors names every connector that is off.",
      inputSchema: z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(20).optional() }).strict(),
    }, async ({ query, limit }) => {
      const words = searchWords(query)
      const [found, readable, all] = await Promise.all([
        searchCapabilityRegistry(capabilityContext, { query, limit: limit ?? 5 }),
        skillsReachable(),
        skills(),
      ])
      const aboutSkills = words.includes("skill")
      const wanted = words.filter((word) => word !== "skill")
      const scored = all.map((skill) => ({ skill, score: wordScore(wanted, skill.name, skill.title, skill.description) }))
      const named = scored.filter(({ score }) => score > 0).sort((a, b) => b.score - a.score)
      const fitting = named.length > 0 || !aboutSkills ? named : scored
      const off = await searchOffAgentTools(capabilityContext, { query, limit: 8,
        alsoMatch: (connectionId, toolName) => connectionId === OPENWORK_CONNECTION_ID && toolName === SKILLS_TOOL.name && (aboutSkills || fitting.length > 0),
      })
      return textResult({ matches: found.matches, ...(found.externalCoverageHint ? { hint: found.externalCoverageHint } : {}),
        ...(readable && fitting.length > 0 ? { skills: fitting.slice(0, 20).map(({ skill }) => ({ name: skill.capability, title: skill.title, description: skill.description.slice(0, 240) })),
          skillsHint: "Read a skill with execute_capability and its name, then follow it." } : {}),
        offTools: off.offTools, offConnectors: off.offConnectors })
    })
    const readSkill = async (skill: RemoteSkillDescriptor, file: unknown): Promise<ExecuteCapabilityToolResult> => {
      const refusal = await personalAgentRunDispatchRefusal(scopes, organizationId) ?? await toolPermissionRefusal({
        scopes, connection: { id: OPENWORK_CONNECTION_ID, name: OPENWORK_CONNECTION_NAME, organizationId },
        tool: SKILLS_TOOL, actingMemberId: member.orgMembershipId,
      })
      if (refusal) return textResult(refusal, true)
      const source = await readRemoteSkillSource({ skill, organizationId, member: identity, recordUse: typeof file !== "string" })
      if (!source) return textResult({ error: "skill_unavailable", message: `Skill "${skill.name}" is no longer available.` }, true)
      if ("blocked" in source) return textResult({ error: "skill_needs_setup", message: source.blocked.message }, true)
      const files = source.files ?? []
      if (typeof file === "string") {
        const entry = files.find(({ path }) => path === file.replace(/^\.\//, ""))
        const bytes = entry && await readSkillFileBytes(organizationId, entry)
        const text = bytes ? skillFileText(bytes) : null
        return text === null
          ? textResult({ error: "unknown_skill_file", message: `Skill "${skill.name}" has no readable file "${file}".`, files: files.map(({ path }) => path) }, true)
          : { content: [{ type: "text", text }] }
      }
      const note = supportingFilesNote(skill, files).replace("get_skill", "execute_capability, passing body")
      return { content: [{ type: "text", text: [standardSkillMarkdown(skill, source.content), ...(note ? ["---", note] : [])].join("\n\n") }] }
    }
    server.registerTool("execute_capability", {
      description: "Call a tool by its exact name from search. For an OpenWork tool pass path, query and body as the match's pathParams, queryParams and bodySchema describe. For a connected app pass its arguments object as body and copy the schema digest. For a skill pass its name, and body { file } to read one of its supporting files. A tool that needs approval cannot run until a person approves it.",
      inputSchema: z.object({ name: z.string().min(1).max(400), schemaDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
        path: z.record(z.string(), z.unknown()).optional(), query: z.record(z.string(), z.unknown()).optional(),
        arguments: z.record(z.string(), z.unknown()).optional(), body: z.record(z.string(), z.unknown()).optional() }).strict(),
    }, async ({ name, schemaDigest, path, query, arguments: args, body }) => {
      const skill = name.startsWith("skill:") || name.startsWith("plugin:") ? findRemoteSkill(await skills(), name) : undefined
      const result = await executeCapabilityWithBudget({
        capability: name,
        invoke: (): Promise<ExecuteCapabilityToolResult> => skill ? readSkill(skill, (args ?? body)?.file) : executeCapability(capabilityContext, {
          name, schemaDigest, path, query, body, ...(args === undefined ? {} : { arguments: args }),
        }),
      })
      return { ...result, isError: result.isError === true }
    })
    registerAgentConnectorRequestTool(server, { execution: { kind: "chat", id: turnId }, capabilityContext, member })
    const transport = new StreamableHTTPTransport()
    await server.connect(transport)
    return await transport.handleRequest(c) ?? new Response(null, { status: 204 })
  })
}
