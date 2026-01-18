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
  DEMO_MODE_PREF_KEY,
  DEMO_SEQUENCE_PREF_KEY,
  MODEL_PREF_KEY,
  SUGGESTED_PLUGINS,
  THINKING_PREF_KEY,
  VARIANT_PREF_KEY,
} from "./app/constants";
import type {
  Client,
  CuratedPackage,
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
  WorkspaceDisplay,
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
import { createExtensionsStore } from "./app/extensions";
import { createWorkspaceStore } from "./app/workspace";
import {
  updaterEnvironment,
  workspaceTemplateDelete,
  workspaceTemplateWrite,
  resetOpenworkState,
} from "./lib/tauri";


export default function App() {
  const [view, setView] = createSignal<View>("onboarding");
  const [mode, setMode] = createSignal<Mode | null>(null);
  const [onboardingStep, setOnboardingStep] = createSignal<OnboardingStep>("mode");
  const [rememberModeChoice, setRememberModeChoice] = createSignal(false);
  const [tab, setTab] = createSignal<DashboardTab>("home");

  const [engineSource, setEngineSource] = createSignal<"path" | "sidecar">("path");

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

  const [demoMode, setDemoMode] = createSignal(false);
  const [demoSequence, setDemoSequence] = createSignal<DemoSequence>("cold-open");

  const [demoSessions, setDemoSessions] = createSignal<ReturnType<typeof sessions>>([]);
  const [demoSessionStatusById, setDemoSessionStatusById] = createSignal<Record<string, string>>({});
  const [demoMessages, setDemoMessages] = createSignal<MessageWithParts[]>([]);
  const [demoTodos, setDemoTodos] = createSignal<TodoItem[]>([]);
  const [demoArtifacts, setDemoArtifacts] = createSignal<ReturnType<typeof deriveArtifacts>>([]);
  const [demoSelectedSessionId, setDemoSelectedSessionId] = createSignal<string | null>(null);
  const [demoWorkingFiles, setDemoWorkingFiles] = createSignal<string[]>([]);
  const [demoAuthorizedDirs, setDemoAuthorizedDirs] = createSignal<string[]>([]);
  const [demoActiveWorkspaceDisplay, setDemoActiveWorkspaceDisplay] = createSignal<WorkspaceDisplay>({
    id: "demo",
    name: "Demo",
    path: "~/OpenWork Demo",
    preset: "starter",
  });

  const isDemoMode = createMemo(() => demoMode());

  function setDemoSequenceState(sequence: DemoSequence) {
    const now = Date.now();

    setDemoSelectedSessionId(null);

    const makeToolPart = (tool: string, title: string, output: string, path?: string) => ({
      id: `tool-${sequence}-${Math.random().toString(36).slice(2, 8)}`,
      type: "tool",
      sessionID: `demo-${sequence}`,
      messageID: `msg-${sequence}-assistant`,
      tool,
      state: {
        status: "completed",
        title,
        output,
        ...(path ? { path } : {}),
      },
    } as any);

    const makeTextPart = (text: string) => ({
      id: `text-${sequence}-${Math.random().toString(36).slice(2, 8)}`,
      type: "text",
      sessionID: `demo-${sequence}`,
      messageID: `msg-${sequence}-assistant`,
      text,
    } as any);

    const baseSession = {
      id: `demo-${sequence}`,
      slug: "demo",
      title: "Demo run",
      directory: "~/OpenWork Demo",
      time: { updated: now },
    } as any;

    const baseUser = {
      id: `msg-${sequence}-user`,
      sessionID: baseSession.id,
      role: "user",
      time: { created: now - 120000 },
    } as any;

    const baseAssistant = {
      id: `msg-${sequence}-assistant`,
      sessionID: baseSession.id,
      role: "assistant",
      time: { created: now - 90000 },
    } as any;

    if (sequence === "cold-open") {
      const parts = [
        makeTextPart("Scheduled weekly finance recap and prepared the grocery draft."),
        makeToolPart(
          "schedule_job",
          "Scheduled weekly finance recap",
          "Next run: Monday 9:00 AM",
        ),
        makeToolPart(
          "read",
          "Summarized meeting notes",
          "Generated notes summary: highlights + follow-ups.",
          "notes/summary.md",
        ),
        makeToolPart(
          "write",
          "Prepared grocery order",
          "Cart ready with 14 items.",
          "home/grocery-list.md",
        ),
      ];

      const messages = [
        { info: baseUser, parts: [{ type: "text", text: "Run the weekly stack." } as any] },
        { info: baseAssistant, parts },
      ];

      setDemoActiveWorkspaceDisplay({
        id: "demo",
        name: "Home",
        path: "~/OpenWork Demo",
        preset: "starter",
      });
      setDemoSessions([baseSession]);
      setDemoSessionStatusById({ [baseSession.id]: "completed" });
      setDemoMessages(messages);
      setDemoTodos([
        { id: "cold-1", content: "Schedule recurring recap", status: "completed", priority: "high" },
        { id: "cold-2", content: "Summarize notes", status: "completed", priority: "medium" },
        { id: "cold-3", content: "Prepare grocery order", status: "completed", priority: "medium" },
      ]);
      setDemoAuthorizedDirs(["~/OpenWork Demo", "~/Documents/Notes"]);
      setDemoSelectedSessionId(baseSession.id);
      const derived = deriveArtifacts(messages as MessageWithParts[]);
      setDemoArtifacts(derived);
      setDemoWorkingFiles(deriveWorkingFiles(derived));
      return;
    }

    if (sequence === "scheduler") {
      const parts = [
        makeTextPart("Scheduled finance recap and weekly report export."),
        makeToolPart(
          "schedule_job",
          "Weekly finance recap",
          "Next run: Monday 9:00 AM",
        ),
        makeToolPart(
          "schedule_job",
          "Weekly report export",
          "Next run: Friday 4:00 PM",
        ),
      ];

      const messages = [
        { info: baseUser, parts: [{ type: "text", text: "Set up weekly finance jobs." } as any] },
        { info: baseAssistant, parts },
      ];

      setDemoActiveWorkspaceDisplay({
        id: "demo-finance",
        name: "Finance",
        path: "~/OpenWork Demo/finance",
        preset: "starter",
      });
      setDemoSessions([{ ...baseSession, title: "Weekly finance recap" }]);
      setDemoSessionStatusById({ [baseSession.id]: "completed" });
      setDemoMessages(messages);
      setDemoTodos([
        { id: "sched-1", content: "Create weekly recap", status: "completed", priority: "high" },
        { id: "sched-2", content: "Schedule export", status: "completed", priority: "medium" },
      ]);
      setDemoAuthorizedDirs(["~/OpenWork Demo/finance"]);
      setDemoSelectedSessionId(baseSession.id);
      const derived = deriveArtifacts(messages as MessageWithParts[]);
      setDemoArtifacts(derived);
      setDemoWorkingFiles(deriveWorkingFiles(derived));
      return;
    }

    if (sequence === "summaries") {
      const parts = [
        makeTextPart("Compiled the latest meeting notes and flagged action items."),
        makeToolPart(
          "read",
          "Summarized Q1 planning notes",
          "Summary saved with 6 action items.",
          "notes/summary.md",
        ),
        makeToolPart(
          "write",
          "Created follow-up list",
          "Action items captured in follow-ups.md",
          "notes/follow-ups.md",
        ),
      ];

      const messages = [
        { info: baseUser, parts: [{ type: "text", text: "Summarize the latest notes." } as any] },
        { info: baseAssistant, parts },
      ];

      setDemoActiveWorkspaceDisplay({
        id: "demo-notes",
        name: "Notes",
        path: "~/OpenWork Demo/notes",
        preset: "starter",
      });
      setDemoSessions([{ ...baseSession, title: "Notes summary" }]);
      setDemoSessionStatusById({ [baseSession.id]: "completed" });
      setDemoMessages(messages);
      setDemoTodos([
        { id: "sum-1", content: "Read recent notes", status: "completed", priority: "high" },
        { id: "sum-2", content: "Create summary", status: "completed", priority: "medium" },
        { id: "sum-3", content: "Publish follow-ups", status: "completed", priority: "medium" },
      ]);
      setDemoAuthorizedDirs(["~/OpenWork Demo/notes"]);
      setDemoSelectedSessionId(baseSession.id);
      const derived = deriveArtifacts(messages as MessageWithParts[]);
      setDemoArtifacts(derived);
      setDemoWorkingFiles(deriveWorkingFiles(derived));
      return;
    }

    const parts = [
      makeTextPart("Prepared a checkout-ready grocery cart from this week's meal plan."),
      makeToolPart(
        "read",
        "Parsed meal plan",
        "Identified 14 ingredients needed.",
        "home/meal-plan.md",
      ),
      makeToolPart(
        "write",
        "Generated grocery list",
        "Grocery list ready for review.",
        "home/grocery-list.md",
      ),
      makeToolPart(
        "tool.browser",
        "Built Instacart draft",
        "Cart ready with 14 items.",
      ),
    ];

    const messages = [
      { info: baseUser, parts: [{ type: "text", text: "Prep grocery order for this week." } as any] },
      { info: baseAssistant, parts },
    ];

    setDemoActiveWorkspaceDisplay({
      id: "demo-home",
      name: "Home",
      path: "~/OpenWork Demo/home",
      preset: "starter",
    });
    setDemoSessions([{ ...baseSession, title: "Grocery order" }]);
    setDemoSessionStatusById({ [baseSession.id]: "completed" });
    setDemoMessages(messages);
    setDemoTodos([
      { id: "gro-1", content: "Read meal plan", status: "completed", priority: "high" },
      { id: "gro-2", content: "Generate list", status: "completed", priority: "medium" },
      { id: "gro-3", content: "Prepare checkout cart", status: "completed", priority: "medium" },
    ]);
    setDemoAuthorizedDirs(["~/OpenWork Demo/home"]);
    setDemoSelectedSessionId(baseSession.id);
    const derived = deriveArtifacts(messages as MessageWithParts[]);
    setDemoArtifacts(derived);
    setDemoWorkingFiles(deriveWorkingFiles(derived));
  }

  const artifacts = createMemo(() => deriveArtifacts(messages()));
  const workingFiles = createMemo(() => deriveWorkingFiles(artifacts()));

  const activeSessionId = createMemo(() => (isDemoMode() ? demoSelectedSessionId() : selectedSessionId()));
  const activeSessions = createMemo(() => (isDemoMode() ? demoSessions() : sessions()));
  const activeSessionStatusById = createMemo(() => (isDemoMode() ? demoSessionStatusById() : sessionStatusById()));
  const activeMessages = createMemo(() => (isDemoMode() ? demoMessages() : messages()));
  const activeTodos = createMemo(() => (isDemoMode() ? demoTodos() : todos()));
  const activeArtifacts = createMemo(() => (isDemoMode() ? demoArtifacts() : artifacts()));
  const activeWorkingFiles = createMemo(() => (isDemoMode() ? demoWorkingFiles() : workingFiles()));

  const selectDemoSession = (sessionId: string) => {
    setDemoSelectedSessionId(sessionId);
  };

  createEffect(() => {
    if (!isDemoMode()) return;
    setDemoSequenceState(demoSequence());
  });

  const [prompt, setPrompt] = createSignal("");
  const [lastPromptSent, setLastPromptSent] = createSignal("");

  async function sendPrompt() {
    const content = prompt().trim();
    if (!content) return;

    if (isDemoMode()) {
      setLastPromptSent(content);
      setPrompt("");
      return;
    }

    const c = client();
    const sessionID = selectedSessionId();
    if (!c || !sessionID) return;

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

      await loadSessions(workspaceStore.activeWorkspaceRoot().trim()).catch(() => undefined);
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

  async function respondPermissionAndRemember(requestID: string, reply: "once" | "always" | "reject") {
    // Intentional no-op: permission prompts grant session-scoped access only.
    // Persistent workspace roots must be managed explicitly via workspace settings.
    await respondPermission(requestID, reply);
  }

  const [reloadRequired, setReloadRequired] = createSignal(false);
  const [reloadReasons, setReloadReasons] = createSignal<ReloadReason[]>([]);
  const [reloadLastTriggeredAt, setReloadLastTriggeredAt] = createSignal<number | null>(null);
  const [reloadBusy, setReloadBusy] = createSignal(false);
  const [reloadError, setReloadError] = createSignal<string | null>(null);

  const extensionsStore = createExtensionsStore({
    client,
    mode,
    projectDir: () => workspaceProjectDir(),
    activeWorkspaceRoot: () => workspaceStore.activeWorkspaceRoot(),
    setBusy,
    setBusyLabel,
    setBusyStartedAt,
    setError,
    markReloadRequired,
  });

  const {
    skills,
    skillsStatus,
    openPackageSource,
    setOpenPackageSource,
    packageSearch,
    setPackageSearch,
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
    installFromOpenPackage,
    useCuratedPackage,
    importLocalSkill,
  } = extensionsStore;

  const [providers, setProviders] = createSignal<Provider[]>([]);
  const [providerDefaults, setProviderDefaults] = createSignal<Record<string, string>>({});
  const [providerConnectedIds, setProviderConnectedIds] = createSignal<string[]>([]);

  const [defaultModel, setDefaultModel] = createSignal<ModelRef>(DEFAULT_MODEL);
  const [modelPickerOpen, setModelPickerOpen] = createSignal(false);
  const [modelPickerTarget, setModelPickerTarget] = createSignal<"session" | "default">("session");
  const [modelPickerQuery, setModelPickerQuery] = createSignal("");

  const [showThinking, setShowThinking] = createSignal(false);
  const [modelVariant, setModelVariant] = createSignal<string | null>(null);

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
      if (!workspaceStore.activeWorkspaceRoot().trim()) {
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
        const workspaceRoot = workspaceStore.activeWorkspaceRoot().trim();
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
      const workspaceRoot = workspaceStore.activeWorkspaceRoot().trim();
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
    if (isDemoMode()) {
      setView("session");
      return;
    }

    const c = client();
    if (!c) return;

    setBusy(true);
    setError(null);

    try {
      const session = unwrap(
        await c.session.create({ title: template.title, directory: workspaceStore.activeWorkspaceRoot().trim() }),
      );
      await loadSessions(workspaceStore.activeWorkspaceRoot().trim());
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
    loadWorkspaceTemplates,
    loadSessions,
    refreshPendingPermissions,
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

  const activeAuthorizedDirs = createMemo(() =>
    isDemoMode() ? demoAuthorizedDirs() : workspaceStore.authorizedDirs(),
  );
  const activeWorkspaceDisplay = createMemo(() =>
    isDemoMode() ? demoActiveWorkspaceDisplay() : workspaceStore.activeWorkspaceDisplay(),
  );
  const activePermissionMemo = createMemo(() => (isDemoMode() ? null : activePermission()));

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

      await refreshPlugins("project").catch(() => undefined);
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

  async function createSessionAndOpen() {
    if (isDemoMode()) {
      setView("session");
      return;
    }

    const c = client();
    if (!c) return;

    setBusy(true);
    setBusyLabel("Creating session");
    setBusyStartedAt(Date.now());
    setError(null);

    try {
      const session = unwrap(
        await c.session.create({ title: "New task", directory: workspaceStore.activeWorkspaceRoot().trim() }),
      );
      await loadSessions(workspaceStore.activeWorkspaceRoot().trim());
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
    const root = (options?.workspaceRoot ?? workspaceStore.activeWorkspaceRoot()).trim();
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

        const storedEngineSource = window.localStorage.getItem("openwork.engineSource");
        if (storedEngineSource === "path" || storedEngineSource === "sidecar") {
          setEngineSource(storedEngineSource);
        }


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

        const storedDemoMode = window.localStorage.getItem(DEMO_MODE_PREF_KEY);
        if (storedDemoMode != null) {
          setDemoMode(storedDemoMode === "1");
        }

        const storedDemoSequence = window.localStorage.getItem(DEMO_SEQUENCE_PREF_KEY);
        if (
          storedDemoSequence === "cold-open" ||
          storedDemoSequence === "scheduler" ||
          storedDemoSequence === "summaries" ||
          storedDemoSequence === "groceries"
        ) {
          setDemoSequence(storedDemoSequence);
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

    void workspaceStore.bootstrapOnboarding();
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
      window.localStorage.setItem("openwork.clientDirectory", clientDirectory());
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
    authorizedDirs: workspaceStore.authorizedDirs(),
    activeWorkspacePath: workspaceStore.activeWorkspacePath(),
    localHostLabel: localHostLabel(),
    engineRunning: Boolean(engine()?.running),
    developerMode: developerMode(),
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
    onStartHost: workspaceStore.onStartHost,
    onAttachHost: workspaceStore.onAttachHost,
    onConnectClient: workspaceStore.onConnectClient,
    onBackToMode: workspaceStore.onBackToMode,
    onSetAuthorizedDir: workspaceStore.setNewAuthorizedDir,
    onAddAuthorizedDir: workspaceStore.addAuthorizedDir,
    onAddAuthorizedDirFromPicker: () => workspaceStore.addAuthorizedDirFromPicker({ persistToWorkspace: true }),
    onRemoveAuthorizedDir: workspaceStore.removeAuthorizedDirAtIndex,
    onRefreshEngineDoctor: async () => {
      workspaceStore.setEngineInstallLogs(null);
      await workspaceStore.refreshEngineDoctor();
    },
    onInstallEngine: workspaceStore.onInstallEngine,
    onShowSearchNotes: () => {
      const notes = workspaceStore.engineDoctorResult()?.notes?.join("\n") ?? "";
      workspaceStore.setEngineInstallLogs(notes || null);
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
    workspaceSearch: workspaceStore.workspaceSearch(),
    setWorkspaceSearch: workspaceStore.setWorkspaceSearch,
    workspacePickerOpen: workspaceStore.workspacePickerOpen(),
    setWorkspacePickerOpen: workspaceStore.setWorkspacePickerOpen,
    workspaces: workspaceStore.workspaces(),
    filteredWorkspaces: workspaceStore.filteredWorkspaces(),
    activeWorkspaceId: workspaceStore.activeWorkspaceId(),
    activateWorkspace: workspaceStore.activateWorkspace,
    createWorkspaceOpen: workspaceStore.createWorkspaceOpen(),
    setCreateWorkspaceOpen: workspaceStore.setCreateWorkspaceOpen,
    createWorkspaceFlow: workspaceStore.createWorkspaceFlow,
    sessions: activeSessions().map((s) => ({
      id: s.id,
      slug: s.slug,
      title: s.title,
      time: s.time,
      directory: s.directory,
    })),
    sessionStatusById: activeSessionStatusById(),
    activeWorkspaceRoot: isDemoMode() ? demoActiveWorkspaceDisplay().path : workspaceStore.activeWorkspaceRoot().trim(),
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
    selectSession: isDemoMode() ? selectDemoSession : selectSession,
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
    pendingPermissions: pendingPermissions(),
    events: events(),
    safeStringify,
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
                selectedSessionId={activeSessionId()}
                setView={setView}
                setTab={setTab}
                activeWorkspaceDisplay={activeWorkspaceDisplay()}
                setWorkspaceSearch={workspaceStore.setWorkspaceSearch}
                setWorkspacePickerOpen={workspaceStore.setWorkspacePickerOpen}
                headerStatus={headerStatus()}
                busyHint={busyHint()}
                selectedSessionModelLabel={selectedSessionModelLabel()}
                openSessionModelPicker={openSessionModelPicker}
                activePlugins={sidebarPluginList()}
                activePluginStatus={sidebarPluginStatus()}

                createSessionAndOpen={createSessionAndOpen}

                sendPromptAsync={sendPrompt}
                newTaskDisabled={newTaskDisabled()}
                sessions={activeSessions().map((session) => ({
                  id: session.id,
                  title: session.title,
                  slug: session.slug,
                }))}
                selectSession={isDemoMode() ? selectDemoSession : selectSession}
                messages={activeMessages()}
                todos={activeTodos()}
                busyLabel={busyLabel()}
                developerMode={developerMode()}
                showThinking={showThinking()}
                groupMessageParts={groupMessageParts}
                summarizeStep={summarizeStep}
                expandedStepIds={expandedStepIds()}
                setExpandedStepIds={setExpandedStepIds}
                expandedSidebarSections={expandedSidebarSections()}
                setExpandedSidebarSections={setExpandedSidebarSections}
                artifacts={activeArtifacts()}
                workingFiles={activeWorkingFiles()}
                authorizedDirs={activeAuthorizedDirs()}
                busy={busy()}
                prompt={prompt()}
                setPrompt={setPrompt}
                sendPrompt={sendPrompt}
                activePermission={activePermissionMemo()}
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
