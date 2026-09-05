import { Tool, toolError } from "@openwork/codemode"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { Effect } from "effect"
import type { Hono } from "hono"
import { z } from "zod"
import { memberFacingMcpConnectionsEnabled } from "../capability-sources/external-mcp-rollout.js"
import { isPlatformAdminUserId } from "../middleware/admin.js"
import type { McpPrincipal } from "./auth.js"
import type { McpToolOperation } from "./catalog.js"
import {
  executeAdminCapability,
  listAvailableAdminCapabilities,
  parseAdminCapabilityName,
  searchAvailableAdminCapabilities,
} from "./admin-capabilities.js"
import {
  executeBuiltinSkillCapability,
  listBuiltinSkillDescriptors,
  searchBuiltinSkillCapabilities,
} from "./builtin-skills.js"
import {
  buildDenCatalogToolTree,
  buildExternalMcpToolTree,
  buildNativeProviderToolTree,
  isCredentialBoundNativeOperation,
  type BuiltCodemodeTools,
} from "./codemode-tools.js"
import {
  codemodeScriptPath,
  resolveCodemodeConnectionNamespaceContext,
  type CodemodeConnectionNamespaceContext,
} from "./codemode-namespaces.js"
import {
  connectedConnectionActionPayload,
  connectionActionErrorCard,
  connectionActionLaunch,
  connectionActionPayloadFromStatus,
  connectionActionTextFallback,
} from "./connection-action-app.js"
import {
  buildExternalCapabilityName,
  executeExternalCapability,
  externalMcpSearchCoverageHint,
  parseExternalCapabilityName,
  probeExternalConnectionStatus,
  searchExternalCapabilities,
  type ExternalCapabilityExecuteResult,
  type McpMemberIdentity,
} from "./external-capabilities.js"
import { attachPluginFlowCard } from "./plugin-flow-app.js"
import { invokeMcpOperation, normalizeToolBody, normalizeToolRecord } from "./invoke.js"
import {
  executeMarketplaceCapability,
  listAccessibleMarketplaceCapabilityReferences,
  parseMarketplaceCapabilityName,
  searchMarketplaceCapabilities,
  type MarketplaceCapabilityExecuteResult,
  type MarketplaceCapabilityObjectType,
} from "./marketplace-capabilities.js"
import {
  executeNativeCapability,
  parseNativeCapabilityName,
  searchNativeCapabilities,
} from "./native-capabilities.js"
import {
  executeRemoteSessionCapability,
  parseRemoteSessionCapabilityName,
  remoteSessionCapabilitiesEnabled,
  searchRemoteSessionCapabilities,
  type RemoteSessionAction,
} from "./remote-session-capabilities.js"
import { DEN_MCP_WRITE_SCOPE } from "./scopes.js"
import {
  compareCapabilityMatches,
  EXECUTE_CAPABILITY_TOOL_NAME,
  searchCapabilities,
  searchCapabilitySourceFilter,
  SEARCH_CAPABILITIES_TOOL_NAME,
  type CapabilityMatch,
  type SearchCapabilityType,
} from "./search.js"
import type { AgentToolContentPart } from "./tool-content.js"
import { externalToolContent } from "./tool-content.js"

export const CAPABILITY_SOURCE_KINDS = ["catalog", "native", "externalMcp", "marketplace", "builtinSkill", "remoteSession", "admin"] as const
export type CapabilitySourceKind = (typeof CAPABILITY_SOURCE_KINDS)[number]

export type ParsedCapability =
  | { kind: "catalog"; name: string }
  | { kind: "native"; name: string; connectionId: string; toolName: string }
  | { kind: "externalMcp"; name: string; connectionId: string; toolName: string }
  | { kind: "marketplace"; name: string; configObjectId: string; pluginId: string }
  | { kind: "builtinSkill"; name: string }
  | { kind: "remoteSession"; name: string; action: RemoteSessionAction }
  | { kind: "admin"; name: string; toolName: string }

export type ExecuteCapabilityToolResult = {
  isError?: boolean
  content: AgentToolContentPart[]
  structuredContent?: Record<string, unknown>
  _meta?: Record<string, unknown>
}

export type CapabilityExecuteInput = {
  name: string
  schemaDigest?: string
  path?: unknown
  query?: unknown
  body?: unknown
}

export type CapabilityRegistryContext = {
  app: Hono
  env: unknown
  catalog: readonly McpToolOperation[]
  principal: McpPrincipal
  organizationId: DenTypeId<"organization">
  member: McpMemberIdentity | null
  redirectUriBase: string
  generatedArtifactViewsEnabled: boolean
  externalMcpConnectionsEnabled: boolean
  remoteSessionsEnabled: boolean
  resolvePlatformAdmin: () => Promise<boolean>
  resolveNamespaceContext: () => Promise<CodemodeConnectionNamespaceContext>
}

export type CapabilityRegistryContextInput = {
  app: Hono
  env: unknown
  catalog: readonly McpToolOperation[]
  principal: McpPrincipal
  organizationId: DenTypeId<"organization">
  member: McpMemberIdentity | null
  redirectUriBase: string
  generatedArtifactViewsEnabled: boolean
  organizationMetadata: Parameters<typeof memberFacingMcpConnectionsEnabled>[0]
  mcpConnectionsGatingEnabled: boolean
}

export function createCapabilityRegistryContext(input: CapabilityRegistryContextInput): CapabilityRegistryContext {
  const externalMcpConnectionsEnabled = memberFacingMcpConnectionsEnabled(input.organizationMetadata, {
    gatingEnabled: input.mcpConnectionsGatingEnabled,
  })
  let platformAdmin: Promise<boolean> | undefined
  const resolvePlatformAdmin = () => {
    platformAdmin ??= isPlatformAdminUserId(input.principal.userId)
    return platformAdmin
  }
  let namespaceContext: Promise<CodemodeConnectionNamespaceContext> | undefined
  const resolveNamespaceContext = () => {
    namespaceContext ??= resolveCodemodeConnectionNamespaceContext({
      organizationId: input.organizationId,
      member: input.member,
      includeExternalMcp: externalMcpConnectionsEnabled,
    })
    return namespaceContext
  }
  return {
    app: input.app,
    env: input.env,
    catalog: input.catalog,
    principal: input.principal,
    organizationId: input.organizationId,
    member: input.member,
    redirectUriBase: input.redirectUriBase,
    generatedArtifactViewsEnabled: input.generatedArtifactViewsEnabled,
    externalMcpConnectionsEnabled,
    remoteSessionsEnabled: remoteSessionCapabilitiesEnabled(input.organizationMetadata),
    resolvePlatformAdmin,
    resolveNamespaceContext,
  }
}

export function catalogOperationAvailableToCapabilities(
  context: Pick<CapabilityRegistryContext, "generatedArtifactViewsEnabled">,
  operation: Pick<McpToolOperation, "method" | "path">,
) {
  // Standalone URL-App operations are deferred and never enter the generic
  // capability gateway, even if their retained storage routes are reworked.
  if (operation.path.startsWith("/v1/remote-mcp-apps")) return false
  if (context.generatedArtifactViewsEnabled) return true
  return operation.path !== "/v1/workflows/{configObjectId}/views"
    && !operation.path.startsWith("/v1/artifact-views/")
}

type CapabilitySearchContext = CapabilityRegistryContext & {
  sourceFilter: ReturnType<typeof searchCapabilitySourceFilter>
  marketplaceObjectTypes?: MarketplaceCapabilityObjectType[]
  reportExternalCoverage: (hint: string | undefined) => void
}

export type CapabilityLeaf = {
  namespace: string
  toolName: string
  scriptPath: string
  capabilityName: string
  readOnly?: boolean
  authority?: "den" | "external"
  definition: Tool.Definition
}

type CapabilitySourceExclusion = { excluded: string }

export type CapabilitySource = {
  kind: CapabilitySourceKind
  parseName: (name: string) => ParsedCapability | null
  search: (ctx: CapabilitySearchContext, query: string, limit: number) => Promise<CapabilityMatch[]>
  enumerate: (ctx: CapabilityRegistryContext) => Promise<CapabilityLeaf[]> | CapabilitySourceExclusion
  execute: (ctx: CapabilityRegistryContext, parsed: ParsedCapability, input: CapabilityExecuteInput) => Promise<ExecuteCapabilityToolResult>
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

function unknownCapabilityResult(name: string): ExecuteCapabilityToolResult {
  return { isError: true, content: textContent(unknownCapabilityText(name)) }
}

const externalMcpProviderErrorOutputSchema = z.object({
  jsonRpcCode: z.number().int().optional(),
  message: z.string().optional(),
  data: z.string().optional(),
})

const externalCapabilityErrorPayloadSchema = z.object({
  error: z.string(),
  message: z.string(),
  referenceId: z.string().optional(),
  retryable: z.boolean().optional(),
  providerError: externalMcpProviderErrorOutputSchema.optional(),
  connectionStatus: z.unknown().optional(),
  capability: z.string().optional(),
  issues: z.array(z.object({
    path: z.string(),
    keyword: z.string(),
    message: z.string(),
  })).optional(),
  schemaDigest: z.string().optional(),
  sameArgumentsRetryable: z.literal(false).optional(),
  retry: z.object({
    action: z.enum(["correct_arguments", "search_capabilities"]),
    searchRequired: z.boolean(),
  }).optional(),
  schemaGuidance: z.unknown().optional(),
  connectionCard: z.string().optional(),
})

export function externalCapabilityErrorToolResult(
  result: Exclude<ExternalCapabilityExecuteResult, { ok: true }>,
): ExecuteCapabilityToolResult {
  const statusCapability = result.connectionStatus
    ? buildExternalCapabilityName(result.connectionStatus.connectionId, "*")
    : undefined
  const payload = externalCapabilityErrorPayloadSchema.parse({
    error: result.error,
    message: result.message,
    ...(result.referenceId === undefined ? {} : { referenceId: result.referenceId }),
    ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
    ...(result.providerError ? { providerError: result.providerError } : {}),
    ...(result.connectionStatus ? { connectionStatus: result.connectionStatus } : {}),
    ...(result.capability ? { capability: result.capability } : {}),
    ...(result.issues ? { issues: result.issues } : {}),
    ...(result.schemaDigest ? { schemaDigest: result.schemaDigest } : {}),
    ...(result.sameArgumentsRetryable === false ? { sameArgumentsRetryable: false } : {}),
    ...(result.retry ? { retry: result.retry } : {}),
    ...(result.schemaGuidance ? { schemaGuidance: result.schemaGuidance } : {}),
    ...(statusCapability
      ? { connectionCard: `Execute "${statusCapability}" once to show the member an actionable connection card, then relay the action in text.` }
      : {}),
  })
  if (!result.connectionStatus) {
    return {
      isError: true,
      content: textContent(JSON.stringify(payload)),
    }
  }
  const card = connectionActionErrorCard(result.connectionStatus)
  return {
    isError: true,
    content: textContent(JSON.stringify(payload)),
    structuredContent: card.structuredContent,
    _meta: card.meta,
  }
}

export function externalCapabilitySuccessToolResult(
  result: Extract<ExternalCapabilityExecuteResult, { ok: true }>,
): ExecuteCapabilityToolResult {
  const content = externalToolContent(result.result)
  const providerStructuredContent = isRecord(result.result)
    && isRecord(result.result.structuredContent)
    ? result.result.structuredContent
    : undefined
  const structuredContent = result.mcpApp
    ? {
        ...(providerStructuredContent ?? {}),
        serverTools: {
          searchCapabilities: SEARCH_CAPABILITIES_TOOL_NAME,
          executeCapability: EXECUTE_CAPABILITY_TOOL_NAME,
        },
      }
    : providerStructuredContent
  const providerMeta = isRecord(result.result) && isRecord(result.result._meta)
    ? result.result._meta
    : {}
  const meta = {
    ...providerMeta,
    ...(result.mcpApp ? { "openwork/mcpApp": result.mcpApp } : {}),
  }
  if (!result.schemaGuidance) {
    return {
      content,
      ...(structuredContent ? { structuredContent } : {}),
      ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    }
  }
  return {
    content: [
      ...content,
      ...textContent(JSON.stringify({ schemaGuidance: result.schemaGuidance })),
    ],
    structuredContent: {
      ...(structuredContent ?? {}),
      schemaGuidance: result.schemaGuidance,
    },
    ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
  }
}

function marketplaceCapabilityErrorToolResult(
  result: Exclude<MarketplaceCapabilityExecuteResult, { ok: true }>,
): ExecuteCapabilityToolResult {
  const payload = Object.fromEntries(Object.entries(result).filter(([key]) => key !== "ok"))
  return {
    isError: true,
    content: textContent(JSON.stringify(payload)),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCodemodeJsonSchema(value: unknown): value is Tool.JsonSchema {
  return isRecord(value)
}

function textParts(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.content)) return []
  return value.content.flatMap((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [])
}

function toolResultValue(value: unknown): unknown {
  if (isRecord(value) && value.structuredContent !== undefined) return value.structuredContent
  const text = textParts(value)
  if (text.length === 0) return null
  if (text.length > 1) return text.join("\n")
  try {
    return JSON.parse(text[0] ?? "")
  } catch {
    return text[0] ?? ""
  }
}

function toolResultError(value: unknown): string {
  const text = textParts(value).join("\n").trim()
  return text || "Capability execution failed."
}

function leavesFromBuilt(built: BuiltCodemodeTools): CapabilityLeaf[] {
  const definitions = new Map<string, { namespace: string; toolName: string; definition: Tool.Definition }>()
  for (const [namespace, tools] of Object.entries(built.tools)) {
    for (const [toolName, definition] of Object.entries(tools)) {
      definitions.set(codemodeScriptPath(namespace, toolName), { namespace, toolName, definition })
    }
  }
  return built.manifest.flatMap((entry) => {
    const resolved = definitions.get(entry.scriptPath)
    return resolved ? [{ ...resolved, ...entry }] : []
  })
}

function contentLeaf(input: {
  namespace: string
  toolName: string
  capabilityName: string
  description: string
  readOnly: boolean
  authority: "den" | "external"
  input?: Tool.JsonSchema
  run: (args: unknown) => Promise<unknown>
}): CapabilityLeaf {
  return {
    namespace: input.namespace,
    toolName: input.toolName,
    capabilityName: input.capabilityName,
    scriptPath: codemodeScriptPath(input.namespace, input.toolName),
    readOnly: input.readOnly,
    authority: input.authority,
    definition: Tool.make({
      description: input.description,
      input: input.input ?? { type: "object" },
      run: (args) => Effect.promise(() => input.run(args)),
    }),
  }
}

async function executeMarketplaceSource(
  ctx: CapabilityRegistryContext,
  parsed: Extract<ParsedCapability, { kind: "marketplace" }>,
  input: CapabilityExecuteInput,
): Promise<MarketplaceCapabilityExecuteResult> {
  return executeMarketplaceCapability({
    buildTools: () => buildCapabilityToolTree(ctx),
    organizationId: ctx.organizationId,
    member: ctx.member,
    pluginId: parsed.pluginId,
    configObjectId: parsed.configObjectId,
    body: input.body,
    validateScriptOutput: true,
    enabled: ctx.externalMcpConnectionsEnabled,
    redirectUriBase: ctx.redirectUriBase,
  })
}

function parsedForKind<K extends CapabilitySourceKind>(parsed: ParsedCapability, kind: K): parsed is Extract<ParsedCapability, { kind: K }> {
  return parsed.kind === kind
}

const catalogSource: CapabilitySource = {
  kind: "catalog",
  parseName: (name) => name.includes(":") ? null : { kind: "catalog", name },
  search: async (ctx, query, limit) => {
    if (!ctx.sourceFilter.api) return []
    return searchCapabilities(
      ctx.catalog.filter((operation) => (
        !isCredentialBoundNativeOperation(operation)
        && catalogOperationAvailableToCapabilities(ctx, operation)
      )),
      query,
      limit,
    ).map((match) => ({ ...match, scriptPath: codemodeScriptPath("den", match.name) }))
  },
  enumerate: (ctx) => Promise.resolve(leavesFromBuilt(buildDenCatalogToolTree({
    ...ctx,
    catalog: ctx.catalog.filter((operation) => catalogOperationAvailableToCapabilities(ctx, operation)),
  }))),
  execute: async (ctx, parsed, input) => {
    if (!parsedForKind(parsed, "catalog")) return unknownCapabilityResult(input.name)
    const operation = ctx.catalog.find((candidate) => (
      candidate.name === parsed.name
      && !isCredentialBoundNativeOperation(candidate)
      && catalogOperationAvailableToCapabilities(ctx, candidate)
    ))
    if (!operation) return unknownCapabilityResult(input.name)
    const path = normalizeToolRecord(input.path)
    const body = normalizeToolBody(input.body)
    const result = await invokeMcpOperation({
      app: ctx.app,
      env: ctx.env,
      operation,
      principal: ctx.principal,
      toolInput: {
        path,
        query: normalizeToolRecord(input.query),
        body,
      },
    })
    return attachPluginFlowCard({ name: parsed.name, path, body, result })
  },
}

const nativeSource: CapabilitySource = {
  kind: "native",
  parseName: (name) => {
    const parsed = parseNativeCapabilityName(name)
    return parsed ? { kind: "native", name, ...parsed } : null
  },
  search: async (ctx, query, limit) => {
    if (!ctx.sourceFilter.api) return []
    return searchNativeCapabilities({
      organizationId: ctx.organizationId,
      member: ctx.member,
      query,
      catalog: ctx.catalog,
      limit,
      namespaceContext: await ctx.resolveNamespaceContext(),
    })
  },
  enumerate: async (ctx) => leavesFromBuilt(await buildNativeProviderToolTree({
    ...ctx,
    namespaceContext: await ctx.resolveNamespaceContext(),
  })),
  execute: async (ctx, parsed, input) => {
    if (!parsedForKind(parsed, "native")) return unknownCapabilityResult(input.name)
    const result = await executeNativeCapability({
      app: ctx.app,
      env: ctx.env,
      name: parsed.name,
      organizationId: ctx.organizationId,
      member: ctx.member,
      catalog: ctx.catalog,
      principal: ctx.principal,
      path: input.path,
      query: input.query,
      body: input.body,
    })
    return result ?? unknownCapabilityResult(input.name)
  },
}

const externalMcpSource: CapabilitySource = {
  kind: "externalMcp",
  parseName: (name) => {
    const parsed = parseExternalCapabilityName(name)
    return parsed ? { kind: "externalMcp", name, ...parsed } : null
  },
  search: async (ctx, query, limit) => {
    if (!ctx.sourceFilter.mcp || !ctx.externalMcpConnectionsEnabled) return []
    return searchExternalCapabilities({
      organizationId: ctx.organizationId,
      member: ctx.member,
      query,
      redirectUriBase: ctx.redirectUriBase,
      limit,
      namespaceContext: await ctx.resolveNamespaceContext(),
      reportCoverage: (coverage) => ctx.reportExternalCoverage(externalMcpSearchCoverageHint(coverage)),
    })
  },
  enumerate: async (ctx) => {
    if (!ctx.externalMcpConnectionsEnabled) return []
    return leavesFromBuilt(await buildExternalMcpToolTree({
      organizationId: ctx.organizationId,
      member: ctx.member,
      redirectUriBase: ctx.redirectUriBase,
      namespaceContext: await ctx.resolveNamespaceContext(),
    }))
  },
  execute: async (ctx, parsed, input) => {
    if (!parsedForKind(parsed, "externalMcp")) return unknownCapabilityResult(input.name)
    if (!ctx.externalMcpConnectionsEnabled) {
      return {
        isError: true,
        content: textContent(JSON.stringify({
          error: "unknown_capability",
          message: "No external MCP connection capabilities are available for this organization.",
        })),
      }
    }
    if (parsed.toolName === "*") {
      // A connection_status match: probing is the capability. Report the live
      // state as a successful result carrying the first-party connection
      // card, so compatible hosts render the exact human action inline.
      const probe = await probeExternalConnectionStatus({
        organizationId: ctx.organizationId,
        member: ctx.member,
        connectionId: parsed.connectionId,
      })
      if (!probe.ok) {
        return { isError: true, content: textContent(JSON.stringify({ error: probe.error, message: probe.message })) }
      }
      const payload = probe.connected
        ? connectedConnectionActionPayload({ connectionId: probe.connection.id, connectionName: probe.connection.name })
        : connectionActionPayloadFromStatus(probe.status)
      return {
        content: textContent(connectionActionTextFallback(payload)),
        structuredContent: { ...payload },
        _meta: { "openwork/mcpApp": connectionActionLaunch(payload) },
      }
    }
    const result = await executeExternalCapability({
      organizationId: ctx.organizationId,
      member: ctx.member,
      connectionId: parsed.connectionId,
      toolName: parsed.toolName,
      args: normalizeToolBody(input.body),
      schemaDigest: input.schemaDigest,
      redirectUriBase: ctx.redirectUriBase,
    })
    return result.ok
      ? externalCapabilitySuccessToolResult(result)
      : externalCapabilityErrorToolResult(result)
  },
}

const marketplaceSource: CapabilitySource = {
  kind: "marketplace",
  parseName: (name) => {
    const parsed = parseMarketplaceCapabilityName(name)
    return parsed ? { kind: "marketplace", name, ...parsed } : null
  },
  search: async (ctx, query, limit) => {
    if (!ctx.sourceFilter.marketplace || !ctx.externalMcpConnectionsEnabled) return []
    const matches = await searchMarketplaceCapabilities({
      organizationId: ctx.organizationId,
      member: ctx.member,
      objectTypes: ctx.marketplaceObjectTypes,
      query,
      limit,
      enabled: ctx.externalMcpConnectionsEnabled,
    })
    return matches.map((match) => match.kind !== "workflow"
      ? { ...match, scriptPath: codemodeScriptPath("marketplace", match.name) }
      : match)
  },
  enumerate: async (ctx) => {
    if (!ctx.externalMcpConnectionsEnabled) return []
    const references = await listAccessibleMarketplaceCapabilityReferences({
      organizationId: ctx.organizationId,
      member: ctx.member,
      enabled: ctx.externalMcpConnectionsEnabled,
    })
    const uniqueReferences = new Map(references
      .filter((reference) => reference.objectType !== "workflow")
      .map((reference) => [`${reference.pluginId}:${reference.configObjectId}`, reference]))
    return [...uniqueReferences.values()].map((reference) => {
      const capabilityName = `plugin:${reference.pluginId}:${reference.configObjectId}`
      const parsed: Extract<ParsedCapability, { kind: "marketplace" }> = {
        kind: "marketplace",
        name: capabilityName,
        pluginId: reference.pluginId,
        configObjectId: reference.configObjectId,
      }
      return contentLeaf({
        namespace: "marketplace",
        toolName: capabilityName,
        capabilityName,
        description: `Retrieve marketplace capability ${capabilityName}`,
        readOnly: true,
        authority: "den",
        run: async (args) => {
          const result = await executeMarketplaceSource(ctx, parsed, { name: capabilityName, body: args })
          if (!result.ok) throw toolError(result.message)
          const content = result.result.content ?? result.result.source ?? result.result.definition
          return typeof content === "string" ? content : JSON.stringify(result.result)
        },
      })
    })
  },
  execute: async (ctx, parsed, input) => {
    if (!parsedForKind(parsed, "marketplace")) return unknownCapabilityResult(input.name)
    const result = await executeMarketplaceSource(ctx, parsed, input)
    if (!result.ok) {
      return result.error === "unknown_capability"
        ? unknownCapabilityResult(input.name)
        : marketplaceCapabilityErrorToolResult(result)
    }
    return {
      content: textContent(JSON.stringify(result.result, null, 2)),
      structuredContent: result.result,
    }
  },
}

const builtinSkillSource: CapabilitySource = {
  kind: "builtinSkill",
  parseName: (name) => name.startsWith("skill:") && name.length > "skill:".length
    ? { kind: "builtinSkill", name }
    : null,
  search: async (ctx, query, limit) => {
    if (!ctx.sourceFilter.skills) return []
    return searchBuiltinSkillCapabilities(query, limit).map((match) => ({ ...match, scriptPath: codemodeScriptPath("skills", match.name) }))
  },
  enumerate: (ctx) => Promise.resolve(listBuiltinSkillDescriptors().map((skill) => contentLeaf({
    namespace: "skills",
    toolName: skill.capability,
    capabilityName: skill.capability,
    description: skill.description,
    readOnly: true,
    authority: "den",
    run: async () => executeBuiltinSkillCapability(skill.capability)?.content ?? "",
  }))),
  execute: async (_ctx, parsed, input) => {
    if (!parsedForKind(parsed, "builtinSkill")) return unknownCapabilityResult(input.name)
    const result = executeBuiltinSkillCapability(parsed.name)
    return result
      ? { content: textContent(JSON.stringify(result, null, 2)) }
      : unknownCapabilityResult(input.name)
  },
}

const remoteSessionSource: CapabilitySource = {
  kind: "remoteSession",
  parseName: (name) => {
    const action = parseRemoteSessionCapabilityName(name)
    return action ? { kind: "remoteSession", name, action } : null
  },
  search: async (ctx, query, limit) => {
    // Remote sessions require an active membership and the organization's
    // Cloud capability flag: a member of a flag-off org never discovers
    // these capabilities. Worker provisioning state is checked at execute
    // time and reported as an actionable needs-setup result.
    if (!ctx.sourceFilter.api || !ctx.member || !ctx.remoteSessionsEnabled) return []
    return searchRemoteSessionCapabilities(query, limit)
  },
  // Deliberately absent from the confined-script tool tree in v1: remote
  // sessions are long-lived side effects that agents should drive through
  // explicit execute_capability calls, not batched scripts.
  enumerate: () => Promise.resolve([]),
  execute: async (ctx, parsed, input) => {
    if (!parsedForKind(parsed, "remoteSession")) return unknownCapabilityResult(input.name)
    if (!ctx.remoteSessionsEnabled) {
      return {
        isError: true,
        content: textContent(JSON.stringify({
          error: "unknown_capability",
          message: "Remote session capabilities are not available for this organization.",
        })),
      }
    }
    if (!ctx.member) {
      return {
        isError: true,
        content: textContent(JSON.stringify({
          error: "membership_required",
          message: "Remote sessions require an active organization membership.",
        })),
      }
    }
    return executeRemoteSessionCapability({
      action: parsed.action,
      organizationId: ctx.organizationId,
      userId: ctx.principal.userId,
      hasWriteScope: ctx.principal.scopes.has(DEN_MCP_WRITE_SCOPE),
      body: input.body,
    })
  },
}

const adminSource: CapabilitySource = {
  kind: "admin",
  parseName: (name) => {
    const toolName = parseAdminCapabilityName(name)
    return toolName ? { kind: "admin", name, toolName } : null
  },
  search: async (ctx, query, limit) => {
    if (!ctx.sourceFilter.admin) return []
    const matches = await searchAvailableAdminCapabilities(await ctx.resolvePlatformAdmin(), query, limit)
    return matches.map((match) => ({ ...match, scriptPath: codemodeScriptPath("admin", parseAdminCapabilityName(match.name) ?? match.name) }))
  },
  enumerate: async (ctx) => {
    const matches = await listAvailableAdminCapabilities(await ctx.resolvePlatformAdmin())
    return matches.flatMap((match) => {
      const toolName = parseAdminCapabilityName(match.name)
      if (!toolName) return []
      const parsed: Extract<ParsedCapability, { kind: "admin" }> = { kind: "admin", name: match.name, toolName }
      return [contentLeaf({
        namespace: "admin",
        toolName,
        capabilityName: match.name,
        description: match.summary,
        readOnly: false,
        authority: "den",
        input: isCodemodeJsonSchema(match.argumentsSchema) ? match.argumentsSchema : undefined,
        run: async (args) => {
          const result = await adminSource.execute(ctx, parsed, { name: match.name, body: args })
          if (result.isError) throw toolError(toolResultError(result))
          return toolResultValue(result)
        },
      })]
    })
  },
  execute: async (ctx, parsed, input) => {
    if (!parsedForKind(parsed, "admin") || !(await ctx.resolvePlatformAdmin())) {
      return unknownCapabilityResult(input.name)
    }
    return (await executeAdminCapability(parsed.name, input.body)) ?? unknownCapabilityResult(input.name)
  },
}

export const CAPABILITY_SOURCES: Record<CapabilitySourceKind, CapabilitySource> = {
  catalog: catalogSource,
  native: nativeSource,
  externalMcp: externalMcpSource,
  marketplace: marketplaceSource,
  builtinSkill: builtinSkillSource,
  remoteSession: remoteSessionSource,
  admin: adminSource,
}

export function createCapabilityRegistry(sources: Record<CapabilitySourceKind, CapabilitySource>) {
  return {
    search: async (
      ctx: CapabilityRegistryContext,
      input: { query: string; limit: number; type?: SearchCapabilityType },
    ): Promise<{ matches: CapabilityMatch[]; externalCoverageHint?: string }> => {
      let externalCoverageHint: string | undefined
      const sourceFilter = searchCapabilitySourceFilter(input.type)
      const searchContext: CapabilitySearchContext = {
        ...ctx,
        sourceFilter,
        ...(input.type === "skills" ? { marketplaceObjectTypes: ["skill"] } : {}),
        reportExternalCoverage: (hint) => {
          externalCoverageHint = hint
        },
      }
      const sourceMatches = await Promise.all(CAPABILITY_SOURCE_KINDS.map((kind) => (
        sources[kind].search(searchContext, input.query, input.limit)
      )))
      const matches = sourceMatches.flat()
        .sort(compareCapabilityMatches)
        .slice(0, input.limit)
      return {
        matches,
        ...(externalCoverageHint ? { externalCoverageHint } : {}),
      }
    },
    execute: async (
      ctx: CapabilityRegistryContext,
      input: CapabilityExecuteInput,
    ): Promise<ExecuteCapabilityToolResult> => {
      for (const kind of CAPABILITY_SOURCE_KINDS) {
        const source = sources[kind]
        const parsed = source.parseName(input.name)
        if (parsed) return source.execute(ctx, parsed, input)
      }
      return unknownCapabilityResult(input.name)
    },
    buildToolTree: async (ctx: CapabilityRegistryContext): Promise<BuiltCodemodeTools> => {
      const enumerated = await Promise.all(CAPABILITY_SOURCE_KINDS.map(async (kind) => {
        const result = await sources[kind].enumerate(ctx)
        return "excluded" in result ? [] : result
      }))
      const leaves = enumerated.flat()
      const namespaceTools = new Map<string, Map<string, Tool.Definition>>()
      for (const leaf of leaves) {
        const tools = namespaceTools.get(leaf.namespace) ?? new Map<string, Tool.Definition>()
        tools.set(leaf.toolName, leaf.definition)
        namespaceTools.set(leaf.namespace, tools)
      }
      return {
        tools: Object.fromEntries([...namespaceTools].map(([namespace, tools]) => [namespace, Object.fromEntries(tools)])),
        manifest: leaves.map(({ capabilityName, scriptPath, readOnly, authority }) => ({
          capabilityName,
          scriptPath,
          ...(readOnly === undefined ? {} : { readOnly }),
          ...(authority === undefined ? {} : { authority }),
        })),
      }
    },
  }
}

export const CAPABILITY_REGISTRY = createCapabilityRegistry(CAPABILITY_SOURCES)
export const searchCapabilityRegistry = CAPABILITY_REGISTRY.search
export const executeCapability = CAPABILITY_REGISTRY.execute
export const buildCapabilityToolTree = CAPABILITY_REGISTRY.buildToolTree
