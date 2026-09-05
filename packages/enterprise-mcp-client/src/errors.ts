import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client"
import type { EnterpriseMcpOperationPhase, EnterpriseMcpRequestPhase } from "./contracts.js"

export type EnterpriseMcpErrorCode =
  | "MCP_CONFIGURATION_FAILED"
  | "MCP_REQUIREMENTS_DISCOVERY_FAILED"
  | "MCP_CONNECTION_HANDSHAKE_FAILED"
  | "MCP_AUTHORIZATION_CALLBACK_FAILED"
  | "MCP_PROTOCOL_INITIALIZE_FAILED"
  | "MCP_TOOL_DISCOVERY_FAILED"
  | "MCP_TOOL_EXECUTION_FAILED"
  | "MCP_RESOURCE_DISCOVERY_FAILED"
  | "MCP_RESOURCE_READ_FAILED"
  | "MCP_SHUTDOWN_FAILED"

const errorCodeByPhase: Record<EnterpriseMcpOperationPhase, EnterpriseMcpErrorCode> = {
  configuration: "MCP_CONFIGURATION_FAILED",
  "requirements-discovery": "MCP_REQUIREMENTS_DISCOVERY_FAILED",
  "connection-handshake": "MCP_CONNECTION_HANDSHAKE_FAILED",
  "authorization-callback": "MCP_AUTHORIZATION_CALLBACK_FAILED",
  "protocol-initialize": "MCP_PROTOCOL_INITIALIZE_FAILED",
  "tool-discovery": "MCP_TOOL_DISCOVERY_FAILED",
  "tool-execution": "MCP_TOOL_EXECUTION_FAILED",
  "resource-discovery": "MCP_RESOURCE_DISCOVERY_FAILED",
  "resource-read": "MCP_RESOURCE_READ_FAILED",
  shutdown: "MCP_SHUTDOWN_FAILED",
}

const phaseLabel: Record<EnterpriseMcpOperationPhase, string> = {
  configuration: "connection configuration",
  "requirements-discovery": "MCP connection requirements discovery",
  "connection-handshake": "MCP connection handshake",
  "authorization-callback": "OAuth authorization callback",
  "protocol-initialize": "MCP protocol negotiation",
  "tool-discovery": "MCP tool discovery",
  "tool-execution": "MCP tool execution",
  "resource-discovery": "MCP resource discovery",
  "resource-read": "MCP resource read",
  shutdown: "MCP client shutdown",
}

const requestPhaseLabel: Record<EnterpriseMcpRequestPhase, string> = {
  "endpoint-request": "the configured MCP endpoint",
  "oauth-resource-discovery": "OAuth protected-resource discovery",
  "oauth-server-discovery": "OAuth authorization-server discovery",
  "oauth-client-registration": "OAuth client registration",
  "oauth-token-exchange": "OAuth token exchange",
  "oauth-token-refresh": "OAuth token refresh",
  "mcp-discovery": "the MCP server/discover request",
  "mcp-initialize": "the MCP initialize request",
  "mcp-tool-discovery": "the MCP tools/list request",
  "mcp-tool-execution": "the MCP tools/call request",
  "mcp-resource-discovery": "the MCP resource catalog request",
  "mcp-resource-read": "the MCP resources/read request",
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

/**
 * Marks a lifecycle abort as ours on the `data` of an MCP error. The SDK
 * rethrows an `SdkError` untouched but collapses any other abort reason into
 * `String(reason)` on a RequestTimeout, leaving downstream diagnostics unable
 * to tell an OpenWork deadline apart from a provider-declared failure.
 */
export const ENTERPRISE_MCP_LIFECYCLE_DEADLINE_DATA_KEY = "enterpriseMcpLifecycleDeadline"

export class EnterpriseMcpLifecycleDeadlineError extends SdkError {
  readonly operationPhase: EnterpriseMcpOperationPhase

  constructor(operationPhase: EnterpriseMcpOperationPhase) {
    super(SdkErrorCode.RequestTimeout, `Enterprise MCP ${operationPhase} exceeded its lifecycle deadline.`, {
      [ENTERPRISE_MCP_LIFECYCLE_DEADLINE_DATA_KEY]: true,
      operationPhase,
    })
    this.name = "EnterpriseMcpLifecycleDeadlineError"
    this.operationPhase = operationPhase
  }
}

/** Walks an error chain for the deadline marker set by this client. */
export function isEnterpriseMcpLifecycleDeadline(value: unknown): boolean {
  let current: unknown = value
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof EnterpriseMcpLifecycleDeadlineError) return true
    if (typeof current === "object" && current !== null && "data" in current) {
      const data: unknown = current.data
      if (
        typeof data === "object" && data !== null
        && ENTERPRISE_MCP_LIFECYCLE_DEADLINE_DATA_KEY in data
        && data[ENTERPRISE_MCP_LIFECYCLE_DEADLINE_DATA_KEY] === true
      ) {
        return true
      }
    }
    current = typeof current === "object" && current !== null && "cause" in current ? current.cause : undefined
  }
  return false
}

export type EnterpriseMcpOAuthContractErrorCode =
  | "MCP_OAUTH_AUTHORIZATION_ID_REQUIRED"
  | "MCP_OAUTH_AUTHORIZATION_MISSING"
  | "MCP_OAUTH_AUTHORIZATION_EXPIRED"
  | "MCP_OAUTH_AUTHORIZATION_CLIENT_CHANGED"
  | "MCP_OAUTH_CLIENT_EXPIRED"
  | "MCP_OAUTH_CREDENTIAL_EXPIRED"
  | "MCP_OAUTH_CREDENTIAL_CHANGED"
  | "MCP_OAUTH_CONFIGURATION_CHANGED"
  | "MCP_OAUTH_CONFIGURATION_REQUIRED"
  | "MCP_OAUTH_ISSUER_MISMATCH"
  | "MCP_OAUTH_PERSISTENCE_INVALID"
  | "MCP_LIFECYCLE_DEADLINE"

/** Safe, stable failures for application-owned OAuth persistence invariants. */
export class EnterpriseMcpOAuthContractError extends Error {
  readonly code: EnterpriseMcpOAuthContractErrorCode

  constructor(code: EnterpriseMcpOAuthContractErrorCode, message: string) {
    super(message)
    this.name = "EnterpriseMcpOAuthContractError"
    this.code = code
  }
}

export class EnterpriseMcpToolResultError extends Error {
  readonly code = "MCP_TOOL_REPORTED_ERROR"
  readonly providerSignal: Record<string, unknown> | undefined

  constructor(result?: unknown) {
    super("The MCP provider completed the request but reported that the tool operation failed.")
    this.name = "EnterpriseMcpToolResultError"
    const structuredContent = typeof result === "object" && result !== null && "structuredContent" in result
      && typeof result.structuredContent === "object" && result.structuredContent !== null
      ? result.structuredContent
      : null
    const content = typeof result === "object" && result !== null && "content" in result && Array.isArray(result.content)
      ? result.content
      : []
    const hasStandardInputValidationError = content.some((item) => {
      if (typeof item !== "object" || item === null || !("type" in item) || item.type !== "text" || !("text" in item) || typeof item.text !== "string") {
        return false
      }
      return /^Input validation error:\s*Invalid arguments for tool\b/i.test(item.text)
        || /^Invalid (?:tool )?(?:arguments|params)\b/i.test(item.text)
    })
    const providerStatus = structuredContent && "providerStatus" in structuredContent && typeof structuredContent.providerStatus === "number"
      ? structuredContent.providerStatus
      : undefined
    const category = structuredContent && "category" in structuredContent && typeof structuredContent.category === "string"
      ? structuredContent.category
      : hasStandardInputValidationError
        ? "invalid_arguments"
        : undefined
    const requestId = structuredContent && "requestId" in structuredContent && typeof structuredContent.requestId === "string"
      ? structuredContent.requestId
      : undefined
    if (providerStatus === undefined && category === undefined && requestId === undefined) return
    this.providerSignal = {
      ...(providerStatus !== undefined ? { providerStatus } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
    }
  }
}

export type EnterpriseMcpToolInputErrorCode =
  | "MCP_TOOL_ARGUMENT_SIZE_LIMIT"
  | "MCP_TOOL_ARGUMENT_DEPTH_LIMIT"
  | "MCP_TOOL_ARGUMENT_CYCLE"
  | "MCP_TOOL_ARGUMENT_INVALID_JSON"

export class EnterpriseMcpToolInputError extends Error {
  readonly code: EnterpriseMcpToolInputErrorCode

  constructor(code: EnterpriseMcpToolInputErrorCode) {
    super("The MCP tool arguments do not satisfy the bounded JSON input contract.")
    this.name = "EnterpriseMcpToolInputError"
    this.code = code
  }
}

export type EnterpriseMcpCatalogErrorCode =
  | "MCP_CATALOG_CURSOR_LOOP"
  | "MCP_CATALOG_PAGE_LIMIT"
  | "MCP_CATALOG_ITEM_LIMIT"
  | "MCP_CATALOG_DUPLICATE_TOOL"
  | "MCP_CATALOG_DUPLICATE_RESOURCE"
  | "MCP_CATALOG_TOOL_NAME_LIMIT"
  | "MCP_CATALOG_TOOL_DESCRIPTION_LIMIT"
  | "MCP_CATALOG_TOOL_TITLE_LIMIT"
  | "MCP_CATALOG_SCHEMA_SIZE_LIMIT"
  | "MCP_CATALOG_SCHEMA_DEPTH_LIMIT"
  | "MCP_CATALOG_SCHEMA_CYCLE"
  | "MCP_CATALOG_CURSOR_SIZE_LIMIT"
  | "MCP_CATALOG_BYTE_LIMIT"
  | "MCP_RESOURCE_URI_LIMIT"
  | "MCP_RESOURCE_DESCRIPTOR_LIMIT"
  | "MCP_RESOURCE_RESULT_LIMIT"

export class EnterpriseMcpCatalogError extends Error {
  readonly code: EnterpriseMcpCatalogErrorCode

  constructor(code: EnterpriseMcpCatalogErrorCode) {
    super("The MCP catalog or resource exceeded an enterprise client contract limit.")
    this.name = "EnterpriseMcpCatalogError"
    this.code = code
  }
}
