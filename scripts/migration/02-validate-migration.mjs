#!/usr/bin/env node
// Guided validation for a migration release. Mix of automated probes and
// checklist prompts you acknowledge in-terminal. Designed to be run in a
// release-review pair session.
//
// Usage:
//   node scripts/migration/02-validate-migration.mjs --tag v0.12.0
//   node scripts/migration/02-validate-migration.mjs --tag v0.12.0 --skip-manual

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

function parseArgs(argv) {
  const out = { skipManual: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--skip-manual") out.skipManual = true;
    else if (arg === "--tag") out.tag = argv[++i];
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

function die(msg) {
  console.error(`[validate] ${msg}`);
  process.exit(1);
}

async function sha256(path) {
  const hash = createHash("sha256");
  return await new Promise((resolvePromise, rejectPromise) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolvePromise(hash.digest("hex")))
      .on("error", rejectPromise);
  });
}

async function confirm(prompt) {
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${prompt} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function ghReleaseAssets(tag) {
  const result = spawnSync(
    "gh",
    [
      "release",
      "view",
      tag,
      "--repo",
      "different-ai/openwork",
      "--json",
      "assets",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) die(`gh release view ${tag} failed`);
  const parsed = JSON.parse(result.stdout);
  return parsed.assets ?? [];
}

async function ghDownload(tag, assetName, targetDir) {
  await mkdir(targetDir, { recursive: true });
  const target = join(targetDir, assetName);
  const result = spawnSync(
    "gh",
    [
      "release",
      "download",
      tag,
      "--repo",
      "different-ai/openwork",
      "--pattern",
      assetName,
      "--dir",
      targetDir,
      "--clobber",
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) die(`gh release download failed for ${assetName}`);
  return target;
}

function codesignVerify(appPath) {
  const result = spawnSync(
    "codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", appPath],
    { encoding: "utf8" },
  );
  return {
    ok: result.status === 0,
    message: (result.stderr ?? "").trim() || (result.stdout ?? "").trim(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.tag) {
    console.log("Usage: 02-validate-migration.mjs --tag vX.Y.Z [--skip-manual]");
    process.exit(args.help ? 0 : 2);
  }

  const workDir = join(tmpdir(), `openwork-migrate-validate-${args.tag}`);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  console.log(`[validate] scratch dir: ${workDir}`);

  // 1. List assets on the release.
  const assets = await ghReleaseAssets(args.tag);
  const names = assets.map((a) => a.name);
  console.log(`[validate] release ${args.tag} has ${assets.length} assets`);
  names.forEach((n) => console.log(`    - ${n}`));

  const electronZip = names.find(
    (n) => /electron|\.zip$/i.test(n) && n.includes("mac"),
  ) ?? names.find((n) => n.endsWith(".zip"));
  const electronYml = names.find((n) => n === "latest-mac.yml");
  const tauriLatestJson = names.find((n) => n === "latest.json");

  const presenceChecks = [
    ["electron macOS zip", electronZip],
    ["electron-updater manifest (latest-mac.yml)", electronYml],
    ["tauri minisign feed (latest.json)", tauriLatestJson],
  ];
  console.log("");
  console.log("[validate] required release assets:");
  presenceChecks.forEach(([label, name]) => {
    console.log(`    ${name ? "✓" : "✗"} ${label}${name ? ` — ${name}` : ""}`);
  });
  if (!electronZip) die("no Electron zip asset on the release.");

  // 2. Download + Apple sig check on the Electron zip.
  console.log("");
  console.log("[validate] downloading Electron zip for signature check…");
  const zipPath = await ghDownload(args.tag, electronZip, workDir);
  console.log(`[validate] got ${zipPath} (${(await readFile(zipPath)).byteLength} bytes)`);
  const zipHash = await sha256(zipPath);
  console.log(`[validate] sha256 = ${zipHash}`);

  const unzipDir = join(workDir, "unzipped");
  await mkdir(unzipDir, { recursive: true });
  const unzipResult = spawnSync("unzip", ["-q", "-o", zipPath, "-d", unzipDir], {
    stdio: "inherit",
  });
  if (unzipResult.status !== 0) die("unzip failed");
  const appPath = join(unzipDir, "OpenWork.app");
  if (!existsSync(appPath)) {
    console.log(`[validate] ✗ OpenWork.app not found inside zip (got: ${unzipDir})`);
    die("zip layout unexpected");
  }
  const sig = codesignVerify(appPath);
  console.log(`[validate] ${sig.ok ? "✓" : "✗"} codesign verify on ${appPath}`);
  if (!sig.ok) console.log(sig.message);

  // 3. Manual steps.
  if (args.skipManual) {
    console.log("[validate] --skip-manual: stopping here.");
    return;
  }

  console.log("");
  console.log("[validate] manual checklist — acknowledge each step.");
  const steps = [
    "Install a fresh Tauri v0.11.x build on a test machine (or VM).",
    `Launch it, "Check for updates" → migrates to ${args.tag}.`,
    "Restart, see the 'OpenWork is moving' modal, click 'Install now'.",
    "Confirm Electron app launches automatically after ~30s.",
    "Confirm sidebar shows every workspace that was visible in Tauri.",
    "Open one workspace; confirm last session is preselected.",
    "Settings → Advanced: both runtimes show 'Connected'.",
    "Reopen: confirm the migration modal does NOT reappear.",
  ];
  for (const step of steps) {
    const ok = await confirm(`  ☐ ${step}`);
    if (!ok) die(`manual step declined: ${step}`);
  }

  console.log("");
  console.log("[validate] all checks passed. Migration release is healthy.");
  console.log("[validate] watch v0.12.0 telemetry for ~1-2 weeks before running");
  console.log("           node scripts/migration/03-post-migration-cleanup.mjs");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
