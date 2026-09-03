import type { DenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { listNativeProviderUsableEntries, type NativeProviderConnectionEntry } from "../capability-sources/native-provider-connections.js"
import type { McpPrincipal } from "./auth.js"
import type { AgentToolContentPart } from "./tool-content.js"
import {
  getJsonRequestBodySchema,
  getParameters,
  getQueryParameterSchema,
  hasJsonRequestBody,
  pathParameterNamesFromTemplate,
  type McpToolOperation,
} from "./catalog.js"
import { buildExternalConnectionStatus, type ExternalCapabilityMatch, type McpMemberIdentity } from "./external-capabilities.js"
import { invokeMcpOperation, normalizeToolBody, normalizeToolRecord } from "./invoke.js"
import { compareCapabilityMatches, scoreText, tokenize, type CapabilityMatch } from "./search.js"
import {
  codemodeScriptPath,
  resolveCodemodeConnectionNamespaceContext,
  type CodemodeConnectionNamespaceContext,
} from "./codemode-namespaces.js"

export const NATIVE_CAPABILITY_PREFIX = "native:"

export function buildNativeCapabilityName(connectionId: string, toolName: string): string {
  return `${NATIVE_CAPABILITY_PREFIX}${connectionId}:${toolName}`
}

export function parseNativeCapabilityName(name: string): { connectionId: string; toolName: string } | null {
  if (!name.startsWith(NATIVE_CAPABILITY_PREFIX)) return null
  const rest = name.slice(NATIVE_CAPABILITY_PREFIX.length)
  const separatorIndex = rest.indexOf(":")
  if (separatorIndex <= 0) return null
  return {
    connectionId: rest.slice(0, separatorIndex),
    toolName: rest.slice(separatorIndex + 1),
  }
}

export type NativeCapabilityMatch = CapabilityMatch & {
  kind?: ExternalCapabilityMatch["kind"]
  status?: ExternalCapabilityMatch["status"]
  hint?: string
  connectionStatus?: ExternalCapabilityMatch["connectionStatus"]
}

function operationSummary(operation: McpToolOperation): string {
  return operation.operation.summary ?? operation.operation.description ?? `${operation.method} ${operation.path}`
}

function operationNameTokens(connectionName: string, operationName: string): string[] {
  const words = operationName.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  return tokenize(`${connectionName} ${words}`)
}

function operationScore(connection: NativeProviderConnectionEntry, operation: McpToolOperation, queryTokens: string[]): number {
  return scoreText(
    operationNameTokens(connection.name, operation.name),
    tokenize(`${connection.name} ${operationSummary(operation)}`),
    queryTokens,
    tokenize(operation.path),
  )
}

export function nativeOperations(catalog: readonly McpToolOperation[], nativeProviderKey: string): McpToolOperation[] {
  const pathPrefix = `/v1/capabilities/${nativeProviderKey}/`
  return catalog.filter((operation) => operation.path.startsWith(pathPrefix))
}

function capabilityMatch(
  connection: NativeProviderConnectionEntry,
  operation: McpToolOperation,
  score: number,
  scriptNamespace?: string,
): NativeCapabilityMatch {
  const bodySchema = getJsonRequestBodySchema(operation.operation)
  const querySchema = getQueryParameterSchema(operation.operation)
  return {
    name: buildNativeCapabilityName(connection.id, operation.name),
    method: operation.method,
    path: operation.path,
    score,
    summary: `[${connection.name}] ${operationSummary(operation)}`,
    pathParams: pathParameterNamesFromTemplate(operation.path),
    queryParams: getParameters(operation.operation, "query")
      .flatMap((parameter) => typeof parameter.name === "string" ? [parameter.name] : []),
    hasBody: hasJsonRequestBody(operation.operation),
    ...(bodySchema === undefined ? {} : { bodySchema }),
    ...(querySchema === undefined ? {} : { querySchema }),
    ...(scriptNamespace ? { scriptPath: codemodeScriptPath(scriptNamespace, operation.name) } : {}),
  }
}

function connectionStatusMatch(
  connection: NativeProviderConnectionEntry,
  score: number,
): NativeCapabilityMatch {
  const message = `You haven't connected your ${connection.name} account yet.`
  return {
    name: buildNativeCapabilityName(connection.id, "*"),
    method: "NATIVE",
    path: connection.url,
    score,
    summary: `[${connection.name}] Available to you, but you haven't connected your ${connection.name} account yet.`,
    pathParams: [],
    queryParams: [],
    hasBody: false,
    kind: "connection_status",
    status: "needs_connection",
    hint: `Ask the user to open OpenWork Cloud -> Your Connections and click Connect on "${connection.name}", then search again.`,
    connectionStatus: buildExternalConnectionStatus({
      connection,
      state: "needs_connection",
      errorCode: "not_connected",
      message,
    }),
  }
}

export async function searchNativeCapabilities(input: {
  organizationId: DenTypeId<"organization">
  member: McpMemberIdentity | null
  query: string
  catalog: readonly McpToolOperation[]
  limit: number
  namespaceContext?: CodemodeConnectionNamespaceContext
}): Promise<NativeCapabilityMatch[]> {
  if (!input.member) return []
  const namespaceContext = input.namespaceContext ?? await resolveCodemodeConnectionNamespaceContext({
    organizationId: input.organizationId,
    member: input.member,
  })
  const connections = namespaceContext?.nativeProviderEntries ?? await listNativeProviderUsableEntries({
    organizationId: input.organizationId,
    orgMembershipId: input.member.orgMembershipId,
    teamIds: input.member.teamIds,
  })
  const queryTokens = tokenize(input.query)
  const matches: NativeCapabilityMatch[] = []
  for (const connection of connections) {
    const operations = nativeOperations(input.catalog, connection.nativeProviderKey)
    if (!connection.connectedForMe) {
      const score = Math.max(0, ...operations.map((operation) => operationScore(connection, operation, queryTokens)))
      if (score > 0) matches.push(connectionStatusMatch(connection, score))
      continue
    }
    for (const operation of operations) {
      const score = operationScore(connection, operation, queryTokens)
      if (score > 0) matches.push(capabilityMatch(
        connection,
        operation,
        score,
        namespaceContext?.namespaces.native.get(connection.id),
      ))
    }
  }
  const boundedLimit = Math.max(1, Math.min(20, Math.trunc(input.limit) || 5))
  return matches.sort(compareCapabilityMatches).slice(0, boundedLimit)
}

async function resolveNativeCapability(input: {
  organizationId: DenTypeId<"organization">
  member: McpMemberIdentity | null
  connectionId: string
  toolName: string
  catalog: readonly McpToolOperation[]
}): Promise<{ connection: NativeProviderConnectionEntry; operation: McpToolOperation } | null> {
  if (!input.member) return null
  const connections = await listNativeProviderUsableEntries({
    organizationId: input.organizationId,
    orgMembershipId: input.member.orgMembershipId,
    teamIds: input.member.teamIds,
  })
  const connection = connections.find((candidate) => candidate.id === input.connectionId)
  if (!connection) return null
  const operation = nativeOperations(input.catalog, connection.nativeProviderKey)
    .find((candidate) => candidate.name === input.toolName)
  return operation ? { connection, operation } : null
}

type NativeCapabilityToolResult = {
  isError?: boolean
  content: AgentToolContentPart[]
}

export async function executeNativeCapability(input: {
  app: Hono
  env: unknown
  name: string
  organizationId: DenTypeId<"organization">
  member: McpMemberIdentity | null
  catalog: readonly McpToolOperation[]
  principal: McpPrincipal
  path?: unknown
  query?: unknown
  body?: unknown
}): Promise<NativeCapabilityToolResult | null> {
  const parsed = parseNativeCapabilityName(input.name)
  if (!parsed) return null
  const resolved = await resolveNativeCapability({
    organizationId: input.organizationId,
    member: input.member,
    connectionId: parsed.connectionId,
    toolName: parsed.toolName,
    catalog: input.catalog,
  })
  if (!resolved) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify({
          error: "unknown_capability",
          message: `No capability named "${input.name}". Call search_capabilities to find a valid name.`,
        }),
      }],
    }
  }
  return invokeMcpOperation({
    app: input.app,
    env: input.env,
    operation: resolved.operation,
    principal: input.principal,
    nativeConnectionId: resolved.connection.id,
    toolInput: {
      path: normalizeToolRecord(input.path),
      query: normalizeToolRecord(input.query),
      body: normalizeToolBody(input.body),
    },
  })
}
