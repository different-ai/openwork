import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"

export type EnterpriseMcpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>

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
  connectionId: string
  operationPhase: EnterpriseMcpOperationPhase
  requestPhase: EnterpriseMcpRequestPhase | null
  outcome: "started" | "succeeded" | "failed"
  durationMs?: number
  httpStatus?: number
}

export type EnterpriseMcpDiagnosticSink = (event: EnterpriseMcpDiagnosticEvent) => void

export interface EnterpriseMcpOAuthStore {
  loadClientInformation(): Promise<OAuthClientInformationMixed | undefined>
  saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void>
  loadTokens(): Promise<OAuthTokens | undefined>
  saveTokens(tokens: OAuthTokens): Promise<void>
  saveCodeVerifier(codeVerifier: string): Promise<void>
  loadCodeVerifier(): Promise<string>
}

export type EnterpriseMcpAuthorization =
  | { type: "none" }
  | { type: "api-key"; token: string }
  | { type: "oauth"; store: EnterpriseMcpOAuthStore }

export type EnterpriseMcpConnection = {
  id: string
  serverUrl: string
  authorization: EnterpriseMcpAuthorization
}

export type EnterpriseMcpConnectInput = {
  connection: EnterpriseMcpConnection
  redirectUri: string
  state?: string
}

export type EnterpriseMcpConnectResult =
  | { status: "connected" }
  | { status: "needs_auth"; authorizeUrl: string }

export type EnterpriseMcpCompleteAuthorizationInput = {
  connection: EnterpriseMcpConnection
  redirectUri: string
  code: string
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
  fetch?: EnterpriseMcpFetch
  diagnosticSink?: EnterpriseMcpDiagnosticSink
  operationTimeoutMs?: number
  closeTimeoutMs?: number
  clientName?: string
  clientVersion?: string
}

export interface EnterpriseMcpClient {
  connect(input: EnterpriseMcpConnectInput): Promise<EnterpriseMcpConnectResult>
  completeAuthorization(input: EnterpriseMcpCompleteAuthorizationInput): Promise<void>
  listTools(input: EnterpriseMcpListToolsInput): Promise<Tool[]>
  callTool(input: EnterpriseMcpCallToolInput): Promise<EnterpriseMcpToolResult>
}
