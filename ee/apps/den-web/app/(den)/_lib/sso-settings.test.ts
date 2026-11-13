import assert from "node:assert/strict";
import test from "node:test";
import { ssoSettingsChanges, type SsoSettings } from "./sso-settings";

const saved: SsoSettings = { requireSso: true, restrictDomainToSso: false };

test("a save sends no SSO setting the admin did not change", () => {
  assert.deepEqual(ssoSettingsChanges({ saved, draft: saved }), {});
  assert.deepEqual(
    ssoSettingsChanges({ saved, draft: { ...saved, requireSso: false } }),
    { requireSso: false },
  );
});

test("domain restriction changes are saved independently", () => {
  assert.deepEqual(ssoSettingsChanges({ saved, draft: { ...saved, restrictDomainToSso: true } }), { restrictDomainToSso: true });
});
