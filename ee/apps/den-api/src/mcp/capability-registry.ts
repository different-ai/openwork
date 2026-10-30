import { Tool, toolError } from "@openwork/codemode"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import type { CapabilityUsageSource } from "@openwork-ee/den-db/schema"
import { Effect } from "effect"
import type { Hono } from "hono"
import { z } from "zod"
import type { FeatureMap } from "../features.js"
import { AuditUnavailableError, auditUnavailableToolResult, runMcpServiceAction, serviceAuditResourceId, serviceErrorStatus, toolResultStatus, type McpAuditPrincipal } from "../audit/mcp-service-audit.js"
import type { AuditServiceActionName } from "../audit/service-actions.js"
import { isPlatformAdminUserId } from "../middleware/admin.js"
import { mcpPrincipalCredentialId, type McpPrincipal } from "./auth.js"
import { catalogOperationAvailableToCapabilities, nativeOperationAvailableToCapabilities } from "./catalog-availability.js"
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
  connectionActionPayloadFromStatus,
  connectionActionAppMeta,
  connectionActionTextFallback,
} from "./connection-action.js"
import {
  buildExternalCapabilityName,
  executeExternalCapability,
  externalMcpSearchCoverageHint,
  parseExternalCapabilityName,
  probeExternalConnectionStatus,
  searchExternalCapabilities,
  unavailableExternalCapabilityStatus,
  type ExternalCapabilityExecuteResult,
  type McpMemberIdentity,
} from "./external-capabilities.js"
import { invokeMcpOperation, normalizeToolBody, normalizeToolRecord } from "./invoke.js"
import {
  executeMarketplaceCapability,
  listAccessibleMarketplaceCapabilityReferences,
  parseMarketplaceCapabilityName,
  searchMarketplaceCapabilities,
  type MarketplaceCapabilityExecuteResult,
  type MarketplaceCapabilityObjectType,
  type MarketplaceWorkflowAudit,
} from "./marketplace-capabilities.js"
import {
  connectionStatusMatch,
  executeNativeCapability,
  parseNativeCapabilityName,
  searchNativeCapabilities,
} from "./native-capabilities.js"
import {
  executeRemoteSessionCapability,
  parseRemoteSessionCapabilityName,
  searchRemoteSessionCapabilities,
  type RemoteSessionAction,
} from "./remote-session-capabilities.js"
import { DEN_MCP_WRITE_SCOPE } from "./scopes.js"
import {
  executeSlackSendAsBot,
  isSlackSendAsBotCapabilityName,
  searchSlackSendAsBotCapability,
} from "./slack-send-as-bot.js"
import { headlessRunTokenId } from "./headless-run-token.js"
import {
  compareCapabilityMatches,
  EXECUTE_CAPABILITY_TOOL_NAME,
  searchCapabilities,
  searchCapabilitySourceFilter,
  SEARCH_CAPABILITIES_TOOL_NAME,
  type CapabilityMatch,
  type SearchCapabilityType,
} from "./search.js"
import { ENGINE_LISTED_SOURCE_KINDS, unlistedCapabilityMatches } from "./engine-tool-view.js"
import { externalToolContent } from "./tool-content.js"
import { capabilityCallInput, capabilityToolMatch, type CapabilityToolMatch } from "./capability-tool.js"

export const CAPABILITY_SOURCE_KINDS = ["catalog", "native", "externalMcp", "marketplace", "builtinSkill", "remoteSession", "slackSendAsBot", "admin"] as const
export type CapabilitySourceKind = (typeof CAPABILITY_SOURCE_KINDS)[number]

/**
 * Sources whose capabilities Code Mode scripts (ad-hoc tests, saved Workflows,
 * Apps, Automations) can call. Platform-admin tools are left out: one script
 * could otherwise hand what an admin tool reads straight to a connection tool
 * with no call in between for the client to show. Admins call them one at a
 * time through execute_capability, their full-view tools or /mcp/admin.
 */
const SCRIPT_SOURCE_KINDS: readonly CapabilitySourceKind[] = CAPABILITY_SOURCE_KINDS.filter((kind) => kind !== "admin")

export type ParsedCapability =
  | { kind: "catalog"; name: string }
  | { kind: "native"; name: string; connectionId: string; toolName: string }
  | { kind: "externalMcp"; name: string; connectionId: string; toolName: string }
  | { kind: "marketplace"; name: string; configObjectId: string; pluginId: string }
  | { kind: "builtinSkill"; name: string }
  | { kind: "remoteSession"; name: string; action: RemoteSessionAction }
  | { kind: "slackSendAsBot"; name: string }
  | { kind: "admin"; name: string; toolName: string }

export type ExecuteCapabilityToolResult = {
  isError?: boolean
  content: CallToolResult["content"]
  structuredContent?: Record<string, unknown>
  _meta?: Record<string, unknown>
}

export type CapabilityExecuteInput = {
  name: string
  schemaDigest?: string
  /** Refuse an external tool whose input schema no longer matches schemaDigest. */
  requireSchemaMatch?: boolean
  /** Refuse an external tool that its provider no longer marks read-only for this caller. */
  requireReadOnly?: boolean
  /** One object matching the search match's `inputSchema`; wins over path/query/body. */
  arguments?: unknown
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
  /** Managed deployment planning, launch preparation and status (managed deployments enabled). */
  managedDeploymentsEnabled: boolean
  /** `remote-session:status`, rolled out with the desktop's remote sub-agents. */
  remoteSessionStatusEnabled: boolean
  /** remote-session:answer: the member's agent answers a task's question for the person, after asking them. */
  remoteSessionAnswersEnabled: boolean
  /** `slack_send_as_bot` (feature `slackSendAsBot`); it also needs a member and the write scope. */
  slackSendAsBotEnabled: boolean
  resolvePlatformAdmin: () => Promise<boolean>
  resolveNamespaceContext: () => Promise<CodemodeConnectionNamespaceContext>
  /** Set only by MCP transports: direct service mutations are audited for this caller (src/audit/service-actions.ts). */
  audit: McpAuditPrincipal | null
  /** What started these capability calls, recorded with each Library usage event. */
  usageSource: CapabilityUsageSource
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
  /** Effective features of the organization (see features.ts). */
  organizationFeatures: Partial<Pick<FeatureMap, "remoteSessionSubagents" | "remoteSessionAnswers" | "managedDeployments" | "slackSendAsBot" | "outlookAttachments">>
  /** MCP transports pass the verified caller; route and Automation contexts omit it (their route records the request). */
  audit?: McpAuditPrincipal | null
  /**
   * What starts these calls, for Library usage: the member's agent (MCP agent
   * transport), a saved Workflow run (the run route), a scheduled Automation,
   * or an App. Live artifact renders derive an `artifact` context.
   */
  usageSource: CapabilityUsageSource
}

export function createCapabilityRegistryContext(input: CapabilityRegistryContextInput): CapabilityRegistryContext {
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
    })
    return namespaceContext
  }
  return {
    app: input.app,
    env: input.env,
    // All capability paths (search, Code Mode, execution, saved Workflows) use this catalog.
    // The route also checks the current rollout so a cached tool cannot bypass a kill switch.
    catalog: input.catalog.filter((operation) => nativeOperationAvailableToCapabilities({
      outlookAttachmentsEnabled: input.organizationFeatures.outlookAttachments === true,
    }, operation)),
    principal: input.principal,
    organizationId: input.organizationId,
    member: input.member,
    redirectUriBase: input.redirectUriBase,
    generatedArtifactViewsEnabled: input.generatedArtifactViewsEnabled,
    managedDeploymentsEnabled: input.organizationFeatures.managedDeployments === true,
    remoteSessionStatusEnabled: input.organizationFeatures.remoteSessionSubagents === true,
    // Only a chat with the person in it may answer: never an Automation, a Workflow run or an App.
    remoteSessionAnswersEnabled: input.organizationFeatures.remoteSessionSubagents === true
      && input.organizationFeatures.remoteSessionAnswers === true && input.usageSource === "agent",
    slackSendAsBotEnabled: input.organizationFeatures.slackSendAsBot === true,
    resolvePlatformAdmin,
    resolveNamespaceContext,
    audit: input.audit ?? null,
    usageSource: input.usageSource,
  }
}

/** The same context with calls credited to another Library usage source. */
export function withUsageSource<T extends Pick<CapabilityRegistryContext, "usageSource">>(ctx: T, usageSource: CapabilityUsageSource): T {
  return ctx.usageSource === usageSource ? ctx : { ...ctx, usageSource }
}

/**
 * Capabilities a saved Workflow's script calls count as Workflow use when the
 * member's agent started it; Automation, App and artifact runs keep their source.
 */
export function workflowUsageContext<T extends Pick<CapabilityRegistryContext, "usageSource">>(ctx: T): T {
  return ctx.usageSource === "agent" ? withUsageSource(ctx, "workflow") : ctx
}

/** HTTP-equivalent status of a failed Workflow execution, or null on success. */
export function workflowExecutionAuditStatus(result: { ok: true } | { ok: false; error: string }): number | null {
  if (result.ok) return null
  if (result.error === "invalid_arguments" || result.error === "invalid_result") return 400
  // No provider call was attempted, so no external effect happened.
  if (result.error === "capability_unavailable" || result.error === "unsupported") return 424
  return 502
}

/** Service-layer audit of saved Workflow runs for MCP callers; undefined for route/Automation contexts. */
export function workflowExecutionAudit(ctx: Pick<CapabilityRegistryContext, "audit">): MarketplaceWorkflowAudit | undefined {
  const principal = ctx.audit
  if (!principal) return undefined
  return (configObjectId, run) => runMcpServiceAction("workflow.execute", principal, serviceAuditResourceId(configObjectId), run, {
    result: workflowExecutionAuditStatus, error: serviceErrorStatus,
  })
}

/**
 * Whether this caller may see and run slack_send_as_bot: the feature on, an active member, and a token that may
 * write. Read-only tokens (Your agent's background turns) never list it.
 */
export function slackSendAsBotAvailable(ctx: Pick<CapabilityRegistryContext, "slackSendAsBotEnabled" | "member" | "principal">): boolean {
  return ctx.slackSendAsBotEnabled && ctx.member !== null && ctx.principal.scopes.has(DEN_MCP_WRITE_SCOPE)
}

const remoteSessionAuditActions: Partial<Record<RemoteSessionAction, AuditServiceActionName>> = {
  create: "remote_session.create", send: "remote_session.send", stop: "remote_session.stop", answer: "remote_session.answer",
}

function remoteSessionResourceId(body: unknown): string | null {
  const normalized = normalizeToolBody(body)
  if (typeof normalized !== "object" || normalized === null || Array.isArray(normalized) || !("sessionId" in normalized)) return null
  return serviceAuditResourceId(normalized.sessionId)
}

export { catalogOperationAvailableToCapabilities }

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

/** A tool execution error the model can act on, as text and as structured content. */
function capabilityErrorResult(payload: Record<string, unknown>): ExecuteCapabilityToolResult {
  return { isError: true, content: textContent(JSON.stringify(payload)), structuredContent: payload }
}

function unknownCapabilityResult(name: string): ExecuteCapabilityToolResult {
  return capabilityErrorResult({
    error: "unknown_capability",
    message: `No capability named "${name}". Call search_capabilities to find a valid name.`,
  })
}

const externalMcpProviderErrorOutputSchema = z.object({
  jsonRpcCode: z.number().int().optional(),
  message: z.string().optional(),
  data: z.string().optional(),
})

const externalCapabilityErrorPayloadSchema = z.object({
  error: z.string(),
  reason: z.string().optional(),
  message: z.string(),
  requiredScope: z.enum(["mcp:read", "mcp:write"]).optional(),
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
    ...(result.reason ? { reason: result.reason } : {}),
    message: result.message,
    ...(result.requiredScope ? { requiredScope: result.requiredScope } : {}),
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
  if (!result.connectionStatus) return capabilityErrorResult(payload)
  return {
    isError: true,
    content: textContent(JSON.stringify(payload)),
    structuredContent: connectionActionPayloadFromStatus(result.connectionStatus),
    _meta: connectionActionAppMeta(result.connectionStatus.connectionId),
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
  const providerMeta = isRecord(result.result) && isRecord(result.result._meta)
    ? result.result._meta
    : {}
  const meta = {
    ...providerMeta,
    ...(result.mcpApp ? {
      "openwork/mcpApp": result.mcpApp,
      "openwork/serverTools": {
        searchCapabilities: SEARCH_CAPABILITIES_TOOL_NAME,
        executeCapability: EXECUTE_CAPABILITY_TOOL_NAME,
      },
    } : {}),
    ...(result.schemaGuidance ? { "openwork/schemaGuidance": result.schemaGuidance } : {}),
  }
  return {
    ...(isRecord(result.result) && typeof result.result.isError === "boolean" ? { isError: result.result.isError } : {}),
    content: [
      ...content,
      // Only the advisory is model-visible; never serialize provider _meta.
      ...(result.schemaGuidance ? textContent(JSON.stringify({ "openwork/schemaGuidance": result.schemaGuidance })) : []),
    ],
    ...(providerStructuredContent ? { structuredContent: providerStructuredContent } : {}),
    ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
  }
}

function marketplaceCapabilityErrorToolResult(
  result: Exclude<MarketplaceCapabilityExecuteResult, { ok: true }>,
): ExecuteCapabilityToolResult {
  return capabilityErrorResult(Object.fromEntries(Object.entries(result).filter(([key]) => key !== "ok")))
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
    // Only a Workflow builds tools: what its script calls is Workflow use.
    buildTools: () => buildCapabilityToolTree(workflowUsageContext(ctx)),
    organizationId: ctx.organizationId,
    member: ctx.member,
    pluginId: parsed.pluginId,
    configObjectId: parsed.configObjectId,
    body: input.body,
    validateScriptOutput: true,
    redirectUriBase: ctx.redirectUriBase,
    auditWorkflowExecution: workflowExecutionAudit(ctx),
    usageSource: ctx.usageSource,
    describeUnavailable: (missing) => liveArtifactConnectionFailure(ctx, missing),
  })
}

function parsedForKind<K extends CapabilitySourceKind>(parsed: ParsedCapability, kind: K): parsed is Extract<ParsedCapability, { kind: K }> {
  return parsed.kind === kind
}

const catalogSource: CapabilitySource = {
  kind: "catalog",
  // Every name without a colon is a Den operation, except the Den-native capabilities named like tools.
  parseName: (name) => name.includes(":") || isSlackSendAsBotCapabilityName(name) ? null : { kind: "catalog", name },
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
    return result
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
      scopes: ctx.principal.scopes,
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
      usageSource: ctx.usageSource,
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
    if (!ctx.sourceFilter.mcp) return []
    return searchExternalCapabilities({
      organizationId: ctx.organizationId,
      member: ctx.member,
      query,
      redirectUriBase: ctx.redirectUriBase,
      limit,
      namespaceContext: await ctx.resolveNamespaceContext(),
      reportCoverage: (coverage) => ctx.reportExternalCoverage(externalMcpSearchCoverageHint(coverage)),
      scopes: ctx.principal.scopes,
    })
  },
  enumerate: async (ctx) => {
    return leavesFromBuilt(await buildExternalMcpToolTree({
      organizationId: ctx.organizationId,
      member: ctx.member,
      scopes: ctx.principal.scopes,
      redirectUriBase: ctx.redirectUriBase,
      namespaceContext: await ctx.resolveNamespaceContext(),
      usageSource: ctx.usageSource,
    }))
  },
  execute: async (ctx, parsed, input) => {
    if (!parsedForKind(parsed, "externalMcp")) return unknownCapabilityResult(input.name)
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
        return capabilityErrorResult({ error: probe.error, message: probe.message })
      }
      const payload = probe.connected
        ? connectedConnectionActionPayload({ connectionId: probe.connection.id, connectionName: probe.connection.name })
        : connectionActionPayloadFromStatus(probe.status)
      return {
        content: textContent(connectionActionTextFallback(payload)),
        structuredContent: { ...payload },
        _meta: connectionActionAppMeta(payload.connectionId),
      }
    }
    const result = await executeExternalCapability({
      organizationId: ctx.organizationId,
      member: ctx.member,
      scopes: ctx.principal.scopes,
      connectionId: parsed.connectionId,
      toolName: parsed.toolName,
      args: normalizeToolBody(input.body),
      schemaDigest: input.schemaDigest,
      ...(input.requireSchemaMatch ? { requireSchemaMatch: true } : {}),
      ...(input.requireReadOnly ? { requireReadOnly: true } : {}),
      redirectUriBase: ctx.redirectUriBase,
      usageSource: ctx.usageSource,
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
    if (!ctx.sourceFilter.marketplace) return []
    const matches = await searchMarketplaceCapabilities({
      organizationId: ctx.organizationId,
      member: ctx.member,
      objectTypes: ctx.marketplaceObjectTypes,
      query,
      limit,
    })
    return matches.map((match) => match.kind !== "workflow"
      ? { ...match, scriptPath: codemodeScriptPath("marketplace", match.name) }
      : match)
  },
  enumerate: async (ctx) => {
    const references = await listAccessibleMarketplaceCapabilityReferences({
      organizationId: ctx.organizationId,
      member: ctx.member,
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
    if (!ctx.sourceFilter.api || !ctx.member) return []
    return searchRemoteSessionCapabilities(query, limit, { status: ctx.remoteSessionStatusEnabled, answer: ctx.remoteSessionAnswersEnabled })
  },
  // Deliberately absent from the confined-script tool tree in v1: remote
  // sessions are long-lived side effects that agents should drive through
  // explicit execute_capability calls, not batched scripts.
  enumerate: () => Promise.resolve([]),
  execute: async (ctx, parsed, input) => {
    if (!parsedForKind(parsed, "remoteSession")) return unknownCapabilityResult(input.name)
    if (parsed.action === "status" && !ctx.remoteSessionStatusEnabled) return unknownCapabilityResult(input.name)
    if (parsed.action === "answer" && !ctx.remoteSessionAnswersEnabled) return unknownCapabilityResult(input.name)
    if (!ctx.member) {
      return capabilityErrorResult({
        error: "membership_required",
        message: "Remote sessions require an active organization membership.",
      })
    }
    const run = () => executeRemoteSessionCapability({
      action: parsed.action,
      organizationId: ctx.organizationId,
      userId: ctx.principal.userId,
      hasWriteScope: ctx.principal.scopes.has(DEN_MCP_WRITE_SCOPE),
      body: input.body,
      headlessRunTokenId: headlessRunTokenId(ctx.principal.payload),
    })
    const auditAction = remoteSessionAuditActions[parsed.action]
    if (!auditAction || !ctx.audit) return run()
    try {
      return await runMcpServiceAction(auditAction, ctx.audit, remoteSessionResourceId(input.body), run, { result: toolResultStatus })
    } catch (error) {
      if (error instanceof AuditUnavailableError) return auditUnavailableToolResult()
      throw error
    }
  },
}

const slackSendAsBotSource: CapabilitySource = {
  kind: "slackSendAsBot",
  parseName: (name) => isSlackSendAsBotCapabilityName(name) ? { kind: "slackSendAsBot", name } : null,
  // Listed with Den's own operations and next to the Slack connection's tools.
  search: async (ctx, query) => {
    if (!(ctx.sourceFilter.api || ctx.sourceFilter.mcp) || !slackSendAsBotAvailable(ctx)) return []
    return searchSlackSendAsBotCapability(query)
  },
  // Not in Code Mode scripts in v1: each message is one explicit call the person can see.
  enumerate: () => Promise.resolve([]),
  execute: async (ctx, parsed, input) => {
    if (!parsedForKind(parsed, "slackSendAsBot") || !ctx.slackSendAsBotEnabled) return unknownCapabilityResult(input.name)
    const run = () => executeSlackSendAsBot({
      organizationId: ctx.organizationId,
      userId: ctx.principal.userId,
      memberId: ctx.member?.orgMembershipId ?? null,
      hasWriteScope: ctx.principal.scopes.has(DEN_MCP_WRITE_SCOPE),
      body: input.body,
    })
    if (!ctx.audit) return run()
    try {
      return await runMcpServiceAction("slack_assistant.bot_message.send", ctx.audit, null, run, { result: toolResultStatus })
    } catch (error) {
      if (error instanceof AuditUnavailableError) return auditUnavailableToolResult()
      throw error
    }
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
    // No scriptPath: Code Mode scripts cannot call admin tools (SCRIPT_SOURCE_KINDS).
    return searchAvailableAdminCapabilities(await ctx.resolvePlatformAdmin(), query, limit)
  },
  // Full-view tools list these; Code Mode trees leave them out.
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
    const admin = { userId: ctx.principal.userId, credentialId: mcpPrincipalCredentialId(ctx.principal), scopes: ctx.principal.scopes }
    return (await executeAdminCapability(parsed.name, input.body, admin)) ?? unknownCapabilityResult(input.name)
  },
}

export const CAPABILITY_SOURCES: Record<CapabilitySourceKind, CapabilitySource> = {
  catalog: catalogSource,
  native: nativeSource,
  externalMcp: externalMcpSource,
  marketplace: marketplaceSource,
  builtinSkill: builtinSkillSource,
  remoteSession: remoteSessionSource,
  slackSendAsBot: slackSendAsBotSource,
  admin: adminSource,
}

export function createCapabilityRegistry(sources: Record<CapabilitySourceKind, CapabilitySource>) {
  return {
    search: async (
      ctx: CapabilityRegistryContext,
      input: {
        query: string
        limit: number
        type?: SearchCapabilityType
        /** Only what has no tool of its own in the full view (engine-tool-view.ts). */
        unlistedOnly?: boolean
      },
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
      const kinds = input.unlistedOnly
        ? CAPABILITY_SOURCE_KINDS.filter((kind) => !ENGINE_LISTED_SOURCE_KINDS.has(kind))
        : CAPABILITY_SOURCE_KINDS
      const sourceMatches = (await Promise.all(kinds.map((kind) => (
        sources[kind].search(searchContext, input.query, input.limit)
      )))).flat()
      const matches = (input.unlistedOnly ? unlistedCapabilityMatches(sourceMatches) : sourceMatches)
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
        if (!parsed) continue
        const call = capabilityCallInput(
          input.arguments === undefined ? input : { ...input, arguments: normalizeToolBody(input.arguments) },
          HTTP_ARGUMENT_KINDS.has(kind),
        )
        return call.ok ? source.execute(ctx, parsed, call.input) : capabilityErrorResult(call.error)
      }
      return unknownCapabilityResult(input.name)
    },
    buildToolTree: async (ctx: CapabilityRegistryContext): Promise<BuiltCodemodeTools> => {
      const enumerated = await Promise.all(SCRIPT_SOURCE_KINDS.map(async (kind) => {
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

/** Den API and native connector operations take `{ path, query, body }` as their arguments. */
const HTTP_ARGUMENT_KINDS: ReadonlySet<CapabilitySourceKind> = new Set(["catalog", "native"])

/** A search match in MCP `Tool` shape, with its `inputSchema` built the way execute reads `arguments`. */
export function capabilitySearchMatch(match: CapabilityMatch): CapabilityToolMatch {
  const kind = CAPABILITY_SOURCE_KINDS.find((candidate) => CAPABILITY_SOURCES[candidate].parseName(match.name) !== null)
  return capabilityToolMatch(match, kind !== undefined && HTTP_ARGUMENT_KINDS.has(kind))
}

export const CAPABILITY_REGISTRY = createCapabilityRegistry(CAPABILITY_SOURCES)
export const searchCapabilityRegistry = CAPABILITY_REGISTRY.search
export const executeCapability = CAPABILITY_REGISTRY.execute
export const buildCapabilityToolTree = CAPABILITY_REGISTRY.buildToolTree

export async function liveArtifactConnectionFailure(
  context: CapabilityRegistryContext,
  missing: readonly { capabilityName: string }[],
) {
  const status = await nativeConnectionFailure(context, missing) ?? await externalConnectionFailure(context, missing)
  return status ? {
    connectionStatus: status,
    connectionCard: connectionActionPayloadFromStatus(status),
  } : null
}

async function nativeConnectionFailure(
  context: CapabilityRegistryContext,
  missing: readonly { capabilityName: string }[],
) {
  const ids = new Set(missing.flatMap((entry) => {
    const parsed = parseNativeCapabilityName(entry.capabilityName)
    return parsed ? [parsed.connectionId] : []
  }))
  if (!ids.size) return null
  const namespace = await context.resolveNamespaceContext()
  const connection = namespace.nativeProviderEntries.find((entry) => ids.has(entry.id) && !entry.connectedForMe)
  return connection ? connectionStatusMatch(connection, 1).connectionStatus ?? null : null
}

async function externalConnectionFailure(
  context: CapabilityRegistryContext,
  missing: readonly { capabilityName: string }[],
) {
  for (const entry of missing) {
    const parsed = parseExternalCapabilityName(entry.capabilityName)
    if (!parsed) continue
    const status = await unavailableExternalCapabilityStatus({
      organizationId: context.organizationId,
      member: context.member,
      connectionId: parsed.connectionId,
      toolName: parsed.toolName,
      redirectUriBase: context.redirectUriBase,
    })
    if (status) return status
  }
  return null
}
