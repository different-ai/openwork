#!/usr/bin/env bun

import { parseCliArgs, printHelp, resolveServerConfig } from "./config.js";
import { createManagedOpencodeServer, type ManagedOpencodeServer } from "./managed-opencode.js";
import { createServerLogger, startServer } from "./server.js";
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
const logger = createServerLogger(config);
let managedOpencode: ManagedOpencodeServer | null = null;

if (!config.opencodeBaseUrl && process.env.OPENWORK_MANAGE_OPENCODE === "1") {
  const workspace = config.workspaces[0];
  if (workspace?.path) {
    managedOpencode = await createManagedOpencodeServer({
      bin: process.env.OPENWORK_OPENCODE_BIN,
      cwd: workspace.path,
      env: {
        ...(process.env.OPENWORK_DEV_MODE ? { OPENWORK_DEV_MODE: process.env.OPENWORK_DEV_MODE } : {}),
      },
    });
    config.opencodeBaseUrl = managedOpencode.url;
    config.opencodeUsername = managedOpencode.username;
    config.opencodePassword = managedOpencode.password;
    for (const entry of config.workspaces) {
      entry.baseUrl ??= managedOpencode.url;
      entry.opencodeUsername ??= managedOpencode.username;
      entry.opencodePassword ??= managedOpencode.password;
      entry.directory ??= entry.path;
    }
    logger.log("info", `Managed OpenCode listening on ${managedOpencode.url}`);
  }
}

const server = startServer(config);

const url = `http://${config.host}:${server.port}`;
logger.log("info", `OpenWork server listening on ${url}`);

if (config.tokenSource === "generated") {
  logger.log("info", `Client token: ${config.token}`);
}

if (config.hostTokenSource === "generated") {
  logger.log("info", `Host token: ${config.hostToken}`);
}

if (config.workspaces.length === 0) {
  logger.log("info", "No workspaces configured. Add --workspace or update server.json.");
} else {
  logger.log("info", `Workspaces: ${config.workspaces.length}`);
}

if (args.verbose) {
  logger.log("info", `Config path: ${config.configPath ?? "unknown"}`);
  logger.log("info", `Read-only: ${config.readOnly ? "true" : "false"}`);
  logger.log("info", `Approval: ${config.approval.mode} (${config.approval.timeoutMs}ms)`);
  logger.log("info", `CORS origins: ${config.corsOrigins.join(", ")}`);
  logger.log("info", `Authorized roots: ${config.authorizedRoots.join(", ")}`);
  logger.log("info", `Token source: ${config.tokenSource}`);
  logger.log("info", `Host token source: ${config.hostTokenSource}`);
}

const shutdown = () => {
  managedOpencode?.close();
  (server as { stop?: (closeActiveConnections?: boolean) => void }).stop?.(true);
};

process.once("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.once("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
