#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { parseCliArgs, printHelp, resolveServerConfig } from "./config.js";
import {
  buildEngineAuthProbeHeader,
  registerEngineInstance,
  removeEngineInstance,
  reapOrphanEngineInstances,
} from "./engine-registry.js";
import { createManagedOpencodeServer, type ManagedOpencodeServer } from "./managed-opencode.js";
import { clearEnginePoolForConfig, computeEngineConfigFingerprint, type EnginePool, type EngineSpawnTemplate } from "./engine-pool.js";
import {
  clearTrustedOpencodeProcess,
  createEnginePoolForConfig,
  createServerLogger,
  registerTrustedOpencodeProcess,
  startServer,
  syncAllWorkspacesRuntimeMcpToEngine,
} from "./server.js";
import { ensureLocalWorkspaceFiles } from "./workspace-init.js";
import { findManagedEngineWorkspace, resolveManagedEngineCwd, shouldStartManagedEngine } from "./workspaces.js";
import { runtimeStorageDir } from "./runtime-db.js";
import { keepOpenworkRuntimeConfigFileFresh, writeOpenworkRuntimeConfigFile } from "./openwork-runtime-config.js";
import { migrateOpenworkCloudMcpRuntimeConfig } from "./cloud-mcp-health.js";
import { migrateWorkspaceRuntimeConfigToEngineGlobal } from "./runtime-opencode-config-store.js";
import { resolveOpencodeModelsUrl } from "./opencode-models-url.js";
import { startWorkerActivityHeartbeat } from "./worker-activity-heartbeat.js";
import {
  checkForUpdate,
  ensureManagedEngine,
  loadOrCreateWebTokens,
  openInBrowser,
  readBinaryVersion,
  resolveBundledPluginDir,
  resolvePackageRoot,
  resolveWebRoot,
  updateHint,
} from "./selfhost-web.js";
import { readInstalledOpencodeVersion, setInstalledOpencodeVersion } from "./routes/core.js";
import pkg from "../package.json" with { type: "json" };
import constants from "../../../constants.json" with { type: "json" };

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
  // Everything below is read by resolveServerConfig / the engine spawn through
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
  process.env.OPENWORK_MANAGE_OPENCODE = "1";
  const engine = await ensureManagedEngine({
    env: process.env,
    expectedVersion: constants.opencodeVersion,
    log: (message) => console.log(message),
  });
  process.env.OPENWORK_OPENCODE_BIN = engine.bin;
  setInstalledOpencodeVersion(engine.installedVersion);
}

const config = await resolveServerConfig(args);
const logger = createServerLogger(config);
let managedOpencode: ManagedOpencodeServer | null = null;
let managedOpencodeIdentity: string | null = null;
let managedEngineRecordId: string | null = null;
let enginePool: EnginePool | null = null;
let stopRuntimeConfigFileRefresh: (() => void) | undefined;

if (!config.readOnly) {
  await ensureLocalWorkspaceFiles(config.workspaces);
  await migrateOpenworkCloudMcpRuntimeConfig(config);
  await migrateWorkspaceRuntimeConfigToEngineGlobal(config);
}

// Bind the HTTP server before spawning the engine: serve-node may fall back
// to an OS-assigned port on EADDRINUSE, and the engine's spawn-time env
// (OPENWORK_SERVER_URL) must point at the port that actually bound, not the
// requested one.
// The engine also starts with no workspace registered yet, so providers load
// before the first workspace exists.
const manageEngine = !config.opencodeBaseUrl && process.env.OPENWORK_MANAGE_OPENCODE === "1"
  && shouldStartManagedEngine(config.workspaces);
const server = await startServer(config, { deferManagedEngineStartup: manageEngine });
config.port = server.port;
const serverUrl = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${server.port}`;
const workerActivityHeartbeat = startWorkerActivityHeartbeat(config, logger);

if (manageEngine) {
  // Reap engines recorded by servers that died without cleanup. Best
  // effort: a failed reap must never block startup.
  await reapOrphanEngineInstances(config, { logger }).catch(() => undefined);
  // Server-managed config file: the engine re-reads it from disk on every
  // instance rebuild, and keepOpenworkRuntimeConfigFileFresh synchronizes it
  // on every runtime-DB write — so disposes always pick up current state.
  const { path: runtimeConfigPath } = await writeOpenworkRuntimeConfigFile(config);
  stopRuntimeConfigFileRefresh = keepOpenworkRuntimeConfigFileFresh(config);
  const managedOpencodeCwd = resolveManagedEngineCwd({
    explicit: process.env.OPENWORK_MANAGED_OPENCODE_CWD,
    workspace: findManagedEngineWorkspace(config.workspaces),
    fallbackDir: join(runtimeStorageDir(config), "managed-opencode-workdir"),
  });
  await mkdir(managedOpencodeCwd, { recursive: true });
  const opencodeModelsUrl = await resolveOpencodeModelsUrl();
  const engineEnv: Record<string, string | undefined> = {
    ...(process.env.OPENWORK_DEV_MODE ? { OPENWORK_DEV_MODE: process.env.OPENWORK_DEV_MODE } : {}),
    ...(process.env.OPENWORK_UI_CONTROL_DISCOVERY ? { OPENWORK_UI_CONTROL_DISCOVERY: process.env.OPENWORK_UI_CONTROL_DISCOVERY } : {}),
    OPENWORK_SERVER_URL: serverUrl,
    OPENWORK_SERVER_TOKEN: config.token,
    OPENCODE_CONFIG: runtimeConfigPath,
    OPENCODE_MODELS_URL: opencodeModelsUrl,
  };
  const engineSpawnTemplate: EngineSpawnTemplate = {
    bin: process.env.OPENWORK_OPENCODE_BIN,
    cwd: managedOpencodeCwd,
    runtimeConfigPath,
    env: engineEnv,
    reservedPorts: () => {
      const poolPorts = enginePool?.connections().map((connection) => Number(new URL(connection.baseUrl).port) || 0) ?? [];
      return [...new Set([config.port, ...poolPorts].filter((port) => port > 0))];
    },
  };
  managedOpencode = await createManagedOpencodeServer({
    bin: process.env.OPENWORK_OPENCODE_BIN,
    cwd: managedOpencodeCwd,
    excludedPorts: [config.port],
    env: engineEnv,
  });
  if (!readInstalledOpencodeVersion()) {
    setInstalledOpencodeVersion(readBinaryVersion(process.env.OPENWORK_OPENCODE_BIN?.trim() || "opencode"));
  }
  config.opencodeBaseUrl = managedOpencode.url;
  config.opencodeUsername = managedOpencode.username;
  config.opencodePassword = managedOpencode.password;
  for (const entry of config.workspaces) {
    entry.baseUrl ??= managedOpencode.url;
    entry.opencodeUsername ??= managedOpencode.username;
    entry.opencodePassword ??= managedOpencode.password;
    entry.directory ??= entry.path;
  }
  // The identity only needs to be unique per managed-process boot; a
  // random nonce provides that without routing the engine credentials
  // through the fast identity hash.
  managedOpencodeIdentity = [
    managedOpencode.pid ?? "unknown",
    randomUUID(),
  ].join(":");
  registerTrustedOpencodeProcess(config, {
    baseUrl: managedOpencode.url,
    identity: managedOpencodeIdentity,
    isAlive: managedOpencode.isAlive,
  });
  if (managedOpencode.pid) {
    managedEngineRecordId = randomUUID();
    await registerEngineInstance(config, {
      id: managedEngineRecordId,
      pid: managedOpencode.pid,
      port: Number(new URL(managedOpencode.url).port) || 0,
      url: managedOpencode.url,
      startedAt: Date.now(),
      role: "primary",
      serverRunId: managedOpencodeIdentity,
      ownerPid: process.pid,
      authProbe: buildEngineAuthProbeHeader(managedOpencode.username, managedOpencode.password),
      bin: process.env.OPENWORK_OPENCODE_BIN?.trim() || "opencode",
    }).catch(() => undefined);
  }
  enginePool = createEnginePoolForConfig({
    config,
    template: engineSpawnTemplate,
    handle: managedOpencode,
    fingerprint: await computeEngineConfigFingerprint(engineSpawnTemplate),
    registryId: managedEngineRecordId,
    trustedIdentity: managedOpencodeIdentity,
  });
  try {
    await server.completeManagedEngineStartup();
  } catch (startupError) {
    try {
      await shutdown();
    } catch (cleanupError) {
      throw new AggregateError([startupError, cleanupError], "Managed engine startup failed and cleanup was incomplete");
    }
    throw startupError;
  }
  logger.log("info", `Managed OpenCode listening on ${managedOpencode.url}`);
}

// The runtime config file above only covers workspaces[0]. Push every
// workspace's runtime-DB MCPs into the engine so they aren't invisible
// until a manual reload. Best-effort.
if (managedOpencode) {
  void syncAllWorkspacesRuntimeMcpToEngine(config).catch((error) => {
    logger.log("error", "Startup MCP synchronization crashed.", {
      "mcp.trigger": "startup",
      "mcp.failure.message": error instanceof Error ? error.message : String(error),
    });
  });
}

const url = `http://${config.host}:${server.port}`;
logger.log("info", `OpenWork server listening on ${url}`);

if (args.web) {
  const browserHost = config.host === "0.0.0.0" || config.host === "::" ? "localhost" : config.host;
  const browserUrl = `http://${browserHost}:${server.port}`;
  logger.log("info", `OpenWork web UI: ${browserUrl}`);
  logger.log("info", `Web root: ${webRoot}`);
  logger.log("info", `Engine: ${process.env.OPENWORK_OPENCODE_BIN} (${installedOpencodeVersionLabel()})`);
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

function installedOpencodeVersionLabel(): string {
  const installed = readInstalledOpencodeVersion();
  const expected = constants.opencodeVersion.replace(/^v/, "");
  if (!installed) return `version unknown, expected ${expected}`;
  return installed === expected ? installed : `${installed}, expected ${expected}`;
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
  stopRuntimeConfigFileRefresh?.();
  if (managedOpencodeIdentity && !enginePool) {
    clearTrustedOpencodeProcess(config, managedOpencodeIdentity);
  }
  // Await the engine teardown (SIGTERM → 1s → SIGKILL, bounded ~1.5s): a
  // synchronous process.exit here used to skip the escalation entirely and
  // orphan the OpenCode child to init.
  try {
    if (enginePool) {
      clearEnginePoolForConfig(config);
      await enginePool.disposeAll();
    } else {
      await managedOpencode?.close();
    }
  } catch {
    // Engine already exited.
  }
  if (managedEngineRecordId && !enginePool) {
    await removeEngineInstance(config, managedEngineRecordId).catch(() => undefined);
  }
  await server.stop();
}

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
