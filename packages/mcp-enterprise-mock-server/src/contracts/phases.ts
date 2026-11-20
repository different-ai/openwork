import { z } from "zod"

export const handshakePhaseSchema = z.enum([
  "CONFIGURATION",
  "NETWORK_DNS",
  "NETWORK_TCP",
  "NETWORK_TLS",
  "HTTP_ROUTING",
  "AUTH_RESOURCE_DISCOVERY",
  "AUTH_ISSUER_DISCOVERY",
  "AUTH_CLIENT_REGISTRATION",
  "AUTH_USER_OR_WORKLOAD",
  "AUTH_TOKEN_ACQUISITION",
  "AUTH_RESOURCE_VALIDATION",
  "MCP_TRANSPORT",
  "MCP_VERSION",
  "MCP_INITIALIZE",
  "MCP_INITIALIZED",
  "MCP_TOOL_DISCOVERY",
  "MCP_TOOL_EXECUTION",
  "PROVIDER_AUTHORIZATION",
  "PROVIDER_EXECUTION",
  "CONTINUITY_REFRESH",
  "CONTINUITY_SESSION",
  "SHUTDOWN",
])

export type HandshakePhase = z.infer<typeof handshakePhaseSchema>

export const operatorActionSchema = z.enum([
  "check_configuration",
  "check_network",
  "check_provider_metadata",
  "register_client",
  "reauthorize",
  "request_provider_access",
  "retry_after",
  "reinitialize",
  "inspect_provider",
  "reconcile_before_retry",
  "contact_provider",
])

export type OperatorAction = z.infer<typeof operatorActionSchema>
