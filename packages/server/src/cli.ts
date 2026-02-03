#!/usr/bin/env bun

import { parseCliArgs, printHelp, resolveServerConfig } from "./config.js";
import { startServer } from "./server.js";
import pkg from "../package.json" with { type: "json" };

const args = parseCliArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

if (args.version) {
  console.log(pkg.version);
  process.exit(0);
}

const config = await resolveServerConfig(args);
const server = startServer(config);

const url = `http://${config.host}:${server.port}`;
console.log(`OpenWork server listening on ${url}`);

if (config.tokenSource === "generated") {
  console.log(`Client token: ${config.token}`);
}

if (config.hostTokenSource === "generated") {
  console.log(`Host token: ${config.hostToken}`);
}

if (config.workspaces.length === 0) {
  console.log("No workspaces configured. Add --workspace or update server.json.");
} else {
  console.log(`Workspaces: ${config.workspaces.length}`);
}

if (args.verbose) {
  console.log(`Config path: ${config.configPath ?? "unknown"}`);
  console.log(`Read-only: ${config.readOnly ? "true" : "false"}`);
  console.log(`Approval: ${config.approval.mode} (${config.approval.timeoutMs}ms)`);
  console.log(`CORS origins: ${config.corsOrigins.join(", ")}`);
  console.log(`Authorized roots: ${config.authorizedRoots.join(", ")}`);
  console.log(`Token source: ${config.tokenSource}`);
  console.log(`Host token source: ${config.hostTokenSource}`);
}
