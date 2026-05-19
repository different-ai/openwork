// Rebuild node-pty against Electron's Node ABI so the OpenEral embedded
// terminal works.
//
// We've tried two approaches that don't survive pnpm workspaces on
// Windows:
//   - `electron-rebuild -w node-pty -f` walks the full node_modules
//     tree and trips on pnpm's .ignored_* junctions.
//   - Adding NODE_OPTIONS=--preserve-symlinks "fixes" the walk but
//     breaks electron-rebuild's own internal `import debug from "debug"`
//     because pnpm's transitive resolution depends on following symlinks.
//
// This script uses @electron/rebuild's programmatic API instead. The
// API's `onlyModules: ["node-pty"]` option scopes the rebuild to one
// package without walking the rest of node_modules, sidestepping both
// failure modes.
//
// Failure is loud (banner + retry command) but exits 0 so `pnpm install`
// always completes. OpenShell + OpenWork chat doesn't need node-pty;
// OpenEral does and will warn at runtime if the ABI is wrong.
//
// Opt out entirely with OPENWORK_SKIP_NATIVE_REBUILD=1 (CI, locked-down
// banker machines where the gyp toolchain isn't available).

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.OPENWORK_SKIP_NATIVE_REBUILD === "1") {
  console.log(
    "[postinstall] OPENWORK_SKIP_NATIVE_REBUILD=1 set; skipping rebuild. " +
      "OpenEral PTY will not work until node-pty is rebuilt manually.",
  );
  process.exit(0);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const require = createRequire(import.meta.url);

function printFailureBanner(detail) {
  console.warn("");
  console.warn("============================================================");
  console.warn("[postinstall] node-pty rebuild for Electron failed.");
  if (detail) console.warn(`  ${detail}`);
  console.warn("  OpenEral (embedded Claude Code terminal) will crash on");
  console.warn("  launch with NODE_MODULE_VERSION mismatch. OpenShell +");
  console.warn("  OpenWork chat profile is unaffected.");
  console.warn("");
  console.warn("  Retry manually:");
  console.warn("    pnpm --filter @openwork/desktop rebuild:native");
  console.warn("");
  console.warn("  Common causes on Windows:");
  console.warn("    - VS 2022 Build Tools + 'Desktop development with C++'");
  console.warn("      workload not installed (node-gyp needs MSVC).");
  console.warn("    - Python 3.x not on PATH.");
  console.warn("    - Corporate proxy blocking electronjs.org/headers.");
  console.warn("============================================================");
  console.warn("");
}

let electronVersion;
try {
  electronVersion = require("electron/package.json").version;
} catch (err) {
  printFailureBanner(`Could not resolve electron version: ${err.message}`);
  process.exit(0);
}

let rebuild;
try {
  ({ rebuild } = await import("@electron/rebuild"));
} catch (err) {
  printFailureBanner(`Could not load @electron/rebuild: ${err.message}`);
  process.exit(0);
}

console.log(
  `[postinstall] rebuilding node-pty for Electron ${electronVersion} ` +
    `(buildPath: ${desktopRoot})`,
);

try {
  await rebuild({
    buildPath: desktopRoot,
    electronVersion,
    onlyModules: ["node-pty"],
    force: true,
  });
  console.log("[postinstall] node-pty rebuilt successfully.");
  process.exit(0);
} catch (err) {
  printFailureBanner(err?.message ?? String(err));
  if (err?.stack) console.warn(err.stack);
  process.exit(0);
}
