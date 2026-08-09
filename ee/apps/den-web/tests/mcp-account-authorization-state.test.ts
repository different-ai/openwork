import { describe, expect, test } from "bun:test";
import {
  MCP_AUTHORIZATION_TIMEOUT_MESSAGE,
  MCP_AUTHORIZATION_UNCONFIRMED_CONNECTED_MESSAGE,
  MCP_AUTHORIZATION_WINDOW_CLOSED_MESSAGE,
  resolveMcpAuthorizationPollOutcome,
} from "../app/(den)/dashboard/_components/mcp-account-authorization-state";

describe("resolveMcpAuthorizationPollOutcome", () => {
  test("treats a confirmed connection as success even when the provider window has closed", () => {
    expect(resolveMcpAuthorizationPollOutcome({
      connected: true,
      authorizationWindowClosed: true,
      elapsedMs: 2_000,
      timeoutMs: 90_000,
    })).toBe("connected");
  });

  test("reports an unconfirmed provider window closing instead of failing silently", () => {
    expect(resolveMcpAuthorizationPollOutcome({
      connected: false,
      authorizationWindowClosed: true,
      elapsedMs: 2_000,
      timeoutMs: 90_000,
    })).toBe("window_closed");
    expect(MCP_AUTHORIZATION_WINDOW_CLOSED_MESSAGE).toContain("closed");
  });

  test("reports timeout and otherwise keeps polling", () => {
    expect(resolveMcpAuthorizationPollOutcome({
      connected: false,
      authorizationWindowClosed: false,
      elapsedMs: 90_000,
      timeoutMs: 90_000,
    })).toBe("timeout");
    expect(MCP_AUTHORIZATION_TIMEOUT_MESSAGE).toContain("provider error");
    expect(resolveMcpAuthorizationPollOutcome({
      connected: false,
      authorizationWindowClosed: false,
      elapsedMs: 89_999,
      timeoutMs: 90_000,
    })).toBe("pending");
  });

  test("explains when the start response cannot be confirmed for the member", () => {
    expect(MCP_AUTHORIZATION_UNCONFIRMED_CONNECTED_MESSAGE).toContain("could not confirm");
    expect(MCP_AUTHORIZATION_UNCONFIRMED_CONNECTED_MESSAGE).toContain("provider configuration");
  });
});
