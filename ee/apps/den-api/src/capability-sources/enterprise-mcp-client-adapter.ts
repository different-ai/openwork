import { randomUUID } from "node:crypto"
import {
  createEnterpriseMcpClient,
  EnterpriseMcpCatalogError,
  EnterpriseMcpClientError,
  EnterpriseMcpToolResultError,
  type EnterpriseMcpClient,
  type EnterpriseMcpConnection,
  type EnterpriseMcpDiagnosticEvent,
} from "@openwork/enterprise-mcp-client"
import { env } from "../env.js"
import { createGuardedFetch, createRealmSafeFetch } from "./url-guard.js"
import type { ExternalMcpConnectionRow } from "./external-mcp-connections.js"
import {
  EXTERNAL_MCP_TOOL_CALL_TIMEOUT_MS,
  type ExternalMcpLifecycleDeadline,
  type ExternalMcpMemberContext,
  type ExternalMcpConnectResult,
} from "./external-mcp-client.js"
import { DenEnterpriseMcpOAuthPersistence } from "./enterprise-mcp-oauth-persistence.js"
import { externalMcpClientMetadataUrl } from "./external-mcp-oauth-contract.js"
import {
  ExternalMcpDiagnosticError,
  ExternalMcpDiagnosticTracker,
  catalogDiagnosticError,
  createExternalMcpDiagnosticFetch,
  providerToolDiagnosticError,
  type ExternalMcpDiagnosticPhase,
} from "./external-mcp-diagnostics.js"
import {
  withExternalMcpToolCallInspection,
  type ExternalMcpToolCallInspector,
} from "./external-mcp-tool-inspection.js"

function toEnterpriseConnection(
  connection: ExternalMcpConnectionRow,
  member?: ExternalMcpMemberContext,
): EnterpriseMcpConnection {
  if (connection.kind !== "external_mcp") {
    throw new Error("Native provider connectors do not expose an MCP server.")
  }
  if (connection.authType === "oauth") {
    const metadataUrl = externalMcpClientMetadataUrl()
    return {
      id: connection.id,
      serverUrl: connection.url,
      authorization: {
        type: "oauth",
        persistence: new DenEnterpriseMcpOAuthPersistence(connection, member),
        configuration: {
          applicationType: "web",
          // CIMD client identifiers must be HTTPS URLs. Local HTTP development
          // still exposes the document for inspection, but falls back to DCR
          // or pre-registration instead of advertising a non-conforming ID.
          // Client metadata has one fixed redirect URI, so scoped callback
          // modes must use DCR or a pre-registered client bound to that URI.
          clientMetadataUrl: connection.oauthConfiguration?.callbackMode === "shared-v1"
            && new URL(metadataUrl).protocol === "https:"
            ? metadataUrl
            : undefined,
          authorizationServerIssuer: connection.oauthConfiguration?.authorizationServerIssuer ?? undefined,
          requestedScopes: connection.oauthConfiguration?.requestedScopes ?? [],
        },
      },
    }
  }
  if (connection.authType === "apikey") {
    if (!connection.apiKey) throw new Error(`Connection "${connection.id}" does not have an API key.`)
    return {
      id: connection.id,
      serverUrl: connection.url,
      authorization: { type: "api-key", token: connection.apiKey },
    }
  }
  return {
    id: connection.id,
    serverUrl: connection.url,
    authorization: { type: "none" },
  }
}

const guardedFetch = env.allowPrivateMcpUrls ? createRealmSafeFetch() : createGuardedFetch()

function diagnosticPhase(event: EnterpriseMcpDiagnosticEvent): ExternalMcpDiagnosticPhase {
  if (event.requestPhase === "oauth-resource-discovery") return "AUTH_RESOURCE_DISCOVERY"
  if (event.requestPhase === "oauth-server-discovery") return "AUTH_ISSUER_DISCOVERY"
  if (event.requestPhase === "oauth-client-registration") return "AUTH_CLIENT_REGISTRATION"
  if (event.requestPhase === "oauth-token-exchange") return "AUTH_TOKEN_ACQUISITION"
  if (event.requestPhase === "oauth-token-refresh") return "CONTINUITY_REFRESH"
  if (event.requestPhase === "mcp-discovery" || event.requestPhase === "mcp-initialize") return "MCP_INITIALIZE"
  if (event.requestPhase === "mcp-tool-discovery") return "MCP_TOOL_DISCOVERY"
  if (event.requestPhase === "mcp-tool-execution") return "MCP_TOOL_EXECUTION"
  if (event.requestPhase === "mcp-resource-discovery" || event.requestPhase === "mcp-resource-read") return "MCP_TOOL_DISCOVERY"
  if (event.operationPhase === "configuration") return "CONFIGURATION"
  if (event.operationPhase === "authorization-callback") return "AUTH_TOKEN_ACQUISITION"
  if (event.operationPhase === "tool-discovery") return "MCP_TOOL_DISCOVERY"
  if (event.operationPhase === "tool-execution") return "MCP_TOOL_EXECUTION"
  if (event.operationPhase === "resource-discovery" || event.operationPhase === "resource-read") return "MCP_TOOL_DISCOVERY"
  if (event.operationPhase === "shutdown") return "SHUTDOWN"
  return "MCP_INITIALIZE"
}

function diagnosticSink(tracker: ExternalMcpDiagnosticTracker) {
  return (event: EnterpriseMcpDiagnosticEvent): void => {
    // Den's diagnostic fetch owns HTTP/request classification, including
    // authorization challenges and network causes. Package request events are
    // still available to package consumers, but must not overwrite that richer
    // Den evidence after a response settles.
    if (event.kind === "request") return
    if (event.kind === "credential-invalidation") {
      console.error("external_mcp_credential_invalidated", {
        referenceId: tracker.referenceId,
        connectionId: event.connectionId,
        operationPhase: event.operationPhase,
        requestPhase: event.requestPhase,
        httpStatus: event.httpStatus,
        invalidToken: event.invalidToken,
      })
      return
    }
    const phase = diagnosticPhase(event)
    if (event.outcome === "started") {
      tracker.begin(phase)
      return
    }
    if (event.outcome === "failed") {
      // Preserve any richer HTTP/OAuth classification already recorded by
      // Den's diagnostic fetch. Package-only failures are translated in the
      // operation catch boundary below.
      return
    }
    // A successful protocol negotiation reports the era it settled on; the
    // final request phase differs by era (server/discover on the modern wire,
    // initialize plus notifications/initialized on the legacy fallback).
    if (event.kind === "operation" && (
      event.protocolEra !== undefined
      || event.requestPhase === "mcp-discovery"
      || event.requestPhase === "mcp-initialize"
    )) {
      tracker.passed("MCP_INITIALIZED", "protocol_ready")
      return
    }
    if (event.requestPhase !== null) return
    if (event.operationPhase === "tool-discovery") tracker.passed("MCP_TOOL_DISCOVERY", "catalog_ready")
    else if (event.operationPhase === "tool-execution") tracker.passed("PROVIDER_EXECUTION", "operation_ready")
    else tracker.passed("MCP_INITIALIZED", "protocol_ready")
  }
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  let current: unknown = error
  for (let depth = 0; depth < 6; depth += 1) {
    chain.push(current)
    if (typeof current !== "object" || current === null || !("cause" in current) || current.cause === undefined) break
    current = current.cause
  }
  return chain
}

function translateEnterpriseMcpError(
  error: unknown,
  tracker: ExternalMcpDiagnosticTracker,
): ExternalMcpDiagnosticError {
  const chain = errorChain(error)
  const existing = chain.find((cause) => cause instanceof ExternalMcpDiagnosticError)
  if (existing instanceof ExternalMcpDiagnosticError) return existing
  const catalog = chain.find((cause) => cause instanceof EnterpriseMcpCatalogError)
  if (catalog instanceof EnterpriseMcpCatalogError) {
    return catalogDiagnosticError({
      tracker,
      code: catalog.code,
      operatorAction: "Reduce or repair the provider MCP catalog or resource to satisfy the named enterprise client limit.",
    })
  }
  const toolResult = chain.find((cause) => cause instanceof EnterpriseMcpToolResultError)
  if (toolResult instanceof EnterpriseMcpToolResultError) {
    return providerToolDiagnosticError({
      tracker,
      result: toolResult.providerSignal ? { structuredContent: toolResult.providerSignal } : undefined,
    })
  }
  const enterpriseError = chain.find((cause) => cause instanceof EnterpriseMcpClientError)
  const phase = enterpriseError instanceof EnterpriseMcpClientError
      ? diagnosticPhase({
        kind: "operation",
        connectionId: "",
        operationPhase: enterpriseError.operationPhase,
        requestPhase: enterpriseError.requestPhase,
        outcome: "failed",
      })
    : tracker.activePhase
  const source = [...chain].reverse().find((cause) => (
    !(cause instanceof EnterpriseMcpClientError)
    && !(cause instanceof EnterpriseMcpCatalogError)
    && !(cause instanceof EnterpriseMcpToolResultError)
  )) ?? error
  return tracker.error(source, phase)
}

function createOperationClient(input: {
  connection: ExternalMcpConnectionRow
  diagnosticReferenceId?: string
  lifecycleDeadline?: ExternalMcpLifecycleDeadline
  operationTimeoutMs?: number
  toolCallInspector?: ExternalMcpToolCallInspector
}): { client: EnterpriseMcpClient; tracker: ExternalMcpDiagnosticTracker } {
  const tracker = new ExternalMcpDiagnosticTracker(input.diagnosticReferenceId ?? randomUUID(), {
    authType: input.connection.authType,
    credentialMode: input.connection.credentialMode,
  })
  const diagnosticFetch = createExternalMcpDiagnosticFetch({
    fetch: guardedFetch,
    endpoint: input.connection.url,
    tracker,
  })
  const observedFetch = input.toolCallInspector
    ? input.toolCallInspector.observeFetch(diagnosticFetch)
    : diagnosticFetch
  return {
    tracker,
    client: createEnterpriseMcpClient({
      fetch: observedFetch,
      diagnosticSink: diagnosticSink(tracker),
      ...(input.operationTimeoutMs ? { operationTimeoutMs: input.operationTimeoutMs } : {}),
      ...(input.lifecycleDeadline ? {
        lifecycle: {
          expiresAt: input.lifecycleDeadline.expiresAt,
          signal: input.lifecycleDeadline.signal,
        },
      } : {}),
    }),
  }
}

async function runEnterpriseMcpOperation<T>(input: {
  connection: ExternalMcpConnectionRow
  diagnosticReferenceId?: string
  lifecycleDeadline?: ExternalMcpLifecycleDeadline
  operationTimeoutMs?: number
  toolCallInspector?: ExternalMcpToolCallInspector
  operation: (client: EnterpriseMcpClient) => Promise<T>
}): Promise<T> {
  const { client, tracker } = createOperationClient(input)
  try {
    return await input.operation(client)
  } catch (error) {
    throw translateEnterpriseMcpError(error, tracker)
  }
}

export async function connectExternalMcp(
  connection: ExternalMcpConnectionRow,
  redirectUri: string,
  signedState?: string,
  member?: ExternalMcpMemberContext,
  diagnosticReferenceId?: string,
): Promise<ExternalMcpConnectResult> {
  return runEnterpriseMcpOperation({
    connection,
    diagnosticReferenceId,
    operation: (client) => client.connect({
      connection: toEnterpriseConnection(connection, member),
      redirectUri,
      authorizationId: signedState,
    }),
  })
}

export async function completeExternalMcpAuth(
  connection: ExternalMcpConnectionRow,
  code: string,
  redirectUri: string,
  member?: ExternalMcpMemberContext,
  diagnosticReferenceId?: string,
  signedState?: string,
  responseIssuer?: string,
): Promise<void> {
  if (!signedState) throw new Error("The enterprise MCP OAuth callback requires its signed state transaction.")
  await runEnterpriseMcpOperation({
    connection,
    diagnosticReferenceId,
    operation: (client) => client.completeAuthorization({
      connection: toEnterpriseConnection(connection, member),
      redirectUri,
      code,
      authorizationId: signedState,
      responseIssuer,
    }),
  })
}

export async function abandonExternalMcpAuth(
  connection: ExternalMcpConnectionRow,
  signedState: string,
  member?: ExternalMcpMemberContext,
  diagnosticReferenceId?: string,
): Promise<void> {
  await runEnterpriseMcpOperation({
    connection,
    diagnosticReferenceId,
    operation: (client) => client.abandonAuthorization({
      connection: toEnterpriseConnection(connection, member),
      authorizationId: signedState,
      reason: "provider-rejected",
    }),
  })
}

export async function listExternalMcpTools(
  connection: ExternalMcpConnectionRow,
  redirectUri: string,
  member?: ExternalMcpMemberContext,
  diagnosticReferenceId?: string,
  lifecycleDeadline?: ExternalMcpLifecycleDeadline,
  operationTimeoutMs?: number,
) {
  return runEnterpriseMcpOperation({
    connection,
    diagnosticReferenceId,
    lifecycleDeadline,
    operationTimeoutMs,
    operation: (client) => client.listTools({
      connection: toEnterpriseConnection(connection, member),
      redirectUri,
    }),
  })
}

type ExternalMcpToolCallInput = {
  connection: ExternalMcpConnectionRow
  redirectUri: string
  toolName: string
  args: Record<string, unknown>
  member?: ExternalMcpMemberContext
  diagnosticReferenceId?: string
  lifecycleDeadline?: ExternalMcpLifecycleDeadline
}

function runExternalMcpToolCall(
  input: ExternalMcpToolCallInput,
  toolCallInspector?: ExternalMcpToolCallInspector,
) {
  return runEnterpriseMcpOperation({
    connection: input.connection,
    diagnosticReferenceId: input.diagnosticReferenceId,
    lifecycleDeadline: input.lifecycleDeadline,
    operationTimeoutMs: EXTERNAL_MCP_TOOL_CALL_TIMEOUT_MS,
    toolCallInspector,
    operation: (client) => client.callTool({
      connection: toEnterpriseConnection(input.connection, input.member),
      redirectUri: input.redirectUri,
      toolName: input.toolName,
      arguments: input.args,
    }),
  })
}

export function callExternalMcpTool(input: ExternalMcpToolCallInput) {
  return runExternalMcpToolCall(input)
}

export function callExternalMcpToolRaw(input: ExternalMcpToolCallInput) {
  return runEnterpriseMcpOperation({
    connection: input.connection,
    diagnosticReferenceId: input.diagnosticReferenceId,
    lifecycleDeadline: input.lifecycleDeadline,
    operationTimeoutMs: EXTERNAL_MCP_TOOL_CALL_TIMEOUT_MS,
    operation: (client) => client.callToolRaw({
      connection: toEnterpriseConnection(input.connection, input.member),
      redirectUri: input.redirectUri,
      toolName: input.toolName,
      arguments: input.args,
    }),
  })
}

type ExternalMcpResourceInput = {
  connection: ExternalMcpConnectionRow
  redirectUri: string
  member?: ExternalMcpMemberContext
  diagnosticReferenceId?: string
  lifecycleDeadline?: ExternalMcpLifecycleDeadline
}

export function describeExternalMcpServer(input: ExternalMcpResourceInput) {
  return runEnterpriseMcpOperation({
    connection: input.connection,
    diagnosticReferenceId: input.diagnosticReferenceId,
    lifecycleDeadline: input.lifecycleDeadline,
    operation: (client) => client.describeServer({
      connection: toEnterpriseConnection(input.connection, input.member),
      redirectUri: input.redirectUri,
    }),
  })
}

export function listExternalMcpResources(input: ExternalMcpResourceInput) {
  return runEnterpriseMcpOperation({
    connection: input.connection,
    diagnosticReferenceId: input.diagnosticReferenceId,
    lifecycleDeadline: input.lifecycleDeadline,
    operation: (client) => client.listResources({
      connection: toEnterpriseConnection(input.connection, input.member),
      redirectUri: input.redirectUri,
    }),
  })
}

export function listExternalMcpResourceTemplates(input: ExternalMcpResourceInput) {
  return runEnterpriseMcpOperation({
    connection: input.connection,
    diagnosticReferenceId: input.diagnosticReferenceId,
    lifecycleDeadline: input.lifecycleDeadline,
    operation: (client) => client.listResourceTemplates({
      connection: toEnterpriseConnection(input.connection, input.member),
      redirectUri: input.redirectUri,
    }),
  })
}

export function readExternalMcpResource(input: ExternalMcpResourceInput & { uri: string }) {
  return runEnterpriseMcpOperation({
    connection: input.connection,
    diagnosticReferenceId: input.diagnosticReferenceId,
    lifecycleDeadline: input.lifecycleDeadline,
    operation: (client) => client.readResource({
      connection: toEnterpriseConnection(input.connection, input.member),
      redirectUri: input.redirectUri,
      uri: input.uri,
    }),
  })
}

export function inspectExternalMcpToolCall(input: ExternalMcpToolCallInput) {
  return withExternalMcpToolCallInspection((inspector) => runExternalMcpToolCall(input, inspector))
}
