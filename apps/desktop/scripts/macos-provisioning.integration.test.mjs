import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { verifyAppProvisioning } = require("./macos-provisioning.cjs");

test("a real signed executable launches, while a signed entitlement without a profile is rejected before launch", {
  skip: process.platform !== "darwin",
  timeout: 60_000,
}, () => {
  const baseline = JSON.parse(execFileSync(process.execPath, [
    new URL("./passkey-probe/build.mjs", import.meta.url).pathname,
  ], {
    encoding: "utf8", timeout: 40_000,
    env: { ...process.env, OPENWORK_PROBE_SIGNING_IDENTITY: "-", OPENWORK_PROBE_PROVISIONING_PROFILE: "" },
  }));
  assert.equal(baseline.result.bundleId, "com.openworklabs.com");
  assert.equal(baseline.result.nativeBrowserApiAvailable, true);
  assert.equal(baseline.result.browserEntitlement, false);
  assert.equal(baseline.result.passkeySignInTested, false);
  verifyAppProvisioning(baseline.app);

  const scratch = mkdtempSync(path.join(tmpdir(), "openwork-provisioning-negative-"));
  const broken = path.join(scratch, "OpenWork Probe With Missing Profile.app");
  cpSync(baseline.app, broken, { recursive: true });
  for (const [name, entitlement] of [
    ["keychain", "<key>keychain-access-groups</key><array><string>EXAMPLETEAM.com.example.browser.webauthn</string></array>"],
    ["browser", "<key>com.apple.developer.web-browser.public-key-credential</key><true/>"],
  ]) {
    const plist = path.join(scratch, `${name}.plist`);
    writeFileSync(plist, `<?xml version="1.0"?><plist version="1.0"><dict>${entitlement}</dict></plist>`);
    execFileSync("codesign", ["--force", "--sign", "-", "--timestamp=none", "--entitlements", plist, broken]);
    // This is deliberately a valid signature: the missing authorization is
    // what the new check must catch. Never launch this negative fixture.
    execFileSync("codesign", ["--verify", "--strict", broken]);
    assert.throws(() => verifyAppProvisioning(broken), /Missing Contents\/embedded.provisionprofile/);
  }
});
