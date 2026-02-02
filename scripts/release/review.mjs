import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);
const outputJson = args.includes("--json");
const strict = args.includes("--strict");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readText = (path) => readFileSync(path, "utf8");

const readCargoVersion = (path) => {
  const content = readText(path);
  const match = content.match(/^version\s*=\s*"([^"]+)"/m);
  return match ? match[1] : null;
};

const appPkg = readJson(resolve(root, "packages", "app", "package.json"));
const desktopPkg = readJson(resolve(root, "packages", "desktop", "package.json"));
const headlessPkg = readJson(resolve(root, "packages", "headless", "package.json"));
const serverPkg = readJson(resolve(root, "packages", "server", "package.json"));
const owpenbotPkg = readJson(resolve(root, "packages", "owpenbot", "package.json"));
const tauriConfig = readJson(resolve(root, "packages", "desktop", "src-tauri", "tauri.conf.json"));
const cargoVersion = readCargoVersion(resolve(root, "packages", "desktop", "src-tauri", "Cargo.toml"));

const versions = {
  app: appPkg.version ?? null,
  desktop: desktopPkg.version ?? null,
  tauri: tauriConfig.version ?? null,
  cargo: cargoVersion ?? null,
  server: serverPkg.version ?? null,
  headless: headlessPkg.version ?? null,
  owpenbot: owpenbotPkg.version ?? null,
  opencode: {
    desktop: desktopPkg.opencodeVersion ?? null,
    headless: headlessPkg.opencodeVersion ?? null,
  },
  owpenbotVersionPinned: desktopPkg.owpenbotVersion ?? null,
  headlessOpenworkServerRange: headlessPkg.dependencies?.["openwork-server"] ?? null,
};

const checks = [];
const warnings = [];
let ok = true;

const addCheck = (label, pass, details) => {
  checks.push({ label, ok: pass, details });
  if (!pass) ok = false;
};

const addWarning = (message) => warnings.push(message);

addCheck(
  "App/desktop versions match",
  versions.app && versions.desktop && versions.app === versions.desktop,
  `${versions.app ?? "?"} vs ${versions.desktop ?? "?"}`,
);
addCheck(
  "Desktop/Tauri versions match",
  versions.desktop && versions.tauri && versions.desktop === versions.tauri,
  `${versions.desktop ?? "?"} vs ${versions.tauri ?? "?"}`,
);
addCheck(
  "Desktop/Cargo versions match",
  versions.desktop && versions.cargo && versions.desktop === versions.cargo,
  `${versions.desktop ?? "?"} vs ${versions.cargo ?? "?"}`,
);
addCheck(
  "Owpenbot version pinned in desktop",
  versions.owpenbot && versions.owpenbotVersionPinned && versions.owpenbot === versions.owpenbotVersionPinned,
  `${versions.owpenbotVersionPinned ?? "?"} vs ${versions.owpenbot ?? "?"}`,
);
addCheck(
  "OpenCode version matches (desktop/headless)",
  versions.opencode.desktop && versions.opencode.headless && versions.opencode.desktop === versions.opencode.headless,
  `${versions.opencode.desktop ?? "?"} vs ${versions.opencode.headless ?? "?"}`,
);

const openworkServerRange = versions.headlessOpenworkServerRange ?? "";
const openworkServerPinned = /^\d+\.\d+\.\d+/.test(openworkServerRange);
if (!openworkServerRange) {
  addWarning("openwrk is missing an openwork-server dependency.");
} else if (!openworkServerPinned) {
  addWarning(`openwrk openwork-server dependency is not pinned (${openworkServerRange}).`);
} else {
  addCheck(
    "Openwork-server dependency matches server version",
    versions.server && openworkServerRange === versions.server,
    `${openworkServerRange} vs ${versions.server ?? "?"}`,
  );
}

const sidecarManifestPath = resolve(root, "packages", "headless", "dist", "sidecars", "openwrk-sidecars.json");
if (existsSync(sidecarManifestPath)) {
  const manifest = readJson(sidecarManifestPath);
  addCheck(
    "Sidecar manifest version matches openwrk",
    versions.headless && manifest.version === versions.headless,
    `${manifest.version ?? "?"} vs ${versions.headless ?? "?"}`,
  );
  const serverEntry = manifest.entries?.["openwork-server"]?.version;
  const owpenbotEntry = manifest.entries?.owpenbot?.version;
  if (serverEntry) {
    addCheck(
      "Sidecar manifest openwork-server version matches",
      versions.server && serverEntry === versions.server,
      `${serverEntry ?? "?"} vs ${versions.server ?? "?"}`,
    );
  }
  if (owpenbotEntry) {
    addCheck(
      "Sidecar manifest owpenbot version matches",
      versions.owpenbot && owpenbotEntry === versions.owpenbot,
      `${owpenbotEntry ?? "?"} vs ${versions.owpenbot ?? "?"}`,
    );
  }
} else {
  addWarning("Sidecar manifest missing (run pnpm --filter openwrk build:sidecars).");
}

if (!process.env.SOURCE_DATE_EPOCH) {
  addWarning("SOURCE_DATE_EPOCH is not set (sidecar manifests will include current time).");
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
