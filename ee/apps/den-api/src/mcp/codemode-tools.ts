import { Tool, toolError } from "@openwork/codemode"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { Effect } from "effect"
import type { Hono } from "hono"
import { z } from "zod"
import type { ExternalMcpConnectionRow } from "../capability-sources/external-mcp-connections.js"
import type { NativeProviderConnectionEntry } from "../capability-sources/native-provider-connections.js"
import { listExternalMcpTools } from "../capability-sources/external-mcp-client-runtime.js"
import { createExternalMcpLifecycleDeadline, EXTERNAL_MCP_TOOL_LIFECYCLE_TIMEOUT_MS } from "../capability-sources/external-mcp-client.js"
import { isToolDisabled } from "../capability-sources/external-mcp-tool-policy.js"
import { NATIVE_OAUTH_PROVIDERS } from "../capability-sources/provider-registry.js"
import type { McpPrincipal } from "./auth.js"
import type { McpToolOperation } from "./catalog.js"
import {
  codemodeScriptPath,
  resolveCodemodeConnectionNamespaceContext,
  type CodemodeConnectionNamespaceContext,
} from "./codemode-namespaces.js"
import {
  buildExternalCapabilityName,
  executeExternalCapability,
  EXTERNAL_MCP_SEARCH_CONCURRENCY,
  type McpMemberIdentity,
} from "./external-capabilities.js"
import { invokeMcpOperation, normalizeToolBody, normalizeToolRecord } from "./invoke.js"
import {
  buildNativeCapabilityName,
  executeNativeCapability,
  nativeOperations,
} from "./native-capabilities.js"

export {
  buildCodemodeConnectionNamespaceMaps,
  buildExternalNamespaceMap,
  codemodeScriptPath,
  isCodemodeEligibleConnection,
  sanitizeNamespaceSegment,
} from "./codemode-namespaces.js"

export type CodemodeToolTree = Record<string, Record<string, Tool.Definition>>

export type CodemodeManifestEntry = {
  scriptPath: string
  capabilityName: string
  readOnly?: boolean
  authority?: "den" | "external"
}

export type BuiltCodemodeTools = {
  tools: CodemodeToolTree
  manifest: CodemodeManifestEntry[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function stripUndefinedEntries(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Array.from(value, (entry) => entry === undefined ? null : stripUndefinedEntries(entry))
  }
  if (!isRecord(value)) return value
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  const stripped: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) stripped[key] = stripUndefinedEntries(entry)
  }
  return stripped
}

function isCodemodeJsonSchema(value: unknown): value is Tool.JsonSchema {
  return isRecord(value)
}

function denInputJsonSchema(operation: McpToolOperation): Tool.JsonSchema {
  const serialized = JSON.stringify(z.toJSONSchema(operation.inputSchema), (key, value: unknown) => key === "~standard" ? undefined : value)
  const schema: unknown = JSON.parse(serialized)
  return isCodemodeJsonSchema(schema) ? schema : {}
}

export function restrictCodemodeToolTree(input: {
  built: BuiltCodemodeTools
  requiredCapabilities: readonly CodemodeManifestEntry[]
}): { tools: CodemodeToolTree; missing: CodemodeManifestEntry[] } {
  const manifest = new Set(input.built.manifest.map((entry) => `${entry.scriptPath}\n${entry.capabilityName}`))
  const available = new Map<string, { namespace: string; name: string; definition: Tool.Definition }>()
  for (const [namespace, tools] of Object.entries(input.built.tools)) {
    for (const [name, definition] of Object.entries(tools)) {
      available.set(codemodeScriptPath(namespace, name), { namespace, name, definition })
    }
  }

  const namespaceTools = new Map<string, Map<string, Tool.Definition>>()
  const missing: CodemodeManifestEntry[] = []
  for (const required of input.requiredCapabilities) {
    const resolved = available.get(required.scriptPath)
    if (!resolved || !manifest.has(`${required.scriptPath}\n${required.capabilityName}`)) {
      missing.push(required)
      continue
    }
    const tools = namespaceTools.get(resolved.namespace) ?? new Map<string, Tool.Definition>()
    tools.set(resolved.name, resolved.definition)
    namespaceTools.set(resolved.namespace, tools)
  }
  return {
    tools: Object.fromEntries([...namespaceTools].map(([namespace, tools]) => [namespace, Object.fromEntries(tools)])),
    missing,
  }
}

/**
 * Unattended Cloud runs may be retried after a lost lease, so Phase 1 admits
 * only read-only capabilities implemented by Den itself. External MCP tools
 * remain available to interactive saved-Script runs, but provider metadata is
 * not an authority boundary for unattended execution.
 */
export function firstUnattendedUnsafeCapability(
  built: BuiltCodemodeTools,
  requiredCapabilities: readonly CodemodeManifestEntry[],
): CodemodeManifestEntry | null {
  const manifest = new Map(built.manifest.map((entry) => [
    `${entry.scriptPath}\n${entry.capabilityName}`,
    entry,
  ]))
  return requiredCapabilities.find((required) => {
    const available = manifest.get(`${required.scriptPath}\n${required.capabilityName}`)
    return available?.authority !== "den" || available.readOnly !== true
  }) ?? null
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

const NATIVE_CAPABILITY_PATH_PREFIXES = Object.keys(NATIVE_OAUTH_PROVIDERS)
  .map((providerKey) => `/v1/capabilities/${providerKey}/`)

/** Native provider routes are callable only through a credential-bound connection namespace. */
export function isCredentialBoundNativeOperation(operation: Pick<McpToolOperation, "path">): boolean {
  return NATIVE_CAPABILITY_PATH_PREFIXES.some((pathPrefix) => operation.path.startsWith(pathPrefix))
}

export function buildDenCatalogToolTree(input: {
  app: Hono
  env: unknown
  catalog: readonly McpToolOperation[]
  principal: McpPrincipal
}): BuiltCodemodeTools {
  const operations = input.catalog.filter((operation) => !isCredentialBoundNativeOperation(operation))
  const definitions = operations.map((operation) => [operation.name, Tool.make({
    description: operation.operation.summary ?? operation.operation.description ?? operation.name,
    input: denInputJsonSchema(operation),
    run: (toolInput) => Effect.promise(() => invokeMcpOperation({
      app: input.app,
      env: input.env,
      operation,
      principal: input.principal,
      toolInput: {
        path: normalizeToolRecord(isRecord(toolInput) ? toolInput.path : undefined),
        query: normalizeToolRecord(isRecord(toolInput) ? toolInput.query : undefined),
        body: normalizeToolBody(isRecord(toolInput) ? toolInput.body : undefined),
      },
    })).pipe(Effect.flatMap((result) => result.isError
      ? Effect.fail(toolError(toolResultError(result)))
      : Effect.succeed(toolResultValue(result)))),
  })] satisfies [string, Tool.Definition])
  return {
    tools: { den: Object.fromEntries(definitions) },
    manifest: operations.map((operation) => ({
      scriptPath: codemodeScriptPath("den", operation.name),
      capabilityName: operation.name,
      readOnly: operation.method === "GET",
      authority: "den" as const,
    })),
  }
}

type NativeManifestConnection = Pick<NativeProviderConnectionEntry, "id" | "nativeProviderKey">

export function buildNativeProviderManifest(input: {
  connections: readonly NativeManifestConnection[]
  catalog: readonly McpToolOperation[]
  namespaces: ReadonlyMap<string, string>
}): CodemodeManifestEntry[] {
  return input.connections.flatMap((connection) => {
    const namespace = input.namespaces.get(connection.id)
    if (!namespace) return []
    return nativeOperations(input.catalog, connection.nativeProviderKey).map((operation) => ({
      scriptPath: codemodeScriptPath(namespace, operation.name),
      capabilityName: buildNativeCapabilityName(connection.id, operation.name),
      // Native providers are Den-implemented routes (invokeMcpOperation, just
      // credential-bound to a connection), so they carry the same authority and
      // read-only classification as the plain catalog. Without this, every
      // native capability would be rejected by the unattended-run gate.
      readOnly: operation.method === "GET",
      authority: "den" as const,
    }))
  })
}

export async function buildNativeProviderToolTree(input: {
  app: Hono
  env: unknown
  catalog: readonly McpToolOperation[]
  principal: McpPrincipal
  organizationId: string
  member: McpMemberIdentity | null
  namespaceContext?: CodemodeConnectionNamespaceContext
}): Promise<BuiltCodemodeTools> {
  if (!input.member) return { tools: {}, manifest: [] }
  const memberIdentity = input.member
  const namespaceContext = input.namespaceContext ?? await resolveCodemodeConnectionNamespaceContext({
    organizationId: input.organizationId,
    member: memberIdentity,
  })
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const namespaceEntries = namespaceContext.codemodeNativeProviderEntries.flatMap((connection) => {
    const namespace = namespaceContext.namespaces.native.get(connection.id)
    if (!namespace) return []
    const definitions = nativeOperations(input.catalog, connection.nativeProviderKey).map((operation) => [operation.name, Tool.make({
      description: operation.operation.summary ?? operation.operation.description ?? operation.name,
      input: denInputJsonSchema(operation),
      run: (toolInput) => Effect.promise(() => executeNativeCapability({
        app: input.app,
        env: input.env,
        name: buildNativeCapabilityName(connection.id, operation.name),
        organizationId,
        member: memberIdentity,
        catalog: input.catalog,
        principal: input.principal,
        path: normalizeToolRecord(isRecord(toolInput) ? toolInput.path : undefined),
        query: normalizeToolRecord(isRecord(toolInput) ? toolInput.query : undefined),
        body: normalizeToolBody(isRecord(toolInput) ? toolInput.body : undefined),
      })).pipe(Effect.flatMap((result) => !result || result.isError
        ? Effect.fail(toolError(toolResultError(result)))
        : Effect.succeed(toolResultValue(result)))),
    })] satisfies [string, Tool.Definition])
    return [[namespace, Object.fromEntries(definitions)] satisfies [string, Record<string, Tool.Definition>]]
  })

  return {
    tools: Object.fromEntries(namespaceEntries),
    manifest: buildNativeProviderManifest({
      connections: namespaceContext.codemodeNativeProviderEntries,
      catalog: input.catalog,
      namespaces: namespaceContext.namespaces.native,
    }),
  }
}

async function mapConcurrent<T, R>(items: readonly T[], limit: number, visit: (item: T) => Promise<R>): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = Array.from({ length: items.length })
  let nextIndex = 0
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      const item = items[index]
      if (item === undefined) return
      results[index] = await visit(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

function externalRedirectUri(redirectUriBase: string, connectionId: string): string {
  return `${redirectUriBase}/v1/mcp-connections/${encodeURIComponent(connectionId)}/connect/callback`
}

type ListedExternalConnection = {
  connection: ExternalMcpConnectionRow
  tools: Awaited<ReturnType<typeof listExternalMcpTools>>
}

function isListedExternalConnection(value: ListedExternalConnection | undefined): value is ListedExternalConnection {
  return value !== undefined
}

export async function buildExternalMcpToolTree(input: {
  organizationId: string
  member: McpMemberIdentity | null
  redirectUriBase: string
  namespaceContext?: CodemodeConnectionNamespaceContext
}): Promise<BuiltCodemodeTools> {
  if (!input.member) return { tools: {}, manifest: [] }
  const memberIdentity = input.member
  const namespaceContext = input.namespaceContext ?? await resolveCodemodeConnectionNamespaceContext({
    organizationId: input.organizationId,
    member: memberIdentity,
  })
  const connections = namespaceContext.codemodeExternalMcpConnections
  const deadline = createExternalMcpLifecycleDeadline(EXTERNAL_MCP_TOOL_LIFECYCLE_TIMEOUT_MS)
  const listed = (await mapConcurrent(connections, EXTERNAL_MCP_SEARCH_CONCURRENCY, async (connection) => {
    try {
      const member = connection.credentialMode === "per_member"
        ? { orgMembershipId: memberIdentity.orgMembershipId }
        : undefined
      const tools = await listExternalMcpTools(
        connection,
        externalRedirectUri(input.redirectUriBase, connection.id),
        member,
        undefined,
        deadline,
      )
      return { connection, tools }
    } catch {
      return undefined
    }
  })).filter(isListedExternalConnection)
  const namespaces = namespaceContext.namespaces.externalMcp
  const namespaceEntries = listed.flatMap(({ connection, tools }) => {
    const namespace = namespaces.get(connection.id)
    if (!namespace) return []
    const enabledTools = tools.filter((tool) => !isToolDisabled(connection.toolPolicy, tool.name))
    const definitions = enabledTools.map((tool) => [tool.name, Tool.make({
      description: tool.description ?? tool.title ?? tool.name,
      input: tool.inputSchema,
      run: (args) => Effect.promise(() => executeExternalCapability({
        organizationId: input.organizationId,
        member: memberIdentity,
        connectionId: connection.id,
        toolName: tool.name,
        args: stripUndefinedEntries(args),
        redirectUriBase: input.redirectUriBase,
      })).pipe(Effect.flatMap((result) => result.ok
        ? Effect.succeed(toolResultValue(result.result))
        : Effect.fail(toolError(result.message)))),
    })] satisfies [string, Tool.Definition])
    return [[namespace, Object.fromEntries(definitions)] satisfies [string, Record<string, Tool.Definition>]]
  })
  return {
    tools: Object.fromEntries(namespaceEntries),
    manifest: listed.flatMap(({ connection, tools }) => {
      const namespace = namespaces.get(connection.id)
      if (!namespace) return []
      return tools
        .filter((tool) => !isToolDisabled(connection.toolPolicy, tool.name))
        .map((tool) => ({
          scriptPath: codemodeScriptPath(namespace, tool.name),
          capabilityName: buildExternalCapabilityName(connection.id, tool.name),
          readOnly: tool.annotations?.readOnlyHint === true,
          authority: "external" as const,
        }))
    }),
  }
}
