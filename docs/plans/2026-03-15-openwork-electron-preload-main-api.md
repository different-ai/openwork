# OpenWork Electron Preload/Main API Surface

> Canonical status: this is the contract-level source of truth for renderer-to-desktop Electron APIs during the migration.
>
> Program-level plan: `docs/plans/2026-03-15-openwork-desktop-tauri-to-electron-migration.md`
>
> Execution queue: `docs/plans/2026-03-15-openwork-desktop-tauri-to-electron-migration/steps.json`
>
> Shared learnings log: `docs/plans/2026-03-15-openwork-desktop-tauri-to-electron-migration/learnings.md`
>
> This document defines the exact Electron desktop contract that replaces the current Tauri/Rust renderer bridge. It is a spec only; no runtime code changes happen here.

## Goal

Define the Electron preload API, IPC channel scheme, main-process service ownership, and event contract required to preserve current OpenWork desktop capabilities while removing all Tauri and Rust desktop dependencies.

## Contract Rules

1. Renderer code never calls Electron or Node directly.
2. Renderer code never calls `ipcRenderer` directly.
3. Preload exposes one typed global: `window.openworkDesktop`.
4. Main handles all privileged work: file system mutation, shell open/reveal, dialogs, child-process management, updater, deep links, scheduler, Docker, and destructive resets.
5. The preload contract replaces both:
   - direct `@tauri-apps/*` imports in the renderer, and
   - the Tauri command bridge currently wrapped by `packages/app/src/app/lib/tauri.ts`.

## Shared Type Strategy

Before implementing Electron, extract the reusable DTOs currently defined in `packages/app/src/app/lib/tauri.ts` into a shared contract module.

Recommended future file:

- `packages/app/src/app/lib/desktop-contract.ts`

Move these existing types there without semantic changes:

- `EngineInfo`
- `OpenworkServerInfo`
- `OrchestratorStatus`
- `OrchestratorWorkspace`
- `OrchestratorDetachedHost`
- `EngineDoctorResult`
- `WorkspaceInfo`
- `WorkspaceList`
- `WorkspaceOpenworkConfig`
- `WorkspaceExportSummary`
- `ExecResult`
- `LocalSkillCard`
- `LocalSkillContent`
- `OpencodeConfigFile`
- `UpdaterEnvironment`
- `ScheduledJob`
- `OpenCodeRouterStatus`
- `OpenCodeRouterStatusResult`
- `OpenCodeRouterInfo`
- `SandboxDoctorResult`
- `SandboxDebugProbeResult`
- `OpenworkDockerCleanupResult`
- `CacheResetResult`
- `ObsidianMirrorFileContent`
- `AppBuildInfo`

## Preload Global

```ts
declare global {
  interface Window {
    openworkDesktop?: OpenWorkDesktopAPI;
  }
}

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
```

## Things Explicitly Not Exposed

These are intentionally out of the preload contract:

- raw `fs` access
- raw `child_process` access
- raw `ipcRenderer`
- raw Electron objects (`BrowserWindow`, `webContents`, `shell`, `dialog`, `app`)
- unrestricted arbitrary HTTP proxying
- unrestricted arbitrary command execution

If the renderer needs a new capability, add a typed method for that capability instead of opening a generic primitive.

## IPC Channel Convention

Every preload method maps to one `ipcMain.handle` channel using this format:

- `openwork:<namespace>:<method>`

Examples:

- `openwork:app:getVersion`
- `openwork:window:setZoomFactor`
- `openwork:dialogs:pickDirectory`
- `openwork:workspace:bootstrap`
- `openwork:engine:start`
- `openwork:orchestrator:sandboxDebugProbe`
- `openwork:router:getGroupsEnabled`

Event channels use this format:

- `openwork:event:<name>`

Required event channels:

- `openwork:event:deepLinkOpen`
- `openwork:event:updateStatus`
- `openwork:event:sandboxCreateProgress`
- `openwork:event:reloadRequired`

## Main-Process Service Ownership

Create one service module per privileged concern. These names are the recommended implementation shape for Electron main.

| Namespace | Main service | Responsibilities |
| --- | --- | --- |
| `runtime` | `runtime-service.ts` | app metadata, platform/arch/dev state |
| `app` | `app-service.ts` | version, build info, relaunch, dev-config nuke/exit |
| `window` | `window-service.ts` | decorations, zoom factor, desktop window state |
| `dialogs` | `dialog-service.ts` | file and directory pickers, save dialogs |
| `shell` | `shell-service.ts` | open external URL, open path, reveal file/folder |
| `paths` | `path-service.ts` | home/downloads resolution, path join, tilde expansion |
| `deepLinks` | `deep-link-service.ts` | protocol registration, pending URL queue, runtime delivery |
| `updates` | `update-service.ts` | updater environment, check, download, install, progress events |
| `workspace` | `workspace-service.ts` | workspace registry, local worker creation, config import/export, authorized roots, `.opencode/openwork.json` |
| `commandFiles` | `command-file-service.ts` | local command markdown CRUD |
| `config` | `config-service.ts` | project/global `opencode.json(c)` read/write |
| `skills` | `skill-service.ts` | local skills read/write/template install/import |
| `packages` | `opkg-service.ts` | `opkg` install wrapper |
| `engine` | `engine-service.ts` | local OpenCode resolution, doctor, start/stop/restart/install |
| `orchestrator` | `orchestrator-service.ts` | orchestrator lifecycle, detached start, Docker sandbox helpers, sandbox events |
| `openworkServer` | `openwork-server-service.ts` | local OpenWork server lifecycle |
| `router` | `router-service.ts` | `opencode-router` lifecycle and localhost config/status access |
| `cache` | `cache-service.ts` | destructive local cleanup and reset actions |
| `obsidian` | `obsidian-service.ts` | app availability probe, shell integration, mirror files |
| `scheduler` | `scheduler-service.ts` | launchd/systemd task list/delete support |
| `opencode` | `opencode-admin-service.ts` | OpenCode DB migrate and MCP auth wrappers |
| `events` | `event-bus.ts` | typed fan-out from main services to renderer subscriptions |

## Event Contract

### `openwork:event:deepLinkOpen`

Payload:

```ts
type DesktopDeepLinkEvent = {
  urls: string[];
  source: "initial" | "runtime";
};
```

Used to replace `@tauri-apps/plugin-deep-link` current + runtime flows in `packages/app/src/app/app.tsx`.

### `openwork:event:updateStatus`

Payload:

```ts
type DesktopUpdateStatusEvent =
  | { state: "checking" }
  | { state: "idle"; checkedAt: number | null }
  | { state: "available"; checkedAt: number; version: string; date?: string | null; notes?: string | null }
  | {
      state: "downloading";
      checkedAt: number;
      version: string;
      downloadedBytes: number;
      totalBytes: number | null;
      notes?: string | null;
    }
  | { state: "ready"; checkedAt: number; version: string; notes?: string | null }
  | { state: "error"; checkedAt: number | null; message: string };
```

Used to replace direct updater callback objects from `@tauri-apps/plugin-updater` in `packages/app/src/app/system-state.ts`.

### `openwork:event:sandboxCreateProgress`

Payload:

```ts
type SandboxCreateProgressEvent = {
  runId?: string;
  stage?: string;
  message?: string;
  payload?: unknown;
};
```

Used to replace `listen("openwork://sandbox-create-progress", ...)` in `packages/app/src/app/context/workspace.ts`.

### `openwork:event:reloadRequired`

Payload:

```ts
type ReloadRequiredEvent = {
  workspaceId?: string | null;
  reason?: string | null;
  path?: string | null;
  trigger?: string | null;
};
```

This keeps parity with the existing workspace watcher behavior even though the current app currently treats older reload-required delivery as legacy.

## Direct Replacement Map For Current Renderer Code

| Current renderer dependency | Electron replacement |
| --- | --- |
| `window.__TAURI_INTERNALS__` | `window.openworkDesktop != null` |
| `invoke("...")` | namespaced preload methods |
| `@tauri-apps/plugin-dialog` | `window.openworkDesktop.dialogs.*` |
| `@tauri-apps/plugin-opener` | `window.openworkDesktop.shell.*` |
| `@tauri-apps/api/path` | `window.openworkDesktop.paths.*` |
| `@tauri-apps/api/app#getVersion` | `window.openworkDesktop.app.getVersion()` |
| `@tauri-apps/plugin-process#relaunch` | `window.openworkDesktop.app.relaunch()` |
| `@tauri-apps/api/webview#getCurrentWebview` zoom logic | `window.openworkDesktop.window.getZoomFactor()` and `setZoomFactor()` |
| `@tauri-apps/plugin-deep-link` | `window.openworkDesktop.deepLinks.getPending()` and `onOpen()` |
| `@tauri-apps/api/event#listen` for sandbox progress | `window.openworkDesktop.orchestrator.onSandboxCreateProgress()` |
| direct updater plugin object methods | `window.openworkDesktop.updates.*` |

## HTTP / Fetch Policy

Tauri's HTTP plugin should not get a 1:1 Electron preload replacement by default.

Baseline decision:

- renderer uses standard `fetch` for OpenWork server, OpenCode, and router localhost HTTP calls

Fallback only if needed:

- add a narrowly scoped `loopbackHttp.request()` preload API restricted to `127.0.0.1`, `localhost`, and `::1`

Do not expose a generic native HTTP proxy unless direct renderer `fetch` proves insufficient.

## Security Requirements

1. `contextIsolation: true`
2. `sandbox: true` unless a proven blocker exists
3. `nodeIntegration: false`
4. strict preload allowlist only
5. validate every incoming path, URL, workspace ID, and server name in main
6. never expose arbitrary spawn/exec/file APIs to renderer
7. all sidecar execution paths must come from resolved allowed locations only
8. event subscriptions must be typed and individually removable

## Recommended Implementation Layout

Recommended future Electron files:

- `packages/desktop/src/main/main.ts`
- `packages/desktop/src/main/preload.ts`
- `packages/desktop/src/main/ipc/register-ipc.ts`
- `packages/desktop/src/main/services/runtime-service.ts`
- `packages/desktop/src/main/services/app-service.ts`
- `packages/desktop/src/main/services/window-service.ts`
- `packages/desktop/src/main/services/dialog-service.ts`
- `packages/desktop/src/main/services/shell-service.ts`
- `packages/desktop/src/main/services/path-service.ts`
- `packages/desktop/src/main/services/deep-link-service.ts`
- `packages/desktop/src/main/services/update-service.ts`
- `packages/desktop/src/main/services/workspace-service.ts`
- `packages/desktop/src/main/services/command-file-service.ts`
- `packages/desktop/src/main/services/config-service.ts`
- `packages/desktop/src/main/services/skill-service.ts`
- `packages/desktop/src/main/services/opkg-service.ts`
- `packages/desktop/src/main/services/engine-service.ts`
- `packages/desktop/src/main/services/orchestrator-service.ts`
- `packages/desktop/src/main/services/openwork-server-service.ts`
- `packages/desktop/src/main/services/router-service.ts`
- `packages/desktop/src/main/services/cache-service.ts`
- `packages/desktop/src/main/services/obsidian-service.ts`
- `packages/desktop/src/main/services/scheduler-service.ts`
- `packages/desktop/src/main/services/opencode-admin-service.ts`
- `packages/desktop/src/main/services/event-bus.ts`

## Cutover Plan For Renderer Code

1. Add the new shared DTO module.
2. Add `window.openworkDesktop` preload contract.
3. Replace `isTauriRuntime()` with a generic desktop runtime check based on `window.openworkDesktop`.
4. Reimplement `packages/app/src/app/lib/tauri.ts` on top of `window.openworkDesktop` as a temporary compatibility shim.
5. Replace remaining direct Tauri imports in:
   - `packages/app/src/app/app.tsx`
   - `packages/app/src/app/system-state.ts`
   - `packages/app/src/app/context/workspace.ts`
   - `packages/app/src/app/context/extensions.ts`
   - `packages/app/src/app/pages/session.tsx`
   - `packages/app/src/app/pages/settings.tsx`
   - `packages/app/src/app/pages/mcp.tsx`
   - `packages/app/src/app/pages/dashboard.tsx`
   - `packages/app/src/app/components/part-view.tsx`
   - `packages/app/src/app/components/provider-auth-modal.tsx`
   - `packages/app/src/app/components/mcp-auth-modal.tsx`
   - `packages/app/src/index.tsx`
6. Rename `packages/app/src/app/lib/tauri.ts` to something Electron-neutral only after the migration shim is no longer needed.

## Bottom Line

This contract gives OpenWork a complete Electron-native replacement for the current Tauri bridge without leaving behind Tauri or Rust desktop artifacts.

The important part is not just replacing `invoke(...)`; it is replacing every privileged desktop capability with a typed, namespaced, preload-safe API that keeps feature parity while moving ownership to Electron main or other OpenWork-owned services.
