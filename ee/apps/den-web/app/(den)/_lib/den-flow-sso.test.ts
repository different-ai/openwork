import assert from "node:assert/strict";
import test from "node:test";
import { getRequestError, SsoSessionRequiredError } from "./den-flow";

test("SSO settings recovery accepts only an organization sign-in path on this site", () => {
  const blocked = new Response(null, { status: 409 });
  const recovery = getRequestError({ error: "sso_session_required", message: "Use SSO", signInPath: "/sso/synthetic-org" }, blocked, "Save failed");
  assert.ok(recovery instanceof SsoSessionRequiredError);
  assert.equal(recovery.signInPath, "/sso/synthetic-org");
  for (const signInPath of ["https://outside.example/sso", "//outside.example", "/other", "/sso/test?callbackURL=outside", "/sso/../other"]) {
    assert.equal(getRequestError({ error: "sso_session_required", signInPath }, blocked, "Save failed") instanceof SsoSessionRequiredError, false);
  }
  assert.equal(getRequestError({ error: "other", signInPath: "/sso/synthetic-org" }, blocked, "Save failed") instanceof SsoSessionRequiredError, false);
});
