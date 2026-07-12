import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"

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
  /**
   * A persistence adapter must reject or roll back a write that cannot commit
   * before this absolute deadline. Checking only before a database call is not
   * sufficient because the operation may settle after its caller timed out.
   */
  commitExpiresAt: EnterpriseMcpEpochMs
  signal: AbortSignal
}

export type EnterpriseMcpOAuthClientRegistration = {
  clientInformation: OAuthClientInformationMixed
  /** Opaque adapter-owned compare-and-swap revision. */
  revision: string
  /** Absolute client/client-secret expiration, when the provider declares one. */
  expiresAt?: EnterpriseMcpEpochMs
  source: "pre-registered" | "dynamic"
}

export interface EnterpriseMcpOAuthClientRegistrationPort {
  load(context: EnterpriseMcpPersistenceContext): Promise<EnterpriseMcpOAuthClientRegistration | undefined>
  /**
   * First-writer-wins for concurrent dynamic registration. Implementations
   * return the winning record and never silently replace a different client.
   */
  save(input: {
    context: EnterpriseMcpPersistenceContext
    clientInformation: OAuthClientInformationMixed
    expiresAt?: EnterpriseMcpEpochMs
    source: "dynamic"
  }): Promise<EnterpriseMcpOAuthClientRegistration>
  invalidate(input: {
    context: EnterpriseMcpPersistenceContext
    reason: "expired" | "provider-rejected"
  }): Promise<void>
}

export type EnterpriseMcpOAuthCredential = {
  tokens: OAuthTokens
  /** Absolute access-token expiration, computed when tokens are committed. */
  expiresAt?: EnterpriseMcpEpochMs
  /** Opaque adapter-owned compare-and-swap revision. */
  revision: string
}

export type EnterpriseMcpOAuthAuthorizationHandle = {
  id: string
  /** Opaque single-use transaction revision. */
  revision: string
  expiresAt: EnterpriseMcpEpochMs
  clientRegistrationRevision?: string
}

export interface EnterpriseMcpOAuthAuthorizationPort {
  /**
   * Persist a bounded PKCE transaction. The id is the caller's signed OAuth
   * state and must be stored as a keyed hash or equivalent non-reversible key.
   */
  begin(input: {
    context: EnterpriseMcpPersistenceContext
    id: string
    codeVerifier: string
    expiresAt: EnterpriseMcpEpochMs
    clientRegistrationRevision?: string
  }): Promise<void>
  /** Load without consuming; successful token commit consumes atomically. */
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
  /**
   * For authorization-code commits, the adapter MUST atomically validate and
   * consume `authorization`, validate `clientRegistrationRevision`, persist
   * the tokens, and enforce `context.commitExpiresAt`. Refresh commits enforce
   * the same lifecycle fence but do not consume an authorization transaction.
   */
  save(input: {
    context: EnterpriseMcpPersistenceContext
    tokens: OAuthTokens
    expiresAt?: EnterpriseMcpEpochMs
    source: "authorization-code" | "refresh"
    authorization?: EnterpriseMcpOAuthAuthorizationHandle
    clientRegistrationRevision?: string
  }): Promise<void>
  invalidate(input: {
    context: EnterpriseMcpPersistenceContext
    reason: "expired" | "provider-rejected" | "post-authorization-validation-failed"
  }): Promise<void>
}

/** Application-owned ports. No database, tenant, or deployment shape leaks in. */
export type EnterpriseMcpOAuthPersistence = {
  clientRegistrations: EnterpriseMcpOAuthClientRegistrationPort
  credentials: EnterpriseMcpOAuthCredentialPort
  authorizations: EnterpriseMcpOAuthAuthorizationPort
}

export type EnterpriseMcpRequestPhase =
  | "endpoint-request"
  | "oauth-resource-discovery"
  | "oauth-server-discovery"
  | "oauth-client-registration"
  | "oauth-token-exchange"
  | "oauth-token-refresh"
  | "mcp-initialize"
  | "mcp-tool-discovery"
  | "mcp-tool-execution"
  | "unknown-request"

export type EnterpriseMcpOperationPhase =
  | "configuration"
  | "connection-handshake"
  | "authorization-callback"
  | "protocol-initialize"
  | "tool-discovery"
  | "tool-execution"
  | "shutdown"

export type EnterpriseMcpDiagnosticEvent = {
  kind: "request" | "operation"
  connectionId: string
  operationPhase: EnterpriseMcpOperationPhase
  requestPhase: EnterpriseMcpRequestPhase | null
  outcome: "started" | "succeeded" | "failed"
  durationMs?: number
  httpStatus?: number
}

export type EnterpriseMcpDiagnosticSink = (event: EnterpriseMcpDiagnosticEvent) => void

export type EnterpriseMcpAuthorization =
  | { type: "none" }
  | { type: "api-key"; token: string }
  | { type: "oauth"; persistence: EnterpriseMcpOAuthPersistence }

export type EnterpriseMcpConnection = {
  id: string
  serverUrl: string
  authorization: EnterpriseMcpAuthorization
}

export type EnterpriseMcpConnectInput = {
  connection: EnterpriseMcpConnection
  redirectUri: string
  /** Required only when OAuth must begin; normally a signed, expiring state. */
  authorizationId?: string
}

export type EnterpriseMcpConnectResult =
  | { status: "connected" }
  | { status: "needs_auth"; authorizeUrl: string }

export type EnterpriseMcpCompleteAuthorizationInput = {
  connection: EnterpriseMcpConnection
  redirectUri: string
  code: string
  /** The exact signed state returned by the provider callback. */
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

export type EnterpriseMcpToolResult = Awaited<ReturnType<Client["callTool"]>>

export type EnterpriseMcpClientOptions = {
  /**
   * Required outbound port. The composition root owns SSRF, DNS rebinding,
   * proxy, TLS, redirect, response-size, and secret-forwarding policy.
   */
  fetch: EnterpriseMcpFetch
  clock?: EnterpriseMcpClock
  diagnosticSink?: EnterpriseMcpDiagnosticSink
  operationTimeoutMs?: number
  closeTimeoutMs?: number
  authorizationTransactionTtlMs?: number
  expirationSkewMs?: number
  clientName?: string
  clientVersion?: string
  lifecycle?: EnterpriseMcpLifecycle
}

export interface EnterpriseMcpClient {
  connect(input: EnterpriseMcpConnectInput): Promise<EnterpriseMcpConnectResult>
  completeAuthorization(input: EnterpriseMcpCompleteAuthorizationInput): Promise<void>
  abandonAuthorization(input: EnterpriseMcpAbandonAuthorizationInput): Promise<void>
  listTools(input: EnterpriseMcpListToolsInput): Promise<Tool[]>
  callTool(input: EnterpriseMcpCallToolInput): Promise<EnterpriseMcpToolResult>
}
