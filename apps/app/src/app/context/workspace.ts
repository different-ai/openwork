import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { listen, type Event as TauriEvent } from "@tauri-apps/api/event";
import type { Session } from "@opencode-ai/sdk/v2/client";

import type {
  Client,
  StartupPreference,
  OnboardingStep,
  WorkspaceDisplay,
  WorkspaceOpenworkConfig,
  WorkspacePreset,
  WorkspaceConnectionState,
  EngineRuntime,
} from "../types";
import {
  addOpencodeCacheHint,
  clearStartupPreference,
  isTauriRuntime,
  normalizeDirectoryPath,
  readStartupPreference,
  safeStringify,
  writeStartupPreference,
} from "../utils";
import { unwrap } from "../lib/opencode";
import { recordDevLog } from "../lib/dev-log";
import { describeDirectoryScope, resolveScopedClientDirectory, toSessionTransportDirectory } from "../lib/session-scope";
import { blueprintMaterializedSessions, blueprintSessions, defaultBlueprintSessionsForPreset } from "../lib/workspace-blueprints";
import {
  buildOpenworkWorkspaceBaseUrl,
  createOpenworkServerClient,
  normalizeOpenworkServerUrl,
  parseOpenworkWorkspaceIdFromUrl,
  OpenworkServerError,
  type OpenworkServerClient,
  type OpenworkWorkspaceInfo,
} from "../lib/openwork-server";
import { downloadDir, homeDir } from "@tauri-apps/api/path";
import {
  engineDoctor,
  engineInfo,
  engineInstall,
  engineStart,
  engineStop,
  sandboxDoctor,
  orchestratorInstanceDispose,
  orchestratorStartDetached,
  orchestratorWorkspaceActivate,
  pickFile,
  pickDirectory,
  saveFile,
  workspaceBootstrap,
  workspaceCreate,
  workspaceCreateRemote,
  workspaceExportConfig,
  workspaceForget,
  workspaceImportConfig,
  workspaceOpenworkRead,
  workspaceOpenworkWrite,
  workspaceSetRuntimeActive,
  workspaceSetSelected,
  workspaceUpdateDisplayName,
  workspaceUpdateRemote,
  resolveWorkspaceListSelectedId,
  type EngineDoctorResult,
  type EngineInfo,
  type SandboxDoctorResult,
  type WorkspaceInfo,
} from "../lib/tauri";
import type { BootPhase, StartupBranch } from "../lib/startup-boot";
import { waitForHealthy, createClient, type OpencodeAuth } from "../lib/opencode";
import type { OpencodeConnectStatus, ProviderListItem } from "../types";
import { t, currentLocale } from "../../i18n";
import { filterProviderList, mapConfigProvidersToList } from "../utils/providers";
import { buildDefaultWorkspaceBlueprint, normalizeWorkspaceOpenworkConfig } from "../lib/workspace-blueprints";
import type { OpenworkServerStore } from "../connections/openwork-server-store";

export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;

export type WorkspaceDebugEvent = {
  at: number;
  label: string;
  payload?: unknown;
};

export type SandboxCreateProgressStepStatus = "pending" | "active" | "done" | "error";

export type SandboxCreateProgressStep = {
  key: "docker" | "workspace" | "sandbox" | "health" | "connect";
  label: string;
  status: SandboxCreateProgressStepStatus;
  detail?: string | null;
};

export type SandboxCreateProgressState = {
  runId: string;
  startedAt: number;
  stage: string;
  steps: SandboxCreateProgressStep[];
  logs: string[];
  error: string | null;
};

export type SandboxCreatePhase = "idle" | "preflight" | "provisioning" | "finalizing";

type BlueprintSeedMessage = { role?: "assistant" | "user" | null; text?: string | null };

type RuntimeWorkspaceLookup = {
  workspaceId?: string | null;
  directoryHint?: string | null;
  localRoot?: string | null;
  strictMatch?: boolean;
};

export function createWorkspaceStore(options: {
  startupPreference: () => StartupPreference | null;
  setStartupPreference: (value: StartupPreference | null) => void;
  onboardingStep: () => OnboardingStep;
  setOnboardingStep: (step: OnboardingStep) => void;
  rememberStartupChoice: () => boolean;
  setRememberStartupChoice: (value: boolean) => void;
  baseUrl: () => string;
  setBaseUrl: (value: string) => void;
  clientDirectory: () => string;
  setClientDirectory: (value: string) => void;
  client: () => Client | null;
  setClient: (value: Client | null) => void;
  setConnectedVersion: (value: string | null) => void;
  setSseConnected: (value: boolean) => void;
  setProviders: (value: ProviderListItem[]) => void;
  setProviderDefaults: (value: Record<string, string>) => void;
  setProviderConnectedIds: (value: string[]) => void;
  setError: (value: string | null) => void;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
  loadSessions: (scopeRoot?: string) => Promise<void>;
  refreshPendingPermissions: () => Promise<void>;
  refreshWorkspaceSessions?: (workspaceId: string) => Promise<void>;
  sessions: () => Session[];
  sessionsLoaded: () => boolean;
  creatingSession: () => boolean;
  readLastSessionByWorkspace?: () => Record<string, string>;
  selectedSessionId: () => string | null;
  selectSession: (id: string, options?: { skipHealthCheck?: boolean; source?: string }) => Promise<void>;
  setBlueprintSeedMessagesBySessionId: (
    updater: (current: Record<string, BlueprintSeedMessage[]>) => Record<string, BlueprintSeedMessage[]>,
  ) => void;
  setSelectedSessionId: (value: string | null) => void;
  setMessages: (value: any[]) => void;
  setTodos: (value: any[]) => void;
  setPendingPermissions: (value: any[]) => void;
  setSessionStatusById: (value: Record<string, string>) => void;
  defaultModel: () => any;
  modelVariant: () => string | null;
  refreshSkills: (options?: { force?: boolean }) => Promise<void>;
  refreshPlugins: () => Promise<void>;
  engineSource: () => "path" | "sidecar" | "custom";
  engineCustomBinPath?: () => string;
  opencodeEnableExa?: () => boolean;
  setEngineSource: (value: "path" | "sidecar" | "custom") => void;
  setView: (value: any, sessionId?: string) => void;
  setSettingsTab: (value: any) => void;
  isWindowsPlatform: () => boolean;
  openworkServer: OpenworkServerStore;
  openworkEnvWorkspaceId?: string | null;
  setOpencodeConnectStatus?: (status: OpencodeConnectStatus | null) => void;
  onEngineStable?: () => void;
  onBootPhaseChange?: (phase: BootPhase, detail?: Record<string, unknown>) => void;
  onStartupBranch?: (branch: StartupBranch, detail?: Record<string, unknown>) => void;
  onStartupTrace?: (event: string, detail?: Record<string, unknown>) => void;
  engineRuntime?: () => EngineRuntime;
  developerMode: () => boolean;
  pendingInitialSessionSelection?: () => { workspaceId: string; title: string | null; readyAt: number } | null;
  setPendingInitialSessionSelection?: (input: { workspaceId: string; title: string | null; readyAt: number } | null) => void;
}) {

  const wsDebugEnabled = () => options.developerMode();

  const WORKSPACE_DEBUG_EVENT_LIMIT = 200;
  const [workspaceDebugEvents, setWorkspaceDebugEvents] = createSignal<WorkspaceDebugEvent[]>([]);
  const clearWorkspaceDebugEvents = () => setWorkspaceDebugEvents([]);
  const pushWorkspaceDebugEvent = (label: string, payload?: unknown) => {
    if (!wsDebugEnabled()) return;
    const entry: WorkspaceDebugEvent = { at: Date.now(), label, payload };
    setWorkspaceDebugEvents((prev) => {
      if (!prev.length) return [entry];
      const sliceStart = Math.max(0, prev.length - WORKSPACE_DEBUG_EVENT_LIMIT + 1);
      const next = prev.slice(sliceStart);
      next.push(entry);
      return next;
    });
  };

  const wsDebug = (label: string, payload?: unknown) => {
    if (!wsDebugEnabled()) return;
    try {
      recordDevLog(true, { level: "debug", source: "workspace", label, payload });
      if (payload === undefined) {
        console.log(`[WSDBG] ${label}`);
      } else {
        console.log(`[WSDBG] ${label}`, payload);
      }
      pushWorkspaceDebugEvent(label, payload);
    } catch {
      // ignore
    }
  };

  const connectInFlightByKey = new Map<string, Promise<boolean>>();
  let createRemoteInFlight: Promise<boolean> | null = null;
  const DEFAULT_CONNECT_HEALTH_TIMEOUT_MS = 12_000;
  const LOCAL_BOOT_CONNECT_HEALTH_TIMEOUT_MS = 180_000;
  const LONG_BOOT_CONNECT_REASONS = new Set(["host-start", "bootstrap-local"]);
  const DEFAULT_WORKSPACE_HOME_FOLDER_NAME = "OpenWork";
  const FIRST_RUN_WELCOME_WORKSPACE_NAME = "Welcome";
  const preferredInitialSessionTitleForPreset = (preset: WorkspacePreset) => {
    const trimmed = defaultBlueprintSessionsForPreset(preset)
      .find((session) => session.openOnFirstLoad === true)?.title?.trim();
    return trimmed || null;
  };

  const queuePendingInitialSessionSelection = (workspaceId: string | null, preset: WorkspacePreset) => {
    const preferredInitialSessionTitle = preferredInitialSessionTitleForPreset(preset);
    if (!workspaceId) {
      options.setPendingInitialSessionSelection?.(null);
      return;
    }
    options.setPendingInitialSessionSelection?.({
      workspaceId,
      title: preferredInitialSessionTitle,
      readyAt: Date.now() + 2_000,
    });
  };

  const connectRequestKey = (
    nextBaseUrl: string,
    directory?: string,
    context?: {
      workspaceId?: string;
      workspaceType?: WorkspaceInfo["workspaceType"];
      targetRoot?: string;
      reason?: string;
    },
    auth?: OpencodeAuth,
    connectOptions?: { quiet?: boolean; navigate?: boolean },
  ) =>
    [
      nextBaseUrl.trim(),
      (directory ?? "").trim(),
      context?.workspaceId?.trim() ?? "",
      context?.workspaceType ?? "",
      context?.targetRoot?.trim() ?? "",
      context?.reason ?? "",
      auth?.mode ?? (auth ? "basic" : "none"),
      String(connectOptions?.quiet ?? false),
      String(connectOptions?.navigate ?? true),
    ].join("::");

  const resolveConnectHealthTimeoutMs = (reason?: string) => {
    const normalizedReason = reason?.trim() ?? "";
    if (LONG_BOOT_CONNECT_REASONS.has(normalizedReason)) {
      return LOCAL_BOOT_CONNECT_HEALTH_TIMEOUT_MS;
    }
    return DEFAULT_CONNECT_HEALTH_TIMEOUT_MS;
  };

  const [engine, setEngine] = createSignal<EngineInfo | null>(null);
  const [engineAuth, setEngineAuth] = createSignal<OpencodeAuth | null>(null);
  const [engineDoctorResult, setEngineDoctorResult] = createSignal<EngineDoctorResult | null>(null);
  const [engineDoctorCheckedAt, setEngineDoctorCheckedAt] = createSignal<number | null>(null);
  const [engineInstallLogs, setEngineInstallLogs] = createSignal<string | null>(null);
  const [sandboxDoctorResult, setSandboxDoctorResult] = createSignal<SandboxDoctorResult | null>(null);
  const [sandboxDoctorCheckedAt, setSandboxDoctorCheckedAt] = createSignal<number | null>(null);
  const [sandboxDoctorBusy, setSandboxDoctorBusy] = createSignal(false);
  const [sandboxPreflightBusy, setSandboxPreflightBusy] = createSignal(false);
  const [sandboxCreatePhase, setSandboxCreatePhase] = createSignal<SandboxCreatePhase>("idle");

  const [sandboxCreateProgress, setSandboxCreateProgress] = createSignal<SandboxCreateProgressState | null>(null);
  const [lastSandboxCreateProgress, setLastSandboxCreateProgress] =
    createSignal<SandboxCreateProgressState | null>(null);
  const clearSandboxCreateProgress = () => {
    const snapshot = sandboxCreateProgress();
    if (snapshot) {
      setLastSandboxCreateProgress(snapshot);
    }
    setSandboxCreateProgress(null);
  };

  const pushSandboxCreateLog = (line: string) => {
    const value = String(line ?? "").trim();
    if (!value) return;
    setSandboxCreateProgress((prev) => {
      if (!prev) return prev;
      const nextLogs = prev.logs.length ? prev.logs.slice(-119) : [];
      // Avoid rapid duplicates.
      const last = nextLogs[nextLogs.length - 1] ?? "";
      if (last !== value) nextLogs.push(value);
      return { ...prev, logs: nextLogs };
    });
  };

  const setSandboxStep = (key: SandboxCreateProgressStep["key"], patch: Partial<SandboxCreateProgressStep>) => {
    setSandboxCreateProgress((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        steps: prev.steps.map((step) => (step.key === key ? { ...step, ...patch } : step)),
      };
    });
  };

  const setSandboxStage = (stage: string) => {
    const value = String(stage ?? "").trim();
    if (!value) return;
    setSandboxCreateProgress((prev) => (prev ? { ...prev, stage: value } : prev));
  };

  const setSandboxError = (message: string) => {
    const value = String(message ?? "").trim() || "Sandbox failed to start";
    setSandboxCreateProgress((prev) => (prev ? { ...prev, error: value } : prev));
  };

  const makeRunId = () => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  };
  let lastEngineReconnectAt = 0;
  let reconnectingEngine = false;

  const [projectDir, setProjectDir] = createSignal("");
  const [workspaces, setWorkspaces] = createSignal<WorkspaceInfo[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = createSignal<string>("");

  const syncSelectedWorkspaceId = (id: string) => {
    setSelectedWorkspaceId(id);
  };

  const pickSelectedWorkspaceId = (
    nextWorkspaces: WorkspaceInfo[],
    preferredIds: Array<string | null | undefined> = [],
    fallbackList?: { selectedId?: string; activeId?: string | null } | null,
  ) => {
    for (const candidate of preferredIds) {
      const id = candidate?.trim() ?? "";
      if (id && nextWorkspaces.some((workspace) => workspace.id === id)) {
        return id;
      }
    }

    const responseId = resolveWorkspaceListSelectedId(fallbackList);
    if (responseId && nextWorkspaces.some((workspace) => workspace.id === responseId)) {
      return responseId;
    }

    return nextWorkspaces[0]?.id ?? "";
  };

  const applyServerLocalWorkspaces = (nextLocals: WorkspaceInfo[], nextActiveId: string | null | undefined) => {
    const remotes = workspaces().filter((workspace) => workspace.workspaceType === "remote");
    const merged = [...nextLocals, ...remotes];
    setWorkspaces(merged);

    syncSelectedWorkspaceId(
      pickSelectedWorkspaceId(merged, [selectedWorkspaceId()], { activeId: nextActiveId ?? null }),
    );
  };

  const [authorizedDirs, setAuthorizedDirs] = createSignal<string[]>([]);
  const [newAuthorizedDir, setNewAuthorizedDir] = createSignal("");

  const [workspaceConfig, setWorkspaceConfig] = createSignal<WorkspaceOpenworkConfig | null>(null);
  const [workspaceConfigLoaded, setWorkspaceConfigLoaded] = createSignal(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = createSignal(false);
  const [createRemoteWorkspaceOpen, setCreateRemoteWorkspaceOpen] = createSignal(false);
  const [editRemoteWorkspaceOpen, setEditRemoteWorkspaceOpen] = createSignal(false);
  const [editRemoteWorkspaceId, setEditRemoteWorkspaceId] = createSignal<string | null>(null);
  const [editRemoteWorkspaceError, setEditRemoteWorkspaceError] = createSignal<string | null>(null);
  const [renameWorkspaceOpen, setRenameWorkspaceOpen] = createSignal(false);
  const [renameWorkspaceId, setRenameWorkspaceId] = createSignal<string | null>(null);
  const [renameWorkspaceName, setRenameWorkspaceName] = createSignal("");
  const [renameWorkspaceBusy, setRenameWorkspaceBusy] = createSignal(false);
  const [connectingWorkspaceId, setConnectingWorkspaceId] = createSignal<string | null>(null);
  const [connectedWorkspaceId, setConnectedWorkspaceId] = createSignal<string | null>(null);
  const [runtimeWorkspaceId, setRuntimeWorkspaceId] = createSignal<string | null>(null);
  const [runtimeWorkspaceConfigById, setRuntimeWorkspaceConfigById] = createSignal<
    Record<string, WorkspaceOpenworkConfig | null>
  >({});
  const [workspaceConnectionStateById, setWorkspaceConnectionStateById] = createSignal<
    Record<string, WorkspaceConnectionState>
  >({});
  const [blueprintSessionMaterializeBusyByWorkspaceId, setBlueprintSessionMaterializeBusyByWorkspaceId] =
    createSignal<Record<string, boolean>>({});
  const [blueprintSessionMaterializeAttemptedByWorkspaceId, setBlueprintSessionMaterializeAttemptedByWorkspaceId] =
    createSignal<Record<string, boolean>>({});
  const [exportingWorkspaceConfig, setExportingWorkspaceConfig] = createSignal(false);
  const [importingWorkspaceConfig, setImportingWorkspaceConfig] = createSignal(false);
  const selectedWorkspaceInfo = createMemo(() => workspaces().find((w) => w.id === selectedWorkspaceId()) ?? null);
  const connectedWorkspaceInfo = createMemo(() => {
    const id = connectedWorkspaceId()?.trim() ?? "";
    if (!id) return null;
    return workspaces().find((workspace) => workspace.id === id) ?? null;
  });

  const selectedWorkspaceDisplay = createMemo<WorkspaceDisplay>(() => {
    const ws = selectedWorkspaceInfo();
    if (!ws) {
      return {
        id: "",
        name: "Worker",
        path: "",
        preset: "minimal",
        workspaceType: "local",
        remoteType: "opencode",
        baseUrl: null,
        directory: null,
        displayName: null,
        openworkHostUrl: null,
        openworkWorkspaceId: null,
        openworkWorkspaceName: null,
      };
    }
    const displayName =
      ws.displayName?.trim() ||
      ws.openworkWorkspaceName?.trim() ||
      ws.name ||
      ws.openworkHostUrl ||
      ws.baseUrl ||
      ws.path ||
      "Worker";
    return { ...ws, name: displayName };
  });
  const normalizeRemoteType = (value?: WorkspaceInfo["remoteType"] | null) =>
    value === "openwork" ? "openwork" : "opencode";
  const isOpenworkRemote = (workspace: WorkspaceInfo | null) =>
    Boolean(workspace && workspace.workspaceType === "remote" && normalizeRemoteType(workspace.remoteType) === "openwork");
  const selectedWorkspacePath = createMemo(() => {
    const ws = selectedWorkspaceInfo();
    if (!ws) return "";
    if (ws.workspaceType === "remote") return ws.directory?.trim() ?? "";
    return ws.path ?? "";
  });
  const selectedWorkspaceRoot = createMemo(() => selectedWorkspacePath().trim());
  const resolveWorkspaceRuntimeRoot = (workspace: WorkspaceInfo | null | undefined) => {
    if (!workspace) return "";
    if (workspace.workspaceType === "remote") {
      return workspace.directory?.trim() ?? workspace.path?.trim() ?? "";
    }
    return workspace.path?.trim() ?? "";
  };
  const resolveCurrentRuntimeRoot = () => {
    const connectedRoot = resolveWorkspaceRuntimeRoot(connectedWorkspaceInfo());
    if (connectedRoot) return connectedRoot;
    const engineRoot = engine()?.projectDir?.trim() ?? "";
    if (engineRoot) return engineRoot;
    return projectDir().trim();
  };
  const runtimeWorkspaceRoot = createMemo(() => resolveCurrentRuntimeRoot().trim());
  const workspaceRootForId = (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return "";
    return resolveWorkspaceRuntimeRoot(workspaces().find((workspace) => workspace.id === id) ?? null);
  };
  const runtimeWorkspaceConfig = createMemo(() => {
    const id = runtimeWorkspaceId()?.trim() ?? "";
    if (!id) return null;
    return runtimeWorkspaceConfigById()[id] ?? null;
  });

  const editRemoteWorkspaceDefaults = createMemo(() => {
    const workspaceId = editRemoteWorkspaceId();
    if (!workspaceId) return null;
    const workspace = workspaces().find((item) => item.id === workspaceId) ?? null;
    if (!workspace || workspace.workspaceType !== "remote") return null;
    const openworkHostUrl =
      normalizeRemoteType(workspace.remoteType) === "openwork"
        ? buildOpenworkWorkspaceBaseUrl(
            workspace.openworkHostUrl?.trim() ?? "",
            workspace.openworkWorkspaceId,
          ) ||
          workspace.openworkHostUrl?.trim() ||
          workspace.baseUrl?.trim() ||
          ""
        : workspace.openworkHostUrl?.trim() || workspace.baseUrl?.trim() || "";
    return {
      openworkHostUrl,
      openworkToken: workspace.openworkToken ?? options.openworkServer.openworkServerSettings().token ?? "",
      directory: workspace.directory ?? "",
      displayName: workspace.displayName ?? "",
    };
  });

  const clearSelectedSessionSurface = () => {
    options.setSelectedSessionId(null);
    options.setMessages([]);
    options.setTodos([]);
    options.setPendingPermissions([]);
    options.setSessionStatusById({});
  };

  const resolveWorkspaceEntryId = (input: {
    workspaceId?: string | null;
    workspaceType?: WorkspaceInfo["workspaceType"];
    targetRoot?: string | null;
    directory?: string | null;
  }) => {
    const explicit = input.workspaceId?.trim() ?? "";
    if (explicit && workspaces().some((workspace) => workspace.id === explicit)) {
      return explicit;
    }

    const scope = normalizeDirectoryPath(input.targetRoot ?? input.directory ?? "");
    if (!scope) return null;

    const match = workspaces().find((workspace) => {
      const workspaceScope = normalizeDirectoryPath(
        workspace.workspaceType === "remote"
          ? workspace.directory?.trim() ?? workspace.path?.trim() ?? ""
          : workspace.path?.trim() ?? "",
      );
      if (!workspaceScope || workspaceScope !== scope) return false;
      if (input.workspaceType && workspace.workspaceType !== input.workspaceType) return false;
      return true;
    });

    return match?.id ?? null;
  };

  const applySelectedWorkspacePresentation = async (workspace: WorkspaceInfo) => {
    syncSelectedWorkspaceId(workspace.id);
    if (workspace.workspaceType === "remote") {
      setProjectDir(workspace.directory?.trim() ?? "");
      setWorkspaceConfig(null);
      setWorkspaceConfigLoaded(true);
      setAuthorizedDirs([]);
      return;
    }

    setProjectDir(workspace.path);

    if (isTauriRuntime()) {
      setWorkspaceConfigLoaded(false);
      try {
        const cfg = await loadWorkspaceConfigFromOpenworkServer(workspace.path)
          ?? await workspaceOpenworkRead({ workspacePath: workspace.path });
        setWorkspaceConfig(cfg);
        setWorkspaceConfigLoaded(true);

        const roots = Array.isArray(cfg.authorizedRoots) ? cfg.authorizedRoots : [];
        if (roots.length) {
          setAuthorizedDirs(roots);
        } else {
          setAuthorizedDirs([workspace.path]);
        }
      } catch {
        setWorkspaceConfig(null);
        setWorkspaceConfigLoaded(true);
        setAuthorizedDirs([workspace.path]);
      }
      return;
    }

    if (!authorizedDirs().includes(workspace.path)) {
      const merged = authorizedDirs().length ? authorizedDirs().slice() : [];
      if (!merged.includes(workspace.path)) merged.push(workspace.path);
      setAuthorizedDirs(merged);
    }
  };

  async function applyWorkspaceSelection(workspaceId: string) {
    const id = workspaceId.trim();
    if (!id) return false;
    const workspace = workspaces().find((entry) => entry.id === id) ?? null;
    if (!workspace) return false;
    const changed = selectedWorkspaceId() !== id;

    await applySelectedWorkspacePresentation(workspace);

    if (changed) {
      clearSelectedSessionSurface();
    }

    if (isTauriRuntime()) {
      try {
        await workspaceSetSelected(id);
      } catch {
        // ignore
      }
    }

    return true;
  }

  async function selectWorkspace(workspaceId: string) {
    return await applyWorkspaceSelection(workspaceId);
  }

  async function switchWorkspace(workspaceId: string) {
    const id = workspaceId.trim();
    if (!id) return false;
    const prevProjectDir = resolveCurrentRuntimeRoot();
    return await activateWorkspace(id, { prevProjectDir });
  }

  const updateWorkspaceConnectionState = (
    workspaceId: string,
    next: Partial<WorkspaceConnectionState>,
  ) => {
    const id = workspaceId.trim();
    if (!id) return;
    setWorkspaceConnectionStateById((prev) => {
      const current = prev[id] ?? { status: "idle", message: null, checkedAt: null };
      return {
        ...prev,
        [id]: {
          ...current,
          ...next,
          checkedAt: Date.now(),
        },
      };
    });
  };

  const clearWorkspaceConnectionState = (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    setWorkspaceConnectionStateById((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  createEffect(() => {
    const ids = new Set(workspaces().map((workspace) => workspace.id));
    setWorkspaceConnectionStateById((prev) => {
      let changed = false;
      const next: Record<string, WorkspaceConnectionState> = {};
      for (const [id, state] of Object.entries(prev)) {
        if (!ids.has(id)) {
          changed = true;
          continue;
        }
        next[id] = state;
      }
      return changed ? next : prev;
    });
  });

  createEffect(() => {
    const client = options.openworkServer.openworkServerClient();
    const status = options.openworkServer.openworkServerStatus();
    const connectedWorkspace = connectedWorkspaceInfo();

    if (!client || status !== "connected" || !connectedWorkspace) {
      setRuntimeWorkspaceId(null);
      return;
    }

    const lookup = resolveRuntimeWorkspaceLookup(connectedWorkspace);
    if (!lookup) {
      setRuntimeWorkspaceId(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      const resolved = await ensureRuntimeWorkspaceId(lookup);
      if (cancelled) return;
      if (!resolved) {
        setRuntimeWorkspaceId(null);
      }
    })();

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    const client = options.openworkServer.openworkServerClient();
    const status = options.openworkServer.openworkServerStatus();
    const workspaceId = runtimeWorkspaceId()?.trim() ?? "";

    if (!client || status !== "connected" || !workspaceId) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        await refreshRuntimeWorkspaceConfig(workspaceId);
      } catch {
        if (cancelled) return;
      }
    })();

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    const workspaceId = (runtimeWorkspaceId() ?? "").trim();
    const client = options.openworkServer.openworkServerClient();
    const connected = options.openworkServer.openworkServerStatus() === "connected";
    const root = selectedWorkspaceRoot().trim();
    const config = runtimeWorkspaceConfig() ?? workspaceConfig();
    const templates = blueprintSessions(config);
    const materialized = blueprintMaterializedSessions(config);
    const currentSessions = options.sessions();
    const normalizedRoot = normalizeDirectoryPath(root);
    const hasWorkspaceSessions = currentSessions.some((session) => {
      const directory = typeof session.directory === "string" ? session.directory : "";
      return normalizeDirectoryPath(directory) === normalizedRoot;
    });

    if (!workspaceId || !client || !connected) return;
    if (!root) return;
    if (!options.sessionsLoaded()) return;
    if (options.creatingSession()) return;
    if (options.selectedSessionId()) return;
    if (!templates.length) return;
    if (materialized.length > 0) return;
    if (hasWorkspaceSessions) return;
    if (blueprintSessionMaterializeBusyByWorkspaceId()[workspaceId]) return;
    if (blueprintSessionMaterializeAttemptedByWorkspaceId()[workspaceId]) return;

    setBlueprintSessionMaterializeBusyByWorkspaceId((current) => ({
      ...current,
      [workspaceId]: true,
    }));

    void (async () => {
      try {
        const result = await client.materializeBlueprintSessions(workspaceId);
        const templateMessages = new Map(
          templates.map((template) => [template.id?.trim(), (template.messages ?? []).filter((entry) => entry?.text?.trim())] as const),
        );
        if (result.created.length > 0) {
          options.setBlueprintSeedMessagesBySessionId((current) => {
            const next = { ...current };
            result.created.forEach((entry) => {
              const messages = templateMessages.get(entry.templateId?.trim());
              if (messages && messages.length > 0) {
                next[entry.sessionId] = messages;
              }
            });
            return next;
          });
        }
        setBlueprintSessionMaterializeAttemptedByWorkspaceId((current) => ({
          ...current,
          [workspaceId]: true,
        }));
        await refreshRuntimeWorkspaceConfig(workspaceId);
        await options.loadSessions(root || undefined);
        const pending = options.pendingInitialSessionSelection?.() ?? null;
        const shouldDeferInitialOpen = Boolean(pending && pending.workspaceId === workspaceId);
        if (result.openSessionId && !shouldDeferInitialOpen) {
          options.setView("session", result.openSessionId);
          await options.selectSession(result.openSessionId, {
            skipHealthCheck: true,
            source: "blueprint-open-session",
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : safeStringify(error);
        options.setError(addOpencodeCacheHint(message));
      } finally {
        setBlueprintSessionMaterializeBusyByWorkspaceId((current) => {
          const next = { ...current };
          delete next[workspaceId];
          return next;
        });
      }
    })();
  });

  const resolveOpenworkHost = async (input: {
    hostUrl: string;
    token?: string | null;
    workspaceId?: string | null;
    directoryHint?: string | null;
  }) => {
    let normalizedHostUrl = normalizeOpenworkServerUrl(input.hostUrl) ?? "";
    if (!normalizedHostUrl) {
      return { kind: "fallback" as const };
    }

    let inferredWorkspaceId: string | null = null;
    try {
      const url = new URL(normalizedHostUrl);
      const segments = url.pathname.split("/").filter(Boolean);
      const last = segments[segments.length - 1] ?? "";
      const prev = segments[segments.length - 2] ?? "";
      const alreadyMounted = prev === "w" && Boolean(last);
      if (alreadyMounted) {
        inferredWorkspaceId = decodeURIComponent(last);
        const baseSegments = segments.slice(0, -2);
        url.pathname = `/${baseSegments.join("/")}`;
        normalizedHostUrl = url.toString().replace(/\/+$/, "");
      }
    } catch {
      // ignore
    }

    const requestedWorkspaceId = (input.workspaceId?.trim() || inferredWorkspaceId || "").trim();
    const workspaceBaseUrl = buildOpenworkWorkspaceBaseUrl(normalizedHostUrl, requestedWorkspaceId) ?? normalizedHostUrl;

    const client = createOpenworkServerClient({ baseUrl: workspaceBaseUrl, token: input.token ?? undefined });

    const trimmedToken = input.token?.trim() ?? "";

    try {
      const health = await client.health();
      if (!health?.ok) {
        return { kind: "fallback" as const };
      }
    } catch (error) {
      if (error instanceof OpenworkServerError && (error.status === 401 || error.status === 403)) {
        if (!trimmedToken) {
          throw new Error("Access token required for OpenWork server.");
        }
        throw new Error("OpenWork server rejected the access token.");
      }
      return { kind: "fallback" as const };
    }

    if (!trimmedToken) {
      throw new Error("Access token required for OpenWork server.");
    }

    const response = await client.listWorkspaces();
    const items = Array.isArray(response.items) ? response.items : [];
    const hint = normalizeDirectoryPath(input.directoryHint ?? "");
    const selectByHint = (entry: OpenworkWorkspaceInfo) => {
      if (!hint) return false;
      const entryPath = normalizeDirectoryPath(
        (entry.opencode?.directory as string | undefined) ?? (entry.path as string | undefined) ?? "",
      );
      return Boolean(entryPath && entryPath === hint);
    };
    const selectById = (entry: OpenworkWorkspaceInfo) => Boolean(requestedWorkspaceId && entry?.id === requestedWorkspaceId);

    const workspaceById = requestedWorkspaceId
      ? (items.find((item) => item?.id && selectById(item as any)) as OpenworkWorkspaceInfo | undefined)
      : undefined;
    if (requestedWorkspaceId && !workspaceById) {
      throw new Error("OpenWork worker not found on that host.");
    }

    const workspaceByHint = hint
      ? (items.find((item) => item?.id && selectByHint(item as any)) as OpenworkWorkspaceInfo | undefined)
      : undefined;

    const workspace = (workspaceById ?? workspaceByHint ?? items[0]) as OpenworkWorkspaceInfo | undefined;
    if (!workspace?.id) {
      throw new Error("OpenWork server did not return a worker.");
    }
    const opencodeUpstreamBaseUrl = workspace.opencode?.baseUrl?.trim() ?? workspace.baseUrl?.trim() ?? "";
    if (!opencodeUpstreamBaseUrl) {
      throw new Error("OpenWork server did not provide an OpenCode URL.");
    }

    const workspaceScopedBaseUrl =
      buildOpenworkWorkspaceBaseUrl(normalizedHostUrl, workspace.id) ?? workspaceBaseUrl;
    const opencodeBaseUrl = `${workspaceScopedBaseUrl.replace(/\/+$/, "")}/opencode`;
    const opencodeAuth: OpencodeAuth | undefined = trimmedToken
      ? { token: trimmedToken, mode: "openwork" }
      : undefined;

    return {
      kind: "openwork" as const,
      hostUrl: normalizedHostUrl,
      workspace,
      opencodeBaseUrl,
      directory: workspace.opencode?.directory?.trim() ?? workspace.directory?.trim() ?? "",
      auth: opencodeAuth,
    };
  };

  const resolveEngineRuntime = () => options.engineRuntime?.() ?? "openwork-orchestrator";

  const resolveWorkspacePaths = () => {
    const active = selectedWorkspacePath().trim();
    const locals = workspaces()
      .filter((ws) => ws.workspaceType === "local")
      .map((ws) => ws.path)
      .filter((path): path is string => Boolean(path && path.trim()))
      .map((path) => path.trim());
    const resolved: string[] = [];
    if (active) resolved.push(active);
    for (const path of locals) {
      if (!resolved.includes(path)) resolved.push(path);
    }
    return resolved;
  };

  const resolveConnectedOpenworkServer = () => {
    const client = options.openworkServer.openworkServerClient();
    if (!client) return null;
    if (options.openworkServer.openworkServerStatus() !== "connected") return null;
    return client;
  };

  const resolveLocalOpenworkServer = async () => {
    if (!isTauriRuntime()) return null;
    try {
      return (await options.openworkServer.ensureLocalOpenworkServerClient()) ?? null;
    } catch (error) {
      wsDebug("openwork:local-host:unavailable", {
        message: error instanceof Error ? error.message : safeStringify(error),
      });
      return null;
    }
  };

  const resolveActiveOpenworkWorkspace = () => {
    const client = resolveConnectedOpenworkServer();
    const workspaceId = runtimeWorkspaceId()?.trim() ?? "";
    if (!client || !workspaceId) return null;
    return { client, workspaceId };
  };

  const resolveRuntimeWorkspaceLookup = (workspace: WorkspaceInfo | null): RuntimeWorkspaceLookup | null => {
    if (!workspace) return null;
    if (workspace.workspaceType === "remote") {
      if (normalizeRemoteType(workspace.remoteType) !== "openwork") return null;
      return {
        workspaceId:
          workspace.openworkWorkspaceId?.trim() ||
          parseOpenworkWorkspaceIdFromUrl(workspace.openworkHostUrl ?? "") ||
          parseOpenworkWorkspaceIdFromUrl(workspace.baseUrl ?? "") ||
          options.openworkEnvWorkspaceId?.trim() ||
          null,
        directoryHint: workspace.directory?.trim() ?? workspace.path?.trim() ?? "",
      };
    }

    return {
      localRoot: workspace.path?.trim() ?? "",
    };
  };

  const resolveRuntimeWorkspaceIdFromResponse = (
    items: OpenworkWorkspaceInfo[],
    activeId?: string | null,
    target?: RuntimeWorkspaceLookup,
  ) => {
    const explicitId = target?.workspaceId?.trim() ?? "";
    if (explicitId) {
      return items.find((entry) => entry?.id === explicitId)?.id ?? null;
    }

    const hint = normalizeDirectoryPath(target?.directoryHint ?? target?.localRoot ?? "");
    if (hint) {
      const match = items.find((entry) => {
        const entryPath = normalizeDirectoryPath(
          (entry.opencode?.directory as string | undefined) ??
            (entry.directory as string | undefined) ??
            (entry.path as string | undefined) ??
            "",
        );
        return Boolean(entryPath && entryPath === hint);
      });
      if (match?.id) return match.id;
      if (target?.strictMatch) return null;
    }

    const normalizedActiveId = activeId?.trim() ?? "";
    if (normalizedActiveId && items.some((entry) => entry?.id === normalizedActiveId)) {
      return normalizedActiveId;
    }

    return items[0]?.id ?? null;
  };

  async function ensureRuntimeWorkspaceId(target?: RuntimeWorkspaceLookup): Promise<string | null> {
    const explicitId = target?.workspaceId?.trim() ?? "";
    const pathHint = normalizeDirectoryPath(target?.directoryHint ?? target?.localRoot ?? "");
    const currentId = runtimeWorkspaceId()?.trim() ?? "";

    if (!explicitId && !pathHint && currentId) {
      return currentId;
    }

    const client = resolveConnectedOpenworkServer();
    if (!client) {
      setRuntimeWorkspaceId(null);
      return null;
    }

    try {
      const response = await client.listWorkspaces();
      const items = Array.isArray(response.items) ? response.items : [];
      const nextId = resolveRuntimeWorkspaceIdFromResponse(items, response.activeId, target);
      setRuntimeWorkspaceId(nextId);
      return nextId;
    } catch (error) {
      wsDebug("runtime-workspace:resolve:error", {
        message: error instanceof Error ? error.message : safeStringify(error),
      });
      setRuntimeWorkspaceId(null);
      return null;
    }
  }

  const storeRuntimeWorkspaceConfig = (workspaceId: string, config: WorkspaceOpenworkConfig | null) => {
    const id = workspaceId.trim();
    if (!id) return;
    setRuntimeWorkspaceConfigById((current) => {
      if (current[id] === config) return current;
      return {
        ...current,
        [id]: config,
      };
    });
  };

  async function refreshRuntimeWorkspaceConfig(workspaceIdOverride?: string | null): Promise<WorkspaceOpenworkConfig | null> {
    const client = resolveConnectedOpenworkServer();
    const workspaceId = (workspaceIdOverride ?? runtimeWorkspaceId() ?? "").trim();
    if (!client || !workspaceId) return null;

    if (options.openworkServer.openworkServerCapabilities()?.config?.read === false) {
      storeRuntimeWorkspaceConfig(workspaceId, null);
      return null;
    }

    const workspace = connectedWorkspaceInfo() ?? selectedWorkspaceInfo();

    try {
      const config = await client.getConfig(workspaceId);
      const normalized = normalizeWorkspaceOpenworkConfig(
        config.openwork as WorkspaceOpenworkConfig | null | undefined,
        workspace?.preset ?? "starter",
      );
      const next = normalized.blueprint
        ? normalized
        : {
            ...normalized,
            blueprint: buildDefaultWorkspaceBlueprint(
              normalized.workspace?.preset ?? workspace?.preset ?? "starter",
            ),
          };
      storeRuntimeWorkspaceConfig(workspaceId, next);
      return next;
    } catch (error) {
      storeRuntimeWorkspaceConfig(workspaceId, null);
      throw error;
    }
  }

  const findOpenworkWorkspaceByPathWithClient = async (
    client: OpenworkServerClient,
    workspacePath: string,
  ) => {
    const targetPath = normalizeDirectoryPath(workspacePath);
    if (!targetPath) return null;

    const response = await client.listWorkspaces();
    const items = Array.isArray(response.items) ? response.items : [];
    const match = items.find((entry) => normalizeDirectoryPath(entry.path) === targetPath);
    if (!match?.id) return null;
    return { client, workspaceId: match.id, response };
  };

  const findOpenworkWorkspaceByPath = async (workspacePath: string) => {
    const client = resolveConnectedOpenworkServer();
    if (!client) return null;
    return findOpenworkWorkspaceByPathWithClient(client, workspacePath);
  };

  const listWorkspaceSessions = async (workspacePath: string) => {
    const client = options.client();
    if (!client) return [];

    const root = normalizeDirectoryPath(workspacePath);
    const queryDirectory = resolveScopedClientDirectory({
      targetRoot: workspacePath,
      workspaceType: "local",
    }) || undefined;
    const list = unwrap(await client.session.list({ directory: queryDirectory, roots: true }));
    return root
      ? list.filter((session) => normalizeDirectoryPath(session.directory) === root)
      : list;
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const ensureBackendWorkspaceReady = async (
    workspacePath: string,
    name: string,
    preset: WorkspacePreset,
    input?: { timeoutMs?: number; pollMs?: number },
  ) => {
    const timeoutMs = input?.timeoutMs ?? 15_000;
    const pollMs = input?.pollMs ?? 500;
    const start = Date.now();
    const localServer = await resolveLocalOpenworkServer();
    if (!localServer) {
      throw new Error("Local OpenWork server is unavailable after opening the workspace.");
    }

    let createAttempted = false;
    while (Date.now() - start < timeoutMs) {
      const resolved = await findOpenworkWorkspaceByPathWithClient(localServer, workspacePath);
      if (resolved?.workspaceId) {
        return resolved;
      }

      if (!createAttempted) {
        createAttempted = true;
        await localServer.createLocalWorkspace({ folderPath: workspacePath, name, preset });
      }

      await sleep(pollMs);
    }

    throw new Error("Local OpenWork server never registered the created workspace.");
  };

  const materializeStarterSessions = async (
    workspacePath: string,
    name: string,
    preset: WorkspacePreset,
  ) => {
    if (preset !== "starter") return null;
    const localWorkspace = await ensureBackendWorkspaceReady(workspacePath, name, preset);
    return await localWorkspace.client.materializeBlueprintSessions(localWorkspace.workspaceId);
  };

  const waitForWorkspaceSessionsReady = async (
    workspacePath: string,
    input?: { timeoutMs?: number; pollMs?: number },
  ) => {
    const timeoutMs = input?.timeoutMs ?? 30_000;
    const pollMs = input?.pollMs ?? 500;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const sessions = await listWorkspaceSessions(workspacePath);
        if (sessions.length > 0) {
          await options.loadSessions(workspacePath);
          return true;
        }
      } catch {
        // keep polling while the local engine/session index settles
      }

      await sleep(pollMs);
    }

    try {
      await options.loadSessions(workspacePath);
      return (await listWorkspaceSessions(workspacePath)).length > 0;
    } catch {
      return false;
    }
  };

  const loadWorkspaceConfigFromOpenworkServer = async (workspacePath: string): Promise<WorkspaceOpenworkConfig | null> => {
    const resolved = await findOpenworkWorkspaceByPath(workspacePath);
    if (!resolved) return null;
    const config = await resolved.client.getConfig(resolved.workspaceId);
    return (config.openwork as WorkspaceOpenworkConfig | null | undefined) ?? null;
  };

  const persistWorkspaceConfigToOpenworkServer = async (config: WorkspaceOpenworkConfig): Promise<boolean> => {
    const active = resolveActiveOpenworkWorkspace();
    if (!active) return false;
    await active.client.patchConfig(active.workspaceId, { openwork: config as Record<string, unknown> });
    return true;
  };

  const activateOpenworkHostWorkspace = async (workspacePath: string) => {
    const resolved = await findOpenworkWorkspaceByPath(workspacePath);
    if (!resolved) return;
    try {
      if (resolved.response.activeId === resolved.workspaceId) return;
      await resolved.client.activateWorkspace(resolved.workspaceId);
    } catch {
      // ignore
    }
  };

  async function testWorkspaceConnection(workspaceId: string) {
    const id = workspaceId.trim();
    if (!id) return false;
    const workspace = workspaces().find((item) => item.id === id) ?? null;
    if (!workspace) return false;

    updateWorkspaceConnectionState(id, { status: "connecting", message: null });

    if (workspace.workspaceType !== "remote") {
      updateWorkspaceConnectionState(id, { status: "connected", message: null });
      return true;
    }

    const remoteType = normalizeRemoteType(workspace.remoteType);

    if (remoteType === "openwork") {
      const hostUrl =
        workspace.openworkHostUrl?.trim() || workspace.baseUrl?.trim() || workspace.path?.trim() || "";
      if (!hostUrl) {
        updateWorkspaceConnectionState(id, {
          status: "error",
          message: "OpenWork server URL is required.",
        });
        return false;
      }

      const token = workspace.openworkToken?.trim() || options.openworkServer.openworkServerSettings().token || undefined;
      try {
        const resolved = await resolveOpenworkHost({
          hostUrl,
          token,
          workspaceId: workspace.openworkWorkspaceId ?? null,
        });
        if (resolved.kind !== "openwork") {
          updateWorkspaceConnectionState(id, {
            status: "error",
            message: "OpenWork server unavailable. Check the URL and token.",
          });
          return false;
        }
        updateWorkspaceConnectionState(id, { status: "connected", message: null });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : safeStringify(error);
        updateWorkspaceConnectionState(id, { status: "error", message });
        return false;
      }
    }

    const baseUrl = workspace.baseUrl?.trim() || "";
    if (!baseUrl) {
      updateWorkspaceConnectionState(id, {
        status: "error",
        message: "Remote base URL is required.",
      });
      return false;
    }

    try {
      const client = createClient(baseUrl, workspace.directory?.trim() || undefined);
      await waitForHealthy(client, { timeoutMs: 8_000 });
      updateWorkspaceConnectionState(id, { status: "connected", message: null });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      updateWorkspaceConnectionState(id, { status: "error", message });
      return false;
    }
  }

  async function refreshEngine() {
    if (!isTauriRuntime()) return;

    try {
      const info = await engineInfo();
      setEngine(info);

      const connectedWorkspace = connectedWorkspaceInfo();
      const syncLocalState = connectedWorkspace?.workspaceType !== "remote";

      const username = info.opencodeUsername?.trim() ?? "";
      const password = info.opencodePassword?.trim() ?? "";
      const auth = username && password ? { username, password } : null;
      setEngineAuth(auth);

      if (info.projectDir && syncLocalState) {
        setProjectDir(info.projectDir);
      }
      if (info.baseUrl && syncLocalState) {
        options.setBaseUrl(info.baseUrl);
      }

      if (
        syncLocalState &&
        info.running &&
        info.baseUrl &&
        !options.client() &&
        !reconnectingEngine
      ) {
        const now = Date.now();
        if (now - lastEngineReconnectAt > 10_000) {
          const reconnectRoot =
            (connectedWorkspace?.workspaceType === "local"
              ? connectedWorkspace.path?.trim()
              : connectedWorkspace?.directory?.trim()) ||
            info.projectDir?.trim() ||
            "";
          lastEngineReconnectAt = now;
          reconnectingEngine = true;
          connectToServer(
            info.baseUrl,
            reconnectRoot || undefined,
            { workspaceType: "local", targetRoot: reconnectRoot, reason: "engine-refresh" },
            auth ?? undefined,
            { quiet: true, navigate: false },
          )
            .catch(() => undefined)
            .finally(() => {
              reconnectingEngine = false;
            });
        }
      }
    } catch {
      // ignore
    }
  }

  async function refreshEngineDoctor() {
    if (!isTauriRuntime()) return;

    try {
      const source = options.engineSource();
      const result = await engineDoctor({
        preferSidecar: source === "sidecar",
        opencodeBinPath: source === "custom" ? options.engineCustomBinPath?.().trim() || null : null,
      });
      setEngineDoctorResult(result);
      setEngineDoctorCheckedAt(Date.now());
    } catch (e) {
      setEngineDoctorResult(null);
      setEngineDoctorCheckedAt(Date.now());
      setEngineInstallLogs(e instanceof Error ? e.message : safeStringify(e));
    }
  }

  async function refreshSandboxDoctor() {
    if (!isTauriRuntime()) {
      setSandboxDoctorResult(null);
      setSandboxDoctorCheckedAt(Date.now());
      return null;
    }
    if (sandboxDoctorBusy()) return sandboxDoctorResult();
    setSandboxDoctorBusy(true);
    try {
      const result = await sandboxDoctor();
      setSandboxDoctorResult(result);
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      const fallback: SandboxDoctorResult = {
        installed: false,
        daemonRunning: false,
        permissionOk: false,
        ready: false,
        error: message,
      };
      setSandboxDoctorResult(fallback);
      return fallback;
    } finally {
      setSandboxDoctorCheckedAt(Date.now());
      setSandboxDoctorBusy(false);
    }
  }

  async function activateWorkspace(
    workspaceId: string,
    hint?: { prevProjectDir?: string },
  ) {
    const id = workspaceId.trim();
    if (!id) return false;

    const capturedPrevDir = hint?.prevProjectDir?.trim() || resolveCurrentRuntimeRoot();

    const next = workspaces().find((w) => w.id === id) ?? null;
    if (!next) return false;
    if (connectedWorkspaceId() === id && options.client()) {
      if (selectedWorkspaceId() !== id) {
        await applyWorkspaceSelection(id);
      }
      updateWorkspaceConnectionState(id, { status: "connected", message: null });
      wsDebug("activate:noop-already-connected", { id });
      return true;
    }
    if (selectedWorkspaceId() !== id) {
      await applyWorkspaceSelection(id);
    }
    const isRemote = next.workspaceType === "remote";
    console.log("[workspace] activate", { id: next.id, type: next.workspaceType });
    const activateStart = Date.now();
    wsDebug("activate:start", {
      id: next.id,
      type: next.workspaceType,
      remoteType: next.remoteType ?? null,
      prevActiveId: selectedWorkspaceId(),
      prevProjectDir: capturedPrevDir,
      currentProjectDir: projectDir(),
      startupPref: options.startupPreference(),
      hasClient: Boolean(options.client()),
    });

    const remoteType = isRemote ? normalizeRemoteType(next.remoteType) : "opencode";
    const baseUrl = isRemote ? next.baseUrl?.trim() ?? "" : "";

    setConnectingWorkspaceId(id);
    updateWorkspaceConnectionState(id, { status: "connecting", message: null });

    // Allow the UI to paint the "switching" state before we kick off work that can
    // trigger expensive reactive updates (e.g. sidebar session refreshes).
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    }

    try {
      if (isRemote) {
        options.setStartupPreference("server");

        if (remoteType === "openwork") {
          const hostUrl = next.openworkHostUrl?.trim() ?? "";
          if (!hostUrl) {
            options.setError("OpenWork server URL is required.");
            updateWorkspaceConnectionState(id, {
              status: "error",
              message: "OpenWork server URL is required.",
            });
            return false;
          }

          const workspaceToken = next.openworkToken?.trim() ?? "";
          const fallbackToken = options.openworkServer.openworkServerSettings().token ?? "";
          const token = workspaceToken || fallbackToken;

          const currentSettings = options.openworkServer.openworkServerSettings();
          if (
            currentSettings.urlOverride?.trim() !== hostUrl ||
            (token && currentSettings.token?.trim() !== token)
          ) {
            options.openworkServer.updateOpenworkServerSettings({
              ...currentSettings,
              urlOverride: hostUrl,
              token: token || currentSettings.token,
            });
          }

          let resolvedBaseUrl = baseUrl;
          let resolvedDirectory = next.directory?.trim() ?? "";
          let workspaceInfo: OpenworkWorkspaceInfo | null = null;
          let resolvedAuth: OpencodeAuth | undefined = token ? { token, mode: "openwork" } : undefined;

          const finishRemoteWorkspaceActivation = async (shouldPersistResolved: boolean) => {
            if (shouldPersistResolved) {
              if (isTauriRuntime()) {
                try {
                  const ws = await workspaceUpdateRemote({
                    workspaceId: next.id,
                    remoteType: "openwork",
                    baseUrl: resolvedBaseUrl,
                    directory: resolvedDirectory || null,
                    openworkHostUrl: hostUrl,
                    openworkToken: token ? token : null,
                    openworkWorkspaceId: workspaceInfo?.id ?? next.openworkWorkspaceId ?? null,
                    openworkWorkspaceName: workspaceInfo?.name ?? next.openworkWorkspaceName ?? null,
                  });
                  setWorkspaces(ws.workspaces);
                  syncSelectedWorkspaceId(pickSelectedWorkspaceId(ws.workspaces, [id, selectedWorkspaceId()], ws));
                } catch {
                  // ignore
                }
              } else {
                const resolvedToken = token.trim();
                setWorkspaces((prev) =>
                  prev.map((ws) => {
                    if (ws.id !== next.id) return ws;
                    return {
                      ...ws,
                      remoteType: "openwork",
                      baseUrl: resolvedBaseUrl.replace(/\/+$/, ""),
                      directory: resolvedDirectory || null,
                      openworkHostUrl: hostUrl,
                      openworkToken: resolvedToken || null,
                      openworkWorkspaceId: workspaceInfo?.id ?? ws.openworkWorkspaceId ?? null,
                      openworkWorkspaceName: workspaceInfo?.name ?? ws.openworkWorkspaceName ?? null,
                    };
                  }),
                );
              }
            }

            syncSelectedWorkspaceId(id);
            setProjectDir(resolvedDirectory || "");
            setWorkspaceConfig(null);
            setWorkspaceConfigLoaded(true);
            setAuthorizedDirs([]);

            if (isTauriRuntime()) {
              try {
                await workspaceSetRuntimeActive(id);
              } catch {
                // ignore
              }
            }

            updateWorkspaceConnectionState(id, { status: "connected", message: null });
            return true;
          };

          if (resolvedBaseUrl) {
            const cachedOk = await connectToServer(
              resolvedBaseUrl,
              resolvedDirectory || undefined,
              {
                workspaceId: next.id,
                workspaceType: next.workspaceType,
                targetRoot: resolvedDirectory ?? "",
                reason: "workspace-switch-openwork-cached",
              },
              resolvedAuth,
              { navigate: false, quiet: true },
            );

            if (cachedOk) {
              wsDebug("activate:remote:cached", { id, hostUrl, resolvedBaseUrl, resolvedDirectory });
              return await finishRemoteWorkspaceActivation(false);
            }
          }

          try {
            const resolved = await resolveOpenworkHost({
              hostUrl,
              token,
              workspaceId: next.openworkWorkspaceId ?? null,
              directoryHint: next.directory ?? null,
            });
            if (resolved.kind !== "openwork") {
              options.setError("OpenWork server unavailable. Check the URL and token.");
              updateWorkspaceConnectionState(id, {
                status: "error",
                message: "OpenWork server unavailable. Check the URL and token.",
              });
              return false;
            }

            resolvedBaseUrl = resolved.opencodeBaseUrl;
            resolvedDirectory = resolved.directory;
            workspaceInfo = resolved.workspace;
            resolvedAuth = resolved.auth;
          } catch (error) {
            const message = error instanceof Error ? error.message : safeStringify(error);
            options.setError(addOpencodeCacheHint(message));
            updateWorkspaceConnectionState(id, { status: "error", message });
            return false;
          }

          if (!resolvedBaseUrl) {
            options.setError(t("app.error.remote_base_url_required", currentLocale()));
            updateWorkspaceConnectionState(id, {
              status: "error",
              message: "Remote base URL is required.",
            });
            return false;
          }

          const ok = await connectToServer(
            resolvedBaseUrl,
            resolvedDirectory || undefined,
            {
              workspaceId: next.id,
              workspaceType: next.workspaceType,
              targetRoot: resolvedDirectory ?? "",
              reason: "workspace-switch-openwork",
            },
            resolvedAuth,
            { navigate: false },
          );

          if (!ok) {
            updateWorkspaceConnectionState(id, {
              status: "error",
              message: "Failed to connect to worker.",
            });
            return false;
          }
          return await finishRemoteWorkspaceActivation(true);
        }

        if (!baseUrl) {
          options.setError(t("app.error.remote_base_url_required", currentLocale()));
          updateWorkspaceConnectionState(id, {
            status: "error",
            message: "Remote base URL is required.",
          });
          return false;
        }

        const ok = await connectToServer(
          baseUrl,
          next.directory?.trim() || undefined,
          {
            workspaceId: next.id,
            workspaceType: next.workspaceType,
            targetRoot: next.directory?.trim() ?? "",
            reason: "workspace-switch-direct",
          },
          undefined,
          { navigate: false },
        );

        if (!ok) {
          updateWorkspaceConnectionState(id, {
            status: "error",
            message: "Failed to connect to worker.",
          });
          return false;
        }

        syncSelectedWorkspaceId(id);
        setProjectDir(next.directory?.trim() ?? "");
        setWorkspaceConfig(null);
        setWorkspaceConfigLoaded(true);
        setAuthorizedDirs([]);

        if (isTauriRuntime()) {
          try {
            await workspaceSetRuntimeActive(id);
          } catch {
            // ignore
          }
        }

        updateWorkspaceConnectionState(id, { status: "connected", message: null });
        wsDebug("activate:remote:done", { id, ms: Date.now() - activateStart });
        return true;
      }

    const wasLocalConnection = options.startupPreference() === "local" && options.client();
    options.setStartupPreference("local");
    const nextRoot = isRemote ? next.directory?.trim() ?? "" : next.path;
    // Use the pre-switch snapshot instead of projectDir() which may already
    // point at the new workspace due to applySelectedWorkspacePresentation.
    const oldWorkspacePath = capturedPrevDir;
    const workspaceChanged = oldWorkspacePath !== nextRoot;

    wsDebug("activate:local:prep", {
      id,
      nextRoot,
      workspaceChanged,
      wasLocalConnection: Boolean(wasLocalConnection),
      prevProjectDir: oldWorkspacePath,
    });

    syncSelectedWorkspaceId(id);
    setProjectDir(nextRoot);

    if (isTauriRuntime()) {
      if (isRemote) {
        setWorkspaceConfig(null);
        setWorkspaceConfigLoaded(true);
        setAuthorizedDirs([]);
      } else {
        setWorkspaceConfigLoaded(false);
        try {
          const cfg = await loadWorkspaceConfigFromOpenworkServer(next.path)
            ?? await workspaceOpenworkRead({ workspacePath: next.path });
          setWorkspaceConfig(cfg);
          setWorkspaceConfigLoaded(true);

          const roots = Array.isArray(cfg.authorizedRoots) ? cfg.authorizedRoots : [];
          if (roots.length) {
            setAuthorizedDirs(roots);
          } else {
            setAuthorizedDirs([next.path]);
          }
        } catch {
          setWorkspaceConfig(null);
          setWorkspaceConfigLoaded(true);
          setAuthorizedDirs([next.path]);
        }
      }

      try {
        if (!isRemote) {
          await activateOpenworkHostWorkspace(next.path);
        }
        await workspaceSetRuntimeActive(id);
      } catch {
        // ignore
      }
    } else if (!isRemote) {
      if (!authorizedDirs().includes(next.path)) {
        const merged = authorizedDirs().length ? authorizedDirs().slice() : [];
        if (!merged.includes(next.path)) merged.push(next.path);
        setAuthorizedDirs(merged);
      }
    } else {
      setAuthorizedDirs([]);
    }

    // If we were previously connected to a remote engine, switching back to a local workspace
    // requires starting (or reconnecting) the local host engine.
    //
    // Without this, we end up keeping the remote client while `startupPreference` flips to
    // "local", and subsequent session/file actions behave inconsistently.
    if (!isRemote && options.client() && !wasLocalConnection) {
      wsDebug("activate:remote->local:reconnect", {
        id,
        nextPath: next.path,
        engine: engine()?.baseUrl ?? null,
        engineRunning: Boolean(engine()?.running),
      });
      options.setSelectedSessionId(null);
      options.setMessages([]);
      options.setTodos([]);
      options.setPendingPermissions([]);
      options.setSessionStatusById({});

      // If a local host engine is already running (common when bouncing between remote/local),
      // reuse it instead of restarting to keep switching snappy.
      let connectedToLocalHost = false;
      const existingEngine = engine();
      const runtime = existingEngine?.runtime ?? resolveEngineRuntime();
      const canReuseHost =
        isTauriRuntime() &&
        Boolean(existingEngine?.running && existingEngine.baseUrl);

      wsDebug("activate:remote->local:hostReuse", {
        canReuseHost,
        runtime,
        existingEngineBaseUrl: existingEngine?.baseUrl ?? null,
        existingEngineProjectDir: existingEngine?.projectDir ?? null,
      });

      if (canReuseHost && runtime === "openwork-orchestrator") {
        try {
          const reuseStart = Date.now();
          await orchestratorWorkspaceActivate({
            workspacePath: next.path,
            name: next.displayName?.trim() || next.name?.trim() || null,
          });
          await activateOpenworkHostWorkspace(next.path);

          const nextInfo = await engineInfo();
          setEngine(nextInfo);

          const username = nextInfo.opencodeUsername?.trim() ?? "";
          const password = nextInfo.opencodePassword?.trim() ?? "";
          const auth = username && password ? { username, password } : undefined;
          setEngineAuth(auth ?? null);

          if (nextInfo.baseUrl) {
            connectedToLocalHost = await connectToServer(
              nextInfo.baseUrl,
              next.path,
              { workspaceType: "local", targetRoot: next.path, reason: "workspace-attach-local" },
              auth,
              { navigate: false },
            );
          }
          wsDebug("activate:remote->local:reuseHost:done", {
            ok: connectedToLocalHost,
            ms: Date.now() - reuseStart,
          });
        } catch {
          connectedToLocalHost = false;
          wsDebug("activate:remote->local:reuseHost:error");
        }
      }

      if (!connectedToLocalHost) {
        const startHostAt = Date.now();
        const ok = await startHost({ workspacePath: next.path, navigate: false });
        wsDebug("activate:remote->local:startHost:done", { ok, ms: Date.now() - startHostAt });
        if (!ok) {
          updateWorkspaceConnectionState(id, {
            status: "error",
            message: "Failed to start local engine.",
          });
          return false;
        }
      }
    }

    // When running locally, restart the engine when workspace changes
    if (!isRemote && wasLocalConnection && workspaceChanged) {
      wsDebug("activate:local->local:restartEngine", { id, nextPath: next.path });
      options.setError(null);
      options.setBusy(true);
      options.setBusyLabel("status.restarting_engine");
      options.setBusyStartedAt(Date.now());

      try {
        const runtime = resolveEngineRuntime();
        if (runtime === "openwork-orchestrator") {
          await orchestratorWorkspaceActivate({
            workspacePath: next.path,
            name: next.displayName?.trim() || next.name?.trim() || null,
          });
          await activateOpenworkHostWorkspace(next.path);

          const newInfo = await engineInfo();
          setEngine(newInfo);

          const username = newInfo.opencodeUsername?.trim() ?? "";
          const password = newInfo.opencodePassword?.trim() ?? "";
          const auth = username && password ? { username, password } : undefined;
          setEngineAuth(auth ?? null);

            if (newInfo.baseUrl) {
              const ok = await connectToServer(
                newInfo.baseUrl,
                next.path,
                { workspaceType: "local", targetRoot: next.path, reason: "workspace-orchestrator-switch" },
                auth,
                { navigate: false },
              );
              if (!ok) {
                options.setError("Failed to reconnect after worker switch");
              }
            }
        } else {
          // Stop the current engine
          const info = await engineStop();
          setEngine(info);

          // Start engine with new workspace directory
          const newInfo = await engineStart(next.path, {
            preferSidecar: options.engineSource() === "sidecar",
            opencodeBinPath:
              options.engineSource() === "custom" ? options.engineCustomBinPath?.().trim() || null : null,
            opencodeEnableExa: options.opencodeEnableExa?.() ?? false,
            openworkRemoteAccess: options.openworkServer.openworkServerSettings().remoteAccessEnabled === true,
            runtime,
            workspacePaths: resolveWorkspacePaths(),
          });
          setEngine(newInfo);

          const username = newInfo.opencodeUsername?.trim() ?? "";
          const password = newInfo.opencodePassword?.trim() ?? "";
          const auth = username && password ? { username, password } : undefined;
          setEngineAuth(auth ?? null);

          // Reconnect to server
            if (newInfo.baseUrl) {
              const ok = await connectToServer(
                newInfo.baseUrl,
                next.path,
                { workspaceType: "local", targetRoot: next.path, reason: "workspace-restart" },
                auth,
                { navigate: false },
              );
              if (!ok) {
                options.setError("Failed to reconnect after worker switch");
              }
            }
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : safeStringify(e);
        options.setError(addOpencodeCacheHint(message));
      } finally {
        options.setBusy(false);
        options.setBusyLabel(null);
        options.setBusyStartedAt(null);
      }
    }

      updateWorkspaceConnectionState(id, { status: "connected", message: null });
      wsDebug("activate:local:done", { id, ms: Date.now() - activateStart });
      return true;
    } finally {
      setConnectingWorkspaceId(null);
      wsDebug("activate:finally", { id, ms: Date.now() - activateStart });
    }
  }

  async function connectToServer(
    nextBaseUrl: string,
    directory?: string,
    context?: {
      workspaceId?: string;
      workspaceType?: WorkspaceInfo["workspaceType"];
      targetRoot?: string;
      reason?: string;
    },
    auth?: OpencodeAuth,
    connectOptions?: { quiet?: boolean; navigate?: boolean },
  ) {
    const requestKey = connectRequestKey(nextBaseUrl, directory, context, auth, connectOptions);
    const existing = connectInFlightByKey.get(requestKey);
    if (existing) {
      wsDebug("connect:dedupe", {
        baseUrl: nextBaseUrl,
        directory: directory ?? null,
        reason: context?.reason ?? null,
        workspaceType: context?.workspaceType ?? null,
      });
      return existing;
    }

    const run = (async () => {
      console.log("[workspace] connect", {
        baseUrl: nextBaseUrl,
        directory: directory ?? null,
        workspaceType: context?.workspaceType ?? null,
      });
      const connectStart = Date.now();
      wsDebug("connect:start", {
        baseUrl: nextBaseUrl,
        directory: directory ?? null,
        directoryScope: describeDirectoryScope(directory),
        reason: context?.reason ?? null,
        workspaceType: context?.workspaceType ?? null,
        targetRoot: context?.targetRoot ?? null,
        targetRootScope: describeDirectoryScope(context?.targetRoot),
        workspaceId: context?.workspaceId ?? null,
        selectedWorkspaceId: selectedWorkspaceId() || null,
        selectedWorkspaceRoot: selectedWorkspaceRoot().trim() || null,
        activeWorkspaceScope: describeDirectoryScope(selectedWorkspaceRoot().trim()),
        projectDir: projectDir().trim() || null,
        clientDirectory: options.clientDirectory().trim() || null,
        healthTimeoutMs: resolveConnectHealthTimeoutMs(context?.reason),
        quiet: connectOptions?.quiet ?? false,
        navigate: connectOptions?.navigate ?? true,
        authMode: auth && "mode" in auth ? (auth as any).mode : auth ? "basic" : "none",
      });
      const quiet = connectOptions?.quiet ?? false;
      const navigate = connectOptions?.navigate ?? true;
      options.setError(null);
      if (!quiet) {
        options.setBusy(true);
        options.setBusyLabel("status.connecting");
        options.setBusyStartedAt(Date.now());
      }
      options.setSseConnected(false);

      const connectMeta: OpencodeConnectStatus = {
        at: Date.now(),
        baseUrl: nextBaseUrl,
        directory: directory ?? null,
        reason: context?.reason ?? null,
        status: "connecting",
        error: null,
      };
      options.setOpencodeConnectStatus?.(connectMeta);

      const connectMetrics: NonNullable<OpencodeConnectStatus["metrics"]> = {};

      try {
        let resolvedDirectory = resolveScopedClientDirectory({
          directory,
          targetRoot: context?.targetRoot,
          workspaceType: context?.workspaceType ?? "local",
        });
        let nextClient = createClient(nextBaseUrl, resolvedDirectory || undefined, auth);
        const healthTimeoutMs = resolveConnectHealthTimeoutMs(context?.reason);
        const health = await waitForHealthy(nextClient, { timeoutMs: healthTimeoutMs });
        connectMetrics.healthyMs = Date.now() - connectStart;
        wsDebug("connect:healthy", {
          ms: Date.now() - connectStart,
          version: health.version,
          timeoutMs: healthTimeoutMs,
          resolvedDirectory: resolvedDirectory || null,
          resolvedDirectoryScope: describeDirectoryScope(resolvedDirectory),
        });

        if (context?.workspaceType === "remote" && !resolvedDirectory) {
          try {
            const pathInfo = unwrap(await nextClient.path.get());
            const discovered = toSessionTransportDirectory(pathInfo.directory);
            if (discovered) {
              resolvedDirectory = discovered;
              console.log("[workspace] remote directory resolved", resolvedDirectory);
              if (isTauriRuntime() && context.workspaceId) {
                const updated = await workspaceUpdateRemote({
                  workspaceId: context.workspaceId,
                  directory: resolvedDirectory,
                });
                setWorkspaces(updated.workspaces);
                syncSelectedWorkspaceId(
                  pickSelectedWorkspaceId(updated.workspaces, [context.workspaceId, selectedWorkspaceId()], updated),
                );
              }
              setProjectDir(resolvedDirectory);
              nextClient = createClient(nextBaseUrl, resolvedDirectory, auth);
            }
          } catch (error) {
            console.log("[workspace] remote directory lookup failed", error);
          }
        }

        options.setClient(nextClient);
        options.setConnectedVersion(health.version);
        options.setBaseUrl(nextBaseUrl);
        options.setClientDirectory(resolvedDirectory);
        setConnectedWorkspaceId(
          resolveWorkspaceEntryId({
            workspaceId: context?.workspaceId ?? null,
            workspaceType: context?.workspaceType,
            targetRoot: context?.targetRoot ?? resolvedDirectory,
            directory: resolvedDirectory,
          }),
        );

        const providersPromise = (async () => {
          const providersAt = Date.now();
          wsDebug("connect:providers:start", { baseUrl: nextBaseUrl });
          let disabledProviders: string[] = [];
          try {
            const config = unwrap(await nextClient.config.get());
            disabledProviders = Array.isArray(config.disabled_providers) ? config.disabled_providers : [];
          } catch {
            // ignore config read failures and continue with provider discovery
          }
          try {
            const providerList = unwrap(await nextClient.provider.list());
              wsDebug("connect:providers:done", {
                ms: Date.now() - providersAt,
                source: "provider.list",
                available: providerList.all?.length ?? 0,
                connected: providerList.connected?.length ?? 0,
              });
              const next = filterProviderList(providerList, disabledProviders);
              return {
                providers: next.all,
                defaults: next.default,
                connectedIds: next.connected,
              };
            } catch (error) {
            const message = error instanceof Error ? error.message : safeStringify(error);
            wsDebug("connect:providers:fallback", { ms: Date.now() - providersAt, message });
            try {
              const cfg = unwrap(await nextClient.config.providers());
              const mapped = mapConfigProvidersToList(cfg.providers);
              wsDebug("connect:providers:done", {
                ms: Date.now() - providersAt,
                source: "config.providers",
                available: mapped.length,
                connected: 0,
              });
              const next = filterProviderList(
                { all: mapped, connected: [], default: cfg.default },
                disabledProviders,
              );
              return {
                providers: next.all,
                defaults: next.default,
                connectedIds: next.connected,
              };
            } catch (fallbackError) {
              const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : safeStringify(fallbackError);
              wsDebug("connect:providers:error", { ms: Date.now() - providersAt, message: fallbackMessage });
              return {
                providers: [],
                defaults: {},
                connectedIds: [],
              };
            }
          } finally {
            connectMetrics.providersMs = Date.now() - providersAt;
          }
        })();

        const targetRoot = context?.targetRoot ?? (resolvedDirectory || selectedWorkspaceRoot().trim());
        wsDebug("connect:loadSessions", {
          targetRoot,
          targetRootScope: describeDirectoryScope(targetRoot),
          resolvedDirectory,
          resolvedDirectoryScope: describeDirectoryScope(resolvedDirectory),
          selectedWorkspaceId: selectedWorkspaceId() || null,
          selectedWorkspaceRoot: selectedWorkspaceRoot().trim() || null,
        });
        const sessionsAt = Date.now();
        await options.loadSessions(targetRoot);
        connectMetrics.loadSessionsMs = Date.now() - sessionsAt;
        wsDebug("connect:loadSessions:done", { ms: Date.now() - sessionsAt });
        options.onBootPhaseChange?.("sessionIndexReady", {
          source: context?.reason ?? "connectToServer",
          targetRoot: targetRoot || null,
        });
        options.onStartupTrace?.("session-index-ready", {
          source: context?.reason ?? "connectToServer",
          targetRoot: targetRoot || null,
        });
        const pendingPermissionsAt = Date.now();
        await options.refreshPendingPermissions();
        connectMetrics.pendingPermissionsMs = Date.now() - pendingPermissionsAt;

        const providerState = await providersPromise;
        options.setProviders(providerState.providers);
        options.setProviderDefaults(providerState.defaults);
        options.setProviderConnectedIds(providerState.connectedIds);

        if (navigate && !options.selectedSessionId()) {
          options.setSettingsTab("automations");
          options.setView("session");
        }

        options.onEngineStable?.();
        connectMetrics.totalMs = Date.now() - connectStart;
        options.setOpencodeConnectStatus?.({ ...connectMeta, status: "connected", metrics: connectMetrics });
        wsDebug("connect:done", { ok: true, ms: Date.now() - connectStart });
        return true;
      } catch (e) {
        options.setClient(null);
        options.setConnectedVersion(null);
        setConnectedWorkspaceId(null);
        const message = e instanceof Error ? e.message : safeStringify(e);
        wsDebug("connect:error", { ms: Date.now() - connectStart, message });
        connectMetrics.totalMs = Date.now() - connectStart;
        options.setOpencodeConnectStatus?.({
          ...connectMeta,
          status: "error",
          error: addOpencodeCacheHint(message),
          metrics: connectMetrics,
        });
        if (!quiet) {
          options.setError(addOpencodeCacheHint(message));
        }
        return false;
      } finally {
        if (!quiet) {
          options.setBusy(false);
          options.setBusyLabel(null);
          options.setBusyStartedAt(null);
        }
      }
    })();

    connectInFlightByKey.set(requestKey, run);
    try {
      return await run;
    } finally {
      if (connectInFlightByKey.get(requestKey) === run) {
        connectInFlightByKey.delete(requestKey);
      }
    }
  }

  const openEmptySession = async (scopeRoot?: string) => {
    const root = (scopeRoot ?? selectedWorkspaceRoot().trim()).trim();
    wsDebug("open-empty-session:start", {
      scopeRoot: scopeRoot ?? null,
      resolvedRoot: root || null,
      selectedWorkspaceId: selectedWorkspaceId(),
      activeWorkspace: selectedWorkspaceInfo(),
      hasClient: Boolean(options.client()),
    });

    if (options.client()) {
      try {
        await options.loadSessions(root || undefined);
      } catch {
        // If session loading fails, still fall back to the draft-ready session view.
      }
    }

    clearSelectedSessionSurface();
    options.setView("session");
  };

  const activateFreshLocalWorkspace = async (workspaceId: string | null, workspacePath: string) => {
    const hasClient = Boolean(options.client());
    const ok = hasClient
      ? workspaceId
        ? await activateWorkspace(workspaceId)
        : true
      : await startHost({ workspacePath, navigate: false });

    if (!ok) {
      return false;
    }
    return true;
  };

  async function createWorkspaceFlow(preset: WorkspacePreset, folder: string | null): Promise<boolean> {
    if (!isTauriRuntime()) {
      options.setError(t("app.error.tauri_required", currentLocale()));
      return false;
    }

    if (!folder) {
      options.setError(t("app.error.choose_folder", currentLocale()));
      return false;
    }

    options.setBusy(true);
    options.setBusyLabel("status.creating_workspace");
    options.setBusyStartedAt(Date.now());
    options.setError(null);
    clearSandboxCreateProgress();
    setSandboxPreflightBusy(false);

    try {
      const resolvedFolder = await resolveWorkspacePath(folder);
      if (!resolvedFolder) {
        options.setError(t("app.error.choose_folder", currentLocale()));
        return false;
      }

      const name = deriveWorkspaceName(resolvedFolder, preset);
      const openworkServer = await resolveLocalOpenworkServer();
      const ws = openworkServer
        ? await openworkServer.createLocalWorkspace({ folderPath: resolvedFolder, name, preset })
        : await workspaceCreate({ folderPath: resolvedFolder, name, preset });

      const createdWorkspaceId = pickSelectedWorkspaceId(ws.workspaces, [resolveWorkspaceListSelectedId(ws)], ws);

      if (openworkServer && isTauriRuntime()) {
        try {
          await workspaceCreate({ folderPath: resolvedFolder, name, preset });
        } catch {
          // keep the server result as the source of truth for this run
        }
      }

      const nextSelectedId = createdWorkspaceId;
      applyServerLocalWorkspaces(ws.workspaces, nextSelectedId);
      if (nextSelectedId) {
        const nextSelectedWorkspace = ws.workspaces.find((workspace) => workspace.id === nextSelectedId) ?? null;
        if (nextSelectedWorkspace) {
          await applySelectedWorkspacePresentation(nextSelectedWorkspace);
        } else {
          syncSelectedWorkspaceId(nextSelectedId);
        }
        updateWorkspaceConnectionState(nextSelectedId, { status: "connected", message: null });
      }

      queuePendingInitialSessionSelection(nextSelectedId || null, preset);

      setCreateWorkspaceOpen(false);

      const opened = await activateFreshLocalWorkspace(nextSelectedId || null, resolvedFolder);
      if (!opened) {
        options.setPendingInitialSessionSelection?.(null);
        return false;
      }

      if (preset === "starter") {
        const materialized = await materializeStarterSessions(resolvedFolder, name, preset);
        const sessionsReady = await waitForWorkspaceSessionsReady(resolvedFolder);
        if (!sessionsReady) {
          throw new Error("Starter sessions did not finish loading for the new workspace.");
        }
        if (nextSelectedId) {
          await options.refreshWorkspaceSessions?.(nextSelectedId);
        }
        const openSessionId = materialized?.openSessionId?.trim() || "";
        if (openSessionId) {
          options.setPendingInitialSessionSelection?.(null);
          options.setSelectedSessionId(openSessionId);
          options.setView("session", openSessionId);
          await options.selectSession(openSessionId, {
            skipHealthCheck: true,
            source: "create-workspace-open-session",
          });
        }
      }

      if (!nextSelectedId) {
        await openEmptySession(resolvedFolder);
      }

      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
      return false;
    } finally {
      options.setBusy(false);
      options.setBusyLabel(null);
      options.setBusyStartedAt(null);
    }
  }

  async function createSandboxFlow(
    preset: WorkspacePreset,
    folder: string | null,
    input?: { onReady?: () => Promise<void> | void },
  ): Promise<boolean> {
    if (!isTauriRuntime()) {
      options.setError(t("app.error.tauri_required", currentLocale()));
      return false;
    }

    if (!folder) {
      options.setError(t("app.error.choose_folder", currentLocale()));
      return false;
    }

    const runId = makeRunId();
    const startedAt = Date.now();
    setSandboxCreatePhase("preflight");
    setSandboxPreflightBusy(true);
    options.setError(null);
    clearSandboxCreateProgress();

    const doctor = await refreshSandboxDoctor();
    setSandboxPreflightBusy(false);
    setSandboxCreatePhase("provisioning");
    setSandboxCreateProgress({
      runId,
      startedAt,
      stage: "Checking Docker...",
      error: null,
      logs: [],
      steps: [
        { key: "docker", label: "Docker ready", status: "active", detail: null },
        { key: "workspace", label: "Prepare worker", status: "pending", detail: null },
        { key: "sandbox", label: "Start sandbox services", status: "pending", detail: null },
        { key: "health", label: "Wait for OpenWork", status: "pending", detail: null },
        { key: "connect", label: "Connect in OpenWork", status: "pending", detail: null },
      ],
    });

    if (doctor?.debug) {
      const selectedBin = doctor.debug.selectedBin?.trim();
      if (selectedBin) {
        pushSandboxCreateLog(`Docker binary: ${selectedBin}`);
      }
      const candidates = (doctor.debug.candidates ?? []).filter((item) => item?.trim());
      if (candidates.length) {
        pushSandboxCreateLog(`Docker candidates: ${candidates.join(", ")}`);
      }
      const versionDebug = doctor.debug.versionCommand;
      if (versionDebug) {
        pushSandboxCreateLog(`docker --version exit=${versionDebug.status}`);
        if (versionDebug.stderr?.trim()) pushSandboxCreateLog(`docker --version stderr: ${versionDebug.stderr.trim()}`);
      }
      const infoDebug = doctor.debug.infoCommand;
      if (infoDebug) {
        pushSandboxCreateLog(`docker info exit=${infoDebug.status}`);
        if (infoDebug.stderr?.trim()) pushSandboxCreateLog(`docker info stderr: ${infoDebug.stderr.trim()}`);
      }
    }
    if (!doctor?.ready) {
      const detail =
        doctor?.error?.trim() ||
        "Docker is required for sandboxes. Install Docker Desktop, start it, then retry.";
      options.setError(detail);
      setSandboxStep("docker", { status: "error", detail });
      setSandboxError(detail);
      setSandboxStage("Docker not ready");
      setSandboxCreatePhase("idle");
      return false;
    }
    setSandboxStep("docker", { status: "done", detail: doctor.serverVersion ?? null });
    setSandboxStage("Preparing worker...");

    try {
      const resolvedFolder = await resolveWorkspacePath(folder);
      if (!resolvedFolder) {
        options.setError(t("app.error.choose_folder", currentLocale()));
        setSandboxStep("workspace", { status: "error", detail: "No folder selected" });
        setSandboxError("No folder selected");
        return false;
      }

      const name = deriveWorkspaceName(resolvedFolder, preset);

      setSandboxStep("workspace", { status: "active", detail: name });
      pushSandboxCreateLog(`Worker: ${resolvedFolder}`);

      // Ensure the workspace folder has baseline OpenWork/OpenCode files.
      const openworkServer = await resolveLocalOpenworkServer();
      const created = openworkServer
        ? await openworkServer.createLocalWorkspace({ folderPath: resolvedFolder, name, preset })
        : await workspaceCreate({ folderPath: resolvedFolder, name, preset });
      if (openworkServer && isTauriRuntime()) {
        try {
          await workspaceCreate({ folderPath: resolvedFolder, name, preset });
        } catch {
          // ignore desktop mirror failures here
        }
      }
      const localId = pickSelectedWorkspaceId(created.workspaces, [resolveWorkspaceListSelectedId(created)], created);
      applyServerLocalWorkspaces(created.workspaces, localId);
      if (localId) {
        syncSelectedWorkspaceId(localId);
      }
      setSandboxStep("workspace", { status: "done", detail: null });

      // Remove the local workspace entry to avoid duplicate Local+Remote rows.
      if (localId) {
        pushSandboxCreateLog("Removing local worker row (will re-add as remote sandbox)...");
        const activeLocalWorkspace = openworkServer ? await findOpenworkWorkspaceByPath(resolvedFolder) : null;
        const forgotten = await (activeLocalWorkspace
          ? (() => activeLocalWorkspace.client.deleteWorkspace(activeLocalWorkspace.workspaceId).then((response) => ({
              activeId: response.activeId ?? "",
              workspaces: response.workspaces ?? response.items,
            })))()
          : workspaceForget(localId));
        if (activeLocalWorkspace && isTauriRuntime()) {
          try {
            await workspaceForget(localId);
          } catch {
            // ignore desktop mirror failures here
          }
        }
        applyServerLocalWorkspaces(forgotten.workspaces, forgotten.activeId);
      }

      setSandboxStep("sandbox", { status: "active", detail: null });
      setSandboxStage("Starting sandbox services...");

      let stopListen: (() => void) | null = null;
      try {
        stopListen = await listen(
          "openwork://sandbox-create-progress",
          (event: TauriEvent<{ runId?: string; stage?: string; message?: string; payload?: any }>) => {
            const payload = event.payload ?? {};
            if ((payload.runId ?? "").trim() !== runId) return;
            const stage = String(payload.stage ?? "").trim();
            const message = String(payload.message ?? "").trim();
            if (message) {
              setSandboxStage(message);
              pushSandboxCreateLog(message);
            }

            if (stage === "docker.container") {
              const state = String(payload.payload?.containerState ?? "").trim();
              if (state) {
                setSandboxStep("sandbox", { status: "active", detail: `Container: ${state}` });
              }
            }

            if (stage === "docker.config") {
              const selected = String(payload.payload?.openworkDockerBin ?? "").trim();
              if (selected) {
                pushSandboxCreateLog(`OPENWORK_DOCKER_BIN=${selected}`);
              }
              const resolved = String(payload.payload?.resolvedDockerBin ?? "").trim();
              if (resolved) {
                pushSandboxCreateLog(`Resolved docker: ${resolved}`);
              }
              const candidates = Array.isArray(payload.payload?.candidates)
                ? payload.payload.candidates.filter((item: unknown) => String(item ?? "").trim())
                : [];
              if (candidates.length) {
                pushSandboxCreateLog(`Docker probe paths: ${candidates.join(", ")}`);
              }
            }

            if (stage === "docker.inspect") {
              const inspectError = String(payload.payload?.error ?? "").trim();
              if (inspectError) {
                setSandboxStep("sandbox", { status: "active", detail: "Docker inspect warning" });
                pushSandboxCreateLog(`docker inspect warning: ${inspectError}`);
              }
            }

            if (stage === "openwork.waiting") {
              const elapsedMs = Number(payload.payload?.elapsedMs ?? 0);
              const seconds = elapsedMs > 0 ? Math.max(1, Math.floor(elapsedMs / 1000)) : 0;
              setSandboxStep("health", { status: "active", detail: seconds ? `${seconds}s` : null });
              const probeError = String(payload.payload?.containerProbeError ?? "").trim();
              if (probeError) {
                pushSandboxCreateLog(`Container probe: ${probeError}`);
              }
            }

            if (stage === "openwork.healthy") {
              setSandboxStep("sandbox", { status: "done" });
              setSandboxStep("health", { status: "done", detail: null });
            }

            if (stage === "error") {
              const err = String(payload.payload?.error ?? "").trim() || message || "Sandbox failed to start";
              setSandboxStep("sandbox", { status: "error", detail: err });
              setSandboxStep("health", { status: "error", detail: err });
              setSandboxError(err);
            }
          },
        );

        const host = await orchestratorStartDetached({
          workspacePath: resolvedFolder,
          sandboxBackend: "docker",
          runId,
        });
        setSandboxStep("sandbox", { status: "done", detail: host.sandboxContainerName ?? null });
        setSandboxStep("health", { status: "done" });
        setSandboxStage("Connecting to sandbox...");

        setSandboxStep("connect", { status: "active", detail: null });

        const ok = await createRemoteWorkspaceFlow({
          openworkHostUrl: host.openworkUrl,
          openworkToken: host.ownerToken?.trim() || host.token,
          openworkClientToken: host.token,
          openworkHostToken: host.hostToken,
          directory: resolvedFolder,
          displayName: name,
          sandboxBackend: host.sandboxBackend ?? "docker",
          sandboxRunId: host.sandboxRunId ?? runId,
          sandboxContainerName: host.sandboxContainerName ?? null,
          manageBusy: false,
          closeModal: false,
        });
        if (!ok) {
          const fallback = "Failed to connect to sandbox";
          pushSandboxCreateLog(fallback);
          setSandboxStep("connect", { status: "error", detail: fallback });
          setSandboxError(fallback);
          return false;
        }

        if (input?.onReady) {
          setSandboxCreatePhase("finalizing");
          setSandboxStage("Finalizing worker...");
          setSandboxStep("connect", { status: "active", detail: "Applying setup" });
          pushSandboxCreateLog("Applying final worker setup...");
          await input.onReady();
        }

        setSandboxStep("connect", { status: "done", detail: null });
        setSandboxStage("Sandbox ready.");
        setCreateWorkspaceOpen(false);
        clearSandboxCreateProgress();
        return true;
      } finally {
        stopListen?.();
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
      setSandboxError(message);
      setSandboxStage("Sandbox failed");
      return false;
    } finally {
      setSandboxPreflightBusy(false);
      setSandboxCreatePhase("idle");
    }
  }

  async function createRemoteWorkspaceFlow(input: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    openworkClientToken?: string | null;
    openworkHostToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
    manageBusy?: boolean;
    closeModal?: boolean;

    // Sandbox lifecycle metadata (desktop-managed)
    sandboxBackend?: "docker" | null;
    sandboxRunId?: string | null;
    sandboxContainerName?: string | null;
  }) {
    if (createRemoteInFlight) {
      wsDebug("create-remote:dedupe", {
        hostUrl: input.openworkHostUrl ?? null,
        directory: input.directory ?? null,
      });
      return createRemoteInFlight;
    }

    const run = (async () => {
    const hostUrl = normalizeOpenworkServerUrl(input.openworkHostUrl ?? "") ?? "";
    const token = input.openworkToken?.trim() ?? "";
    const directory = input.directory?.trim() ?? "";
    const displayName = input.displayName?.trim() || null;

    if (!hostUrl) {
      options.setError(t("app.error.remote_base_url_required", currentLocale()));
      return false;
    }

    options.setError(null);
    console.log("[workspace] create remote request", {
      hostUrl: hostUrl || null,
      directory: directory || null,
      displayName,
    });

    options.setStartupPreference("server");

    let remoteType: "openwork" = "openwork";
    let resolvedBaseUrl = "";
    let resolvedDirectory = directory;
    let openworkWorkspace: OpenworkWorkspaceInfo | null = null;
    let resolvedAuth: OpencodeAuth | undefined = undefined;
    let resolvedHostUrl = hostUrl;

    options.openworkServer.updateOpenworkServerSettings({
      ...options.openworkServer.openworkServerSettings(),
      urlOverride: hostUrl,
      token: token || undefined,
    });

    try {
      let resolved: Awaited<ReturnType<typeof resolveOpenworkHost>> | null = null;
      try {
        resolved = await resolveOpenworkHost({
          hostUrl,
          token,
          directoryHint: directory || null,
        });
      } catch (error) {
        // Sandbox workers can report healthy before listWorkspaces is fully ready.
        // Fall back to host-level OpenCode URL so the worker can still be registered.
        if (input.sandboxBackend !== "docker") {
          throw error;
        }
        wsDebug("sandbox:openwork-resolve-fallback:error", {
          hostUrl,
          message: error instanceof Error ? error.message : safeStringify(error),
        });
      }

      if (resolved?.kind === "openwork") {
        resolvedBaseUrl = resolved.opencodeBaseUrl;
        resolvedDirectory = resolved.directory || directory;
        openworkWorkspace = resolved.workspace;
        resolvedHostUrl = resolved.hostUrl;
        resolvedAuth = resolved.auth;
      } else if (input.sandboxBackend === "docker") {
        resolvedHostUrl = hostUrl;
        resolvedBaseUrl = `${hostUrl.replace(/\/+$/, "")}/opencode`;
        resolvedDirectory = directory || resolvedDirectory;
        resolvedAuth = token ? { token, mode: "openwork" } : undefined;
        wsDebug("sandbox:openwork-resolve-fallback:host", {
          hostUrl: resolvedHostUrl,
          baseUrl: resolvedBaseUrl,
          directory: resolvedDirectory,
        });
      } else {
        options.setError("OpenWork server unavailable. Check the URL and token.");
        return false;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      options.setError(addOpencodeCacheHint(message));
      return false;
    }

    if (!resolvedBaseUrl) {
      options.setError(t("app.error.remote_base_url_required", currentLocale()));
      return false;
    }

    const ok = await connectToServer(
      resolvedBaseUrl,
      resolvedDirectory || undefined,
      {
        workspaceType: "remote",
        targetRoot: resolvedDirectory ?? "",
        reason: "workspace-create-remote",
      },
      resolvedAuth,
    );

    if (!ok) {
      return false;
    }

    const finalDirectory = options.clientDirectory().trim() || resolvedDirectory || "";

    const manageBusy = input.manageBusy ?? true;
    if (manageBusy) {
      options.setBusy(true);
      options.setBusyLabel("status.creating_workspace");
      options.setBusyStartedAt(Date.now());
    }

    try {
      let createdWorkspaceId: string | null = null;
      if (isTauriRuntime()) {
        const ws = await workspaceCreateRemote({
          baseUrl: resolvedBaseUrl.replace(/\/+$/, ""),
          directory: finalDirectory ? finalDirectory : null,
          displayName,
          remoteType,
          openworkHostUrl: remoteType === "openwork" ? resolvedHostUrl : null,
          openworkToken: remoteType === "openwork" ? (token || null) : null,
          openworkClientToken:
            remoteType === "openwork" ? (input.openworkClientToken?.trim() || null) : null,
          openworkHostToken:
            remoteType === "openwork" ? (input.openworkHostToken?.trim() || null) : null,
          openworkWorkspaceId: remoteType === "openwork" ? openworkWorkspace?.id ?? null : null,
          openworkWorkspaceName: remoteType === "openwork" ? openworkWorkspace?.name ?? null : null,
          sandboxBackend: input.sandboxBackend ?? null,
          sandboxRunId: input.sandboxRunId ?? null,
          sandboxContainerName: input.sandboxContainerName ?? null,
        });
        setWorkspaces(ws.workspaces);
        const nextSelectedId = pickSelectedWorkspaceId(ws.workspaces, [resolveWorkspaceListSelectedId(ws)], ws);
        createdWorkspaceId = nextSelectedId;
        syncSelectedWorkspaceId(nextSelectedId);
        console.log("[workspace] create remote complete:", nextSelectedId || "none");
      } else {
        const workspaceId = `remote:${resolvedBaseUrl}:${finalDirectory}`;
        createdWorkspaceId = workspaceId;
        const nextWorkspace: WorkspaceInfo = {
          id: workspaceId,
          name: displayName ?? openworkWorkspace?.name ?? resolvedHostUrl ?? resolvedBaseUrl,
          path: "",
          preset: "remote",
          workspaceType: "remote",
          remoteType,
          baseUrl: resolvedBaseUrl,
          directory: finalDirectory || null,
          displayName,
          openworkHostUrl: remoteType === "openwork" ? resolvedHostUrl : null,
          openworkToken: remoteType === "openwork" ? (token || null) : null,
          openworkClientToken:
            remoteType === "openwork" ? (input.openworkClientToken?.trim() || null) : null,
          openworkHostToken:
            remoteType === "openwork" ? (input.openworkHostToken?.trim() || null) : null,
          openworkWorkspaceId: remoteType === "openwork" ? openworkWorkspace?.id ?? null : null,
          openworkWorkspaceName: remoteType === "openwork" ? openworkWorkspace?.name ?? null : null,
          sandboxBackend: input.sandboxBackend ?? null,
          sandboxRunId: input.sandboxRunId ?? null,
          sandboxContainerName: input.sandboxContainerName ?? null,
        };

        setWorkspaces((prev) => {
          const withoutMatch = prev.filter((workspace) => workspace.id !== workspaceId);
          return [...withoutMatch, nextWorkspace];
        });
        syncSelectedWorkspaceId(workspaceId);
        console.log("[workspace] create remote complete:", workspaceId);
      }

      if (createdWorkspaceId) {
        setConnectedWorkspaceId(createdWorkspaceId);
      }

      setProjectDir(finalDirectory);
      setWorkspaceConfig(null);
      setWorkspaceConfigLoaded(true);
      setAuthorizedDirs([]);

      const closeModal = input.closeModal ?? true;
      if (closeModal) {
        setCreateWorkspaceOpen(false);
        setCreateRemoteWorkspaceOpen(false);
      }
      if (createdWorkspaceId) {
        updateWorkspaceConnectionState(createdWorkspaceId, { status: "connected", message: null });
      }

      await openEmptySession(selectedWorkspaceRoot().trim() || finalDirectory);
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      console.log("[workspace] create remote failed:", message);
      options.setError(addOpencodeCacheHint(message));
      return false;
    } finally {
      if (manageBusy) {
        options.setBusy(false);
        options.setBusyLabel(null);
        options.setBusyStartedAt(null);
      }
    }
    })();

    createRemoteInFlight = run;
    try {
      return await run;
    } finally {
      if (createRemoteInFlight === run) {
        createRemoteInFlight = null;
      }
    }
  }

  async function updateRemoteWorkspaceFlow(
    workspaceId: string,
    input: {
      openworkHostUrl?: string | null;
      openworkToken?: string | null;
      openworkClientToken?: string | null;
      openworkHostToken?: string | null;
      directory?: string | null;
      displayName?: string | null;
    },
  ) {
    const id = workspaceId.trim();
    if (!id) return false;
    const workspace = workspaces().find((item) => item.id === id) ?? null;
    if (!workspace || workspace.workspaceType !== "remote") return false;

    const remoteType = normalizeRemoteType(workspace.remoteType);
    if (remoteType !== "openwork") {
      options.setError("Only OpenWork remote workers can be edited.");
      return false;
    }

    const hostUrl =
      normalizeOpenworkServerUrl(
        input.openworkHostUrl ?? workspace.openworkHostUrl ?? workspace.baseUrl ?? "",
      ) ?? "";
    const token =
      input.openworkToken?.trim() ??
      workspace.openworkToken?.trim() ??
      options.openworkServer.openworkServerSettings().token ??
      "";
    const directory = input.directory?.trim() ?? "";
    const displayName = input.displayName?.trim() || null;

    if (!hostUrl) {
      options.setError(t("app.error.remote_base_url_required", currentLocale()));
      return false;
    }

    options.setError(null);
    options.setStartupPreference("server");

    let resolvedBaseUrl = "";
    let resolvedDirectory = directory;
    let openworkWorkspace: OpenworkWorkspaceInfo | null = null;
    let resolvedAuth: OpencodeAuth | undefined = undefined;
    let resolvedHostUrl = hostUrl;

    options.openworkServer.updateOpenworkServerSettings({
      ...options.openworkServer.openworkServerSettings(),
      urlOverride: hostUrl,
      token: token || undefined,
    });

    try {
      const resolved = await resolveOpenworkHost({
        hostUrl,
        token,
        workspaceId: workspace.openworkWorkspaceId ?? null,
        directoryHint: directory || null,
      });
      if (resolved.kind !== "openwork") {
        options.setError("OpenWork server unavailable. Check the URL and token.");
        return false;
      }
      resolvedBaseUrl = resolved.opencodeBaseUrl;
      resolvedDirectory = resolved.directory || directory;
      openworkWorkspace = resolved.workspace;
      resolvedHostUrl = resolved.hostUrl;
      resolvedAuth = resolved.auth;
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      options.setError(addOpencodeCacheHint(message));
      return false;
    }

    if (!resolvedBaseUrl) {
      options.setError(t("app.error.remote_base_url_required", currentLocale()));
      return false;
    }

    const isActive = connectedWorkspaceId() === id;
    const finalDirectory = resolvedDirectory || "";

    if (isActive) {
      updateWorkspaceConnectionState(id, { status: "connecting", message: null });
      const ok = await connectToServer(
        resolvedBaseUrl,
        finalDirectory || undefined,
        {
          workspaceId: id,
          workspaceType: "remote",
          targetRoot: finalDirectory ?? "",
          reason: "workspace-edit-remote",
        },
        resolvedAuth,
      );
      if (!ok) {
        updateWorkspaceConnectionState(id, {
          status: "error",
          message: "Failed to connect to worker.",
        });
        return false;
      }
    }

    if (isTauriRuntime()) {
      try {
        const ws = await workspaceUpdateRemote({
          workspaceId: id,
          remoteType: "openwork",
          baseUrl: resolvedBaseUrl,
          directory: finalDirectory ? finalDirectory : null,
          displayName,
          openworkHostUrl: resolvedHostUrl,
          openworkToken: token ? token : null,
          openworkClientToken:
            input.openworkClientToken?.trim() || workspace.openworkClientToken?.trim() || null,
          openworkHostToken:
            input.openworkHostToken?.trim() || workspace.openworkHostToken?.trim() || null,
          openworkWorkspaceId: openworkWorkspace?.id ?? workspace.openworkWorkspaceId ?? null,
          openworkWorkspaceName: openworkWorkspace?.name ?? workspace.openworkWorkspaceName ?? null,
        });
        setWorkspaces(ws.workspaces);
        syncSelectedWorkspaceId(pickSelectedWorkspaceId(ws.workspaces, [id, selectedWorkspaceId()], ws));
      } catch {
        // ignore
      }
    } else {
      setWorkspaces((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                remoteType: "openwork",
                baseUrl: resolvedBaseUrl,
                directory: finalDirectory ? finalDirectory : null,
                displayName,
                openworkHostUrl: resolvedHostUrl,
                openworkToken: token ? token : null,
                openworkClientToken:
                  input.openworkClientToken?.trim() || item.openworkClientToken?.trim() || null,
                openworkHostToken:
                  input.openworkHostToken?.trim() || item.openworkHostToken?.trim() || null,
                openworkWorkspaceId: openworkWorkspace?.id ?? item.openworkWorkspaceId ?? null,
                openworkWorkspaceName: openworkWorkspace?.name ?? item.openworkWorkspaceName ?? null,
              }
            : item,
        ),
      );
    }

    if (isActive) {
      setProjectDir(finalDirectory);
      setWorkspaceConfig(null);
      setWorkspaceConfigLoaded(true);
      setAuthorizedDirs([]);
      updateWorkspaceConnectionState(id, { status: "connected", message: null });
    }

    return true;
  }

  async function forgetWorkspace(workspaceId: string) {
    if (!isTauriRuntime()) {
      options.setError(t("app.error.tauri_required", currentLocale()));
      return;
    }

    const id = workspaceId.trim();
    if (!id) return;
    const workspace = workspaces().find((entry) => entry.id === id) ?? null;

    console.log("[workspace] forget", { id });

    try {
      const previousActive = selectedWorkspaceId();
      const openworkWorkspace = workspace?.workspaceType === "local" ? await findOpenworkWorkspaceByPath(workspace.path) : null;
      const ws = openworkWorkspace
        ? await openworkWorkspace.client.deleteWorkspace(openworkWorkspace.workspaceId).then((response) => ({
            activeId: response.activeId ?? "",
            workspaces: response.workspaces ?? response.items,
          }))
        : await workspaceForget(id);

      if (openworkWorkspace && isTauriRuntime()) {
        try {
          await workspaceForget(id);
        } catch {
          // ignore desktop mirror failures here
        }
      }

      if (openworkWorkspace) {
        applyServerLocalWorkspaces(ws.workspaces, ws.activeId);
      } else {
        setWorkspaces(ws.workspaces);
      }
      clearWorkspaceConnectionState(id);

      if (!openworkWorkspace) {
        syncSelectedWorkspaceId(pickSelectedWorkspaceId(ws.workspaces, [selectedWorkspaceId()], ws));
      }

      const nextSelectedId = pickSelectedWorkspaceId(ws.workspaces, [selectedWorkspaceId()], ws);
      const selected = ws.workspaces.find((w) => w.id === nextSelectedId) ?? null;
      // Snapshot the runtime root before the optimistic selected-workspace update
      // so activateWorkspace can still detect a real workspace transition.
      const prevProjectDir = resolveCurrentRuntimeRoot();
      if (selected) {
        setProjectDir(selected.workspaceType === "remote" ? selected.directory?.trim() ?? "" : selected.path);
      }

      if (nextSelectedId && nextSelectedId !== previousActive) {
        await activateWorkspace(nextSelectedId, { prevProjectDir });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
    }
  }

  async function recoverWorkspace(workspaceId: string) {
    const id = workspaceId.trim();
    if (!id) return false;
    if (connectingWorkspaceId() === id) return false;

    const workspace = workspaces().find((item) => item.id === id) ?? null;
    if (!workspace) return false;

    const reconnect = async () => {
      if (connectedWorkspaceId() === id) {
        return await activateWorkspace(id);
      }
      return await testWorkspaceConnection(id);
    };

    setConnectingWorkspaceId(id);
    options.setError(null);

    try {
      updateWorkspaceConnectionState(id, { status: "connecting", message: null });

      if (workspace.workspaceType !== "remote") {
        return Boolean(await reconnect());
      }

      const isSandboxWorkspace =
        workspace.sandboxBackend === "docker" || Boolean(workspace.sandboxContainerName?.trim());

      if (!isSandboxWorkspace) {
        return Boolean(await reconnect());
      }

      if (!isTauriRuntime()) {
        options.setError(t("app.error.tauri_required", currentLocale()));
        updateWorkspaceConnectionState(id, {
          status: "error",
          message: t("app.error.tauri_required", currentLocale()),
        });
        return false;
      }

      const workspacePath = workspace.directory?.trim() || workspace.path?.trim() || "";
      if (!workspacePath) {
        const message = "Worker folder is missing. Open Edit connection and try again.";
        options.setError(message);
        updateWorkspaceConnectionState(id, { status: "error", message });
        return false;
      }

      const doctor = await refreshSandboxDoctor();
      if (!doctor?.ready) {
        const detail =
          doctor?.error?.trim() ||
          "Docker needs to be running before we can get this worker back online.";
        throw new Error(detail);
      }

      const host = await orchestratorStartDetached({
        workspacePath,
        sandboxBackend: "docker",
        runId: workspace.sandboxRunId?.trim() || null,
        openworkToken:
          workspace.openworkClientToken?.trim() ||
          workspace.openworkToken?.trim() ||
          options.openworkServer.openworkServerSettings().token?.trim() ||
          null,
        openworkHostToken: workspace.openworkHostToken?.trim() || null,
      });

      const resolved = await resolveOpenworkHost({
        hostUrl: host.openworkUrl,
        token: host.ownerToken?.trim() || host.token,
        directoryHint: workspacePath,
      });

      if (resolved.kind !== "openwork") {
        throw new Error("Worker is still warming up. Try again in a few seconds.");
      }

      const updated = await workspaceUpdateRemote({
        workspaceId: id,
        remoteType: "openwork",
        baseUrl: resolved.opencodeBaseUrl,
        directory: resolved.directory || workspacePath,
        openworkHostUrl: resolved.hostUrl,
        openworkToken: host.ownerToken?.trim() || host.token,
        openworkClientToken: host.token,
        openworkHostToken: host.hostToken,
        openworkWorkspaceId: resolved.workspace.id,
        openworkWorkspaceName: resolved.workspace.name ?? workspace.openworkWorkspaceName ?? null,
        sandboxBackend: host.sandboxBackend ?? "docker",
        sandboxRunId: host.sandboxRunId ?? workspace.sandboxRunId ?? null,
        sandboxContainerName: host.sandboxContainerName ?? workspace.sandboxContainerName ?? null,
      });

      setWorkspaces(updated.workspaces);
      syncSelectedWorkspaceId(pickSelectedWorkspaceId(updated.workspaces, [id, selectedWorkspaceId()], updated));

      const ok = await reconnect();
      if (!ok) {
        const message = "Worker restarted, but reconnect failed. Try again in a few seconds.";
        updateWorkspaceConnectionState(id, { status: "error", message });
        options.setError(message);
        return false;
      }

      updateWorkspaceConnectionState(id, { status: "connected", message: null });
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      const hint = addOpencodeCacheHint(message);
      options.setError(hint);
      updateWorkspaceConnectionState(id, { status: "error", message: hint });
      return false;
    } finally {
      setConnectingWorkspaceId((current) => (current === id ? null : current));
    }
  }

  async function pickWorkspaceFolder() {
    if (!isTauriRuntime()) {
      options.setError(t("app.error.tauri_required", currentLocale()));
      return null;
    }

    try {
      const selection = await pickDirectory({ title: t("onboarding.choose_workspace_folder", currentLocale()) });
      const folder =
        typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;

      return folder ?? null;
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
      return null;
    }
  }

  function joinNativePath(base: string, leaf: string) {
    const trimmedBase = base.replace(/[\\/]+$/, "");
    if (!trimmedBase) return leaf;
    const separator = trimmedBase.includes("\\") ? "\\" : "/";
    return `${trimmedBase}${separator}${leaf}`;
  }

  function deriveWorkspaceName(folderPath: string, preset: WorkspacePreset) {
    return folderPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "Worker";
  }

  async function resolveFirstRunWelcomeFolder() {
    const base = (await homeDir()).replace(/[\\/]+$/, "");
    return joinNativePath(joinNativePath(base, DEFAULT_WORKSPACE_HOME_FOLDER_NAME), FIRST_RUN_WELCOME_WORKSPACE_NAME);
  }

  async function exportWorkspaceConfig(workspaceId?: string) {
    if (exportingWorkspaceConfig()) return;
    if (!isTauriRuntime()) {
      options.setError(t("app.error.tauri_required", currentLocale()));
      return;
    }

    const targetId = workspaceId?.trim() || selectedWorkspaceInfo()?.id || "";
    if (!targetId) {
      options.setError("Select a worker to export");
      return;
    }
    const target = workspaces().find((ws) => ws.id === targetId) ?? null;
    if (!target) {
      options.setError("Unknown worker");
      return;
    }
    if (target.workspaceType === "remote") {
      options.setError("Export is only supported for local workers");
      return;
    }

    setExportingWorkspaceConfig(true);
    options.setError(null);

    try {
      const nameBase = (target.displayName || target.name || "worker")
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
      const dateStamp = new Date().toISOString().slice(0, 10);
      const fileName = `openwork-${nameBase || "worker"}-${dateStamp}.openwork-workspace`;
      const downloads = await downloadDir().catch(() => null);
      const defaultPath = downloads ? `${downloads}/${fileName}` : fileName;

      const outputPath = await saveFile({
        title: "Export worker config",
        defaultPath,
        filters: [{ name: "OpenWork Worker", extensions: ["openwork-workspace", "zip"] }],
      });

      if (!outputPath) {
        return;
      }

      await workspaceExportConfig({
        workspaceId: target.id,
        outputPath,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
    } finally {
      setExportingWorkspaceConfig(false);
    }
  }

  async function importWorkspaceConfig() {
    if (importingWorkspaceConfig()) return;
    if (!isTauriRuntime()) {
      options.setError(t("app.error.tauri_required", currentLocale()));
      return;
    }

    setImportingWorkspaceConfig(true);
    options.setError(null);

    try {
      const selection = await pickFile({
        title: "Import worker config",
        filters: [{ name: "OpenWork Worker", extensions: ["openwork-workspace", "zip"] }],
      });
      const filePath =
        typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;
      if (!filePath) return;

      const target = await pickDirectory({
        title: "Choose a worker folder",
      });
      const folder =
        typeof target === "string" ? target : Array.isArray(target) ? target[0] : null;
      if (!folder) return;

      const resolvedFolder = await resolveWorkspacePath(folder);
      if (!resolvedFolder) {
        options.setError(t("app.error.choose_folder", currentLocale()));
        return;
      }

      const ws = await workspaceImportConfig({
        archivePath: filePath,
        targetDir: resolvedFolder,
      });

      setWorkspaces(ws.workspaces);
      const nextSelectedId = pickSelectedWorkspaceId(ws.workspaces, [resolveWorkspaceListSelectedId(ws)], ws);
      syncSelectedWorkspaceId(nextSelectedId);
      setCreateWorkspaceOpen(false);
      setCreateRemoteWorkspaceOpen(false);

      const opened = await activateFreshLocalWorkspace(nextSelectedId || null, resolvedFolder);
      if (!opened) {
        return;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
    } finally {
      setImportingWorkspaceConfig(false);
    }
  }

  async function startHost(optionsOverride?: { workspacePath?: string; navigate?: boolean }) {
    if (!isTauriRuntime()) {
      options.setError(t("app.error.tauri_required", currentLocale()));
      return false;
    }

    const overrideWorkspacePath = optionsOverride?.workspacePath?.trim() ?? "";
    if (selectedWorkspaceInfo()?.workspaceType === "remote" && !overrideWorkspacePath) {
      options.setError(t("app.error.host_requires_local", currentLocale()));
      return false;
    }

    const dir = (overrideWorkspacePath || selectedWorkspacePath() || projectDir()).trim();
    if (!dir) {
      options.setError(t("app.error.pick_workspace_folder", currentLocale()));
      return false;
    }

      try {
        const source = options.engineSource();
        const result = await engineDoctor({
          preferSidecar: source === "sidecar",
          opencodeBinPath: source === "custom" ? options.engineCustomBinPath?.().trim() || null : null,
        });
        setEngineDoctorResult(result);
        setEngineDoctorCheckedAt(Date.now());

        if (!result.found) {
          options.setError(
            options.isWindowsPlatform()
            ? "OpenCode CLI not found. Install the OpenWork-pinned OpenCode version for Windows or bundle opencode.exe with OpenWork, then restart. If it is installed, ensure `opencode.exe` is on PATH (try `opencode --version` in PowerShell)."
            : "OpenCode CLI not found. Install the OpenWork-pinned OpenCode version, then retry.",
        );
        return false;
      }

      if (!result.supportsServe) {
        const serveDetails = [result.serveHelpStdout, result.serveHelpStderr]
          .filter((value) => value && value.trim())
          .join("\n\n");
        const suffix = serveDetails ? `\n\nServe output:\n${serveDetails}` : "";
        options.setError(
          `OpenCode CLI is installed, but \`opencode serve\` is unavailable. Update to the OpenWork-pinned OpenCode version and retry.${suffix}`
        );
        return false;
      }
    } catch (e) {
      setEngineInstallLogs(e instanceof Error ? e.message : safeStringify(e));
    }

    options.setError(null);
    options.setBusy(true);
    options.setBusyLabel("status.starting_engine");
    options.setBusyStartedAt(Date.now());

    try {
      setProjectDir(dir);
      if (!authorizedDirs().length) {
        setAuthorizedDirs([dir]);
      }

      const info = await engineStart(dir, {
        preferSidecar: options.engineSource() === "sidecar",
        opencodeBinPath:
          options.engineSource() === "custom" ? options.engineCustomBinPath?.().trim() || null : null,
        opencodeEnableExa: options.opencodeEnableExa?.() ?? false,
        openworkRemoteAccess: options.openworkServer.openworkServerSettings().remoteAccessEnabled === true,
        runtime: resolveEngineRuntime(),
        workspacePaths: resolveWorkspacePaths(),
      });
      setEngine(info);

      const username = info.opencodeUsername?.trim() ?? "";
      const password = info.opencodePassword?.trim() ?? "";
      const auth = username && password ? { username, password } : undefined;
      setEngineAuth(auth ?? null);

      if (info.baseUrl) {
        const ok = await connectToServer(
          info.baseUrl,
          dir,
          { workspaceType: "local", targetRoot: dir, reason: "host-start" },
          auth,
          { navigate: optionsOverride?.navigate ?? true },
        );
        if (!ok) return false;
      }

      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
      return false;
    } finally {
      options.setBusy(false);
      options.setBusyLabel(null);
      options.setBusyStartedAt(null);
    }
  }

  async function updateWorkspaceDisplayName(workspaceId: string, displayName: string | null) {
    const id = workspaceId.trim();
    if (!id) return false;
    const workspace = workspaces().find((item) => item.id === id) ?? null;
    if (!workspace) return false;

    const nextDisplayName = displayName?.trim() || null;
    options.setError(null);

    const openworkWorkspace = workspace.workspaceType === "local"
      ? await findOpenworkWorkspaceByPath(workspace.path)
      : null;

    if (openworkWorkspace) {
      try {
        const ws = await openworkWorkspace.client.updateWorkspaceDisplayName(openworkWorkspace.workspaceId, nextDisplayName);
        if (isTauriRuntime()) {
          try {
            await workspaceUpdateDisplayName({ workspaceId: id, displayName: nextDisplayName });
          } catch {
            // ignore desktop mirror failures here
          }
        }
        applyServerLocalWorkspaces(ws.workspaces, ws.activeId);
        updateWorkspaceConnectionState(id, { status: "connected", message: null });
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : safeStringify(e);
        options.setError(addOpencodeCacheHint(message));
        return false;
      }
    }

    if (isTauriRuntime()) {
      try {
        const ws = await workspaceUpdateDisplayName({ workspaceId: id, displayName: nextDisplayName });
        setWorkspaces(ws.workspaces);
        syncSelectedWorkspaceId(pickSelectedWorkspaceId(ws.workspaces, [id, selectedWorkspaceId()], ws));
        updateWorkspaceConnectionState(id, { status: "connected", message: null });
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : safeStringify(e);
        options.setError(addOpencodeCacheHint(message));
        return false;
      }
    }

    setWorkspaces((prev) =>
      prev.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              displayName: nextDisplayName,
              name: nextDisplayName ?? entry.name,
            }
          : entry
      )
    );
    return true;
  }

  const openRenameWorkspace = (workspaceId: string) => {
    const workspace = workspaces().find((item) => item.id === workspaceId) ?? null;
    if (!workspace) return;
    setRenameWorkspaceId(workspaceId);
    setRenameWorkspaceName(
      workspace.displayName?.trim() ||
        workspace.openworkWorkspaceName?.trim() ||
        workspace.name?.trim() ||
        "",
    );
    setRenameWorkspaceOpen(true);
  };

  const closeRenameWorkspace = () => {
    if (renameWorkspaceBusy()) return;
    setRenameWorkspaceOpen(false);
    setRenameWorkspaceId(null);
    setRenameWorkspaceName("");
  };

  const saveRenameWorkspace = async () => {
    const workspaceId = renameWorkspaceId();
    if (!workspaceId) return;
    const nextName = renameWorkspaceName().trim();
    if (!nextName) return;
    if (renameWorkspaceBusy()) return;

    setRenameWorkspaceBusy(true);
    options.setError(null);
    try {
      const ok = await updateWorkspaceDisplayName(workspaceId, nextName);
      if (!ok) return;
      setRenameWorkspaceOpen(false);
      setRenameWorkspaceId(null);
      setRenameWorkspaceName("");
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
    } finally {
      setRenameWorkspaceBusy(false);
    }
  };

  const closeWorkspaceConnectionSettings = () => {
    setEditRemoteWorkspaceOpen(false);
    setEditRemoteWorkspaceId(null);
    setEditRemoteWorkspaceError(null);
  };

  const saveWorkspaceConnectionSettings = async (input: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
  }) => {
    const workspaceId = editRemoteWorkspaceId();
    if (!workspaceId) return;
    setEditRemoteWorkspaceError(null);
    try {
      const ok = await updateRemoteWorkspaceFlow(workspaceId, input);
      if (ok) {
        closeWorkspaceConnectionSettings();
        return;
      }
      setEditRemoteWorkspaceError(t("app.error_connection_failed_url", currentLocale()));
      options.setError(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : t("app.error_connection_failed", currentLocale());
      setEditRemoteWorkspaceError(message);
      options.setError(null);
    }
  };

  const openWorkspaceConnectionSettings = (workspaceId: string) => {
    const workspace = workspaces().find((item) => item.id === workspaceId) ?? null;
    if (workspace?.workspaceType === "remote") {
      setEditRemoteWorkspaceId(workspace.id);
      setEditRemoteWorkspaceError(null);
      setEditRemoteWorkspaceOpen(true);
      return;
    }
    setEditRemoteWorkspaceId(null);
    setEditRemoteWorkspaceError(null);
    options.setSettingsTab("advanced");
    options.setView("settings");
  };

  async function stopHost() {
    options.setError(null);
    options.setBusy(true);
    options.setBusyLabel("status.disconnecting");
    options.setBusyStartedAt(Date.now());

    try {
      if (isTauriRuntime()) {
        const info = await engineStop();
        setEngine(info);
      }

      setEngineAuth(null);

      options.setClient(null);
      options.setConnectedVersion(null);
      setConnectedWorkspaceId(null);
      if (isTauriRuntime()) {
        try {
          await workspaceSetRuntimeActive(null);
        } catch {
          // ignore
        }
      }
      options.setSelectedSessionId(null);
      options.setMessages([]);
      options.setTodos([]);
      options.setPendingPermissions([]);
      options.setSessionStatusById({});
      options.setSseConnected(false);

      options.setStartupPreference(null);
      options.setOnboardingStep("welcome");

      options.setView("session");
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
      options.setBusyLabel(null);
      options.setBusyStartedAt(null);
    }
  }

  async function reloadWorkspaceEngine() {
    if (!isTauriRuntime()) {
      options.setError("Reloading the engine requires the desktop app.");
      return false;
    }

    if (selectedWorkspaceDisplay().workspaceType !== "local") {
      options.setError("Reload is only available for local workers.");
      return false;
    }

    const root = selectedWorkspacePath().trim();
    if (!root) {
      options.setError("Pick a worker folder first.");
      return false;
    }

    options.setError(null);
    options.setBusy(true);
    options.setBusyLabel("status.reloading_engine");
    options.setBusyStartedAt(Date.now());

    try {
      const runtime = engine()?.runtime ?? resolveEngineRuntime();
      if (runtime === "openwork-orchestrator") {
        await orchestratorInstanceDispose(root);
        await orchestratorWorkspaceActivate({
          workspacePath: root,
          name: selectedWorkspaceInfo()?.displayName?.trim() || selectedWorkspaceInfo()?.name?.trim() || null,
        });

        const nextInfo = await engineInfo();
        setEngine(nextInfo);

        const username = nextInfo.opencodeUsername?.trim() ?? "";
        const password = nextInfo.opencodePassword?.trim() ?? "";
        const auth = username && password ? { username, password } : undefined;
        setEngineAuth(auth ?? null);

        if (nextInfo.baseUrl) {
          const ok = await connectToServer(
            nextInfo.baseUrl,
            root,
            { workspaceType: "local", targetRoot: root, reason: "engine-reload-orchestrator" },
            auth,
          );
          if (!ok) {
            options.setError("Failed to reconnect after reload");
            return false;
          }
        }

        return true;
      }

      const info = await engineStop();
      setEngine(info);

      const nextInfo = await engineStart(root, {
        preferSidecar: options.engineSource() === "sidecar",
        opencodeBinPath:
          options.engineSource() === "custom" ? options.engineCustomBinPath?.().trim() || null : null,
        opencodeEnableExa: options.opencodeEnableExa?.() ?? false,
        openworkRemoteAccess: options.openworkServer.openworkServerSettings().remoteAccessEnabled === true,
        runtime,
        workspacePaths: resolveWorkspacePaths(),
      });
      setEngine(nextInfo);

      const username = nextInfo.opencodeUsername?.trim() ?? "";
      const password = nextInfo.opencodePassword?.trim() ?? "";
      const auth = username && password ? { username, password } : undefined;
      setEngineAuth(auth ?? null);

      if (nextInfo.baseUrl) {
        const ok = await connectToServer(
          nextInfo.baseUrl,
          root,
          { workspaceType: "local", targetRoot: root, reason: "engine-reload" },
          auth,
        );
        if (!ok) {
          options.setError("Failed to reconnect after reload");
          return false;
        }
      }

      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
      return false;
    } finally {
      options.setBusy(false);
      options.setBusyLabel(null);
      options.setBusyStartedAt(null);
    }
  }

  async function onInstallEngine() {
    options.setError(null);
    setEngineInstallLogs(null);
    options.setBusy(true);
    options.setBusyLabel("status.installing_opencode");
    options.setBusyStartedAt(Date.now());

    try {
      const result = await engineInstall();
      const combined = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
      setEngineInstallLogs(combined || null);

      if (!result.ok) {
        options.setError(result.stderr.trim() || t("app.error.install_failed", currentLocale()));
      }

      await refreshEngineDoctor();
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
      options.setBusyLabel(null);
      options.setBusyStartedAt(null);
    }
  }

  function normalizeRoots(list: string[]) {
    const out: string[] = [];
    for (const entry of list) {
      const trimmed = entry.trim().replace(/\/+$/, "");
      if (!trimmed) continue;
      if (!out.includes(trimmed)) out.push(trimmed);
    }
    return out;
  }

  async function resolveWorkspacePath(input: string) {
    const trimmed = input.trim();
    if (!trimmed) return "";
    if (!isTauriRuntime()) return trimmed;

    if (trimmed === "~") {
      try {
        return (await homeDir()).replace(/[\\/]+$/, "");
      } catch {
        return trimmed;
      }
    }

    if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
      try {
        const home = (await homeDir()).replace(/[\\/]+$/, "");
        return `${home}${trimmed.slice(1)}`;
      } catch {
        return trimmed;
      }
    }

    return trimmed;
  }

  async function persistAuthorizedRoots(nextRoots: string[]) {
    if (!isTauriRuntime()) return;
    if (selectedWorkspaceInfo()?.workspaceType === "remote") return;
    const root = selectedWorkspacePath().trim();
    if (!root) return;

    const existing = workspaceConfig();
    const cfg: WorkspaceOpenworkConfig = {
      version: existing?.version ?? 1,
      workspace: existing?.workspace ?? null,
      authorizedRoots: nextRoots,
      blueprint: existing?.blueprint ?? null,
      reload: existing?.reload ?? null,
    };

    const persistedViaServer = await persistWorkspaceConfigToOpenworkServer(cfg).catch(() => false);
    if (!persistedViaServer) {
      await workspaceOpenworkWrite({ workspacePath: root, config: cfg });
    }
    setWorkspaceConfig(cfg);
  }

  async function addAuthorizedDir() {
    if (selectedWorkspaceInfo()?.workspaceType === "remote") return;
    const next = newAuthorizedDir().trim();
    if (!next) return;

    const roots = normalizeRoots([...authorizedDirs(), next]);
    setAuthorizedDirs(roots);
    setNewAuthorizedDir("");

    try {
      await persistAuthorizedRoots(roots);
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
    }
  }

  async function addAuthorizedDirFromPicker(optionsOverride?: { persistToWorkspace?: boolean }) {
    if (!isTauriRuntime()) return;
    if (selectedWorkspaceInfo()?.workspaceType === "remote") return;

    try {
      const selection = await pickDirectory({ title: t("onboarding.authorize_folder", currentLocale()) });
      const folder =
        typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;
      if (!folder) return;

      const roots = normalizeRoots([...authorizedDirs(), folder]);
      setAuthorizedDirs(roots);

      if (optionsOverride?.persistToWorkspace) {
        await persistAuthorizedRoots(roots);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
    }
  }

  async function removeAuthorizedDir(dir: string) {
    if (selectedWorkspaceInfo()?.workspaceType === "remote") return;
    const roots = normalizeRoots(authorizedDirs().filter((root) => root !== dir));
    setAuthorizedDirs(roots);

    try {
      await persistAuthorizedRoots(roots);
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
    }
  }

  function removeAuthorizedDirAtIndex(index: number) {
    const roots = authorizedDirs();
    const target = roots[index];
    if (target) {
      void removeAuthorizedDir(target);
    }
  }

  function restoreLastSession() {
    const map = options.readLastSessionByWorkspace?.() ?? {};
    const workspaceId = selectedWorkspaceId().trim();
    if (!workspaceId) return;
    const lastSessionId = map[workspaceId]?.trim();
    if (!lastSessionId) return;
    if (options.selectedSessionId() === lastSessionId) return;
    options.setSelectedSessionId(lastSessionId);
    options.setView("session", lastSessionId);
    void options.selectSession(lastSessionId, { skipHealthCheck: true, source: "restore-last-session" });
  }

  async function bootstrapOnboarding() {
    const enterPhase = (phase: BootPhase, detail?: Record<string, unknown>) => {
      options.onBootPhaseChange?.(phase, detail);
      options.onStartupTrace?.(`phase:${phase}`, detail);
    };
    const markBranch = (branch: StartupBranch, detail?: Record<string, unknown>) => {
      options.onStartupBranch?.(branch, detail);
      options.onStartupTrace?.(`branch:${branch}`, detail);
    };

    const startupPref = readStartupPreference();
    let info: EngineInfo | null = null;

    if (isTauriRuntime()) {
      enterPhase("workspaceBootstrap", { source: "workspace_bootstrap" });
      try {
        const ws = await workspaceBootstrap();
        setWorkspaces(ws.workspaces);
        syncSelectedWorkspaceId(pickSelectedWorkspaceId(ws.workspaces, [resolveWorkspaceListSelectedId(ws)], ws));
      } catch (error) {
        options.onStartupTrace?.("workspace_bootstrap:error", {
          error: error instanceof Error ? error.message : safeStringify(error),
        });
      }
    }

    enterPhase("engineProbe", { source: "ts-probe" });
    void refreshEngine().catch(() => undefined);
    info = engine();
    void refreshEngineDoctor().catch(() => undefined);

    if (isTauriRuntime() && workspaces().length === 0) {
      markBranch("firstRunNoWorkspace", { startupPref });
      options.setStartupPreference("local");
      const welcomeFolder = await resolveFirstRunWelcomeFolder();
      const ok = await createWorkspaceFlow("starter", welcomeFolder);
      if (!ok) {
        options.setOnboardingStep("local");
      }
      enterPhase("ready", { reason: "first-run-no-workspace" });
      return;
    }

    if (isTauriRuntime()) {
      const active = workspaces().find((w) => w.id === selectedWorkspaceId()) ?? null;
      if (active) {
        if (active.workspaceType === "remote") {
          setProjectDir(active.directory?.trim() ?? "");
          setWorkspaceConfig(null);
          setWorkspaceConfigLoaded(true);
          setAuthorizedDirs([]);
          if (active.baseUrl) {
            options.setBaseUrl(active.baseUrl);
          }
        } else {
          setProjectDir(active.path);
          try {
            const cfg = await workspaceOpenworkRead({ workspacePath: active.path });
            setWorkspaceConfig(cfg);
            setWorkspaceConfigLoaded(true);
            const roots = Array.isArray(cfg.authorizedRoots) ? cfg.authorizedRoots : [];
            setAuthorizedDirs(roots.length ? roots : [active.path]);
          } catch {
            setWorkspaceConfig(null);
            setWorkspaceConfigLoaded(true);
            setAuthorizedDirs([active.path]);
          }

        }
      }
    }

    const localEngine = info ?? engine();
    if (localEngine?.baseUrl) {
      options.setBaseUrl(localEngine.baseUrl);
    }

    const activeWorkspace = selectedWorkspaceInfo();
    if (isTauriRuntime() && !localEngine?.baseUrl) {
      const firstLocalWorkspace = workspaces().find((workspace) => workspace.workspaceType === "local");
      if (firstLocalWorkspace?.path?.trim()) {
        enterPhase("engineStartOrConnect", { source: "bootstrap-first-local-host-start" });
        await startHost({ workspacePath: firstLocalWorkspace.path.trim(), navigate: false }).catch(() => false);
        info = engine();
      }
    }

    if (activeWorkspace?.workspaceType === "remote") {
      markBranch("remoteWorkspace", { workspaceId: activeWorkspace.id });
      options.setStartupPreference("server");
      options.setOnboardingStep("connecting");
      enterPhase("engineStartOrConnect", { source: "remote-activate" });
      const ok = await activateWorkspace(activeWorkspace.id);
      if (!ok) {
        options.setOnboardingStep("server");
      } else {
        enterPhase("sessionIndexReady", { source: "remote-activate" });
        restoreLastSession();
        enterPhase("firstSessionReady", { source: "restore-last-session" });
      }
      enterPhase("ready", { reason: "remote-workspace-branch" });
      return;
    }

    if (startupPref) {
      options.setStartupPreference(startupPref);
    }

    if (startupPref === "server") {
      markBranch("serverPreference", { startupPref });
      options.setOnboardingStep("server");
      enterPhase("ready", { reason: "server-preference" });
      return;
    }

    if (selectedWorkspacePath().trim()) {
      options.setStartupPreference("local");

      if (localEngine?.running && localEngine.baseUrl) {
        markBranch("localAttachExisting", {
          baseUrl: localEngine.baseUrl,
        });
        const bootstrapRoot = selectedWorkspacePath().trim() || localEngine.projectDir?.trim() || "";
        options.setOnboardingStep("connecting");
        enterPhase("engineStartOrConnect", { source: "bootstrap-local-attach" });
        const ok = await connectToServer(
          localEngine.baseUrl,
          bootstrapRoot || undefined,
          { workspaceType: "local", targetRoot: bootstrapRoot, reason: "bootstrap-local" },
          engineAuth() ?? undefined,
        );
        if (!ok) {
          options.setStartupPreference(null);
          options.setOnboardingStep("welcome");
          enterPhase("error", { reason: "bootstrap-local-connect-failed" });
          return;
        }
        enterPhase("sessionIndexReady", { source: "bootstrap-local-attach" });
        restoreLastSession();
        enterPhase("firstSessionReady", { source: "restore-last-session" });
        enterPhase("ready", { reason: "bootstrap-local-attach" });
        return;
      }

      markBranch("localHostStart", { workspacePath: selectedWorkspacePath().trim() });
      options.setOnboardingStep("connecting");
      enterPhase("engineStartOrConnect", { source: "bootstrap-local-host-start" });
      const ok = await startHost({ workspacePath: selectedWorkspacePath().trim() });
      if (!ok) {
        options.setOnboardingStep("local");
        enterPhase("error", { reason: "bootstrap-local-host-start-failed" });
        return;
      }
      enterPhase("sessionIndexReady", { source: "bootstrap-local-host-start" });
      restoreLastSession();
      enterPhase("firstSessionReady", { source: "restore-last-session" });
      enterPhase("ready", { reason: "bootstrap-local-host-start" });
      return;
    }

    if (startupPref === "local") {
      markBranch("localPreference", { startupPref });
      options.setOnboardingStep("local");
      enterPhase("ready", { reason: "local-preference" });
      return;
    }

    markBranch("welcome", { startupPref: startupPref ?? null });
    options.setOnboardingStep("welcome");
    enterPhase("ready", { reason: "default-welcome" });
  }

  function onSelectStartup(nextPref: StartupPreference) {
    if (options.rememberStartupChoice()) {
      writeStartupPreference(nextPref);
    }
    options.setStartupPreference(nextPref);
    options.setOnboardingStep(nextPref === "local" ? "local" : "server");
  }

  function onBackToWelcome() {
    options.setStartupPreference(null);
    options.setOnboardingStep("welcome");
  }

  async function onStartHost() {
    options.setStartupPreference("local");
    options.setOnboardingStep("connecting");
    const ok = await startHost({ workspacePath: selectedWorkspacePath().trim() });
    if (!ok) {
      options.setOnboardingStep("local");
    }
  }

  async function onAttachHost() {
    options.setStartupPreference("local");
    options.setOnboardingStep("connecting");
    const attachRoot = selectedWorkspacePath().trim() || engine()?.projectDir?.trim() || "";
    const ok = await connectToServer(
      engine()?.baseUrl ?? "",
      attachRoot || undefined,
      { workspaceType: "local", targetRoot: attachRoot, reason: "attach-local" },
      engineAuth() ?? undefined,
    );
    if (!ok) {
      options.setStartupPreference(null);
      options.setOnboardingStep("welcome");
    }
  }

  async function onConnectClient() {
    options.setStartupPreference("server");
    options.setOnboardingStep("connecting");
    const settings = options.openworkServer.openworkServerSettings();
    const ok = await createRemoteWorkspaceFlow({
      openworkHostUrl: settings.urlOverride ?? null,
      openworkToken: settings.token ?? null,
      directory: options.clientDirectory().trim() ? options.clientDirectory().trim() : null,
      displayName: null,
    });
    if (!ok) {
      options.setOnboardingStep("server");
    }
  }

  function onRememberStartupToggle() {
    if (typeof window === "undefined") return;
    const next = !options.rememberStartupChoice();
    options.setRememberStartupChoice(next);
    try {
      if (next) {
        const current = options.startupPreference();
        if (current === "local" || current === "server") {
          writeStartupPreference(current);
        }
      } else {
        clearStartupPreference();
      }
    } catch {
      // ignore
    }
  }

  return {
    engine,
    engineDoctorResult,
    engineDoctorCheckedAt,
    engineInstallLogs,
    sandboxDoctorResult,
    sandboxDoctorCheckedAt,
    sandboxDoctorBusy,
    sandboxPreflightBusy,
    sandboxCreatePhase,
    projectDir,
    workspaces,
    selectedWorkspaceId,
    authorizedDirs,
    newAuthorizedDir,
    workspaceConfig,
    workspaceConfigLoaded,
    createWorkspaceOpen,
    createRemoteWorkspaceOpen,
    editRemoteWorkspaceOpen,
    editRemoteWorkspaceId,
    editRemoteWorkspaceError,
    editRemoteWorkspaceDefaults,
    renameWorkspaceOpen,
    renameWorkspaceId,
    renameWorkspaceName,
    renameWorkspaceBusy,
    setRenameWorkspaceName,
    connectingWorkspaceId,
    connectedWorkspaceId,
    runtimeWorkspaceId,
    runtimeWorkspaceConfig,
    workspaceConnectionStateById,
    exportingWorkspaceConfig,
    importingWorkspaceConfig,
    selectedWorkspaceInfo,
    selectedWorkspaceDisplay,
    selectedWorkspacePath,
    selectedWorkspaceRoot,
    runtimeWorkspaceRoot,
    setCreateWorkspaceOpen,
    setCreateRemoteWorkspaceOpen,
    setProjectDir,
    setAuthorizedDirs,
    setNewAuthorizedDir,
    setWorkspaceConfig,
    setWorkspaceConfigLoaded,
    setWorkspaces,
    clearSelectedSessionSurface,
    syncSelectedWorkspaceId: syncSelectedWorkspaceId,
    workspaceRootForId,
    selectWorkspace,
    switchWorkspace,
    refreshEngine,
    refreshEngineDoctor,
    activateWorkspace,
    ensureRuntimeWorkspaceId,
    testWorkspaceConnection,
    connectToServer,
    createWorkspaceFlow,
    createSandboxFlow,
    createRemoteWorkspaceFlow,
    updateRemoteWorkspaceFlow,
    updateWorkspaceDisplayName,
    openRenameWorkspace,
    closeRenameWorkspace,
    saveRenameWorkspace,
    openWorkspaceConnectionSettings,
    closeWorkspaceConnectionSettings,
    saveWorkspaceConnectionSettings,
    forgetWorkspace,
    recoverWorkspace,
    pickWorkspaceFolder,
    exportWorkspaceConfig,
    importWorkspaceConfig,
    startHost,
    stopHost,
    reloadWorkspaceEngine,
    refreshRuntimeWorkspaceConfig,
    bootstrapOnboarding,
    onSelectStartup,
    onBackToWelcome,
    onStartHost,
    onAttachHost,
    onConnectClient,
    onRememberStartupToggle,
    onInstallEngine,
    addAuthorizedDir,
    addAuthorizedDirFromPicker,
    removeAuthorizedDir,
    removeAuthorizedDirAtIndex,
    setEngineInstallLogs,
    refreshSandboxDoctor,
    sandboxCreateProgress,
    lastSandboxCreateProgress,
    clearSandboxCreateProgress,
    workspaceDebugEvents,
    clearWorkspaceDebugEvents,
  };
}
