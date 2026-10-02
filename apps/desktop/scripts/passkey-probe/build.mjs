import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { verifyAppProvisioning } = require("../macos-provisioning.cjs");
if (process.platform !== "darwin") throw new Error("The passkey probe requires macOS and Xcode Command Line Tools.");

const directory = path.dirname(fileURLToPath(import.meta.url));
// Always use a new directory, so an earlier signed probe can never be overwritten.
const output = mkdtempSync(path.join(tmpdir(), "openwork-passkey-probe-"));
const app = path.join(output, "OpenWork Passkey Probe.app");
const contents = path.join(app, "Contents");
const executable = path.join(contents, "MacOS", "OpenWorkPasskeyProbe");
mkdirSync(path.dirname(executable), { recursive: true });
const identity = process.env.OPENWORK_PROBE_SIGNING_IDENTITY || "-";
const profile = process.env.OPENWORK_PROBE_PROVISIONING_PROFILE;
const entitlementFile = path.join(output, "entitlements.plist");
const browserPermission = process.argv.includes("--browser-permission");
const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });

if (browserPermission && (!profile || identity === "-")) {
  throw new Error("Browser permission requires an approved embedded profile and a real signing identity. Use a baseline probe while Apple review is pending.");
}
if (profile && !existsSync(profile)) throw new Error("The specified provisioning profile does not exist.");

writeFileSync(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.openworklabs.com</string>
<key>CFBundleName</key><string>OpenWork Passkey Probe</string>
<key>CFBundleExecutable</key><string>OpenWorkPasskeyProbe</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.5</string>
<key>LSUIElement</key><true/>
</dict></plist>\n`);
writeFileSync(entitlementFile, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>${browserPermission ? `
<key>com.apple.application-identifier</key><string>F5DJWB4CCV.com.openworklabs.com</string>
<key>com.apple.developer.team-identifier</key><string>F5DJWB4CCV</string>
<key>com.apple.developer.web-browser.public-key-credential</key><true/>` : ""}
</dict></plist>\n`);
run("xcrun", ["clang", "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=13.5",
  "-framework", "AppKit", "-framework", "AuthenticationServices", "-framework", "Security",
  path.join(directory, "main.m"), "-o", executable]);
if (profile) copyFileSync(profile, path.join(contents, "embedded.provisionprofile"));
run("codesign", ["--force", "--sign", identity, "--options", "runtime", "--entitlements", entitlementFile,
  ...(identity === "-" ? ["--timestamp=none"] : ["--timestamp"]), app]);
run("codesign", ["--verify", "--strict", "--verbose=2", app]);
verifyAppProvisioning(app);

// Launch the actual signed executable. This is the check the old release
// missed: codesign/spctl/notarization can pass while macOS rejects execution.
const result = JSON.parse(execFileSync(executable, [], { encoding: "utf8", timeout: 20_000 }));
if (result.bundleId !== "com.openworklabs.com" || result.browserEntitlement !== browserPermission || result.nativeBrowserApiAvailable !== true) {
  throw new Error(`Unexpected probe result: ${JSON.stringify(result)}`);
}
writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ app, result }, null, 2));
