import assert from "node:assert/strict";
import { test } from "node:test";
import { describeMcpAuthorizationFailure, type McpAuthorizationDebugDetails } from "./mcp-authorization-url";

const refused: McpAuthorizationDebugDetails = {
  httpStatus: 424,
  errorCode: "oauth_handshake_failed",
  diagnosticCode: "MCP_HTTP_403",
  diagnosticReference: "req_test_registration",
  phase: "AUTH_CLIENT_REGISTRATION",
  highestPassed: "reachable",
  category: "http_failure",
  retryable: false,
  actionOwner: "provider_admin",
  responseJson: "{}",
};

test("a provider that refuses to register OpenWork says only approved apps can sign in", () => {
  const failure = describeMcpAuthorizationFailure({ connectionName: "Figma", message: "Could not connect", details: refused });
  assert.equal(failure.title, "Figma only lets approved apps sign in");
  assert.match(failure.description, /only accepts apps it has approved/);
  assert.match(failure.description, /trying again won't help/);
  assert.equal(failure.retryable, false);
  assert.deepEqual(failure.copyable, [{ label: "Reference", value: "req_test_registration" }]);
  assert.ok(!failure.advice.some((line) => /Try again/.test(line)));
});

test("a 403 in another phase keeps the generic message", () => {
  const failure = describeMcpAuthorizationFailure({ connectionName: "Figma", message: "Could not connect", details: { ...refused, phase: "AUTH_TOKEN_EXCHANGE" } });
  assert.equal(failure.title, "Couldn't start the Figma sign-in");
});

test("other registration failures keep the generic message", () => {
  const failure = describeMcpAuthorizationFailure({ connectionName: "Figma", message: "Could not connect", details: { ...refused, diagnosticCode: "MCP_HTTP_500" } });
  assert.equal(failure.title, "Couldn't start the Figma sign-in");
});
