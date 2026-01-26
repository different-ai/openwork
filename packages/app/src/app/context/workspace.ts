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
import { homeDir } from "@tauri-apps/api/path";
import {
  engineDoctor,
  engineInfo,
  engineInstall,
  engineStart,
  engineStop,
  pickDirectory,
  workspaceBootstrap,
  workspaceCreate,
  workspaceCreateRemote,
  workspaceForget,
  workspaceOpenworkRead,
  workspaceOpenworkWrite,
  workspaceSetActive,
  workspaceUpdateRemote,
  type EngineDoctorResult,
  type EngineInfo,
  type WorkspaceInfo,
} from "../lib/tauri";
import { waitForHealthy, createClient } from "../lib/opencode";
import type { Provider } from "@opencode-ai/sdk/v2/client";
import { t, currentLocale } from "../../i18n";

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
  setProviders: (value: Provider[]) => void;
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
        baseUrl: null,
        directory: null,
        displayName: null,
      };
    }
    const displayName = ws.displayName?.trim() || ws.name || ws.baseUrl || ws.path || "Workspace";
    return { ...ws, name: displayName };
  });
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
      } ${ws.directory ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });
  });

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

  const normalizeBaseUrl = (value: string) => value.trim().replace(/\/+$/, "");

  async function activateWorkspace(
    workspaceId: string,
    optionsOverride?: {
      silent?: boolean;
      preferExistingConnection?: boolean;
      skipHostRestart?: boolean;
    }
  ) {
    const id = workspaceId.trim();
    if (!id) return false;

    const next = workspaces().find((w) => w.id === id) ?? null;
    if (!next) return false;
    const isRemote = next.workspaceType === "remote";
    console.log("[workspace] activate", { id: next.id, type: next.workspaceType });

    const baseUrl = isRemote ? next.baseUrl?.trim() ?? "" : "";
    if (isRemote && !baseUrl) {
      options.setError(t("app.error.remote_base_url_required", currentLocale()));
      return false;
    }
    const hasClient = Boolean(options.client());
    const currentBase = normalizeBaseUrl(options.baseUrl());
    const nextBase = normalizeBaseUrl(baseUrl);
    const canReuseConnection =
      isRemote &&
      optionsOverride?.preferExistingConnection &&
      hasClient &&
      options.mode() === "client" &&
      currentBase &&
      currentBase === nextBase;

    if (!optionsOverride?.silent) {
      setConnectingWorkspaceId(id);
    }

    try {
      if (isRemote) {
        options.setMode("client");
        const directory = next.directory?.trim() ?? "";

        if (canReuseConnection) {
          syncActiveWorkspaceId(id);
          setProjectDir(directory);
          options.setClientDirectory(directory);
          options.setBaseUrl(baseUrl);
          options.setSseConnected(false);
          options.setClient(createClient(baseUrl, directory || undefined));
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

        const ok = await connectToServer(baseUrl, directory || undefined, {
          workspaceId: next.id,
          workspaceType: next.workspaceType,
          targetRoot: directory,
        });

        if (!ok) {
          return false;
        }

        syncActiveWorkspaceId(id);
        setProjectDir(directory);
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
    }

    // In Host mode, restart the engine when workspace changes
    if (!isRemote && wasHostMode && workspaceChanged && !optionsOverride?.skipHostRestart) {
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
    options.setMode("client");
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

      try {
        const providerList = unwrap(await nextClient.provider.list());
        options.setProviders(providerList.all as unknown as Provider[]);
        options.setProviderDefaults(providerList.default);
        options.setProviderConnectedIds(providerList.connected);
      } catch {
        try {
          const cfg = unwrap(await nextClient.config.providers());
          options.setProviders(cfg.providers as unknown as Provider[]);
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
      if (!options.selectedSessionId()) {
        options.setTab("home");
        options.setView("dashboard");
      }

      // If the user successfully connected, treat onboarding as complete so we
      // don't force the onboarding flow on subsequent launches.
      markOnboardingComplete();
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
    baseUrl: string;
    directory?: string | null;
    displayName?: string | null;
  }) {
    const baseUrl = input.baseUrl.trim();
    if (!baseUrl) {
      options.setError(t("app.error.remote_base_url_required", currentLocale()));
      return false;
    }

    options.setError(null);
    console.log("[workspace] create remote", {
      baseUrl,
      directory: input.directory ?? null,
      displayName: input.displayName ?? null,
    });

    options.setMode("client");
    const ok = await connectToServer(baseUrl, input.directory?.trim() || undefined, {
      workspaceType: "remote",
      targetRoot: input.directory?.trim() ?? "",
    });

    if (!ok) {
      return false;
    }

    const resolvedDirectory = options.clientDirectory().trim() || input.directory?.trim() || "";

    options.setBusy(true);
    options.setBusyLabel("status.creating_workspace");
    options.setBusyStartedAt(Date.now());

    const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
    const displayName = input.displayName?.trim() || null;
    const workspaceId = `remote:${normalizedBaseUrl}:${resolvedDirectory}`;

    try {
      if (isTauriRuntime()) {
        const ws = await workspaceCreateRemote({
          baseUrl: normalizedBaseUrl,
          directory: resolvedDirectory ? resolvedDirectory : null,
          displayName,
        });
        setWorkspaces(ws.workspaces);
        syncActiveWorkspaceId(ws.activeId);
      } else {
        const nextWorkspace: WorkspaceInfo = {
          id: workspaceId,
          name: displayName ?? normalizedBaseUrl,
          path: "",
          preset: "remote",
          workspaceType: "remote",
          baseUrl: normalizedBaseUrl,
          directory: resolvedDirectory || null,
          displayName,
        };

        setWorkspaces((prev) => {
          const withoutMatch = prev.filter((workspace) => workspace.id !== workspaceId);
          return [...withoutMatch, nextWorkspace];
        });
        syncActiveWorkspaceId(workspaceId);
      }

      setProjectDir(resolvedDirectory);
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
        await discoverLocalProjects(info.baseUrl, { quiet: true });
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

      options.setMode("client");
      options.setOnboardingStep("client");
      options.setView("dashboard");
      options.setTab("sessions");
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

  async function discoverRemoteProjects(baseUrlInput: string) {
    const baseUrl = baseUrlInput.trim();
    if (!baseUrl) {
      options.setError(t("app.error.remote_base_url_required", currentLocale()));
      return false;
    }

    options.setError(null);
    options.setBusy(true);
    options.setBusyLabel("status.connecting");
    options.setBusyStartedAt(Date.now());

    try {
      const client = createClient(baseUrl);
      const projects = unwrap(await client.project.list());
      if (!projects.length) {
        options.setError("No projects found on that server.");
        return false;
      }

      const previousActiveId = activeWorkspaceId();
      for (const project of projects) {
        const directory = project.worktree?.trim();
        if (!directory) continue;
        if (isTauriRuntime()) {
          const ws = await workspaceCreateRemote({
            baseUrl,
            directory,
            displayName: project.name ?? null,
          });
          setWorkspaces(ws.workspaces);
          syncActiveWorkspaceId(ws.activeId);
        } else {
          const workspaceId = `remote:${baseUrl}:${directory}`;
          const nextWorkspace: WorkspaceInfo = {
            id: workspaceId,
            name: project.name ?? baseUrl,
            path: "",
            preset: "remote",
            workspaceType: "remote",
            baseUrl,
            directory,
            displayName: project.name ?? null,
          };
          setWorkspaces((prev) => {
            const withoutMatch = prev.filter((workspace) => workspace.id !== workspaceId);
            return [...withoutMatch, nextWorkspace];
          });
        }
      }

      if (isTauriRuntime() && previousActiveId) {
        try {
          const ws = await workspaceSetActive(previousActiveId);
          setWorkspaces(ws.workspaces);
          syncActiveWorkspaceId(ws.activeId);
        } catch {
          // ignore
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

  async function discoverLocalProjects(
    baseUrlInput: string,
    optionsOverride?: { quiet?: boolean }
  ) {
    const baseUrl = baseUrlInput.trim();
    if (!baseUrl) return false;

    const quiet = optionsOverride?.quiet ?? false;
    options.setError(null);
    if (!quiet) {
      options.setBusy(true);
      options.setBusyLabel("status.connecting");
      options.setBusyStartedAt(Date.now());
    }

    try {
      const client = createClient(baseUrl);
      const projects = unwrap(await client.project.list());
      if (!projects.length) return false;

      const existingPaths = new Set(
        workspaces()
          .filter((workspace) => workspace.workspaceType !== "remote")
          .map((workspace) => workspace.path?.trim() ?? "")
          .filter(Boolean)
      );
      const previousActiveId = activeWorkspaceId();
      for (const project of projects) {
        const directory = project.worktree?.trim();
        if (!directory) continue;
        if (existingPaths.has(directory)) continue;
        if (isTauriRuntime()) {
          const name = directory.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "Workspace";
          const ws = await workspaceCreate({ folderPath: directory, name, preset: "starter" });
          setWorkspaces(ws.workspaces);
          syncActiveWorkspaceId(ws.activeId);
          existingPaths.add(directory);
        }
      }

      if (isTauriRuntime() && previousActiveId) {
        try {
          const ws = await workspaceSetActive(previousActiveId);
          setWorkspaces(ws.workspaces);
          syncActiveWorkspaceId(ws.activeId);
        } catch {
          // ignore
        }
      }

      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
      return false;
    } finally {
      if (!quiet) {
        options.setBusy(false);
        options.setBusyLabel(null);
        options.setBusyStartedAt(null);
      }
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
    await refreshEngine();
    await refreshEngineDoctor();

    if (isTauriRuntime()) {
      try {
        const ws = await workspaceBootstrap();
        setWorkspaces(ws.workspaces);
        syncActiveWorkspaceId(ws.activeId);
        const active = ws.workspaces.find((w) => w.id === ws.activeId) ?? null;
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

            await options.loadCommands({ workspaceRoot: active.path, quiet: true }).catch(() => undefined);
          }
        }
      } catch {
        // ignore
      }
    }

    options.setMode("client");
    options.setOnboardingStep("connecting");
    markOnboardingComplete();
    options.setView("dashboard");
    options.setTab("sessions");

    const activeWorkspace = activeWorkspaceInfo();
    const baseUrl = (activeWorkspace?.baseUrl?.trim() || options.baseUrl().trim()).trim();
    const directory = activeWorkspace
      ? activeWorkspace.workspaceType === "remote"
        ? activeWorkspace.directory?.trim() ?? ""
        : activeWorkspace.path?.trim() ?? ""
      : options.clientDirectory().trim();

    if (!baseUrl) return;

    await connectToServer(baseUrl, directory || undefined, {
      workspaceId: activeWorkspace?.id,
      workspaceType: activeWorkspace?.workspaceType ?? "remote",
      targetRoot: directory,
    });
  }

  function onModeSelect(nextMode: Mode) {
    if (options.rememberModeChoice()) {
      writeModePreference("client");
    }
    options.setMode("client");
    options.setOnboardingStep("client");
  }

  function onBackToMode() {
    options.setMode("client");
    options.setOnboardingStep("client");
  }

  async function onStartHost() {
    options.setError("Host mode is no longer supported. Use a server URL instead.");
  }

  async function onAttachHost() {
    options.setError("Host attach is no longer supported. Use a server URL instead.");
  }

  async function onConnectClient() {
    options.setMode("client");
    const ok = await createRemoteWorkspaceFlow({
      baseUrl: options.baseUrl().trim(),
      directory: options.clientDirectory().trim() ? options.clientDirectory().trim() : null,
      displayName: null,
    });
    if (!ok) return;
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
    discoverRemoteProjects,
    discoverLocalProjects,
    forgetWorkspace,
    pickWorkspaceFolder,
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
