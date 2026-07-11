import { describe, expect, test } from "bun:test";

import {
  McpConnectionTestRequestError,
  parseMcpConnectionTestFailure,
  parseMcpConnectionTestResult,
  summarizeMcpConnectionTest,
  visibleMcpToolNames,
} from "../app/(den)/dashboard/_components/mcp-connection-test-state";

const readyResult = {
  status: "ready",
  testId: "mcp-test-0001",
  protocolVersion: "2025-06-18",
  transport: "streamable_http",
  sessionUsed: true,
  serverName: "openwork-enterprise-mock-servicenow",
  serverVersion: "1.0.0",
  toolPageCount: 2,
  toolCount: 3,
  toolNames: ["lookup_incident_records", "incident_summarization", "create_incident"],
  catalogHash: "sha256:0123456789abcdef",
  elapsedMs: 24,
};

describe("MCP connection test presentation", () => {
  test("parses a complete redacted result and summarizes readiness", () => {
    const parsed = parseMcpConnectionTestResult(readyResult);
    expect(summarizeMcpConnectionTest(parsed)).toBe("Protocol ready · 2025-06-18 · 3 tools across 2 pages");
    expect(visibleMcpToolNames(parsed)).toBe("lookup_incident_records, incident_summarization, create_incident");
  });

  test("rejects inconsistent counts instead of rendering partial evidence", () => {
    expect(() => parseMcpConnectionTestResult({ ...readyResult, toolCount: 4 })).toThrow("inconsistent counts");
  });

  test("bounds long catalogs in the connection row", () => {
    const parsed = parseMcpConnectionTestResult({
      ...readyResult,
      toolCount: 7,
      toolNames: ["one", "two", "three", "four", "five", "six", "seven"],
    });
    expect(visibleMcpToolNames(parsed)).toBe("one, two, three, four, five, +2 more");
  });

  test("allowlists failure copy and preserves only the diagnostic ID", () => {
    const failure = parseMcpConnectionTestFailure({
      error: "connection_test_failed",
      code: "mcp_catalog_cursor_cycle",
      testId: "mcp-test-safe-id",
      message: "raw cursor=fault-cursor-secret token=mock-access-token session=fault-session-secret",
    });
    expect(failure).toEqual({
      error: "connection_test_failed",
      code: "mcp_catalog_cursor_cycle",
      testId: "mcp-test-safe-id",
      message: "The MCP server repeated a tool-catalog pagination cursor.",
    });
    if (!failure) throw new Error("failure parser rejected an allowlisted code");
    const error = new McpConnectionTestRequestError(failure);
    expect(error.message).not.toContain("fault-cursor-secret");
    expect(error.message).not.toContain("mock-access-token");
    expect(error.message).not.toContain("fault-session-secret");
    expect(error.testId).toBe("mcp-test-safe-id");
  });
});
