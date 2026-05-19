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
import { createRequire } from "node:module";
import { dirname } from "node:path";

if (process.env.OPENWORK_SKIP_NATIVE_REBUILD === "1") {
  console.log(
    "[postinstall] OPENWORK_SKIP_NATIVE_REBUILD=1 set; skipping electron-rebuild. " +
      "OpenEral PTY will not work until you rebuild node-pty manually.",
  );
  process.exit(0);
}

const require = createRequire(import.meta.url);

let modulePath;
try {
  modulePath = dirname(require.resolve("node-pty/package.json"));
} catch (err) {
  console.warn(
    "[postinstall] node-pty not resolvable; skipping rebuild. " +
      "OpenEral PTY support will be broken until it is rebuilt manually.",
  );
  console.warn(`  reason: ${err.message}`);
  process.exit(0);
}

const cmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const env = {
  ...process.env,
  // Stops electron-rebuild's directory walk from following pnpm's
  // workspace symlinks into .pnpm/.ignored_* junctions. Without this
  // flag the rebuild crashes on Windows pnpm workspaces.
  NODE_OPTIONS: [process.env.NODE_OPTIONS, "--preserve-symlinks"]
    .filter(Boolean)
    .join(" "),
};

const result = spawnSync(
  cmd,
  [
    "exec",
    "electron-rebuild",
    "-f",
    "-w",
    "node-pty",
    "--module-dir",
    modulePath,
  ],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
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
