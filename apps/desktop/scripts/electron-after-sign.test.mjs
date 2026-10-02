import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { verifySignedApp } = require("./electron-after-sign.cjs");
const { validateProvisioning } = require("./macos-provisioning.cjs");

function recorder() {
  const calls = [];
  return { calls, runCommand: (command, args) => calls.push([command, ...args]) };
}

for (const appPath of [
  "/tmp/dist/mac-arm64/OpenWork.app",
  "/tmp/dist/mac-arm64/OpenWork Cloud.app",
  "/tmp/dist/mac-x64/OpenWork Enterprise.app",
]) {
  test(`verifies the bundle itself for ${appPath}`, () => {
    const { calls, runCommand } = recorder();
    verifySignedApp(appPath, { runCommand });
    assert.deepEqual(calls, [
      ["codesign", "--verify", "--deep", "--strict", "--verbose=2", appPath],
      ["spctl", "--assess", "--type", "execute", "--verbose=2", appPath],
      ["xcrun", "stapler", "validate", appPath],
    ]);
    assert.ok(calls.every((call) => !call.some((arg) => arg.includes("Contents/MacOS"))));
  });
}

test("a failing check fails the build", () => {
  const runCommand = (command) => {
    if (command === "spctl") throw new Error("spctl --assess failed with status 3");
  };
  assert.throws(() => verifySignedApp("/tmp/OpenWork Cloud.app", { runCommand }), /spctl/);
});

test("the build step never launches the packaged app", () => {
  const source = readFileSync(new URL("./electron-after-sign.cjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /"Contents",\s*"MacOS"/);
});

function provisionedApp() {
  return {
    bundleId: "com.example.browser",
    signingTeam: "EXAMPLETEAM",
    certificateHash: "fixture-certificate-sha256",
    developerId: true,
    now: Date.parse("2026-01-01T00:00:00Z"),
    entitlements: {
      "com.apple.application-identifier": "EXAMPLETEAM.com.example.browser",
      "com.apple.developer.team-identifier": "EXAMPLETEAM",
      "keychain-access-groups": ["EXAMPLETEAM.com.example.browser.webauthn"],
      "com.apple.developer.web-browser.public-key-credential": true,
    },
    profile: {
      expiration: "2027-01-01T00:00:00Z",
      platforms: ["OSX"],
      teams: ["EXAMPLETEAM"],
      prefixes: ["EXAMPLETEAM"],
      certificateHashes: ["fixture-certificate-sha256"],
      provisionsAllDevices: true,
      entitlements: {
        "com.apple.application-identifier": "EXAMPLETEAM.com.example.browser",
        "keychain-access-groups": ["EXAMPLETEAM.*"],
        "com.apple.developer.web-browser.public-key-credential": true,
      },
    },
  };
}

test("ordinary hardened-runtime builds do not need a provisioning profile", () => {
  assert.doesNotThrow(() => validateProvisioning({ entitlements: {
    "com.apple.security.cs.allow-jit": true,
    "com.apple.security.device.audio-input": true,
  } }));
});

test("the original keychain entitlement without an embedded profile fails before notarization", () => {
  assert.throws(() => validateProvisioning({ entitlements: {
    "keychain-access-groups": ["EXAMPLETEAM.com.example.browser.webauthn"],
  } }), /Missing Contents\/embedded.provisionprofile/);
});

test("browser passkeys require an embedded profile even without local Touch ID groups", () => {
  assert.throws(() => validateProvisioning({ entitlements: {
    "com.apple.developer.web-browser.public-key-credential": true,
  } }), /Missing Contents\/embedded.provisionprofile/);
});

test("a matching signed macOS profile authorizes all requested capabilities", () => {
  assert.doesNotThrow(() => validateProvisioning(provisionedApp()));
});

test("a scalar wildcard grant authorizes an array of associated domains", () => {
  const app = provisionedApp();
  app.entitlements["com.apple.developer.associated-domains"] = [
    "webcredentials:example.com",
    "webcredentials:login.example.com",
  ];
  app.profile.entitlements["com.apple.developer.associated-domains"] = "*";
  assert.doesNotThrow(() => validateProvisioning(app));
});

test("a scalar domain grant cannot authorize unrelated domains", () => {
  const app = provisionedApp();
  app.entitlements["com.apple.developer.associated-domains"] = [
    "webcredentials:example.com",
    "webcredentials:unapproved.example.com",
  ];
  app.profile.entitlements["com.apple.developer.associated-domains"] = "webcredentials:example.com";
  assert.throws(() => validateProvisioning(app), /every requested value/);
});

for (const [name, change, message] of [
  ["expired profile", (app) => { app.profile.expiration = "2025-12-31T00:00:00Z"; }, /expired/],
  ["invalid expiration", (app) => { app.profile.expiration = "invalid"; }, /expiration/],
  ["iOS profile", (app) => { app.profile.platforms = ["iOS"]; }, /macOS/],
  ["different team", (app) => { app.signingTeam = "OTHERTEAM"; }, /signing team/],
  ["different certificate", (app) => { app.certificateHash = "other-certificate"; }, /certificate/],
  ["development profile for Developer ID", (app) => { app.profile.provisionsAllDevices = false; }, /distribution profile/],
  ["missing application identifier", (app) => { delete app.entitlements["com.apple.application-identifier"]; }, /application-identifier/],
  ["different bundle identifier", (app) => { app.bundleId = "com.example.other"; }, /application-identifier/],
  ["wrong App ID in profile", (app) => { app.profile.entitlements["com.apple.application-identifier"] = "EXAMPLETEAM.com.example.other"; }, /application identifier/],
  ["wrong team entitlement", (app) => { app.entitlements["com.apple.developer.team-identifier"] = "OTHERTEAM"; }, /team entitlement/],
  ["unapproved browser permission", (app) => { delete app.profile.entitlements["com.apple.developer.web-browser.public-key-credential"]; }, /does not authorize com.apple.developer.web-browser/],
  ["denied browser permission", (app) => { app.profile.entitlements["com.apple.developer.web-browser.public-key-credential"] = false; }, /does not authorize com.apple.developer.web-browser/],
  ["unauthorized keychain group", (app) => { app.entitlements["keychain-access-groups"].push("OTHERTEAM.private"); }, /every requested value/],
  ["unapproved associated domain", (app) => { app.entitlements["com.apple.developer.associated-domains"] = ["webcredentials:example.com"]; }, /every requested value/],
]) {
  test(`rejects ${name}`, () => {
    const app = provisionedApp();
    change(app);
    assert.throws(() => validateProvisioning(app), message);
  });
}

test("legacy App ID prefixes can differ from the signing team", () => {
  const app = provisionedApp();
  app.profile.prefixes = ["OLDPREFIX"];
  app.entitlements["com.apple.application-identifier"] = "OLDPREFIX.com.example.browser";
  app.profile.entitlements["com.apple.application-identifier"] = "OLDPREFIX.*";
  assert.doesNotThrow(() => validateProvisioning(app));
});

test("development signing permits device-specific macOS profiles", () => {
  const app = provisionedApp();
  app.developerId = false;
  app.profile.provisionsAllDevices = false;
  assert.doesNotThrow(() => validateProvisioning(app));
});
