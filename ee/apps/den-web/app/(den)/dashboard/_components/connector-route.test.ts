import assert from "node:assert/strict";
import { test } from "node:test";
import { detectedRoute, requestHeaderProblem, requestHeadersFromDrafts, routeSignInMethod } from "./connector-route";
import type { McpRequirementsDiscovery } from "./mcp-connections-data";

function discovery(authentication: Partial<McpRequirementsDiscovery["authentication"]>, status: McpRequirementsDiscovery["status"] = "ready") {
  return {
    status,
    authentication: {
      kind: "oauth" as const,
      authorizationServers: [],
      requiredScopes: [],
      recommendedScopes: [],
      refreshSupport: "supported" as const,
      availableRegistrationMethods: [],
      recommendedRegistrationMethod: "pre_registered" as const,
      ...authentication,
    },
  };
}

test("detection marks OAuth with OpenWork's published details when the server takes them", () => {
  const route = detectedRoute(discovery({ availableRegistrationMethods: ["client_metadata", "dynamic"], recommendedRegistrationMethod: "client_metadata" }));
  assert.deepEqual(route, { auth: "oauth", client: "automatic", automaticRegistration: "client_metadata" });
});

test("detection falls back to dynamic registration, then to the admin's own OAuth app", () => {
  assert.equal(detectedRoute(discovery({ availableRegistrationMethods: ["dynamic"], recommendedRegistrationMethod: "dynamic" })).automaticRegistration, "dynamic");
  assert.deepEqual(detectedRoute(discovery({ availableRegistrationMethods: ["pre_registered"] })), { auth: "oauth", client: "own", automaticRegistration: null });
});

test("detection reports keys, open servers, and nothing when unreachable or unknown", () => {
  assert.equal(detectedRoute(discovery({ kind: "manual_bearer" })).auth, "api_key");
  assert.equal(detectedRoute(discovery({ kind: "none" })).auth, "none");
  assert.equal(detectedRoute(discovery({ kind: "unknown" })).auth, null);
  assert.equal(detectedRoute(discovery({ kind: "none" }, "unreachable")).auth, null);
  assert.equal(detectedRoute(null).auth, null);
});

test("the chosen route decides the setup check's sign-in method", () => {
  assert.equal(routeSignInMethod({ auth: "oauth", client: "automatic" }), "sign_in");
  assert.equal(routeSignInMethod({ auth: "oauth", client: "own" }), "oauth_app");
  assert.equal(routeSignInMethod({ auth: "api_key", client: "automatic" }), "api_key");
  assert.equal(routeSignInMethod({ auth: "none", client: "own" }), "none");
});

test("header rows reject names OpenWork sets and Authorization when OpenWork signs in", () => {
  assert.equal(requestHeaderProblem({ name: "X-Api-Key", value: "abc" }, [], "oauth"), null);
  assert.match(requestHeaderProblem({ name: "Host", value: "a" }, [], "none") ?? "", /OpenWork sets Host/);
  assert.match(requestHeaderProblem({ name: "x-openwork-org-id", value: "a" }, [], "none") ?? "", /OpenWork sets/);
  assert.match(requestHeaderProblem({ name: "Authorization", value: "Bearer a" }, [], "oauth") ?? "", /Sign-in sends Authorization/);
  assert.equal(requestHeaderProblem({ name: "Authorization", value: "Bearer a" }, [], "none"), null);
  assert.match(requestHeaderProblem({ name: "bad name", value: "a" }, [], "none") ?? "", /letters, numbers/);
  assert.match(requestHeaderProblem({ name: "X-Key", value: "a\nb" }, [], "none") ?? "", /one line/);
  assert.match(requestHeaderProblem({ name: "X-Key", value: "" }, [], "none") ?? "", /Add the value/);
});

test("blank rows are ignored and duplicate names are flagged on the later row", () => {
  const result = requestHeadersFromDrafts([
    { id: "a", name: "X-Key", value: "1" },
    { id: "b", name: "", value: "" },
    { id: "c", name: "x-key", value: "2" },
  ], "oauth");
  assert.deepEqual(result.headers, [{ name: "X-Key", value: "1" }]);
  assert.deepEqual(Object.keys(result.problems), ["c"]);
});
