/**
 * Single entry point for embedding the OpenWork server in-process.
 *
 * Handles config resolution, managed OpenCode spawn, and server start
 * in one call -- mirrors what cli.ts does but returns a handle instead
 * of owning the process lifecycle.
 */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
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
import { findManagedEngineWorkspace } from "./workspaces.js";
import { keepOpenworkRuntimeConfigFileFresh, writeOpenworkRuntimeConfigFile } from "./openwork-runtime-config.js";
import { migrateOpenworkCloudMcpRuntimeConfig } from "./cloud-mcp-health.js";
import { migrateWorkspaceRuntimeConfigToEngineGlobal } from "./runtime-opencode-config-store.js";
import { resolveOpencodeModelsUrl } from "./opencode-models-url.js";
import type { ServeResult } from "./serve-node.js";
import type { LocalManagedMcpVaultKeyProvider, ServerConfig } from "./types.js";

export type EmbeddedServerOptions = CliArgs & {
  /** When true, spawn a managed OpenCode child process. */
  manageOpencode?: boolean;
  /** Path to the OpenCode binary. Falls back to OPENWORK_OPENCODE_BIN env. */
  opencodeBin?: string;
  /** Working directory for the managed OpenCode process. */
  opencodeCwd?: string;
  /** Secure key custody for the local managed MCP credential vault. */
  localManagedMcpVaultKey?: LocalManagedMcpVaultKeyProvider;
};

export type EmbeddedServerHandle = {
  /** Bound port the HTTP server is listening on. */
  port: number;
  /** Full base URL, e.g. http://127.0.0.1:48123 */
  url: string;
  /** The resolved server config (with OpenCode URLs populated). */
  config: ServerConfig;
  /** Redacted details for the managed OpenCode child process, when spawned. */
  managedOpencodeExecution: OpencodeExecutionSnapshot | null;
  /** Liveness for the managed OpenCode child process, when spawned. */
  managedOpencode: { pid: number | null; isAlive: () => boolean } | null;
  /** Current managed-engine generations for desktop diagnostics and acceptance checks. */
  managedOpencodePool: () => EnginePoolSnapshot | null;
  /** Stop the HTTP server and managed OpenCode (if any). */
  stop: () => Promise<void>;
};

export async function startEmbeddedServer(options: EmbeddedServerOptions): Promise<EmbeddedServerHandle> {
  const config = await resolveServerConfig(options);
  config.localManagedMcpVaultKey = options.localManagedMcpVaultKey;
  const logger = createServerLogger(config);

  // Spawn managed OpenCode if requested and no explicit base URL was provided.
  let managedOpencode: ManagedOpencodeServer | null = null;
  let managedOpencodeIdentity: string | null = null;
  let managedEngineRecordId: string | null = null;
  let engineSpawnTemplate: EngineSpawnTemplate | null = null;
  let enginePool: EnginePool | null = null;
  let stopRuntimeConfigFileRefresh: (() => void) | null = null;
  let server: ServeResult | null = null;
  let stopPromise: Promise<void> | null = null;

  const releaseResources = async (): Promise<void> => {
    const errors: unknown[] = [];

    const identity = managedOpencodeIdentity;
    managedOpencodeIdentity = null;
    if (identity && !enginePool) {
      try {
        clearTrustedOpencodeProcess(config, identity);
      } catch (error) {
        errors.push(error);
      }
    }

    // With rollover enabled the pool owns every engine process, including any
    // still draining, so it is the one that must close them.
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

  // Bind the HTTP server before spawning the engine: serve-node may fall back
  // to an OS-assigned port on EADDRINUSE, and the engine's spawn-time env
  // (OPENWORK_SERVER_URL) must point at the port that actually bound, not the
  // requested one. Proxy requests that land in the short window before the
  // engine is ready fail with opencode_unconfigured and clients retry; the
  // desktop only learns the server URL after this function returns.
  server = await duringStartup(() => startServer(config));
  config.port = server.port;
  const serverUrl = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${server.port}`;

  if (!config.opencodeBaseUrl && options.manageOpencode) {
    const workspace = findManagedEngineWorkspace(config.workspaces);
    if (workspace) {
      // Reap engines recorded by servers that died without cleanup. Best
      // effort: a failed reap must never block startup.
      await reapOrphanEngineInstances(config).catch(() => undefined);
      // Server-managed config file: the engine re-reads it from disk on every
      // instance rebuild, and keepOpenworkRuntimeConfigFileFresh synchronizes it
      // on every runtime-DB write — so disposes always pick up current state.
      const { path: runtimeConfigPath } = await writeOpenworkRuntimeConfigFile(config);
      stopRuntimeConfigFileRefresh = keepOpenworkRuntimeConfigFileFresh(config);
      const cwd = options.opencodeCwd
        || process.env.OPENWORK_MANAGED_OPENCODE_CWD?.trim()
        || workspace.path;
      await duringStartup(() => mkdir(cwd, { recursive: true }));
      const opencodeModelsUrl = await duringStartup(() => resolveOpencodeModelsUrl());

      const opencodeBin = options.opencodeBin || process.env.OPENWORK_OPENCODE_BIN;
      // Shared by the first spawn and by any later rollover standby, so a
      // replacement engine is identical apart from its port.
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
      }));

      config.opencodeBaseUrl = managedOpencode.url;
      config.opencodeUsername = managedOpencode.username;
      config.opencodePassword = managedOpencode.password;
      for (const entry of config.workspaces) {
        if (entry.workspaceType === "remote") {
          entry.baseUrl ??= managedOpencode.url;
          entry.opencodeUsername ??= managedOpencode.username;
          entry.opencodePassword ??= managedOpencode.password;
          entry.directory ??= entry.path;
          continue;
        }
        entry.baseUrl = managedOpencode.url;
        entry.opencodeUsername = managedOpencode.username;
        entry.opencodePassword = managedOpencode.password;
        entry.directory = entry.path;
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
          bin: opencodeBin?.trim() || "opencode",
        }).catch(() => undefined);
      }
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

  if (managedOpencode && engineSpawnTemplate) {
    enginePool = createEnginePoolForConfig({
      config,
      template: engineSpawnTemplate,
      handle: managedOpencode,
      fingerprint: await computeEngineConfigFingerprint(engineSpawnTemplate),
      registryId: managedEngineRecordId,
      trustedIdentity: managedOpencodeIdentity,
    });
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
