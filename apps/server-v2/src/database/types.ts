export type ServerKind = "local" | "remote";
export type HostingKind = "desktop" | "self_hosted" | "cloud";
export type WorkspaceKind = "local" | "remote" | "control" | "help";
export type WorkspaceStatus = "ready" | "imported" | "attention";
export type BackendKind = "local_opencode" | "remote_openwork";
export type ImportStatus = "error" | "imported" | "skipped" | "unavailable";

export type JsonObject = Record<string, unknown>;

export type ServerRecord = {
  auth: JsonObject | null;
  baseUrl: string | null;
  capabilities: JsonObject;
  createdAt: string;
  hostingKind: HostingKind;
  id: string;
  isEnabled: boolean;
  isLocal: boolean;
  kind: ServerKind;
  label: string;
  lastSeenAt: string | null;
  notes: JsonObject | null;
  source: string;
  updatedAt: string;
};

export type WorkspaceRecord = {
  configDir: string | null;
  createdAt: string;
  dataDir: string | null;
  displayName: string;
  id: string;
  isHidden: boolean;
  kind: WorkspaceKind;
  notes: JsonObject | null;
  opencodeProjectId: string | null;
  remoteWorkspaceId: string | null;
  serverId: string;
  slug: string;
  status: WorkspaceStatus;
  updatedAt: string;
};

export type ServerRuntimeStateRecord = {
  health: JsonObject | null;
  lastExit: JsonObject | null;
  lastStartedAt: string | null;
  opencodeBaseUrl: string | null;
  opencodeStatus: string;
  opencodeVersion: string | null;
  restartPolicy: JsonObject | null;
  routerStatus: string;
  routerVersion: string | null;
  runtimeVersion: string | null;
  serverId: string;
  updatedAt: string;
};

export type WorkspaceRuntimeStateRecord = {
  backendKind: BackendKind;
  health: JsonObject | null;
  lastError: JsonObject | null;
  lastSessionRefreshAt: string | null;
  lastSyncAt: string | null;
  updatedAt: string;
  workspaceId: string;
};

export type ServerConfigStateRecord = {
  opencode: JsonObject;
  serverId: string;
  updatedAt: string;
};

export type WorkspaceConfigStateRecord = {
  openwork: JsonObject;
  opencode: JsonObject;
  updatedAt: string;
  workspaceId: string;
};

export type ManagedSource = "cloud_synced" | "discovered" | "imported" | "openwork_managed";

export type ManagedConfigRecord = {
  auth: JsonObject | null;
  cloudItemId: string | null;
  config: JsonObject;
  createdAt: string;
  displayName: string;
  id: string;
  key: string | null;
  metadata: JsonObject | null;
  source: ManagedSource;
  updatedAt: string;
};

export type WorkspaceAssignmentRecord = {
  createdAt: string;
  itemId: string;
  updatedAt: string;
  workspaceId: string;
};

export type CloudSigninRecord = {
  auth: JsonObject | null;
  cloudBaseUrl: string;
  createdAt: string;
  id: string;
  lastValidatedAt: string | null;
  metadata: JsonObject | null;
  orgId: string | null;
  serverId: string;
  updatedAt: string;
  userId: string | null;
};

export type WorkspaceShareRecord = {
  accessKey: string | null;
  audit: JsonObject | null;
  createdAt: string;
  id: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: "active" | "disabled" | "revoked";
  updatedAt: string;
  workspaceId: string;
};

export type RouterIdentityRecord = {
  auth: JsonObject | null;
  config: JsonObject;
  createdAt: string;
  displayName: string;
  id: string;
  isEnabled: boolean;
  kind: string;
  serverId: string;
  updatedAt: string;
};

export type RouterBindingRecord = {
  config: JsonObject;
  createdAt: string;
  bindingKey: string;
  id: string;
  isEnabled: boolean;
  routerIdentityId: string;
  serverId: string;
  updatedAt: string;
};

export type MigrationRecord = {
  appliedAt: string;
  checksum: string;
  name: string;
  version: string;
};

export type MigrationResult = {
  applied: string[];
  currentVersion: string;
  totalApplied: number;
};

export type ImportSourceReport = {
  details: JsonObject;
  sourcePath: string | null;
  status: ImportStatus;
  warnings: string[];
};

export type StartupDiagnostics = {
  completedAt: string;
  importReports: {
    cloudSignin: ImportSourceReport;
    desktopWorkspaceState: ImportSourceReport;
    orchestratorAuth: ImportSourceReport;
    orchestratorState: ImportSourceReport;
  };
  legacyWorkspaceImport: {
    completedAt: string | null;
    skipped: boolean;
  };
  mode: "fresh" | "existing";
  migrations: MigrationResult;
  registry: {
    hiddenWorkspaceIds: string[];
    localServerCreated: boolean;
    localServerId: string;
    totalServers: number;
    totalVisibleWorkspaces: number;
  };
  warnings: string[];
  workingDirectory: {
    databasePath: string;
    rootDir: string;
    workspacesDir: string;
  };
};
