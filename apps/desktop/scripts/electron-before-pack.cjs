const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const baseEntitlements = path.resolve(__dirname, "../build/entitlements.mac.plist");
const generatedEntitlements = path.resolve(__dirname, "../build/entitlements.mac.generated.plist");

function signingTeamId({ identity, identities }) {
  if (identity === "-") return null;
  const candidates = identities.split("\n")
    .map((line) => line.match(/"([^"]+ \(([A-Z0-9]{10})\))"/))
    .filter(Boolean);
  const selected = identity
    ? candidates.filter((match) => match[1] === identity || match[1].includes(identity))
    : candidates;
  const teamIds = [...new Set(selected.map((match) => match[2]))];
  if (teamIds.length > 1) throw new Error("Multiple Apple signing teams found. Set CSC_NAME to select one.");
  return teamIds[0] ?? null;
}

function teamIdFromSigningCertificate(link, password) {
  if (!link || !/^[A-Za-z0-9+/=\s]+$/.test(link)) return null;
  const p12 = Buffer.from(link.replace(/\s/g, ""), "base64");
  if (!p12.length) return null;
  const certificate = spawnSync("openssl", ["pkcs12", "-clcerts", "-nokeys", "-passin", "env:CSC_KEY_PASSWORD"], {
    input: p12, encoding: "utf8", env: { ...process.env, CSC_KEY_PASSWORD: password || "" },
  });
  if (certificate.status !== 0) return null;
  const subject = spawnSync("openssl", ["x509", "-noout", "-subject"], { input: certificate.stdout, encoding: "utf8" });
  return subject.status === 0 ? teamIdFromSubject(subject.stdout) : null;
}

function teamIdFromSubject(subject) {
  return subject.match(/(?:^|[,/])\s*OU\s*=\s*([A-Z0-9]{10})(?:\s*[,/]|\s*$)/)?.[1] ?? null;
}

function entitlementsForTeam(base, teamId, appId) {
  if (!teamId) return base;
  if (!/^[A-Z0-9]{10}$/.test(teamId) || !/^[a-zA-Z0-9.-]+$/.test(appId)) {
    throw new Error("Invalid Apple signing team or app identifier for WebAuthn.");
  }
  const group = `${teamId}.${appId}.webauthn`;
  return base.replace("</dict>", `  <key>keychain-access-groups</key>\n  <array>\n    <string>${group}</string>\n  </array>\n</dict>`);
}

async function beforePack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const identity = process.env.CSC_NAME || context.packager.config.mac?.identity || null;
  const result = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
  if (result.error) throw result.error;
  const teamId = teamIdFromSigningCertificate(process.env.CSC_LINK, process.env.CSC_KEY_PASSWORD)
    || signingTeamId({ identity, identities: result.stdout || "" });
  if (!teamId && process.env.CSC_LINK) {
    throw new Error("Apple signing certificate is present, but its Team ID could not be resolved for WebAuthn.");
  }
  const appId = context.packager.appInfo.id;
  const base = fs.readFileSync(baseEntitlements, "utf8");
  fs.writeFileSync(generatedEntitlements, entitlementsForTeam(base, teamId, appId));
  console.log(`[electron-before-pack] WebAuthn entitlement prepared (${teamId ? "signed" : "unsigned"} build).`);
}

module.exports = beforePack;
module.exports.signingTeamId = signingTeamId;
module.exports.entitlementsForTeam = entitlementsForTeam;
module.exports.teamIdFromSigningCertificate = teamIdFromSigningCertificate;
module.exports.teamIdFromSubject = teamIdFromSubject;
