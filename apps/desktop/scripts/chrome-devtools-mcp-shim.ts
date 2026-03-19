#!/usr/bin/env node
import { spawn } from "node:child_process";

const packageSpec =
  process.env.OPENWORK_CHROME_DEVTOOLS_MCP_SPEC?.trim() ||
  process.env.CHROME_DEVTOOLS_MCP_SPEC?.trim() ||
  "chrome-devtools-mcp@0.17.0";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const args = ["exec", "--yes", packageSpec, "--", ...process.argv.slice(2)];

const child = spawn(npmCommand, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    npm_config_yes: "true",
  },
});

child.on("error", (error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ENOENT")) {
    console.error(
      "Control Chrome requires npm (Node.js). Install Node.js or configure mcp.chrome-devtools.command to a local chrome-devtools-mcp binary."
    );
  } else {
    console.error(`Failed to start chrome-devtools-mcp via npm exec: ${message}`);
  }
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
