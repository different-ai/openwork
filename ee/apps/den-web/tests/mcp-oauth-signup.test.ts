import { describe, expect, test } from "bun:test";
import {
  MCP_OAUTH_RESTART_MESSAGE,
  describeMcpOAuthError,
  getMcpOAuthSelectOrganizationRoute,
  getMcpOAuthSocialCallbackUrl,
  isMcpOAuthQueryExpired,
} from "../app/(den)/_lib/mcp-oauth-route";
import { readConnectMcpLink, readConnectStartResult } from "../app/connect/mcp/connect-mcp-link";

const signedQuery =
  "response_type=code&client_id=agent-cli&scope=openid+mcp%3Aread+mcp%3Awrite&redirect_uri=http%3A%2F%2F127.0.0.1%3A5555%2Fcb&code_challenge=abc&exp=1900000000&ba_iat=1&sig=s1g";

describe("social sign-up during an agent's MCP authorization", () => {
  test("returns to the landing page with the exact signed query so authorization resumes", () => {
    const callback = getMcpOAuthSocialCallbackUrl(`?${signedQuery}`, "https://app.example.test");
    expect(callback).toBe(`https://app.example.test/?${signedQuery}`);
    const landing = new URL(callback ?? "");
    expect(getMcpOAuthSelectOrganizationRoute(landing.search)).toBe(`/mcp/select-organization?${signedQuery}`);
  });

  test("ordinary sign-ins keep their existing callback", () => {
    expect(getMcpOAuthSocialCallbackUrl("?mode=sign-up", "https://app.example.test")).toBeNull();
    expect(getMcpOAuthSocialCallbackUrl("", "https://app.example.test")).toBeNull();
  });
});

describe("expired MCP authorization", () => {
  test("detects a signed query whose exp has passed", () => {
    expect(isMcpOAuthQueryExpired("exp=100", 200_000)).toBe(true);
    expect(isMcpOAuthQueryExpired("?exp=1900000000", Date.now())).toBe(false);
    expect(isMcpOAuthQueryExpired("scope=mcp%3Aread", Date.now())).toBe(false);
  });

  test("tells the person to restart from their agent on invalid_signature", () => {
    expect(describeMcpOAuthError({ error: "invalid_signature" }, "fallback")).toBe(MCP_OAUTH_RESTART_MESSAGE);
    expect(describeMcpOAuthError({ message: "invalid_signature" }, "fallback")).toBe(MCP_OAUTH_RESTART_MESSAGE);
    expect(describeMcpOAuthError({ message: "Organization required" }, "fallback")).toBe("Organization required");
    expect(describeMcpOAuthError(null, "fallback")).toBe("fallback");
  });
});

describe("one-click connection sign-in link", () => {
  test("reads the link den-api returns and rejects malformed ids", () => {
    expect(readConnectMcpLink(new URLSearchParams("connectionId=emc_1&org=org_1&name=Linear"))).toEqual({
      connectionId: "emc_1",
      organizationId: "org_1",
      name: "Linear",
    });
    expect(readConnectMcpLink(new URLSearchParams("connectionId=emc_1&org=org_1"))?.name).toBe("this connection");
    expect(readConnectMcpLink(new URLSearchParams("connectionId=../x&org=org_1"))).toBeNull();
    expect(readConnectMcpLink(new URLSearchParams("org=org_1"))).toBeNull();
  });

  test("maps connect/start results to connected, redirect, or a readable error", () => {
    expect(readConnectStartResult({ status: "connected", authorizeUrl: null }, true)).toEqual({ kind: "connected" });
    expect(readConnectStartResult({ status: "needs_auth", authorizeUrl: "https://idp.test/authorize" }, true)).toEqual({
      kind: "redirect",
      authorizeUrl: "https://idp.test/authorize",
    });
    expect(readConnectStartResult({ status: "needs_auth", authorizeUrl: null }, true).kind).toBe("error");
    expect(readConnectStartResult({ error: "connection_not_found" }, false)).toEqual({
      kind: "error",
      message: "This connection was removed or is not shared with you. Ask your agent for a new link.",
    });
  });
});
