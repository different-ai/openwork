#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
function pnpm(args) {
  // pnpm supplies its JS entry point, avoiding .cmd invocation on Windows.
  const entry = process.env.npm_execpath;
  execFileSync(entry ? process.execPath : "pnpm", entry ? [entry, ...args] : args, { cwd: root, stdio: "inherit" });
}

pnpm(["--filter", "@openwork/mcp-apps", "build"]);
pnpm(["api:snapshot"]);
pnpm(["--filter", "@openwork/sdk", "generate", "--input", fileURLToPath(new URL("../packages/docs/openapi.json", import.meta.url))]);
