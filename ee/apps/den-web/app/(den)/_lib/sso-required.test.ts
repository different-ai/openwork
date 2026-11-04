import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSsoRequiredRedirect, readSsoRequiredSignInPath } from "./sso-required";

test("reads the SSO sign-in path from Den's sso_required and Better Auth's SSO_REQUIRED refusals", () => {
  assert.equal(readSsoRequiredSignInPath({ error: "sso_required", signInPath: "/sso/acme" }), "/sso/acme");
  assert.equal(readSsoRequiredSignInPath({ code: "SSO_REQUIRED", message: "x", signInPath: "/sso/acme" }), "/sso/acme");
  assert.equal(readSsoRequiredSignInPath({ error: "forbidden", signInPath: "/sso/acme" }), null);
  assert.equal(readSsoRequiredSignInPath({ error: "sso_required", signInPath: "https://elsewhere.test/sso" }), null, "only a same-site path");
  assert.equal(readSsoRequiredSignInPath(null), null);
});

test("the SSO redirect returns to the page being opened and never leaves the site", () => {
  const origin = "https://app.example.test";
  const url = new URL(buildSsoRequiredRedirect("/sso/acme", `${origin}/dashboard/acme`, origin));
  assert.equal(url.pathname, "/sso/acme");
  assert.equal(url.searchParams.get("callbackURL"), `${origin}/dashboard/acme`);
  assert.equal(buildSsoRequiredRedirect("//evil.test/sso", `${origin}/`, origin), `${origin}/`);
});
