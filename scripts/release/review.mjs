import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);
const outputJson = args.includes("--json");
const strict = args.includes("--strict");

/**
 * Versions live in git tags, not files: every committed package.json must hold
 * the permanent dev placeholder. CI stamps the real version into the workspace
 * at build time (scripts/release/stamp-version.mjs). This review guards against
 * accidentally re-introducing committed release versions.
 */
export const VERSION_PLACEHOLDER = "0.0.0-dev";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const appPkg = readJson(resolve(root, "apps", "app", "package.json"));
const desktopPkg = readJson(resolve(root, "apps", "desktop", "package.json"));
const serverPkg = readJson(resolve(root, "apps", "server", "package.json"));
const pinnedOpencodeVersion = String(
  readJson(resolve(root, "constants.json")).opencodeV2Version ?? "",
).trim();

const versions = {
  app: appPkg.version ?? null,
  desktop: desktopPkg.version ?? null,
  server: serverPkg.version ?? null,
  opencode: pinnedOpencodeVersion || null,
};

const checks = [];
const warnings = [];
let ok = true;

const addCheck = (label, pass, details) => {
  checks.push({ label, ok: pass, details });
  if (!pass) ok = false;
};

const addWarning = (message) => warnings.push(message);

for (const [name, version] of [
  ["app", versions.app],
  ["desktop", versions.desktop],
  ["openwork-server", versions.server],
]) {
  addCheck(
    `${name} package.json holds the dev placeholder`,
    version === VERSION_PLACEHOLDER,
    `${version ?? "?"} (expected ${VERSION_PLACEHOLDER}; releases stamp versions in CI from the tag)`,
  );
}

if (versions.opencode) {
  addCheck("OpenCode version pin exists", true, String(versions.opencode));
} else {
  addWarning("OpenCode version is not pinned in constants.json.");
}

const report = { ok, versions, checks, warnings };

if (outputJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("Release review");
  for (const check of checks) {
    const status = check.ok ? "ok" : "fail";
    console.log(`- ${status}: ${check.label} (${check.details})`);
  }
  if (warnings.length) {
    console.log("Warnings:");
    for (const warning of warnings) {
      console.log(`- ${warning}`);
    }
  }
}

if (strict && !ok) {
  process.exit(1);
}
