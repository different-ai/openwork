import assert from "node:assert/strict";
import { test } from "node:test";
import { describeMcpAuthorizationFailure, mcpAuthorizationTabUrl, parseMcpAuthorizationTabState, type McpAuthorizationDebugDetails } from "./mcp-authorization-url";

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

const configurationRequired: McpAuthorizationDebugDetails = {
  httpStatus: 409,
  errorCode: "mcp_oauth_configuration_required",
  responseJson: "{}",
};

test("domain callback recovery is nonretryable and offers the exact redirect URI to copy", () => {
  const redirectUri = "https://api.example.test/custom/path/callback?runtime=verified";
  const failure = describeMcpAuthorizationFailure({
    connectionName: "Test provider",
    message: "The deployment callback URL changed. An organization admin must update the provider.",
    details: { ...configurationRequired, redirectUri, retryable: true },
  });
  assert.equal(failure.retryable, false);
  assert.match(failure.title, /admin to reconnect/);
  assert.ok(failure.advice.some((line) => /existing OAuth app/.test(line)));
  assert.ok(failure.advice.some((line) => /confirm the callback URL update/.test(line)));
  assert.deepEqual(failure.copyable, [{ label: "Redirect URI", value: redirectUri }]);
  assert.ok(!failure.advice.some((line) => /try again/i.test(line)));
});

test("member domain safeguard without a callback asks for admin reconnect, not provider changes", () => {
  const message = "The deployment domain changed. An organization admin must reconnect this connection before members can sign in again.";
  const failure = describeMcpAuthorizationFailure({ connectionName: "Test provider", message, details: configurationRequired });
  assert.equal(failure.retryable, false);
  assert.equal(failure.description, message);
  assert.deepEqual(failure.copyable, []);
  assert.deepEqual(failure.advice, ["Ask an organization admin to reconnect this connection before signing in again."]);
  assert.doesNotMatch(failure.advice.join(" "), /provider|allowlist|client ID|callback/i);
});

test("other configuration errors retain setup guidance without claiming the domain changed", () => {
  const message = "This authorization server requires a pre-registered OAuth client before OpenWork can connect.";
  const redirectUri = "https://api.example.test/oauth/callback";
  const failure = describeMcpAuthorizationFailure({ connectionName: "Test provider", message, details: { ...configurationRequired, redirectUri } });
  assert.equal(failure.retryable, false);
  assert.equal(failure.description, message);
  assert.equal(failure.title, "Test provider needs sign-in setup");
  assert.doesNotMatch(failure.advice.join(" "), /domain changed|existing OAuth app|confirm the callback/);
  assert.deepEqual(failure.copyable, [{ label: "Redirect URI", value: redirectUri }]);
  const withoutCallback = describeMcpAuthorizationFailure({ connectionName: "Test provider", message: "Review the sign-in setup.", details: configurationRequired });
  assert.deepEqual(withoutCallback.advice, ["Ask an organization admin to review this connection's sign-in setup."]);
});

test("configuration-required redirect URI survives the failure tab handoff", () => {
  const details = { ...configurationRequired, redirectUri: "https://api.example.test/oauth/callback" };
  const url = mcpAuthorizationTabUrl({ connectionId: "test-connection", connectionName: "Test provider", failure: { message: "The deployment callback URL changed.", details } });
  const state = parseMcpAuthorizationTabState(new URL(url, "https://den.example.test").searchParams);
  assert.equal(state.failure?.details?.redirectUri, details.redirectUri);
  assert.equal(state.failure?.details?.errorCode, "mcp_oauth_configuration_required");
});
