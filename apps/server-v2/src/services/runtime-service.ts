import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Database } from "bun:sqlite";
import type { LocalOpencodeHandle, LocalProcessExit } from "../adapters/opencode/local.js";
import { LocalOpencodeStartupError, createLocalOpencode } from "../adapters/opencode/local.js";
import type { ServerRepositories } from "../database/repositories.js";
import type { ServerWorkingDirectory } from "../database/working-directory.js";
import { createBoundedOutputCollector, formatRuntimeOutput, type RuntimeOutputSnapshot } from "../runtime/output-buffer.js";
import type { ResolvedRuntimeBinary, RuntimeManifest } from "../runtime/manifest.js";
import { createRuntimeAssetService, type RuntimeAssetService } from "../runtime/assets.js";

type RuntimeBootstrapPolicy = "disabled" | "eager" | "manual";
type RuntimeChildStatus = "crashed" | "disabled" | "error" | "restart_scheduled" | "running" | "starting" | "stopped";

type RuntimeRestartPolicy = {
  backoffMs: number;
  maxAttempts: number;
  windowMs: number;
};

type RuntimeLastExit = LocalProcessExit & {
  output: RuntimeOutputSnapshot;
  reason: string;
};

type RouterEnablementDecision = {
  enabled: boolean;
  enabledBindingCount: number;
  enabledIdentityCount: number;
  forced: boolean;
  reason: string;
};

type RuntimeChildState = {
  asset: ResolvedRuntimeBinary | null;
  baseUrl: string | null;
  healthUrl: string | null;
  lastError: string | null;
  lastExit: RuntimeLastExit | null;
  lastReadyAt: string | null;
  lastStartedAt: string | null;
  pid: number | null;
  recentOutput: RuntimeOutputSnapshot;
  running: boolean;
  status: RuntimeChildStatus;
  version: string | null;
};

type RouterMaterialization = {
  bindingCount: number;
  configPath: string;
  dataDir: string;
  dbPath: string;
  identityCount: number;
  logFile: string;
};

type ManagedProcessHandle = {
  close(): void;
  getOutput(): RuntimeOutputSnapshot;
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  waitForExit(): Promise<LocalProcessExit>;
};

type RuntimeUpgradeState = {
  error: string | null;
  finishedAt: string | null;
  startedAt: string | null;
  status: "completed" | "failed" | "idle" | "running";
};

export type RuntimeService = {
  applyRouterConfig(): Promise<ReturnType<RuntimeService["getRouterHealth"]>>;
  bootstrap(): Promise<void>;
  dispose(): Promise<void>;
  getBootstrapPolicy(): RuntimeBootstrapPolicy;
  getOpencodeHealth(): {
    baseUrl: string | null;
    binaryPath: string | null;
    diagnostics: RuntimeOutputSnapshot;
    lastError: string | null;
    lastExit: RuntimeLastExit | null;
    lastReadyAt: string | null;
    lastStartedAt: string | null;
    manifest: RuntimeManifest | null;
    pid: number | null;
    running: boolean;
    source: "development" | "release";
    status: RuntimeChildStatus;
    version: string | null;
  };
  getRouterHealth(): {
    baseUrl: string | null;
    binaryPath: string | null;
    diagnostics: RuntimeOutputSnapshot;
    enablement: RouterEnablementDecision;
    healthUrl: string | null;
    lastError: string | null;
    lastExit: RuntimeLastExit | null;
    lastReadyAt: string | null;
    lastStartedAt: string | null;
    manifest: RuntimeManifest | null;
    materialization: RouterMaterialization | null;
    pid: number | null;
    running: boolean;
    source: "development" | "release";
    status: RuntimeChildStatus;
    version: string | null;
  };
  getRuntimeSummary(): {
    bootstrapPolicy: RuntimeBootstrapPolicy;
    manifest: RuntimeManifest | null;
    opencode: ReturnType<RuntimeService["getOpencodeHealth"]>;
    restartPolicy: RuntimeRestartPolicy;
    router: ReturnType<RuntimeService["getRouterHealth"]>;
    upgrade: RuntimeUpgradeState;
    source: "development" | "release";
    target: ReturnType<RuntimeAssetService["getTarget"]>;
  };
  getRuntimeVersions(): {
    active: {
      opencodeVersion: string | null;
      routerVersion: string | null;
      serverVersion: string;
    };
    manifest: RuntimeManifest | null;
    pinned: {
      opencodeVersion: string | null;
      routerVersion: string | null;
      serverVersion: string;
    };
    target: ReturnType<RuntimeAssetService["getTarget"]>;
  };
  getStateForPersistence(): ReturnType<RuntimeService["getRuntimeSummary"]>;
  upgradeRuntime(): Promise<{ state: RuntimeUpgradeState; summary: ReturnType<RuntimeService["getRuntimeSummary"]> }>;
};

type CreateRuntimeServiceOptions = {
  assetService?: RuntimeAssetService;
  bootstrapPolicy?: RuntimeBootstrapPolicy;
  environment: string;
  repositories: ServerRepositories;
  restartPolicy?: Partial<RuntimeRestartPolicy>;
  serverId: string;
  serverVersion: string;
  workingDirectory: ServerWorkingDirectory;
};

function isTruthy(value: string | undefined) {
  if (!value) {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function emptyOutput(): RuntimeOutputSnapshot {
  return {
    combined: [],
    stderr: [],
    stdout: [],
    totalLines: 0,
    truncated: false,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function resolveBootstrapPolicy(environment: string, explicit?: RuntimeBootstrapPolicy): RuntimeBootstrapPolicy {
  if (explicit) {
    return explicit;
  }

  const fromEnv = process.env.OPENWORK_SERVER_V2_RUNTIME_BOOTSTRAP?.trim().toLowerCase();
  if (fromEnv === "disabled" || fromEnv === "manual" || fromEnv === "eager") {
    return fromEnv;
  }

  if (environment === "test") {
    return "disabled";
  }

  return "eager";
}

function resolveRestartPolicy(overrides?: Partial<RuntimeRestartPolicy>): RuntimeRestartPolicy {
  const maxAttempts = Number.parseInt(process.env.OPENWORK_SERVER_V2_RUNTIME_RESTART_MAX_ATTEMPTS ?? "2", 10);
  const backoffMs = Number.parseInt(process.env.OPENWORK_SERVER_V2_RUNTIME_RESTART_BACKOFF_MS ?? "750", 10);
  const windowMs = Number.parseInt(process.env.OPENWORK_SERVER_V2_RUNTIME_RESTART_WINDOW_MS ?? "30000", 10);

  return {
    backoffMs: overrides?.backoffMs ?? (Number.isFinite(backoffMs) ? backoffMs : 750),
    maxAttempts: overrides?.maxAttempts ?? (Number.isFinite(maxAttempts) ? maxAttempts : 2),
    windowMs: overrides?.windowMs ?? (Number.isFinite(windowMs) ? windowMs : 30_000),
  };
}

function pickLatestExit(opencode: RuntimeChildState, router: RuntimeChildState) {
  const exits = [
    opencode.lastExit ? { component: "opencode" as const, ...opencode.lastExit } : null,
    router.lastExit ? { component: "router" as const, ...router.lastExit } : null,
  ].filter(Boolean) as Array<RuntimeLastExit & { component: "opencode" | "router" }>;
  exits.sort((left, right) => right.at.localeCompare(left.at));
  return exits[0] ?? null;
}

async function getFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate a free loopback port."));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });
}

async function waitForOpencodeHealthy(handle: LocalOpencodeHandle, timeoutMs = 5_000, pollMs = 200) {
  const startedAt = Date.now();
  let lastError = "OpenCode did not report healthy status yet.";

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const health = await handle.client.global.health();
      const data = (health as { healthy?: boolean }).healthy;
      if (data) {
        return;
      }
      lastError = "OpenCode reported unhealthy state.";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await Bun.sleep(pollMs);
  }

  throw new Error(lastError);
}

async function waitForHttpOk(url: string, timeoutMs = 10_000, pollMs = 250) {
  const startedAt = Date.now();
  let lastError = `Timed out waiting for ${url}`;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status} from ${url}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await Bun.sleep(pollMs);
  }

  throw new Error(lastError);
}

async function spawnManagedBinary(
  command: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    timeoutMs: number;
    readinessUrl: string;
  },
) {
  const output = createBoundedOutputCollector({ maxBytes: 16_384, maxLines: 200 });
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });

  const waitForExit = async (): Promise<LocalProcessExit> => {
    const code = await proc.exited;
    return {
      at: nowIso(),
      code,
      signal: "signalCode" in proc && typeof proc.signalCode === "string" ? proc.signalCode : null,
    };
  };

  const pump = async (streamName: "stdout" | "stderr", stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) {
      return;
    }
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          output.finish(streamName);
          return;
        }
        output.pushChunk(streamName, decoder.decode(value, { stream: true }));
      }
    } finally {
      output.finish(streamName);
      reader.releaseLock();
    }
  };

  void pump("stdout", proc.stdout);
  void pump("stderr", proc.stderr);

  try {
    await waitForHttpOk(options.readinessUrl, options.timeoutMs, 200);
  } catch (error) {
    proc.kill();
    const exit = await waitForExit().catch(() => ({ at: nowIso(), code: null, signal: null }));
    const snapshot = output.snapshot();
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Router failed to become ready at ${options.readinessUrl}: ${detail}. Last exit: ${exit.code ?? "null"}.\nCollected output:\n${formatRuntimeOutput(snapshot)}`,
    );
  }

  const handle: ManagedProcessHandle = {
    close() {
      proc.kill();
    },
    getOutput() {
      return output.snapshot();
    },
    proc,
    waitForExit,
  };

  return handle;
}

function ensureRouterStoreSchema(database: Database) {
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      channel TEXT NOT NULL,
      identity_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      directory TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (channel, identity_id, peer_id)
    );
    CREATE TABLE IF NOT EXISTS allowlist (
      channel TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (channel, peer_id)
    );
    CREATE TABLE IF NOT EXISTS bindings (
      channel TEXT NOT NULL,
      identity_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      directory TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (channel, identity_id, peer_id)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function resolveDirectoryFromBindingConfig(config: unknown) {
  const record = asRecord(config);
  for (const key of ["directory", "dir", "path", "workspacePath"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function createInitialChildState(status: RuntimeChildStatus, version: string | null): RuntimeChildState {
  return {
    asset: null,
    baseUrl: null,
    healthUrl: null,
    lastError: null,
    lastExit: null,
    lastReadyAt: null,
    lastStartedAt: null,
    pid: null,
    recentOutput: emptyOutput(),
    running: false,
    status,
    version,
  };
}

export function createRuntimeService(options: CreateRuntimeServiceOptions): RuntimeService {
  const bootstrapPolicy = resolveBootstrapPolicy(options.environment, options.bootstrapPolicy);
  const restartPolicy = resolveRestartPolicy(options.restartPolicy);
  const assetService = options.assetService ?? createRuntimeAssetService({
    environment: options.environment,
    serverVersion: options.serverVersion,
    workingDirectory: options.workingDirectory,
  });
  const persisted = options.repositories.serverRuntimeState.getByServerId(options.serverId);
  const startupDiagnostics = asRecord(asRecord(persisted?.health).startup);
  const opencodeState = createInitialChildState(bootstrapPolicy === "disabled" ? "disabled" : "stopped", persisted?.opencodeVersion ?? null);
  const routerState = createInitialChildState(persisted?.routerStatus === "running" ? "stopped" : "disabled", persisted?.routerVersion ?? null);

  let runtimeManifest: RuntimeManifest | null = null;
  let routerMaterialization: RouterMaterialization | null = null;
  let bootstrapPromise: Promise<void> | null = null;
  let shuttingDown = false;
  let opencodeHandle: LocalOpencodeHandle | null = null;
  let routerHandle: ManagedProcessHandle | null = null;
  let opencodeStopping = false;
  let routerStopping = false;
  let routerEnablement: RouterEnablementDecision = {
    enabled: false,
    enabledBindingCount: 0,
    enabledIdentityCount: 0,
    forced: false,
    reason: "router_not_evaluated",
  };
  let upgradeState: RuntimeUpgradeState = {
    error: null,
    finishedAt: null,
    startedAt: null,
    status: "idle",
  };

  const restartHistory = {
    opencode: [] as number[],
    router: [] as number[],
  };
  const restartTimers = {
    opencode: null as ReturnType<typeof setTimeout> | null,
    router: null as ReturnType<typeof setTimeout> | null,
  };

  const persistState = () => {
    const health = {
      startup: startupDiagnostics,
      runtime: {
        bootstrapPolicy,
        manifest: runtimeManifest,
        opencode: {
          ...opencodeState,
          binaryPath: opencodeState.asset?.absolutePath ?? null,
        },
        restartPolicy,
        router: {
          ...routerState,
          binaryPath: routerState.asset?.absolutePath ?? null,
          enablement: routerEnablement,
          materialization: routerMaterialization,
        },
        target: assetService.getTarget(),
        upgrade: upgradeState,
      },
    };
    const latestExit = pickLatestExit(opencodeState, routerState);

    options.repositories.serverRuntimeState.upsert({
      health,
      lastExit: latestExit,
      lastStartedAt: [opencodeState.lastStartedAt, routerState.lastStartedAt].filter(Boolean).sort().reverse()[0] ?? null,
      opencodeBaseUrl: opencodeState.baseUrl,
      opencodeStatus: opencodeState.status,
      opencodeVersion: opencodeState.version ?? runtimeManifest?.opencodeVersion ?? null,
      restartPolicy: {
        bootstrapPolicy,
        ...restartPolicy,
      },
      routerStatus: routerState.status,
      routerVersion: routerState.version ?? runtimeManifest?.routerVersion ?? null,
      runtimeVersion: options.serverVersion,
      serverId: options.serverId,
    });
  };

  const withRestartRecord = (component: "opencode" | "router") => {
    const now = Date.now();
    const withinWindow = restartHistory[component].filter((value) => now - value <= restartPolicy.windowMs);
    restartHistory[component] = withinWindow;
    if (withinWindow.length >= restartPolicy.maxAttempts) {
      return false;
    }
    restartHistory[component].push(now);
    return true;
  };

  const clearRestartTimer = (component: "opencode" | "router") => {
    const timer = restartTimers[component];
    if (timer) {
      clearTimeout(timer);
      restartTimers[component] = null;
    }
  };

  const resolveRouterEnablement = () => {
    const identities = options.repositories.routerIdentities.listByServer(options.serverId);
    const bindings = options.repositories.routerBindings.listByServer(options.serverId);
    const enabledIdentityCount = identities.filter((identity) => identity.isEnabled).length;
    const enabledBindingCount = bindings.filter((binding) => binding.isEnabled).length;
    const forced = isTruthy(process.env.OPENWORK_SERVER_V2_ROUTER_FORCE) || isTruthy(process.env.OPENWORK_SERVER_V2_ROUTER_REQUIRED);

    if (forced) {
      return {
        enabled: true,
        enabledBindingCount,
        enabledIdentityCount,
        forced: true,
        reason: "router_forced_by_environment",
      } satisfies RouterEnablementDecision;
    }

    if (enabledIdentityCount > 0) {
      return {
        enabled: true,
        enabledBindingCount,
        enabledIdentityCount,
        forced: false,
        reason: "enabled_router_identities_present",
      } satisfies RouterEnablementDecision;
    }

    if (enabledBindingCount > 0) {
      return {
        enabled: true,
        enabledBindingCount,
        enabledIdentityCount,
        forced: false,
        reason: "enabled_router_bindings_present",
      } satisfies RouterEnablementDecision;
    }

    return {
      enabled: false,
      enabledBindingCount,
      enabledIdentityCount,
      forced: false,
      reason: "no_enabled_router_identities_or_bindings",
    } satisfies RouterEnablementDecision;
  };

  const materializeRouterConfig = () => {
    const identities = options.repositories.routerIdentities.listByServer(options.serverId).filter((identity) => identity.isEnabled);
    const bindings = options.repositories.routerBindings.listByServer(options.serverId).filter((binding) => binding.isEnabled);
    const dataDir = path.join(options.workingDirectory.runtimeDir, "router");
    const configPath = path.join(dataDir, "opencode-router.json");
    const dbPath = path.join(dataDir, "opencode-router.db");
    const logFile = path.join(dataDir, "logs", "opencode-router.log");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const identityKindById = new Map(identities.map((identity) => [identity.id, identity.kind]));

    const telegramBots = identities.filter((identity) => identity.kind === "telegram").flatMap((identity) => {
      const auth = asRecord(identity.auth);
      const config = asRecord(identity.config);
      const token = typeof auth.token === "string" ? auth.token.trim() : typeof config.token === "string" ? config.token.trim() : "";
      if (!token) {
        return [];
      }
      return [{
        access: typeof config.access === "string" ? config.access : "public",
        directory: typeof config.directory === "string" ? config.directory.trim() : undefined,
        enabled: true,
        id: identity.id,
        pairingCodeHash: typeof config.pairingCodeHash === "string" ? config.pairingCodeHash.trim() : undefined,
        token,
      }];
    });
    const slackApps = identities.filter((identity) => identity.kind === "slack").flatMap((identity) => {
      const auth = asRecord(identity.auth);
      const config = asRecord(identity.config);
      const botToken = typeof auth.botToken === "string" ? auth.botToken.trim() : typeof config.botToken === "string" ? config.botToken.trim() : "";
      const appToken = typeof auth.appToken === "string" ? auth.appToken.trim() : typeof config.appToken === "string" ? config.appToken.trim() : "";
      if (!botToken || !appToken) {
        return [];
      }
      return [{
        appToken,
        botToken,
        directory: typeof config.directory === "string" ? config.directory.trim() : undefined,
        enabled: true,
        id: identity.id,
      }];
    });

    const configPayload = {
      channels: {
        slack: {
          apps: slackApps,
          enabled: slackApps.length > 0,
        },
        telegram: {
          bots: telegramBots,
          enabled: telegramBots.length > 0,
        },
      },
      groupsEnabled: false,
      opencodeDirectory: options.workingDirectory.rootDir,
      opencodeUrl: opencodeState.baseUrl ?? undefined,
      version: 1,
    };

    fs.writeFileSync(configPath, `${JSON.stringify(configPayload, null, 2)}\n`, "utf8");

    const database = new Database(dbPath, { create: true });
    try {
      ensureRouterStoreSchema(database);
      database.query("DELETE FROM bindings").run();
      const insert = database.query(
        `INSERT OR REPLACE INTO bindings (channel, identity_id, peer_id, directory, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      );
      const now = Date.now();
      let writtenBindings = 0;
      for (const binding of bindings) {
        const channel = identityKindById.get(binding.routerIdentityId);
        const directory = resolveDirectoryFromBindingConfig(binding.config);
        if ((channel !== "telegram" && channel !== "slack") || !directory) {
          continue;
        }
        insert.run(channel, binding.routerIdentityId, binding.bindingKey, directory, now, now);
        writtenBindings += 1;
      }

      routerMaterialization = {
        bindingCount: writtenBindings,
        configPath,
        dataDir,
        dbPath,
        identityCount: telegramBots.length + slackApps.length,
        logFile,
      };
    } finally {
      database.close(false);
    }
  };

  const updateRecentOutput = () => {
    opencodeState.recentOutput = opencodeHandle?.server.getOutput() ?? opencodeState.recentOutput;
    routerState.recentOutput = routerHandle?.getOutput() ?? routerState.recentOutput;
  };

  const stopRouter = async () => {
    clearRestartTimer("router");
    if (!routerHandle) {
      routerState.running = false;
      routerState.pid = null;
      if (routerState.status !== "disabled") {
        routerState.status = "stopped";
      }
      persistState();
      return;
    }

    routerStopping = true;
    const handle = routerHandle;
    routerHandle = null;
    handle.close();
    await handle.waitForExit().catch(() => null);
    routerState.running = false;
    routerState.pid = null;
    routerState.recentOutput = handle.getOutput();
    routerState.status = routerEnablement.enabled ? "stopped" : "disabled";
    persistState();
    routerStopping = false;
  };

  const stopOpencode = async () => {
    clearRestartTimer("opencode");
    if (!opencodeHandle) {
      opencodeState.running = false;
      opencodeState.pid = null;
      opencodeState.status = bootstrapPolicy === "disabled" ? "disabled" : "stopped";
      persistState();
      return;
    }

    opencodeStopping = true;
    const handle = opencodeHandle;
    opencodeHandle = null;
    handle.server.close();
    await handle.server.waitForExit().catch(() => null);
    opencodeState.running = false;
    opencodeState.pid = null;
    opencodeState.recentOutput = handle.server.getOutput();
    opencodeState.status = bootstrapPolicy === "disabled" ? "disabled" : "stopped";
    persistState();
    opencodeStopping = false;
  };

  const startRouter = async () => {
    if (!routerEnablement.enabled) {
      await stopRouter();
      routerState.status = "disabled";
      routerState.lastError = null;
      persistState();
      return;
    }

    if (routerHandle && routerState.running) {
      return;
    }

    if (!runtimeManifest) {
      return;
    }

    if (!opencodeState.running || !opencodeState.baseUrl) {
      routerState.status = "error";
      routerState.lastError = "Router cannot start until OpenCode is running.";
      persistState();
      return;
    }

    routerState.asset = await assetService.ensureRouterBinary();
    routerState.version = routerState.asset.version;
    routerState.status = "starting";
    routerState.lastError = null;
    routerState.lastStartedAt = nowIso();
    materializeRouterConfig();
    const healthPort = Number.parseInt(process.env.OPENWORK_SERVER_V2_ROUTER_HEALTH_PORT ?? "0", 10) || await getFreePort();
    const healthUrl = `http://127.0.0.1:${healthPort}`;
    routerState.healthUrl = healthUrl;
    persistState();

    try {
      const handle = await spawnManagedBinary(
        [
          routerState.asset.absolutePath,
          "serve",
          options.workingDirectory.rootDir,
          "--opencode-url",
          opencodeState.baseUrl,
        ],
        {
          cwd: options.workingDirectory.rootDir,
          env: {
            OPENCODE_DIRECTORY: options.workingDirectory.rootDir,
            OPENCODE_ROUTER_CONFIG_PATH: routerMaterialization?.configPath,
            OPENCODE_ROUTER_DATA_DIR: routerMaterialization?.dataDir,
            OPENCODE_ROUTER_DB_PATH: routerMaterialization?.dbPath,
            OPENCODE_ROUTER_HEALTH_PORT: String(healthPort),
            OPENCODE_ROUTER_LOG_FILE: routerMaterialization?.logFile,
            OPENCODE_URL: opencodeState.baseUrl,
          },
          readinessUrl: `${healthUrl}/health`,
          timeoutMs: Number.parseInt(process.env.OPENWORK_SERVER_V2_ROUTER_START_TIMEOUT_MS ?? "10000", 10) || 10_000,
        },
      );
      routerHandle = handle;
      routerState.baseUrl = healthUrl;
      routerState.lastReadyAt = nowIso();
      routerState.pid = handle.proc.pid ?? null;
      routerState.recentOutput = handle.getOutput();
      routerState.running = true;
      routerState.status = "running";
      persistState();

      void handle.waitForExit().then((exit) => {
        if (routerHandle === handle) {
          routerHandle = null;
        }
        routerState.running = false;
        routerState.pid = null;
        routerState.recentOutput = handle.getOutput();
        routerState.lastExit = {
          ...exit,
          output: handle.getOutput(),
          reason: routerStopping || shuttingDown ? "stopped" : "unexpected_exit",
        };

        if (routerStopping || shuttingDown) {
          routerState.status = routerEnablement.enabled ? "stopped" : "disabled";
          persistState();
          return;
        }

        routerState.status = "crashed";
        persistState();
        if (!withRestartRecord("router")) {
          routerState.lastError = "Router restart policy exhausted.";
          persistState();
          return;
        }

        routerState.status = "restart_scheduled";
        persistState();
        clearRestartTimer("router");
        restartTimers.router = setTimeout(() => {
          if (shuttingDown) {
            return;
          }
          void startRouter().catch((error) => {
            routerState.status = "error";
            routerState.lastError = error instanceof Error ? error.message : String(error);
            persistState();
          });
        }, restartPolicy.backoffMs);
      });
    } catch (error) {
      routerState.running = false;
      routerState.status = "error";
      routerState.lastError = error instanceof Error ? error.message : String(error);
      persistState();
    }
  };

  const startOpencode = async () => {
    const bundle = await assetService.resolveRuntimeBundle();
    runtimeManifest = bundle.manifest;
    opencodeState.asset = bundle.opencode;
    opencodeState.version = bundle.opencode.version;
    routerState.asset = bundle.router;
    routerState.version = bundle.router.version;
    opencodeState.status = bootstrapPolicy === "disabled" ? "disabled" : "starting";
    opencodeState.lastError = null;
    opencodeState.lastStartedAt = nowIso();
    persistState();

    const configuredPort = Number.parseInt(process.env.OPENWORK_SERVER_V2_OPENCODE_PORT ?? "0", 10);
    const handle = await createLocalOpencode({
      binary: bundle.opencode.absolutePath,
      client: {
        directory: options.workingDirectory.rootDir,
        responseStyle: "data",
        throwOnError: true,
      },
      config: {},
      cwd: options.workingDirectory.rootDir,
      hostname: process.env.OPENWORK_SERVER_V2_OPENCODE_HOST?.trim() || "127.0.0.1",
      port: configuredPort > 0 ? configuredPort : await getFreePort(),
      timeout: Number.parseInt(process.env.OPENWORK_SERVER_V2_OPENCODE_START_TIMEOUT_MS ?? "10000", 10) || 10_000,
    });

    try {
      await waitForOpencodeHealthy(handle, 5_000, 200);
    } catch (error) {
      handle.server.close();
      const snapshot = handle.server.getOutput();
      throw new Error(
        `OpenCode became reachable at ${handle.server.url}, but did not pass the SDK health probe: ${error instanceof Error ? error.message : String(error)}.\nCollected output:\n${formatRuntimeOutput(snapshot)}`,
      );
    }

    opencodeHandle = handle;
    opencodeState.baseUrl = handle.server.url;
    opencodeState.lastReadyAt = nowIso();
    opencodeState.pid = handle.server.proc.pid ?? null;
    opencodeState.recentOutput = handle.server.getOutput();
    opencodeState.running = true;
    opencodeState.status = "running";
    persistState();

    void handle.server.waitForExit().then(async (exit) => {
      if (opencodeHandle === handle) {
        opencodeHandle = null;
      }
      opencodeState.running = false;
      opencodeState.pid = null;
      opencodeState.recentOutput = handle.server.getOutput();
      opencodeState.lastExit = {
        ...exit,
        output: handle.server.getOutput(),
        reason: opencodeStopping || shuttingDown ? "stopped" : "unexpected_exit",
      };

      await stopRouter();

      if (opencodeStopping || shuttingDown) {
        opencodeState.status = bootstrapPolicy === "disabled" ? "disabled" : "stopped";
        persistState();
        return;
      }

      opencodeState.status = "crashed";
      persistState();

      if (!withRestartRecord("opencode")) {
        opencodeState.lastError = "OpenCode restart policy exhausted.";
        persistState();
        return;
      }

      opencodeState.status = "restart_scheduled";
      persistState();
      clearRestartTimer("opencode");
      restartTimers.opencode = setTimeout(() => {
        if (shuttingDown) {
          return;
        }

        void bootstrap().catch((error) => {
          opencodeState.status = "error";
          opencodeState.lastError = error instanceof Error ? error.message : String(error);
          persistState();
        });
      }, restartPolicy.backoffMs);
    });
  };

  const bootstrap = async () => {
    if (bootstrapPolicy === "disabled") {
      opencodeState.status = "disabled";
      routerState.status = "disabled";
      persistState();
      return;
    }

    if (bootstrapPromise) {
      return bootstrapPromise;
    }

    bootstrapPromise = (async () => {
      routerEnablement = resolveRouterEnablement();
      persistState();
      try {
        updateRecentOutput();
        if (!opencodeState.running) {
          await startOpencode();
        }
      } catch (error) {
        opencodeState.running = false;
        opencodeState.status = "error";
        opencodeState.lastError = error instanceof Error ? error.message : String(error);
        if (error instanceof LocalOpencodeStartupError) {
          opencodeState.recentOutput = error.output;
          opencodeState.lastExit = {
            at: nowIso(),
            code: null,
            output: error.output,
            reason: error.code,
            signal: null,
          };
        }
        persistState();
        throw error;
      }

      await startRouter();
    })().finally(() => {
      bootstrapPromise = null;
    });

    return bootstrapPromise;
  };

  const applyRouterConfig = async () => {
    routerEnablement = resolveRouterEnablement();
    persistState();

    if (bootstrapPolicy !== "disabled" && !opencodeState.running) {
      await startOpencode();
    }

    if (routerHandle || routerState.running) {
      await stopRouter();
    }

    if (bootstrapPolicy === "disabled") {
      routerState.status = "disabled";
      persistState();
      return;
    }

    await startRouter();
  };

  persistState();

  const service: RuntimeService = {
    async applyRouterConfig() {
      await applyRouterConfig();
      return this.getRouterHealth();
    },

    async bootstrap() {
      await bootstrap();
    },

    async dispose() {
      shuttingDown = true;
      clearRestartTimer("opencode");
      clearRestartTimer("router");
      await stopRouter();
      await stopOpencode();
      persistState();
    },

    getBootstrapPolicy() {
      return bootstrapPolicy;
    },

    getOpencodeHealth() {
      updateRecentOutput();
      return {
        baseUrl: opencodeState.baseUrl,
        binaryPath: opencodeState.asset?.absolutePath ?? null,
        diagnostics: opencodeState.recentOutput,
        lastError: opencodeState.lastError,
        lastExit: opencodeState.lastExit,
        lastReadyAt: opencodeState.lastReadyAt,
        lastStartedAt: opencodeState.lastStartedAt,
        manifest: runtimeManifest,
        pid: opencodeState.pid,
        running: opencodeState.running,
        source: opencodeState.asset?.source ?? assetService.getSource(),
        status: opencodeState.status,
        version: opencodeState.version,
      };
    },

    getRouterHealth() {
      updateRecentOutput();
      return {
        baseUrl: routerState.baseUrl,
        binaryPath: routerState.asset?.absolutePath ?? null,
        diagnostics: routerState.recentOutput,
        enablement: routerEnablement,
        healthUrl: routerState.healthUrl,
        lastError: routerState.lastError,
        lastExit: routerState.lastExit,
        lastReadyAt: routerState.lastReadyAt,
        lastStartedAt: routerState.lastStartedAt,
        manifest: runtimeManifest,
        materialization: routerMaterialization,
        pid: routerState.pid,
        running: routerState.running,
        source: routerState.asset?.source ?? assetService.getSource(),
        status: routerState.status,
        version: routerState.version,
      };
    },

    getRuntimeSummary() {
      return {
        bootstrapPolicy,
        manifest: runtimeManifest,
        opencode: this.getOpencodeHealth(),
        restartPolicy,
        router: this.getRouterHealth(),
        upgrade: upgradeState,
        source: assetService.getSource(),
        target: assetService.getTarget(),
      };
    },

    getRuntimeVersions() {
      const summary = this.getRuntimeSummary();
      return {
        active: {
          opencodeVersion: summary.opencode.version,
          routerVersion: summary.router.version,
          serverVersion: options.serverVersion,
        },
        manifest: summary.manifest,
        pinned: {
          opencodeVersion: summary.manifest?.opencodeVersion ?? null,
          routerVersion: summary.manifest?.routerVersion ?? null,
          serverVersion: options.serverVersion,
        },
        target: summary.target,
      };
    },

    getStateForPersistence(): ReturnType<RuntimeService["getRuntimeSummary"]> {
      return this.getRuntimeSummary();
    },

    async upgradeRuntime() {
      upgradeState = {
        error: null,
        finishedAt: null,
        startedAt: nowIso(),
        status: "running",
      };
      persistState();

      try {
        await stopRouter();
        await stopOpencode();
        runtimeManifest = null;
        opencodeState.asset = null;
        routerState.asset = null;
        await bootstrap();
        upgradeState = {
          error: null,
          finishedAt: nowIso(),
          startedAt: upgradeState.startedAt,
          status: "completed",
        };
        persistState();
        return {
          state: upgradeState,
          summary: this.getRuntimeSummary(),
        };
      } catch (error) {
        upgradeState = {
          error: error instanceof Error ? error.message : String(error),
          finishedAt: nowIso(),
          startedAt: upgradeState.startedAt,
          status: "failed",
        };
        persistState();
        throw error;
      }
    },
  };

  return service;
}
