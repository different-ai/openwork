#!/usr/bin/env bun

import { parseCliArgs, printHelp, resolveServerConfig } from "./config.js";
import { startServer } from "./server.js";

const args = parseCliArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
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
