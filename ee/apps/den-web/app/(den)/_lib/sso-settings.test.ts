import assert from "node:assert/strict";
import test from "node:test";
import { ssoSettingsChanges, type SsoSettings } from "./sso-settings";

const saved: SsoSettings = { requireSso: true, restrictDomainToSso: false };

test("a save sends no SSO setting the admin did not change", () => {
  assert.deepEqual(ssoSettingsChanges({ perOrganization: true, saved, draft: saved }), {});
  assert.deepEqual(
    ssoSettingsChanges({ perOrganization: true, saved, draft: { ...saved, requireSso: false } }),
    { requireSso: false },
  );
});

test("with ssoPerOrganization off, a save never writes SSO settings", () => {
  assert.deepEqual(ssoSettingsChanges({ perOrganization: false, saved, draft: { ...saved, requireSso: false } }), {});
});
