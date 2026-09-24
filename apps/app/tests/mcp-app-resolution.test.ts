import { expect, test } from "bun:test";
import { mcpAppResolutionRetryDelayMs } from "../src/app/lib/mcp-app-resolution";
import { OpenworkServerError } from "../src/app/lib/openwork-server";

test("bounds retries to transient discovery failures", () => {
  for (const code of ["server_unavailable", "mcp_unreachable", "connect_catalog_discovery_unavailable"]) {
    const cause = new OpenworkServerError(503, code, "starting");
    expect(mcpAppResolutionRetryDelayMs(cause, 0)).toBe(1_000);
    expect(mcpAppResolutionRetryDelayMs(cause, 1)).toBe(3_000);
    expect(mcpAppResolutionRetryDelayMs(cause, 2)).toBeNull();
  }
  for (const code of ["tool_denied", "tool_resource_mismatch"]) {
    expect(mcpAppResolutionRetryDelayMs(new OpenworkServerError(422, code, "denied"), 0)).toBeNull();
  }
  expect(mcpAppResolutionRetryDelayMs(new Error("unknown failure"), 0)).toBeNull();
});

test("never retries authentication or access failures, even with a legacy 502 status", () => {
  for (const code of ["mcp_auth_required", "mcp_access_denied"]) {
    for (const status of [401, 403, 502]) {
      for (const attempt of [0, 1, 2]) {
        expect(mcpAppResolutionRetryDelayMs(new OpenworkServerError(status, code, "blocked"), attempt)).toBeNull();
      }
    }
  }
});
