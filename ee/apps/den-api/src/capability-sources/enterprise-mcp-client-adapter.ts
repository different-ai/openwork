import { randomUUID } from "node:crypto"
import {
  createEnterpriseMcpClient,
  EnterpriseMcpCatalogError,
  EnterpriseMcpClientError,
  EnterpriseMcpToolResultError,
  EnterpriseMcpOAuthContractError,
  oauthIssuerMismatchMessage,
  IssuerMismatchError,
  type EnterpriseMcpClient,
  type EnterpriseMcpConnection,
  type EnterpriseMcpDiagnosticEvent,
} from "@openwork/mcp-enterprise-client"
import { env } from "../env.js"
import { organizationFeatureEnabled } from "../features.js"
import { createGuardedFetch, createRealmSafeFetch } from "./url-guard.js"
import { parseStoredExternalMcpRequestHeaders, withExternalMcpRequestHeaders } from "./external-mcp-request-headers.js"
import { memberApiKeyStillCurrent, rejectMemberApiKey, resolveMemberApiKey, type ExternalMcpConnectionRow } from "./external-mcp-connections.js"
import { memberApiKeyAuthorization, usesMemberApiKey } from "./member-api-key.js"
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

type MemberApiKeyCredential = Awaited<ReturnType<typeof resolveMemberApiKey>>

function toEnterpriseConnection(
  connection: ExternalMcpConnectionRow,
  member: ExternalMcpMemberContext | undefined,
  tracker: ExternalMcpDiagnosticTracker,
  memberApiKey: MemberApiKeyCredential | undefined,
  requestSelectedScopesOnly: boolean,
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
        persistence: new DenEnterpriseMcpOAuthPersistence(connection, member, tracker),
        configuration: {
          applicationType: "web",
          manualOAuthEndpoints: connection.oauthConfiguration?.manualOAuthEndpoints,
          clientMetadataUrl: connection.oauthConfiguration?.callbackMode === "shared-v1"
            && new URL(metadataUrl).protocol === "https:"
            ? metadataUrl
            : undefined,
          authorizationServerIssuer: connection.oauthConfiguration?.authorizationServerIssuer ?? undefined,
          requestedScopes: connection.oauthConfiguration?.requestedScopes ?? [],
          requestSelectedScopesOnly,
        },
      },
    }
  }
  if (connection.authType === "apikey") {
    if (connection.credentialMode === "per_member") {
      if (!memberApiKey) throw new Error("A member identity is required for this connection.")
      return { id: connection.id, serverUrl: connection.url, authorization: { type: "api-key", token: memberApiKey.key, scheme: connection.apiKeyAuthScheme } }
    }
    if (!connection.apiKey) throw new Error(`Connection "${connection.id}" does not have an API key.`)
    return {
      id: connection.id,
      serverUrl: connection.url,
      authorization: { type: "api-key", token: connection.apiKey, scheme: connection.apiKeyAuthScheme },
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
    if (event.kind === "request" || event.kind === "credential-invalidation") return
    const phase = diagnosticPhase(event)
    if (event.outcome === "started") {
      tracker.begin(phase)
      return
    }
    if (event.outcome === "failed") {
      return
    }
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
  const mismatch = chain.find((cause) => cause instanceof IssuerMismatchError)
  if (mismatch instanceof IssuerMismatchError && mismatch.kind === "metadata") {
    const classified = tracker.error(new EnterpriseMcpOAuthContractError("MCP_OAUTH_ISSUER_MISMATCH", "Inconsistent sign-in information."), "AUTH_ISSUER_DISCOVERY")
    return new ExternalMcpDiagnosticError({ ...classified.diagnostic, message: oauthIssuerMismatchMessage(mismatch.expected, mismatch.received) }, error)
  }
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
      result: {
        content: toolResult.providerText.map((text) => ({ type: "text", text })),
        ...(toolResult.providerSignal ? { structuredContent: toolResult.providerSignal } : {}),
      },
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

type OperationInput = {
  webhookEvents?: boolean
  connection: ExternalMcpConnectionRow
  member?: ExternalMcpMemberContext
  diagnosticReferenceId?: string
  lifecycleDeadline?: ExternalMcpLifecycleDeadline
  operationTimeoutMs?: number
  toolCallInspector?: ExternalMcpToolCallInspector
}

function createOperationClient(
  input: OperationInput,
  tracker: ExternalMcpDiagnosticTracker,
  memberApiKey: MemberApiKeyCredential | undefined,
): EnterpriseMcpClient {
  const member = input.member
  const networkFetch = withExternalMcpRequestHeaders(
    guardedFetch,
    input.connection.url,
    parseStoredExternalMcpRequestHeaders(input.connection.requestHeaders),
  )
  const fetchForCaller: typeof guardedFetch = memberApiKey && member
    ? async (resource, init) => {
      const credential = memberApiKey
      if (!await memberApiKeyStillCurrent(input.connection, member.orgMembershipId, credential)) {
        throw new Error("Connect your personal API key in Your Connections.")
      }
      const request = new Request(resource, init)
      if (request.url !== new URL(input.connection.url).href || request.headers.get("authorization") !== memberApiKeyAuthorization(credential.key, input.connection.apiKeyAuthScheme)) {
        throw new Error("Connection credentials or destination changed. Reconnect and retry.")
      }
      const response = await networkFetch(resource, { ...init, redirect: "error" })
      if (response.status === 401) await rejectMemberApiKey(input.connection, member.orgMembershipId, credential)
      return response
    }
    : input.connection.oauthConfiguration?.manualOAuthEndpoints
      ? async (resource, init) => {
          const destination = resource instanceof Request ? resource.url : String(resource)
          const tokenEndpoint = input.connection.oauthConfiguration?.manualOAuthEndpoints?.tokenEndpoint
          if (destination !== new URL(input.connection.url).href && destination !== tokenEndpoint) {
            throw new Error("Manual sign-in configuration does not allow discovery or another endpoint.")
          }
          return networkFetch(resource, { ...init, redirect: "manual" })
        }
      : networkFetch
  const diagnosticFetch = createExternalMcpDiagnosticFetch({
    fetch: fetchForCaller,
    endpoint: input.connection.url,
    tracker,
  })
  const observedFetch = input.toolCallInspector
    ? input.toolCallInspector.observeFetch(diagnosticFetch)
    : diagnosticFetch
  return createEnterpriseMcpClient({
    fetch: observedFetch,
    webhookEvents: input.webhookEvents,
    diagnosticSink: diagnosticSink(tracker),
    ...(input.operationTimeoutMs ? { operationTimeoutMs: input.operationTimeoutMs } : {}),
    ...(input.lifecycleDeadline ? {
      lifecycle: {
        expiresAt: input.lifecycleDeadline.expiresAt,
        signal: input.lifecycleDeadline.signal,
      },
    } : {}),
  })
}

async function runEnterpriseMcpOperation<T>(input: OperationInput & {
  operation: (client: EnterpriseMcpClient, connection: EnterpriseMcpConnection) => Promise<T>
}): Promise<T> {
  const tracker = new ExternalMcpDiagnosticTracker(input.diagnosticReferenceId ?? randomUUID(), {
    authType: input.connection.authType,
    credentialMode: input.connection.credentialMode,
  })
  try {
    let memberApiKey: MemberApiKeyCredential | undefined
    if (usesMemberApiKey(input.connection)) {
      if (!input.member) throw new Error("A member identity is required for this connection.")
      memberApiKey = await resolveMemberApiKey(input.connection, input.member.orgMembershipId)
    }
    const requestSelectedScopesOnly = input.connection.oauthConfiguration?.requestSelectedScopesOnly === true
      && await organizationFeatureEnabled(input.connection.organizationId, "connectionSelectedScopesOnly")
    const client = createOperationClient(input, tracker, memberApiKey)
    return await input.operation(client, toEnterpriseConnection(input.connection, input.member, tracker, memberApiKey, requestSelectedScopesOnly))
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
    member,
    diagnosticReferenceId,
    operation: (client, connection) => client.connect({
      connection,
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
    member,
    diagnosticReferenceId,
    operation: (client, connection) => client.completeAuthorization({
      connection,
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
    member,
    diagnosticReferenceId,
    operation: (client, connection) => client.abandonAuthorization({
      connection,
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
    member,
    diagnosticReferenceId,
    lifecycleDeadline,
    operationTimeoutMs,
    operation: (client, connection) => client.listTools({
      connection,
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
    member: input.member,
    diagnosticReferenceId: input.diagnosticReferenceId,
    lifecycleDeadline: input.lifecycleDeadline,
    operationTimeoutMs: EXTERNAL_MCP_TOOL_CALL_TIMEOUT_MS,
    toolCallInspector,
    operation: (client, connection) => client.callTool({
      connection,
      redirectUri: input.redirectUri,
      toolName: input.toolName,
      arguments: input.args,
    }),
  })
}

export function callExternalMcpTool(input: ExternalMcpToolCallInput) {
  return runExternalMcpToolCall(input)
}

export function callListedExternalMcpTool(input: ExternalMcpToolCallInput & {
  beforeCall: (tools: Awaited<ReturnType<typeof listExternalMcpTools>>) => void | Promise<void>
}) {
  return runEnterpriseMcpOperation({
    connection: input.connection,
    member: input.member,
    diagnosticReferenceId: input.diagnosticReferenceId,
    lifecycleDeadline: input.lifecycleDeadline,
    operationTimeoutMs: EXTERNAL_MCP_TOOL_CALL_TIMEOUT_MS,
    operation: (client, connection) => client.callListedTool({
      connection,
      redirectUri: input.redirectUri,
      toolName: input.toolName,
      arguments: input.args,
      beforeCall: input.beforeCall,
    }),
  })
}

export function callExternalMcpToolRaw(input: ExternalMcpToolCallInput) {
  return runEnterpriseMcpOperation({
    connection: input.connection,
    member: input.member,
    diagnosticReferenceId: input.diagnosticReferenceId,
    lifecycleDeadline: input.lifecycleDeadline,
    operationTimeoutMs: EXTERNAL_MCP_TOOL_CALL_TIMEOUT_MS,
    operation: (client, connection) => client.callToolRaw({
      connection,
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
    member: input.member,
    diagnosticReferenceId: input.diagnosticReferenceId,
    lifecycleDeadline: input.lifecycleDeadline,
    operation: (client, connection) => client.describeServer({
      connection,
      redirectUri: input.redirectUri,
    }),
  })
}

export function listExternalMcpResources(input: ExternalMcpResourceInput) {
  return runEnterpriseMcpOperation({
    connection: input.connection,
    member: input.member,
    diagnosticReferenceId: input.diagnosticReferenceId,
    lifecycleDeadline: input.lifecycleDeadline,
    operation: (client, connection) => client.listResources({
      connection,
      redirectUri: input.redirectUri,
    }),
  })
}

export function listExternalMcpResourceTemplates(input: ExternalMcpResourceInput) {
  return runEnterpriseMcpOperation({
    connection: input.connection,
    member: input.member,
    diagnosticReferenceId: input.diagnosticReferenceId,
    lifecycleDeadline: input.lifecycleDeadline,
    operation: (client, connection) => client.listResourceTemplates({
      connection,
      redirectUri: input.redirectUri,
    }),
  })
}

export function readExternalMcpResource(input: ExternalMcpResourceInput & { uri: string }) {
  return runEnterpriseMcpOperation({
    connection: input.connection,
    member: input.member,
    diagnosticReferenceId: input.diagnosticReferenceId,
    lifecycleDeadline: input.lifecycleDeadline,
    operation: (client, connection) => client.readResource({
      connection,
      redirectUri: input.redirectUri,
      uri: input.uri,
    }),
  })
}

export function inspectExternalMcpToolCall(input: ExternalMcpToolCallInput) {
  return withExternalMcpToolCallInspection((inspector) => runExternalMcpToolCall(input, inspector))
}

export function requestExternalMcpEvents(input: ExternalMcpResourceInput & {
  method: "events/list" | "events/subscribe" | "events/unsubscribe" | "events/poll"
  params: Record<string, unknown>
}) {
  return runEnterpriseMcpOperation({
    ...input,
    webhookEvents: true,
    operation: (client, connection) => client.requestEvents({ connection, redirectUri: input.redirectUri, method: input.method, params: input.params }),
  })
}
