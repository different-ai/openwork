import assert from "node:assert/strict";
import test from "node:test";
import { ssoSessionMaxAgeLabel, ssoSettingsChanges, type SsoSettings } from "./sso-settings";

const saved: SsoSettings = { requireSso: true, restrictDomainToSso: false, ssoSessionMaxAgeHours: null };

test("a save sends no SSO setting the admin did not change", () => {
  assert.deepEqual(ssoSettingsChanges({ perOrganization: true, saved, draft: saved }), {});
  assert.deepEqual(
    ssoSettingsChanges({ perOrganization: true, saved, draft: { ...saved, requireSso: false, ssoSessionMaxAgeHours: 24 } }),
    { requireSso: false, ssoSessionMaxAgeHours: 24 },
  );
  assert.deepEqual(
    ssoSettingsChanges({ perOrganization: true, saved: { ...saved, ssoSessionMaxAgeHours: 8 }, draft: saved }),
    { ssoSessionMaxAgeHours: null },
    "clearing the limit is a change",
  );
});

test("with ssoPerOrganization off, a save never writes SSO settings", () => {
  assert.deepEqual(ssoSettingsChanges({ perOrganization: false, saved, draft: { ...saved, requireSso: false } }), {});
});

test("max age choices read as people say them", () => {
  assert.equal(ssoSessionMaxAgeLabel(null), "Only when their session ends");
  assert.equal(ssoSessionMaxAgeLabel(8), "After 8 hours");
  assert.equal(ssoSessionMaxAgeLabel(24), "After 1 day");
  assert.equal(ssoSessionMaxAgeLabel(168), "After 7 days");
  assert.equal(ssoSessionMaxAgeLabel(720), "After 30 days");
});
