import { createEffect, createMemo, createSignal } from "solid-js";
import { listen, type Event as TauriEvent } from "@tauri-apps/api/event";

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
import {
  buildOpenworkWorkspaceBaseUrl,
  createOpenworkServerClient,
  normalizeOpenworkServerUrl,
  OpenworkServerError,
  type OpenworkServerClient,
  type OpenworkServerSettings,
  type OpenworkWorkspaceInfo,
} from "../lib/openwork-server";
import { downloadDir, homeDir } from "@tauri-apps/api/path";
import {
  engineDoctor,
  engineInfo,
  opencodeDbMigrate,
  engineInstall,
  engineStart,
  engineStop,
  sandboxDoctor,
  sandboxStop,
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
  workspaceSetActive,
  workspaceUpdateDisplayName,
  workspaceUpdateRemote,
  type EngineDoctorResult,
  type EngineInfo,
  type SandboxDoctorResult,
  type WorkspaceInfo,
} from "../lib/tauri";
import { waitForHealthy, createClient, type OpencodeAuth } from "../lib/opencode";
import type { OpencodeConnectStatus, ProviderListItem } from "../types";
import { t, currentLocale } from "../../i18n";
import { mapConfigProvidersToList } from "../utils/providers";

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

export type MigrationRepairResult = {
  ok: boolean;
  message: string;
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
  selectedSessionId: () => string | null;
  selectSession: (id: string) => Promise<void>;
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
  setEngineSource: (value: "path" | "sidecar" | "custom") => void;
  setView: (value: any) => void;
  setTab: (value: any) => void;
  isWindowsPlatform: () => boolean;
  openworkServerSettings: () => OpenworkServerSettings;
  updateOpenworkServerSettings: (next: OpenworkServerSettings) => void;
  openworkServerClient?: () => OpenworkServerClient | null;
  setOpencodeConnectStatus?: (status: OpencodeConnectStatus | null) => void;
  onEngineStable?: () => void;
  engineRuntime?: () => EngineRuntime;
  developerMode: () => boolean;
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
  const DB_MIGRATE_UNSUPPORTED_PATTERNS = [
    /unknown(?:\s+sub)?command\s+['"`]?db['"`]?/i,
    /unrecognized(?:\s+sub)?command\s+['"`]?db['"`]?/i,
    /no such command[:\s]+db/i,
    /found argument ['"`]db['"`] which wasn't expected/i,
  ] as const;

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

  const formatExecOutput = (result: { stdout: string; stderr: string }) => {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    return [stderr, stdout].filter(Boolean).join("\n\n");
  };

  const isDbMigrateUnsupported = (output: string) => {
    const normalized = output.trim();
    if (!normalized) return false;
    return DB_MIGRATE_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(normalized));
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
  const clearSandboxCreateProgress = () => setSandboxCreateProgress(null);

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
  const [activeWorkspaceId, setActiveWorkspaceId] = createSignal<string>("starter");

  const syncActiveWorkspaceId = (id: string) => {
    setActiveWorkspaceId(id);
  };

  const [authorizedDirs, setAuthorizedDirs] = createSignal<string[]>([]);
  const [newAuthorizedDir, setNewAuthorizedDir] = createSignal("");

  const [workspaceConfig, setWorkspaceConfig] = createSignal<WorkspaceOpenworkConfig | null>(null);
  const [workspaceConfigLoaded, setWorkspaceConfigLoaded] = createSignal(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = createSignal(false);
  const [createRemoteWorkspaceOpen, setCreateRemoteWorkspaceOpen] = createSignal(false);
  const [connectingWorkspaceId, setConnectingWorkspaceId] = createSignal<string | null>(null);
  const [workspaceConnectionStateById, setWorkspaceConnectionStateById] = createSignal<
    Record<string, WorkspaceConnectionState>
  >({});
  const [exportingWorkspaceConfig, setExportingWorkspaceConfig] = createSignal(false);
  const [importingWorkspaceConfig, setImportingWorkspaceConfig] = createSignal(false);
  const [migrationRepairBusy, setMigrationRepairBusy] = createSignal(false);
  const [migrationRepairResult, setMigrationRepairResult] = createSignal<MigrationRepairResult | null>(null);

  const activeWorkspaceInfo = createMemo(() => workspaces().find((w) => w.id === activeWorkspaceId()) ?? null);
  const activeWorkspaceDisplay = createMemo<WorkspaceDisplay>(() => {
    const ws = activeWorkspaceInfo();
    if (!ws) {
      return {
        id: "",
        name: "Worker",
        path: "",
        preset: "starter",
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
  const activeWorkspacePath = createMemo(() => {
    const ws = activeWorkspaceInfo();
    if (!ws) return "";
    if (ws.workspaceType === "remote") return ws.directory?.trim() ?? "";
    return ws.path ?? "";
  });
  const activeWorkspaceRoot = createMemo(() => activeWorkspacePath().trim());

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
    const active = activeWorkspacePath().trim();
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

  const activateOpenworkHostWorkspace = async (workspacePath: string) => {
    const client = options.openworkServerClient?.();
    if (!client) return;
    const targetPath = normalizeDirectoryPath(workspacePath);
    if (!targetPath) return;
    try {
      const response = await client.listWorkspaces();
      const items = Array.isArray(response.items) ? response.items : [];
      const match = items.find((entry) => normalizeDirectoryPath(entry.path) === targetPath);
      if (!match?.id) return;
      if (response.activeId === match.id) return;
      await client.activateWorkspace(match.id);
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

      const token = workspace.openworkToken?.trim() || options.openworkServerSettings().token || undefined;
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

      const isRemoteWorkspace = activeWorkspaceInfo()?.workspaceType === "remote";
      const syncLocalState = !isRemoteWorkspace;

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
          lastEngineReconnectAt = now;
          reconnectingEngine = true;
          connectToServer(
            info.baseUrl,
            info.projectDir ?? undefined,
            { reason: "engine-refresh" },
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

  async function activateWorkspace(workspaceId: string) {
    const id = workspaceId.trim();
    if (!id) return false;

    const next = workspaces().find((w) => w.id === id) ?? null;
    if (!next) return false;
    const isRemote = next.workspaceType === "remote";
    console.log("[workspace] activate", { id: next.id, type: next.workspaceType });
    const activateStart = Date.now();
    wsDebug("activate:start", {
      id: next.id,
      type: next.workspaceType,
      remoteType: next.remoteType ?? null,
      prevActiveId: activeWorkspaceId(),
      prevProjectDir: projectDir(),
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
          const fallbackToken = options.openworkServerSettings().token ?? "";
          const token = workspaceToken || fallbackToken;

          const currentSettings = options.openworkServerSettings();
          if (
            currentSettings.urlOverride?.trim() !== hostUrl ||
            (token && currentSettings.token?.trim() !== token)
          ) {
            options.updateOpenworkServerSettings({
              ...currentSettings,
              urlOverride: hostUrl,
              token: token || currentSettings.token,
            });
          }

          let resolvedBaseUrl = baseUrl;
          let resolvedDirectory = next.directory?.trim() ?? "";
          let workspaceInfo: OpenworkWorkspaceInfo | null = null;
          let resolvedAuth: OpencodeAuth | undefined = undefined;

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
              syncActiveWorkspaceId(ws.activeId);
            } catch {
              // ignore
            }
          } else {
            // In web mode, we still need to persist the resolved OpenWork connection
            // details onto the workspace entry so that the sidebar can list sessions
            // for multiple remotes at once (without relying on global server settings).
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

          syncActiveWorkspaceId(id);
          setProjectDir(resolvedDirectory || "");
          setWorkspaceConfig(null);
          setWorkspaceConfigLoaded(true);
          setAuthorizedDirs([]);

          if (isTauriRuntime()) {
            try {
              await workspaceSetActive(id);
            } catch {
              // ignore
            }
          }

          updateWorkspaceConnectionState(id, { status: "connected", message: null });
          return true;
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

        syncActiveWorkspaceId(id);
        setProjectDir(next.directory?.trim() ?? "");
        setWorkspaceConfig(null);
        setWorkspaceConfigLoaded(true);
        setAuthorizedDirs([]);

        if (isTauriRuntime()) {
          try {
            await workspaceSetActive(id);
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
    const oldWorkspacePath = projectDir();
    const workspaceChanged = oldWorkspacePath !== nextRoot;

    wsDebug("activate:local:prep", {
      id,
      nextRoot,
      workspaceChanged,
      wasLocalConnection: Boolean(wasLocalConnection),
      prevProjectDir: oldWorkspacePath,
    });

    syncActiveWorkspaceId(id);
    setProjectDir(nextRoot);

    if (isTauriRuntime()) {
      if (isRemote) {
        setWorkspaceConfig(null);
        setWorkspaceConfigLoaded(true);
        setAuthorizedDirs([]);
      } else {
        setWorkspaceConfigLoaded(false);
        try {
          const cfg = await workspaceOpenworkRead({ workspacePath: next.path });
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
        await workspaceSetActive(id);
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
              nextInfo.projectDir ?? undefined,
              { reason: "workspace-attach-local" },
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
                newInfo.projectDir ?? undefined,
                { reason: "workspace-orchestrator-switch" },
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
                newInfo.projectDir ?? undefined,
                { reason: "workspace-restart" },
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

      options.refreshSkills({ force: true }).catch(() => undefined);
      options.refreshPlugins().catch(() => undefined);
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
        reason: context?.reason ?? null,
        workspaceType: context?.workspaceType ?? null,
        targetRoot: context?.targetRoot ?? null,
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
        let resolvedDirectory = directory?.trim() ?? "";
        let nextClient = createClient(nextBaseUrl, resolvedDirectory || undefined, auth);
        const healthTimeoutMs = resolveConnectHealthTimeoutMs(context?.reason);
        const health = await waitForHealthy(nextClient, { timeoutMs: healthTimeoutMs });
        connectMetrics.healthyMs = Date.now() - connectStart;
        wsDebug("connect:healthy", {
          ms: Date.now() - connectStart,
          version: health.version,
          timeoutMs: healthTimeoutMs,
        });

        if (context?.workspaceType === "remote" && !resolvedDirectory) {
          try {
            const pathInfo = unwrap(await nextClient.path.get());
            const discovered = pathInfo.directory?.trim() ?? "";
            if (discovered) {
              resolvedDirectory = discovered;
              console.log("[workspace] remote directory resolved", resolvedDirectory);
              if (isTauriRuntime() && context.workspaceId) {
                const updated = await workspaceUpdateRemote({
                  workspaceId: context.workspaceId,
                  directory: resolvedDirectory,
                });
                setWorkspaces(updated.workspaces);
                syncActiveWorkspaceId(updated.activeId);
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

        const providersPromise = (async () => {
          const providersAt = Date.now();
          wsDebug("connect:providers:start", { baseUrl: nextBaseUrl });
          try {
            const providerList = unwrap(await nextClient.provider.list());
            wsDebug("connect:providers:done", {
              ms: Date.now() - providersAt,
              source: "provider.list",
              available: providerList.all?.length ?? 0,
              connected: providerList.connected?.length ?? 0,
            });
            return {
              providers: providerList.all,
              defaults: providerList.default,
              connectedIds: providerList.connected,
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
              return {
                providers: mapped,
                defaults: cfg.default,
                connectedIds: [],
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

        const targetRoot = context?.targetRoot ?? (resolvedDirectory || activeWorkspaceRoot().trim());
        wsDebug("connect:loadSessions", { targetRoot, resolvedDirectory });
        const sessionsAt = Date.now();
        await options.loadSessions(targetRoot);
        connectMetrics.loadSessionsMs = Date.now() - sessionsAt;
        wsDebug("connect:loadSessions:done", { ms: Date.now() - sessionsAt });
        const pendingPermissionsAt = Date.now();
        await options.refreshPendingPermissions();
        connectMetrics.pendingPermissionsMs = Date.now() - pendingPermissionsAt;

        const providerState = await providersPromise;
        options.setProviders(providerState.providers);
        options.setProviderDefaults(providerState.defaults);
        options.setProviderConnectedIds(providerState.connectedIds);

        options.setSelectedSessionId(null);
        options.setMessages([]);
        options.setTodos([]);
        options.setPendingPermissions([]);
        options.setSessionStatusById({});

        options.refreshSkills({ force: true }).catch(() => undefined);
        options.refreshPlugins().catch(() => undefined);
        if (navigate && !options.selectedSessionId()) {
          options.setTab("scheduled");
          options.setView("session");
        }

        // If the user successfully connected, treat onboarding as complete so we
        // don't force the onboarding flow on subsequent launches.
        markOnboardingComplete();
        options.onEngineStable?.();
        connectMetrics.totalMs = Date.now() - connectStart;
        options.setOpencodeConnectStatus?.({ ...connectMeta, status: "connected", metrics: connectMetrics });
        wsDebug("connect:done", { ok: true, ms: Date.now() - connectStart });
        return true;
      } catch (e) {
        options.setClient(null);
        options.setConnectedVersion(null);
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

  async function createWorkspaceFlow(preset: WorkspacePreset, folder: string | null) {
    if (!isTauriRuntime()) {
      options.setError(t("app.error.tauri_required", currentLocale()));
      return;
    }

    if (!folder) {
      options.setError(t("app.error.choose_folder", currentLocale()));
      return;
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
        return;
      }

      const name = resolvedFolder.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "Worker";
      const ws = await workspaceCreate({ folderPath: resolvedFolder, name, preset });
      setWorkspaces(ws.workspaces);
      syncActiveWorkspaceId(ws.activeId);
      if (ws.activeId) {
        updateWorkspaceConnectionState(ws.activeId, { status: "connected", message: null });
      }

      const active = ws.workspaces.find((w) => w.id === ws.activeId) ?? null;
        if (active) {
          setProjectDir(active.path);
          setAuthorizedDirs([active.path]);
        }

      setCreateWorkspaceOpen(false);
      options.setTab("scheduled");
      options.setView("dashboard");
      markOnboardingComplete();
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
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
    options.setBusy(true);
    options.setBusyLabel("status.creating_workspace");
    options.setBusyStartedAt(startedAt);
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
      options.setBusy(false);
      options.setBusyLabel(null);
      options.setBusyStartedAt(null);
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

      const name = resolvedFolder.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "Worker";

      setSandboxStep("workspace", { status: "active", detail: name });
      pushSandboxCreateLog(`Worker: ${resolvedFolder}`);

      // Ensure the workspace folder has baseline OpenWork/OpenCode files.
      const created = await workspaceCreate({ folderPath: resolvedFolder, name, preset });
      setWorkspaces(created.workspaces);
      syncActiveWorkspaceId(created.activeId);
      setSandboxStep("workspace", { status: "done", detail: null });

      // Remove the local workspace entry to avoid duplicate Local+Remote rows.
      const localId = created.activeId;
      if (localId) {
        pushSandboxCreateLog("Removing local worker row (will re-add as remote sandbox)...");
        const forgotten = await workspaceForget(localId);
        setWorkspaces(forgotten.workspaces);
        syncActiveWorkspaceId(forgotten.activeId);
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

        markOnboardingComplete();

        const ok = await createRemoteWorkspaceFlow({
          openworkHostUrl: host.openworkUrl,
          openworkToken: host.token,
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
          setSandboxStage("Opening session...");
          setSandboxStep("connect", { status: "active", detail: "Opening session" });
          pushSandboxCreateLog("Opening session in new worker...");
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
      options.setBusy(false);
      options.setBusyLabel(null);
      options.setBusyStartedAt(null);
    }
  }

  async function createRemoteWorkspaceFlow(input: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
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

    options.updateOpenworkServerSettings({
      ...options.openworkServerSettings(),
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
      if (isTauriRuntime()) {
        const ws = await workspaceCreateRemote({
          baseUrl: resolvedBaseUrl.replace(/\/+$/, ""),
          directory: finalDirectory ? finalDirectory : null,
          displayName,
          remoteType,
          openworkHostUrl: remoteType === "openwork" ? resolvedHostUrl : null,
          openworkToken: remoteType === "openwork" ? (token || null) : null,
          openworkWorkspaceId: remoteType === "openwork" ? openworkWorkspace?.id ?? null : null,
          openworkWorkspaceName: remoteType === "openwork" ? openworkWorkspace?.name ?? null : null,
          sandboxBackend: input.sandboxBackend ?? null,
          sandboxRunId: input.sandboxRunId ?? null,
          sandboxContainerName: input.sandboxContainerName ?? null,
        });
        setWorkspaces(ws.workspaces);
        syncActiveWorkspaceId(ws.activeId);
        console.log("[workspace] create remote complete:", ws.activeId ?? "none");
      } else {
        const workspaceId = `remote:${resolvedBaseUrl}:${finalDirectory}`;
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
        syncActiveWorkspaceId(workspaceId);
        console.log("[workspace] create remote complete:", workspaceId);
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
      const activeId = activeWorkspaceId();
      if (activeId) {
        updateWorkspaceConnectionState(activeId, { status: "connected", message: null });
      }
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
      options.openworkServerSettings().token ??
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

    options.updateOpenworkServerSettings({
      ...options.openworkServerSettings(),
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

    const isActive = activeWorkspaceId() === id;
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
          openworkWorkspaceId: openworkWorkspace?.id ?? workspace.openworkWorkspaceId ?? null,
          openworkWorkspaceName: openworkWorkspace?.name ?? workspace.openworkWorkspaceName ?? null,
        });
        setWorkspaces(ws.workspaces);
        syncActiveWorkspaceId(ws.activeId);
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

    console.log("[workspace] forget", { id });

    try {
      const previousActive = activeWorkspaceId();
      const ws = await workspaceForget(id);
      setWorkspaces(ws.workspaces);
      clearWorkspaceConnectionState(id);
      syncActiveWorkspaceId(ws.activeId);

      const active = ws.workspaces.find((w) => w.id === ws.activeId) ?? null;
      if (active) {
        setProjectDir(active.workspaceType === "remote" ? active.directory?.trim() ?? "" : active.path);
      }

      if (ws.activeId && ws.activeId !== previousActive) {
        await activateWorkspace(ws.activeId);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
    }
  }

  async function stopSandbox(workspaceId: string) {
    if (!isTauriRuntime()) {
      options.setError(t("app.error.tauri_required", currentLocale()));
      return;
    }

    const id = workspaceId.trim();
    if (!id) return;

    const workspace = workspaces().find((entry) => entry.id === id) ?? null;
    const containerName = workspace?.sandboxContainerName?.trim() ?? "";
    if (!containerName) {
      options.setError("Sandbox container name missing.");
      return;
    }

    options.setBusy(true);
    options.setBusyLabel("Stopping sandbox...");
    options.setBusyStartedAt(Date.now());
    options.setError(null);

    try {
      const result = await sandboxStop(containerName);
      if (!result.ok) {
        const details = [result.stderr?.trim(), result.stdout?.trim()]
          .filter(Boolean)
          .join("\n")
          .trim();
        throw new Error(details || `Failed to stop sandbox (status ${result.status})`);
      }

      // If the user stopped the active workspace, proactively disconnect the client.
      if (activeWorkspaceId() === id) {
        options.setClient(null);
        options.setConnectedVersion(null);
        options.setSseConnected(false);
      }

      updateWorkspaceConnectionState(id, { status: "error", message: "Sandbox stopped." });
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
      options.setBusyLabel(null);
      options.setBusyStartedAt(null);
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

  async function exportWorkspaceConfig(workspaceId?: string) {
    if (exportingWorkspaceConfig()) return;
    if (!isTauriRuntime()) {
      options.setError(t("app.error.tauri_required", currentLocale()));
      return;
    }

    const targetId = workspaceId?.trim() || activeWorkspaceInfo()?.id || "";
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
      syncActiveWorkspaceId(ws.activeId);
      setCreateWorkspaceOpen(false);
      setCreateRemoteWorkspaceOpen(false);
      options.setTab("scheduled");
      options.setView("dashboard");
      markOnboardingComplete();

      if (ws.activeId) {
        await activateWorkspace(ws.activeId);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
    } finally {
      setImportingWorkspaceConfig(false);
    }
  }

  function canRepairOpencodeMigration() {
    if (!isTauriRuntime()) return false;
    const workspace = activeWorkspaceInfo();
    if (!workspace || workspace.workspaceType !== "local") return false;
    return Boolean(activeWorkspacePath().trim());
  }

  async function repairOpencodeMigration(optionsOverride?: { navigate?: boolean }) {
    if (!isTauriRuntime()) {
      const message = t("app.migration.desktop_required", currentLocale());
      setMigrationRepairResult({ ok: false, message });
      options.setError(message);
      return false;
    }

    if (migrationRepairBusy()) return false;

    const workspace = activeWorkspaceInfo();
    if (!workspace || workspace.workspaceType !== "local") {
      const message = t("app.migration.local_only", currentLocale());
      setMigrationRepairResult({ ok: false, message });
      options.setError(message);
      return false;
    }

    const root = activeWorkspacePath().trim();
    if (!root) {
      const message = t("app.migration.workspace_required", currentLocale());
      setMigrationRepairResult({ ok: false, message });
      options.setError(message);
      return false;
    }

    setMigrationRepairBusy(true);
    setMigrationRepairResult(null);
    options.setError(null);
    options.setBusy(true);
    options.setBusyLabel("status.repairing_migration");
    options.setBusyStartedAt(Date.now());

    try {
      if (engine()?.running) {
        const info = await engineStop();
        setEngine(info);
      }

      const source = options.engineSource();
      const result = await opencodeDbMigrate({
        projectDir: root,
        preferSidecar: source === "sidecar",
        opencodeBinPath: source === "custom" ? options.engineCustomBinPath?.().trim() || null : null,
      });

      if (!result.ok) {
        const output = formatExecOutput(result);
        if (isDbMigrateUnsupported(output)) {
          const message = t("app.migration.unsupported", currentLocale());
          setMigrationRepairResult({ ok: false, message });
          options.setError(message);
          return false;
        }

        const fallback = t("app.migration.failed", currentLocale());
        const message = output ? `${fallback}\n\n${output}` : fallback;
        setMigrationRepairResult({ ok: false, message });
        options.setError(addOpencodeCacheHint(message));
        return false;
      }

      const started = await startHost({
        workspacePath: root,
        navigate: optionsOverride?.navigate ?? false,
      });
      if (!started) {
        const message = t("app.migration.restart_failed", currentLocale());
        setMigrationRepairResult({ ok: false, message });
        return false;
      }

      setMigrationRepairResult({ ok: true, message: t("app.migration.success", currentLocale()) });
      return true;
    } catch (error) {
      const message = addOpencodeCacheHint(error instanceof Error ? error.message : safeStringify(error));
      setMigrationRepairResult({ ok: false, message });
      options.setError(message);
      return false;
    } finally {
      setMigrationRepairBusy(false);
      options.setBusy(false);
      options.setBusyLabel(null);
      options.setBusyStartedAt(null);
    }
  }

  async function onRepairOpencodeMigration() {
    options.setStartupPreference("local");
    options.setOnboardingStep("connecting");
    const ok = await repairOpencodeMigration({ navigate: true });
    if (!ok) {
      options.setOnboardingStep("local");
    }
  }

  async function startHost(optionsOverride?: { workspacePath?: string; navigate?: boolean }) {
    if (!isTauriRuntime()) {
      options.setError(t("app.error.tauri_required", currentLocale()));
      return false;
    }

    if (activeWorkspaceInfo()?.workspaceType === "remote") {
      options.setError(t("app.error.host_requires_local", currentLocale()));
      return false;
    }

    const dir = (optionsOverride?.workspacePath ?? activeWorkspacePath() ?? projectDir()).trim();
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
            ? "OpenCode CLI not found. Install OpenCode for Windows or bundle opencode.exe with OpenWork, then restart. If it is installed, ensure `opencode.exe` is on PATH (try `opencode --version` in PowerShell)."
            : "OpenCode CLI not found. Install with `brew install anomalyco/tap/opencode` or `curl -fsSL https://opencode.ai/install | bash`, then retry.",
        );
        return false;
      }

      if (!result.supportsServe) {
        const serveDetails = [result.serveHelpStdout, result.serveHelpStderr]
          .filter((value) => value && value.trim())
          .join("\n\n");
        const suffix = serveDetails ? `\n\nServe output:\n${serveDetails}` : "";
        options.setError(
          `OpenCode CLI is installed, but \`opencode serve\` is unavailable. Update OpenCode and retry.${suffix}`
        );
        return false;
      }
    } catch (e) {
      setEngineInstallLogs(e instanceof Error ? e.message : safeStringify(e));
    }

    options.setError(null);
    setMigrationRepairResult(null);
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
           info.projectDir ?? undefined,
           { reason: "host-start" },
           auth,
           { navigate: optionsOverride?.navigate ?? true },
         );
         if (!ok) return false;
       }

      markOnboardingComplete();
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

    if (isTauriRuntime()) {
      try {
        const ws = await workspaceUpdateDisplayName({ workspaceId: id, displayName: nextDisplayName });
        setWorkspaces(ws.workspaces);
        if (ws.activeId) {
          updateWorkspaceConnectionState(ws.activeId, { status: "connected", message: null });
        }
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

    if (activeWorkspaceDisplay().workspaceType !== "local") {
      options.setError("Reload is only available for local workers.");
      return false;
    }

    const root = activeWorkspacePath().trim();
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
          name: activeWorkspaceInfo()?.displayName?.trim() || activeWorkspaceInfo()?.name?.trim() || null,
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
            nextInfo.projectDir ?? undefined,
            { reason: "engine-reload-orchestrator" },
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
          nextInfo.projectDir ?? undefined,
          { reason: "engine-reload" },
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

  function markOnboardingComplete() {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("openwork.onboardingComplete", "1");
    } catch {
      // ignore
    }
  }

  async function persistAuthorizedRoots(nextRoots: string[]) {
    if (!isTauriRuntime()) return;
    if (activeWorkspaceInfo()?.workspaceType === "remote") return;
    const root = activeWorkspacePath().trim();
    if (!root) return;

    const existing = workspaceConfig();
    const cfg: WorkspaceOpenworkConfig = {
      version: existing?.version ?? 1,
      workspace: existing?.workspace ?? null,
      authorizedRoots: nextRoots,
      reload: existing?.reload ?? null,
    };

    await workspaceOpenworkWrite({ workspacePath: root, config: cfg });
    setWorkspaceConfig(cfg);
  }

  async function persistReloadSettings(next: { auto?: boolean; resume?: boolean }) {
    if (!isTauriRuntime()) return;
    if (activeWorkspaceInfo()?.workspaceType === "remote") return;
    const root = activeWorkspacePath().trim();
    if (!root) return;

    const existing = workspaceConfig();
    const cfg: WorkspaceOpenworkConfig = {
      version: existing?.version ?? 1,
      workspace: existing?.workspace ?? null,
      authorizedRoots: Array.isArray(existing?.authorizedRoots) ? existing!.authorizedRoots : authorizedDirs(),
      reload: {
        auto: Boolean(next.auto),
        resume: Boolean(next.resume),
      },
    };

    await workspaceOpenworkWrite({ workspacePath: root, config: cfg });
    setWorkspaceConfig(cfg);
  }

  async function addAuthorizedDir() {
    if (activeWorkspaceInfo()?.workspaceType === "remote") return;
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
    if (activeWorkspaceInfo()?.workspaceType === "remote") return;

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
    if (activeWorkspaceInfo()?.workspaceType === "remote") return;
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

  async function bootstrapOnboarding() {
    const startupPref = readStartupPreference();
    const onboardingComplete = (() => {
      try {
        return window.localStorage.getItem("openwork.onboardingComplete") === "1";
      } catch {
        return false;
      }
    })();

    if (isTauriRuntime()) {
      try {
        const ws = await workspaceBootstrap();
        setWorkspaces(ws.workspaces);
        syncActiveWorkspaceId(ws.activeId);
      } catch {
        // ignore
      }
    }

    await refreshEngine();
    await refreshEngineDoctor();

    if (isTauriRuntime()) {
      const active = workspaces().find((w) => w.id === activeWorkspaceId()) ?? null;
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

    const info = engine();
    if (info?.baseUrl) {
      options.setBaseUrl(info.baseUrl);
    }

    const activeWorkspace = activeWorkspaceInfo();
    if (activeWorkspace?.workspaceType === "remote") {
      options.setStartupPreference("server");
      options.setOnboardingStep("connecting");
      const ok = await activateWorkspace(activeWorkspace.id);
      if (!ok) {
        options.setOnboardingStep("server");
      }
      return;
    }

    if (startupPref) {
      options.setStartupPreference(startupPref);
    }

    if (startupPref === "server") {
      options.setOnboardingStep("server");
      return;
    }

    if (activeWorkspacePath().trim()) {
      options.setStartupPreference("local");

      if (info?.running && info.baseUrl) {
        options.setOnboardingStep("connecting");
        const ok = await connectToServer(
          info.baseUrl,
          info.projectDir ?? undefined,
          { reason: "bootstrap-local" },
          engineAuth() ?? undefined,
        );
        if (!ok) {
          options.setStartupPreference(null);
          options.setOnboardingStep("welcome");
          return;
        }
        markOnboardingComplete();
        return;
      }

      options.setOnboardingStep("connecting");
      const ok = await startHost({ workspacePath: activeWorkspacePath().trim() });
      if (!ok) {
        options.setOnboardingStep("local");
        return;
      }
      markOnboardingComplete();
      return;
    }

    if (startupPref === "local") {
      options.setOnboardingStep("local");
      return;
    }

    options.setOnboardingStep("welcome");
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
    const ok = await startHost({ workspacePath: activeWorkspacePath().trim() });
    if (!ok) {
      options.setOnboardingStep("local");
    }
  }

  async function onAttachHost() {
    options.setStartupPreference("local");
    options.setOnboardingStep("connecting");
    const ok = await connectToServer(
      engine()?.baseUrl ?? "",
      engine()?.projectDir ?? undefined,
      { reason: "attach-local" },
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
    const settings = options.openworkServerSettings();
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
    activeWorkspaceId,
    authorizedDirs,
    newAuthorizedDir,
    workspaceConfig,
    workspaceConfigLoaded,
    createWorkspaceOpen,
    createRemoteWorkspaceOpen,
    connectingWorkspaceId,
    workspaceConnectionStateById,
    exportingWorkspaceConfig,
    importingWorkspaceConfig,
    migrationRepairBusy,
    migrationRepairResult,
    activeWorkspaceDisplay,
    activeWorkspacePath,
    activeWorkspaceRoot,
    setCreateWorkspaceOpen,
    setCreateRemoteWorkspaceOpen,
    setProjectDir,
    setAuthorizedDirs,
    setNewAuthorizedDir,
    setWorkspaceConfig,
    setWorkspaceConfigLoaded,
    setWorkspaces,
    syncActiveWorkspaceId: syncActiveWorkspaceId,
    refreshEngine,
    refreshEngineDoctor,
    activateWorkspace,
    testWorkspaceConnection,
    connectToServer,
    createWorkspaceFlow,
    createSandboxFlow,
    createRemoteWorkspaceFlow,
    updateRemoteWorkspaceFlow,
    updateWorkspaceDisplayName,
    forgetWorkspace,
    stopSandbox,
    pickWorkspaceFolder,
    exportWorkspaceConfig,
    importWorkspaceConfig,
    canRepairOpencodeMigration,
    repairOpencodeMigration,
    startHost,
    stopHost,
    reloadWorkspaceEngine,
    bootstrapOnboarding,
    onSelectStartup,
    onBackToWelcome,
    onStartHost,
    onRepairOpencodeMigration,
    onAttachHost,
    onConnectClient,
    onRememberStartupToggle,
    onInstallEngine,
    addAuthorizedDir,
    addAuthorizedDirFromPicker,
    removeAuthorizedDir,
    removeAuthorizedDirAtIndex,
    persistReloadSettings,
    setEngineInstallLogs,
    refreshSandboxDoctor,
    sandboxCreateProgress,
    clearSandboxCreateProgress,
    workspaceDebugEvents,
    clearWorkspaceDebugEvents,
  };
}
