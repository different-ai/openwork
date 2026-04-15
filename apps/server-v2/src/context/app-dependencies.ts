import { createAuthService, type AuthService } from "../services/auth-service.js";
import { createCapabilitiesService, type CapabilitiesService } from "../services/capabilities-service.js";
import { createProcessInfoAdapter, type ProcessInfoAdapter } from "../adapters/process-info.js";
import { createServerPersistence, type ServerPersistence } from "../database/persistence.js";
import { createSqliteDatabaseStatusProvider, type DatabaseStatusProvider } from "../database/status-provider.js";
import type { RuntimeAssetService } from "../runtime/assets.js";
import type { RegistryService } from "../services/registry-service.js";
import { createServerRegistryService, type ServerRegistryService } from "../services/server-registry-service.js";
import { createRuntimeService, type RuntimeService } from "../services/runtime-service.js";
import { createWorkspaceSessionService, type WorkspaceSessionService } from "../services/workspace-session-service.js";
import { createSystemService, type SystemService } from "../services/system-service.js";
import { createWorkspaceRegistryService, type WorkspaceRegistryService } from "../services/workspace-registry-service.js";

export type AppDependencies = {
  database: DatabaseStatusProvider;
  environment: string;
  persistence: ServerPersistence;
  processInfo: ProcessInfoAdapter;
  services: {
    auth: AuthService;
    capabilities: CapabilitiesService;
    registry: RegistryService;
    runtime: RuntimeService;
    sessions: WorkspaceSessionService;
    serverRegistry: ServerRegistryService;
    system: SystemService;
    workspaceRegistry: WorkspaceRegistryService;
  };
  startedAt: Date;
  version: string;
  close(): Promise<void>;
};

type CreateAppDependenciesOverrides = Partial<Omit<AppDependencies, "services" | "close" | "database" | "persistence">> & {
  inMemory?: boolean;
  legacy?: {
    cloudSigninJson?: string;
    cloudSigninPath?: string;
    desktopDataDir?: string;
    orchestratorDataDir?: string;
  };
  localServer?: {
    baseUrl?: string | null;
    hostingKind?: "cloud" | "desktop" | "self_hosted";
    label?: string;
  };
  persistence?: ServerPersistence;
  runtime?: {
    assetService?: RuntimeAssetService;
    bootstrapPolicy?: "disabled" | "eager" | "manual";
    restartPolicy?: {
      backoffMs?: number;
      maxAttempts?: number;
      windowMs?: number;
    };
  };
  workingDirectory?: string;
};

function isTruthy(value: string | undefined) {
  if (!value) {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function resolveLocalHostingKind(explicit?: "cloud" | "desktop" | "self_hosted") {
  if (explicit) {
    return explicit;
  }

  const fromEnv = process.env.OPENWORK_SERVER_V2_HOSTING_KIND?.trim();
  if (fromEnv === "desktop" || fromEnv === "self_hosted" || fromEnv === "cloud") {
    return fromEnv;
  }

  if (isTruthy(process.env.OPENWORK_DESKTOP_HOSTED) || Boolean(process.env.TAURI_ENV_PLATFORM)) {
    return "desktop";
  }

  return "self_hosted";
}

export function createAppDependencies(overrides: CreateAppDependenciesOverrides = {}): AppDependencies {
  const environment = overrides.environment ?? process.env.NODE_ENV ?? "development";
  const startedAt = overrides.startedAt ?? new Date();
  const version = overrides.version ?? "0.0.0";
  const processInfo = overrides.processInfo ?? createProcessInfoAdapter(environment);
  const persistence = overrides.persistence ?? createServerPersistence({
    environment,
    inMemory: overrides.inMemory,
    legacy: overrides.legacy,
    localServer: {
      baseUrl: overrides.localServer?.baseUrl ?? null,
      hostingKind: resolveLocalHostingKind(overrides.localServer?.hostingKind),
      label: overrides.localServer?.label ?? "Local OpenWork Server",
    },
    version,
    workingDirectory: overrides.workingDirectory,
  });
  const database = createSqliteDatabaseStatusProvider({ diagnostics: persistence.diagnostics });
  const auth = createAuthService();
  const serverRegistry = createServerRegistryService({
    localServerId: persistence.registry.localServerId,
    repositories: persistence.repositories,
  });
  const workspaceRegistry = createWorkspaceRegistryService({
    repositories: persistence.repositories,
    servers: serverRegistry,
  });
  const runtime = createRuntimeService({
    assetService: overrides.runtime?.assetService,
    bootstrapPolicy: overrides.runtime?.bootstrapPolicy,
    environment,
    repositories: persistence.repositories,
    restartPolicy: overrides.runtime?.restartPolicy,
    serverId: persistence.registry.localServerId,
    serverVersion: version,
    workingDirectory: persistence.workingDirectory,
  });
  const capabilities = createCapabilitiesService({
    auth,
    runtime,
  });
  const sessions = createWorkspaceSessionService({
    repositories: persistence.repositories,
    runtime,
  });

  return {
    database,
    environment,
    persistence,
    processInfo,
    services: {
      auth,
      capabilities,
      registry: persistence.registry,
      runtime,
      sessions,
      serverRegistry,
      system: createSystemService({
        auth,
        capabilities,
        database,
        environment,
        processInfo,
        serverRegistry,
        runtime,
        startedAt,
        version,
        workspaceRegistry,
      }),
      workspaceRegistry,
    },
    startedAt,
    version,
    async close() {
      await runtime.dispose();
      persistence.close();
    },
  };
}
