import {
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { applyEdits, modify } from "jsonc-parser";

import type { Provider } from "@opencode-ai/sdk/v2/client";

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

import ModelPickerModal from "./components/ModelPickerModal";
import ResetModal from "./components/ResetModal";
import TemplateModal from "./components/TemplateModal";
import OnboardingView from "./views/OnboardingView";
import DashboardView from "./views/DashboardView";
import SessionView from "./views/SessionView";
import { createClient, unwrap, waitForHealthy } from "./lib/opencode";
import {
  CURATED_PACKAGES,
  DEFAULT_MODEL,
  MODEL_PREF_KEY,
  SUGGESTED_PLUGINS,
  THINKING_PREF_KEY,
  VARIANT_PREF_KEY,
} from "./app/constants";
import type {
  Client,
  CuratedPackage,
  DashboardTab,
  Mode,
  ModelOption,
  ModelRef,
  OnboardingStep,
  PluginScope,
  ReloadReason,
  ResetOpenworkMode,
  SkillCard,
  View,
  WorkspaceDisplay,
  WorkspaceOpenworkConfig,
  WorkspacePreset,
  WorkspaceTemplate,
  UpdateHandle,
} from "./app/types";
import {
  clearModePreference,
  deriveArtifacts,
  deriveWorkingFiles,
  formatBytes,
  formatModelLabel,
  formatModelRef,
  formatRelativeTime,
  groupMessageParts,
  isTauriRuntime,
  isWindowsPlatform,
  lastUserModelFromMessages,
  parseModelRef,
  readModePreference,
  safeParseJson,
  safeStringify,
  summarizeStep,
  templatePathFromWorkspaceRoot,
  writeModePreference,
} from "./app/utils";
import { buildTemplateDraft, createTemplateRecord, resetTemplateDraft } from "./app/templates";
import { createUpdaterState } from "./app/updater";
import { createSessionStore } from "./app/session";
import {
  isPluginInstalled,
  loadPluginsFromConfig as loadPluginsFromConfigHelpers,
  parsePluginListFromContent,
  stripPluginVersion,
} from "./app/plugins";
import {
  engineDoctor,
  engineInfo,
  engineInstall,
  engineStart,
  engineStop,
  importSkill,
  opkgInstall,
  pickDirectory,
  readOpencodeConfig,
  updaterEnvironment,

  workspaceBootstrap,
  workspaceCreate,
  workspaceSetActive,
  workspaceOpenworkRead,
  workspaceOpenworkWrite,
  workspaceTemplateDelete,
  workspaceTemplateWrite,
  writeOpencodeConfig,
  resetOpenworkState,
  type EngineDoctorResult,
  type EngineInfo,
  type OpencodeConfigFile,
  type WorkspaceInfo,
} from "./lib/tauri";


export default function App() {
  const [view, setView] = createSignal<View>("onboarding");
  const [mode, setMode] = createSignal<Mode | null>(null);
  const [onboardingStep, setOnboardingStep] = createSignal<OnboardingStep>("mode");
  const [rememberModeChoice, setRememberModeChoice] = createSignal(false);
  const [tab, setTab] = createSignal<DashboardTab>("home");

  const [engine, setEngine] = createSignal<EngineInfo | null>(null);
  const [engineDoctorResult, setEngineDoctorResult] = createSignal<EngineDoctorResult | null>(null);
  const [engineDoctorCheckedAt, setEngineDoctorCheckedAt] = createSignal<number | null>(null);
  const [engineInstallLogs, setEngineInstallLogs] = createSignal<string | null>(null);
  const [engineSource, setEngineSource] = createSignal<"path" | "sidecar">("path");

  const [projectDir, setProjectDir] = createSignal("");

  const [workspaces, setWorkspaces] = createSignal<WorkspaceInfo[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = createSignal<string>("starter");

  const [authorizedDirs, setAuthorizedDirs] = createSignal<string[]>([]);
  const [newAuthorizedDir, setNewAuthorizedDir] = createSignal("");

  const [workspaceConfig, setWorkspaceConfig] = createSignal<WorkspaceOpenworkConfig | null>(null);
  const [workspaceConfigLoaded, setWorkspaceConfigLoaded] = createSignal(false);
  const [workspaceSearch, setWorkspaceSearch] = createSignal("");
  const [workspacePickerOpen, setWorkspacePickerOpen] = createSignal(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = createSignal(false);

  const [baseUrl, setBaseUrl] = createSignal("http://127.0.0.1:4096");
  const [clientDirectory, setClientDirectory] = createSignal("");

  const [client, setClient] = createSignal<Client | null>(null);
  const [connectedVersion, setConnectedVersion] = createSignal<string | null>(null);
  const [sseConnected, setSseConnected] = createSignal(false);

  const [busy, setBusy] = createSignal(false);
  const [busyLabel, setBusyLabel] = createSignal<string | null>(null);
  const [busyStartedAt, setBusyStartedAt] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [developerMode, setDeveloperMode] = createSignal(false);

  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null);
  const [sessionModelOverrideById, setSessionModelOverrideById] = createSignal<Record<string, ModelRef>>({});
  const [sessionModelById, setSessionModelById] = createSignal<Record<string, ModelRef>>({});

  const sessionStore = createSessionStore({
    client,
    selectedSessionId,
    setSelectedSessionId,
    sessionModelState: () => ({ overrides: sessionModelOverrideById(), resolved: sessionModelById() }),
    setSessionModelState: (updater) => {
      const next = updater({ overrides: sessionModelOverrideById(), resolved: sessionModelById() });
      setSessionModelOverrideById(next.overrides);
      setSessionModelById(next.resolved);
      return next;
    },
    lastUserModelFromMessages,
    developerMode,
    setError,
    setSseConnected,
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
    respondPermission,
    setSessions,
    setSessionStatusById,
    setMessages,
    setTodos,
    setPendingPermissions,
  } = sessionStore;

  const artifacts = createMemo(() => deriveArtifacts(messages()));
  const workingFiles = createMemo(() => deriveWorkingFiles(artifacts()));

  const [prompt, setPrompt] = createSignal("");
  const [lastPromptSent, setLastPromptSent] = createSignal("");

  async function sendPrompt() {
    const c = client();
    const sessionID = selectedSessionId();
    if (!c || !sessionID) return;

    const content = prompt().trim();
    if (!content) return;

    setBusy(true);
    setBusyLabel("Running");
    setBusyStartedAt(Date.now());
    setError(null);

    try {
      setLastPromptSent(content);
      setPrompt("");

      const model = selectedSessionModel();

      await c.session.promptAsync({
        sessionID,
        model,
        variant: modelVariant() ?? undefined,
        parts: [{ type: "text", text: content }],
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

      await loadSessions(activeWorkspaceRoot().trim()).catch(() => undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setBusy(false);
      setBusyLabel(null);
      setBusyStartedAt(null);
    }
  }

  const [templates, setTemplates] = createSignal<WorkspaceTemplate[]>([]);
  const [workspaceTemplatesLoaded, setWorkspaceTemplatesLoaded] = createSignal(false);
  const [globalTemplatesLoaded, setGlobalTemplatesLoaded] = createSignal(false);

  const [templateModalOpen, setTemplateModalOpen] = createSignal(false);
  const [templateDraftTitle, setTemplateDraftTitle] = createSignal("");
  const [templateDraftDescription, setTemplateDraftDescription] = createSignal("");
  const [templateDraftPrompt, setTemplateDraftPrompt] = createSignal("");
  const [templateDraftScope, setTemplateDraftScope] = createSignal<"workspace" | "global">("workspace");

  const workspaceTemplates = createMemo(() => templates().filter((t) => t.scope === "workspace"));
  const globalTemplates = createMemo(() => templates().filter((t) => t.scope === "global"));

  function openTemplateModal() {
    const seedTitle = selectedSession()?.title ?? "";
    const seedPrompt = lastPromptSent() || prompt();
    const nextDraft = buildTemplateDraft({ seedTitle, seedPrompt, scope: "workspace" });

    resetTemplateDraft(
      {
        setTitle: setTemplateDraftTitle,
        setDescription: setTemplateDraftDescription,
        setPrompt: setTemplateDraftPrompt,
        setScope: setTemplateDraftScope,
      },
      nextDraft.scope,
    );

    setTemplateDraftTitle(nextDraft.title);
    setTemplateDraftPrompt(nextDraft.prompt);
    setTemplateModalOpen(true);
  }

  async function saveTemplate() {
    const draft = buildTemplateDraft({
      scope: templateDraftScope(),
    });
    draft.title = templateDraftTitle().trim();
    draft.description = templateDraftDescription().trim();
    draft.prompt = templateDraftPrompt().trim();

    if (!draft.title || !draft.prompt) {
      setError("Template title and prompt are required.");
      return;
    }

    if (draft.scope === "workspace") {
      if (!isTauriRuntime()) {
        setError("Workspace templates require the desktop app.");
        return;
      }
      if (!activeWorkspacePath().trim()) {
        setError("Pick a workspace folder first.");
        return;
      }
    }

    setBusy(true);
    setBusyLabel(draft.scope === "workspace" ? "Saving workspace template" : "Saving template");
    setBusyStartedAt(Date.now());
    setError(null);

    try {
      const template = createTemplateRecord(draft);

      if (draft.scope === "workspace") {
        const workspaceRoot = activeWorkspacePath().trim();
        await workspaceTemplateWrite({ workspacePath: workspaceRoot, template });
        await loadWorkspaceTemplates({ workspaceRoot, quiet: true });
      } else {
        setTemplates((current) => [template, ...current]);
        setGlobalTemplatesLoaded(true);
      }

      setTemplateModalOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setBusy(false);
      setBusyLabel(null);
      setBusyStartedAt(null);
    }
  }

  async function deleteTemplate(templateId: string) {
    const scope = templates().find((t) => t.id === templateId)?.scope;

    if (scope === "workspace") {
      if (!isTauriRuntime()) return;
      const workspaceRoot = activeWorkspacePath().trim();
      if (!workspaceRoot) return;

      setBusy(true);
      setBusyLabel("Deleting template");
      setBusyStartedAt(Date.now());
      setError(null);

      try {
        await workspaceTemplateDelete({ workspacePath: workspaceRoot, templateId });
        await loadWorkspaceTemplates({ workspaceRoot, quiet: true });
      } catch (e) {
        setError(e instanceof Error ? e.message : safeStringify(e));
      } finally {
        setBusy(false);
        setBusyLabel(null);
        setBusyStartedAt(null);
      }

      return;
    }

    setTemplates((current) => current.filter((t) => t.id !== templateId));
    setGlobalTemplatesLoaded(true);
  }

  async function runTemplate(template: WorkspaceTemplate) {
    const c = client();
    if (!c) return;

    setBusy(true);
    setError(null);

    try {
      const session = unwrap(
        await c.session.create({ title: template.title, directory: activeWorkspaceRoot().trim() }),
      );
      await loadSessions(activeWorkspaceRoot().trim());
      await selectSession(session.id);
      setView("session");

      const model = defaultModel();

      await c.session.promptAsync({
        sessionID: session.id,
        model,
        variant: modelVariant() ?? undefined,
        parts: [{ type: "text", text: template.prompt }],
      });

      setSessionModelById((current) => ({
        ...current,
        [session.id]: model,
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }


  const [skills, setSkills] = createSignal<SkillCard[]>([]);
  const [skillsStatus, setSkillsStatus] = createSignal<string | null>(null);

  async function respondPermissionAndRemember(requestID: string, reply: "once" | "always" | "reject") {
    // Intentional no-op: permission prompts grant session-scoped access only.
    // Persistent workspace roots must be managed explicitly via workspace settings.
    await respondPermission(requestID, reply);
  }
  const [openPackageSource, setOpenPackageSource] = createSignal("");
  const [packageSearch, setPackageSearch] = createSignal("");

  const [pluginScope, setPluginScope] = createSignal<PluginScope>("project");
  const [pluginConfig, setPluginConfig] = createSignal<OpencodeConfigFile | null>(null);
  const [pluginList, setPluginList] = createSignal<string[]>([]);
  const [pluginInput, setPluginInput] = createSignal("");
  const [pluginStatus, setPluginStatus] = createSignal<string | null>(null);
  const [activePluginGuide, setActivePluginGuide] = createSignal<string | null>(null);

  const [sidebarPluginList, setSidebarPluginList] = createSignal<string[]>([]);
  const [sidebarPluginStatus, setSidebarPluginStatus] = createSignal<string | null>(null);

  const [reloadRequired, setReloadRequired] = createSignal(false);
  const [reloadReasons, setReloadReasons] = createSignal<ReloadReason[]>([]);
  const [reloadLastTriggeredAt, setReloadLastTriggeredAt] = createSignal<number | null>(null);
  const [reloadBusy, setReloadBusy] = createSignal(false);
  const [reloadError, setReloadError] = createSignal<string | null>(null);

  const [providers, setProviders] = createSignal<Provider[]>([]);
  const [providerDefaults, setProviderDefaults] = createSignal<Record<string, string>>({});
  const [providerConnectedIds, setProviderConnectedIds] = createSignal<string[]>([]);

  const [defaultModel, setDefaultModel] = createSignal<ModelRef>(DEFAULT_MODEL);
  const [modelPickerOpen, setModelPickerOpen] = createSignal(false);
  const [modelPickerTarget, setModelPickerTarget] = createSignal<"session" | "default">("session");
  const [modelPickerQuery, setModelPickerQuery] = createSignal("");

  const [showThinking, setShowThinking] = createSignal(false);
  const [modelVariant, setModelVariant] = createSignal<string | null>(null);

  const [expandedStepIds, setExpandedStepIds] = createSignal<Set<string>>(new Set());
  const [expandedSidebarSections, setExpandedSidebarSections] = createSignal({
    progress: true,
    artifacts: true,
    context: true,
  });

  const [appVersion, setAppVersion] = createSignal<string | null>(null);

  const updater = createUpdaterState();
  const {
    updateAutoCheck,
    setUpdateAutoCheck,
    updateStatus,
    setUpdateStatus,
    pendingUpdate,
    setPendingUpdate,
    updateEnv,
    setUpdateEnv,
  } = updater;

  const [resetModalOpen, setResetModalOpen] = createSignal(false);
  const [resetModalMode, setResetModalMode] = createSignal<ResetOpenworkMode>("onboarding");
  const [resetModalText, setResetModalText] = createSignal("");
  const [resetModalBusy, setResetModalBusy] = createSignal(false);

  const busySeconds = createMemo(() => {
    const start = busyStartedAt();
    if (!start) return 0;
    return Math.max(0, Math.round((Date.now() - start) / 1000));
  });

  const newTaskDisabled = createMemo(() => {
    const label = busyLabel();
    // Allow creating a new session even while a run is in progress.
    if (busy() && label === "Running") return false;

    // Otherwise, block during engine / connection transitions.
    if (busy() && (label === "Connecting" || label === "Starting engine" || label === "Disconnecting")) {
      return true;
    }

    return busy();
  });

  const filteredPackages = createMemo(() => {
    const query = packageSearch().trim().toLowerCase();
    if (!query) return CURATED_PACKAGES;

    return CURATED_PACKAGES.filter((pkg) => {
      const haystack = [pkg.name, pkg.source, pkg.description, pkg.tags.join(" ")]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  });

  const isPluginInstalledByName = (pluginName: string, aliases: string[] = []) =>
    isPluginInstalled(pluginList(), pluginName, aliases);

  const loadPluginsFromConfig = (config: OpencodeConfigFile | null) => {
    loadPluginsFromConfigHelpers(config, setPluginList, (message) => setPluginStatus(message));
  };


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

  const selectedSessionModelLabel = createMemo(() => formatModelLabel(selectedSessionModel(), providers()));

  const modelPickerCurrent = createMemo(() =>
    modelPickerTarget() === "default" ? defaultModel() : selectedSessionModel(),
  );

  const modelOptions = createMemo<ModelOption[]>(() => {
    const allProviders = providers();
    const defaults = providerDefaults();

    if (!allProviders.length) {
      return [
        {
          providerID: DEFAULT_MODEL.providerID,
          modelID: DEFAULT_MODEL.modelID,
          title: DEFAULT_MODEL.modelID,
          description: DEFAULT_MODEL.providerID,
          footer: "Fallback",
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
      const models = Object.values(provider.models ?? {}).filter((m) => m.status !== "deprecated");

      models.sort((a, b) => {
        const aFree = a.cost?.input === 0 && a.cost?.output === 0;
        const bFree = b.cost?.input === 0 && b.cost?.output === 0;
        if (aFree !== bFree) return aFree ? -1 : 1;
        return (a.name ?? a.id).localeCompare(b.name ?? b.id);
      });

      for (const model of models) {
        const isFree = model.cost?.input === 0 && model.cost?.output === 0;
        const footerBits: string[] = [];
        if (defaultModelID === model.id) footerBits.push("Default");
        if (isFree) footerBits.push("Free");
        if (model.capabilities?.reasoning) footerBits.push("Reasoning");

        next.push({
          providerID: provider.id,
          modelID: model.id,
          title: model.name ?? model.id,
          description: provider.name,
          footer: footerBits.length ? footerBits.slice(0, 2).join(" · ") : undefined,
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
    setModelPickerOpen(false);
  }


  async function refreshEngine() {
    if (!isTauriRuntime()) return;

    try {
      const info = await engineInfo();
      setEngine(info);

      if (info.projectDir) {
        setProjectDir(info.projectDir);
      }
      if (info.baseUrl) {
        setBaseUrl(info.baseUrl);
      }
    } catch {
      // ignore
    }
  }

  function anyActiveRuns() {
    const statuses = sessionStatusById();
    return sessions().some((s) => statuses[s.id] === "running" || statuses[s.id] === "retry");
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

  function openResetModal(mode: ResetOpenworkMode) {
    if (anyActiveRuns()) {
      setError("Stop active runs before resetting.");
      return;
    }

    setError(null);
    setResetModalMode(mode);
    setResetModalText("");
    setResetModalOpen(true);
  }

  async function confirmReset() {
    if (resetModalBusy()) return;

    if (anyActiveRuns()) {
      setError("Stop active runs before resetting.");
      return;
    }

    if (resetModalText().trim().toUpperCase() !== "RESET") return;

    setResetModalBusy(true);
    setError(null);

    try {
      if (isTauriRuntime()) {
        await resetOpenworkState(resetModalMode());
      }

      clearOpenworkLocalStorage();

      if (isTauriRuntime()) {
        await relaunch();
      } else {
        window.location.reload();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : safeStringify(e));
      setResetModalBusy(false);
    }
  }

  function markReloadRequired(reason: ReloadReason) {
    setReloadRequired(true);
    setReloadLastTriggeredAt(Date.now());
    setReloadReasons((current) => (current.includes(reason) ? current : [...current, reason]));
  }

  function clearReloadRequired() {
    setReloadRequired(false);
    setReloadReasons([]);
    setReloadError(null);
  }

  const reloadCopy = createMemo(() => {
    const reasons = reloadReasons();
    if (!reasons.length) {
      return {
        title: "Reload required",
        body: "OpenWork detected changes that require reloading the OpenCode instance.",
      };
    }

    if (reasons.length === 1 && reasons[0] === "plugins") {
      return {
        title: "Reload required",
        body: "OpenCode loads npm plugins at startup. Reload the engine to apply opencode.json changes.",
      };
    }

    if (reasons.length === 1 && reasons[0] === "skills") {
      return {
        title: "Reload required",
        body: "OpenCode can cache skill discovery/state. Reload the engine to make newly installed skills available.",
      };
    }

    return {
      title: "Reload required",
      body: "OpenWork detected plugin/skill changes. Reload the engine to apply them.",
    };
  });

  const canReloadEngine = createMemo(() => {
    if (!reloadRequired()) return false;
    if (!client()) return false;
    if (reloadBusy()) return false;
    if (anyActiveRuns()) return false;
    if (mode() !== "host") return false;
    return true;
  });

  // Keep this mounted so the reload banner UX remains in the app.
  createEffect(() => {
    reloadRequired();
  });

  async function reloadEngineInstance() {
    const c = client();
    if (!c) return;

    if (mode() !== "host") {
      setReloadError("Reload is only available in Host mode.");
      return;
    }

    if (anyActiveRuns()) {
      setReloadError("A run is in progress. Stop it before reloading the engine.");
      return;
    }

    setReloadBusy(true);
    setReloadError(null);

    try {
      unwrap(await c.instance.dispose());
      await waitForHealthy(c, { timeoutMs: 12_000 });

      try {
        const providerList = unwrap(await c.provider.list());
        setProviders(providerList.all as unknown as Provider[]);
        setProviderDefaults(providerList.default);
        setProviderConnectedIds(providerList.connected);
      } catch {
        try {
          const cfg = unwrap(await c.config.providers());
          setProviders(cfg.providers);
          setProviderDefaults(cfg.default);
          setProviderConnectedIds([]);
        } catch {
          setProviders([]);
          setProviderDefaults({});
          setProviderConnectedIds([]);
        }
      }

      await refreshPlugins().catch(() => undefined);
      await refreshSkills().catch(() => undefined);

      clearReloadRequired();
    } catch (e) {
      setReloadError(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setReloadBusy(false);
    }
  }

  async function checkForUpdates(options?: { quiet?: boolean }) {
    if (!isTauriRuntime()) return;

    const env = updateEnv();
    if (env && !env.supported) {
      if (!options?.quiet) {
        setUpdateStatus({
          state: "error",
          lastCheckedAt:
            updateStatus().state === "idle"
              ? (updateStatus() as { state: "idle"; lastCheckedAt: number | null }).lastCheckedAt
              : null,
          message: env.reason ?? "Updates are not supported in this environment.",
        });
      }
      return;
    }

    const prev = updateStatus();
    setUpdateStatus({ state: "checking", startedAt: Date.now() });

    try {
      const update = (await check({
        timeout: 8_000,
      })) as unknown as UpdateHandle | null;
      const checkedAt = Date.now();

      if (!update) {
        setPendingUpdate(null);
        setUpdateStatus({ state: "idle", lastCheckedAt: checkedAt });
        return;
      }

      const notes = typeof update.body === "string" ? update.body : undefined;
      setPendingUpdate({ update, version: update.version, notes });
      setUpdateStatus({
        state: "available",
        lastCheckedAt: checkedAt,
        version: update.version,
        date: update.date,
        notes,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);

      if (options?.quiet) {
        setUpdateStatus(prev);
        return;
      }

      setPendingUpdate(null);
      setUpdateStatus({ state: "error", lastCheckedAt: null, message });
    }
  }

  async function downloadUpdate() {
    const pending = pendingUpdate();
    if (!pending) return;

    setError(null);

    const state = updateStatus();
    const lastCheckedAt = state.state === "available" ? state.lastCheckedAt : Date.now();

    setUpdateStatus({
      state: "downloading",
      lastCheckedAt,
      version: pending.version,
      totalBytes: null,
      downloadedBytes: 0,
      notes: pending.notes,
    });

    try {
      await pending.update.download((event: any) => {
        if (!event || typeof event !== "object") return;
        const record = event as Record<string, any>;

        setUpdateStatus((current) => {
          if (current.state !== "downloading") return current;

          if (record.event === "Started") {
            const total =
              record.data && typeof record.data.contentLength === "number" ? record.data.contentLength : null;
            return { ...current, totalBytes: total };
          }

          if (record.event === "Progress") {
            const chunk =
              record.data && typeof record.data.chunkLength === "number" ? record.data.chunkLength : 0;
            return { ...current, downloadedBytes: current.downloadedBytes + chunk };
          }

          return current;
        });
      });

      setUpdateStatus({
        state: "ready",
        lastCheckedAt,
        version: pending.version,
        notes: pending.notes,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      setUpdateStatus({ state: "error", lastCheckedAt, message });
    }
  }

  async function installUpdateAndRestart() {
    const pending = pendingUpdate();
    if (!pending) return;

    if (anyActiveRuns()) {
      setError("Stop active runs before installing an update.");
      return;
    }

    setError(null);
    try {
      await pending.update.install();
      await pending.update.close();
      await relaunch();
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      setUpdateStatus({ state: "error", lastCheckedAt: null, message });
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

    setActiveWorkspaceId(id);
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
        setAuthorizedDirs((current) => {
          const merged = current.length ? current.slice() : [];
          if (!merged.includes(next.path)) merged.push(next.path);
          return merged;
        });
      }
    }

    await loadWorkspaceTemplates({ workspaceRoot: next.path }).catch(() => undefined);

    if (mode() === "host" && engine()?.running && engine()?.baseUrl) {
      return;
    }
  }

  async function connectToServer(nextBaseUrl: string, directory?: string) {
    setError(null);
    setBusy(true);
    setBusyLabel("Connecting");
    setBusyStartedAt(Date.now());
    setSseConnected(false);

    try {
      const nextClient = createClient(nextBaseUrl, directory);
      const health = await waitForHealthy(nextClient, { timeoutMs: 12_000 });

      setClient(nextClient);
      setConnectedVersion(health.version);
      setBaseUrl(nextBaseUrl);

      await loadSessions(activeWorkspaceRoot().trim());
      await refreshPendingPermissions();

      try {
        const providerList = unwrap(await nextClient.provider.list());
        setProviders(providerList.all as unknown as Provider[]);
        setProviderDefaults(providerList.default);
        setProviderConnectedIds(providerList.connected);
      } catch {
        // Backwards compatibility: older servers may not support provider.list
        try {
          const cfg = unwrap(await nextClient.config.providers());
          setProviders(cfg.providers);
          setProviderDefaults(cfg.default);
          setProviderConnectedIds([]);
        } catch {
          setProviders([]);
          setProviderDefaults({});
          setProviderConnectedIds([]);
        }
      }

      setSelectedSessionId(null);
      setMessages([]);
      setTodos([]);
      setPendingPermissions([]);
      setSessionStatusById({});

      // Auto-create a first-run onboarding session in the active workspace.
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
              model: defaultModel(),
              variant: modelVariant() ?? undefined,
              parts: [
                {
                  type: "text",
                  text:
                    "Load the `workspace_guide` skill from this workspace and explain, in plain language, what lives in this folder (skills/plugins/templates) and what’s global. Then suggest 2 quick next actions the user can do in OpenWork.",
                },
              ],
            });

            try {
              window.localStorage.setItem(storedKey, "1");
            } catch {
              // ignore
            }

            await loadSessions(activeWorkspaceRoot().trim()).catch(() => undefined);

          }
        }
      } catch {
        // ignore onboarding session failures
      }

      setView("dashboard");
      setTab("home");
      refreshSkills().catch(() => undefined);
      return true;
    } catch (e) {
      setClient(null);
      setConnectedVersion(null);
      setError(e instanceof Error ? e.message : safeStringify(e));
      return false;
    } finally {
      setBusy(false);
      setBusyLabel(null);
      setBusyStartedAt(null);
    }
  }

  async function createWorkspaceFlow(preset: WorkspacePreset) {
    if (!isTauriRuntime()) {
      setError("Workspace creation requires the Tauri app runtime.");
      return;
    }

    try {
      const selection = await pickDirectory({ title: "Choose workspace folder" });
      const folder =
        typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;

      if (!folder) return;

      setBusy(true);
      setBusyLabel("Creating workspace");
      setBusyStartedAt(Date.now());
      setError(null);

      const name = folder.split("/").filter(Boolean).pop() ?? "Workspace";
      const ws = await workspaceCreate({ folderPath: folder, name, preset });
      setWorkspaces(ws.workspaces);
      setActiveWorkspaceId(ws.activeId);

      const active = ws.workspaces.find((w) => w.id === ws.activeId) ?? null;
      if (active) {
        setProjectDir(active.path);
        setAuthorizedDirs([active.path]);
        await loadWorkspaceTemplates({ workspaceRoot: active.path, quiet: true }).catch(() => undefined);
      }

      setWorkspacePickerOpen(false);
      setCreateWorkspaceOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setBusy(false);
      setBusyLabel(null);
      setBusyStartedAt(null);
    }
  }

  async function startHost(options?: { workspacePath?: string }) {
    if (!isTauriRuntime()) {
      setError("Host mode requires the Tauri app runtime. Use `pnpm dev`.");
      return false;
    }

    const dir = (options?.workspacePath ?? activeWorkspacePath() ?? projectDir()).trim();
    if (!dir) {
      setError("Pick a workspace folder to start OpenCode in.");
      return false;
    }

    try {
      const result = await engineDoctor();
      setEngineDoctorResult(result);
      setEngineDoctorCheckedAt(Date.now());

      if (!result.found) {
        setError(
          isWindowsPlatform()
            ? "OpenCode CLI not found. Install OpenCode for Windows, then restart OpenWork. If it is installed, ensure `opencode.exe` is on PATH (try `opencode --version` in PowerShell)."
            : "OpenCode CLI not found. Install with `brew install anomalyco/tap/opencode` or `curl -fsSL https://opencode.ai/install | bash`, then retry.",
        );
        return false;
      }

      if (!result.supportsServe) {
        setError("OpenCode CLI is installed, but `opencode serve` is unavailable. Update OpenCode and retry.");
        return false;
      }
    } catch (e) {
      setEngineInstallLogs(e instanceof Error ? e.message : safeStringify(e));
    }

    setError(null);
    setBusy(true);
    setBusyLabel("Starting engine");
    setBusyStartedAt(Date.now());

    try {
      // Keep legacy state in sync for now.
      setProjectDir(dir);
      if (!authorizedDirs().length) {
        setAuthorizedDirs([dir]);
      }

      if (isWindowsPlatform() && engineSource() === "sidecar") {
        setEngineSource("path");
        setError("Sidecar OpenCode is not supported on Windows yet. Using PATH instead.");
      }

      const info = await engineStart(dir, { preferSidecar: engineSource() === "sidecar" });

      setEngine(info);

      if (info.baseUrl) {
        const ok = await connectToServer(info.baseUrl, info.projectDir ?? undefined);
        if (!ok) return false;
      }

      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : safeStringify(e));
      return false;
    } finally {
      setBusy(false);
      setBusyLabel(null);
      setBusyStartedAt(null);
    }
  }

  async function stopHost() {
    setError(null);
    setBusy(true);
    setBusyLabel("Disconnecting");
    setBusyStartedAt(Date.now());

    try {
      if (isTauriRuntime()) {
        const info = await engineStop();
        setEngine(info);
      }

      setClient(null);
      setConnectedVersion(null);
      setSessions([]);
      setSelectedSessionId(null);
      setMessages([]);
      setTodos([]);
      setPendingPermissions([]);
      setSessionStatusById({});
      setSseConnected(false);

      setMode(null);
      setOnboardingStep("mode");
      setView("onboarding");
    } catch (e) {
      setError(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setBusy(false);
      setBusyLabel(null);
      setBusyStartedAt(null);
    }
  }


  async function createSessionAndOpen() {
    const c = client();
    if (!c) return;

    setBusy(true);
    setBusyLabel("Creating session");
    setBusyStartedAt(Date.now());
    setError(null);

    try {
      const session = unwrap(await c.session.create({ title: "New task", directory: activeWorkspaceRoot().trim() }));
      await loadSessions(activeWorkspaceRoot().trim());
      await selectSession(session.id);
      setView("session");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  async function loadWorkspaceTemplates(options?: { workspaceRoot?: string; quiet?: boolean }) {
    const c = client();
    const root = (options?.workspaceRoot ?? activeWorkspaceRoot()).trim();
    if (!c || !root) return;

    try {
      const templatesPath = ".openwork/templates";
      const nodes = unwrap(await c.file.list({ directory: root, path: templatesPath }));
      const jsonFiles = nodes
        .filter((n) => n.type === "file" && !n.ignored)
        .filter((n) => n.name.toLowerCase().endsWith(".json"));

      const loaded: WorkspaceTemplate[] = [];

      for (const node of jsonFiles) {
        const content = unwrap(await c.file.read({ directory: root, path: node.path }));
        if (content.type !== "text") continue;

        const parsed = safeParseJson<Partial<WorkspaceTemplate> & Record<string, unknown>>(content.content);
        if (!parsed) continue;

        const title = typeof parsed.title === "string" ? parsed.title : "Untitled";
        const promptText = typeof parsed.prompt === "string" ? parsed.prompt : "";
        if (!promptText.trim()) continue;

        loaded.push({
          id: typeof parsed.id === "string" ? parsed.id : node.name.replace(/\.json$/i, ""),
          title,
          description: typeof parsed.description === "string" ? parsed.description : "",
          prompt: promptText,
          createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
          scope: "workspace",
        });
      }

      const stable = loaded.slice().sort((a, b) => b.createdAt - a.createdAt);

      setTemplates((current) => {
        const globals = current.filter((t) => t.scope === "global");
        return [...stable, ...globals];
      });
      setWorkspaceTemplatesLoaded(true);
    } catch (e) {
      setWorkspaceTemplatesLoaded(true);
      if (!options?.quiet) {
        setError(e instanceof Error ? e.message : safeStringify(e));
      }
    }
  }

  async function refreshSkills() {
    const c = client();
    if (!c) return;

    try {
      setSkillsStatus(null);
      const nodes = unwrap(await c.file.list({ directory: activeWorkspaceRoot().trim(), path: ".opencode/skill" }));

      const dirs = nodes.filter((n) => n.type === "directory" && !n.ignored);

      const next: SkillCard[] = [];

      for (const dir of dirs) {
        let description: string | undefined;

        try {
            const skillDoc = unwrap(
              await c.file.read({
                directory: activeWorkspaceRoot().trim(),
                path: `.opencode/skill/${dir.name}/SKILL.md`,
              }),
            );

          if (skillDoc.type === "text") {
            const lines = skillDoc.content.split("\n");
            const first = lines
              .map((l) => l.trim())
              .filter((l) => l && !l.startsWith("#"))
              .slice(0, 2)
              .join(" ");
            if (first) {
              description = first;
            }
          }
        } catch {
          // ignore missing SKILL.md
        }

        next.push({ name: dir.name, path: dir.path, description });
      }

      setSkills(next);
      if (!next.length) {
        setSkillsStatus("No skills found in .opencode/skill");
      }
    } catch (e) {
      setSkills([]);
      setSkillsStatus(e instanceof Error ? e.message : "Failed to load skills");
    }
  }

  async function refreshPlugins(scopeOverride?: PluginScope) {
    if (!isTauriRuntime()) {
      setPluginStatus("Plugin management is only available in Host mode.");
      setPluginList([]);
      setSidebarPluginStatus("Plugins are only available in Host mode.");
      setSidebarPluginList([]);
      return;
    }

    const scope = scopeOverride ?? pluginScope();
    const targetDir = projectDir().trim();

    if (scope === "project" && !targetDir) {
      setPluginStatus("Pick a project folder to manage project plugins.");
      setPluginList([]);
      setSidebarPluginStatus("Pick a project folder to load active plugins.");
      setSidebarPluginList([]);
      return;
    }

    try {
      setPluginStatus(null);
      setSidebarPluginStatus(null);
      const config = await readOpencodeConfig(scope, targetDir);
      setPluginConfig(config);

      if (!config.exists) {
        setPluginList([]);
        setPluginStatus("No opencode.json found yet. Add a plugin to create one.");
        setSidebarPluginList([]);
        setSidebarPluginStatus("No opencode.json in this workspace yet.");
        return;
      }

       try {
         const next = parsePluginListFromContent(config.content ?? "");
         setSidebarPluginList(next);
       } catch {
         setSidebarPluginList([]);
         setSidebarPluginStatus("Failed to parse opencode.json");
       }


      loadPluginsFromConfig(config);
    } catch (e) {
      setPluginConfig(null);
      setPluginList([]);
      setPluginStatus(e instanceof Error ? e.message : "Failed to load opencode.json");
      setSidebarPluginStatus("Failed to load active plugins.");
      setSidebarPluginList([]);
    }
  }

  async function addPlugin(pluginNameOverride?: string) {
    if (!isTauriRuntime()) {
      setPluginStatus("Plugin management is only available in Host mode.");
      return;
    }

    const pluginName = (pluginNameOverride ?? pluginInput()).trim();
    const isManualInput = pluginNameOverride == null;

    if (!pluginName) {
      if (isManualInput) {
        setPluginStatus("Enter a plugin package name.");
      }
      return;
    }

    const scope = pluginScope();
    const targetDir = projectDir().trim();

    if (scope === "project" && !targetDir) {
      setPluginStatus("Pick a project folder to manage project plugins.");
      return;
    }

    try {
      setPluginStatus(null);
      const config = await readOpencodeConfig(scope, targetDir);
      const raw = config.content ?? "";

      if (!raw.trim()) {
        const payload = {
          $schema: "https://opencode.ai/config.json",
          plugin: [pluginName],
        };
        await writeOpencodeConfig(scope, targetDir, `${JSON.stringify(payload, null, 2)}\n`);
        markReloadRequired("plugins");
        if (isManualInput) {
          setPluginInput("");
        }
        await refreshPlugins(scope);
        return;
      }

      const plugins = parsePluginListFromContent(raw);

      const desired = stripPluginVersion(pluginName).toLowerCase();
      if (plugins.some((entry) => stripPluginVersion(entry).toLowerCase() === desired)) {
        setPluginStatus("Plugin already listed in opencode.json.");
        return;
      }

      const next = [...plugins, pluginName];
      const edits = modify(raw, ["plugin"], next, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      });
      const updated = applyEdits(raw, edits);

      await writeOpencodeConfig(scope, targetDir, updated);
      markReloadRequired("plugins");
      if (isManualInput) {
        setPluginInput("");
      }
      await refreshPlugins(scope);
    } catch (e) {
      setPluginStatus(e instanceof Error ? e.message : "Failed to update opencode.json");
    }
  }

  async function installFromOpenPackage(sourceOverride?: string) {
    if (mode() !== "host" || !isTauriRuntime()) {
      setError("OpenPackage installs are only available in Host mode.");
      return;
    }

    const targetDir = projectDir().trim();
    const pkg = (sourceOverride ?? openPackageSource()).trim();

    if (!targetDir) {
      setError("Pick a project folder first.");
      return;
    }

    if (!pkg) {
      setError("Enter an OpenPackage source (e.g. github:anthropics/claude-code).");
      return;
    }

    setOpenPackageSource(pkg);
    setBusy(true);
    setError(null);
    setSkillsStatus("Installing OpenPackage...");

    try {
      const result = await opkgInstall(targetDir, pkg);
      if (!result.ok) {
        setSkillsStatus(result.stderr || result.stdout || `opkg failed (${result.status})`);
      } else {
        setSkillsStatus(result.stdout || "Installed.");
        markReloadRequired("skills");
      }

      await refreshSkills();
    } catch (e) {
      setError(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setBusy(false);
    }
  }

  async function useCuratedPackage(pkg: CuratedPackage) {
    if (pkg.installable) {
      await installFromOpenPackage(pkg.source);
      return;
    }

    setOpenPackageSource(pkg.source);
    setSkillsStatus(
      "This is a curated list, not an OpenPackage yet. Copy the link or watch the PRD for planned registry search integration.",
    );
  }

  async function importLocalSkill() {
    if (mode() !== "host" || !isTauriRuntime()) {
      setError("Skill import is only available in Host mode.");
      return;
    }

    const targetDir = projectDir().trim();
    if (!targetDir) {
      setError("Pick a project folder first.");
      return;
    }

    setBusy(true);
    setError(null);
    setSkillsStatus(null);

    try {
      const selection = await pickDirectory({ title: "Select skill folder" });
      const sourceDir =
        typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;

      if (!sourceDir) {
        return;
      }

      const result = await importSkill(targetDir, sourceDir, { overwrite: false });
      if (!result.ok) {
        setSkillsStatus(result.stderr || result.stdout || `Import failed (${result.status})`);
      } else {
        setSkillsStatus(result.stdout || "Imported.");
        markReloadRequired("skills");
      }

      await refreshSkills();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
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

  function normalizeRoots(list: string[]) {
    const out: string[] = [];
    for (const entry of list) {
      const trimmed = entry.trim().replace(/\/+$/, "");
      if (!trimmed) continue;
      if (!out.includes(trimmed)) out.push(trimmed);
    }
    return out;
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
      setError(e instanceof Error ? e.message : safeStringify(e));
    }
  }

  async function addAuthorizedDirFromPicker(options?: { persistToWorkspace?: boolean }) {
    if (!isTauriRuntime()) return;

    try {
      const selection = await pickDirectory({ title: "Add folder" });
      const path =
        typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;

      if (!path) return;

      const roots = normalizeRoots([...authorizedDirs(), path]);
      setAuthorizedDirs(roots);

      if (options?.persistToWorkspace) {
        await persistAuthorizedRoots(roots);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : safeStringify(e));
    }
  }

  async function removeAuthorizedDir(index: number) {
    const roots = authorizedDirs().filter((_, i) => i !== index);
    setAuthorizedDirs(roots);

    try {
      await persistAuthorizedRoots(roots);
    } catch (e) {
      setError(e instanceof Error ? e.message : safeStringify(e));
    }
  }

  onMount(async () => {
    const modePref = readModePreference();
    if (modePref) {
      setRememberModeChoice(true);
    }

    if (typeof window !== "undefined") {
      try {
        const storedBaseUrl = window.localStorage.getItem("openwork.baseUrl");
        if (storedBaseUrl) {
          setBaseUrl(storedBaseUrl);
        }

        const storedClientDir = window.localStorage.getItem("openwork.clientDirectory");
        if (storedClientDir) {
          setClientDirectory(storedClientDir);
        }

        // Legacy: projectDir is now derived from the active workspace.
        const storedProjectDir = window.localStorage.getItem("openwork.projectDir");
        if (storedProjectDir && !projectDir().trim()) {
          setProjectDir(storedProjectDir);
        }

        const storedEngineSource = window.localStorage.getItem("openwork.engineSource");
        if (storedEngineSource === "path" || storedEngineSource === "sidecar") {
          setEngineSource(storedEngineSource);
        }

        const storedAuthorized = window.localStorage.getItem("openwork.authorizedDirs");
        if (storedAuthorized) {
          const parsed = JSON.parse(storedAuthorized) as unknown;
          if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
            setAuthorizedDirs(parsed);
          }
        }

        // Legacy (pre-workspace templates): normalize any stored templates into global templates.
        const storedTemplates = window.localStorage.getItem("openwork.templates");
         if (storedTemplates) {
           const parsed = JSON.parse(storedTemplates) as unknown;
           if (Array.isArray(parsed)) {
             const normalized = (parsed as unknown[])
               .filter((v) => v && typeof v === "object")
               .map((entry) => {
                 const record = entry as Record<string, unknown>;
                 return {
                   id: typeof record.id === "string" ? record.id : `tmpl_${Date.now()}`,
                   title: typeof record.title === "string" ? record.title : "Untitled",
                   description: typeof record.description === "string" ? record.description : "",
                   prompt: typeof record.prompt === "string" ? record.prompt : "",
                   createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
                   scope: "global" as const,
                 } satisfies WorkspaceTemplate;
               })
               .filter((t) => t.prompt.trim().length > 0);

             setTemplates(normalized);
           }
         }

         setGlobalTemplatesLoaded(true);

        const storedDefaultModel = window.localStorage.getItem(MODEL_PREF_KEY);
        const parsedDefaultModel = parseModelRef(storedDefaultModel);
        if (parsedDefaultModel) {
          setDefaultModel(parsedDefaultModel);
        } else {
          setDefaultModel(DEFAULT_MODEL);
          try {
            window.localStorage.setItem(MODEL_PREF_KEY, formatModelRef(DEFAULT_MODEL));
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
          setModelVariant(storedVariant.trim());
        }

        const storedUpdateAutoCheck = window.localStorage.getItem("openwork.updateAutoCheck");
        if (storedUpdateAutoCheck === "0" || storedUpdateAutoCheck === "1") {
          setUpdateAutoCheck(storedUpdateAutoCheck === "1");
        }

        const storedUpdateCheckedAt = window.localStorage.getItem("openwork.updateLastCheckedAt");
        if (storedUpdateCheckedAt) {
          const parsed = Number(storedUpdateCheckedAt);
          if (Number.isFinite(parsed) && parsed > 0) {
            setUpdateStatus({ state: "idle", lastCheckedAt: parsed });
          }
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

      // Mark global templates as loaded even if nothing was stored.
      setGlobalTemplatesLoaded(true);

      try {
        setUpdateEnv(await updaterEnvironment());
      } catch {
        // ignore
      }

      if (updateAutoCheck()) {
        const state = updateStatus();
        const lastCheckedAt = state.state === "idle" ? state.lastCheckedAt : null;
        if (!lastCheckedAt || Date.now() - lastCheckedAt > 24 * 60 * 60_000) {
          checkForUpdates({ quiet: true }).catch(() => undefined);
        }
      }
    }

    await refreshEngine();
    await refreshEngineDoctor();

     // Bootstrap workspaces (Host mode only).
     if (isTauriRuntime()) {
       try {
          const ws = await workspaceBootstrap();
          setWorkspaces(ws.workspaces);
          setActiveWorkspaceId(ws.activeId);
          const active = ws.workspaces.find((w) => w.id === ws.activeId) ?? null;
          if (active) {
            setProjectDir(active.path);
            if (isTauriRuntime()) {
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
            } else if (!authorizedDirs().length) {
              setAuthorizedDirs([active.path]);
            }

            await loadWorkspaceTemplates({ workspaceRoot: active.path, quiet: true }).catch(() => undefined);
          }
       } catch {
         // ignore
       }
     }

     const info = engine();
     if (info?.baseUrl) {
       setBaseUrl(info.baseUrl);
     }

     // Auto-continue based on saved preference.
     if (!modePref) return;


    if (modePref === "host") {
      setMode("host");

      if (info?.running && info.baseUrl) {
        setOnboardingStep("connecting");
        const ok = await connectToServer(info.baseUrl, info.projectDir ?? undefined);
        if (!ok) {
          setMode(null);
          setOnboardingStep("mode");
        }
        return;
      }

       if (isTauriRuntime() && activeWorkspacePath().trim()) {
         if (!authorizedDirs().length && activeWorkspacePath().trim()) {
           setAuthorizedDirs([activeWorkspacePath().trim()]);
         }

         setOnboardingStep("connecting");
         const ok = await startHost({ workspacePath: activeWorkspacePath().trim() });
         if (!ok) {
           setOnboardingStep("host");
         }
         return;
       }

       // Missing required info; take them directly to Host setup.
       setOnboardingStep("host");
       return;
     }

    // Client preference.
    setMode("client");
    if (!baseUrl().trim()) {
      setOnboardingStep("client");
      return;
    }

    setOnboardingStep("connecting");
    const ok = await connectToServer(
      baseUrl().trim(),
      clientDirectory().trim() ? clientDirectory().trim() : undefined,
    );

    if (!ok) {
      setOnboardingStep("client");
    }
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (onboardingStep() !== "host") return;
    void refreshEngineDoctor();
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
      window.localStorage.setItem("openwork.clientDirectory", clientDirectory());
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    // Legacy key: keep for backwards compatibility.
    try {
      window.localStorage.setItem("openwork.projectDir", projectDir());
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
    // Legacy persistence; workspace config is authoritative in the desktop app.
    try {
      window.localStorage.setItem("openwork.authorizedDirs", JSON.stringify(authorizedDirs()));
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!globalTemplatesLoaded()) return;

    try {
      const payload = templates()
        .filter((t) => t.scope === "global")
        .map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          prompt: t.prompt,
          createdAt: t.createdAt,
          scope: t.scope,
        }));

      window.localStorage.setItem("openwork.templates", JSON.stringify(payload));
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(MODEL_PREF_KEY, formatModelRef(defaultModel()));
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("openwork.updateAutoCheck", updateAutoCheck() ? "1" : "0");
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(THINKING_PREF_KEY, JSON.stringify(showThinking()));
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
    const state = updateStatus();
    if (typeof window === "undefined") return;
    if (state.state === "idle" && state.lastCheckedAt) {
      try {
        window.localStorage.setItem("openwork.updateLastCheckedAt", String(state.lastCheckedAt));
      } catch {
        // ignore
      }
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


  const headerStatus = createMemo(() => {
    if (!client() || !connectedVersion()) return "Disconnected";
    const bits = [`Connected · ${connectedVersion()}`];
    if (sseConnected()) bits.push("Live");
    return bits.join(" · ");
  });

  const busyHint = createMemo(() => {
    if (!busy() || !busyLabel()) return null;
    const seconds = busySeconds();
    return seconds > 0 ? `${busyLabel()} · ${seconds}s` : busyLabel();
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
    authorizedDirs: authorizedDirs(),
    activeWorkspacePath: activeWorkspacePath(),
    localHostLabel: localHostLabel(),
    engineRunning: Boolean(engine()?.running),
    engineBaseUrl: engine()?.baseUrl ?? null,
    engineDoctorFound: engineDoctorResult()?.found ?? null,
    engineDoctorSupportsServe: engineDoctorResult()?.supportsServe ?? null,
    engineDoctorVersion: engineDoctorResult()?.version ?? null,
    engineDoctorResolvedPath: engineDoctorResult()?.resolvedPath ?? null,
    engineDoctorNotes: engineDoctorResult()?.notes ?? [],
    engineDoctorCheckedAt: engineDoctorCheckedAt(),
    engineInstallLogs: engineInstallLogs(),
    error: error(),
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
    onStartHost: async () => {
      setMode("host");
      setOnboardingStep("connecting");
      const ok = await startHost({ workspacePath: activeWorkspacePath().trim() });
      if (!ok) {
        setOnboardingStep("host");
      }
    },
    onAttachHost: async () => {
      setMode("host");
      setOnboardingStep("connecting");
      const ok = await connectToServer(engine()?.baseUrl ?? "", engine()?.projectDir ?? undefined);
      if (!ok) {
        setMode(null);
        setOnboardingStep("mode");
      }
    },
    onConnectClient: async () => {
      setMode("client");
      setOnboardingStep("connecting");
      const ok = await connectToServer(
        baseUrl().trim(),
        clientDirectory().trim() ? clientDirectory().trim() : undefined,
      );
      if (!ok) {
        setOnboardingStep("client");
      }
    },
    onBackToMode: () => {
      setMode(null);
      setOnboardingStep("mode");
    },
    onSetAuthorizedDir: setNewAuthorizedDir,
    onAddAuthorizedDir: addAuthorizedDir,
    onAddAuthorizedDirFromPicker: () => addAuthorizedDirFromPicker({ persistToWorkspace: true }),
    onRemoveAuthorizedDir: removeAuthorizedDir,
    onRefreshEngineDoctor: async () => {
      setEngineInstallLogs(null);
      await refreshEngineDoctor();
    },
    onInstallEngine: async () => {
      setError(null);
      setEngineInstallLogs(null);
      setBusy(true);
      setBusyLabel("Installing OpenCode");
      setBusyStartedAt(Date.now());

      try {
        const result = await engineInstall();
        const combined = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
        setEngineInstallLogs(combined || null);

        if (!result.ok) {
          setError(result.stderr.trim() || "OpenCode install failed. See logs above.");
        }

        await refreshEngineDoctor();
      } catch (e) {
        setError(e instanceof Error ? e.message : safeStringify(e));
      } finally {
        setBusy(false);
        setBusyLabel(null);
        setBusyStartedAt(null);
      }
    },
    onShowSearchNotes: () => {
      const notes = engineDoctorResult()?.notes?.join("\n") ?? "";
      setEngineInstallLogs(notes || null);
    },
  });

  const dashboardProps = () => ({
    tab: tab(),
    setTab,
    view: view(),
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
    workspaceSearch: workspaceSearch(),
    setWorkspaceSearch,
    workspacePickerOpen: workspacePickerOpen(),
    setWorkspacePickerOpen,
    workspaces: workspaces(),
    filteredWorkspaces: filteredWorkspaces(),
    activeWorkspaceId: activeWorkspaceId(),
    activateWorkspace,
    createWorkspaceOpen: createWorkspaceOpen(),
    setCreateWorkspaceOpen,
    createWorkspaceFlow,
    sessions: sessions().map((s) => ({
      id: s.id,
      slug: s.slug,
      title: s.title,
      time: s.time,
      directory: s.directory,
    })),
    sessionStatusById: sessionStatusById(),
    activeWorkspaceRoot: activeWorkspaceRoot().trim(),
    workspaceTemplates: workspaceTemplates(),
    globalTemplates: globalTemplates(),
    setTemplateDraftTitle,
    setTemplateDraftDescription,
    setTemplateDraftPrompt,
    setTemplateDraftScope,
    resetTemplateDraft: (scope: "workspace" | "global" = "workspace") =>
      resetTemplateDraft(
        {
          setTitle: setTemplateDraftTitle,
          setDescription: setTemplateDraftDescription,
          setPrompt: setTemplateDraftPrompt,
          setScope: setTemplateDraftScope,
        },
        scope,
      ),
    openTemplateModal,
    runTemplate,
    deleteTemplate,
    refreshSkills: () => refreshSkills().catch(() => undefined),
    refreshPlugins: (scopeOverride?: PluginScope) => refreshPlugins(scopeOverride).catch(() => undefined),
    skills: skills(),
    skillsStatus: skillsStatus(),
    openPackageSource: openPackageSource(),
    setOpenPackageSource,
    installFromOpenPackage: () => installFromOpenPackage(),
    importLocalSkill,
    packageSearch: packageSearch(),
    setPackageSearch,
    filteredPackages: filteredPackages(),
    useCuratedPackage,
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
    selectSession,
    defaultModelLabel: formatModelLabel(defaultModel(), providers()),
    defaultModelRef: formatModelRef(defaultModel()),
    openDefaultModelPicker,
    showThinking: showThinking(),
    toggleShowThinking: () => setShowThinking((v) => !v),
    modelVariantLabel: modelVariant() ?? "(default)",
    editModelVariant: () => {
      const next = window.prompt(
        "Model variant (provider-specific, e.g. high/max/minimal). Leave blank to clear.",
        modelVariant() ?? "",
      );
      if (next == null) return;
      const trimmed = next.trim();
      setModelVariant(trimmed ? trimmed : null);
    },
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
    pendingPermissions: pendingPermissions(),
    events: events(),
    safeStringify,
  });

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

  return (
    <>
      <Show when={client()} fallback={<OnboardingView {...onboardingProps()} />}>
        <Switch>
          <Match when={view() === "dashboard"}>
            <DashboardView {...dashboardProps()} />
          </Match>
          <Match when={view() === "session"}>
            <SessionView
                selectedSessionId={selectedSessionId()}
                setView={setView}
                setTab={setTab}
                activeWorkspaceDisplay={activeWorkspaceDisplay()}
                setWorkspaceSearch={setWorkspaceSearch}
                setWorkspacePickerOpen={setWorkspacePickerOpen}
                headerStatus={headerStatus()}
                busyHint={busyHint()}
                createSessionAndOpen={createSessionAndOpen}
                sendPromptAsync={sendPrompt}
                newTaskDisabled={newTaskDisabled()}
                sessions={sessions().map((session) => ({
                  id: session.id,
                  title: session.title,
                  slug: session.slug,
                }))}
                selectSession={selectSession}
                messages={messages()}
                todos={todos()}
                busyLabel={busyLabel()}
                developerMode={developerMode()}
                showThinking={showThinking()}
                groupMessageParts={groupMessageParts}
                summarizeStep={summarizeStep}
                expandedStepIds={expandedStepIds()}
                setExpandedStepIds={setExpandedStepIds}
                expandedSidebarSections={expandedSidebarSections()}
                setExpandedSidebarSections={setExpandedSidebarSections}
                artifacts={artifacts()}
                workingFiles={workingFiles()}
                authorizedDirs={authorizedDirs()}
                busy={busy()}
                prompt={prompt()}
                setPrompt={setPrompt}
                sendPrompt={sendPrompt}
                activePermission={activePermission()}
                permissionReplyBusy={permissionReplyBusy()}
                respondPermission={respondPermission}
                respondPermissionAndRemember={respondPermissionAndRemember}
                safeStringify={safeStringify}

            />
          </Match>
          <Match when={true}>
            <DashboardView {...dashboardProps()} />
          </Match>
        </Switch>
      </Show>

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
        canReset={!resetModalBusy() && !anyActiveRuns() && resetModalText().trim().toUpperCase() === "RESET"}
        hasActiveRuns={anyActiveRuns()}
        onClose={() => setResetModalOpen(false)}
        onConfirm={confirmReset}
        onTextChange={setResetModalText}
      />

      <TemplateModal
        open={templateModalOpen()}
        title={templateDraftTitle()}
        description={templateDraftDescription()}
        prompt={templateDraftPrompt()}
        scope={templateDraftScope()}
        onClose={() => setTemplateModalOpen(false)}
        onSave={saveTemplate}
        onTitleChange={setTemplateDraftTitle}
        onDescriptionChange={setTemplateDraftDescription}
        onPromptChange={setTemplateDraftPrompt}
        onScopeChange={setTemplateDraftScope}
      />
    </>
  );
}
