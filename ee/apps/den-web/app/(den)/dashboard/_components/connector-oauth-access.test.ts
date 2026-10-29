import assert from "node:assert/strict";
import { test } from "node:test";
import { connectorOAuthAccess, requestedScopeSelection } from "./connector-oauth-access";

function discovery(requiredScopes: string[], resourceScopesSupported?: string[]) {
  return { authentication: { requiredScopes, resourceScopesSupported, recommendedScopes: [...requiredScopes], authorizationServers: [{ scopesSupported: ["read", "write", "offline_access"] }] } };
}

test("a read/write challenge is preserved when resource metadata advertises only read", () => {
  const input = discovery(["read", "write"], ["read"]);
  const access = connectorOAuthAccess(input);
  assert.deepEqual(access.requiredScopes, ["read", "write"]);
  assert.deepEqual(access.conflictingScopes, ["write"]);
  assert.deepEqual(access.selectedDefault, ["read", "write"]);
  assert.deepEqual(requestedScopeSelection(input, ["read"]), ["read", "write"]);
  assert.match(access.warnings.join(" "), /not listed in the resource metadata/);
});

test("broad provider-required permissions are not relabelled or stripped for a readonly endpoint", () => {
  const input = discovery(["repo", "write:packages", "project"], ["repo", "write:packages", "project"]);
  assert.deepEqual(connectorOAuthAccess(input).selectedDefault, ["repo", "write:packages", "project"]);
  assert.match(connectorOAuthAccess(input).warnings.join(" "), /read-only tool endpoint does not mean a read-only OAuth grant/);
});

test("recommendations and advertised capabilities are optional, not automatically requested", () => {
  const input = { authentication: { ...discovery(["read"], ["read", "write"]).authentication, recommendedScopes: ["read", "write", "offline_access"] } };
  const access = connectorOAuthAccess(input);
  assert.deepEqual(access.optionalScopes, ["write", "offline_access"]);
  assert.deepEqual(access.selectedDefault, ["read"]);
  assert.deepEqual(requestedScopeSelection(input, ["offline_access", "offline_access"]), ["read", "offline_access"]);
});

test("missing challenge requires a deliberate scope choice instead of silently selecting all metadata", () => {
  const access = connectorOAuthAccess(discovery([], ["read", "write"]));
  assert.deepEqual(access.selectedDefault, []);
  assert.equal(access.requiresScopeChoice, true);
  assert.match(access.warnings.join(" "), /all advertised permissions/);
});

test("curated defaults remain unchanged, while conflict disclosure still includes required scopes", () => {
  assert.deepEqual(connectorOAuthAccess(discovery(["read"], ["read"]), { defaultOAuthScopes: ["read", "offline_access"] }).selectedDefault, ["read", "offline_access"]);
  assert.deepEqual(connectorOAuthAccess(discovery(["read"])).conflictingScopes, []);
  assert.deepEqual(connectorOAuthAccess(discovery(["read"], [])).conflictingScopes, ["read"]);
});

test("absent metadata never pretends the final grant is known", () => {
  assert.deepEqual(requestedScopeSelection(null, []), []);
  assert.match(connectorOAuthAccess(null).warnings.join(" "), /provider.*defaults/);
});
