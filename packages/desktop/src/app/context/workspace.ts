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
  workspaceOpenworkRead,
  workspaceOpenworkWrite,
  workspaceRemove,
  workspaceSetActive,
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
  loadWorkspaceTemplates: (options?: { workspaceRoot?: string; quiet?: boolean }) => Promise<void>;
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

  const activeWorkspaceInfo = createMemo(() => workspaces().find((w) => w.id === activeWorkspaceId()) ?? null);
  const activeWorkspaceDisplay = createMemo<WorkspaceDisplay>(() => {
    const ws = activeWorkspaceInfo();
    if (!ws) {
      return {
        id: "",
        name: "Workspace",
        path: "",
        preset: "starter",
      };
    }
    return { ...ws, name: ws.name || ws.path || "Workspace" };
  });
  const activeWorkspacePath = createMemo(() => activeWorkspaceInfo()?.path ?? "");
  const activeWorkspaceRoot = createMemo(() => activeWorkspacePath().trim());
  const filteredWorkspaces = createMemo(() => {
    const query = workspaceSearch().trim().toLowerCase();
    if (!query) return workspaces();
    return workspaces().filter((ws) => {
      const haystack = `${ws.name ?? ""} ${ws.path ?? ""}`.toLowerCase();
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

  async function activateWorkspace(workspaceId: string) {
    const id = workspaceId.trim();
    if (!id) return;

    const next = workspaces().find((w) => w.id === id) ?? null;
    if (!next) return;

    const wasHostMode = options.mode() === "host" && options.client();
    const oldWorkspacePath = projectDir();
    const workspaceChanged = oldWorkspacePath !== next.path;

    syncActiveWorkspaceId(id);
    setProjectDir(next.path);

    if (isTauriRuntime()) {
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

      try {
        await workspaceSetActive(id);
      } catch {
        // ignore
      }
    } else {
      if (!authorizedDirs().includes(next.path)) {
        const merged = authorizedDirs().length ? authorizedDirs().slice() : [];
        if (!merged.includes(next.path)) merged.push(next.path);
        setAuthorizedDirs(merged);
      }
    }

    await options.loadWorkspaceTemplates({ workspaceRoot: next.path }).catch(() => undefined);

    if (workspaceChanged && options.client() && !wasHostMode) {
      options.setSelectedSessionId(null);
      options.setMessages([]);
      options.setTodos([]);
      options.setPendingPermissions([]);
      options.setSessionStatusById({});
      await options.loadSessions(next.path).catch(() => undefined);
    }

    // In Host mode, restart the engine when workspace changes
    if (wasHostMode && workspaceChanged) {
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
  }

  async function connectToServer(nextBaseUrl: string, directory?: string) {
    console.log("[connectToServer] starting", {
      baseUrl: nextBaseUrl,
      directory,
      workspace: activeWorkspacePath(),
    });
    options.setError(null);
    options.setBusy(true);
    options.setBusyLabel("status.connecting");
    options.setBusyStartedAt(Date.now());
    options.setSseConnected(false);

    try {
      const nextClient = createClient(nextBaseUrl, directory);
      console.log("[connectToServer] client created");
      const health = await waitForHealthy(nextClient, { timeoutMs: 12_000 });
      console.log("[connectToServer] healthy", { version: health.version });

      options.setClient(nextClient);
      options.setConnectedVersion(health.version);
      options.setBaseUrl(nextBaseUrl);

      await options.loadSessions(activeWorkspaceRoot().trim());
      await options.refreshPendingPermissions();

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

      options.refreshSkills({ force: true }).catch(() => undefined);
      if (!options.selectedSessionId()) {
        options.setView("dashboard");
        options.setTab("home");
      }

      // If the user successfully connected, treat onboarding as complete so we
      // don't force the onboarding flow on subsequent launches.
      markOnboardingComplete();
      console.log("[connectToServer] connected", { baseUrl: nextBaseUrl });
      return true;
    } catch (e) {
      console.log("[connectToServer] failed", e);
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
        await options.loadWorkspaceTemplates({ workspaceRoot: active.path, quiet: true }).catch(() => undefined);
      }

      setWorkspacePickerOpen(false);
      setCreateWorkspaceOpen(false);
      options.setView("dashboard");
      options.setTab("home");
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

  async function removeWorkspace(workspaceId: string) {
    if (!isTauriRuntime()) {
      options.setError(t("app.error.tauri_required", currentLocale()));
      return;
    }

    const id = workspaceId.trim();
    if (!id) return;

    options.setBusy(true);
    options.setBusyLabel("status.updating_workspace");
    options.setBusyStartedAt(Date.now());
    options.setError(null);

    try {
      const updated = await workspaceRemove(id);
      setWorkspaces(updated.workspaces);

      if (updated.activeId !== activeWorkspaceId()) {
        await activateWorkspace(updated.activeId);
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
            ? "OpenCode CLI not found. Install OpenCode for Windows, then restart OpenWork. If it is installed, ensure `opencode.exe` is on PATH (try `opencode --version` in PowerShell)."
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

      if (options.engineSource() === "sidecar" && options.isWindowsPlatform()) {
        options.setEngineSource("path");
        options.setError(t("app.error.sidecar_unsupported_windows", currentLocale()));
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
        setWorkspaces((await workspaceBootstrap()).workspaces);
      } catch {
        // ignore
      }
    }

    await refreshEngine();
    await refreshEngineDoctor();

    if (isTauriRuntime()) {
      try {
        const ws = await workspaceBootstrap();
        setWorkspaces(ws.workspaces);
        syncActiveWorkspaceId(ws.activeId);
        const active = ws.workspaces.find((w) => w.id === ws.activeId) ?? null;
        if (active) {
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

          await options.loadWorkspaceTemplates({ workspaceRoot: active.path, quiet: true }).catch(() => undefined);
        }
      } catch {
        // ignore
      }
    }

    const info = engine();
    if (info?.baseUrl) {
      options.setBaseUrl(info.baseUrl);
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
    console.log("[attachHost] start", {
      baseUrl: engine()?.baseUrl,
      projectDir: engine()?.projectDir,
    });
    options.setMode("host");
    options.setOnboardingStep("connecting");
    const ok = await connectToServer(engine()?.baseUrl ?? "", engine()?.projectDir ?? undefined);
    if (!ok) {
      options.setMode(null);
      options.setOnboardingStep("mode");
    }
  }

  async function onConnectClient() {
    console.log("[connectClient] start", {
      baseUrl: options.baseUrl(),
      directory: options.clientDirectory(),
    });
    options.setMode("client");
    options.setOnboardingStep("connecting");
    const ok = await connectToServer(
      options.baseUrl().trim(),
      options.clientDirectory().trim() ? options.clientDirectory().trim() : undefined,
    );
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
    activeWorkspaceDisplay,
    activeWorkspacePath,
    activeWorkspaceRoot,
    filteredWorkspaces,
    setWorkspaceSearch,
    setWorkspacePickerOpen,
    setCreateWorkspaceOpen,
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
    removeWorkspace,
    pickWorkspaceFolder,
    startHost,
    stopHost,
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
