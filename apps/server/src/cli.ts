#!/usr/bin/env bun

import { mkdir } from "node:fs/promises";

import { parseCliArgs, printHelp, resolveServerConfig } from "./config.js";
import { createManagedOpencodeServer, type ManagedOpencodeServer } from "./managed-opencode.js";
import {
  clearTrustedOpencodeProcess,
  createServerLogger,
  registerTrustedOpencodeProcess,
  startServer,
  syncAllWorkspacesRuntimeMcpToEngine,
} from "./server.js";
import { ensureLocalWorkspaceFiles } from "./workspace-init.js";
import { findManagedEngineWorkspace } from "./workspaces.js";
import {
  keepOpenworkRuntimeConfigFileFresh,
  openworkAgentPromptLength,
  openworkAgentPromptSha256,
  writeOpenworkRuntimeConfigFile,
} from "./openwork-runtime-config.js";
import { createServerObservabilityController } from "./observability.js";
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
const observability = createServerObservabilityController();
let managedOpencode: ManagedOpencodeServer | null = null;
let managedOpencodeIdentity: string | null = null;

if (!config.readOnly) {
  await ensureLocalWorkspaceFiles(config.workspaces);
}

// Bind OpenWork first so the observer receives the actual port when callers
// request port 0 or the HTTP adapter falls back after EADDRINUSE.
const server = await startServer(config, { observability });
const serverUrl = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${server.port}`;

try {
  if (!config.opencodeBaseUrl && process.env.OPENWORK_MANAGE_OPENCODE === "1") {
    const workspace = findManagedEngineWorkspace(config.workspaces);
    if (workspace) {
      // Server-managed config file: the engine re-reads it from disk on every
      // instance rebuild, and keepOpenworkRuntimeConfigFileFresh rewrites it
      // on every runtime-DB write — so disposes always pick up current state.
      const runtimeConfigPath = await writeOpenworkRuntimeConfigFile(config, workspace.id, observability);
      keepOpenworkRuntimeConfigFileFresh(config, workspace.id, observability);
      const managedOpencodeCwd = process.env.OPENWORK_MANAGED_OPENCODE_CWD?.trim() || workspace.path;
      await mkdir(managedOpencodeCwd, { recursive: true });
      managedOpencode = await createManagedOpencodeServer({
        bin: process.env.OPENWORK_OPENCODE_BIN,
        cwd: managedOpencodeCwd,
        excludedPorts: [server.port],
        env: {
          ...(process.env.OPENWORK_DEV_MODE ? { OPENWORK_DEV_MODE: process.env.OPENWORK_DEV_MODE } : {}),
          ...(process.env.OPENWORK_UI_CONTROL_DISCOVERY ? { OPENWORK_UI_CONTROL_DISCOVERY: process.env.OPENWORK_UI_CONTROL_DISCOVERY } : {}),
          OPENWORK_SERVER_URL: serverUrl,
          OPENWORK_SERVER_TOKEN: config.token,
          OPENWORK_OBSERVABILITY_TOKEN: observability.getInternalToken(),
          OPENWORK_AGENT_PROMPT_SHA256: openworkAgentPromptSha256(),
          OPENWORK_AGENT_PROMPT_LENGTH: String(openworkAgentPromptLength()),
          OPENCODE_CONFIG: runtimeConfigPath,
        },
        observe: (event) => {
          observability.record(event);
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
      managedOpencodeIdentity = [
        managedOpencode.pid ?? "unknown",
        managedOpencode.username,
        managedOpencode.password,
      ].join(":");
      registerTrustedOpencodeProcess(config, {
        baseUrl: managedOpencode.url,
        identity: managedOpencodeIdentity,
        isAlive: managedOpencode.isAlive,
      });
      logger.log("info", `Managed OpenCode listening on ${managedOpencode.url}`);
    }
  }
} catch (error) {
  await server.stop();
  throw error;
}

// The runtime config file above only covers workspaces[0]. Push every
// workspace's runtime-DB MCPs into the engine so they aren't invisible
// until a manual reload. Best-effort.
if (managedOpencode) {
  void syncAllWorkspacesRuntimeMcpToEngine(config);
}

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
  if (managedOpencodeIdentity) {
    clearTrustedOpencodeProcess(config, managedOpencodeIdentity);
  }
  void managedOpencode?.close();
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
