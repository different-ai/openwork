#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

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
import { findManagedEngineWorkspace } from "./workspaces.js";
import { keepOpenworkRuntimeConfigFileFresh, writeOpenworkRuntimeConfigFile } from "./openwork-runtime-config.js";
import { migrateOpenworkCloudMcpRuntimeConfig } from "./cloud-mcp-health.js";
import { migrateWorkspaceRuntimeConfigToEngineGlobal } from "./runtime-opencode-config-store.js";
import { resolveOpencodeModelsUrl } from "./opencode-models-url.js";
import { startWorkerActivityHeartbeat } from "./worker-activity-heartbeat.js";
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
let managedOpencodeIdentity: string | null = null;
let managedEngineRecordId: string | null = null;
let enginePool: EnginePool | null = null;

if (!config.readOnly) {
  await ensureLocalWorkspaceFiles(config.workspaces);
  await migrateOpenworkCloudMcpRuntimeConfig(config);
  await migrateWorkspaceRuntimeConfigToEngineGlobal(config);
}

// Bind the HTTP server before spawning the engine: serve-node may fall back
// to an OS-assigned port on EADDRINUSE, and the engine's spawn-time env
// (OPENWORK_SERVER_URL) must point at the port that actually bound, not the
// requested one.
const server = await startServer(config);
config.port = server.port;
const serverUrl = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${server.port}`;
const workerActivityHeartbeat = startWorkerActivityHeartbeat(config, logger);

if (!config.opencodeBaseUrl && process.env.OPENWORK_MANAGE_OPENCODE === "1") {
  const workspace = findManagedEngineWorkspace(config.workspaces);
  if (workspace) {
    // Reap engines recorded by servers that died without cleanup. Best
    // effort: a failed reap must never block startup.
    await reapOrphanEngineInstances(config, { logger }).catch(() => undefined);
    // Server-managed config file: the engine re-reads it from disk on every
    // instance rebuild, and keepOpenworkRuntimeConfigFileFresh synchronizes it
    // on every runtime-DB write — so disposes always pick up current state.
    const { path: runtimeConfigPath } = await writeOpenworkRuntimeConfigFile(config);
    keepOpenworkRuntimeConfigFileFresh(config);
    const managedOpencodeCwd = process.env.OPENWORK_MANAGED_OPENCODE_CWD?.trim() || workspace.path;
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
    logger.log("info", `Managed OpenCode listening on ${managedOpencode.url}`);
  }
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

const shutdown = async () => {
  workerActivityHeartbeat?.stop();
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
  (server as { stop?: (closeActiveConnections?: boolean) => void }).stop?.(true);
};

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
