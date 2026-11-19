import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMcpAppSandboxCsp,
  MCP_APP_SANDBOX_PROXY_VERSION,
  mcpAppSandboxPageHeaders,
  parseMcpAppSandboxCsp,
} from "../src/mcp-app-sandbox.js";

const csp = JSON.stringify({
  connectDomains: ["https://api.example"],
  resourceDomains: ["https://cdn.example"],
  frameDomains: [],
  baseUriDomains: [],
});

test("the sandbox page is cached for good only under its current version", () => {
  assert.match(MCP_APP_SANDBOX_PROXY_VERSION, /^[0-9a-f]{16}$/);
  const security = {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": buildMcpAppSandboxCsp(parseMcpAppSandboxCsp(csp)),
    "Referrer-Policy": "strict-origin",
    "X-Content-Type-Options": "nosniff",
  };

  const current = mcpAppSandboxPageHeaders(new URLSearchParams({ v: MCP_APP_SANDBOX_PROXY_VERSION, csp }));
  assert.deepEqual(current, { ...security, "Cache-Control": "public, max-age=31536000, immutable" });

  for (const params of [{ csp }, { v: "0000000000000000", csp }, { v: "", csp }]) {
    assert.deepEqual(mcpAppSandboxPageHeaders(new URLSearchParams(params)), { ...security, "Cache-Control": "no-store" });
  }
});

test("each App's policy stays in its own cached URL", () => {
  const open = mcpAppSandboxPageHeaders(new URLSearchParams({ v: MCP_APP_SANDBOX_PROXY_VERSION }));
  const scoped = mcpAppSandboxPageHeaders(new URLSearchParams({ v: MCP_APP_SANDBOX_PROXY_VERSION, csp }));
  assert.match(open["Content-Security-Policy"], /connect-src 'none'/);
  assert.match(scoped["Content-Security-Policy"], /connect-src https:\/\/api\.example/);
});
