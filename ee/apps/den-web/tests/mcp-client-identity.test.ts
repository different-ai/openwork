import { describe, expect, test } from "bun:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mcpIdentityFacts, McpReturnLine, McpUnverifiedAppWarning } from "../app/mcp/client-identity";
import { McpTechnicalDetails } from "../app/mcp/consent-permissions";
import { knownMcpCimdDomain } from "../app/mcp/client-trust-constants";
import { describeMcpRedirect, fallbackClientName, isLoopbackHost } from "../app/mcp/client-identity-model";

describe("MCP consent client identity", () => {
  test("names the host the approval is sent to", () => {
    expect(describeMcpRedirect("https://claude.ai/api/mcp/auth_callback")).toEqual({ host: "claude.ai", url: "https://claude.ai/api/mcp/auth_callback", loopbackOnly: false });
  });

  test("flags loopback-only redirects, on any port", () => {
    expect(describeMcpRedirect("http://127.0.0.1:39421/callback")).toEqual({ host: "127.0.0.1:39421", url: "http://127.0.0.1:39421/callback", loopbackOnly: true });
    expect(describeMcpRedirect("http://localhost:3000/cb")?.loopbackOnly).toBe(true);
    expect(describeMcpRedirect("http://[::1]:8080/cb")?.loopbackOnly).toBe(true);
    expect(isLoopbackHost("127.9.9.9")).toBe(true);
    expect(isLoopbackHost("localhost.evil.example")).toBe(false);
  });

  test("names native app schemes and ignores garbage", () => {
    expect(describeMcpRedirect("cursor://anysphere.cursor-mcp/oauth/callback")).toEqual({ host: "cursor://", url: "cursor://anysphere.cursor-mcp/oauth/callback", loopbackOnly: false });
    expect(describeMcpRedirect("not a url")).toBeNull();
    expect(describeMcpRedirect(null)).toBeNull();
  });

  test("falls back to the metadata document host for unnamed CIMD clients", () => {
    expect(fallbackClientName("https://app.example.com/oauth/client.json")).toBe("app.example.com");
    expect(fallbackClientName("abc123")).toBe("An app without a name");
  });

  test.each([
    ["https://claude.ai/oauth/claude-code-client-metadata", "claude.ai"],
    ["https://unknown.example/client.json", "unknown.example"],
    ["https://unknown.example:8443/client.json", "unknown.example:8443"],
  ])("shows the CIMD domain beside a trusted-looking name for %s", (clientId, domain) => {
    const client = { name: "Claude", logoUri: null, clientId, loaded: true, metadataResolved: true };
    const markup = renderToStaticMarkup(createElement(Fragment, null, mcpIdentityFacts(client, null).app.value));
    expect(markup).toContain('data-testid="mcp-client-name">Claude</span>');
    expect(markup).toContain(`data-testid="mcp-client-domain">${domain}</span>`);
    if (domain === "unknown.example") {
      expect(renderToStaticMarkup(createElement(McpUnverifiedAppWarning, { client, redirect: null }))).toContain("Unverified application");
    }
  });

  test("does not infer a domain from an opaque DCR client's name or redirect", () => {
    const client = { name: "Claude", logoUri: null, clientId: "dcr-client", loaded: true, metadataResolved: true };
    const redirect = describeMcpRedirect("https://claude.ai/api/mcp/auth_callback");
    const markup = renderToStaticMarkup(createElement(Fragment, null, mcpIdentityFacts(client, redirect).app.value));
    expect(markup).toContain('data-testid="mcp-client-name">Claude</span>');
    expect(markup).not.toContain('data-testid="mcp-client-domain"');
    expect(renderToStaticMarkup(createElement(McpUnverifiedAppWarning, { client, redirect }))).toContain("Unverified application");
  });
});

describe("unverified application warning", () => {
  test.each([
    ["https://claude.ai/oauth/mcp-oauth-client-metadata", "claude.ai"],
    ["https://claude.ai/oauth/claude-code-client-metadata", "claude.ai"],
    ["https://chatgpt.com/oauth/client.json", "chatgpt.com"],
    ["https://chatgpt.com/oauth/abc123/client.json", "chatgpt.com"],
    ["https://chatgpt.com/oauth/codex/abc123/client.json", "chatgpt.com"],
    ["https://vscode.dev/oauth/client-metadata.json", "vscode.dev"],
  ])("recognizes the published CIMD document %s", (clientId, domain) => {
    expect(knownMcpCimdDomain(clientId)).toBe(domain);
  });

  test("recognizes only the exact HTTPS CIMD domain", () => {
    for (const id of [null, "dcr-client", "http://claude.ai/oauth/client", "https://claude.ai/", "https://claude.ai.evil.example/client", "https://sub.claude.ai/client", "https://claude.ai@evil.example/client", "https://evil.example@claude.ai/client", "https://claude.ai:8443/client", "https://claude.ai/client#fragment", "https://chatgpt.com.evil.example/oauth/client.json", "https://www.chatgpt.com/oauth/client.json", "https://vscode.dev.evil.example/oauth/client-metadata.json", "https://insiders.vscode.dev/oauth/client-metadata.json", "https://evil.example/vscode.dev/oauth/client-metadata.json", "https://claude.ai/share/client.json", "https://chatgpt.com/g/client.json", "https://vscode.dev/client-metadata.json", "https://claude.ai/oauth", "https://claude.ai/OAuth/client.json", "https://claude.ai/oauth/../share/client.json", "https://claude.ai/oauth/%2e%2e/share/client.json"]) {
      expect(knownMcpCimdDomain(id)).toBeNull();
    }
  });

  test("recognized CIMD suppresses only the generic warning, not loopback guidance", () => {
    const client = { name: "Client", logoUri: null, clientId: "https://claude.ai/oauth/claude-code-client-metadata", loaded: true, metadataResolved: true };
    const redirect = describeMcpRedirect("http://127.0.0.1:3000/callback");
    const markup = renderToStaticMarkup(createElement(McpUnverifiedAppWarning, { redirect, client }));
    expect(markup).toContain('data-testid="mcp-known-app-identity"');
    expect(markup).toContain("claude.ai");
    expect(markup).not.toContain("Unverified application");
    expect(renderToStaticMarkup(createElement(McpReturnLine, { redirect, client }))).toContain('data-testid="mcp-loopback-warning"');
    for (const changed of [{ ...client, metadataResolved: false }, { ...client, loaded: false }, { ...client, clientId: "dcr-client" }, { ...client, clientId: "https://unknown.example/client" }, { ...client, clientId: "https://claude.ai/share/client.json" }]) {
      expect(renderToStaticMarkup(createElement(McpUnverifiedAppWarning, { redirect: describeMcpRedirect("https://claude.ai/api/mcp/auth_callback"), client: changed }))).toContain("Unverified application");
    }
  });

  test.each([
    ["https://assistant.example.com/oauth/callback", "assistant.example.com"],
    ["http://127.0.0.1:39421/callback", "127.0.0.1:39421"],
    ["cursor://anysphere.cursor-mcp/oauth/callback", "cursor://"],
  ])("always warns and shows only the return host for %s", (url, host) => {
    const markup = renderToStaticMarkup(createElement(McpUnverifiedAppWarning, { redirect: describeMcpRedirect(url) }));
    expect(markup).toContain("Unverified application");
    expect(markup).toContain("OpenWork has not verified who is requesting this access.");
    expect(markup).toContain("Only authorize if you started this connection and trust the app to act on your behalf with the permissions shown.");
    expect(markup).toContain("Check the return host supplied by this app:");
    expect(markup).toContain(`data-testid="mcp-warning-redirect-host">${host}</span>`);
    expect(markup).not.toContain(url);
    expect(markup).not.toContain('data-testid="mcp-redirect-url"');
    expect(markup).toContain('dir="ltr"');
    expect(markup).toContain("break-all");
    expect(markup).not.toContain("<a ");
    expect(markup).not.toContain("<details");
  });

  test.each([null, "not a url"])("keeps the warning and gives a safe next step when the address is %s", (url) => {
    const markup = renderToStaticMarkup(createElement(McpUnverifiedAppWarning, { redirect: describeMcpRedirect(url) }));
    expect(markup).toContain("Unverified application");
    expect(markup).toContain("Return address unavailable. Cancel and restart the connection from the app you intended to use.");
    expect(markup).not.toContain('data-testid="mcp-redirect-url"');
    expect(markup).not.toContain('data-testid="mcp-warning-redirect-host"');
  });

  test("renders the escaped full callback as inert text inside collapsed technical details", () => {
    const url = "https://assistant.example.com/callback?label=<img src=x onerror=alert(1)>&next=review";
    const markup = renderToStaticMarkup(createElement(McpTechnicalDetails, { scope: "mcp:read", clientId: "dcr-client", redirect: describeMcpRedirect(url) }));
    expect(markup).toMatch(/<details\b[^>]*>[\s\S]*data-testid="mcp-redirect-url"[\s\S]*<\/details>/);
    expect(markup).not.toMatch(/<details\b[^>]*\sopen(?:[\s=>])/);
    expect(markup).toContain('data-testid="mcp-redirect-url">https://assistant.example.com/callback?label=%3Cimg%20src=x%20onerror=alert(1)%3E&amp;next=review</span>');
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("href=");
  });

  test("keeps the actual host visible when the URL contains misleading user info", () => {
    const redirect = describeMcpRedirect("https://trusted.example@untrusted.example/oauth/callback");
    expect(redirect?.host).toBe("untrusted.example");
    const markup = renderToStaticMarkup(createElement(McpUnverifiedAppWarning, { redirect }));
    expect(markup).toContain('data-testid="mcp-warning-redirect-host">untrusted.example</span>');
    expect(markup).not.toContain("trusted.example@");
    expect(markup).not.toContain("/oauth/callback");
    expect(markup).not.toContain('data-testid="mcp-redirect-url"');
    const details = renderToStaticMarkup(createElement(McpTechnicalDetails, { scope: "mcp:read", clientId: "dcr-client", redirect }));
    expect(details).toContain('data-testid="mcp-redirect-url">https://trusted.example@untrusted.example/oauth/callback</span>');
  });
});
