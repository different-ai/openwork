export type McpConnectionTestResult = {
  status: "ready" | "warning";
  warnings: McpConnectionTestWarningCode[];
  testId: string;
  protocolVersion: string;
  transport: "streamable_http";
  sessionUsed: boolean;
  serverName: string | null;
  serverVersion: string | null;
  toolPageCount: number;
  toolCount: number;
  toolNames: string[];
  catalogHash: string;
  elapsedMs: number;
};

export const MCP_CONNECTION_TEST_WARNING_MESSAGES = {
  empty_tool_catalog: "The MCP server is reachable, but it returned no tools. Check provider assignments, permissions, and catalog configuration.",
} as const;

export type McpConnectionTestWarningCode = keyof typeof MCP_CONNECTION_TEST_WARNING_MESSAGES;

export const MCP_CONNECTION_TEST_FAILURE_MESSAGES = {
  mcp_test_timeout: "The MCP connection test timed out.",
  mcp_initialize_failed: "The MCP server did not complete protocol initialization.",
  mcp_reauth_required: "The existing MCP credential was rejected. Reconnect this account, then test again.",
  mcp_provider_permission_denied: "The MCP provider denied access to this connection. Ask a provider administrator to review account assignments, roles, ACLs, and required scopes, then test again.",
  mcp_catalog_unavailable: "The MCP server did not return a valid tool catalog.",
  mcp_catalog_cursor_cycle: "The MCP server repeated a tool-catalog pagination cursor.",
  mcp_catalog_duplicate_tool: "The MCP server returned duplicate tool names.",
  mcp_catalog_limit_exceeded: "The MCP tool catalog exceeded the diagnostic safety limit.",
  mcp_response_limit_exceeded: "An MCP response exceeded the diagnostic byte limit.",
  mcp_catalog_page_limit_exceeded: "An MCP tool-catalog page contained too many tools.",
  mcp_catalog_item_limit_exceeded: "An MCP tool-catalog item exceeded the diagnostic size or nesting limits.",
  mcp_catalog_cursor_limit_exceeded: "The MCP server returned an oversized pagination cursor.",
  mcp_catalog_tool_name_invalid: "The MCP server returned an invalid or oversized tool name.",
} as const;

export type McpConnectionTestFailureCode = keyof typeof MCP_CONNECTION_TEST_FAILURE_MESSAGES;

export type McpConnectionTestFailure = {
  error: "connection_test_failed";
  code: McpConnectionTestFailureCode;
  testId: string;
  message: string;
};

export class McpConnectionTestRequestError extends Error {
  readonly name = "McpConnectionTestRequestError";
  readonly code: McpConnectionTestFailureCode;
  readonly testId: string;

  constructor(failure: McpConnectionTestFailure) {
    super(failure.message);
    this.code = failure.code;
    this.testId = failure.testId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isFailureCode(value: unknown): value is McpConnectionTestFailureCode {
  return typeof value === "string"
    && Object.prototype.hasOwnProperty.call(MCP_CONNECTION_TEST_FAILURE_MESSAGES, value);
}

function isWarningCode(value: unknown): value is McpConnectionTestWarningCode {
  return typeof value === "string"
    && Object.prototype.hasOwnProperty.call(MCP_CONNECTION_TEST_WARNING_MESSAGES, value);
}

export function parseMcpConnectionTestFailure(value: unknown): McpConnectionTestFailure | null {
  if (!isRecord(value)
    || value.error !== "connection_test_failed"
    || !isFailureCode(value.code)
    || typeof value.testId !== "string"
    || value.testId.length === 0
  ) {
    return null;
  }
  return {
    error: "connection_test_failed",
    code: value.code,
    testId: value.testId,
    // Render only the local allowlisted copy. Never trust an opaque SDK or
    // upstream-provider message returned by a failed diagnostic request.
    message: MCP_CONNECTION_TEST_FAILURE_MESSAGES[value.code],
  };
}

export function parseMcpConnectionTestResult(value: unknown): McpConnectionTestResult {
  if (!isRecord(value)) throw new Error("Connection test response was incomplete.");
  const {
    status,
    warnings,
    testId,
    protocolVersion,
    transport,
    sessionUsed,
    serverName,
    serverVersion,
    toolPageCount,
    toolCount,
    toolNames,
    catalogHash,
    elapsedMs,
  } = value;
  if (
    (status !== "ready" && status !== "warning")
    || !Array.isArray(warnings)
    || !warnings.every(isWarningCode)
    || typeof testId !== "string"
    || typeof protocolVersion !== "string"
    || transport !== "streamable_http"
    || typeof sessionUsed !== "boolean"
    || (typeof serverName !== "string" && serverName !== null)
    || (typeof serverVersion !== "string" && serverVersion !== null)
    || typeof toolPageCount !== "number"
    || !Number.isInteger(toolPageCount)
    || typeof toolCount !== "number"
    || !Number.isInteger(toolCount)
    || !isStringArray(toolNames)
    || typeof catalogHash !== "string"
    || typeof elapsedMs !== "number"
    || !Number.isInteger(elapsedMs)
  ) {
    throw new Error("Connection test response was incomplete.");
  }
  const warningConsistency = status === "warning"
    && toolCount === 0
    && warnings.length === 1
    && warnings[0] === "empty_tool_catalog";
  if (toolPageCount < 0
    || toolCount < 0
    || elapsedMs < 0
    || toolCount !== toolNames.length
    || (status === "ready" && warnings.length > 0)
    || (status === "warning" && !warningConsistency)
  ) {
    throw new Error("Connection test response had inconsistent counts.");
  }
  return {
    status,
    warnings,
    testId,
    protocolVersion,
    transport,
    sessionUsed,
    serverName,
    serverVersion,
    toolPageCount,
    toolCount,
    toolNames,
    catalogHash,
    elapsedMs,
  };
}

export function summarizeMcpConnectionTest(result: McpConnectionTestResult): string {
  const pages = `${result.toolPageCount} ${result.toolPageCount === 1 ? "page" : "pages"}`;
  const tools = `${result.toolCount} ${result.toolCount === 1 ? "tool" : "tools"}`;
  if (result.status === "warning") {
    return `Protocol reached · ${result.protocolVersion} · no tools discovered across ${pages}`;
  }
  return `Protocol ready · ${result.protocolVersion} · ${tools} across ${pages}`;
}

export function visibleMcpToolNames(result: McpConnectionTestResult, limit = 5): string {
  if (result.toolNames.length === 0) return MCP_CONNECTION_TEST_WARNING_MESSAGES.empty_tool_catalog;
  const visible = result.toolNames.slice(0, limit);
  const hidden = result.toolNames.length - visible.length;
  return `${visible.join(", ")}${hidden > 0 ? `, +${hidden} more` : ""}`;
}
