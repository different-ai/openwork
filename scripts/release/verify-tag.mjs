import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);
const tagIndex = args.indexOf("--tag");
const tagArg = tagIndex >= 0 ? args[tagIndex + 1] : null;
const tag = (tagArg || process.env.RELEASE_TAG || "").trim();

if (!tag) {
  console.error("Release tag missing. Provide --tag or set RELEASE_TAG.");
  process.exit(1);
}

const version = tag.startsWith("v") ? tag.slice(1) : tag;

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readText = (path) => readFileSync(path, "utf8");

const readCargoVersion = (path) => {
  const content = readText(path);
  const match = content.match(/^version\s*=\s*"([^"]+)"/m);
  return match ? match[1] : null;
};

const appVersion = readJson(resolve(root, "packages", "app", "package.json")).version ?? null;
const desktopVersion = readJson(resolve(root, "packages", "desktop", "package.json")).version ?? null;
const orchestratorVersion =
  readJson(resolve(root, "packages", "orchestrator", "package.json")).version ?? null;
const serverVersion = readJson(resolve(root, "packages", "server", "package.json")).version ?? null;
const opencodeRouterVersion = readJson(resolve(root, "packages", "opencode-router", "package.json")).version ?? null;
const tauriVersion = readJson(resolve(root, "packages", "desktop", "src-tauri", "tauri.conf.json")).version ?? null;
const cargoVersion = readCargoVersion(resolve(root, "packages", "desktop", "src-tauri", "Cargo.toml"));

const mismatches = [];
const check = (label, actual) => {
  if (!actual) {
    mismatches.push(`${label} missing`);
    return;
  }
  if (actual !== version) {
    mismatches.push(`${label}=${actual} (expected ${version})`);
  }
};

check("app", appVersion);
check("desktop", desktopVersion);
check("openwork-orchestrator", orchestratorVersion);
check("openwork-server", serverVersion);
check("opencode-router", opencodeRouterVersion);
check("tauri", tauriVersion);
check("cargo", cargoVersion);

if (mismatches.length) {
  console.error(`Release tag ${tag} does not match package versions:`);
  for (const mismatch of mismatches) {
    console.error(`- ${mismatch}`);
  }
  process.exit(1);
}

console.log(`Release tag ${tag} matches app/desktop/openwork-orchestrator versions.`);
