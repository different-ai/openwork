import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConnectHealth } from "./connect.ts";
import {
  connectRowStatus,
  connectionStatusWords,
  localToolStatus,
  parseCloudConnectionStatus,
  parseEngineToolStatus,
  readinessWords,
} from "./connection-words.ts";

function health(code: string, recommendedAction = ""): ConnectHealth {
  return { usable: false, phase: "degraded", toolsPresent: [], toolsMissing: [], failure: { code, message: `failure ${code}`, recommendedAction } };
}

test("the Connected with OpenWork row maps every gateway state to plain words", () => {
  assert.deepEqual(connectRowStatus(null, false, "Acme"), {
    label: "Not connected", tone: "mist", detail: "Sign in to OpenWork to bring your organization's apps and tools here.", action: "sign-in",
  });
  assert.equal(connectRowStatus(null, true, "Acme").label, "Connecting");
  assert.equal(connectRowStatus({ status: "connecting" }, true, "Acme").label, "Connecting");
  const connected = connectRowStatus({ status: "connected", health: { usable: true, phase: "ready", toolsPresent: [], toolsMissing: [], failure: null } }, true, "Acme");
  assert.deepEqual(connected, { label: "Connected as Acme", tone: "mint", detail: "", action: null });
  assert.equal(connectRowStatus({ status: "connected", health: { usable: true, phase: "ready", toolsPresent: [], toolsMissing: [], failure: null } }, true, "  ").label, "Connected");
  // A lapsed or revoked token is a sign-in, not a repair.
  for (const code of ["invalid_mcp_token", "missing_mcp_token", "mcp_session_revoked", "cloud_mcp_needs_auth", "insufficient_mcp_scope"]) {
    const status = connectRowStatus({ status: "attention", health: health(code), message: "x" }, true, "Acme");
    assert.equal(status.label, "Needs sign-in", code);
    assert.equal(status.action, "sign-in", code);
  }
  // Membership, disabled agent access, or the wrong organization needs an admin.
  for (const code of ["mcp_membership_revoked", "cloud_mcp_disabled", "wrong_mcp_resource", "cloud_token_org_mismatch"]) {
    const status = connectRowStatus({ status: "attention", health: health(code, "Enable Agent access in Settings → Connect"), message: "x" }, true, "Acme");
    assert.equal(status.label, "Needs setup by an admin", code);
    assert.equal(status.detail, "Enable Agent access in Settings → Connect");
    assert.equal(status.action, null);
  }
  const attention = connectRowStatus({ status: "attention", health: health("opencode_engine_unreachable"), message: "engine down" }, true, "Acme");
  assert.deepEqual([attention.label, attention.tone, attention.action], ["Needs attention", "amber", "repair"]);
  assert.equal(connectRowStatus({ status: "attention", health: null, message: "Not ready" }, true, "Acme").detail, "Not ready");
  const unavailable = connectRowStatus({ status: "unavailable", message: "No token" }, true, "Acme");
  assert.deepEqual(unavailable, { label: "Unavailable", tone: "rose", detail: "No token", action: "repair" });
});

test("a Cloud connection status names the exact human step and where to take it", () => {
  const raw = {
    version: 1,
    kind: "connection_action",
    connectionId: "conn_1",
    connectionName: "Notion",
    authType: "oauth",
    credentialMode: "per_member",
    state: "needs_connection",
    actor: "member",
    action: { type: "connect", label: "Connect Notion", surface: "openwork_your_connections", retry: "search_capabilities" },
    message: "Notion is not connected for you yet.",
  };
  const parsed = parseCloudConnectionStatus(raw);
  assert.ok(parsed);
  const words = connectionStatusWords(parsed);
  assert.deepEqual([words.label, words.tone, words.detail], ["Needs sign-in", "amber", "Notion is not connected for you yet."]);
  assert.equal(words.humanAction, "Connect Notion on your Connections page in OpenWork.");

  const admin = connectionStatusWords({ ...parsed, actor: "organization_admin", state: "reauth_required", action: { type: "reconnect", surface: "openwork_organization_connections" } });
  assert.equal(admin.label, "Needs setup by an admin");
  assert.equal(admin.humanAction, "Ask an organization admin to reconnect Notion on the organization's Connections dashboard in OpenWork.");

  const provider = connectionStatusWords({ ...parsed, actor: "provider_admin", state: "provider_error", action: { type: "fix_provider", surface: "provider_admin_console" } });
  assert.equal(provider.label, "Needs attention");
  assert.equal(provider.humanAction, "Ask the provider's administrator to fix Notion on the provider's own admin console.");

  const member = connectionStatusWords({ ...parsed, state: "provider_error", action: { type: "inspect_connection", surface: "openwork_your_connections" } });
  assert.equal(member.label, "Needs attention");
  assert.equal(member.humanAction, "Check Notion on your Connections page in OpenWork.");

  const network = connectionStatusWords({ ...parsed, actor: "network_admin", state: "provider_error", action: { type: "fix_network", surface: "network_infrastructure" } });
  assert.equal(network.humanAction, "Ask whoever runs your network to check the network path to Notion on your network setup.");

  const support = connectionStatusWords({ ...parsed, actor: "openwork", state: "provider_error", action: { type: "contact_openwork", surface: "openwork_support" } });
  assert.equal(support.humanAction, "Ask about Notion with OpenWork support.");

  assert.equal(parseCloudConnectionStatus({ ...raw, state: "weird" }), null);
  assert.equal(parseCloudConnectionStatus({ ...raw, action: { type: "connect" } }), null);
  assert.equal(parseCloudConnectionStatus("nope"), null);
});

test("a tool set up on this Mac reads by what the workspace, the sign-in, and the AI service know", () => {
  assert.equal(localToolStatus({ enabled: false }).label, "Off");
  assert.equal(localToolStatus({ enabled: true, engine: { status: "disabled" } }).label, "Off");
  assert.equal(localToolStatus({ enabled: true, managedOAuth: { status: "needs_auth" } }).label, "Needs sign-in");
  assert.equal(localToolStatus({ enabled: true, managedOAuth: { status: "reconnect_required", lastError: "token expired" } }).technical, "token expired");
  assert.equal(localToolStatus({ enabled: true, engine: { status: "needs_auth" } }).label, "Needs sign-in");
  assert.equal(localToolStatus({ enabled: true, managedOAuth: { status: "connecting" } }).label, "Connecting");
  const registration = localToolStatus({ enabled: true, engine: { status: "needs_client_registration", error: "401 dynamic client registration" } });
  assert.deepEqual([registration.label, registration.technical], ["Needs setup", "401 dynamic client registration"]);
  const failed = localToolStatus({ enabled: true, engine: { status: "failed", error: "ECONNREFUSED 127.0.0.1:9" } });
  assert.deepEqual([failed.label, failed.tone, failed.technical], ["Not connected", "rose", "ECONNREFUSED 127.0.0.1:9"]);
  assert.ok(!failed.detail.includes("ECONNREFUSED"), "raw errors stay behind Technical details");
  assert.deepEqual(localToolStatus({ enabled: true, engine: { status: "connected" } }), { label: "Connected", tone: "mint", detail: "", technical: "" });
  assert.equal(localToolStatus({ enabled: true, reachable: false }).label, "Not connected");
  assert.equal(localToolStatus({ enabled: true, reachable: true }).label, "Connected");
  assert.equal(localToolStatus({ enabled: true }).label, "Checking");
  // The AI service's report is read strictly.
  assert.deepEqual(parseEngineToolStatus({ status: "failed", error: "boom" }), { status: "failed", error: "boom" });
  assert.deepEqual(parseEngineToolStatus({ status: "connected" }), { status: "connected" });
  assert.equal(parseEngineToolStatus({ status: "sideways" }), null);
  assert.equal(parseEngineToolStatus(null), null);
});

test("plugin readiness states become four plain labels", () => {
  assert.equal(readinessWords(undefined).label, "Ready");
  assert.equal(readinessWords("ready").label, "Ready");
  assert.equal(readinessWords("connection_available").label, "Ready");
  assert.equal(readinessWords("needs_signin").label, "Needs sign-in");
  assert.equal(readinessWords("needs_connection").label, "Needs sign-in");
  assert.equal(readinessWords("reconnect").label, "Needs sign-in");
  assert.equal(readinessWords("needs_admin_setup").label, "Needs setup by an admin");
  assert.equal(readinessWords("needs_install").label, "Desktop only");
  assert.equal(readinessWords("desktop_only").label, "Desktop only");
  assert.equal(readinessWords("content_not_synced").label, "Not ready yet");
  assert.equal(readinessWords("unsupported").label, "Not available");
});
