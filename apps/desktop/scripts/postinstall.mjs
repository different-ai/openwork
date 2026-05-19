// Rebuild node-pty against Electron's Node ABI so the OpenEral embedded
// terminal works.
//
// The blunt `electron-rebuild -w node-pty -f` invocation we used to call
// from package.json walks the entire node_modules tree, which trips
// over pnpm's .ignored_* junctions on Windows workspaces and fails the
// whole install. The fix is two-pronged:
//   1. NODE_OPTIONS=--preserve-symlinks — keeps Node from following pnpm
//      symlinks into siblings (the actual cause of the .ignored_* trip).
//   2. --module-dir pointed at node-pty's resolved location — narrows
//      the scan to one directory instead of the whole hoisted graph.
//
// Failure is loud (banner + clear retry command) but non-fatal — a
// broken postinstall blocked every other flow before, and OpenShell +
// OpenWork chat profile doesn't need node-pty. OpenEral users see the
// warning and rerun.
//
// Opt out entirely with OPENWORK_SKIP_NATIVE_REBUILD=1 (CI, locked-down
// banker machines where electron-rebuild can't run).

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.OPENWORK_SKIP_NATIVE_REBUILD === "1") {
  console.log(
    "[postinstall] OPENWORK_SKIP_NATIVE_REBUILD=1 set; skipping electron-rebuild. " +
      "OpenEral PTY will not work until you rebuild node-pty manually.",
  );
  process.exit(0);
}

// electron-rebuild's --module-dir wants the directory that *contains*
// node_modules/, not the package dir itself. From the desktop package
// root, that's just "." — but we resolve absolutely so the script
// works regardless of CWD (e.g. when invoked from the repo root).
const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");

const cmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const env = {
  ...process.env,
  // Stops the directory walk from following pnpm's workspace symlinks
  // into .pnpm/.ignored_* sibling junctions. Without this the rebuild
  // crashes on Windows pnpm workspaces. --preserve-symlinks-main is the
  // companion flag for ESM entry points.
  NODE_OPTIONS: [
    process.env.NODE_OPTIONS,
    "--preserve-symlinks",
    "--preserve-symlinks-main",
  ]
    .filter(Boolean)
    .join(" "),
};

console.log(
  "[postinstall] rebuilding node-pty against Electron ABI " +
    `(module-dir: ${desktopRoot})`,
);

const result = spawnSync(
  cmd,
  [
    "exec",
    "electron-rebuild",
    "-f",
    "-w",
    "node-pty",
    "--module-dir",
    desktopRoot,
  ],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
    cwd: desktopRoot,
    env,
  },
);

if (result.status !== 0) {
  console.warn("");
  console.warn(
    "============================================================",
  );
  console.warn(
    "[postinstall] electron-rebuild failed for node-pty.",
  );
  console.warn(
    "  OpenEral (embedded Claude Code terminal) will crash on launch",
  );
  console.warn(
    "  with NODE_MODULE_VERSION mismatch. OpenShell + OpenWork chat",
  );
  console.warn("  profile is unaffected.");
  console.warn("");
  console.warn("  Retry manually:");
  console.warn("    pnpm --filter @openwork/desktop rebuild:native");
  console.warn(
    "============================================================",
  );
  console.warn("");
}

process.exit(0);
