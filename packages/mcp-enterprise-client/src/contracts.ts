import type {
  Client,
  Implementation,
  OAuthDiscoveryState,
  ServerCapabilities,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
  Tool,
} from "@modelcontextprotocol/client"

export type { OAuthDiscoveryState, StoredOAuthClientInformation, StoredOAuthTokens } from "@modelcontextprotocol/client"

/**
 * Most OAuth scopes one connection may request. Without a required scope, MCP
 * clients request every scope the resource advertises, and some servers list
 * well over a hundred (PostHog advertises 155).
 */
export const ENTERPRISE_MCP_REQUESTED_SCOPES_LIMIT = 512

/** Epoch milliseconds. The package never reads a database or environment clock. */
export type EnterpriseMcpEpochMs = number

export type EnterpriseMcpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>

export interface EnterpriseMcpClock {
  now(): EnterpriseMcpEpochMs
}

export type EnterpriseMcpLifecycle = {
  expiresAt: EnterpriseMcpEpochMs
  signal: AbortSignal
}

export type EnterpriseMcpPersistenceContext = {
  connectionId: string
  commitExpiresAt: EnterpriseMcpEpochMs
  signal: AbortSignal
}

export type EnterpriseMcpOAuthClientRegistration = {
  clientInformation: StoredOAuthClientInformation
  revision: string
  expiresAt?: EnterpriseMcpEpochMs
  source: "pre-registered" | "client-metadata" | "dynamic"
}

export interface EnterpriseMcpOAuthClientRegistrationPort {
  load(context: EnterpriseMcpPersistenceContext): Promise<EnterpriseMcpOAuthClientRegistration | undefined>
  save(input: {
    context: EnterpriseMcpPersistenceContext
    clientInformation: StoredOAuthClientInformation
    redirectUri: string
    expiresAt?: EnterpriseMcpEpochMs
    source: "client-metadata" | "dynamic"
  }): Promise<EnterpriseMcpOAuthClientRegistration>
  invalidate(input: {
    context: EnterpriseMcpPersistenceContext
    reason: "expired" | "provider-rejected"
  }): Promise<void>
}

export interface EnterpriseMcpOAuthDiscoveryPort {
  load(context: EnterpriseMcpPersistenceContext): Promise<OAuthDiscoveryState | undefined>
  save(input: {
    context: EnterpriseMcpPersistenceContext
    state: OAuthDiscoveryState
  }): Promise<void>
  invalidate(input: {
    context: EnterpriseMcpPersistenceContext
    reason: "issuer-mismatch" | "provider-rejected"
  }): Promise<void>
}

export type EnterpriseMcpOAuthCredential = {
  tokens: StoredOAuthTokens
  expiresAt?: EnterpriseMcpEpochMs
  revision: string
}

export type EnterpriseMcpOAuthAuthorizationHandle = {
  id: string
  revision: string
  expiresAt: EnterpriseMcpEpochMs
  clientRegistrationRevision?: string
}

export interface EnterpriseMcpOAuthAuthorizationPort {
  begin(input: {
    context: EnterpriseMcpPersistenceContext
    id: string
    codeVerifier: string
    expiresAt: EnterpriseMcpEpochMs
    clientRegistrationRevision?: string
  }): Promise<void>
  load(input: {
    context: EnterpriseMcpPersistenceContext
    id: string
  }): Promise<{ handle: EnterpriseMcpOAuthAuthorizationHandle; codeVerifier: string } | undefined>
  invalidate(input: {
    context: EnterpriseMcpPersistenceContext
    id: string
    reason: "expired" | "abandoned" | "provider-rejected"
  }): Promise<void>
}

export interface EnterpriseMcpOAuthCredentialPort {
  load(context: EnterpriseMcpPersistenceContext): Promise<EnterpriseMcpOAuthCredential | undefined>
  save(input: {
    context: EnterpriseMcpPersistenceContext
    tokens: StoredOAuthTokens
    expiresAt?: EnterpriseMcpEpochMs
    source: "authorization-code" | "refresh"
    authorization?: EnterpriseMcpOAuthAuthorizationHandle
    clientRegistrationRevision?: string
    expectedCredentialRevision?: string
  }): Promise<void>
  invalidate(input: {
    context: EnterpriseMcpPersistenceContext
    reason: "expired" | "provider-rejected" | "post-authorization-validation-failed"
  }): Promise<void>
  refreshExclusively?(input: {
    context: EnterpriseMcpPersistenceContext
    refreshToken: string
    refresh: () => Promise<{ tokens: StoredOAuthTokens; expiresAt?: EnterpriseMcpEpochMs } | undefined>
  }): Promise<EnterpriseMcpOAuthRefreshOutcome>
}

export type EnterpriseMcpOAuthRefreshOutcome =
  | { status: "refreshed" | "not-saved" }
  | { status: "superseded"; credential?: EnterpriseMcpOAuthCredential }

/** Application-owned ports. No database, tenant, or deployment shape leaks in. */
export type EnterpriseMcpOAuthPersistence = {
  clientRegistrations: EnterpriseMcpOAuthClientRegistrationPort
  credentials: EnterpriseMcpOAuthCredentialPort
  authorizations: EnterpriseMcpOAuthAuthorizationPort
  discovery?: EnterpriseMcpOAuthDiscoveryPort
}

export type EnterpriseMcpOAuthConfiguration = {
  applicationType: "web" | "native"
  manualOAuthEndpoints?: { authorizationEndpoint: string; tokenEndpoint: string }
  clientMetadataUrl?: string
  authorizationServerIssuer?: string
  requestedScopes?: string[]
  requestSelectedScopesOnly?: boolean
}

export type EnterpriseMcpRequestPhase =
  | "endpoint-request"
  | "oauth-resource-discovery"
  | "oauth-server-discovery"
  | "oauth-client-registration"
  | "oauth-token-exchange"
  | "oauth-token-refresh"
  | "mcp-discovery"
  | "mcp-initialize"
  | "mcp-tool-discovery"
  | "mcp-tool-execution"
  | "mcp-resource-discovery"
  | "mcp-resource-read"
  | "unknown-request"

export type EnterpriseMcpOperationPhase =
  | "configuration"
  | "requirements-discovery"
  | "connection-handshake"
  | "authorization-callback"
  | "protocol-initialize"
  | "tool-discovery"
  | "tool-execution"
  | "resource-discovery"
  | "resource-read"
  | "shutdown"

export type EnterpriseMcpDiagnosticEvent =
  | {
    kind: "request" | "operation"
    connectionId: string
    operationPhase: EnterpriseMcpOperationPhase
    requestPhase: EnterpriseMcpRequestPhase | null
    outcome: "started" | "succeeded" | "failed"
    durationMs?: number
    httpStatus?: number
    responseBodyExcerpt?: string
    protocolEra?: "modern" | "legacy"
    protocolVersion?: string
  }
  | {
    kind: "credential-invalidation"
    connectionId: string
    operationPhase: EnterpriseMcpOperationPhase
    requestPhase: EnterpriseMcpRequestPhase
    httpStatus?: number
    invalidToken: boolean
  }

export type EnterpriseMcpDiagnosticSink = (event: EnterpriseMcpDiagnosticEvent) => void

export type EnterpriseMcpAuthorization =
  | { type: "none" }
  | { type: "api-key"; token: string; scheme?: "bearer" | "token" }
  | {
    type: "oauth"
    persistence: EnterpriseMcpOAuthPersistence
    configuration?: EnterpriseMcpOAuthConfiguration
  }

export type EnterpriseMcpConnection = {
  id: string
  serverUrl: string
  authorization: EnterpriseMcpAuthorization
}

export type EnterpriseMcpConnectInput = {
  connection: EnterpriseMcpConnection
  redirectUri: string
  authorizationId?: string
}

export type EnterpriseMcpConnectResult =
  | { status: "connected" }
  | { status: "needs_auth"; authorizeUrl: string }

export type EnterpriseMcpCompleteAuthorizationInput = {
  connection: EnterpriseMcpConnection
  redirectUri: string
  code: string
  responseIssuer?: string
  authorizationId: string
}

export type EnterpriseMcpAbandonAuthorizationInput = {
  connection: EnterpriseMcpConnection
  authorizationId: string
  reason: "provider-rejected" | "abandoned"
}

export type EnterpriseMcpListToolsInput = {
  connection: EnterpriseMcpConnection
  redirectUri: string
}

export type EnterpriseMcpCallToolInput = {
  connection: EnterpriseMcpConnection
  redirectUri: string
  toolName: string
  arguments: Record<string, unknown>
}

export type EnterpriseMcpCallListedToolInput = EnterpriseMcpCallToolInput & {
  beforeCall: (tools: EnterpriseMcpTool[]) => void | Promise<void>
}

export type EnterpriseMcpListResourcesInput = {
  connection: EnterpriseMcpConnection
  redirectUri: string
}

export type EnterpriseMcpReadResourceInput = {
  connection: EnterpriseMcpConnection
  redirectUri: string
  uri: string
}

export type EnterpriseMcpListResourceTemplatesInput = {
  connection: EnterpriseMcpConnection
  redirectUri: string
}

export type EnterpriseMcpToolResult = Awaited<ReturnType<Client["callTool"]>>
export type EnterpriseMcpTool = Omit<Tool, "inputSchema" | "outputSchema"> & {
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
}
export type EnterpriseMcpResourceList = Awaited<ReturnType<Client["listResources"]>>["resources"]
export type EnterpriseMcpResourceTemplateList = Awaited<ReturnType<Client["listResourceTemplates"]>>["resourceTemplates"]
export type EnterpriseMcpResourceResult = Awaited<ReturnType<Client["readResource"]>>

export type EnterpriseMcpServerDescriptor = {
  capabilities: ServerCapabilities
  serverInfo?: Implementation
  instructions?: string
}

export type EnterpriseMcpRequirementWarning = {
  code: string
  message: string
}

export type EnterpriseMcpManualRequirement = {
  code: string
  label: string
  reason: string
  required: boolean
}

export type EnterpriseMcpAuthorizationServerRequirement = {
  issuer: string
  authorizationEndpoint?: string
  tokenEndpoint?: string
  registrationEndpoint?: string
  clientIdMetadataDocumentSupported: boolean
  scopesSupported?: string[]
  grantTypesSupported?: string[]
  codeChallengeMethodsSupported?: string[]
  tokenEndpointAuthMethodsSupported?: string[]
}

export type EnterpriseMcpConnectionRequirements = {
  publishedSignInAddresses?: Array<{ authorizationEndpoint: string; tokenEndpoint: string; advertisedIssuer: string; metadataIssuer: string }>
  status: "ready" | "manual_action_required" | "unsupported" | "unreachable"
  server: {
    url: string
    protocolEra?: "modern" | "legacy"
    protocolVersion?: string
    initialize: "succeeded" | "authentication_required" | "failed"
  }
  authentication: {
    kind: "none" | "oauth" | "manual_bearer" | "unknown"
    resource?: string
    protectedResourceMetadataUrl?: string
    authorizationServers: EnterpriseMcpAuthorizationServerRequirement[]
    requiredScopes: string[]
    resourceScopesSupported?: string[]
    recommendedScopes: string[]
    refreshSupport: "supported" | "not_advertised" | "unknown"
    availableRegistrationMethods: Array<"pre_registered" | "client_metadata" | "dynamic">
    recommendedRegistrationMethod: "client_metadata" | "dynamic" | "pre_registered"
  }
  tools: {
    visibility: "available_without_auth" | "requires_auth" | "unavailable"
    count?: number
    items?: Array<{
      name: string
      readOnlyHint?: boolean
      destructiveHint?: boolean
      openWorldHint?: boolean
    }>
  }
  manualRequirements: EnterpriseMcpManualRequirement[]
  warnings: EnterpriseMcpRequirementWarning[]
}

export type EnterpriseMcpDiscoveryCheck = {
  id: "server" | "resource" | "provider"
  status: "running" | "passed" | "failed" | "skipped"
  httpStatus?: number
  code?: "authentication_required" | "not_required" | "issuer_mismatch" | "unavailable" | "unsupported"
}

export type DiscoverEnterpriseMcpConnectionRequirementsInput = {
  onCheck?: (check: EnterpriseMcpDiscoveryCheck) => void
  signal?: AbortSignal
  serverUrl: string
  fetch: EnterpriseMcpFetch
  timeoutMs?: number
  maxAuthorizationServers?: number
  maxTools?: number
}

export type EnterpriseMcpClientOptions = {
  fetch: EnterpriseMcpFetch
  clock?: EnterpriseMcpClock
  diagnosticSink?: EnterpriseMcpDiagnosticSink
  operationTimeoutMs?: number
  closeTimeoutMs?: number
  authorizationTransactionTtlMs?: number
  expirationSkewMs?: number
  clientName?: string
  clientVersion?: string
  webhookEvents?: boolean
  lifecycle?: EnterpriseMcpLifecycle
}

export interface EnterpriseMcpClient {
  requestEvents(input: EnterpriseMcpListResourcesInput & { method: "events/list" | "events/subscribe" | "events/unsubscribe"; params: Record<string, unknown> }): Promise<Record<string, unknown>>
  connect(input: EnterpriseMcpConnectInput): Promise<EnterpriseMcpConnectResult>
  completeAuthorization(input: EnterpriseMcpCompleteAuthorizationInput): Promise<void>
  abandonAuthorization(input: EnterpriseMcpAbandonAuthorizationInput): Promise<void>
  listTools(input: EnterpriseMcpListToolsInput): Promise<EnterpriseMcpTool[]>
  callTool(input: EnterpriseMcpCallToolInput): Promise<EnterpriseMcpToolResult>
  callToolRaw(input: EnterpriseMcpCallToolInput): Promise<EnterpriseMcpToolResult>
  callListedTool(input: EnterpriseMcpCallListedToolInput): Promise<EnterpriseMcpToolResult>
  listResources(input: EnterpriseMcpListResourcesInput): Promise<EnterpriseMcpResourceList>
  readResource(input: EnterpriseMcpReadResourceInput): Promise<EnterpriseMcpResourceResult>
  listResourceTemplates(input: EnterpriseMcpListResourceTemplatesInput): Promise<EnterpriseMcpResourceTemplateList>
  describeServer(input: EnterpriseMcpListResourcesInput): Promise<EnterpriseMcpServerDescriptor>
}
