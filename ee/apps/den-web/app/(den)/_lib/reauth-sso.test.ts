import assert from "node:assert/strict";
import test from "node:test";
import { parseReauthSessionMethods, reauthPasswordOption, resolveReauthSsoTarget } from "./reauth-sso";

const defaults = { loading: false, ssoOnly: false, legacyPasswordAvailable: true };

for (const [sessionUsesSso, hasPasswordCredential, ssoOnly, expected] of [
  [true, true, false, "disclosed"],
  [true, true, true, "hidden"],
  [true, false, false, "hidden"],
  [true, false, true, "hidden"],
  [false, true, false, "visible"],
  [false, true, true, "hidden"],
  [false, false, false, "hidden"],
  [false, false, true, "hidden"],
] as const) {
  test(`password option: SSO session=${sessionUsesSso}, password=${hasPasswordCredential}, SSO-only=${ssoOnly}`, () => {
    const methods = parseReauthSessionMethods({ sessionUsesSso, hasPasswordCredential });
    assert.equal(reauthPasswordOption({ ...defaults, ssoOnly, methods }), expected);
  });
}

test("an older API keeps the previous password presentation, but checking methods never shows it", () => {
  const methods = parseReauthSessionMethods({ organizations: [] });
  assert.equal(methods, null);
  assert.equal(reauthPasswordOption({ ...defaults, methods }), "visible");
  assert.equal(reauthPasswordOption({ ...defaults, methods, loading: true }), "hidden");
  assert.equal(reauthPasswordOption({ ...defaults, methods, legacyPasswordAvailable: false }), "hidden");
});

test("an SSO session does not select another workspace's SSO URL", () => {
  assert.equal(resolveReauthSsoTarget({
    organizationId: "original-workspace",
    organization: null,
    resolvedDomainSso: null,
    memberSsoSignIns: [{ organizationId: "other-workspace", signInUrl: "/sso/other-workspace", ssoOnly: false }],
  }), null);
});
