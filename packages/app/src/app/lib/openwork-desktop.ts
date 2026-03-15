import type {
  AppBuildInfo,
  CacheResetResult,
  EngineDoctorResult,
  EngineInfo,
  ExecResult,
  LocalSkillCard,
  LocalSkillContent,
  ObsidianMirrorFileContent,
  OpenCodeRouterInfo,
  OpenCodeRouterStatus,
  OpencodeConfigFile,
  OpenworkDockerCleanupResult,
  OpenworkServerInfo,
  OrchestratorDetachedHost,
  OrchestratorStatus,
  OrchestratorWorkspace,
  SandboxDebugProbeResult,
  SandboxDoctorResult,
  ScheduledJob,
  UpdaterEnvironment,
  WorkspaceExportSummary,
  WorkspaceList,
  WorkspaceOpenworkConfig,
} from "./desktop-contract";

export type DesktopUnsubscribe = () => void;

export type DesktopRuntimeInfo = {
  contractVersion: 1;
  runtime: "electron";
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  isPackaged: boolean;
  isDev: boolean;
};

export type DesktopUpdateCheckResult =
  | { available: false; checkedAt: number }
  | {
      available: true;
      checkedAt: number;
      version: string;
      date?: string | null;
      notes?: string | null;
    };

export type DesktopUpdateStatusEvent =
  | { state: "checking" }
  | { state: "idle"; checkedAt: number | null }
  | {
      state: "available";
      checkedAt: number;
      version: string;
      date?: string | null;
      notes?: string | null;
    }
  | {
      state: "downloading";
      checkedAt: number;
      version: string;
      downloadedBytes: number;
      totalBytes: number | null;
      notes?: string | null;
    }
  | {
      state: "ready";
      checkedAt: number;
      version: string;
      notes?: string | null;
    }
  | { state: "error"; checkedAt: number | null; message: string };

export type DesktopDeepLinkEvent = {
  urls: string[];
  source: "initial" | "runtime";
};

export type SandboxCreateProgressEvent = {
  runId?: string;
  stage?: string;
  message?: string;
  payload?: unknown;
};

export type ReloadRequiredEvent = {
  workspaceId?: string | null;
  reason?: string | null;
  path?: string | null;
  trigger?: string | null;
};

export interface OpenWorkDesktopAPI {
  runtime: {
    getInfo(): Promise<DesktopRuntimeInfo>;
  };

  app: {
    getVersion(): Promise<string>;
    getBuildInfo(): Promise<AppBuildInfo>;
    relaunch(): Promise<void>;
    nukeDevConfigAndExit(): Promise<void>;
  };

  window: {
    setDecorations(input: { decorations: boolean }): Promise<void>;
    getZoomFactor(): Promise<number>;
    setZoomFactor(input: { factor: number }): Promise<number>;
  };

  dialogs: {
    pickDirectory(input?: {
      title?: string;
      defaultPath?: string;
      multiple?: boolean;
    }): Promise<string | string[] | null>;
    pickFile(input?: {
      title?: string;
      defaultPath?: string;
      multiple?: boolean;
      filters?: Array<{ name: string; extensions: string[] }>;
    }): Promise<string | string[] | null>;
    saveFile(input?: {
      title?: string;
      defaultPath?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    }): Promise<string | null>;
  };

  shell: {
    openExternal(input: { url: string }): Promise<void>;
    openPath(input: { path: string }): Promise<void>;
    revealItemInDir(input: { path: string }): Promise<void>;
  };

  paths: {
    home(): Promise<string>;
    downloads(): Promise<string>;
    join(input: { segments: string[] }): Promise<string>;
    expandUser(input: { path: string }): Promise<string>;
  };

  deepLinks: {
    getPending(): Promise<string[]>;
    onOpen(listener: (event: DesktopDeepLinkEvent) => void): DesktopUnsubscribe;
  };

  updates: {
    getEnvironment(): Promise<UpdaterEnvironment>;
    check(input?: { timeoutMs?: number }): Promise<DesktopUpdateCheckResult>;
    download(): Promise<void>;
    installAndRelaunch(): Promise<void>;
    onStatus(listener: (event: DesktopUpdateStatusEvent) => void): DesktopUnsubscribe;
  };

  workspace: {
    bootstrap(): Promise<WorkspaceList>;
    setActive(input: { workspaceId: string }): Promise<WorkspaceList>;
    create(input: { folderPath: string; name: string; preset: string }): Promise<WorkspaceList>;
    createRemote(input: {
      baseUrl: string;
      directory?: string | null;
      displayName?: string | null;
      remoteType?: "openwork" | "opencode" | null;
      openworkHostUrl?: string | null;
      openworkToken?: string | null;
      openworkWorkspaceId?: string | null;
      openworkWorkspaceName?: string | null;
      sandboxBackend?: "docker" | null;
      sandboxRunId?: string | null;
      sandboxContainerName?: string | null;
    }): Promise<WorkspaceList>;
    updateRemote(input: {
      workspaceId: string;
      baseUrl?: string | null;
      directory?: string | null;
      displayName?: string | null;
      remoteType?: "openwork" | "opencode" | null;
      openworkHostUrl?: string | null;
      openworkToken?: string | null;
      openworkWorkspaceId?: string | null;
      openworkWorkspaceName?: string | null;
      sandboxBackend?: "docker" | null;
      sandboxRunId?: string | null;
      sandboxContainerName?: string | null;
    }): Promise<WorkspaceList>;
    updateDisplayName(input: {
      workspaceId: string;
      displayName?: string | null;
    }): Promise<WorkspaceList>;
    forget(input: { workspaceId: string }): Promise<WorkspaceList>;
    addAuthorizedRoot(input: {
      workspacePath: string;
      folderPath: string;
    }): Promise<ExecResult>;
    openworkRead(input: { workspacePath: string }): Promise<WorkspaceOpenworkConfig>;
    openworkWrite(input: {
      workspacePath: string;
      config: WorkspaceOpenworkConfig;
    }): Promise<ExecResult>;
    exportConfig(input: {
      workspaceId: string;
      outputPath: string;
    }): Promise<WorkspaceExportSummary>;
    importConfig(input: {
      archivePath: string;
      targetDir: string;
      name?: string | null;
    }): Promise<WorkspaceList>;
    onReloadRequired(listener: (event: ReloadRequiredEvent) => void): DesktopUnsubscribe;
  };

  commandFiles: {
    list(input: { scope: "workspace" | "global"; projectDir: string }): Promise<string[]>;
    write(input: {
      scope: "workspace" | "global";
      projectDir: string;
      command: {
        name: string;
        description?: string;
        template: string;
        agent?: string;
        model?: string;
        subtask?: boolean;
      };
    }): Promise<ExecResult>;
    delete(input: {
      scope: "workspace" | "global";
      projectDir: string;
      name: string;
    }): Promise<ExecResult>;
  };

  config: {
    readOpencode(input: {
      scope: "project" | "global";
      projectDir: string;
    }): Promise<OpencodeConfigFile>;
    writeOpencode(input: {
      scope: "project" | "global";
      projectDir: string;
      content: string;
    }): Promise<ExecResult>;
  };

  skills: {
    listLocal(input: { projectDir: string }): Promise<LocalSkillCard[]>;
    readLocal(input: { projectDir: string; name: string }): Promise<LocalSkillContent>;
    writeLocal(input: { projectDir: string; name: string; content: string }): Promise<ExecResult>;
    installTemplate(input: {
      projectDir: string;
      name: string;
      content: string;
      overwrite?: boolean;
    }): Promise<ExecResult>;
    uninstall(input: { projectDir: string; name: string }): Promise<ExecResult>;
    importFromDirectory(input: {
      projectDir: string;
      sourceDir: string;
      overwrite?: boolean;
    }): Promise<ExecResult>;
  };

  packages: {
    opkgInstall(input: { projectDir: string; package: string }): Promise<ExecResult>;
  };

  engine: {
    info(): Promise<EngineInfo>;
    start(input: {
      projectDir: string;
      preferSidecar?: boolean;
      runtime?: "direct" | "openwork-orchestrator";
      workspacePaths?: string[];
      opencodeBinPath?: string | null;
    }): Promise<EngineInfo>;
    stop(): Promise<EngineInfo>;
    restart(): Promise<EngineInfo>;
    doctor(input?: {
      preferSidecar?: boolean;
      opencodeBinPath?: string | null;
    }): Promise<EngineDoctorResult>;
    install(): Promise<ExecResult>;
  };

  orchestrator: {
    status(): Promise<OrchestratorStatus>;
    activateWorkspace(input: {
      workspacePath: string;
      name?: string | null;
    }): Promise<OrchestratorWorkspace>;
    disposeInstance(input: { workspacePath: string }): Promise<boolean>;
    startDetached(input: {
      workspacePath: string;
      sandboxBackend?: "none" | "docker" | null;
      runId?: string | null;
      openworkToken?: string | null;
      openworkHostToken?: string | null;
    }): Promise<OrchestratorDetachedHost>;
    sandboxDoctor(): Promise<SandboxDoctorResult>;
    sandboxStop(input: { containerName: string }): Promise<ExecResult>;
    sandboxCleanupOpenworkContainers(): Promise<OpenworkDockerCleanupResult>;
    sandboxDebugProbe(): Promise<SandboxDebugProbeResult>;
    onSandboxCreateProgress(
      listener: (event: SandboxCreateProgressEvent) => void,
    ): DesktopUnsubscribe;
  };

  openworkServer: {
    info(): Promise<OpenworkServerInfo>;
    restart(): Promise<OpenworkServerInfo>;
  };

  router: {
    info(): Promise<OpenCodeRouterInfo>;
    status(): Promise<OpenCodeRouterStatus>;
    start(input: {
      workspacePath: string;
      opencodeUrl?: string;
      opencodeUsername?: string;
      opencodePassword?: string;
      healthPort?: number;
    }): Promise<OpenCodeRouterInfo>;
    stop(): Promise<OpenCodeRouterInfo>;
    restart(input: {
      workspacePath: string;
      opencodeUrl?: string;
      opencodeUsername?: string;
      opencodePassword?: string;
      healthPort?: number;
    }): Promise<OpenCodeRouterInfo>;
    getGroupsEnabled(): Promise<boolean | null>;
    setGroupsEnabled(input: { enabled: boolean }): Promise<ExecResult>;
  };

  cache: {
    resetOpenworkState(input: { mode: "onboarding" | "all" }): Promise<void>;
    resetOpencodeCache(): Promise<CacheResetResult>;
  };

  obsidian: {
    isAvailable(): Promise<boolean>;
    open(input: { filePath: string }): Promise<void>;
    writeMirrorFile(input: {
      workspaceId: string;
      filePath: string;
      content: string;
    }): Promise<string>;
    readMirrorFile(input: {
      workspaceId: string;
      filePath: string;
    }): Promise<ObsidianMirrorFileContent>;
  };

  scheduler: {
    listJobs(input?: { scopeRoot?: string }): Promise<ScheduledJob[]>;
    deleteJob(input: { name: string; scopeRoot?: string }): Promise<ScheduledJob>;
  };

  opencode: {
    dbMigrate(input: {
      projectDir: string;
      preferSidecar?: boolean;
      opencodeBinPath?: string | null;
    }): Promise<ExecResult>;
    mcpAuth(input: { projectDir: string; serverName: string }): Promise<ExecResult>;
  };
}

declare global {
  interface Window {
    openworkDesktop?: OpenWorkDesktopAPI;
  }
}
