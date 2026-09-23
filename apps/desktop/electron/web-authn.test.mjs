import assert from "node:assert/strict";
import { test } from "node:test";

import { chooseWebAuthnAccount, configureBrowserWebAuthn, signedWebAuthnGroup } from "./web-authn.mjs";

const appId = "com.differentai.openwork";
const group = `A1B2C3D4E5.${appId}.webauthn`;

test("WebAuthn only uses the signed app's own keychain entitlement", () => {
  const run = (command) => command === "codesign" ? "<plist/>" : JSON.stringify(["A1B2C3D4E5.other.app.webauthn", group]);
  assert.equal(signedWebAuthnGroup({ executable: "/OpenWork", appId, run }), group);
  assert.equal(signedWebAuthnGroup({ executable: "/OpenWork", appId: "other.app", run }), "A1B2C3D4E5.other.app.webauthn");
  assert.equal(signedWebAuthnGroup({ executable: "/OpenWork", appId, run: () => { throw new Error("unsigned"); } }), null);
});

test("WebAuthn configures Touch ID only in an entitled packaged macOS app", () => {
  const configured = [];
  const app = { isPackaged: true, getPath: () => "/OpenWork", configureWebAuthn: (options) => configured.push(options) };
  const run = (command) => command === "codesign" ? "<plist/>" : JSON.stringify([group]);
  assert.equal(configureBrowserWebAuthn({ app, appId, platform: "darwin", run }), true);
  assert.deepEqual(configured, [{ touchID: { keychainAccessGroup: group, promptReason: "sign in to $1" } }]);
  assert.equal(configureBrowserWebAuthn({ app: { ...app, isPackaged: false }, appId, platform: "darwin", run }), false);
  assert.equal(configureBrowserWebAuthn({ app, appId, platform: "win32", run }), false);
  assert.equal(configured.length, 1);
});

test("account chooser selects the requested credential across pages and cancels safely", async () => {
  const accounts = Array.from({ length: 5 }, (_, index) => ({ credentialId: `id-${index}`, name: `Account ${index}` }));
  const window = { isDestroyed: () => false };
  const dialogs = [];
  const selected = await chooseWebAuthnAccount({
    details: { relyingPartyId: "example.com", accounts }, window,
    showMessageBox: async (_window, options) => {
      dialogs.push(options);
      return { response: dialogs.length === 1 ? 4 : 2 };
    },
  });
  assert.equal(selected, "id-4");
  assert.deepEqual(dialogs[0].buttons, ["Cancel", "Account 0", "Account 1", "Account 2", "More passkeys"]);
  assert.deepEqual(dialogs[1].buttons, ["Cancel", "Account 3", "Account 4", "Previous"]);
  assert.equal(await chooseWebAuthnAccount({
    details: { relyingPartyId: "example.com", accounts }, window,
    showMessageBox: async () => ({ response: 0 }),
  }), null);
});
