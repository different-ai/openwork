import {
  createContext,
  createMemo,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js";

import { currentLocale, t } from "../../i18n";
import { isTauriRuntime } from "../utils";

import type {
  MigrationRepairResult,
  SandboxCreateProgressState,
} from "../context/workspace";

export type WorkspaceMaintenanceContextValue = {
  sandboxCreateProgress: Accessor<SandboxCreateProgressState | null>;
  sandboxCreateProgressLast: Accessor<SandboxCreateProgressState | null>;
  repairOpencodeMigration: () => void;
  migrationRepairBusy: Accessor<boolean>;
  migrationRepairResult: Accessor<MigrationRepairResult | null>;
  migrationRepairAvailable: Accessor<boolean>;
  migrationRepairUnavailableReason: Accessor<string | null>;
  repairOpencodeCache: () => void;
  cacheRepairBusy: Accessor<boolean>;
  cacheRepairResult: Accessor<string | null>;
  cleanupOpenworkDockerContainers: () => void;
  dockerCleanupBusy: Accessor<boolean>;
  dockerCleanupResult: Accessor<string | null>;
};

type CreateWorkspaceMaintenanceStoreOptions = {
  sandboxCreateProgress: Accessor<SandboxCreateProgressState | null>;
  sandboxCreateProgressLast: Accessor<SandboxCreateProgressState | null>;
  repairOpencodeMigration: () => void;
  migrationRepairBusy: Accessor<boolean>;
  migrationRepairResult: Accessor<MigrationRepairResult | null>;
  canRepairOpencodeMigration: Accessor<boolean>;
  selectedWorkspaceType: Accessor<string>;
  selectedWorkspacePath: Accessor<string>;
  repairOpencodeCache: () => void;
  cacheRepairBusy: Accessor<boolean>;
  cacheRepairResult: Accessor<string | null>;
  cleanupOpenworkDockerContainers: () => void;
  dockerCleanupBusy: Accessor<boolean>;
  dockerCleanupResult: Accessor<string | null>;
};

export function createWorkspaceMaintenanceStore(
  options: CreateWorkspaceMaintenanceStoreOptions,
): WorkspaceMaintenanceContextValue {
  const migrationRepairUnavailableReason = createMemo<string | null>(() => {
    if (options.canRepairOpencodeMigration()) return null;
    if (!isTauriRuntime()) {
      return t("app.migration.desktop_required", currentLocale());
    }

    if (options.selectedWorkspaceType() !== "local") {
      return t("app.migration.local_only", currentLocale());
    }

    if (!options.selectedWorkspacePath().trim()) {
      return t("app.migration.workspace_required", currentLocale());
    }

    return t("app.migration.local_only", currentLocale());
  });

  return {
    sandboxCreateProgress: options.sandboxCreateProgress,
    sandboxCreateProgressLast: options.sandboxCreateProgressLast,
    repairOpencodeMigration: options.repairOpencodeMigration,
    migrationRepairBusy: options.migrationRepairBusy,
    migrationRepairResult: options.migrationRepairResult,
    migrationRepairAvailable: options.canRepairOpencodeMigration,
    migrationRepairUnavailableReason,
    repairOpencodeCache: options.repairOpencodeCache,
    cacheRepairBusy: options.cacheRepairBusy,
    cacheRepairResult: options.cacheRepairResult,
    cleanupOpenworkDockerContainers: options.cleanupOpenworkDockerContainers,
    dockerCleanupBusy: options.dockerCleanupBusy,
    dockerCleanupResult: options.dockerCleanupResult,
  };
}

const WorkspaceMaintenanceContext = createContext<WorkspaceMaintenanceContextValue | undefined>(undefined);

export function WorkspaceMaintenanceProvider(props: ParentProps<{ value: WorkspaceMaintenanceContextValue }>) {
  return (
    <WorkspaceMaintenanceContext.Provider value={props.value}>
      {props.children}
    </WorkspaceMaintenanceContext.Provider>
  );
}

export function useWorkspaceMaintenance() {
  const context = useContext(WorkspaceMaintenanceContext);
  if (!context) {
    throw new Error("Workspace maintenance context is missing");
  }
  return context;
}
