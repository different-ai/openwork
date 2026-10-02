const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

// These passkey-related entitlements are authorized by a provisioning profile.
// codesign, Gatekeeper and notarization alone did not catch a missing profile.
const PROFILE_ENTITLEMENTS = [
  "keychain-access-groups",
  "com.apple.developer.associated-domains",
  "com.apple.developer.web-browser.public-key-credential",
];

function requestedProfileEntitlements(entitlements) {
  return PROFILE_ENTITLEMENTS.filter((key) => {
    const value = entitlements[key];
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== false;
  });
}

function permits(pattern, value) {
  if (typeof pattern !== "string" || typeof value !== "string") return pattern === value;
  // Apple's profile wildcards are suffix wildcards, not regular expressions.
  return pattern === value || (pattern.endsWith("*") && value.startsWith(pattern.slice(0, -1)));
}

function validateProvisioning({ entitlements, profile, bundleId, signingTeam, certificateHash, developerId, now = Date.now() }) {
  const restricted = requestedProfileEntitlements(entitlements);
  if (restricted.length === 0) return;
  const fail = (message) => { throw new Error(`[macos-provisioning] ${message}`); };
  if (!profile) fail(`Missing Contents/embedded.provisionprofile for ${restricted.join(", ")}. macOS can reject launch even after notarization.`);
  const expiration = Date.parse(profile.expiration);
  if (!Number.isFinite(expiration) || expiration <= now) fail("The embedded provisioning profile is expired or has no valid expiration date.");
  if (!profile.platforms?.includes("OSX")) fail("The embedded provisioning profile does not authorize macOS.");
  if (!signingTeam || !profile.teams?.includes(signingTeam)) fail("The signing team does not match the embedded provisioning profile.");
  if (!certificateHash || !profile.certificateHashes?.includes(certificateHash)) fail("The signing certificate is not authorized by the embedded provisioning profile.");
  if (developerId && profile.provisionsAllDevices !== true) fail("Developer ID distribution requires an all-devices distribution profile.");

  const applicationId = entitlements["com.apple.application-identifier"];
  if (typeof applicationId !== "string" || !profile.prefixes?.some((prefix) => applicationId === `${prefix}.${bundleId}`)) {
    fail("com.apple.application-identifier must match the profile prefix and the actual bundle identifier.");
  }
  const allowed = profile.entitlements ?? {};
  if (!permits(allowed["com.apple.application-identifier"], applicationId)) fail("The profile does not authorize this application identifier.");
  const entitlementTeam = entitlements["com.apple.developer.team-identifier"];
  if (entitlementTeam !== undefined && entitlementTeam !== signingTeam) fail("The team entitlement does not match the signing team.");

  for (const key of restricted) {
    const requested = entitlements[key];
    const permitted = allowed[key];
    if (Array.isArray(requested)) {
      // Apple can grant an array-valued entitlement with the scalar wildcard "*".
      const patterns = Array.isArray(permitted) ? permitted : [permitted];
      if (!requested.every((value) => patterns.some((pattern) => permits(pattern, value)))) {
        fail(`The profile does not authorize every requested value of ${key}.`);
      }
    } else if (!permits(permitted, requested)) {
      fail(`The profile does not authorize ${key}.`);
    }
  }
}

function plistField(plist, key, format = "json") {
  const result = execFileSync("/usr/bin/plutil", ["-extract", key, format, "-o", "-", "--", "-"], {
    input: plist, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
  return format === "json" ? JSON.parse(result) : result.trim();
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function verifyAppProvisioning(appPath) {
  const signedEntitlements = execFileSync("/usr/bin/codesign", ["--display", "--entitlements", ":-", appPath], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  // An app with no entitlements has no profile-backed passkey capability.
  const entitlements = signedEntitlements.trim()
    ? JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], {
      input: signedEntitlements, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    }))
    : {};
  if (requestedProfileEntitlements(entitlements).length === 0) return;
  const profilePath = path.join(appPath, "Contents", "embedded.provisionprofile");
  if (!existsSync(profilePath)) return validateProvisioning({ entitlements });

  const decoded = execFileSync("/usr/bin/security", ["cms", "-D", "-i", profilePath], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const certificates = plistField(decoded, "DeveloperCertificates", "xml1");
  const profile = {
    expiration: plistField(decoded, "ExpirationDate", "raw"),
    platforms: plistField(decoded, "Platform"),
    teams: plistField(decoded, "TeamIdentifier"),
    prefixes: plistField(decoded, "ApplicationIdentifierPrefix"),
    entitlements: plistField(decoded, "Entitlements"),
    certificateHashes: [...certificates.matchAll(/<data>([\s\S]*?)<\/data>/g)].map((match) => sha256(Buffer.from(match[1].replace(/\s/g, ""), "base64"))),
    provisionsAllDevices: /<key>ProvisionsAllDevices<\/key>\s*<true\s*\/>/.test(decoded),
  };
  const info = readFileSync(path.join(appPath, "Contents", "Info.plist"));
  const scratch = mkdtempSync(path.join(tmpdir(), "openwork-signature-"));
  try {
    const prefix = path.join(scratch, "certificate");
    // Extracts only the public signing certificates; never exports private keys.
    execFileSync("/usr/bin/codesign", ["--display", `--extract-certificates=${prefix}`, appPath], { stdio: "pipe" });
    const leaf = readFileSync(`${prefix}0`);
    const certificateText = execFileSync("/usr/bin/openssl", ["x509", "-inform", "DER", "-noout", "-subject", "-nameopt", "sep_multiline"], {
      input: leaf, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    const signingTeam = certificateText.match(/^\s*OU\s*=\s*(\S+)\s*$/m)?.[1];
    validateProvisioning({
      entitlements, profile, signingTeam,
      bundleId: plistField(info, "CFBundleIdentifier", "raw"),
      certificateHash: sha256(leaf),
      developerId: /^\s*CN\s*=\s*Developer ID Application:/m.test(certificateText),
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

module.exports = { requestedProfileEntitlements, validateProvisioning, verifyAppProvisioning };
if (require.main === module) {
  if (process.platform !== "darwin" || process.argv.length !== 3) {
    console.error("Usage on macOS: node macos-provisioning.cjs /path/to/OpenWork.app");
    process.exitCode = 1;
  } else {
    verifyAppProvisioning(process.argv[2]);
    console.log("Passkey provisioning check passed.");
  }
}
