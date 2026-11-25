import { randomUUID } from "node:crypto";
import { stopTaskRecovery } from "./task-recovery.js";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import constants from "../../../constants.json" with { type: "json" };
import { readBinaryVersion, seedManagedOpencodePluginDeps } from "./selfhost-web.js";
import { resolveServerConfig, type CliArgs } from "./config.js";
import {
  buildEngineAuthProbeHeader,
  registerEngineInstance,
  removeEngineInstance,
  reapOrphanEngineInstances,
} from "./engine-registry.js";
import {
  clearEnginePoolForConfig,
  computeEngineConfigFingerprint,
  type EnginePool,
  type EnginePoolSnapshot,
  type EngineSpawnTemplate,
} from "./engine-pool.js";
import { createManagedOpencodeServer, type ManagedOpencodeServer, type OpencodeExecutionSnapshot } from "./managed-opencode.js";
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
import type { LocalManagedMcpVaultKeyProvider, ServerConfig } from "./types.js";

export type EmbeddedServerOptions = CliArgs & {
  manageOpencode?: boolean;
  opencodeBin?: string;
  opencodeCwd?: string;
  localManagedMcpVaultKey?: LocalManagedMcpVaultKeyProvider;
  driveFileApproval?: ServerConfig["driveFileApproval"];
  resumeInterruptedTasks?: boolean;
  anonymousInference?: ServerConfig["anonymousInference"];
  trustedDenOrigin?: string;
  engineSystemProxyEnv?: ServerConfig["engineSystemProxyEnv"];
  freshInstallEngine?: ServerConfig["freshInstallEngine"];
  engineAutoUpgrade?: boolean;
};

export type EmbeddedServerHandle = {
  port: number;
  url: string;
  config: ServerConfig;
  managedOpencodeExecution: OpencodeExecutionSnapshot | null;
  managedOpencode: { pid: number | null; isAlive: () => boolean } | null;
  managedOpencodePool: () => EnginePoolSnapshot | null;
  stop: () => Promise<void>;
};

export async function startEmbeddedServer(options: EmbeddedServerOptions): Promise<EmbeddedServerHandle> {
  const config = await resolveServerConfig(options);
  config.localManagedMcpVaultKey = options.localManagedMcpVaultKey;
  config.driveFileApproval = options.driveFileApproval;
  config.anonymousInference = options.anonymousInference;
  config.trustedDenOrigin = options.trustedDenOrigin;
  config.engineSystemProxyEnv = options.engineSystemProxyEnv;
  config.freshInstallEngine = options.freshInstallEngine;
  if (options.engineAutoUpgrade !== undefined) {
    config.engineAutoUpgrade = options.engineAutoUpgrade;
  }
  config.resumeInterruptedTasks = options.resumeInterruptedTasks === true && options.manageOpencode === true && !config.opencodeBaseUrl;
  const logger = createServerLogger(config);

  let managedOpencode: ManagedOpencodeServer | null = null;
  let managedOpencodeIdentity: string | null = null;
  let managedEngineRecordId: string | null = null;
  let engineSpawnTemplate: EngineSpawnTemplate | null = null;
  let enginePool: EnginePool | null = null;
  let stopRuntimeConfigFileRefresh: (() => void) | null = null;
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  let stopPromise: Promise<void> | null = null;

  const releaseResources = async (): Promise<void> => {
    const errors: unknown[] = [];
    try { await stopTaskRecovery(config); } catch (error) { errors.push(error); }

    const identity = managedOpencodeIdentity;
    managedOpencodeIdentity = null;
    if (identity && !enginePool) {
      try {
        clearTrustedOpencodeProcess(config, identity);
      } catch (error) {
        errors.push(error);
      }
    }

    const pool = enginePool;
    enginePool = null;
    if (pool) {
      clearEnginePoolForConfig(config);
      try {
        await pool.disposeAll();
      } catch (error) {
        errors.push(error);
      }
    }

    const opencode = managedOpencode;
    managedOpencode = null;
    if (opencode && !pool) {
      try {
        await opencode.close();
      } catch (error) {
        errors.push(error);
      }
    }

    const engineRecordId = managedEngineRecordId;
    managedEngineRecordId = null;
    if (engineRecordId) {
      await removeEngineInstance(config, engineRecordId).catch(() => undefined);
    }

    const httpServer = server;
    server = null;
    if (httpServer) {
      try {
        await httpServer.stop();
      } catch (error) {
        errors.push(error);
      }
    }

    const unsubscribe = stopRuntimeConfigFileRefresh;
    stopRuntimeConfigFileRefresh = null;
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Failed to stop embedded OpenWork server");
    }
  };

  const stop = (): Promise<void> => {
    stopPromise ??= releaseResources();
    return stopPromise;
  };

  const duringStartup = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (startupError) {
      try {
        await stop();
      } catch (cleanupError) {
        throw new AggregateError(
          [startupError, cleanupError],
          "Embedded OpenWork server startup failed and cleanup was incomplete",
        );
      }
      throw startupError;
    }
  };

  if (!config.readOnly) {
    await ensureLocalWorkspaceFiles(config.workspaces);
    await migrateOpenworkCloudMcpRuntimeConfig(config);
    await migrateWorkspaceRuntimeConfigToEngineGlobal(config);
  }

  const manageEngine = !config.opencodeBaseUrl && options.manageOpencode === true
    && shouldStartManagedEngine(config.workspaces);
  server = await duringStartup(() => startServer(config, { deferManagedEngineStartup: manageEngine }));
  config.port = server.port;
  const serverUrl = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${server.port}`;

  if (manageEngine) {
    await reapOrphanEngineInstances(config).catch(() => undefined);
    const { path: runtimeConfigPath } = await writeOpenworkRuntimeConfigFile(config);
    stopRuntimeConfigFileRefresh = keepOpenworkRuntimeConfigFileFresh(config);
    const cwd = resolveManagedEngineCwd({
      explicit: options.opencodeCwd || process.env.OPENWORK_MANAGED_OPENCODE_CWD,
      workspace: findManagedEngineWorkspace(config.workspaces),
      fallbackDir: join(runtimeStorageDir(config), "managed-opencode-workdir"),
    });
    await duringStartup(() => mkdir(cwd, { recursive: true }));
    const opencodeModelsUrl = await duringStartup(() => resolveOpencodeModelsUrl());

    const opencodeBin = options.opencodeBin || process.env.OPENWORK_OPENCODE_BIN;
    const pluginDepsArchive = fileURLToPath(new URL(
      `./opencode-plugin-deps-${constants.opencodeVersion.replace(/^v/, "")}.tgz`, import.meta.url,
    )).replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
    if (!config.readOnly && existsSync(pluginDepsArchive) && opencodeBin
      && readBinaryVersion(opencodeBin) === constants.opencodeVersion.replace(/^v/, "")) {
      const seeded = await duringStartup(() => seedManagedOpencodePluginDeps({
        archive: pluginDepsArchive, cwd, env: process.env,
        workspaceDirs: config.workspaces.map((workspace) => workspace.path).filter((path) => path.trim()),
      }));
      for (const { result } of seeded) {
        if (result.seeded) {
          logger.log("info", `Bundled engine dependencies seeded: true (${result.durationMs} ms).`);
        } else if (result.reason === "failed") {
          logger.log("warn", "Bundled engine dependencies could not be prepared; using the engine installer.");
        }
      }
    }
    const engineStateDir = join(runtimeStorageDir(config), "opencode-v1", "state");
    const engineEnv: Record<string, string | undefined> = {
      ...(process.env.OPENWORK_DEV_MODE ? { OPENWORK_DEV_MODE: process.env.OPENWORK_DEV_MODE } : {}),
      ...(process.env.OPENWORK_UI_CONTROL_DISCOVERY ? { OPENWORK_UI_CONTROL_DISCOVERY: process.env.OPENWORK_UI_CONTROL_DISCOVERY } : {}),
      OPENWORK_SERVER_URL: serverUrl,
      OPENWORK_SERVER_TOKEN: config.token,
      OPENCODE_CONFIG: runtimeConfigPath,
      OPENCODE_MODELS_URL: opencodeModelsUrl,
    };
    engineSpawnTemplate = {
      bin: opencodeBin,
      cwd,
      runtimeConfigPath,
      env: engineEnv,
      stateDir: engineStateDir,
      reservedPorts: () => {
        const poolPorts = enginePool?.connections()
          .map((connection) => Number(new URL(connection.baseUrl).port) || 0)
          .filter((port) => port > 0) ?? [];
        const startupPort = managedOpencode ? Number(new URL(managedOpencode.url).port) || 0 : 0;
        return [...new Set([config.port, ...poolPorts, startupPort].filter((port) => port > 0))];
      },
    };
    managedOpencode = await duringStartup(() => createManagedOpencodeServer({
      bin: opencodeBin,
      cwd,
      excludedPorts: [config.port],
      env: engineEnv,
      stateDir: engineStateDir,
    }));

    config.opencodeBaseUrl = managedOpencode.url;
    config.opencodeUsername = managedOpencode.username;
    config.opencodePassword = managedOpencode.password;
    for (const entry of config.workspaces) {
      entry.baseUrl = managedOpencode.url;
      entry.opencodeUsername = managedOpencode.username;
      entry.opencodePassword = managedOpencode.password;
      entry.directory = entry.path;
    }
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
        bin: opencodeBin?.trim() || "opencode",
      }).catch(() => undefined);
    }
  }

  if (managedOpencode) {
    void syncAllWorkspacesRuntimeMcpToEngine(config).catch((error) => {
      logger.log("error", "Startup MCP synchronization crashed.", {
        "mcp.trigger": "startup",
        "mcp.failure.message": error instanceof Error ? error.message : String(error),
      });
    });
  }

  if (managedOpencode && engineSpawnTemplate) {
    enginePool = createEnginePoolForConfig({
      config,
      template: engineSpawnTemplate,
      handle: managedOpencode,
      fingerprint: await computeEngineConfigFingerprint(engineSpawnTemplate),
      registryId: managedEngineRecordId,
      trustedIdentity: managedOpencodeIdentity,
    });
    await duringStartup(server.completeManagedEngineStartup);
  }

  const initialManagedOpencode = managedOpencode;
  return {
    port: server.port,
    url: `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${server.port}`,
    config,
    managedOpencodeExecution: managedOpencode?.execution ?? null,
    managedOpencode: initialManagedOpencode
      ? {
          get pid() {
            return enginePool?.primaryProcess()?.pid ?? initialManagedOpencode.pid ?? null;
          },
          isAlive: () => enginePool?.primaryProcess()?.isAlive() ?? initialManagedOpencode.isAlive(),
        }
      : null,
    managedOpencodePool: () => enginePool?.snapshot() ?? null,
    stop,
  };
}
