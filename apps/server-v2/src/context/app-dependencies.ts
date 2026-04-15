import { createProcessInfoAdapter, type ProcessInfoAdapter } from "../adapters/process-info.js";
import { createPhase1DatabaseStatusProvider, type DatabaseStatusProvider } from "../database/status-provider.js";
import { createSystemService, type SystemService } from "../services/system-service.js";

export type AppDependencies = {
  database: DatabaseStatusProvider;
  environment: string;
  processInfo: ProcessInfoAdapter;
  services: {
    system: SystemService;
  };
  startedAt: Date;
  version: string;
};

export function createAppDependencies(overrides: Partial<Omit<AppDependencies, "services">> = {}): AppDependencies {
  const environment = overrides.environment ?? process.env.NODE_ENV ?? "development";
  const startedAt = overrides.startedAt ?? new Date();
  const version = overrides.version ?? "0.0.0";
  const database = overrides.database ?? createPhase1DatabaseStatusProvider();
  const processInfo = overrides.processInfo ?? createProcessInfoAdapter(environment);

  return {
    database,
    environment,
    processInfo,
    services: {
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
  };
}
