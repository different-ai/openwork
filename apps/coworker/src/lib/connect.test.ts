import assert from "node:assert/strict";
import { test } from "node:test";
import { connectGatewayUrl, connectReconcilePayload, connectStateFromHealth, describeConnect, parseConnectHealth } from "./connect.ts";

test("connectGatewayUrl heals hosted resources and appends /agent to self-hosted ones", () => {
  assert.equal(connectGatewayUrl("https://app.openworklabs.com/mcp"), "https://api.app.openworklabs.com/mcp/agent");
  assert.equal(connectGatewayUrl("https://app.openworklabs.com/api/den/mcp/"), "https://api.app.openworklabs.com/mcp/agent");
  assert.equal(connectGatewayUrl("https://api.app.openworklabs.com/mcp"), "https://api.app.openworklabs.com/mcp/agent");
  assert.equal(connectGatewayUrl("http://127.0.0.1:4111/mcp"), "http://127.0.0.1:4111/mcp/agent");
  assert.equal(connectGatewayUrl("ftp://example.com/mcp"), null);
  assert.equal(connectGatewayUrl(""), null);
});

test("connectReconcilePayload is the desktop's remote bearer shape, org-scoped and never OAuth", () => {
  const payload = connectReconcilePayload({
    workspaceId: "ws_1",
    session: { baseUrl: "http://127.0.0.1:4111", token: "session", userName: "Eval", userEmail: "e@x", orgId: "org_1", orgName: "Eval Org" },
    token: { token: "mcp-token", expiresAt: "2026-09-02T00:00:00.000Z", organizationId: "org_1", resource: "http://127.0.0.1:4111/mcp", scopes: ["mcp:read", "mcp:write"] },
    appVersion: "0.0.0-dev",
  });
  assert.ok(payload);
  assert.equal(payload.name, "openwork-cloud");
  assert.deepEqual(payload.config, {
    type: "remote",
    enabled: true,
    url: "http://127.0.0.1:4111/mcp/agent",
    headers: { Authorization: "Bearer mcp-token" },
    oauth: false,
  });
  assert.deepEqual(payload.org, { id: "org_1", slug: null, name: "Eval Org" });
  assert.deepEqual(payload.tokenMetadata, { organizationId: "org_1", expiresAt: "2026-09-02T00:00:00.000Z", resource: "http://127.0.0.1:4111/mcp", scopes: "mcp:read mcp:write" });
  assert.equal("appHostAuthorization" in payload, false);
});

test("health parses leniently and becomes one plain status", () => {
  const usable = parseConnectHealth({ usable: true, phase: "ready", tools: { present: ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"], missing: [] }, firstFailure: null, extra: 1 });
  assert.deepEqual(usable.toolsPresent, ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"]);
  assert.equal(connectStateFromHealth(usable).status, "connected");
  assert.deepEqual(describeConnect(connectStateFromHealth(usable), true), { label: "Connected", tone: "mint", detail: "" });

  const broken = parseConnectHealth({ usable: false, phase: "degraded", firstFailure: { code: "invalid_mcp_token", message: "token expired", recommendedAction: "Reconnect OpenWork Cloud" } });
  const attention = connectStateFromHealth(broken);
  assert.equal(attention.status, "attention");
  assert.equal(describeConnect(attention, true).detail, "Reconnect OpenWork Cloud");
  assert.equal(describeConnect(null, false).label, "Not connected");
  assert.equal(describeConnect(null, true).label, "Connecting");
});
