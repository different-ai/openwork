import { createProcessInfoAdapter, type ProcessInfoAdapter } from "../adapters/process-info.js";
import { createServerPersistence, type ServerPersistence } from "../database/persistence.js";
import { createSqliteDatabaseStatusProvider, type DatabaseStatusProvider } from "../database/status-provider.js";
import type { RegistryService } from "../services/registry-service.js";
import { createSystemService, type SystemService } from "../services/system-service.js";

export type AppDependencies = {
  database: DatabaseStatusProvider;
  environment: string;
  persistence: ServerPersistence;
  processInfo: ProcessInfoAdapter;
  services: {
    registry: RegistryService;
    system: SystemService;
  };
  startedAt: Date;
  version: string;
  close(): void;
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

  return {
    database,
    environment,
    persistence,
    processInfo,
    services: {
      registry: persistence.registry,
      system: createSystemService({
        database,
        environment,
        processInfo,
        startedAt,
        version,
      }),
    },
    startedAt,
    version,
    close() {
      persistence.close();
    },
  };
}
