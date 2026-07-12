import type { EnterpriseMcpOperationPhase, EnterpriseMcpRequestPhase } from "./contracts.js"

export type EnterpriseMcpErrorCode =
  | "MCP_CONFIGURATION_FAILED"
  | "MCP_CONNECTION_HANDSHAKE_FAILED"
  | "MCP_AUTHORIZATION_CALLBACK_FAILED"
  | "MCP_PROTOCOL_INITIALIZE_FAILED"
  | "MCP_TOOL_DISCOVERY_FAILED"
  | "MCP_TOOL_EXECUTION_FAILED"
  | "MCP_SHUTDOWN_FAILED"

const errorCodeByPhase: Record<EnterpriseMcpOperationPhase, EnterpriseMcpErrorCode> = {
  configuration: "MCP_CONFIGURATION_FAILED",
  "connection-handshake": "MCP_CONNECTION_HANDSHAKE_FAILED",
  "authorization-callback": "MCP_AUTHORIZATION_CALLBACK_FAILED",
  "protocol-initialize": "MCP_PROTOCOL_INITIALIZE_FAILED",
  "tool-discovery": "MCP_TOOL_DISCOVERY_FAILED",
  "tool-execution": "MCP_TOOL_EXECUTION_FAILED",
  shutdown: "MCP_SHUTDOWN_FAILED",
}

const phaseLabel: Record<EnterpriseMcpOperationPhase, string> = {
  configuration: "connection configuration",
  "connection-handshake": "MCP connection handshake",
  "authorization-callback": "OAuth authorization callback",
  "protocol-initialize": "MCP protocol initialization",
  "tool-discovery": "MCP tool discovery",
  "tool-execution": "MCP tool execution",
  shutdown: "MCP client shutdown",
}

const requestPhaseLabel: Record<EnterpriseMcpRequestPhase, string> = {
  "endpoint-request": "the configured MCP endpoint",
  "oauth-resource-discovery": "OAuth protected-resource discovery",
  "oauth-server-discovery": "OAuth authorization-server discovery",
  "oauth-client-registration": "OAuth client registration",
  "oauth-token-exchange": "OAuth token exchange",
  "oauth-token-refresh": "OAuth token refresh",
  "mcp-initialize": "the MCP initialize request",
  "mcp-tool-discovery": "the MCP tools/list request",
  "mcp-tool-execution": "the MCP tools/call request",
  "unknown-request": "an MCP provider request",
}

export class EnterpriseMcpClientError extends Error {
  readonly code: EnterpriseMcpErrorCode
  readonly operationPhase: EnterpriseMcpOperationPhase
  readonly requestPhase: EnterpriseMcpRequestPhase | null

  constructor(input: {
    operationPhase: EnterpriseMcpOperationPhase
    requestPhase: EnterpriseMcpRequestPhase | null
    cause: unknown
  }) {
    const request = input.requestPhase ? ` while requesting ${requestPhaseLabel[input.requestPhase]}` : ""
    super(`Enterprise MCP failed during ${phaseLabel[input.operationPhase]}${request}.`, { cause: input.cause })
    this.name = "EnterpriseMcpClientError"
    this.code = errorCodeByPhase[input.operationPhase]
    this.operationPhase = input.operationPhase
    this.requestPhase = input.requestPhase
  }
}

export class EnterpriseMcpToolResultError extends Error {
  readonly code = "MCP_TOOL_REPORTED_ERROR"

  constructor() {
    super("The MCP provider completed the request but reported that the tool operation failed.")
    this.name = "EnterpriseMcpToolResultError"
  }
}
