import type { StartupDiagnostics } from "./types.js";

export type DatabaseStatus = {
  bootstrapMode: "fresh" | "existing";
  configured: true;
  importWarnings: number;
  kind: "sqlite";
  migrations: {
    appliedThisRun: string[];
    currentVersion: string;
    totalApplied: number;
  };
  path: string;
  phaseOwner: 2;
  status: "ready" | "warning";
  summary: string;
  workingDirectory: string;
};

export type DatabaseStatusProvider = {
  getStartupDiagnostics(): StartupDiagnostics;
  getStatus(): DatabaseStatus;
};

export function createSqliteDatabaseStatusProvider(input: { diagnostics: StartupDiagnostics }): DatabaseStatusProvider {
  return {
    getStartupDiagnostics() {
      return input.diagnostics;
    },

    getStatus() {
      const warningCount = input.diagnostics.warnings.length;
      const appliedThisRun = input.diagnostics.migrations.applied;
      const totalVisibleWorkspaces = input.diagnostics.registry.totalVisibleWorkspaces;
      const totalServers = input.diagnostics.registry.totalServers;
      return {
        bootstrapMode: input.diagnostics.mode,
        configured: true,
        importWarnings: warningCount,
        kind: "sqlite",
        migrations: {
          appliedThisRun,
          currentVersion: input.diagnostics.migrations.currentVersion,
          totalApplied: input.diagnostics.migrations.totalApplied,
        },
        path: input.diagnostics.workingDirectory.databasePath,
        phaseOwner: 2,
        status: warningCount > 0 ? "warning" : "ready",
        summary: `SQLite ready with ${totalServers} server record(s), ${totalVisibleWorkspaces} visible workspace(s), and ${warningCount} import warning(s).`,
        workingDirectory: input.diagnostics.workingDirectory.rootDir,
      };
    },
  };
}
