#!/usr/bin/env node
// Post-migration cleanup. Run this ONLY after v0.12.x has been stable
// for ~1-2 weeks and telemetry confirms users have rolled over to the
// Electron build. Irreversible (well, revertible via git, but not
// trivial to redeploy the Tauri path after removing it).
//
// Usage:
//   node scripts/migration/03-post-migration-cleanup.mjs --dry-run   # default
//   node scripts/migration/03-post-migration-cleanup.mjs --execute   # actually do it

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

function parseArgs(argv) {
  // Default is dry-run for safety; --execute required to actually do it.
  const out = { dryRun: true };
  for (const arg of argv) {
    if (arg === "--execute") out.dryRun = false;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else {
      console.error(`unknown arg: ${arg}`);
      process.exit(2);
    }
  }
  return out;
}

function log(msg) {
  console.log(`[cleanup] ${msg}`);
}

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(" ")}`);
  if (opts.dryRun) return "";
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`[cleanup] command failed: ${cmd}`);
    process.exit(1);
  }
}

async function patchJson(path, updater, { dryRun }) {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);
  const next = updater(parsed);
  if (JSON.stringify(parsed) === JSON.stringify(next)) {
    log(`no change needed: ${path}`);
    return;
  }
  log(`patching: ${path}`);
  if (!dryRun) {
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }
}

async function replaceInFile(path, replacements, { dryRun }) {
  if (!existsSync(path)) return;
  const original = await readFile(path, "utf8");
  let next = original;
  for (const [pattern, replacement] of replacements) {
    next = next.replace(pattern, replacement);
  }
  if (next === original) return;
  log(`rewriting: ${path}`);
  if (!dryRun) {
    await writeFile(path, next, "utf8");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        "Post-migration cleanup (Tauri → Electron).",
        "",
        "Runs in dry-run mode by default. Pass --execute to actually change files.",
      ].join("\n"),
    );
    return;
  }

  if (args.dryRun) {
    log("DRY RUN — no filesystem changes. Pass --execute to apply.");
  }

  // 1. Flip apps/desktop/package.json defaults to Electron.
  const desktopPkgPath = resolve(repoRoot, "apps/desktop/package.json");
  await patchJson(
    desktopPkgPath,
    (pkg) => {
      const scripts = { ...(pkg.scripts ?? {}) };
      scripts.dev = "node ./scripts/electron-dev.mjs";
      scripts.build = "node ./scripts/electron-build.mjs";
      scripts.package =
        "pnpm run build && pnpm exec electron-builder --config electron-builder.yml";
      scripts["dev:electron"] = undefined;
      scripts["build:electron"] = undefined;
      scripts["package:electron"] = undefined;
      scripts["package:electron:dir"] =
        "pnpm run build && pnpm exec electron-builder --config electron-builder.yml --dir";
      scripts.electron = undefined;
      scripts["dev:react-session"] = undefined;
      scripts["dev:electron:react-session"] =
        "VITE_OPENWORK_REACT_SESSION=1 node ./scripts/electron-dev.mjs";
      // Remove Tauri-specific script entries.
      scripts["build:debug:react-session"] = undefined;
      scripts["dev:windows"] = undefined;
      scripts["dev:windows:x64"] = undefined;

      const filteredScripts = Object.fromEntries(
        Object.entries(scripts).filter(([, v]) => v != null),
      );
      const devDeps = { ...(pkg.devDependencies ?? {}) };
      delete devDeps["@tauri-apps/cli"];
      return { ...pkg, scripts: filteredScripts, devDependencies: devDeps };
    },
    { dryRun: args.dryRun },
  );

  // 2. Strip @tauri-apps/* from apps/app and apps/story-book package.json.
  for (const pkgPath of [
    resolve(repoRoot, "apps/app/package.json"),
    resolve(repoRoot, "apps/story-book/package.json"),
  ]) {
    if (!existsSync(pkgPath)) continue;
    await patchJson(
      pkgPath,
      (pkg) => {
        const deps = { ...(pkg.dependencies ?? {}) };
        const devDeps = { ...(pkg.devDependencies ?? {}) };
        for (const name of Object.keys(deps)) {
          if (name.startsWith("@tauri-apps/")) delete deps[name];
        }
        for (const name of Object.keys(devDeps)) {
          if (name.startsWith("@tauri-apps/")) delete devDeps[name];
        }
        return { ...pkg, dependencies: deps, devDependencies: devDeps };
      },
      { dryRun: args.dryRun },
    );
  }

  // 3. Delete src-tauri/ entirely.
  run("git", ["rm", "-r", "-f", "apps/desktop/src-tauri"], { dryRun: args.dryRun });

  // 4. Collapse desktop-tauri.ts into desktop.ts. We do a surgical rename
  //    for now and leave the collapse for a follow-up PR; deleting the
  //    proxy layer is a bigger refactor.
  log(
    "[reminder] apps/app/src/app/lib/desktop-tauri.ts still exists. After this script lands,",
  );
  log(
    "           open a follow-up PR that inlines desktop.ts's Electron path and removes the",
  );
  log("           proxy + re-export surface.");

  // 5. Drop AGENTS.md / ARCHITECTURE.md / README.md Tauri references.
  const docReplacements = [
    [/Tauri 2\.x/g, "Electron"],
    [/\| Desktop\/Mobile shell \| Tauri 2\.x\s+\|/g, "| Desktop/Mobile shell | Electron |"],
    [/apps\/desktop\/src-tauri/g, "apps/desktop/electron"],
  ];
  for (const path of [
    resolve(repoRoot, "AGENTS.md"),
    resolve(repoRoot, "ARCHITECTURE.md"),
    resolve(repoRoot, "README.md"),
  ]) {
    await replaceInFile(path, docReplacements, { dryRun: args.dryRun });
  }

  // 6. Remove the migration-release env fragment once it's no longer
  //    relevant.
  run("git", ["rm", "-f", "apps/app/.env.migration-release"], {
    dryRun: args.dryRun,
  });

  // 7. Stage + commit.
  run("git", ["add", "-A"], { dryRun: args.dryRun });
  run(
    "git",
    [
      "commit",
      "-m",
      "chore(desktop): remove Tauri shell, make Electron the default\n\nRun after v0.12.x stabilized in the wild. See\nscripts/migration/README.md for the full runbook.",
    ],
    { dryRun: args.dryRun },
  );

  log("");
  log(
    args.dryRun
      ? "dry run complete. rerun with --execute to apply."
      : "commit created. push + open PR for review.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
