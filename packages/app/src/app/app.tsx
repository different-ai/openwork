import {
  Match,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";

import { useLocation, useNavigate } from "@solidjs/router";

import type {
  Agent,
  Provider,
  Part,
  TextPartInput,
  FilePartInput,
  AgentPartInput,
  SubtaskPartInput,
} from "@opencode-ai/sdk/v2/client";

import { getVersion } from "@tauri-apps/api/app";
import { parse } from "jsonc-parser";

import ModelPickerModal from "./components/model-picker-modal";
import ResetModal from "./components/reset-modal";
import CommandModal from "./components/command-modal";
import CommandRunModal from "./components/command-run-modal";
import CommandPaletteModal, { type PaletteGroup } from "./components/command-palette-modal";
import WorkspacePicker from "./components/workspace-picker";
import WorkspaceSwitchOverlay from "./components/workspace-switch-overlay";
import CreateRemoteWorkspaceModal from "./components/create-remote-workspace-modal";
import CreateWorkspaceModal from "./components/create-workspace-modal";
import McpAuthModal from "./components/mcp-auth-modal";
import ReloadWorkspaceToast from "./components/reload-workspace-toast";
import OnboardingView from "./pages/onboarding";
import DashboardView from "./pages/dashboard";
import SessionView from "./pages/session";
import { createClient, unwrap, waitForHealthy } from "./lib/opencode";
import {
  DEFAULT_MODEL,
  DEMO_MODE_PREF_KEY,
  DEMO_SEQUENCE_PREF_KEY,
  KEYBIND_PREF_KEY,
  MCP_QUICK_CONNECT,
  MODEL_PREF_KEY,
  SESSION_MODEL_PREF_KEY,
  SUGGESTED_PLUGINS,
  THINKING_PREF_KEY,
  VARIANT_PREF_KEY,
} from "./constants";
import { parseMcpServersFromContent } from "./mcp";
import type {
  Client,
  DashboardTab,
  DemoSequence,
  MessageWithParts,
  Mode,
  ModelOption,
  ModelRef,
  OnboardingStep,
  PluginScope,
  ReloadReason,
  ResetOpenworkMode,
  SkillCard,
  TodoItem,
  View,
  CommandRegistryItem,
  CommandTriggerContext,
  WorkspaceDisplay,
  McpServerEntry,
  McpStatusMap,
  ComposerAttachment,
  ComposerDraft,
  ComposerPart,
  WorkspaceCommand,
  UpdateHandle,
} from "./types";
import {
  clearModePreference,
  formatBytes,
  formatModelLabel,
  formatModelRef,
  formatRelativeTime,
  groupMessageParts,
  isTauriRuntime,
  modelEquals,
} from "./utils";
import { isEditableTarget, matchKeybind, normalizeKeybind } from "./utils/keybinds";
import { currentLocale, setLocale, t, type Language } from "../i18n";
import {
  isWindowsPlatform,
  lastUserModelFromMessages,
  parseModelRef,
  readModePreference,
  safeStringify,
  summarizeStep,
  writeModePreference,
  addOpencodeCacheHint,
} from "./utils";
import {
  applyThemeMode,
  getInitialThemeMode,
  persistThemeMode,
  subscribeToSystemTheme,
  type ThemeMode,
} from "./theme";
import { createDemoState } from "./demo-state";
import { createCommandState } from "./command-state";
import { createCommandRegistry } from "./command-registry";
import { createSystemState } from "./system-state";
import { relaunch } from "@tauri-apps/plugin-process";
import { createSessionStore } from "./context/session";
import { createExtensionsStore } from "./context/extensions";
import { useGlobalSync } from "./context/global-sync";
import { createWorkspaceStore } from "./context/workspace";
import {
  updaterEnvironment,
  readOpencodeConfig,
  writeOpencodeConfig,
} from "./lib/tauri";

export default function App() {
  type ProviderAuthMethod = { type: "oauth" | "api"; label: string };

  const location = useLocation();
  const navigate = useNavigate();

  const [creatingSession, setCreatingSession] = createSignal(false);
  const [sessionViewLockUntil, setSessionViewLockUntil] = createSignal(0);
  const currentView = createMemo<View>(() => {
    const path = location.pathname.toLowerCase();
    if (path.startsWith("/onboarding")) return "onboarding";
    if (path.startsWith("/session")) return "session";
    return "dashboard";
  });

  const [tab, setTabState] = createSignal<DashboardTab>("home");

  const goToDashboard = (nextTab: DashboardTab, options?: { replace?: boolean }) => {
    setTabState(nextTab);
    navigate(`/dashboard/${nextTab}`, options);
  };

  const setTab = (nextTab: DashboardTab) => {
    if (currentView() === "dashboard") {
      goToDashboard(nextTab);
      return;
    }
    setTabState(nextTab);
  };

  const setView = (next: View, sessionId?: string) => {
    if (next === "dashboard" && creatingSession()) {
      return;
    }
    if (next === "dashboard" && Date.now() < sessionViewLockUntil()) {
      return;
    }
    if (next === "onboarding") {
      navigate("/onboarding");
      return;
    }
    if (next === "session") {
      if (sessionId) {
        goToSession(sessionId);
        return;
      }
      const fallback = activeSessionId();
      if (fallback) {
        goToSession(fallback);
        return;
      }
      navigate("/session");
      return;
    }
    goToDashboard(tab());
  };

  const goToSession = (sessionId: string, options?: { replace?: boolean }) => {
    const trimmed = sessionId.trim();
    if (!trimmed) {
      navigate("/session", options);
      return;
    }
    navigate(`/session/${trimmed}`, options);
  };

  const [mode, setMode] = createSignal<Mode | null>(null);
  const [onboardingStep, setOnboardingStep] =
    createSignal<OnboardingStep>("mode");
  const [rememberModeChoice, setRememberModeChoice] = createSignal(false);
  const [themeMode, setThemeMode] = createSignal<ThemeMode>(getInitialThemeMode());

  const [engineSource, setEngineSource] = createSignal<"path" | "sidecar">(
    isTauriRuntime() ? "sidecar" : "path"
  );

  const [baseUrl, setBaseUrl] = createSignal("http://127.0.0.1:4096");
  const [clientDirectory, setClientDirectory] = createSignal("");

  const [client, setClient] = createSignal<Client | null>(null);
  const [connectedVersion, setConnectedVersion] = createSignal<string | null>(
    null
  );
  const [sseConnected, setSseConnected] = createSignal(false);

  const [busy, setBusy] = createSignal(false);
  const [busyLabel, setBusyLabel] = createSignal<string | null>(null);
  const [busyStartedAt, setBusyStartedAt] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [booting, setBooting] = createSignal(true);
  const [developerMode, setDeveloperMode] = createSignal(false);
  let markReloadRequiredRef: (reason: ReloadReason) => void = () => {};

  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(
    null
  );
  const [sessionModelOverrideById, setSessionModelOverrideById] = createSignal<
    Record<string, ModelRef>
  >({});
  const [sessionModelById, setSessionModelById] = createSignal<
    Record<string, ModelRef>
  >({});
  const [sessionModelOverridesReady, setSessionModelOverridesReady] = createSignal(false);
  const [workspaceDefaultModelReady, setWorkspaceDefaultModelReady] = createSignal(false);
  const [legacyDefaultModel, setLegacyDefaultModel] = createSignal<ModelRef>(DEFAULT_MODEL);
  const [defaultModelExplicit, setDefaultModelExplicit] = createSignal(false);
  const [sessionAgentById, setSessionAgentById] = createSignal<Record<string, string>>({});
  const [providerAuthModalOpen, setProviderAuthModalOpen] = createSignal(false);
  const [providerAuthBusy, setProviderAuthBusy] = createSignal(false);
  const [providerAuthError, setProviderAuthError] = createSignal<string | null>(null);
  const [providerAuthMethods, setProviderAuthMethods] = createSignal<Record<string, ProviderAuthMethod[]>>({});

  const sessionStore = createSessionStore({
    client,
    selectedSessionId,
    setSelectedSessionId,
    sessionModelState: () => ({
      overrides: sessionModelOverrideById(),
      resolved: sessionModelById(),
    }),
    setSessionModelState: (updater) => {
      const next = updater({
        overrides: sessionModelOverrideById(),
        resolved: sessionModelById(),
      });
      setSessionModelOverrideById(next.overrides);
      setSessionModelById(next.resolved);
      return next;
    },
    lastUserModelFromMessages,
    developerMode,
    setError,
    setSseConnected,
    markReloadRequired: (reason) => markReloadRequiredRef(reason),
  });

  const {
    sessions,
    sessionStatusById,
    selectedSession,
    selectedSessionStatus,
    messages,
    todos,
    pendingPermissions,
    permissionReplyBusy,
    events,
    activePermission,
    loadSessions,
    refreshPendingPermissions,
    selectSession,
    renameSession,
    respondPermission,
    setSessions,
    setSessionStatusById,
    setMessages,
    setTodos,
    setPendingPermissions,
  } = sessionStore;

  const demoState = createDemoState({
    sessions,
    sessionStatusById,
    messages,
    todos,
    selectedSessionId,
  });

  const {
    demoMode,
    setDemoMode,
    demoSequence,
    setDemoSequence,
    isDemoMode,
    demoAuthorizedDirs,
    demoActiveWorkspaceDisplay,
    activeSessionId,
    activeSessions,
    activeSessionStatusById,
    activeMessages,
    activeTodos,
    activeArtifacts,
    activeWorkingFiles,
    selectDemoSession,
    renameDemoSession,
  } = demoState;

  const [prompt, setPrompt] = createSignal("");
  const [lastPromptSent, setLastPromptSent] = createSignal("");
  const [commandPaletteOpen, setCommandPaletteOpen] = createSignal(false);
  const [commandPaletteMode, setCommandPaletteMode] = createSignal<"command" | "file">("command");
  const [commandPaletteQuery, setCommandPaletteQuery] = createSignal("");
  const [keybindOverrides, setKeybindOverrides] = createSignal<Record<string, string>>({});
  const [recentCommandIds, setRecentCommandIds] = createSignal<string[]>([]);
  const [paletteAgents, setPaletteAgents] = createSignal<Agent[]>([]);
  const [paletteAgentsReady, setPaletteAgentsReady] = createSignal(false);
  const [paletteAgentsBusy, setPaletteAgentsBusy] = createSignal(false);

  type PartInput = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput;

  const buildPromptParts = (draft: ComposerDraft): PartInput[] => {
    const parts: PartInput[] = [];
    const pushText = (text: string) => {
      if (!text) return;
      parts.push({ type: "text", text } as TextPartInput);
    };

    for (const part of draft.parts) {
      if (part.type === "text") {
        pushText(part.text);
        continue;
      }
      if (part.type === "agent") {
        parts.push({ type: "agent", name: part.name } as AgentPartInput);
        continue;
      }
      parts.push({ type: "file", path: part.path } as unknown as FilePartInput);
    }

    for (const attachment of draft.attachments) {
      parts.push({
        type: "file",
        url: attachment.dataUrl,
        filename: attachment.name,
        mime: attachment.mimeType,
      } as FilePartInput);
    }

    const hasTextPart = parts.some((part) => part.type === "text");
    if (!hasTextPart && draft.attachments.length) {
      pushText(draft.text.trim());
    }
    if (!parts.length && draft.text.trim()) {
      pushText(draft.text.trim());
    }

    return parts;
  };

  async function sendPrompt(draft?: ComposerDraft) {
    const fallbackText = prompt().trim();
    const resolvedDraft: ComposerDraft = draft ?? {
      mode: "prompt",
      parts: fallbackText ? [{ type: "text", text: fallbackText } as ComposerPart] : [],
      attachments: [] as ComposerAttachment[],
      text: fallbackText,
    };
    const content = resolvedDraft.text.trim();
    if (!content && !resolvedDraft.attachments.length) return;

    if (isDemoMode()) {
      setLastPromptSent(content);
      setPrompt("");
      return;
    }

    const c = client();
    const sessionID = selectedSessionId();
    if (!c || !sessionID) return;

    setBusy(true);
    setBusyLabel("status.running");
    setBusyStartedAt(Date.now());
    setError(null);

    try {
      setLastPromptSent(content);
      setPrompt("");

      const model = selectedSessionModel();
      const agent = selectedSessionAgent();
      const parts = buildPromptParts(resolvedDraft);

      if (resolvedDraft.mode === "shell") {
        const sessionApi = c.session as any;
        if (sessionApi.shellAsync) {
          await sessionApi.shellAsync({ sessionID, command: content });
        } else if (sessionApi.shell) {
          await sessionApi.shell({ sessionID, command: content });
        } else {
          await c.session.promptAsync({
            sessionID,
            model,
            agent: agent ?? undefined,
            variant: modelVariant() ?? undefined,
            parts: [{ type: "text", text: `!${content}` }],
          });
        }
      } else {
        await c.session.promptAsync({
          sessionID,
          model,
          agent: agent ?? undefined,
          variant: modelVariant() ?? undefined,
          parts,
        });

        setSessionModelById((current) => ({
          ...current,
          [sessionID]: model,
        }));

        setSessionModelOverrideById((current) => {
          if (!current[sessionID]) return current;
          const copy = { ...current };
          delete copy[sessionID];
          return copy;
        });

        await loadSessions(workspaceStore.activeWorkspaceRoot().trim()).catch(
          () => undefined
        );
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      setError(addOpencodeCacheHint(message));
    } finally {
      setBusy(false);
      setBusyLabel(null);
      setBusyStartedAt(null);
    }
  }

  async function renameSessionTitle(sessionID: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("Session name is required");
    }

    if (isDemoMode()) {
      renameDemoSession(sessionID, trimmed);
      return;
    }

    await renameSession(sessionID, trimmed);
  }

  async function openConnectFlow() {
    setView("onboarding");
    setMode("client");
    setOnboardingStep("client");
  }

  async function listAgents(): Promise<Agent[]> {
    const c = client();
    if (!c) return [];
    const list = unwrap(await c.app.agents());
    return list.filter((agent) => !agent.hidden && agent.mode !== "subagent");
  }

  const loadPaletteAgents = async (force = false) => {
    if (paletteAgentsBusy()) return paletteAgents();
    if (paletteAgentsReady() && !force) return paletteAgents();
    setPaletteAgentsBusy(true);
    try {
      const agents = await listAgents();
      const sorted = agents.slice().sort((a, b) => a.name.localeCompare(b.name));
      setPaletteAgents(sorted);
      setPaletteAgentsReady(true);
      return sorted;
    } catch {
      setPaletteAgents([]);
      return [];
    } finally {
      setPaletteAgentsBusy(false);
    }
  };

  function setSessionAgent(sessionID: string, agent: string | null) {
    const trimmed = agent?.trim() ?? "";
    setSessionAgentById((current) => {
      const next = { ...current };
      if (!trimmed) {
        delete next[sessionID];
        return next;
      }
      next[sessionID] = trimmed;
      return next;
    });
  }

  async function startProviderAuth(providerId?: string) {
    const c = client();
    if (!c) {
      throw new Error("Not connected to a server");
    }

    const authMethods = unwrap(await c.provider.auth());
    const providerIds = Object.keys(authMethods).sort();
    if (!providerIds.length) {
      throw new Error("No providers available");
    }

    const resolved = providerId?.trim() ?? "";
    if (!resolved) {
      throw new Error("Provider ID is required");
    }
    if (!authMethods[resolved]) {
      throw new Error(`Unknown provider: ${resolved}`);
    }

    const methods = authMethods[resolved];
    if (!methods || !methods.length) {
      throw new Error(`No auth methods for ${resolved}`);
    }

    const oauthIndex = methods.findIndex((method) => method.type === "oauth");
    if (oauthIndex === -1) {
      return `Configure ${resolved} API keys in opencode.json`;
    }

    const auth = unwrap(await c.provider.oauth.authorize({ providerID: resolved, method: oauthIndex }));
    if (isTauriRuntime()) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(auth.url);
    } else {
      window.open(auth.url, "_blank", "noopener,noreferrer");
    }

    return auth.instructions || `Opened ${resolved} auth in browser`;
  }

  async function openProviderAuthModal() {
    const c = client();
    if (!c) {
      throw new Error("Not connected to a server");
    }

    setProviderAuthBusy(true);
    setProviderAuthError(null);
    try {
      const methods = unwrap(await c.provider.auth());
      setProviderAuthMethods(methods as Record<string, ProviderAuthMethod[]>);
      setProviderAuthModalOpen(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load providers";
      setProviderAuthError(message);
      throw error;
    } finally {
      setProviderAuthBusy(false);
    }
  }

  function closeProviderAuthModal() {
    setProviderAuthModalOpen(false);
    setProviderAuthError(null);
  }

  async function saveSessionExport(sessionID: string) {
    if (isDemoMode()) {
      const payload = {
        sessionID,
        messages: activeMessages(),
        todos: activeTodos(),
        exportedAt: new Date().toISOString(),
        source: "openwork",
      };
      return downloadSessionExport(payload, `session-${sessionID}.json`);
    }

    const c = client();
    if (!c) {
      throw new Error("Not connected to a server");
    }

    const session = unwrap(await c.session.get({ sessionID }));
    const messages = unwrap(await c.session.messages({ sessionID }));
    let todos: TodoItem[] = [];
    try {
      todos = unwrap(await c.session.todo({ sessionID }));
    } catch {
      // ignore
    }

    const payload = {
      session,
      messages,
      todos,
      exportedAt: new Date().toISOString(),
      source: "openwork",
    };

    const baseName = session.title || session.slug || session.id;
    const safeName = baseName
      .toLowerCase()
      .replace(/[^a-z0-9\-_.]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    const fileName = `session-${safeName || session.id}.json`;
    return downloadSessionExport(payload, fileName);
  }

  function downloadSessionExport(payload: unknown, fileName: string) {
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
    return fileName;
  }


  async function respondPermissionAndRemember(
    requestID: string,
    reply: "once" | "always" | "reject"
  ) {
    // Intentional no-op: permission prompts grant session-scoped access only.
    // Persistent workspace roots must be managed explicitly via workspace settings.
    await respondPermission(requestID, reply);
  }

  const [notionStatus, setNotionStatus] = createSignal<"disconnected" | "connecting" | "connected" | "error">(
    "disconnected",
  );
  const [notionStatusDetail, setNotionStatusDetail] = createSignal<string | null>(null);
  const [notionError, setNotionError] = createSignal<string | null>(null);
  const [notionBusy, setNotionBusy] = createSignal(false);
  const [notionSkillInstalled, setNotionSkillInstalled] = createSignal(false);
  const [tryNotionPromptVisible, setTryNotionPromptVisible] = createSignal(false);
  const notionIsActive = createMemo(() => notionStatus() === "connected");
  const [mcpServers, setMcpServers] = createSignal<McpServerEntry[]>([]);
  const [mcpStatus, setMcpStatus] = createSignal<string | null>(null);
  const [mcpLastUpdatedAt, setMcpLastUpdatedAt] = createSignal<number | null>(null);
  const [mcpStatuses, setMcpStatuses] = createSignal<McpStatusMap>({});
  const [mcpConnectingName, setMcpConnectingName] = createSignal<string | null>(null);
  const [selectedMcp, setSelectedMcp] = createSignal<string | null>(null);

  // MCP OAuth modal state
  const [mcpAuthModalOpen, setMcpAuthModalOpen] = createSignal(false);
  const [mcpAuthEntry, setMcpAuthEntry] = createSignal<(typeof MCP_QUICK_CONNECT)[number] | null>(null);

  const extensionsStore = createExtensionsStore({
    client,
    mode,
    projectDir: () => workspaceProjectDir(),
    activeWorkspaceRoot: () => workspaceStore.activeWorkspaceRoot(),
    setBusy,
    setBusyLabel,
    setBusyStartedAt,
    setError,
    markReloadRequired: (reason) => markReloadRequiredRef(reason),
    onNotionSkillInstalled: () => {
      setNotionSkillInstalled(true);
      try {
        window.localStorage.setItem("openwork.notionSkillInstalled", "1");
      } catch {
        // ignore
      }
      if (notionIsActive()) {
        setTryNotionPromptVisible(true);
      }
    },
  });

  const {
    skills,
    skillsStatus,
    pluginScope,
    setPluginScope,
    pluginConfig,
    pluginList,
    pluginInput,
    setPluginInput,
    pluginStatus,
    activePluginGuide,
    setActivePluginGuide,
    sidebarPluginList,
    sidebarPluginStatus,
    isPluginInstalledByName,
    refreshSkills,
    refreshPlugins,
    addPlugin,
    importLocalSkill,
    installSkillCreator,
    revealSkillsFolder,
    uninstallSkill,
    abortRefreshes,
  } = extensionsStore;

  const globalSync = useGlobalSync();
  const providers = createMemo(() => globalSync.data.provider.all ?? []);
  const providerDefaults = createMemo(() => globalSync.data.provider.default ?? {});
  const providerConnectedIds = createMemo(() => globalSync.data.provider.connected ?? []);
  const setProviders = (value: Provider[]) => {
    globalSync.set("provider", "all", value);
  };
  const setProviderDefaults = (value: Record<string, string>) => {
    globalSync.set("provider", "default", value);
  };
  const setProviderConnectedIds = (value: string[]) => {
    globalSync.set("provider", "connected", value);
  };

  const [defaultModel, setDefaultModel] = createSignal<ModelRef>(DEFAULT_MODEL);
  const sessionModelOverridesKey = (workspaceId: string) =>
    `${SESSION_MODEL_PREF_KEY}.${workspaceId}`;

  const parseSessionModelOverrides = (raw: string | null) => {
    if (!raw) return {} as Record<string, ModelRef>;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {} as Record<string, ModelRef>;
      }
      const next: Record<string, ModelRef> = {};
      for (const [sessionId, value] of Object.entries(parsed)) {
        if (typeof value === "string") {
          const model = parseModelRef(value);
          if (model) next[sessionId] = model;
          continue;
        }
        if (!value || typeof value !== "object") continue;
        const record = value as Record<string, unknown>;
        if (typeof record.providerID === "string" && typeof record.modelID === "string") {
          next[sessionId] = {
            providerID: record.providerID,
            modelID: record.modelID,
          };
        }
      }
      return next;
    } catch {
      return {} as Record<string, ModelRef>;
    }
  };

  const serializeSessionModelOverrides = (overrides: Record<string, ModelRef>) => {
    const entries = Object.entries(overrides);
    if (!entries.length) return null;
    const payload: Record<string, string> = {};
    for (const [sessionId, model] of entries) {
      payload[sessionId] = formatModelRef(model);
    }
    return JSON.stringify(payload);
  };

  const parseDefaultModelFromConfig = (content: string | null) => {
    if (!content) return null;
    try {
      const parsed = parse(content) as Record<string, unknown> | undefined;
      const rawModel = typeof parsed?.model === "string" ? parsed.model : null;
      return parseModelRef(rawModel);
    } catch {
      return null;
    }
  };

  const formatConfigWithDefaultModel = (content: string | null, model: ModelRef) => {
    let config: Record<string, unknown> = {};
    if (content?.trim()) {
      try {
        const parsed = parse(content) as Record<string, unknown> | undefined;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          config = { ...parsed };
        }
      } catch {
        config = {};
      }
    }

    if (!config["$schema"]) {
      config["$schema"] = "https://opencode.ai/config.json";
    }

    config.model = formatModelRef(model);
    return `${JSON.stringify(config, null, 2)}\n`;
  };
  const [modelPickerOpen, setModelPickerOpen] = createSignal(false);
  const [modelPickerTarget, setModelPickerTarget] = createSignal<
    "session" | "default"
  >("session");
  const [modelPickerQuery, setModelPickerQuery] = createSignal("");

  const [showThinking, setShowThinking] = createSignal(false);
  const [modelVariant, setModelVariant] = createSignal<string | null>(null);

  const MODEL_VARIANT_OPTIONS = [
    { value: "none", label: "None" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "X-High" },
  ];

  const normalizeModelVariant = (value: string | null) => {
    if (!value) return null;
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "balance" || trimmed === "balanced") return "none";
    const match = MODEL_VARIANT_OPTIONS.find((option) => option.value === trimmed);
    return match ? match.value : null;
  };

  const formatModelVariantLabel = (value: string | null) => {
    const normalized = normalizeModelVariant(value) ?? "none";
    return MODEL_VARIANT_OPTIONS.find((option) => option.value === normalized)?.label ?? "None";
  };

  const handleEditModelVariant = () => {
    const next = window.prompt(
      "Model variant (none, low, medium, high, xhigh)",
      normalizeModelVariant(modelVariant()) ?? "none"
    );
    if (next == null) return;
    const normalized = normalizeModelVariant(next);
    if (!normalized) {
      window.alert("Variant must be one of: none, low, medium, high, xhigh.");
      return;
    }
    setModelVariant(normalized);
  };

  let loadCommandsRef: (options?: { workspaceRoot?: string; quiet?: boolean }) => Promise<void> = async () => {};

  const workspaceStore = createWorkspaceStore({
    mode,
    setMode,
    onboardingStep,
    setOnboardingStep,
    rememberModeChoice,
    baseUrl,
    setBaseUrl,
    clientDirectory,
    setClientDirectory,
    client,
    setClient,
    setConnectedVersion,
    setSseConnected,
    setProviders,
    setProviderDefaults,
    setProviderConnectedIds,
    setError,
    setBusy,
    setBusyLabel,
    setBusyStartedAt,
    loadCommands: (options) => loadCommandsRef(options),
    loadSessions,
    refreshPendingPermissions,
    selectedSessionId,
    selectSession,
    setSelectedSessionId,
    setMessages,
    setTodos,
    setPendingPermissions,
    setSessionStatusById,
    defaultModel,
    modelVariant,
    refreshSkills,
    refreshPlugins,
    engineSource,
    setEngineSource,
    setView,
    setTab,
    isWindowsPlatform,
  });

  const commandState = createCommandState({
    client,
    selectedSession,
    prompt,
    lastPromptSent,
    loadSessions,
    selectSession,
    setSessionModelById,
    setSessionAgent,
    defaultModel,
    modelVariant,
    setView,
    isDemoMode,
    activeWorkspaceRoot: () => workspaceStore.activeWorkspaceRoot(),
    setBusy,
    setBusyLabel,
    setBusyStartedAt,
    setError,
  });

  const {
    commands,
    setCommands,
    commandsLoaded,
    setCommandsLoaded,
    commandModalOpen,
    setCommandModalOpen,
    commandDraftName,
    setCommandDraftName,
    commandDraftDescription,
    setCommandDraftDescription,
    commandDraftTemplate,
    setCommandDraftTemplate,
    commandDraftScope,
    setCommandDraftScope,
    runModalOpen,
    runModalCommand,
    runModalDetails,
    setRunModalDetails,
    workspaceCommands,
    globalCommands,
    otherCommands,
    openCommandModal,
    saveCommand,
    deleteCommand,
    runCommand,
    loadCommands,
    openRunModal,
    confirmRunModal,
    closeRunModal,
    justSavedCommand,
    clearJustSavedCommand,
  } = commandState;

  const commandRegistry = createCommandRegistry();
  const commandRegistryItems = createMemo(() => commandRegistry.items());

  const resolveKeybind = (command: CommandRegistryItem) =>
    keybindOverrides()[command.id] ?? command.keybind ?? null;

  const commandById = createMemo(() => {
    const map = new Map<string, CommandRegistryItem>();
    for (const item of commandRegistryItems()) {
      map.set(item.id, item);
    }
    return map;
  });

  const registerRecentCommand = (commandId: string) => {
    setRecentCommandIds((current) => {
      const next = [commandId, ...current.filter((id) => id !== commandId)];
      return next.slice(0, 6);
    });
  };

  const runRegistryCommand = (command: CommandRegistryItem, source: CommandTriggerContext["source"]) => {
    command.onSelect({ source });
    registerRecentCommand(command.id);
  };

  const openCommandPalette = (mode: "command" | "file") => {
    setCommandPaletteMode(mode);
    setCommandPaletteQuery("");
    setCommandPaletteOpen(true);
  };
  const closeCommandPalette = () => setCommandPaletteOpen(false);

  const isCommandAvailable = (command: CommandRegistryItem) => {
    const scope = command.scope ?? "global";
    if (scope === "session" && currentView() !== "session") return false;
    return true;
  };

  const insertFileIntoPrompt = (file: string) => {
    const current = prompt();
    const separator = current.trim() && !current.endsWith(" ") ? " " : "";
    setPrompt(`${current}${separator}${file}`);
    window.dispatchEvent(new Event("openwork:focusPrompt"));
    const sessionId = activeSessionId();
    if (currentView() !== "session" && sessionId) {
      setView("session", sessionId);
    }
  };

  const recentCommands = createMemo(() =>
    recentCommandIds()
      .map((id) => commandById().get(id))
      .filter((command): command is CommandRegistryItem => Boolean(command)),
  );

  const paletteCommandItems = createMemo(() =>
    commandRegistryItems()
      .filter((command) => command.showInPalette !== false && isCommandAvailable(command))
      .map((command) => ({
        id: `command:${command.id}`,
        title: command.title,
        description: command.description,
        category: command.category,
        keybind: resolveKeybind(command) ?? undefined,
        onSelect: () => runRegistryCommand(command, "palette"),
        onHighlight: () => command.onHighlight?.({ source: "palette" }),
      })),
  );

  const paletteRecentItems = createMemo(() =>
    recentCommands()
      .filter((command) => command.showInPalette !== false && isCommandAvailable(command))
      .map((command) => ({
        id: `recent:${command.id}`,
        title: command.title,
        description: command.description,
        category: command.category,
        keybind: resolveKeybind(command) ?? undefined,
        onSelect: () => runRegistryCommand(command, "palette"),
        onHighlight: () => command.onHighlight?.({ source: "palette" }),
      })),
  );

  const paletteFileItems = createMemo(() =>
    activeWorkingFiles().map((file) => ({
      id: `file:${file}`,
      title: file,
      description: "Working file",
      onSelect: () => insertFileIntoPrompt(file),
    })),
  );

  createEffect(() => {
    if (!commandPaletteOpen() || commandPaletteMode() !== "command") return;
    void loadPaletteAgents();
  });

  const paletteSessionItems = createMemo(() =>
    activeSessions().map((session) => ({
      id: `session:${session.id}`,
      title: session.title || session.slug || "Untitled session",
      description: session.id === activeSessionId() ? "Active" : session.slug ?? session.id,
      onSelect: () => {
        selectSession(session.id);
        setView("session", session.id);
      },
    })),
  );

  const paletteAgentItems = createMemo(() => {
    const sessionId = activeSessionId();
    if (!sessionId) return [];
    const selectedAgent = selectedSessionAgent();
    const items = [
      {
        id: "agent:default",
        title: "Default agent",
        description: selectedAgent ? undefined : "Active",
        onSelect: () => setSessionAgent(sessionId, null),
      },
    ];
    for (const agent of paletteAgents()) {
      items.push({
        id: `agent:${agent.name}`,
        title: agent.name,
        description: agent.name === selectedAgent ? "Active" : undefined,
        onSelect: () => setSessionAgent(sessionId, agent.name),
      });
    }
    return items;
  });

  const paletteVariantItems = createMemo(() => {
    const currentVariant = normalizeModelVariant(modelVariant()) ?? "none";
    return MODEL_VARIANT_OPTIONS.map((option) => ({
      id: `variant:${option.value}`,
      title: option.label,
      description: option.value === currentVariant ? "Active" : undefined,
      onSelect: () => setModelVariant(option.value),
    }));
  });

  const commandPaletteGroups = createMemo<PaletteGroup[]>(() => {
    const groups: PaletteGroup[] = [];
    if (commandPaletteMode() === "command") {
      if (paletteRecentItems().length) {
        groups.push({ id: "recent", title: "Recent", items: paletteRecentItems() });
      }
      if (paletteCommandItems().length) {
        groups.push({ id: "commands", title: "Commands", items: paletteCommandItems() });
      }
      if (paletteSessionItems().length) {
        groups.push({ id: "sessions", title: "Sessions", items: paletteSessionItems() });
      }
      if (paletteAgentItems().length) {
        groups.push({ id: "agents", title: "Agents", items: paletteAgentItems() });
      }
      if (paletteVariantItems().length) {
        groups.push({ id: "variants", title: "Variants", items: paletteVariantItems() });
      }
      if (paletteFileItems().length) {
        groups.push({ id: "files", title: "Files", items: paletteFileItems() });
      }
      return groups;
    }
    if (paletteFileItems().length) {
      groups.push({ id: "files", title: "Files", items: paletteFileItems() });
    }
    return groups;
  });

  const keybindConflicts = createMemo(() => {
    const byKeybind = new Map<string, CommandRegistryItem[]>();
    for (const command of commandRegistryItems()) {
      const rawKeybind = resolveKeybind(command);
      const keybind = rawKeybind ? normalizeKeybind(rawKeybind) ?? rawKeybind : null;
      if (!keybind) continue;
      const list = byKeybind.get(keybind) ?? [];
      list.push(command);
      byKeybind.set(keybind, list);
    }

    const conflicts = new Map<string, string[]>();
    for (const list of byKeybind.values()) {
      if (list.length < 2) continue;
      for (const command of list) {
        const others = list.filter((entry) => entry.id !== command.id).map((entry) => entry.title);
        conflicts.set(command.id, others);
      }
    }
    return conflicts;
  });

  const keybindSettings = createMemo(() =>
    commandRegistryItems().map((command) => ({
      id: command.id,
      title: command.title,
      category: command.category,
      description: command.description,
      defaultKeybind: command.keybind ?? null,
      overrideKeybind: keybindOverrides()[command.id] ?? null,
      conflicts: keybindConflicts().get(command.id) ?? [],
    })),
  );

  const updateKeybindOverride = (id: string, keybind: string | null) => {
    setKeybindOverrides((current) => {
      const next = { ...current };
      if (!keybind) {
        delete next[id];
      } else {
        const normalized = normalizeKeybind(keybind);
        if (normalized) {
          next[id] = normalized;
        }
      }
      return next;
    });
  };

  const resetKeybindOverride = (id: string) => updateKeybindOverride(id, null);
  const resetAllKeybinds = () => setKeybindOverrides({});

  createEffect(() => {
    const modifier = isWindowsPlatform() ? "ctrl" : "cmd";
    const cleanup = commandRegistry.registerCommands([
      {
        id: "palette.open",
        title: "Open command palette",
        category: "Navigation",
        description: "Search commands and files",
        keybind: `${modifier}+k`,
        showInPalette: false,
        scope: "global",
        onSelect: () => openCommandPalette("command"),
      },
      {
        id: "palette.files",
        title: "Open file palette",
        category: "Navigation",
        description: "Search working files",
        keybind: `${modifier}+p`,
        showInPalette: false,
        scope: "global",
        onSelect: () => openCommandPalette("file"),
      },
      {
        id: "nav.dashboard",
        title: "Open dashboard",
        category: "Navigation",
        description: "Return to the dashboard",
        scope: "global",
        onSelect: () => {
          setTab("home");
          setView("dashboard");
        },
      },
      {
        id: "nav.sessions",
        title: "Open sessions",
        category: "Navigation",
        description: "View all sessions",
        scope: "global",
        onSelect: () => {
          setTab("sessions");
          setView("dashboard");
        },
      },
      {
        id: "nav.commands",
        title: "Open commands",
        category: "Navigation",
        description: "Manage saved commands",
        scope: "global",
        onSelect: () => {
          setTab("commands");
          setView("dashboard");
        },
      },
      {
        id: "nav.skills",
        title: "Open skills",
        category: "Navigation",
        description: "Manage skills",
        scope: "global",
        onSelect: () => {
          setTab("skills");
          setView("dashboard");
        },
      },
      {
        id: "nav.plugins",
        title: "Open plugins",
        category: "Navigation",
        description: "Manage plugins",
        scope: "global",
        onSelect: () => {
          setTab("plugins");
          setView("dashboard");
        },
      },
      {
        id: "nav.mcp",
        title: "Open MCP",
        category: "Navigation",
        description: "Manage MCP servers",
        scope: "global",
        onSelect: () => {
          setTab("mcp");
          setView("dashboard");
        },
      },
      {
        id: "nav.settings",
        title: "Open settings",
        category: "Navigation",
        description: "Adjust preferences",
        scope: "global",
        onSelect: () => {
          setTab("settings");
          setView("dashboard");
        },
      },
      {
        id: "session.new-task",
        title: "Start new task",
        category: "Sessions",
        description: "Start a new session",
        scope: "global",
        onSelect: () => {
          createSessionAndOpen();
          setView("session");
        },
      },
    ]);

    onCleanup(() => cleanup());
  });

  loadCommandsRef = loadCommands;

  const systemState = createSystemState({
    client,
    mode,
    sessions,
    sessionStatusById,
    refreshPlugins,
    refreshSkills,
    refreshMcpServers,
    reloadWorkspaceEngine: () => workspaceStore.reloadWorkspaceEngine(),
    setProviders,
    setProviderDefaults,
    setProviderConnectedIds,
    setError,
    notion: {
      status: notionStatus,
      setStatus: setNotionStatus,
      statusDetail: notionStatusDetail,
      setStatusDetail: setNotionStatusDetail,
      skillInstalled: notionSkillInstalled,
      setTryPromptVisible: setTryNotionPromptVisible,
    },
  });

  const {
    reloadRequired,
    reloadReasons,
    reloadLastTriggeredAt,
    reloadBusy,
    reloadError,
    canReloadEngine,
    markReloadRequired,
    clearReloadRequired,
    reloadWorkspaceEngine,
    cacheRepairBusy,
    cacheRepairResult,
    repairOpencodeCache,
    updateAutoCheck,
    setUpdateAutoCheck,
    updateStatus,
    setUpdateStatus,
    pendingUpdate,
    setPendingUpdate,
    updateEnv,
    setUpdateEnv,
    checkForUpdates,
    downloadUpdate,
    installUpdateAndRestart,
    resetModalOpen,
    setResetModalOpen,
    resetModalMode,
    setResetModalMode,
    resetModalText,
    setResetModalText,
    resetModalBusy,
    openResetModal,
    confirmReset,
    anyActiveRuns,
  } = systemState;

  const [reloadToastDismissedAt, setReloadToastDismissedAt] = createSignal<number | null>(null);

  const reloadToastVisible = createMemo(() => {
    if (!reloadRequired()) return false;
    const lastTriggeredAt = reloadLastTriggeredAt();
    const dismissedAt = reloadToastDismissedAt();
    if (!lastTriggeredAt) return true;
    if (!dismissedAt) return true;
    return dismissedAt < lastTriggeredAt;
  });

  const reloadWarning = createMemo(() =>
    anyActiveRuns()
      ? t("reload.toast_warning_active", currentLocale())
      : t("reload.toast_warning", currentLocale()),
  );

  const reloadBlockedReason = createMemo(() => {
    if (!reloadRequired()) return null;
    if (!client()) return t("reload.toast_blocked_connect", currentLocale());
    if (mode() !== "host") return t("reload.toast_blocked_host", currentLocale());
    if (anyActiveRuns()) return t("reload.toast_blocked_runs", currentLocale());
    return null;
  });

  const reloadActionLabel = createMemo(() =>
    reloadBusy()
      ? t("reload.toast_reloading", currentLocale())
      : t("reload.toast_reload", currentLocale()),
  );

  createEffect(() => {
    if (!reloadRequired()) {
      setReloadToastDismissedAt(null);
    }
  });

  markReloadRequiredRef = markReloadRequired;

  const {
    engine,
    engineDoctorResult,
    engineDoctorCheckedAt,
    engineInstallLogs,
    projectDir: workspaceProjectDir,
    newAuthorizedDir,
    refreshEngineDoctor,
    stopHost,
    setEngineInstallLogs,
  } = workspaceStore;

  createEffect(() => {
    if (!isTauriRuntime() || isDemoMode()) return;
    workspaceStore.activeWorkspaceId();
    workspaceProjectDir();
    void refreshMcpServers();
  });

  const activeAuthorizedDirs = createMemo(() =>
    isDemoMode() ? demoAuthorizedDirs() : workspaceStore.authorizedDirs()
  );
  const activeWorkspaceDisplay = createMemo(() =>
    isDemoMode()
      ? demoActiveWorkspaceDisplay()
      : workspaceStore.activeWorkspaceDisplay()
  );
  const activePermissionMemo = createMemo(() =>
    isDemoMode() ? null : activePermission()
  );

  const [expandedStepIds, setExpandedStepIds] = createSignal<Set<string>>(
    new Set()
  );
  const [expandedSidebarSections, setExpandedSidebarSections] = createSignal({
    progress: true,
    artifacts: true,
    context: true,
    plugins: true,
    mcp: true,
    skills: true,
    authorizedFolders: true,
  });

  const [appVersion, setAppVersion] = createSignal<string | null>(null);


  const busySeconds = createMemo(() => {
    const start = busyStartedAt();
    if (!start) return 0;
    return Math.max(0, Math.round((Date.now() - start) / 1000));
  });

  const newTaskDisabled = createMemo(() => {
    if (!isDemoMode() && !client()) {
      return true;
    }

    const label = busyLabel();
    // Allow creating a new session even while a run is in progress.
    if (busy() && label === "status.running") return false;

    // Otherwise, block during engine / connection transitions.
    if (
      busy() &&
      (label === "status.connecting" ||
        label === "status.starting_engine" ||
        label === "status.disconnecting")
    ) {
      return true;
    }

    return busy();
  });

  createEffect(() => {
    // If we lose the client (disconnect / stop engine), don't strand the user
    // in a session view that can't operate.
    if (currentView() !== "session") return;
    if (isDemoMode()) return;
    if (creatingSession()) return;
    if (client()) return;
    setView("dashboard");
  });

  const selectedSessionModel = createMemo<ModelRef>(() => {
    const id = selectedSessionId();
    if (!id) return defaultModel();

    const override = sessionModelOverrideById()[id];
    if (override) return override;

    const known = sessionModelById()[id];
    if (known) return known;

    const fromMessages = lastUserModelFromMessages(messages());
    if (fromMessages) return fromMessages;

    return defaultModel();
  });

  const selectedSessionAgent = createMemo(() => {
    const id = selectedSessionId();
    if (!id) return null;
    return sessionAgentById()[id] ?? null;
  });

  const selectedSessionModelLabel = createMemo(() =>
    formatModelLabel(selectedSessionModel(), providers())
  );

  const modelPickerCurrent = createMemo(() =>
    modelPickerTarget() === "default" ? defaultModel() : selectedSessionModel()
  );

  const modelOptions = createMemo<ModelOption[]>(() => {
    const allProviders = providers();
    const defaults = providerDefaults();
    const currentDefault = defaultModel();

    if (!allProviders.length) {
      return [
        {
          providerID: DEFAULT_MODEL.providerID,
          modelID: DEFAULT_MODEL.modelID,
          title: DEFAULT_MODEL.modelID,
          description: DEFAULT_MODEL.providerID,
          footer: t("settings.model_fallback", currentLocale()),
          isFree: true,
          isConnected: false,
        },
      ];
    }

    const sortedProviders = allProviders.slice().sort((a, b) => {
      const aIsOpencode = a.id === "opencode";
      const bIsOpencode = b.id === "opencode";
      if (aIsOpencode !== bIsOpencode) return aIsOpencode ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const next: ModelOption[] = [];

    for (const provider of sortedProviders) {
      const defaultModelID = defaults[provider.id];
      const isConnected = providerConnectedIds().includes(provider.id);
      const models = Object.values(provider.models ?? {}).filter(
        (m) => m.status !== "deprecated"
      );

      models.sort((a, b) => {
        const aFree = a.cost?.input === 0 && a.cost?.output === 0;
        const bFree = b.cost?.input === 0 && b.cost?.output === 0;
        if (aFree !== bFree) return aFree ? -1 : 1;
        return (a.name ?? a.id).localeCompare(b.name ?? b.id);
      });

      for (const model of models) {
        const isFree = model.cost?.input === 0 && model.cost?.output === 0;
        const isDefault =
          provider.id === currentDefault.providerID && model.id === currentDefault.modelID;
        const footerBits: string[] = [];
        if (defaultModelID === model.id || isDefault) {
          footerBits.push(t("settings.model_default", currentLocale()));
        }
        if (isFree) footerBits.push(t("settings.model_free", currentLocale()));
        if (model.capabilities?.reasoning) footerBits.push(t("settings.model_reasoning", currentLocale()));

        next.push({
          providerID: provider.id,
          modelID: model.id,
          title: model.name ?? model.id,
          description: provider.name,
          footer: footerBits.length
            ? footerBits.slice(0, 2).join(" · ")
            : undefined,
          disabled: !isConnected,
          isFree,
          isConnected,
        });
      }
    }

    next.sort((a, b) => {
      if (a.isConnected !== b.isConnected) return a.isConnected ? -1 : 1;
      if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
      return a.title.localeCompare(b.title);
    });

    return next;
  });

  const filteredModelOptions = createMemo(() => {
    const q = modelPickerQuery().trim().toLowerCase();
    const options = modelOptions();
    if (!q) return options;

    return options.filter((opt) => {
      const haystack = [
        opt.title,
        opt.description ?? "",
        opt.footer ?? "",
        `${opt.providerID}/${opt.modelID}`,
        opt.isConnected ? "connected" : "disconnected",
        opt.isFree ? "free" : "paid",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  });

  function openSessionModelPicker() {
    setModelPickerTarget("session");
    setModelPickerQuery("");
    setModelPickerOpen(true);
  }

  function openDefaultModelPicker() {
    setModelPickerTarget("default");
    setModelPickerQuery("");
    setModelPickerOpen(true);
  }

  function applyModelSelection(next: ModelRef) {
    if (modelPickerTarget() === "default") {
      setDefaultModelExplicit(true);
      setDefaultModel(next);
      setModelPickerOpen(false);
      return;
    }

    const id = selectedSessionId();
    if (!id) {
      setModelPickerOpen(false);
      return;
    }

    setSessionModelOverrideById((current) => ({ ...current, [id]: next }));
    setDefaultModelExplicit(true);
    setDefaultModel(next);
    setModelPickerOpen(false);

    if (typeof window !== "undefined" && currentView() === "session") {
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent("openwork:focusPrompt"));
      });
    }
  }


  function clearOpenworkLocalStorage() {
    if (typeof window === "undefined") return;

    try {
      const keys = Object.keys(window.localStorage);
      for (const key of keys) {
        if (key.startsWith("openwork.")) {
          window.localStorage.removeItem(key);
        }
      }
      // Legacy compatibility key
      window.localStorage.removeItem("openwork_mode_pref");
    } catch {
      // ignore
    }
  }


  async function connectNotion() {
    if (mode() !== "host") {
      setNotionError("Notion connections are only available in Host mode.");
      return;
    }

    const projectDir = workspaceProjectDir().trim();
    if (!projectDir) {
      setNotionError("Pick a workspace folder first.");
      return;
    }

    if (!isTauriRuntime()) {
      setNotionError("Notion connections require the desktop app.");
      return;
    }

    if (notionBusy()) return;

    setNotionBusy(true);
    setNotionError(null);
    setNotionStatus("connecting");
    setNotionStatusDetail(t("settings.reload_required", currentLocale()));
    setNotionSkillInstalled(false);

    try {
      const config = await readOpencodeConfig("project", projectDir);
      const raw = config.content ?? "";
      const nextConfig = raw.trim()
        ? (parse(raw) as Record<string, unknown>)
        : { $schema: "https://opencode.ai/config.json" };

      const mcp = typeof nextConfig.mcp === "object" && nextConfig.mcp ? { ...(nextConfig.mcp as Record<string, unknown>) } : {};
      mcp.notion = {
        type: "remote",
        url: "https://mcp.notion.com/mcp",
        enabled: true,
      };

      nextConfig.mcp = mcp;
      const formatted = JSON.stringify(nextConfig, null, 2);

      const result = await writeOpencodeConfig("project", projectDir, `${formatted}\n`);
      if (!result.ok) {
        throw new Error(result.stderr || result.stdout || "Failed to update opencode.json");
      }

      markReloadRequired("mcp");
      setNotionStatusDetail(t("settings.reload_required", currentLocale()));
      try {
        window.localStorage.setItem("openwork.notionStatus", "connecting");
        window.localStorage.setItem("openwork.notionStatusDetail", t("settings.reload_required", currentLocale()));
        window.localStorage.setItem("openwork.notionSkillInstalled", "0");
      } catch {
        // ignore
      }
    } catch (e) {
      setNotionStatus("error");
      setNotionError(e instanceof Error ? e.message : "Failed to connect Notion.");
    } finally {
      setNotionBusy(false);
    }
  }

  async function refreshMcpServers() {
    const projectDir = workspaceProjectDir().trim();

    if (!isTauriRuntime()) {
      setMcpStatus("MCP configuration is only available in Host mode.");
      setMcpServers([]);
      setMcpStatuses({});
      return;
    }

    if (!projectDir) {
      setMcpStatus("Pick a workspace folder to load MCP servers.");
      setMcpServers([]);
      setMcpStatuses({});
      return;
    }

    try {
      setMcpStatus(null);
      const config = await readOpencodeConfig("project", projectDir);
      if (!config.exists || !config.content) {
        setMcpServers([]);
        setMcpStatuses({});
        setMcpStatus("No opencode.json found yet. Create one by connecting an MCP.");
        return;
      }

      const next = parseMcpServersFromContent(config.content);
      setMcpServers(next);
      setMcpLastUpdatedAt(Date.now());

      const activeClient = client();
      if (activeClient) {
        try {
          const status = unwrap(await activeClient.mcp.status({ directory: projectDir }));
          setMcpStatuses(status as McpStatusMap);
        } catch {
          setMcpStatuses({});
        }
      }

      if (!next.length) {
        setMcpStatus("No MCP servers configured yet.");
      }
    } catch (e) {
      setMcpServers([]);
      setMcpStatuses({});
      setMcpStatus(e instanceof Error ? e.message : "Failed to load MCP servers");
    }
  }

  async function connectMcp(entry: (typeof MCP_QUICK_CONNECT)[number]) {
    console.log("[connectMcp] called with entry:", entry);

    if (mode() !== "host") {
      console.log("[connectMcp] ❌ mode is not host, mode=", mode());
      setMcpStatus(t("mcp.host_mode_only", currentLocale()));
      return;
    }

    const projectDir = workspaceProjectDir().trim();
    console.log("[connectMcp] projectDir:", projectDir);
    if (!projectDir) {
      console.log("[connectMcp] ❌ no projectDir");
      setMcpStatus(t("mcp.pick_workspace_first", currentLocale()));
      return;
    }

    if (!isTauriRuntime()) {
      console.log("[connectMcp] ❌ not Tauri runtime");
      setMcpStatus(t("mcp.desktop_required", currentLocale()));
      return;
    }
    console.log("[connectMcp] ✓ is Tauri runtime");

    const activeClient = client();
    console.log("[connectMcp] activeClient:", activeClient ? "exists" : "null");
    if (!activeClient) {
      console.log("[connectMcp] ❌ no activeClient");
      setMcpStatus(t("mcp.connect_server_first", currentLocale()));
      return;
    }

    const slug = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const entryType = entry.type ?? "remote";
    console.log("[connectMcp] slug:", slug);

    try {
      setMcpStatus(null);
      setMcpConnectingName(entry.name);
      console.log("[connectMcp] connecting name set to:", entry.name);

      // Step 1: Read existing opencode.json config
      console.log("[connectMcp] reading opencode config for projectDir:", projectDir);
      const configFile = await readOpencodeConfig("project", projectDir);
      console.log("[connectMcp] config file result:", configFile);

      // Step 2: Parse and merge the MCP entry into the config
      let existingConfig: Record<string, unknown> = {};
      if (configFile.exists && configFile.content?.trim()) {
        try {
          existingConfig = parse(configFile.content) ?? {};
          console.log("[connectMcp] parsed existing config:", existingConfig);
        } catch (parseErr) {
          console.warn("[connectMcp] failed to parse existing config, starting fresh:", parseErr);
          existingConfig = {};
        }
      }

      // Ensure base structure
      if (!existingConfig["$schema"]) {
        existingConfig["$schema"] = "https://opencode.ai/config.json";
      }

      // Ensure mcp object exists
      const mcpSection = (existingConfig["mcp"] as Record<string, unknown>) ?? {};
      existingConfig["mcp"] = mcpSection;

      // Add the new MCP server entry
      const mcpEntryConfig: Record<string, unknown> = {
        type: entryType,
        enabled: true,
      };
      if (entryType === "remote") {
        if (!entry.url) {
          throw new Error("Missing MCP URL.");
        }
        mcpEntryConfig["url"] = entry.url;
        if (entry.oauth) {
          mcpEntryConfig["oauth"] = {};
        }
      }
      if (entryType === "local") {
        if (!entry.command?.length) {
          throw new Error("Missing MCP command.");
        }
        mcpEntryConfig["command"] = entry.command;
      }
      mcpSection[slug] = mcpEntryConfig;
      console.log("[connectMcp] merged MCP config:", existingConfig);

      // Step 3: Write the updated config back
      const writeResult = await writeOpencodeConfig(
        "project",
        projectDir,
        `${JSON.stringify(existingConfig, null, 2)}\n`
      );
      console.log("[connectMcp] writeOpencodeConfig result:", writeResult);
      if (!writeResult.ok) {
        throw new Error(writeResult.stderr || writeResult.stdout || "Failed to write opencode.json");
      }

      // Step 4: Call SDK mcp.add to update runtime state
      const mcpAddConfig =
        entryType === "remote"
          ? {
              type: "remote" as const,
              url: entry.url!,
              enabled: true,
              ...(entry.oauth ? { oauth: {} } : {}),
            }
          : {
              type: "local" as const,
              command: entry.command!,
              enabled: true,
            };

      const mcpAddPayload = {
        directory: projectDir,
        name: slug,
        config: mcpAddConfig,
      };
      console.log("[connectMcp] calling activeClient.mcp.add with:", mcpAddPayload);

      const rawResult = await activeClient.mcp.add(mcpAddPayload);
      console.log("[connectMcp] mcp.add raw result:", rawResult);

      const status = unwrap(rawResult);
      console.log("[connectMcp] mcp.add unwrapped status:", status);

      setMcpStatuses(status as McpStatusMap);
      await refreshMcpServers();

      // Step 5: If OAuth, open the auth modal (modal handles the auth flow)
      if (entry.oauth) {
        console.log("[connectMcp] entry has OAuth, opening auth modal for:", entry.name);
        setMcpAuthEntry(entry);
        setMcpAuthModalOpen(true);
      } else {
        setMcpStatus(t("mcp.reload_required_after_add", currentLocale()));
      }

      markReloadRequired("mcp");
      console.log("[connectMcp] ✓ marked reload required, refreshing servers");

      await refreshMcpServers();
      console.log("[connectMcp] ✓ done");
    } catch (e) {
      console.error("[connectMcp] ❌ error:", e);
      setMcpStatus(e instanceof Error ? e.message : t("mcp.connect_failed", currentLocale()));
    } finally {
      setMcpConnectingName(null);
      console.log("[connectMcp] finally block, connecting name cleared");
    }
  }

  async function createSessionAndOpen() {
    console.log("[DEBUG] createSessionAndOpen");
    console.log("[DEBUG] current baseUrl:", baseUrl());
    console.log("[DEBUG] engine info:", engine());
    if (isDemoMode()) {
      const demoId = activeSessionId();
      if (demoId) {
        goToSession(demoId);
      } else {
        setView("session");
      }
      return;
    }

    console.log("[DEBUG] creating session");
    const c = client();
    if (!c) {
      console.log("[DEBUG] no client available!");
      return;
    }

    // Abort any in-flight refresh operations to free up connection resources
    console.log("[DEBUG] aborting in-flight refreshes");
    abortRefreshes();

    // Small delay to allow pending requests to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    console.log("[DEBUG] client found");
    setBusy(true);
    console.log("[DEBUG] busy set");
    setBusyLabel("status.creating_task");
    console.log("[DEBUG] busy label set");
    setBusyStartedAt(Date.now());
    console.log("[DEBUG] busy started at set");
    setError(null);
    console.log("[DEBUG] error set");
    setCreatingSession(true);

    console.log("[DEBUG] with timeout defined");
    const withTimeout = async <T,>(
      promise: Promise<T>,
      ms: number,
      label: string
    ) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          ms
        );
      });
      try {
        return await Promise.race([promise, timeoutPromise]);
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
    };

    const runId = (() => {
      const key = "__openwork_create_session_run__";
      const w = window as typeof window & { [key]?: number };
      w[key] = (w[key] ?? 0) + 1;
      return w[key];
    })();

    const mark = (() => {
      const start = Date.now();
      return (label: string, payload?: unknown) => {
        const elapsedMs = Date.now() - start;
        if (payload === undefined) {
          console.log(`[run ${runId}] ${label} (+${elapsedMs}ms)`);
        } else {
          console.log(`[run ${runId}] ${label} (+${elapsedMs}ms)`, payload);
        }
      };
    })();

    try {
      // Quick health check to detect stale connection
      mark("checking health");
      try {
        const healthResult = await withTimeout(c.global.health(), 3_000, "health");
        mark("health ok", healthResult);
      } catch (healthErr) {
        mark("health FAILED", healthErr);
        throw new Error(t("app.connection_lost", currentLocale()));
      }

      let rawResult: Awaited<ReturnType<typeof c.session.create>>;
      try {
        mark("creating session");
        rawResult = await c.session.create({
          directory: workspaceStore.activeWorkspaceRoot().trim(),
        });
        mark("session created");
      } catch (createErr) {
        mark("session create error", createErr);
        throw createErr;
      }
      mark("raw result received");
      const session = unwrap(rawResult);
      mark("session unwrapped");
      // Set selectedSessionId BEFORE switching view to avoid "No session selected" flash
      setBusyLabel("status.loading_session");
      await withTimeout(
        loadSessions(workspaceStore.activeWorkspaceRoot().trim()),
        12_000,
        "session.list"
      );
      mark("sessions loaded");
      await selectSession(session.id);
      mark("session selected");
      // Now switch view AFTER session is selected
      mark("view set to session");
      // setSessionViewLockUntil(Date.now() + 1200);
      goToSession(session.id);
    } catch (e) {
      mark("error caught", e);
      const message = e instanceof Error ? e.message : t("app.unknown_error", currentLocale());
      setError(addOpencodeCacheHint(message));
    } finally {
      setCreatingSession(false);
      setBusy(false);
    }
  }


  onMount(async () => {
    const modePref = readModePreference();
    if (modePref) {
      setRememberModeChoice(true);
    }

    const unsubscribeTheme = subscribeToSystemTheme((isDark) => {
      if (themeMode() !== "system") return;
      applyThemeMode(isDark ? "dark" : "light");
    });

    onCleanup(() => {
      unsubscribeTheme();
    });

    createEffect(() => {
      const next = themeMode();
      persistThemeMode(next);
      applyThemeMode(next);
    });

    if (typeof window !== "undefined") {
      try {
        const storedBaseUrl = window.localStorage.getItem("openwork.baseUrl");
        if (storedBaseUrl) {
          setBaseUrl(storedBaseUrl);
        }

        const storedClientDir = window.localStorage.getItem(
          "openwork.clientDirectory"
        );
        if (storedClientDir) {
          setClientDirectory(storedClientDir);
        }

        const storedEngineSource = window.localStorage.getItem(
          "openwork.engineSource"
        );
        if (storedEngineSource === "path" || storedEngineSource === "sidecar") {
          setEngineSource(storedEngineSource);
        }

        const storedDefaultModel = window.localStorage.getItem(MODEL_PREF_KEY);
        const parsedDefaultModel = parseModelRef(storedDefaultModel);
        if (parsedDefaultModel) {
          setDefaultModel(parsedDefaultModel);
          setLegacyDefaultModel(parsedDefaultModel);
        } else {
          setDefaultModel(DEFAULT_MODEL);
          setLegacyDefaultModel(DEFAULT_MODEL);
          try {
            window.localStorage.setItem(
              MODEL_PREF_KEY,
              formatModelRef(DEFAULT_MODEL)
            );
          } catch {
            // ignore
          }
        }

        const storedThinking = window.localStorage.getItem(THINKING_PREF_KEY);
        if (storedThinking != null) {
          try {
            const parsed = JSON.parse(storedThinking);
            if (typeof parsed === "boolean") {
              setShowThinking(parsed);
            }
          } catch {
            // ignore
          }
        }

        const storedVariant = window.localStorage.getItem(VARIANT_PREF_KEY);
        if (storedVariant && storedVariant.trim()) {
          const normalized = normalizeModelVariant(storedVariant);
          if (normalized) {
            setModelVariant(normalized);
          }
        }

        const storedDemoMode = window.localStorage.getItem(DEMO_MODE_PREF_KEY);
        if (storedDemoMode != null) {
          setDemoMode(storedDemoMode === "1");
        }

        const storedDemoSequence = window.localStorage.getItem(
          DEMO_SEQUENCE_PREF_KEY
        );
        if (
          storedDemoSequence === "cold-open" ||
          storedDemoSequence === "scheduler" ||
          storedDemoSequence === "summaries" ||
          storedDemoSequence === "groceries"
        ) {
          setDemoSequence(storedDemoSequence);
        }

        const storedKeybinds = window.localStorage.getItem(KEYBIND_PREF_KEY);
        if (storedKeybinds) {
          try {
            const parsed = JSON.parse(storedKeybinds) as Record<string, unknown>;
            const next: Record<string, string> = {};
            for (const [id, value] of Object.entries(parsed ?? {})) {
              if (typeof value !== "string") continue;
              const normalized = normalizeKeybind(value);
              if (normalized) next[id] = normalized;
            }
            setKeybindOverrides(next);
          } catch {
            // ignore
          }
        }

        const storedRecentCommands = window.localStorage.getItem("openwork.commandRecent");
        if (storedRecentCommands) {
          try {
            const parsed = JSON.parse(storedRecentCommands);
            if (Array.isArray(parsed)) {
              const next = parsed.filter((value) => typeof value === "string").slice(0, 6);
              setRecentCommandIds(next);
            }
          } catch {
            // ignore
          }
        }

        const storedUpdateAutoCheck = window.localStorage.getItem(
          "openwork.updateAutoCheck"
        );
        if (storedUpdateAutoCheck === "0" || storedUpdateAutoCheck === "1") {
          setUpdateAutoCheck(storedUpdateAutoCheck === "1");
        }

        const storedUpdateCheckedAt = window.localStorage.getItem(
          "openwork.updateLastCheckedAt"
        );
        if (storedUpdateCheckedAt) {
          const parsed = Number(storedUpdateCheckedAt);
          if (Number.isFinite(parsed) && parsed > 0) {
            setUpdateStatus({ state: "idle", lastCheckedAt: parsed });
          }
        }

        const storedNotionStatus = window.localStorage.getItem("openwork.notionStatus");
        if (
          storedNotionStatus === "disconnected" ||
          storedNotionStatus === "connected" ||
          storedNotionStatus === "connecting" ||
          storedNotionStatus === "error"
        ) {
          setNotionStatus(storedNotionStatus);
        }

        const storedNotionDetail = window.localStorage.getItem("openwork.notionStatusDetail");
        if (storedNotionDetail) {
          setNotionStatusDetail(storedNotionDetail);
        } else if (storedNotionStatus === "connecting") {
          setNotionStatusDetail("Reload required");
        }

        if (storedNotionStatus === "connecting") {
          markReloadRequired("mcp");
        }

        await refreshMcpServers();

        const storedNotionSkillInstalled = window.localStorage.getItem("openwork.notionSkillInstalled");
        if (storedNotionSkillInstalled === "1") {
          setNotionSkillInstalled(true);
        }
      } catch {
        // ignore
      }
    }

    if (isTauriRuntime()) {
      try {
        setAppVersion(await getVersion());
      } catch {
        // ignore
      }

      try {
        setUpdateEnv(await updaterEnvironment());
      } catch {
        // ignore
      }

      if (updateAutoCheck()) {
        const state = updateStatus();
        const lastCheckedAt =
          state.state === "idle" ? state.lastCheckedAt : null;
        if (!lastCheckedAt || Date.now() - lastCheckedAt > 24 * 60 * 60_000) {
          checkForUpdates({ quiet: true }).catch(() => undefined);
        }
      }
    }

    void workspaceStore.bootstrapOnboarding().finally(() => setBooting(false));
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    const workspaceId = workspaceStore.activeWorkspaceId();
    if (!workspaceId) return;

    setSessionModelOverridesReady(false);
    const raw = window.localStorage.getItem(sessionModelOverridesKey(workspaceId));
    setSessionModelOverrideById(parseSessionModelOverrides(raw));
    setSessionModelOverridesReady(true);
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    const projectDir = workspaceProjectDir().trim();
    if (!projectDir) return;
    void refreshMcpServers();
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!sessionModelOverridesReady()) return;
    const workspaceId = workspaceStore.activeWorkspaceId();
    if (!workspaceId) return;

    const payload = serializeSessionModelOverrides(sessionModelOverrideById());
    try {
      if (payload) {
        window.localStorage.setItem(sessionModelOverridesKey(workspaceId), payload);
      } else {
        window.localStorage.removeItem(sessionModelOverridesKey(workspaceId));
      }
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    const workspaceId = workspaceStore.activeWorkspaceId();
    if (!workspaceId) return;

    setWorkspaceDefaultModelReady(false);
    const workspaceType = workspaceStore.activeWorkspaceDisplay().workspaceType;
    const workspaceRoot = workspaceStore.activeWorkspacePath().trim();
    const activeClient = client();

    let cancelled = false;

    const applyDefault = async () => {
      let configDefault: ModelRef | null = null;

      if (isTauriRuntime() && workspaceType === "local" && workspaceRoot) {
        try {
          const configFile = await readOpencodeConfig("project", workspaceRoot);
          configDefault = parseDefaultModelFromConfig(configFile.content);
        } catch {
          // ignore
        }
      } else if (activeClient) {
        try {
          const config = unwrap(
            await activeClient.config.get({ directory: workspaceRoot || undefined })
          );
          if (typeof config.model === "string") {
            configDefault = parseModelRef(config.model);
          }
        } catch {
          // ignore
        }
      }

      setDefaultModelExplicit(Boolean(configDefault));
      const nextDefault = configDefault ?? legacyDefaultModel();
      const currentDefault = untrack(defaultModel);
      if (nextDefault && !modelEquals(currentDefault, nextDefault)) {
        setDefaultModel(nextDefault);
      }

      if (!cancelled) {
        setWorkspaceDefaultModelReady(true);
      }
    };

    void applyDefault();

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    if (!workspaceDefaultModelReady()) return;
    if (!isTauriRuntime()) return;
    if (!defaultModelExplicit()) return;

    const workspace = workspaceStore.activeWorkspaceDisplay();
    if (workspace.workspaceType !== "local") return;

    const root = workspaceStore.activeWorkspacePath().trim();
    if (!root) return;
    const nextModel = defaultModel();
    let cancelled = false;

    const writeConfig = async () => {
      try {
        const configFile = await readOpencodeConfig("project", root);
        const existingModel = parseDefaultModelFromConfig(configFile.content);
        if (existingModel && modelEquals(existingModel, nextModel)) return;

        const content = formatConfigWithDefaultModel(configFile.content, nextModel);
        const result = await writeOpencodeConfig("project", root, content);
        if (!result.ok) {
          throw new Error(result.stderr || result.stdout || "Failed to update opencode.json");
        }
        markReloadRequired("config");
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : safeStringify(error);
        setError(addOpencodeCacheHint(message));
      }
    };

    void writeConfig();

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (onboardingStep() !== "host") return;
    void workspaceStore.refreshEngineDoctor();
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("openwork.baseUrl", baseUrl());
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        "openwork.clientDirectory",
        clientDirectory()
      );
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    // Legacy key: keep for backwards compatibility.
    try {
      window.localStorage.setItem("openwork.projectDir", workspaceProjectDir());
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("openwork.engineSource", engineSource());
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        MODEL_PREF_KEY,
        formatModelRef(defaultModel())
      );
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        "openwork.updateAutoCheck",
        updateAutoCheck() ? "1" : "0"
      );
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        THINKING_PREF_KEY,
        JSON.stringify(showThinking())
      );
    } catch {
      // ignore
    }
  });



  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const value = modelVariant();
      if (value) {
        window.localStorage.setItem(VARIANT_PREF_KEY, value);
      } else {
        window.localStorage.removeItem(VARIANT_PREF_KEY);
      }
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(DEMO_MODE_PREF_KEY, demoMode() ? "1" : "0");
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(DEMO_SEQUENCE_PREF_KEY, demoSequence());
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const overrides = keybindOverrides();
      if (Object.keys(overrides).length) {
        window.localStorage.setItem(KEYBIND_PREF_KEY, JSON.stringify(overrides));
      } else {
        window.localStorage.removeItem(KEYBIND_PREF_KEY);
      }
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const recent = recentCommandIds();
      if (recent.length) {
        window.localStorage.setItem("openwork.commandRecent", JSON.stringify(recent));
      } else {
        window.localStorage.removeItem("openwork.commandRecent");
      }
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (commandPaletteOpen()) return;
      const hasModifier = event.metaKey || event.ctrlKey || event.altKey;
      if (isEditableTarget(event.target) && !hasModifier) return;

      const match = commandRegistryItems().find((command) => {
        if (!isCommandAvailable(command)) return false;
        const keybind = resolveKeybind(command);
        if (!keybind) return false;
        return matchKeybind(event, keybind);
      });
      if (!match) return;
      event.preventDefault();
      event.stopPropagation();
      runRegistryCommand(match, "keybind");
    };

    window.addEventListener("keydown", onKeyDown, true);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, true));
  });

  createEffect(() => {
    const state = updateStatus();
    if (typeof window === "undefined") return;
    if (state.state === "idle" && state.lastCheckedAt) {
      try {
        window.localStorage.setItem(
          "openwork.updateLastCheckedAt",
          String(state.lastCheckedAt)
        );
      } catch {
        // ignore
      }
    }
  });

  const headerStatus = createMemo(() => {
    if (!client() || !connectedVersion()) return t("status.disconnected", currentLocale());
    const bits = [`${t("status.connected", currentLocale())} · ${connectedVersion()}`];
    if (sseConnected()) bits.push(t("status.live", currentLocale()));
    return bits.join(" · ");
  });

  const busyHint = createMemo(() => {
    if (!busy() || !busyLabel()) return null;
    const seconds = busySeconds();
    const label = t(busyLabel()!, currentLocale());
    return seconds > 0 ? `${label} · ${seconds}s` : label;
  });

  const workspaceSwitchWorkspace = createMemo(() => {
    const switchingId = workspaceStore.connectingWorkspaceId();
    if (switchingId) {
      return workspaceStore.workspaces().find((ws) => ws.id === switchingId) ?? activeWorkspaceDisplay();
    }
    return activeWorkspaceDisplay();
  });

  const workspaceSwitchOpen = createMemo(() => {
    if (booting()) return true;
    if (workspaceStore.connectingWorkspaceId()) return true;
    if (!busy() || !busyLabel()) return false;
    const label = busyLabel();
    return (
      label === "status.connecting" ||
      label === "status.starting_engine" ||
      label === "status.restarting_engine"
    );
  });

  const workspaceSwitchStatusKey = createMemo(() => {
    const label = busyLabel();
    if (label === "status.connecting") return "workspace.switching_status_connecting";
    if (label === "status.starting_engine" || label === "status.restarting_engine") {
      return "workspace.switching_status_preparing";
    }
    if (label === "status.loading_session") return "workspace.switching_status_loading";
    if (workspaceStore.connectingWorkspaceId()) return "workspace.switching_status_loading";
    if (booting()) return "workspace.switching_status_preparing";
    return "workspace.switching_status_preparing";
  });

  const localHostLabel = createMemo(() => {
    const info = engine();
    if (info?.hostname && info?.port) {
      return `${info.hostname}:${info.port}`;
    }

    try {
      return new URL(baseUrl()).host;
    } catch {
      return "localhost:4096";
    }
  });

  const onboardingProps = () => ({
    mode: mode(),
    onboardingStep: onboardingStep(),
    rememberModeChoice: rememberModeChoice(),
    busy: busy(),
    baseUrl: baseUrl(),
    clientDirectory: clientDirectory(),
    newAuthorizedDir: newAuthorizedDir(),
    authorizedDirs: workspaceStore.authorizedDirs(),
    activeWorkspacePath: workspaceStore.activeWorkspacePath(),
    workspaces: workspaceStore.workspaces(),
    localHostLabel: localHostLabel(),
    engineRunning: Boolean(engine()?.running),
    developerMode: developerMode(),
    engineBaseUrl: engine()?.baseUrl ?? null,
    engineDoctorFound: engineDoctorResult()?.found ?? null,
    engineDoctorSupportsServe: engineDoctorResult()?.supportsServe ?? null,
    engineDoctorVersion: engineDoctorResult()?.version ?? null,
    engineDoctorResolvedPath: engineDoctorResult()?.resolvedPath ?? null,
    engineDoctorNotes: engineDoctorResult()?.notes ?? [],
    engineDoctorServeHelpStdout: engineDoctorResult()?.serveHelpStdout ?? null,
    engineDoctorServeHelpStderr: engineDoctorResult()?.serveHelpStderr ?? null,
    engineDoctorCheckedAt: engineDoctorCheckedAt(),
    engineInstallLogs: engineInstallLogs(),
    error: error(),
    isWindows: isWindowsPlatform(),
    onBaseUrlChange: setBaseUrl,
    onClientDirectoryChange: setClientDirectory,
    onModeSelect: (nextMode: Mode) => {
      if (nextMode === "host" && rememberModeChoice()) {
        writeModePreference("host");
      }
      if (nextMode === "client" && rememberModeChoice()) {
        writeModePreference("client");
      }
      setMode(nextMode);
      setOnboardingStep(nextMode === "host" ? "host" : "client");
    },
    onRememberModeToggle: () => setRememberModeChoice((v) => !v),
    onStartHost: workspaceStore.onStartHost,
    onCreateWorkspace: workspaceStore.createWorkspaceFlow,
    onPickWorkspaceFolder: workspaceStore.pickWorkspaceFolder,
    onAttachHost: workspaceStore.onAttachHost,
    onConnectClient: workspaceStore.onConnectClient,
    onBackToMode: workspaceStore.onBackToMode,
    onSetAuthorizedDir: workspaceStore.setNewAuthorizedDir,
    onAddAuthorizedDir: workspaceStore.addAuthorizedDir,
    onAddAuthorizedDirFromPicker: () =>
      workspaceStore.addAuthorizedDirFromPicker({ persistToWorkspace: true }),
    onRemoveAuthorizedDir: workspaceStore.removeAuthorizedDirAtIndex,
    onRefreshEngineDoctor: async () => {
      workspaceStore.setEngineInstallLogs(null);
      await workspaceStore.refreshEngineDoctor();
    },
    onInstallEngine: workspaceStore.onInstallEngine,
    onShowSearchNotes: () => {
      const notes =
        workspaceStore.engineDoctorResult()?.notes?.join("\n") ?? "";
      workspaceStore.setEngineInstallLogs(notes || null);
    },
    onOpenSettings: () => {
      setTab("settings");
      setView("dashboard");
    },
    themeMode: themeMode(),
    setThemeMode,
  });

  const dashboardProps = () => ({
    tab: tab(),
    setTab,
    view: currentView(),
    setView,
    mode: mode(),
    baseUrl: baseUrl(),
    clientConnected: Boolean(client()),
    busy: busy(),
    busyHint: busyHint(),
    busyLabel: busyLabel(),
    newTaskDisabled: newTaskDisabled(),
    headerStatus: headerStatus(),
    error: error(),
    activeWorkspaceDisplay: activeWorkspaceDisplay(),
    workspaceSearch: workspaceStore.workspaceSearch(),
    setWorkspaceSearch: workspaceStore.setWorkspaceSearch,
    workspacePickerOpen: workspaceStore.workspacePickerOpen(),
    setWorkspacePickerOpen: workspaceStore.setWorkspacePickerOpen,
    connectingWorkspaceId: workspaceStore.connectingWorkspaceId(),
    workspaces: workspaceStore.workspaces(),
    filteredWorkspaces: workspaceStore.filteredWorkspaces(),
    activeWorkspaceId: workspaceStore.activeWorkspaceId(),
    activateWorkspace: workspaceStore.activateWorkspace,
    createWorkspaceOpen: workspaceStore.createWorkspaceOpen(),
    setCreateWorkspaceOpen: workspaceStore.setCreateWorkspaceOpen,
    createWorkspaceFlow: workspaceStore.createWorkspaceFlow,
    pickWorkspaceFolder: workspaceStore.pickWorkspaceFolder,
    sessions: activeSessions().map((s) => ({
      id: s.id,
      slug: s.slug,
      title: s.title,
      time: s.time,
      directory: s.directory,
    })),
    sessionStatusById: activeSessionStatusById(),
    activeWorkspaceRoot: isDemoMode()
      ? demoActiveWorkspaceDisplay().path
      : workspaceStore.activeWorkspaceRoot().trim(),
    workspaceCommands: workspaceCommands(),
    globalCommands: globalCommands(),
    otherCommands: otherCommands(),
    setCommandDraftName,
    setCommandDraftDescription,
    setCommandDraftTemplate,
    setCommandDraftScope,
    resetCommandDraft: (scope: "workspace" | "global" = "workspace") => {
      setCommandDraftName("");
      setCommandDraftDescription("");
      setCommandDraftTemplate("");
      setCommandDraftScope(scope);
    },
    openCommandModal,
    runCommand: openRunModal,
    deleteCommand,
    justSavedCommand: justSavedCommand(),
    clearJustSavedCommand,
    refreshSkills: (options?: { force?: boolean }) => refreshSkills(options).catch(() => undefined),
    refreshPlugins: (scopeOverride?: PluginScope) =>
      refreshPlugins(scopeOverride).catch(() => undefined),
    skills: skills(),
    skillsStatus: skillsStatus(),
    importLocalSkill,
    installSkillCreator,
    revealSkillsFolder,
    uninstallSkill,
    pluginScope: pluginScope(),
    setPluginScope,
    pluginConfigPath: pluginConfig()?.path ?? null,
    pluginList: pluginList(),
    pluginInput: pluginInput(),
    setPluginInput,
    pluginStatus: pluginStatus(),
    activePluginGuide: activePluginGuide(),
    setActivePluginGuide,
    isPluginInstalled: isPluginInstalledByName,
    suggestedPlugins: SUGGESTED_PLUGINS,
    addPlugin,
    createSessionAndOpen,
    setPrompt,
    selectSession: isDemoMode() ? selectDemoSession : selectSession,
    defaultModelLabel: formatModelLabel(defaultModel(), providers()),
    defaultModelRef: formatModelRef(defaultModel()),
    openDefaultModelPicker,
    showThinking: showThinking(),
    toggleShowThinking: () => setShowThinking((v) => !v),
    modelVariantLabel: formatModelVariantLabel(modelVariant()),
    keybindItems: keybindSettings(),
    onOverrideKeybind: updateKeybindOverride,
    onResetKeybind: resetKeybindOverride,
    onResetAllKeybinds: resetAllKeybinds,
    editModelVariant: handleEditModelVariant,
    demoMode: demoMode(),
    toggleDemoMode: () => setDemoMode((v) => !v),
    demoSequence: demoSequence(),
    setDemoSequence,
    updateAutoCheck: updateAutoCheck(),
    toggleUpdateAutoCheck: () => setUpdateAutoCheck((v) => !v),
    updateStatus: updateStatus(),
    updateEnv: updateEnv(),
    appVersion: appVersion(),
    checkForUpdates: () => checkForUpdates(),
    downloadUpdate: () => downloadUpdate(),
    installUpdateAndRestart,
    anyActiveRuns: anyActiveRuns(),
    engineSource: engineSource(),
    setEngineSource,
    isWindows: isWindowsPlatform(),
    toggleDeveloperMode: () => setDeveloperMode((v) => !v),
    developerMode: developerMode(),
    stopHost,
    openResetModal,
    resetModalBusy: resetModalBusy(),
    onResetStartupPreference: () => clearModePreference(),
    themeMode: themeMode(),
    setThemeMode,
    pendingPermissions: pendingPermissions(),
    events: events(),
    safeStringify,
    repairOpencodeCache,
    cacheRepairBusy: cacheRepairBusy(),
    cacheRepairResult: cacheRepairResult(),
    notionStatus: notionStatus(),
    notionStatusDetail: notionStatusDetail(),
    notionError: notionError(),
    notionBusy: notionBusy(),
    connectNotion,
    mcpServers: mcpServers(),
    mcpStatus: mcpStatus(),
    mcpLastUpdatedAt: mcpLastUpdatedAt(),
    mcpStatuses: mcpStatuses(),
    mcpConnectingName: mcpConnectingName(),
    selectedMcp: selectedMcp(),
    setSelectedMcp,
    quickConnect: MCP_QUICK_CONNECT,
    connectMcp,
    refreshMcpServers,
    showMcpReloadBanner: reloadRequired() && reloadReasons().includes("mcp"),
    mcpReloadBlocked: anyActiveRuns(),
    reloadMcpEngine: () => reloadWorkspaceEngine(),
    language: currentLocale(),
    setLanguage: setLocale,
  });

  const searchWorkspaceFiles = async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return [];
    if (isDemoMode()) {
      const lower = trimmed.toLowerCase();
      return activeWorkingFiles().filter((file) => file.toLowerCase().includes(lower));
    }
    const activeClient = client();
    if (!activeClient) return [];
    try {
      const directory = workspaceProjectDir().trim();
      const result = unwrap(
        await activeClient.find.files({
          query: trimmed,
          dirs: "true",
          limit: 50,
          directory: directory || undefined,
        }),
      );
      return result;
    } catch {
      return [];
    }
  };


  const sessionProps = () => ({
    selectedSessionId: activeSessionId(),
    setView,
    setTab,
    activeWorkspaceDisplay: activeWorkspaceDisplay(),
    setWorkspaceSearch: workspaceStore.setWorkspaceSearch,
    setWorkspacePickerOpen: workspaceStore.setWorkspacePickerOpen,
    headerStatus: headerStatus(),
    busyHint: busyHint(),
    selectedSessionModelLabel: selectedSessionModelLabel(),
    openSessionModelPicker: openSessionModelPicker,
    modelVariantLabel: formatModelVariantLabel(modelVariant()),
    modelVariant: modelVariant(),
    setModelVariant: (value: string) => setModelVariant(value),
    activePlugins: sidebarPluginList(),
    activePluginStatus: sidebarPluginStatus(),
    mcpServers: mcpServers(),
    mcpStatuses: mcpStatuses(),
    mcpStatus: mcpStatus(),
    skills: skills(),
    skillsStatus: skillsStatus(),
    createSessionAndOpen: createSessionAndOpen,
    sendPromptAsync: sendPrompt,
    newTaskDisabled: newTaskDisabled(),
    sessions: activeSessions().map((session) => ({
      id: session.id,
      title: session.title,
      slug: session.slug,
    })),
    selectSession: isDemoMode() ? selectDemoSession : selectSession,
    messages: activeMessages(),
    todos: activeTodos(),
    busyLabel: busyLabel(),
    developerMode: developerMode(),
    showThinking: showThinking(),
    groupMessageParts,
    summarizeStep,
    expandedStepIds: expandedStepIds(),
    setExpandedStepIds: setExpandedStepIds,
    expandedSidebarSections: expandedSidebarSections(),
    setExpandedSidebarSections: setExpandedSidebarSections,
    artifacts: activeArtifacts(),
    workingFiles: activeWorkingFiles(),
    authorizedDirs: activeAuthorizedDirs(),
    busy: busy(),
    prompt: prompt(),
    setPrompt: setPrompt,
    activePermission: activePermissionMemo(),
    permissionReplyBusy: permissionReplyBusy(),
    respondPermission: respondPermission,
    respondPermissionAndRemember: respondPermissionAndRemember,
    safeStringify: safeStringify,
    showTryNotionPrompt: tryNotionPromptVisible() && notionIsActive(),
    openConnect: openConnectFlow,
    startProviderAuth: startProviderAuth,
    openProviderAuthModal: openProviderAuthModal,
    closeProviderAuthModal: closeProviderAuthModal,
    providerAuthModalOpen: providerAuthModalOpen(),
    providerAuthBusy: providerAuthBusy(),
    providerAuthError: providerAuthError(),
    providerAuthMethods: providerAuthMethods(),
    providers: providers(),
    providerConnectedIds: providerConnectedIds(),
    listAgents: listAgents,
    selectedSessionAgent: selectedSessionAgent(),
    setSessionAgent: setSessionAgent,
    saveSession: saveSessionExport,
    sessionStatusById: activeSessionStatusById(),
    commands: commands(),
    runCommand: runCommand,
    openCommandRunModal: openRunModal,
    commandRegistryItems,
    registerCommand: commandRegistry.registerCommand,
    searchFiles: searchWorkspaceFiles,
    onTryNotionPrompt: () => {
      setPrompt("setup my crm");
      setTryNotionPromptVisible(false);
      setNotionSkillInstalled(true);
      try {
        window.localStorage.setItem("openwork.notionSkillInstalled", "1");
      } catch {
        // ignore
      }
    },
    sessionStatus: selectedSessionStatus(),
    renameSession: renameSessionTitle,
    error: error(),
  });

  const dashboardTabs = new Set<DashboardTab>([
    "home",
    "sessions",
    "commands",
    "skills",
    "plugins",
    "mcp",
    "settings",
  ]);

  const resolveDashboardTab = (value?: string | null) => {
    const normalized = value?.trim().toLowerCase() ?? "";
    if (dashboardTabs.has(normalized as DashboardTab)) {
      return normalized as DashboardTab;
    }
    return "home";
  };

  const initialRoute = () => {
    if (typeof window === "undefined") return "/onboarding";
    try {
      return window.localStorage.getItem("openwork.onboardingComplete") === "1"
        ? "/dashboard/home"
        : "/onboarding";
    } catch {
      return "/onboarding";
    }
  };

  createEffect(() => {
    const rawPath = location.pathname.trim();
    const path = rawPath.toLowerCase();

    if (path === "" || path === "/") {
      navigate(initialRoute(), { replace: true });
      return;
    }

    if (path.startsWith("/dashboard")) {
      const [, , tabSegment] = path.split("/");
      const resolvedTab = resolveDashboardTab(tabSegment);

      if (resolvedTab !== tab()) {
        setTabState(resolvedTab);
      }
      if (!tabSegment || tabSegment !== resolvedTab) {
        goToDashboard(resolvedTab, { replace: true });
      }
      return;
    }

    if (path.startsWith("/session")) {
      const [, , sessionSegment] = rawPath.split("/");
      const id = (sessionSegment ?? "").trim();

      if (!id) {
        const fallback = activeSessionId();
        if (fallback) {
          goToSession(fallback, { replace: true });
        } else {
          goToDashboard("sessions", { replace: true });
        }
        return;
      }

      if (isDemoMode()) {
        if (activeSessionId() !== id) {
          selectDemoSession(id);
        }
        return;
      }

      if (selectedSessionId() !== id) {
        void selectSession(id);
      }
      return;
    }

    if (path.startsWith("/onboarding")) {
      return;
    }

    navigate("/dashboard/home", { replace: true });
  });

  return (
    <>
      <Switch>
        <Match when={currentView() === "onboarding"}>
          <OnboardingView {...onboardingProps()} />
        </Match>
        <Match when={currentView() === "session"}>
          <SessionView {...sessionProps()} />
        </Match>
        <Match when={true}>
          <DashboardView {...dashboardProps()} />
        </Match>
      </Switch>

      <WorkspaceSwitchOverlay
        open={workspaceSwitchOpen()}
        workspace={workspaceSwitchWorkspace()}
        statusKey={workspaceSwitchStatusKey()}
      />

      <ModelPickerModal
        open={modelPickerOpen()}
        options={modelOptions()}
        filteredOptions={filteredModelOptions()}
        query={modelPickerQuery()}
        setQuery={setModelPickerQuery}
        target={modelPickerTarget()}
        current={modelPickerCurrent()}
        onSelect={applyModelSelection}
        onClose={() => setModelPickerOpen(false)}
      />

      <ResetModal
        open={resetModalOpen()}
        mode={resetModalMode()}
        text={resetModalText()}
        busy={resetModalBusy()}
        canReset={
          !resetModalBusy() &&
          !anyActiveRuns() &&
          resetModalText().trim().toUpperCase() === "RESET"
        }
        hasActiveRuns={anyActiveRuns()}
        language={currentLocale()}
        onClose={() => setResetModalOpen(false)}
        onConfirm={confirmReset}
        onTextChange={setResetModalText}
      />

      <McpAuthModal
        open={mcpAuthModalOpen()}
        client={client()}
        entry={mcpAuthEntry()}
        projectDir={workspaceProjectDir()}
        language={currentLocale()}
        reloadRequired={reloadRequired() && reloadReasons().includes("mcp")}
        reloadBlocked={anyActiveRuns()}
        isRemoteWorkspace={activeWorkspaceDisplay().workspaceType === "remote"}
        onClose={() => {
          setMcpAuthModalOpen(false);
          setMcpAuthEntry(null);
        }}
        onComplete={async () => {
          setMcpAuthModalOpen(false);
          setMcpAuthEntry(null);
          await refreshMcpServers();
        }}
        onReloadEngine={() => reloadWorkspaceEngine()}
      />

      <CommandModal
        open={commandModalOpen()}
        name={commandDraftName()}
        description={commandDraftDescription()}
        template={commandDraftTemplate()}
        scope={commandDraftScope()}
        onClose={() => setCommandModalOpen(false)}
        onSave={saveCommand}
        onNameChange={setCommandDraftName}
        onDescriptionChange={setCommandDraftDescription}
        onTemplateChange={setCommandDraftTemplate}
        onScopeChange={setCommandDraftScope}
      />

      <CommandRunModal
        open={runModalOpen()}
        command={runModalCommand()}
        details={runModalDetails()}
        onDetailsChange={setRunModalDetails}
        onClose={closeRunModal}
        onRun={confirmRunModal}
      />

      <CommandPaletteModal
        open={commandPaletteOpen()}
        mode={commandPaletteMode()}
        query={commandPaletteQuery()}
        setQuery={setCommandPaletteQuery}
        groups={commandPaletteGroups()}
        onClose={closeCommandPalette}
      />

      <ReloadWorkspaceToast
        open={reloadToastVisible()}
        title={t("reload.toast_title", currentLocale())}
        description={t("reload.toast_description", currentLocale())}
        warning={reloadWarning()}
        blockedReason={reloadBlockedReason()}
        error={reloadError()}
        reloadLabel={reloadActionLabel()}
        dismissLabel={t("reload.toast_dismiss", currentLocale())}
        busy={reloadBusy()}
        canReload={canReloadEngine()}
        hasActiveRuns={anyActiveRuns()}
        onReload={() => reloadWorkspaceEngine()}
        onDismiss={() => setReloadToastDismissedAt(Date.now())}
      />

      <WorkspacePicker
        open={workspaceStore.workspacePickerOpen()}
        workspaces={workspaceStore.workspaces()}
        activeWorkspaceId={workspaceStore.activeWorkspaceId()}
        search={workspaceStore.workspaceSearch()}
        onSearch={workspaceStore.setWorkspaceSearch}
        onClose={() => workspaceStore.setWorkspacePickerOpen(false)}
        onSelect={workspaceStore.activateWorkspace}
        onCreateLocal={() => workspaceStore.setCreateWorkspaceOpen(true)}
        onCreateRemote={() => workspaceStore.setCreateRemoteWorkspaceOpen(true)}
        onForget={workspaceStore.forgetWorkspace}
        connectingWorkspaceId={workspaceStore.connectingWorkspaceId()}
      />

      <CreateWorkspaceModal
        open={workspaceStore.createWorkspaceOpen()}
        onClose={() => workspaceStore.setCreateWorkspaceOpen(false)}
        onPickFolder={workspaceStore.pickWorkspaceFolder}
        onConfirm={(preset, folder) =>
          workspaceStore.createWorkspaceFlow(preset, folder)
        }
        submitting={busy() && busyLabel() === "status.creating_workspace"}
      />

      <CreateRemoteWorkspaceModal
        open={workspaceStore.createRemoteWorkspaceOpen()}
        onClose={() => workspaceStore.setCreateRemoteWorkspaceOpen(false)}
        onConfirm={(input) => workspaceStore.createRemoteWorkspaceFlow(input)}
        submitting={
          busy() &&
          (busyLabel() === "status.creating_workspace" || busyLabel() === "status.connecting")
        }
      />
    </>
  );
}
