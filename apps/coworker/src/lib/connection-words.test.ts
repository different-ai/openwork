import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConnectHealth } from "./connect.ts";
import {
  connectRowStatus,
  parseCloudConnectionStatus,
  parseEngineToolStatus,
} from "./connection-words.ts";

function health(code: string, recommendedAction = ""): ConnectHealth {
  return { usable: false, phase: "degraded", toolsPresent: [], toolsMissing: [], failure: { code, message: `failure ${code}`, recommendedAction } };
}

test("authentication, admin-only failures, and engine repair route to different actions", () => {
  assert.equal(connectRowStatus(null, false, "Acme").action, "sign-in");
  assert.equal(connectRowStatus({ status: "attention", health: health("invalid_mcp_token"), message: "expired" }, true, "Acme").action, "sign-in");
  assert.equal(connectRowStatus({ status: "attention", health: health("cloud_token_org_mismatch"), message: "wrong organization" }, true, "Acme").action, null);
  assert.equal(connectRowStatus({ status: "attention", health: health("opencode_engine_unreachable"), message: "engine down" }, true, "Acme").action, "repair");
});

test("connection status parsers preserve action routing and reject malformed reports", () => {
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
  assert.equal(parsed.actor, "member");
  assert.equal(parsed.action.type, "connect");
  assert.equal(parsed.action.surface, "openwork_your_connections");
  assert.equal(parseCloudConnectionStatus({ ...raw, state: "weird" }), null);
  assert.equal(parseCloudConnectionStatus({ ...raw, action: { type: "connect" } }), null);
  assert.equal(parseCloudConnectionStatus("nope"), null);
  assert.deepEqual(parseEngineToolStatus({ status: "failed", error: "boom" }), { status: "failed", error: "boom" });
  assert.equal(parseEngineToolStatus({ status: "sideways" }), null);
  assert.equal(parseEngineToolStatus(null), null);
});
