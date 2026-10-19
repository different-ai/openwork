#!/usr/bin/env bun

import { parseCliArgs, printHelp, resolveServerConfig } from "./config.js";
import { createServerLogger, startServer } from "./server.js";
import { ensureLocalWorkspaceFiles } from "./workspace-init.js";
import { migrateOpenworkCloudMcpRuntimeConfig } from "./cloud-mcp-health.js";
import { migrateWorkspaceRuntimeConfigToEngineGlobal } from "./runtime-opencode-config-store.js";
import { startWorkerActivityHeartbeat } from "./worker-activity-heartbeat.js";
import {
  checkForUpdate,
  loadOrCreateWebTokens,
  openInBrowser,
  resolveBundledPluginDir,
  resolvePackageRoot,
  resolveWebRoot,
  updateHint,
} from "./selfhost-web.js";
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

let webRoot: string | null = null;
let webTokensPath: string | null = null;
if (args.web) {
  // Everything below is read by resolveServerConfig and the engine through
  // process.env, so it must be settled before the config is resolved.
  const packageRoot = await resolvePackageRoot({ env: process.env, execPath: process.execPath });
  webRoot = await resolveWebRoot({ env: process.env, packageRoot, sourceDir: import.meta.dirname });
  if (!webRoot) {
    console.error("The OpenWork web UI bundle was not found. Reinstall openwork-server, or set OPENWORK_WEB_ROOT to a built apps/app/dist.");
    process.exit(1);
  }
  process.env.OPENWORK_WEB_ROOT = webRoot;
  if (args.bootstrapToken === false) process.env.OPENWORK_WEB_BOOTSTRAP_TOKEN = "0";
  if (!process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR) {
    const pluginDir = await resolveBundledPluginDir(packageRoot);
    if (pluginDir) process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR = pluginDir;
  }
  // The web UI has no approvals responder, so manual mode would time out every gated write.
  args.approvalMode ??= process.env.OPENWORK_APPROVAL_MODE === "manual" ? "manual" : "auto";
  if (args.workspaces.length === 0 && !process.env.OPENWORK_WORKSPACES) args.workspaces.push(process.cwd());
  // Stable tokens across restarts: CLI flag, then env, then a file in the data dir.
  const tokenProvided = Boolean(args.token || process.env.OPENWORK_TOKEN);
  const hostTokenProvided = Boolean(args.hostToken || process.env.OPENWORK_HOST_TOKEN);
  if (!tokenProvided || !hostTokenProvided) {
    const tokens = await loadOrCreateWebTokens({ env: process.env });
    if (!tokenProvided) args.token = tokens.token;
    if (!hostTokenProvided) args.hostToken = tokens.hostToken;
    webTokensPath = tokens.path;
  }
}

const config = await resolveServerConfig(args);
const logger = createServerLogger(config);
if (!config.readOnly) {
  await ensureLocalWorkspaceFiles(config.workspaces);
  await migrateOpenworkCloudMcpRuntimeConfig(config);
  await migrateWorkspaceRuntimeConfigToEngineGlobal(config);
}

const server = await startServer(config);
const workerActivityHeartbeat = startWorkerActivityHeartbeat(config, logger);

const url = `http://${config.host}:${server.port}`;
logger.log("info", `OpenWork server listening on ${url}`);

if (args.web) {
  const browserHost = config.host === "0.0.0.0" || config.host === "::" ? "localhost" : config.host;
  const browserUrl = `http://${browserHost}:${server.port}`;
  logger.log("info", `OpenWork web UI: ${browserUrl}`);
  logger.log("info", `Web root: ${webRoot}`);
  if (webTokensPath) logger.log("info", `Tokens: ${webTokensPath}`);
  if (process.env.OPENWORK_WEB_BOOTSTRAP_TOKEN === "0") {
    logger.log("info", `Browser sign-in requires the client token: ${config.token}`);
  } else if (browserHost !== "localhost" && browserHost !== "127.0.0.1") {
    logger.log("info", "Anyone who can reach this URL is signed in automatically. Keep it on a private network or pass --no-bootstrap-token.");
  }
  if (browserHost !== "localhost" && browserHost !== "127.0.0.1") {
    logger.log("info", "Browsers require HTTPS for a non-localhost origin; put a TLS proxy (e.g. tailscale serve) in front.");
  }
  if (args.open) openInBrowser(browserUrl);
  void checkForUpdate({ currentVersion: pkg.version, env: process.env }).then((latest) => {
    if (latest) logger.log("info", updateHint(latest));
  });
}

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

async function shutdown() {
  workerActivityHeartbeat?.stop();
  await server.stop();
}

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
