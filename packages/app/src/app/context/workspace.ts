import { createMemo, createSignal } from "solid-js";

import type {
  Client,
  Mode,
  OnboardingStep,
  WorkspaceDisplay,
  WorkspaceOpenworkConfig,
  WorkspacePreset,
} from "../types";
import { addOpencodeCacheHint, isTauriRuntime, safeStringify, writeModePreference } from "../utils";
import { unwrap } from "../lib/opencode";
import {
  createOpenworkServerClient,
  normalizeOpenworkServerUrl,
  OpenworkServerError,
  type OpenworkServerSettings,
  type OpenworkWorkspaceInfo,
} from "../lib/openwork-server";
import { downloadDir, homeDir } from "@tauri-apps/api/path";
import {
  engineDoctor,
  engineInfo,
  engineInstall,
  engineStart,
  engineStop,
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
  workspaceUpdateRemote,
  type EngineDoctorResult,
  type EngineInfo,
  type WorkspaceInfo,
} from "../lib/tauri";
import { waitForHealthy, createClient } from "../lib/opencode";
import type { ProviderListItem } from "../types";
import { t, currentLocale } from "../../i18n";
import { mapConfigProvidersToList } from "../utils/providers";

export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;

export function createWorkspaceStore(options: {
  mode: () => Mode | null;
  setMode: (mode: Mode | null) => void;
  onboardingStep: () => OnboardingStep;
  setOnboardingStep: (step: OnboardingStep) => void;
  rememberModeChoice: () => boolean;
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
  loadCommands: (options?: { workspaceRoot?: string; quiet?: boolean }) => Promise<void>;
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
  engineSource: () => "path" | "sidecar";
  setEngineSource: (value: "path" | "sidecar") => void;
  setView: (value: any) => void;
  setTab: (value: any) => void;
  isWindowsPlatform: () => boolean;
  openworkServerSettings: () => OpenworkServerSettings;
  updateOpenworkServerSettings: (next: OpenworkServerSettings) => void;
  onEngineStable?: () => void;
}) {

  const [engine, setEngine] = createSignal<EngineInfo | null>(null);
  const [engineDoctorResult, setEngineDoctorResult] = createSignal<EngineDoctorResult | null>(null);
  const [engineDoctorCheckedAt, setEngineDoctorCheckedAt] = createSignal<number | null>(null);
  const [engineInstallLogs, setEngineInstallLogs] = createSignal<string | null>(null);

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
  const [workspaceSearch, setWorkspaceSearch] = createSignal("");
  const [workspacePickerOpen, setWorkspacePickerOpen] = createSignal(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = createSignal(false);
  const [createRemoteWorkspaceOpen, setCreateRemoteWorkspaceOpen] = createSignal(false);
  const [connectingWorkspaceId, setConnectingWorkspaceId] = createSignal<string | null>(null);
  const [exportingWorkspaceConfig, setExportingWorkspaceConfig] = createSignal(false);
  const [importingWorkspaceConfig, setImportingWorkspaceConfig] = createSignal(false);

  const activeWorkspaceInfo = createMemo(() => workspaces().find((w) => w.id === activeWorkspaceId()) ?? null);
  const activeWorkspaceDisplay = createMemo<WorkspaceDisplay>(() => {
    const ws = activeWorkspaceInfo();
    if (!ws) {
      return {
        id: "",
        name: "Workspace",
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
      "Workspace";
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
  const filteredWorkspaces = createMemo(() => {
    const query = workspaceSearch().trim().toLowerCase();
    if (!query) return workspaces();
    return workspaces().filter((ws) => {
      const haystack = `${ws.name ?? ""} ${ws.path ?? ""} ${ws.baseUrl ?? ""} ${
        ws.displayName ?? ""
      } ${ws.directory ?? ""} ${ws.openworkHostUrl ?? ""} ${ws.openworkWorkspaceName ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });
  });

  const resolveOpenworkHost = async (input: { hostUrl: string; token?: string | null }) => {
    const normalized = normalizeOpenworkServerUrl(input.hostUrl) ?? "";
    if (!normalized) {
      return { kind: "fallback" as const };
    }

    const client = createOpenworkServerClient({ baseUrl: normalized, token: input.token ?? undefined });

    try {
      const health = await client.health();
      if (!health?.ok) {
        return { kind: "fallback" as const };
      }
    } catch (error) {
      if (error instanceof OpenworkServerError && (error.status === 401 || error.status === 403)) {
        throw error;
      }
      return { kind: "fallback" as const };
    }

    if (!input.token?.trim()) {
      throw new Error("Access token required for OpenWork host.");
    }

    const response = await client.listWorkspaces();
    const items = Array.isArray(response.items) ? response.items : [];
    const workspace = items[0] as OpenworkWorkspaceInfo | undefined;
    if (!workspace) {
      throw new Error("OpenWork host did not return a workspace.");
    }
    let opencodeBaseUrl = workspace.opencode?.baseUrl?.trim() ?? workspace.baseUrl?.trim() ?? "";
    if (!opencodeBaseUrl) {
      throw new Error("OpenWork host did not provide an OpenCode URL.");
    }

    try {
      const hostUrl = new URL(normalized);
      const opencodeUrl = new URL(opencodeBaseUrl);
      if (hostUrl.hostname && opencodeUrl.hostname !== hostUrl.hostname) {
        opencodeUrl.hostname = hostUrl.hostname;
        opencodeUrl.protocol = hostUrl.protocol;
        opencodeBaseUrl = opencodeUrl.toString();
      }
    } catch {
      // ignore
    }

    return {
      kind: "openwork" as const,
      hostUrl: normalized,
      workspace,
      opencodeBaseUrl,
      directory: workspace.opencode?.directory?.trim() ?? workspace.directory?.trim() ?? "",
    };
  };

  async function refreshEngine() {
    if (!isTauriRuntime()) return;

    try {
      const info = await engineInfo();
      setEngine(info);

      if (info.projectDir) {
        setProjectDir(info.projectDir);
      }
      if (info.baseUrl) {
        options.setBaseUrl(info.baseUrl);
      }
    } catch {
      // ignore
    }
  }

  async function refreshEngineDoctor() {
    if (!isTauriRuntime()) return;

    try {
      const result = await engineDoctor({ preferSidecar: options.engineSource() === "sidecar" });
      setEngineDoctorResult(result);
      setEngineDoctorCheckedAt(Date.now());
    } catch (e) {
      setEngineDoctorResult(null);
      setEngineDoctorCheckedAt(Date.now());
      setEngineInstallLogs(e instanceof Error ? e.message : safeStringify(e));
    }
  }

  async function activateWorkspace(workspaceId: string) {
    const id = workspaceId.trim();
    if (!id) return false;

    const next = workspaces().find((w) => w.id === id) ?? null;
    if (!next) return false;
    const isRemote = next.workspaceType === "remote";
    console.log("[workspace] activate", { id: next.id, type: next.workspaceType });

    const remoteType = isRemote ? normalizeRemoteType(next.remoteType) : "opencode";
    const baseUrl = isRemote ? next.baseUrl?.trim() ?? "" : "";

    setConnectingWorkspaceId(id);

    try {
      if (isRemote) {
        options.setMode("client");

        if (remoteType === "openwork") {
          const hostUrl = next.openworkHostUrl?.trim() ?? "";
          if (!hostUrl) {
            options.setError("OpenWork host URL is required.");
            return false;
          }

          const currentSettings = options.openworkServerSettings();
          if (currentSettings.urlOverride?.trim() !== hostUrl) {
            options.updateOpenworkServerSettings({
              ...currentSettings,
              urlOverride: hostUrl,
            });
          }

          let resolvedBaseUrl = baseUrl;
          let resolvedDirectory = next.directory?.trim() ?? "";
          let workspaceInfo: OpenworkWorkspaceInfo | null = null;

          try {
            const resolved = await resolveOpenworkHost({
              hostUrl,
              token: options.openworkServerSettings().token ?? undefined,
            });
            if (resolved.kind === "openwork") {
              resolvedBaseUrl = resolved.opencodeBaseUrl;
              resolvedDirectory = resolved.directory;
              workspaceInfo = resolved.workspace;
            } else {
              resolvedBaseUrl = baseUrl || hostUrl;
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

          const ok = await connectToServer(resolvedBaseUrl, resolvedDirectory || undefined, {
            workspaceId: next.id,
            workspaceType: next.workspaceType,
            targetRoot: resolvedDirectory ?? "",
          });

          if (!ok) {
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
                openworkWorkspaceId: workspaceInfo?.id ?? next.openworkWorkspaceId ?? null,
                openworkWorkspaceName: workspaceInfo?.name ?? next.openworkWorkspaceName ?? null,
              });
              setWorkspaces(ws.workspaces);
              syncActiveWorkspaceId(ws.activeId);
            } catch {
              // ignore
            }
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

          return true;
        }

        if (!baseUrl) {
          options.setError(t("app.error.remote_base_url_required", currentLocale()));
          return false;
        }

        const ok = await connectToServer(baseUrl, next.directory?.trim() || undefined, {
          workspaceId: next.id,
          workspaceType: next.workspaceType,
          targetRoot: next.directory?.trim() ?? "",
        });

        if (!ok) {
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

        return true;
      }

    const wasHostMode = options.mode() === "host" && options.client();
    const nextRoot = isRemote ? next.directory?.trim() ?? "" : next.path;
    const oldWorkspacePath = projectDir();
    const workspaceChanged = oldWorkspacePath !== nextRoot;

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

    if (!isRemote) {
      await options.loadCommands({ workspaceRoot: next.path }).catch(() => undefined);
    }

    if (!isRemote && workspaceChanged && options.client() && !wasHostMode) {
      options.setSelectedSessionId(null);
      options.setMessages([]);
      options.setTodos([]);
      options.setPendingPermissions([]);
      options.setSessionStatusById({});
      await options.loadSessions(next.path).catch(() => undefined);
    }

    // In Host mode, restart the engine when workspace changes
    if (!isRemote && wasHostMode && workspaceChanged) {
      options.setError(null);
      options.setBusy(true);
      options.setBusyLabel("status.restarting_engine");
      options.setBusyStartedAt(Date.now());

      try {
        // Stop the current engine
        const info = await engineStop();
        setEngine(info);

        // Start engine with new workspace directory
        const newInfo = await engineStart(next.path, { preferSidecar: options.engineSource() === "sidecar" });
        setEngine(newInfo);

        // Reconnect to server
        if (newInfo.baseUrl) {
          const ok = await connectToServer(newInfo.baseUrl, newInfo.projectDir ?? undefined);
          if (!ok) {
            options.setError("Failed to reconnect after workspace switch");
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
      return true;
    } finally {
      setConnectingWorkspaceId(null);
    }
  }

  async function connectToServer(
    nextBaseUrl: string,
    directory?: string,
    context?: {
      workspaceId?: string;
      workspaceType?: WorkspaceInfo["workspaceType"];
      targetRoot?: string;
    }
  ) {
    console.log("[workspace] connect", {
      baseUrl: nextBaseUrl,
      directory: directory ?? null,
      workspaceType: context?.workspaceType ?? null,
    });
    options.setError(null);
    options.setBusy(true);
    options.setBusyLabel("status.connecting");
    options.setBusyStartedAt(Date.now());
    options.setSseConnected(false);

    try {
      let resolvedDirectory = directory?.trim() ?? "";
      let nextClient = createClient(nextBaseUrl, resolvedDirectory || undefined);
      const health = await waitForHealthy(nextClient, { timeoutMs: 12_000 });

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
            nextClient = createClient(nextBaseUrl, resolvedDirectory);
          }
        } catch (error) {
          console.log("[workspace] remote directory lookup failed", error);
        }
      }

      options.setClient(nextClient);
      options.setConnectedVersion(health.version);
      options.setBaseUrl(nextBaseUrl);
      options.setClientDirectory(resolvedDirectory);

      const targetRoot = context?.targetRoot ?? (resolvedDirectory || activeWorkspaceRoot().trim());
      await options.loadSessions(targetRoot);
      await options.refreshPendingPermissions();

      try {
        const providerList = unwrap(await nextClient.provider.list());
        options.setProviders(providerList.all);
        options.setProviderDefaults(providerList.default);
        options.setProviderConnectedIds(providerList.connected);
      } catch {
        try {
          const cfg = unwrap(await nextClient.config.providers());
          options.setProviders(mapConfigProvidersToList(cfg.providers));
          options.setProviderDefaults(cfg.default);
          options.setProviderConnectedIds([]);
        } catch {
          options.setProviders([]);
          options.setProviderDefaults({});
          options.setProviderConnectedIds([]);
        }
      }

      options.setSelectedSessionId(null);
      options.setMessages([]);
      options.setTodos([]);
      options.setPendingPermissions([]);
      options.setSessionStatusById({});

      // Load workspace commands for all workspace types (local and remote)
      if (targetRoot) {
        await options
          .loadCommands({ workspaceRoot: targetRoot, quiet: true })
          .catch(() => undefined);
      }

      options.refreshSkills({ force: true }).catch(() => undefined);
      options.refreshPlugins().catch(() => undefined);
      if (!options.selectedSessionId()) {
        options.setTab("home");
        options.setView("dashboard");
      }

      // If the user successfully connected, treat onboarding as complete so we
      // don't force the onboarding flow on subsequent launches.
      markOnboardingComplete();
      options.onEngineStable?.();
      return true;
    } catch (e) {
      options.setClient(null);
      options.setConnectedVersion(null);
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
      return false;
    } finally {
      options.setBusy(false);
      options.setBusyLabel(null);
      options.setBusyStartedAt(null);
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

    try {
      const resolvedFolder = await resolveWorkspacePath(folder);
      if (!resolvedFolder) {
        options.setError(t("app.error.choose_folder", currentLocale()));
        return;
      }

      const name = resolvedFolder.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "Workspace";
      const ws = await workspaceCreate({ folderPath: resolvedFolder, name, preset });
      setWorkspaces(ws.workspaces);
      syncActiveWorkspaceId(ws.activeId);

      const active = ws.workspaces.find((w) => w.id === ws.activeId) ?? null;
        if (active) {
          setProjectDir(active.path);
          setAuthorizedDirs([active.path]);
          await options.loadCommands({ workspaceRoot: active.path, quiet: true }).catch(() => undefined);
        }

      setWorkspacePickerOpen(false);
      setCreateWorkspaceOpen(false);
      options.setTab("home");
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

  async function createRemoteWorkspaceFlow(input: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    opencodeBaseUrl?: string | null;
    directory?: string | null;
    displayName?: string | null;
  }) {
    const hostUrl = normalizeOpenworkServerUrl(input.openworkHostUrl ?? "") ?? "";
    const token = input.openworkToken?.trim() ?? "";
    const directBaseUrl = input.opencodeBaseUrl?.trim() ?? "";
    const directory = input.directory?.trim() ?? "";
    const displayName = input.displayName?.trim() || null;

    if (!hostUrl && !directBaseUrl) {
      options.setError("Add an OpenWork host URL or a direct OpenCode URL to continue.");
      return false;
    }

    options.setError(null);
    console.log("[workspace] create remote", {
      hostUrl: hostUrl || null,
      baseUrl: directBaseUrl || null,
      directory: directory || null,
      displayName,
    });

    options.setMode("client");

    let remoteType: "openwork" | "opencode" = "opencode";
    let resolvedBaseUrl = directBaseUrl;
    let resolvedDirectory = directory;
    let openworkWorkspace: OpenworkWorkspaceInfo | null = null;
    let resolvedHostUrl = hostUrl;

    if (hostUrl) {
      options.updateOpenworkServerSettings({
        ...options.openworkServerSettings(),
        urlOverride: hostUrl,
        token: token || undefined,
      });

      try {
        const resolved = await resolveOpenworkHost({ hostUrl, token });
        if (resolved.kind === "openwork") {
          remoteType = "openwork";
          resolvedBaseUrl = resolved.opencodeBaseUrl;
          resolvedDirectory = resolved.directory || directory;
          openworkWorkspace = resolved.workspace;
          resolvedHostUrl = resolved.hostUrl;
        } else if (!resolvedBaseUrl) {
          resolvedBaseUrl = hostUrl;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : safeStringify(error);
        options.setError(addOpencodeCacheHint(message));
        return false;
      }
    }

    if (!resolvedBaseUrl) {
      options.setError(t("app.error.remote_base_url_required", currentLocale()));
      return false;
    }

    const ok = await connectToServer(resolvedBaseUrl, resolvedDirectory || undefined, {
      workspaceType: "remote",
      targetRoot: resolvedDirectory ?? "",
    });

    if (!ok) {
      return false;
    }

    const finalDirectory = options.clientDirectory().trim() || resolvedDirectory || "";

    options.setBusy(true);
    options.setBusyLabel("status.creating_workspace");
    options.setBusyStartedAt(Date.now());

    try {
      if (isTauriRuntime()) {
        const ws = await workspaceCreateRemote({
          baseUrl: resolvedBaseUrl.replace(/\/+$/, ""),
          directory: finalDirectory ? finalDirectory : null,
          displayName,
          remoteType,
          openworkHostUrl: remoteType === "openwork" ? resolvedHostUrl : null,
          openworkWorkspaceId: remoteType === "openwork" ? openworkWorkspace?.id ?? null : null,
          openworkWorkspaceName: remoteType === "openwork" ? openworkWorkspace?.name ?? null : null,
        });
        setWorkspaces(ws.workspaces);
        syncActiveWorkspaceId(ws.activeId);
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
          openworkWorkspaceId: remoteType === "openwork" ? openworkWorkspace?.id ?? null : null,
          openworkWorkspaceName: remoteType === "openwork" ? openworkWorkspace?.name ?? null : null,
        };

        setWorkspaces((prev) => {
          const withoutMatch = prev.filter((workspace) => workspace.id !== workspaceId);
          return [...withoutMatch, nextWorkspace];
        });
        syncActiveWorkspaceId(workspaceId);
      }

      setProjectDir(finalDirectory);
      setWorkspaceConfig(null);
      setWorkspaceConfigLoaded(true);
      setAuthorizedDirs([]);

      setWorkspacePickerOpen(false);
      setCreateRemoteWorkspaceOpen(false);
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

  async function exportWorkspaceConfig() {
    if (exportingWorkspaceConfig()) return;
    if (!isTauriRuntime()) {
      options.setError(t("app.error.tauri_required", currentLocale()));
      return;
    }

    const active = activeWorkspaceInfo();
    if (!active) {
      options.setError("Select a workspace to export");
      return;
    }
    if (active.workspaceType === "remote") {
      options.setError("Export is only supported for local workspaces");
      return;
    }

    setExportingWorkspaceConfig(true);
    options.setError(null);

    try {
      const nameBase = (active.displayName || active.name || "workspace")
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
      const dateStamp = new Date().toISOString().slice(0, 10);
      const fileName = `openwork-${nameBase || "workspace"}-${dateStamp}.openwork-workspace`;
      const downloads = await downloadDir().catch(() => null);
      const defaultPath = downloads ? `${downloads}/${fileName}` : fileName;

      const outputPath = await saveFile({
        title: "Export workspace config",
        defaultPath,
        filters: [{ name: "OpenWork Workspace", extensions: ["openwork-workspace", "zip"] }],
      });

      if (!outputPath) {
        return;
      }

      await workspaceExportConfig({
        workspaceId: active.id,
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
        title: "Import workspace config",
        filters: [{ name: "OpenWork Workspace", extensions: ["openwork-workspace", "zip"] }],
      });
      const filePath =
        typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;
      if (!filePath) return;

      const target = await pickDirectory({
        title: "Choose a workspace folder",
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
      setWorkspacePickerOpen(false);
      setCreateWorkspaceOpen(false);
      setCreateRemoteWorkspaceOpen(false);
      options.setTab("home");
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

  async function startHost(optionsOverride?: { workspacePath?: string }) {
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
      const result = await engineDoctor({ preferSidecar: options.engineSource() === "sidecar" });
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
    options.setBusy(true);
    options.setBusyLabel("status.starting_engine");
    options.setBusyStartedAt(Date.now());

    try {
      setProjectDir(dir);
      if (!authorizedDirs().length) {
        setAuthorizedDirs([dir]);
      }

      const info = await engineStart(dir, { preferSidecar: options.engineSource() === "sidecar" });
      setEngine(info);

      if (info.baseUrl) {
        const ok = await connectToServer(info.baseUrl, info.projectDir ?? undefined);
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

      options.setClient(null);
      options.setConnectedVersion(null);
      options.setSelectedSessionId(null);
      options.setMessages([]);
      options.setTodos([]);
      options.setPendingPermissions([]);
      options.setSessionStatusById({});
      options.setSseConnected(false);

      options.setMode(null);
      options.setOnboardingStep("mode");

      const showOnboarding = (() => {
        if (typeof window === "undefined") return true;
        try {
          return window.localStorage.getItem("openwork.onboardingComplete") !== "1";
        } catch {
          return true;
        }
      })();

      options.setView(showOnboarding ? "onboarding" : "dashboard");
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

    if (options.mode() !== "host") {
      options.setError("Reload is only available in Host mode.");
      return false;
    }

    const root = activeWorkspacePath().trim();
    if (!root) {
      options.setError("Pick a workspace folder first.");
      return false;
    }

    options.setError(null);
    options.setBusy(true);
    options.setBusyLabel("status.reloading_engine");
    options.setBusyStartedAt(Date.now());

    try {
      const info = await engineStop();
      setEngine(info);

      const nextInfo = await engineStart(root, { preferSidecar: options.engineSource() === "sidecar" });
      setEngine(nextInfo);

      if (nextInfo.baseUrl) {
        const ok = await connectToServer(nextInfo.baseUrl, nextInfo.projectDir ?? undefined);
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
    const modePref = (() => {
      try {
        return window.localStorage.getItem("openwork.modePref") as Mode | null;
      } catch {
        return null;
      }
    })();
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

          await options
            .loadCommands({ workspaceRoot: active.path, quiet: true })
            .catch(() => undefined);
        }
      }
    }

    const info = engine();
    if (info?.baseUrl) {
      options.setBaseUrl(info.baseUrl);
    }

    const activeWorkspace = activeWorkspaceInfo();
    if (activeWorkspace?.workspaceType === "remote") {
      options.setMode("client");
      options.setOnboardingStep("connecting");
      const ok = await activateWorkspace(activeWorkspace.id);
      if (!ok) {
        options.setOnboardingStep("client");
      }
      return;
    }

    if (!modePref && onboardingComplete && activeWorkspacePath().trim()) {
      options.setMode("host");

      if (info?.running && info.baseUrl) {
        options.setOnboardingStep("connecting");
        const ok = await connectToServer(info.baseUrl, info.projectDir ?? undefined);
        if (!ok) {
          options.setMode(null);
          options.setOnboardingStep("mode");
        }
        return;
      }

      options.setOnboardingStep("connecting");
      const ok = await startHost({ workspacePath: activeWorkspacePath().trim() });
      if (!ok) {
        options.setOnboardingStep("host");
      }
      return;
    }

    if (!modePref) return;

    if (modePref === "host") {
      options.setMode("host");

      if (info?.running && info.baseUrl) {
        options.setOnboardingStep("connecting");
        const ok = await connectToServer(info.baseUrl, info.projectDir ?? undefined);
        if (!ok) {
          options.setMode(null);
          options.setOnboardingStep("mode");
        }
        return;
      }

      if (isTauriRuntime() && activeWorkspacePath().trim()) {
        if (!authorizedDirs().length && activeWorkspacePath().trim()) {
          setAuthorizedDirs([activeWorkspacePath().trim()]);
        }

        options.setOnboardingStep("connecting");
        const ok = await startHost({ workspacePath: activeWorkspacePath().trim() });
        if (!ok) {
          options.setOnboardingStep("host");
        }
        return;
      }

      options.setOnboardingStep("host");
      return;
    }

    options.setMode("client");
    if (!options.baseUrl().trim()) {
      options.setOnboardingStep("client");
      return;
    }

    options.setOnboardingStep("connecting");
    const ok = await connectToServer(
      options.baseUrl().trim(),
      options.clientDirectory().trim() ? options.clientDirectory().trim() : undefined,
    );

    if (!ok) {
      options.setOnboardingStep("client");
    }
  }

  function onModeSelect(nextMode: Mode) {
    if (nextMode === "host" && options.rememberModeChoice()) {
      writeModePreference("host");
    }
    if (nextMode === "client" && options.rememberModeChoice()) {
      writeModePreference("client");
    }
    options.setMode(nextMode);
    options.setOnboardingStep(nextMode === "host" ? "host" : "client");
  }

  function onBackToMode() {
    options.setMode(null);
    options.setOnboardingStep("mode");
  }

  async function onStartHost() {
    options.setMode("host");
    options.setOnboardingStep("connecting");
    const ok = await startHost({ workspacePath: activeWorkspacePath().trim() });
    if (!ok) {
      options.setOnboardingStep("host");
    }
  }

  async function onAttachHost() {
    options.setMode("host");
    options.setOnboardingStep("connecting");
    const ok = await connectToServer(engine()?.baseUrl ?? "", engine()?.projectDir ?? undefined);
    if (!ok) {
      options.setMode(null);
      options.setOnboardingStep("mode");
    }
  }

  async function onConnectClient() {
    options.setMode("client");
    options.setOnboardingStep("connecting");
    const settings = options.openworkServerSettings();
    const ok = await createRemoteWorkspaceFlow({
      openworkHostUrl: settings.urlOverride ?? null,
      openworkToken: settings.token ?? null,
      opencodeBaseUrl: options.baseUrl().trim(),
      directory: options.clientDirectory().trim() ? options.clientDirectory().trim() : null,
      displayName: null,
    });
    if (!ok) {
      options.setOnboardingStep("client");
    }
  }

  function onRememberModeToggle() {
    if (typeof window === "undefined") return;
    const next = !options.rememberModeChoice();
    try {
      if (next) {
        const current = options.mode();
        if (current === "host" || current === "client") {
          writeModePreference(current);
        }
      } else {
        window.localStorage.removeItem("openwork.modePref");
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
    projectDir,
    workspaces,
    activeWorkspaceId,
    authorizedDirs,
    newAuthorizedDir,
    workspaceConfig,
    workspaceConfigLoaded,
    workspaceSearch,
    workspacePickerOpen,
    createWorkspaceOpen,
    createRemoteWorkspaceOpen,
    connectingWorkspaceId,
    exportingWorkspaceConfig,
    importingWorkspaceConfig,
    activeWorkspaceDisplay,
    activeWorkspacePath,
    activeWorkspaceRoot,
    filteredWorkspaces,
    setWorkspaceSearch,
    setWorkspacePickerOpen,
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
    connectToServer,
    createWorkspaceFlow,
    createRemoteWorkspaceFlow,
    forgetWorkspace,
    pickWorkspaceFolder,
    exportWorkspaceConfig,
    importWorkspaceConfig,
    startHost,
    stopHost,
    reloadWorkspaceEngine,
    bootstrapOnboarding,
    onModeSelect,
    onBackToMode,
    onStartHost,
    onAttachHost,
    onConnectClient,
    onRememberModeToggle,
    onInstallEngine,
    addAuthorizedDir,
    addAuthorizedDirFromPicker,
    removeAuthorizedDir,
    removeAuthorizedDirAtIndex,
    setEngineInstallLogs,
  };
}
