// Runnable check for org-scope pinning. No test framework in den-web,
// so this is a plain assert script: `node org-scope.test.mts`.
import assert from "node:assert/strict";
import {
  getRequestOrgScope,
  setRequestOrgScope,
  shouldPinOrgScopePath,
} from "./org-scope.ts";

assert.equal(shouldPinOrgScopePath("/v1/org"), true);
assert.equal(shouldPinOrgScopePath("/v1/workers?limit=20"), true);
assert.equal(shouldPinOrgScopePath("/v1/mcp-connections?scope=manageable"), true);
assert.equal(shouldPinOrgScopePath("/v1/me"), false);
assert.equal(shouldPinOrgScopePath("/v1/me/"), false);
assert.equal(shouldPinOrgScopePath("/v1/me/orgs"), false);
assert.equal(shouldPinOrgScopePath("/v1/me/orgs?x=1"), false);
assert.equal(shouldPinOrgScopePath("/api/auth/organization/set-active"), false);

setRequestOrgScope("org_test");
assert.equal(getRequestOrgScope(), "org_test");
setRequestOrgScope(null);
assert.equal(getRequestOrgScope(), null);

console.log("ok: org-scope predicate and state");
