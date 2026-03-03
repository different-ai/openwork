import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = new Set(process.argv.slice(2));

const isCI = args.has("--ci");
const requireOpencode = !args.has("--no-opencode");
const requireBun = args.has("--require-bun");
const requireRust = args.has("--require-rust");

const errors = [];
const warnings = [];
const checks = [];

function getVersion(command, versionArgs = ["--version"]) {
  try {
    return execFileSync(command, versionArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function addCheck(name, ok, detail) {
  checks.push({ name, ok, detail });
}

function parseMajor(version) {
  const major = Number.parseInt(version.split(".")[0], 10);
  return Number.isFinite(major) ? major : null;
}

const workspacePackage = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const expectedPnpm = workspacePackage.packageManager?.replace(/^pnpm@/, "") ?? "";

const nodeVersion = process.versions.node;
const nodeMajor = parseMajor(nodeVersion);
if (!nodeMajor || nodeMajor < 20) {
  errors.push(`Node.js >=20 is required (found ${nodeVersion}).`);
  addCheck("node", false, nodeVersion);
} else {
  addCheck("node", true, nodeVersion);
}

const pnpmVersion = getVersion("pnpm");
if (!pnpmVersion) {
  errors.push("pnpm is required but was not found in PATH.");
  addCheck("pnpm", false, "missing");
} else {
  addCheck("pnpm", true, pnpmVersion);
  if (expectedPnpm && pnpmVersion !== expectedPnpm) {
    warnings.push(
      `pnpm version mismatch: expected ${expectedPnpm} from packageManager, found ${pnpmVersion}.`,
    );
  }
}

const opencodeVersion = getVersion("opencode");
if (requireOpencode) {
  if (!opencodeVersion) {
    errors.push("opencode CLI is required for verify but was not found in PATH.");
    addCheck("opencode", false, "missing");
  } else {
    addCheck("opencode", true, opencodeVersion);
  }
} else {
  addCheck("opencode", Boolean(opencodeVersion), opencodeVersion ?? "skipped");
}

const bunVersion = getVersion("bun", ["--version"]);
if (requireBun) {
  if (!bunVersion) {
    errors.push("bun is required for this workflow but was not found in PATH.");
    addCheck("bun", false, "missing");
  } else {
    addCheck("bun", true, bunVersion);
  }
} else {
  addCheck("bun", Boolean(bunVersion), bunVersion ?? "optional");
}

const rustcVersion = getVersion("rustc", ["--version"]);
const cargoVersion = getVersion("cargo", ["--version"]);
if (requireRust) {
  if (!rustcVersion || !cargoVersion) {
    errors.push("Rust toolchain is required for this workflow but rustc/cargo were not found.");
    addCheck("rust", false, "missing");
  } else {
    addCheck("rust", true, `${rustcVersion}; ${cargoVersion}`);
  }
} else {
  addCheck("rust", Boolean(rustcVersion && cargoVersion), "optional");
}

console.log(`[verify:preflight] mode=${isCI ? "ci" : "local"}`);
for (const check of checks) {
  const status = check.ok ? "ok" : "missing";
  console.log(`[verify:preflight] ${status} ${check.name}: ${check.detail}`);
}

for (const warning of warnings) {
  console.warn(`[verify:preflight] warning: ${warning}`);
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[verify:preflight] error: ${error}`);
  }
  process.exit(1);
}

console.log("[verify:preflight] all required dependencies are available.");
