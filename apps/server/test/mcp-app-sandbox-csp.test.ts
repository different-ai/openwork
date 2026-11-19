import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMcpAppSandboxCsp, parseMcpAppSandboxCsp } from "../src/mcp-app-sandbox.js";

// The sandbox proxy builds its CSP from the `csp` query param, which the
// embedding page controls. It must apply the same origin rules as the MCP App
// resource meta, so the param can never widen the policy: https: anywhere,
// wss: for connect-src, http: and ws: only on loopback.
function policy(csp: Record<string, string[]>): Record<string, string[]> {
  const header = buildMcpAppSandboxCsp(parseMcpAppSandboxCsp(JSON.stringify(csp)));
  return Object.fromEntries(header.split(";").map((part) => {
    const [name = "", ...sources] = part.trim().split(/\s+/);
    return [name, sources];
  }));
}

test("MCP App sandbox csp param keeps https, wss and loopback origins and drops non-loopback http and ws", () => {
  const result = policy({
    connectDomains: [
      "https://api.example.com",
      "wss://realtime.example.com",
      "http://localhost:3000",
      "ws://localhost:3000",
      "ws://127.0.0.1:8080",
      "ws://[::1]:8080",
      "ws://example.com",
      "http://example.com",
      "ws://10.0.0.5:8080",
    ],
    resourceDomains: ["https://cdn.example.com", "http://127.0.0.1:5173", "http://cdn.example.com", "wss://cdn.example.com"],
    frameDomains: ["https://frame.example.com", "http://frame.example.com"],
    baseUriDomains: ["https://base.example.com", "http://base.example.com"],
  });
  assert.deepEqual(result["connect-src"], [
    "https://api.example.com",
    "wss://realtime.example.com",
    "http://localhost:3000",
    "ws://localhost:3000",
    "ws://127.0.0.1:8080",
    "ws://[::1]:8080",
  ]);
  assert.deepEqual(result["script-src"], ["'self'", "'unsafe-inline'", "https://cdn.example.com", "http://127.0.0.1:5173"]);
  assert.deepEqual(result["frame-src"], ["'self'", "https://frame.example.com"]);
  assert.deepEqual(result["base-uri"], ["https://base.example.com"]);
  const header = JSON.stringify(result);
  for (const dropped of ["ws://example.com", "http://example.com", "ws://10.0.0.5:8080", "http://cdn.example.com", "wss://cdn.example.com", "http://frame.example.com", "http://base.example.com"]) {
    assert.ok(!header.includes(`"${dropped}"`), `${dropped} must be dropped`);
  }
});
