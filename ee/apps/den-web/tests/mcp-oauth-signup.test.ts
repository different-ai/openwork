import { describe, expect, test } from "bun:test";
import {
  MCP_OAUTH_RESTART_MESSAGE,
  describeMcpOAuthError,
  getMcpOAuthSelectOrganizationRoute,
  getMcpOAuthSocialCallbackUrl,
  isMcpOAuthQueryExpired,
} from "../app/(den)/_lib/mcp-oauth-route";
import { getAuthResumeUrl, signsInInPlace } from "../app/(den)/_lib/auth-resume";
import { readConnectMcpLink, readConnectStartResult, readWorkspaceName } from "../app/connect/mcp/connect-mcp-link";
import { mcpPermissionLines } from "../app/mcp/consent-permissions";
import { mcpStoryCopy } from "../app/mcp/mcp-story";
import { fallbackMcpClientName, readPublicMcpClient } from "../app/mcp/use-mcp-client";

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
    expect(readConnectStartResult({ status: "needs_auth", authorizeUrl: null }, true, "Linear")).toEqual({
      kind: "error",
      message: "Linear did not open a sign-in page. Try again.",
    });
    expect(readConnectStartResult({ error: "connection_not_found" }, false)).toEqual({
      kind: "unavailable",
      message: "This connection was removed or is not shared with you. Ask your agent for a new link.",
    });
  });

  test("names the link's workspace from the person's organizations", () => {
    const payload = { orgs: [{ id: "org_1", name: "Sam's work" }, { id: "org_2", name: "Acme" }] };
    expect(readWorkspaceName(payload, "org_2")).toBe("Acme");
    expect(readWorkspaceName(payload, "org_3")).toBeNull();
    expect(readWorkspaceName(null, "org_1")).toBeNull();
  });
});

describe("signing in without leaving the page", () => {
  test("connection links come back to themselves after social sign-in", () => {
    const location = { pathname: "/connect/mcp", search: "?connectionId=emc_1&org=org_1&name=Linear" };
    expect(signsInInPlace("/connect/mcp")).toBe(true);
    expect(signsInInPlace("/connect/mcp/")).toBe(true);
    expect(getAuthResumeUrl({ pathname: "/device", search: "?user_code=ABCDEFGH" }, "https://app.example.test")).toBe("https://app.example.test/device?user_code=ABCDEFGH");
    expect(getAuthResumeUrl({ pathname: "/claim", search: "?user_code=WXYZ2345" }, "https://app.example.test")).toBe("https://app.example.test/claim?user_code=WXYZ2345");
    expect(getAuthResumeUrl(location, "https://app.example.test")).toBe("https://app.example.test/connect/mcp?connectionId=emc_1&org=org_1&name=Linear");
  });

  test("an agent's authorization keeps its signed query; other pages use the default landing", () => {
    expect(getAuthResumeUrl({ pathname: "/", search: `?${signedQuery}` }, "https://app.example.test")).toBe(`https://app.example.test/?${signedQuery}`);
    expect(getAuthResumeUrl({ pathname: "/dashboard", search: "?mode=sign-up" }, "https://app.example.test")).toBeNull();
    expect(signsInInPlace("/dashboard")).toBe(false);
  });
});

describe("what the agent's authorization page says", () => {
  test("turns scopes into plain sentences", () => {
    expect(mcpPermissionLines("openid profile email mcp:read mcp:write offline_access")).toEqual([
      "See your name and email",
      "Find and read what is in this workspace",
      "Use your connected tools, including actions that create, change, or delete data",
      "Stay connected until you remove it",
    ]);
    expect(mcpPermissionLines("mcp:read")).toEqual(["Find and read what is in this workspace"]);
  });

  test("names the app that asked, or says an app asked when it shared no name", () => {
    expect(mcpStoryCopy({ name: "Claude Code" })).toEqual({ title: "Connect Claude Code.", description: "Claude Code asked to use OpenWork as you." });
    expect(mcpStoryCopy({ name: null })).toEqual({ title: "Connect an app.", description: "An app asked to use OpenWork as you." });
  });

  test("reads the registered client name and only trusts https logos", () => {
    expect(readPublicMcpClient({ client_name: " Claude Code ", logo_uri: "https://example.test/logo.png" })).toEqual({ name: "Claude Code", logoUri: "https://example.test/logo.png" });
    expect(readPublicMcpClient({ client_name: "", logo_uri: "http://example.test/logo.png" })).toEqual({ name: null, logoUri: null });
    expect(fallbackMcpClientName("https://agent.example.net/client.json")).toBe("agent.example.net");
    expect(fallbackMcpClientName("dcr_abc123")).toBeNull();
  });
});
