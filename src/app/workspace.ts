import { createMemo, createSignal } from "solid-js";

import type {
  Client,
  Mode,
  OnboardingStep,
  WorkspaceDisplay,
  WorkspaceOpenworkConfig,
  WorkspacePreset,
} from "./types";
import { isTauriRuntime, safeStringify, writeModePreference } from "./utils";
import { unwrap } from "../lib/opencode";
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
  workspaceSetActive,
  type EngineDoctorResult,
  type EngineInfo,
  type WorkspaceInfo,
} from "../lib/tauri";
import { waitForHealthy, createClient } from "../lib/opencode";
import type { Provider } from "@opencode-ai/sdk/v2/client";

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
  refreshSkills: () => Promise<void>;
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
      const result = await engineDoctor();
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
  }

  async function connectToServer(nextBaseUrl: string, directory?: string) {
    options.setError(null);
    options.setBusy(true);
    options.setBusyLabel("Connecting");
    options.setBusyStartedAt(Date.now());
    options.setSseConnected(false);

    try {
      const nextClient = createClient(nextBaseUrl, directory);
      const health = await waitForHealthy(nextClient, { timeoutMs: 12_000 });

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

      try {
        if (isTauriRuntime() && activeWorkspaceRoot().trim()) {
          const wsRoot = activeWorkspaceRoot().trim();
          const storedKey = `openwork.welcomeSessionCreated:${wsRoot}`;

          let already = false;
          try {
            already = window.localStorage.getItem(storedKey) === "1";
          } catch {
            // ignore
          }

          if (!already) {
            const session = unwrap(
              await nextClient.session.create({ directory: wsRoot, title: "Welcome to OpenWork" }),
            );
            await nextClient.session.promptAsync({
              directory: wsRoot,
              sessionID: session.id,
              model: options.defaultModel(),
              variant: options.modelVariant() ?? undefined,
              parts: [
                {
                  type: "text",
                  text:
                    "Give a short, welcoming overview of this workspace and how to use OpenWork. If a workspace guide skill is available, use it. Avoid CLI language or raw file paths. End with two friendly next actions to try inside OpenWork.",
                },
              ],
            });

            try {
              window.localStorage.setItem(storedKey, "1");
            } catch {
              // ignore
            }

            await options.loadSessions(activeWorkspaceRoot().trim()).catch(() => undefined);

            if (session?.id) {
              try {
                await options.selectSession(session.id);
                options.setView("session");
                options.setTab("sessions");
              } catch {
                // ignore selection failure
              }
            }
          }
        }
      } catch {
        // ignore onboarding session failures
      }

      options.refreshSkills().catch(() => undefined);
      if (!options.selectedSessionId()) {
        options.setView("dashboard");
        options.setTab("home");
      }
      return true;
    } catch (e) {
      options.setClient(null);
      options.setConnectedVersion(null);
      options.setError(e instanceof Error ? e.message : safeStringify(e));
      return false;
    } finally {
      options.setBusy(false);
      options.setBusyLabel(null);
      options.setBusyStartedAt(null);
    }
  }

  async function createWorkspaceFlow(preset: WorkspacePreset, folder: string | null) {
    if (!isTauriRuntime()) {
      options.setError("Workspace creation requires the Tauri app runtime.");
      return;
    }

    if (!folder) {
      options.setError("Choose a folder to create the workspace.");
      return;
    }

    setCreateWorkspaceOpen(false);

    try {
      options.setBusy(true);
      options.setBusyLabel("Creating workspace");
      options.setBusyStartedAt(Date.now());
      options.setError(null);

      const name = folder.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "Workspace";
      const ws = await workspaceCreate({ folderPath: folder, name, preset });
      setWorkspaces(ws.workspaces);
      syncActiveWorkspaceId(ws.activeId);

      const active = ws.workspaces.find((w) => w.id === ws.activeId) ?? null;
      if (active) {
        setProjectDir(active.path);
        setAuthorizedDirs([active.path]);
        await options.loadWorkspaceTemplates({ workspaceRoot: active.path, quiet: true }).catch(() => undefined);
      }

      setWorkspacePickerOpen(false);
      options.setView("dashboard");
      options.setTab("home");
    } catch (e) {
      options.setError(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      options.setBusy(false);
      options.setBusyLabel(null);
      options.setBusyStartedAt(null);
    }
  }

  async function pickWorkspaceFolder() {
    if (!isTauriRuntime()) {
      options.setError("Workspace creation requires the Tauri app runtime.");
      return null;
    }

    try {
      const selection = await pickDirectory({ title: "Choose workspace folder" });
      const folder =
        typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;

      return folder ?? null;
    } catch (e) {
      options.setError(e instanceof Error ? e.message : safeStringify(e));
      return null;
    }
  }

  async function startHost(optionsOverride?: { workspacePath?: string }) {
    if (!isTauriRuntime()) {
      options.setError("Host mode requires the Tauri app runtime. Use `pnpm dev`." );
      return false;
    }

    const dir = (optionsOverride?.workspacePath ?? activeWorkspacePath() ?? projectDir()).trim();
    if (!dir) {
      options.setError("Pick a workspace folder to start OpenCode in.");
      return false;
    }

    try {
      const result = await engineDoctor();
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
        options.setError("OpenCode CLI is installed, but `opencode serve` is unavailable. Update OpenCode and retry.");
        return false;
      }
    } catch (e) {
      setEngineInstallLogs(e instanceof Error ? e.message : safeStringify(e));
    }

    options.setError(null);
    options.setBusy(true);
    options.setBusyLabel("Starting engine");
    options.setBusyStartedAt(Date.now());

    try {
      setProjectDir(dir);
      if (!authorizedDirs().length) {
        setAuthorizedDirs([dir]);
      }

      if (options.engineSource() === "sidecar" && options.isWindowsPlatform()) {
        options.setEngineSource("path");
        options.setError("Sidecar OpenCode is not supported on Windows yet. Using PATH instead.");
      }

      const info = await engineStart(dir, { preferSidecar: options.engineSource() === "sidecar" });
      setEngine(info);

      if (info.baseUrl) {
        const ok = await connectToServer(info.baseUrl, info.projectDir ?? undefined);
        if (!ok) return false;
      }

      return true;
    } catch (e) {
      options.setError(e instanceof Error ? e.message : safeStringify(e));
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
    options.setBusyLabel("Disconnecting");
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
      options.setView("onboarding");
    } catch (e) {
      options.setError(e instanceof Error ? e.message : safeStringify(e));
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
    options.setBusyLabel("Installing OpenCode");
    options.setBusyStartedAt(Date.now());

    try {
      const result = await engineInstall();
      const combined = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
      setEngineInstallLogs(combined || null);

      if (!result.ok) {
        options.setError(result.stderr.trim() || "OpenCode install failed. See logs above.");
      }

      await refreshEngineDoctor();
    } catch (e) {
      options.setError(e instanceof Error ? e.message : safeStringify(e));
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
      options.setError(e instanceof Error ? e.message : safeStringify(e));
    }
  }

  async function addAuthorizedDirFromPicker(optionsOverride?: { persistToWorkspace?: boolean }) {
    if (!isTauriRuntime()) return;

    try {
      const selection = await pickDirectory({ title: "Authorize folder" });
      const folder =
        typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;
      if (!folder) return;

      const roots = normalizeRoots([...authorizedDirs(), folder]);
      setAuthorizedDirs(roots);

      if (optionsOverride?.persistToWorkspace) {
        await persistAuthorizedRoots(roots);
      }
    } catch (e) {
      options.setError(e instanceof Error ? e.message : safeStringify(e));
    }
  }

  async function removeAuthorizedDir(dir: string) {
    const roots = normalizeRoots(authorizedDirs().filter((root) => root !== dir));
    setAuthorizedDirs(roots);

    try {
      await persistAuthorizedRoots(roots);
    } catch (e) {
      options.setError(e instanceof Error ? e.message : safeStringify(e));
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
