#!/usr/bin/env node
/**
 * Chrome DevTools MCP shim — resolves the bundled `chrome-devtools-mcp`
 * dependency and runs it directly via Node, eliminating the runtime
 * dependency on npm/npx.
 *
 * Fallback: if the bundled package cannot be found (e.g. standalone
 * sidecar without node_modules), falls back to `npm exec` like before.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const packageSpec =
  process.env.OPENWORK_CHROME_DEVTOOLS_MCP_SPEC?.trim() ||
  process.env.CHROME_DEVTOOLS_MCP_SPEC?.trim() ||
  "chrome-devtools-mcp@0.17.0";

function resolveBundledBin(): string | null {
  try {
    const require_ = createRequire(import.meta.url);
    const pkgJsonPath = require_.resolve("chrome-devtools-mcp/package.json");
    const binPath = join(dirname(pkgJsonPath), "build", "src", "index.js");
    if (existsSync(binPath)) return binPath;
  } catch { /* not found */ }
  return null;
}

const bundledBin = resolveBundledBin();

let child: ReturnType<typeof spawn>;

if (bundledBin) {
  child = spawn(process.execPath, [bundledBin, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
  });
} else {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["exec", "--yes", packageSpec, "--", ...process.argv.slice(2)];
  child = spawn(npmCommand, args, {
    stdio: "inherit",
    env: { ...process.env, npm_config_yes: "true" },
  });
}

child.on("error", (error: Error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ENOENT")) {
    console.error(
      "Control Chrome requires Node.js. Install Node.js or configure mcp.chrome-devtools.command to a local chrome-devtools-mcp binary."
    );
  } else {
    console.error(`Failed to start chrome-devtools-mcp: ${message}`);
  }
  process.exit(1);
});

child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
  if (signal) { process.kill(process.pid, signal); return; }
  process.exit(code ?? 1);
});
