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
import { invoke } from "@tauri-apps/api/core";
import { parse } from "jsonc-parser";

import ModelPickerModal from "./components/ModelPickerModal";
import ResetModal from "./components/ResetModal";
import TemplateModal from "./components/TemplateModal";
import WorkspacePicker from "./components/WorkspacePicker";
import CreateWorkspaceModal from "./components/CreateWorkspaceModal";
import OnboardingView from "./views/OnboardingView";
import DashboardView from "./views/DashboardView";
import SessionView from "./views/SessionView";
import { createClient, unwrap, waitForHealthy } from "./lib/opencode";
import {
  CURATED_PACKAGES,
  DEFAULT_MODEL,
  DEMO_MODE_PREF_KEY,
  DEMO_SEQUENCE_PREF_KEY,
  createLMStudioProvider,
  MCP_QUICK_CONNECT,
  MODEL_PREF_KEY,
  SUGGESTED_PLUGINS,
  THINKING_PREF_KEY,
  VARIANT_PREF_KEY,
} from "./app/constants";
import { parseMcpServersFromContent } from "./app/mcp";
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
  McpServerEntry,
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
  parseTemplateFrontmatter,
  readModePreference,
  safeParseJson,
  safeStringify,
  summarizeStep,
  templatePathFromWorkspaceRoot,
  writeModePreference,
  addOpencodeCacheHint,
} from "./app/utils";
import {
  buildTemplateDraft,
  createTemplateRecord,
  resetTemplateDraft,
} from "./app/templates";
import { createUpdaterState } from "./app/updater";
import { createSessionStore } from "./app/session";
import { createExtensionsStore } from "./app/extensions";
import { createWorkspaceStore } from "./app/workspace";
import {
  updaterEnvironment,
  workspaceTemplateDelete,
  workspaceTemplateWrite,
  resetOpenworkState,
  resetOpencodeCache,
  readOpencodeConfig,
  writeOpencodeConfig,
} from "./lib/tauri";

export default function App() {
  const [view, _setView] = createSignal<View>("onboarding");
  const [creatingSession, setCreatingSession] = createSignal(false);
  const [sessionViewLockUntil, setSessionViewLockUntil] = createSignal(0);
  const setView = (next: View) => {
    // Guard: Don't allow view to change to dashboard while creating session.
    if (next === "dashboard" && creatingSession()) {
      return;
    }
    if (next === "dashboard" && Date.now() < sessionViewLockUntil()) {
      return;
    }
    _setView(next);
  };
  const [mode, setMode] = createSignal<Mode | null>(null);
  const [onboardingStep, setOnboardingStep] =
    createSignal<OnboardingStep>("mode");
  const [rememberModeChoice, setRememberModeChoice] = createSignal(false);
  const [tab, setTab] = createSignal<DashboardTab>("home");

  const [engineSource, setEngineSource] = createSignal<"path" | "sidecar">(
    "path"
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
  const [developerMode, setDeveloperMode] = createSignal(false);

  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(
    null
  );
  const [sessionModelOverrideById, setSessionModelOverrideById] = createSignal<
    Record<string, ModelRef>
  >({});
  const [sessionModelById, setSessionModelById] = createSignal<
    Record<string, ModelRef>
  >({});

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
  const [demoSequence, setDemoSequence] =
    createSignal<DemoSequence>("cold-open");

  const [demoSessions, setDemoSessions] = createSignal<
    ReturnType<typeof sessions>
  >([]);
  const [demoSessionStatusById, setDemoSessionStatusById] = createSignal<
    Record<string, string>
  >({});
  const [demoMessages, setDemoMessages] = createSignal<MessageWithParts[]>([]);
  const [demoTodos, setDemoTodos] = createSignal<TodoItem[]>([]);
  const [demoArtifacts, setDemoArtifacts] = createSignal<
    ReturnType<typeof deriveArtifacts>
  >([]);
  const [demoSelectedSessionId, setDemoSelectedSessionId] = createSignal<
    string | null
  >(null);
  const [demoWorkingFiles, setDemoWorkingFiles] = createSignal<string[]>([]);
  const [demoAuthorizedDirs, setDemoAuthorizedDirs] = createSignal<string[]>(
    []
  );
  const [demoActiveWorkspaceDisplay, setDemoActiveWorkspaceDisplay] =
    createSignal<WorkspaceDisplay>({
    id: "demo",
    name: "Demo",
    path: "~/OpenWork Demo",
    preset: "starter",
  });

  const isDemoMode = createMemo(() => demoMode());

  function setDemoSequenceState(sequence: DemoSequence) {
    const now = Date.now();

    setDemoSelectedSessionId(null);

    const makeToolPart = (
      tool: string,
      title: string,
      output: string,
      path?: string
    ) =>
      ({
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

    const makeTextPart = (text: string) =>
      ({
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
        makeTextPart(
          "Scheduled weekly finance recap and prepared the grocery draft."
        ),
        makeToolPart(
          "schedule_job",
          "Scheduled weekly finance recap",
          "Next run: Monday 9:00 AM"
        ),
        makeToolPart(
          "read",
          "Summarized meeting notes",
          "Generated notes summary: highlights + follow-ups.",
          "notes/summary.md"
        ),
        makeToolPart(
          "write",
          "Prepared grocery order",
          "Cart ready with 14 items.",
          "home/grocery-list.md"
        ),
      ];

      const messages = [
        {
          info: baseUser,
          parts: [{ type: "text", text: "Run the weekly stack." } as any],
        },
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
        {
          id: "cold-1",
          content: "Schedule recurring recap",
          status: "completed",
          priority: "high",
        },
        {
          id: "cold-2",
          content: "Summarize notes",
          status: "completed",
          priority: "medium",
        },
        {
          id: "cold-3",
          content: "Prepare grocery order",
          status: "completed",
          priority: "medium",
        },
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
          "Next run: Monday 9:00 AM"
        ),
        makeToolPart(
          "schedule_job",
          "Weekly report export",
          "Next run: Friday 4:00 PM"
        ),
      ];

      const messages = [
        {
          info: baseUser,
          parts: [{ type: "text", text: "Set up weekly finance jobs." } as any],
        },
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
        {
          id: "sched-1",
          content: "Create weekly recap",
          status: "completed",
          priority: "high",
        },
        {
          id: "sched-2",
          content: "Schedule export",
          status: "completed",
          priority: "medium",
        },
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
        makeTextPart(
          "Compiled the latest meeting notes and flagged action items."
        ),
        makeToolPart(
          "read",
          "Summarized Q1 planning notes",
          "Summary saved with 6 action items.",
          "notes/summary.md"
        ),
        makeToolPart(
          "write",
          "Created follow-up list",
          "Action items captured in follow-ups.md",
          "notes/follow-ups.md"
        ),
      ];

      const messages = [
        {
          info: baseUser,
          parts: [{ type: "text", text: "Summarize the latest notes." } as any],
        },
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
        {
          id: "sum-1",
          content: "Read recent notes",
          status: "completed",
          priority: "high",
        },
        {
          id: "sum-2",
          content: "Create summary",
          status: "completed",
          priority: "medium",
        },
        {
          id: "sum-3",
          content: "Publish follow-ups",
          status: "completed",
          priority: "medium",
        },
      ]);
      setDemoAuthorizedDirs(["~/OpenWork Demo/notes"]);
      setDemoSelectedSessionId(baseSession.id);
      const derived = deriveArtifacts(messages as MessageWithParts[]);
      setDemoArtifacts(derived);
      setDemoWorkingFiles(deriveWorkingFiles(derived));
      return;
    }

    const parts = [
      makeTextPart(
        "Prepared a checkout-ready grocery cart from this week's meal plan."
      ),
      makeToolPart(
        "read",
        "Parsed meal plan",
        "Identified 14 ingredients needed.",
        "home/meal-plan.md"
      ),
      makeToolPart(
        "write",
        "Generated grocery list",
        "Grocery list ready for review.",
        "home/grocery-list.md"
      ),
      makeToolPart(
        "tool.browser",
        "Built Instacart draft",
        "Cart ready with 14 items."
      ),
    ];

    const messages = [
      {
        info: baseUser,
        parts: [
          { type: "text", text: "Prep grocery order for this week." } as any,
        ],
      },
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
      {
        id: "gro-1",
        content: "Read meal plan",
        status: "completed",
        priority: "high",
      },
      {
        id: "gro-2",
        content: "Generate list",
        status: "completed",
        priority: "medium",
      },
      {
        id: "gro-3",
        content: "Prepare checkout cart",
        status: "completed",
        priority: "medium",
      },
    ]);
    setDemoAuthorizedDirs(["~/OpenWork Demo/home"]);
    setDemoSelectedSessionId(baseSession.id);
    const derived = deriveArtifacts(messages as MessageWithParts[]);
    setDemoArtifacts(derived);
    setDemoWorkingFiles(deriveWorkingFiles(derived));
  }

  const artifacts = createMemo(() => deriveArtifacts(messages()));
  const workingFiles = createMemo(() => deriveWorkingFiles(artifacts()));

  const activeSessionId = createMemo(() =>
    isDemoMode() ? demoSelectedSessionId() : selectedSessionId()
  );
  const activeSessions = createMemo(() =>
    isDemoMode() ? demoSessions() : sessions()
  );
  const activeSessionStatusById = createMemo(() =>
    isDemoMode() ? demoSessionStatusById() : sessionStatusById()
  );
  const activeMessages = createMemo(() =>
    isDemoMode() ? demoMessages() : messages()
  );
  const activeTodos = createMemo(() => (isDemoMode() ? demoTodos() : todos()));
  const activeArtifacts = createMemo(() =>
    isDemoMode() ? demoArtifacts() : artifacts()
  );
  const activeWorkingFiles = createMemo(() =>
    isDemoMode() ? demoWorkingFiles() : workingFiles()
  );

  const selectDemoSession = (sessionId: string) => {
    setDemoSelectedSessionId(sessionId);
  };

  createEffect(() => {
    if (!isDemoMode()) return;
    setDemoSequenceState(demoSequence());
  });

  const [prompt, setPrompt] = createSignal("");
  const [lastPromptSent, setLastPromptSent] = createSignal("");

  // Helper function to add timeout to async operations
  function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
      )
    ]);
  }

  async function fetchLMStudioModels() {
    try {
      const requestData = {
        url: "http://localhost:1234/v1/models",
        method: "GET",
        headers: {},
        body: null,
      };

      // Add 5-second timeout to prevent hanging
      const response = await withTimeout(
        invoke("http_request", { request: requestData }),
        5000
      ) as any;

      if (response?.status === 200) {
        const data = JSON.parse(response.body);
        return data.data || [];
      }
    } catch (error) {
      console.error("Could not fetch LMStudio models:", error);
    }
    return [];
  }

  async function sendLMStudioPrompt(content: string, sessionID: string, modelID: string) {
    const userMessageId = `lmstudio-user-${Date.now()}`;
    const assistantMessageId = `lmstudio-assistant-${Date.now() + 1}`;

    try {
      // Add user message to chat
      const userMessage = {
        info: {
          id: userMessageId,
          sessionID: sessionID,
          role: "user",
          time: { created: Date.now() },
          model: { providerID: "lmstudio", modelID: modelID }
        },
        parts: [{
          id: `${userMessageId}-part`,
          messageID: userMessageId,
          sessionID: sessionID,
          type: "text",
          text: content
        }]
      };

      setMessages(prev => [...prev, userMessage]);

      // Show progress indicator
      setError(`🤖 LMStudio is thinking... (using ${modelID})`);

      const requestData = {
        url: "http://localhost:1234/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: modelID,
          messages: [{ role: "user", content: content }],
          stream: false,
        }),
      };

      // Increase timeout to 45 seconds for larger models
      const response = await withTimeout(
        invoke("http_request", { request: requestData }),
        45000
      ) as any;

      if (response?.status === 200) {
        const data = JSON.parse(response.body);
        const assistantContent = data.choices[0]?.message?.content || "";

        // Add assistant message to chat
        const assistantMessage = {
          info: {
            id: assistantMessageId,
            sessionID: sessionID,
            role: "assistant",
            time: { created: Date.now() },
          },
          parts: [{
            id: `${assistantMessageId}-part`,
            messageID: assistantMessageId,
            sessionID: sessionID,
            type: "text",
            text: assistantContent
          }]
        };

        setMessages(prev => [...prev, assistantMessage]);

        // Clear any previous errors
        setError(null);
      } else {
        throw new Error(`HTTP ${response?.status || 'Unknown'}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (errorMessage.includes("Timeout")) {
        setError(`⏱️ LMStudio timeout: The model took longer than 45 seconds to respond. This can happen with larger models. Try again or check if LMStudio is running at localhost:1234.`);
      } else {
        setError(`❌ LMStudio error: ${errorMessage}`);
      }
    }
  }

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

      // Handle LMStudio provider with direct API call
      if (model.providerID === "lmstudio") {
        // Show a simple notification that LMStudio is being used
        setError(`Using LMStudio model: ${model.modelID}`);
        await sendLMStudioPrompt(content, sessionID, model.modelID);
      } else {
        await c.session.promptAsync({
          sessionID,
          model,
          variant: modelVariant() ?? undefined,
          parts: [{ type: "text", text: content }],
        });
      }

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
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      setError(addOpencodeCacheHint(message));
    } finally {
      setBusy(false);
      setBusyLabel(null);
      setBusyStartedAt(null);
    }
  }

  const [templates, setTemplates] = createSignal<WorkspaceTemplate[]>([]);
  const [workspaceTemplatesLoaded, setWorkspaceTemplatesLoaded] =
    createSignal(false);
  const [globalTemplatesLoaded, setGlobalTemplatesLoaded] = createSignal(false);

  const [templateModalOpen, setTemplateModalOpen] = createSignal(false);
  const [templateDraftTitle, setTemplateDraftTitle] = createSignal("");
  const [templateDraftDescription, setTemplateDraftDescription] =
    createSignal("");
  const [templateDraftPrompt, setTemplateDraftPrompt] = createSignal("");
  const [templateDraftScope, setTemplateDraftScope] = createSignal<
    "workspace" | "global"
  >("workspace");

  const workspaceTemplates = createMemo(() =>
    templates().filter((t) => t.scope === "workspace")
  );
  const globalTemplates = createMemo(() =>
    templates().filter((t) => t.scope === "global")
  );

  async function respondPermissionAndRemember(
    requestID: string,
    reply: "once" | "always" | "reject"
  ) {
    // Intentional no-op: permission prompts grant session-scoped access only.
    // Persistent workspace roots must be managed explicitly via workspace settings.
    await respondPermission(requestID, reply);
  }

  const [reloadRequired, setReloadRequired] = createSignal(false);
  const [reloadReasons, setReloadReasons] = createSignal<ReloadReason[]>([]);
  const [reloadLastTriggeredAt, setReloadLastTriggeredAt] = createSignal<
    number | null
  >(null);
  const [reloadBusy, setReloadBusy] = createSignal(false);
  const [reloadError, setReloadError] = createSignal<string | null>(null);
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
  const [selectedMcp, setSelectedMcp] = createSignal<string | null>(null);
  const [advancedMcpName, setAdvancedMcpName] = createSignal("");
  const [advancedMcpUrl, setAdvancedMcpUrl] = createSignal("");
  const [advancedMcpOAuth, setAdvancedMcpOAuth] = createSignal(true);
  const [advancedMcpEnabled, setAdvancedMcpEnabled] = createSignal(true);
  const [cacheRepairBusy, setCacheRepairBusy] = createSignal(false);
  const [cacheRepairResult, setCacheRepairResult] = createSignal<string | null>(
    null
  );
  const advancedCommand = createMemo(() => "opencode mcp add");

  const advancedAuthCommand = createMemo(() => {
    const name = advancedMcpName().trim() || "my-mcp";
    return `opencode mcp auth ${name}`;
  });


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
    abortRefreshes,
  } = extensionsStore;

  const [providers, setProviders] = createSignal<Provider[]>([]);
  const [providerDefaults, setProviderDefaults] = createSignal<
    Record<string, string>
  >({});
  const [providerConnectedIds, setProviderConnectedIds] = createSignal<
    string[]
  >([]);

  const [defaultModel, setDefaultModel] = createSignal<ModelRef>(DEFAULT_MODEL);
  const [modelPickerOpen, setModelPickerOpen] = createSignal(false);
  const [modelPickerTarget, setModelPickerTarget] = createSignal<
    "session" | "default"
  >("session");
  const [modelPickerQuery, setModelPickerQuery] = createSignal("");

  const [showThinking, setShowThinking] = createSignal(false);
  const [modelVariant, setModelVariant] = createSignal<string | null>(null);

  function openTemplateModal() {
    const seedTitle = selectedSession()?.title ?? "";
    const seedPrompt = lastPromptSent() || prompt();
    const nextDraft = buildTemplateDraft({
      seedTitle,
      seedPrompt,
      scope: "workspace",
    });

    resetTemplateDraft(
      {
        setTitle: setTemplateDraftTitle,
        setDescription: setTemplateDraftDescription,
        setPrompt: setTemplateDraftPrompt,
        setScope: setTemplateDraftScope,
      },
      nextDraft.scope
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
    setBusyLabel(
      draft.scope === "workspace"
        ? "Saving workspace template"
        : "Saving template"
    );
    setBusyStartedAt(Date.now());
    setError(null);

    try {
      const template = createTemplateRecord(draft);

      if (draft.scope === "workspace") {
        const workspaceRoot = workspaceStore.activeWorkspaceRoot().trim();
        await workspaceTemplateWrite({
          workspacePath: workspaceRoot,
          template,
        });
        await loadWorkspaceTemplates({ workspaceRoot, quiet: true });
      } else {
        setTemplates((current) => [template, ...current]);
        setGlobalTemplatesLoaded(true);
      }

      setTemplateModalOpen(false);
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      setError(addOpencodeCacheHint(message));
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
        await workspaceTemplateDelete({
          workspacePath: workspaceRoot,
          templateId,
        });
        await loadWorkspaceTemplates({ workspaceRoot, quiet: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      setError(addOpencodeCacheHint(message));
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
        await c.session.create({
          title: template.title,
          directory: workspaceStore.activeWorkspaceRoot().trim(),
        })
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
      const message = e instanceof Error ? e.message : "Unknown error";
      setError(addOpencodeCacheHint(message));
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
  const [resetModalMode, setResetModalMode] =
    createSignal<ResetOpenworkMode>("onboarding");
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
    if (
      busy() &&
      (label === "Connecting" ||
        label === "Starting engine" ||
        label === "Disconnecting")
    ) {
      return true;
    }

    return busy();
  });

  const filteredPackages = createMemo(() => {
    const query = packageSearch().trim().toLowerCase();
    if (!query) return CURATED_PACKAGES;

    return CURATED_PACKAGES.filter((pkg) => {
      const haystack = [
        pkg.name,
        pkg.source,
        pkg.description,
        pkg.tags.join(" "),
      ]
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

  const selectedSessionModelLabel = createMemo(() =>
    formatModelLabel(selectedSessionModel(), providers())
  );

  const modelPickerCurrent = createMemo(() =>
    modelPickerTarget() === "default" ? defaultModel() : selectedSessionModel()
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
        const footerBits: string[] = [];
        if (defaultModelID === model.id) footerBits.push("Default");
        if (isFree) footerBits.push("Free");
        if (model.capabilities?.reasoning) footerBits.push("Reasoning");

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
    return sessions().some(
      (s) => statuses[s.id] === "running" || statuses[s.id] === "retry"
    );
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
      const message = e instanceof Error ? e.message : safeStringify(e);
      setError(addOpencodeCacheHint(message));
      setResetModalBusy(false);
    }
  }

  function markReloadRequired(reason: ReloadReason) {
    setReloadRequired(true);
    setReloadLastTriggeredAt(Date.now());
    setReloadReasons((current) =>
      current.includes(reason) ? current : [...current, reason]
    );
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

    if (reasons.length === 1 && reasons[0] === "mcp") {
      return {
        title: "Reload required",
        body: "OpenCode loads MCP servers at startup. Reload the engine to activate the new connection.",
      };
    }

    return {
      title: "Reload required",
      body: "OpenWork detected plugin/skill/MCP changes. Reload the engine to apply them.",
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
      setReloadError(
        "A run is in progress. Stop it before reloading the engine."
      );
      return;
    }

    setReloadBusy(true);
    setReloadError(null);

    try {
      unwrap(await c.instance.dispose());
      await waitForHealthy(c, { timeoutMs: 12_000 });

      // Fetch real LMStudio models with timeout
      let lmStudioModels: any[] = [];
      let lmStudioProvider = null;

      try {
        lmStudioModels = await withTimeout(fetchLMStudioModels(), 5000);
        if (lmStudioModels.length > 0) {
          lmStudioProvider = createLMStudioProvider(lmStudioModels);
        }
      } catch (error) {
        console.error("Failed to load LMStudio models:", error);
        // Continue without LMStudio if it fails
      }

      try {
        const providerList = unwrap(await c.provider.list());
        const allProviders = lmStudioProvider
          ? [...(providerList.all as unknown as Provider[]), lmStudioProvider as unknown as Provider]
          : providerList.all as unknown as Provider[];
        setProviders(allProviders);

        const firstModel = lmStudioModels[0]?.id || "local-model";
        const defaults = lmStudioProvider
          ? { ...providerList.default, lmstudio: firstModel }
          : providerList.default;
        setProviderDefaults(defaults);

        const connected = lmStudioProvider
          ? [...providerList.connected, "lmstudio"]
          : providerList.connected;
        setProviderConnectedIds(connected);
      } catch {
        try {
          const cfg = unwrap(await c.config.providers());
          const allProviders = lmStudioProvider
            ? [...cfg.providers, lmStudioProvider as unknown as Provider]
            : cfg.providers;
          setProviders(allProviders);

          const firstModel = lmStudioModels[0]?.id || "local-model";
          const defaults = lmStudioProvider
            ? { ...cfg.default, lmstudio: firstModel }
            : cfg.default;
          setProviderDefaults(defaults);

          setProviderConnectedIds(lmStudioProvider ? ["lmstudio"] : []);
        } catch {
          if (lmStudioProvider) {
            setProviders([lmStudioProvider as unknown as Provider]);
            setProviderDefaults({ lmstudio: lmStudioModels[0]?.id || "local-model" });
            setProviderConnectedIds(["lmstudio"]);
          } else {
            setProviders([]);
            setProviderDefaults({});
            setProviderConnectedIds([]);
          }
        }
      }

      await refreshPlugins("project").catch(() => undefined);
      await refreshSkills().catch(() => undefined);

      let nextStatus = notionStatus();
      if (notionStatus() === "connecting") {
        nextStatus = "connected";
        setNotionStatus(nextStatus);
      }

      if (nextStatus === "connected") {
        setNotionStatusDetail((detail) => detail ?? "Workspace connected");
      }

      try {
        window.localStorage.setItem("openwork.notionStatus", nextStatus);
        if (nextStatus === "connected" && notionStatusDetail()) {
          window.localStorage.setItem("openwork.notionStatusDetail", notionStatusDetail() || "");
        }
      } catch {
        // ignore
      }

      clearReloadRequired();
      if (notionIsActive() && notionSkillInstalled()) {
        setTryNotionPromptVisible(true);
      }
    } catch (e) {
      setReloadError(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setReloadBusy(false);
    }
  }

  async function repairOpencodeCache() {
    if (!isTauriRuntime()) {
      setCacheRepairResult("Cache repair requires the desktop app.");
      return;
    }

    if (cacheRepairBusy()) return;

    setCacheRepairBusy(true);
    setCacheRepairResult(null);
    setError(null);

    try {
      const result = await resetOpencodeCache();
      if (result.errors.length) {
        setCacheRepairResult(result.errors[0]);
        return;
      }

      if (result.removed.length) {
        setCacheRepairResult(
          "OpenCode cache repaired. Restart the engine if it was running."
        );
      } else {
        setCacheRepairResult("No OpenCode cache found. Nothing to repair.");
      }
    } catch (e) {
      setCacheRepairResult(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setCacheRepairBusy(false);
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
              ? (
                  updateStatus() as {
                    state: "idle";
                    lastCheckedAt: number | null;
                  }
                ).lastCheckedAt
              : null,
          message:
            env.reason ?? "Updates are not supported in this environment.",
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
    const lastCheckedAt =
      state.state === "available" ? state.lastCheckedAt : Date.now();

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
              record.data && typeof record.data.contentLength === "number"
                ? record.data.contentLength
                : null;
            return { ...current, totalBytes: total };
          }

          if (record.event === "Progress") {
            const chunk =
              record.data && typeof record.data.chunkLength === "number"
                ? record.data.chunkLength
                : 0;
            return {
              ...current,
              downloadedBytes: current.downloadedBytes + chunk,
            };
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
    setNotionStatusDetail("Reload required");
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
      setNotionStatusDetail("Reload required");
      try {
        window.localStorage.setItem("openwork.notionStatus", "connecting");
        window.localStorage.setItem("openwork.notionStatusDetail", "Reload required");
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
    if (!isTauriRuntime()) {
      setMcpStatus("MCP configuration is only available in Host mode.");
      setMcpServers([]);
      return;
    }

    const projectDir = workspaceProjectDir().trim();
    if (!projectDir) {
      setMcpStatus("Pick a workspace folder to load MCP servers.");
      setMcpServers([]);
      return;
    }

    try {
      setMcpStatus(null);
      const config = await readOpencodeConfig("project", projectDir);
      if (!config.exists || !config.content) {
        setMcpServers([]);
        setMcpStatus("No opencode.json found yet. Add an MCP to create one.");
        return;
      }

      const next = parseMcpServersFromContent(config.content);
      setMcpServers(next);
      setMcpLastUpdatedAt(Date.now());
      if (!next.length) {
        setMcpStatus("No MCP servers configured yet.");
      }
    } catch (e) {
      setMcpServers([]);
      setMcpStatus(e instanceof Error ? e.message : "Failed to load MCP servers");
    }
  }

  async function connectMcp(entry: (typeof MCP_QUICK_CONNECT)[number]) {
    if (mode() !== "host") {
      setMcpStatus("MCP connections are only available in Host mode.");
      return;
    }

    const projectDir = workspaceProjectDir().trim();
    if (!projectDir) {
      setMcpStatus("Pick a workspace folder first.");
      return;
    }

    if (!isTauriRuntime()) {
      setMcpStatus("MCP connections require the desktop app.");
      return;
    }

    try {
      setMcpStatus(null);
      const config = await readOpencodeConfig("project", projectDir);
      const raw = config.content ?? "";
      const nextConfig = raw.trim()
        ? (parse(raw) as Record<string, unknown>)
        : { $schema: "https://opencode.ai/config.json" };

      const mcp = typeof nextConfig.mcp === "object" && nextConfig.mcp ? { ...(nextConfig.mcp as Record<string, unknown>) } : {};
      const slug = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      mcp[slug] = {
        type: "remote",
        url: entry.url,
        enabled: true,
        ...(entry.oauth ? { oauth: {} } : {}),
      };

      nextConfig.mcp = mcp;
      const formatted = JSON.stringify(nextConfig, null, 2);

      const result = await writeOpencodeConfig("project", projectDir, `${formatted}\n`);
      if (!result.ok) {
        throw new Error(result.stderr || result.stdout || "Failed to update opencode.json");
      }

      markReloadRequired("mcp");
      setMcpStatus("Reload required to activate the new MCP.");
      await refreshMcpServers();
    } catch (e) {
      setMcpStatus(e instanceof Error ? e.message : "Failed to connect MCP.");
    }
  }

  async function addAdvancedMcp() {
    const name = advancedMcpName().trim();
    const url = advancedMcpUrl().trim();

    if (!name || !url) {
      setMcpStatus("Enter a server name and URL.");
      return;
    }

    const projectDir = workspaceProjectDir().trim();
    if (!projectDir) {
      setMcpStatus("Pick a workspace folder first.");
      return;
    }

    try {
      const config = await readOpencodeConfig("project", projectDir);
      const raw = config.content ?? "";
      const nextConfig = raw.trim()
        ? (parse(raw) as Record<string, unknown>)
        : { $schema: "https://opencode.ai/config.json" };

      const mcp = typeof nextConfig.mcp === "object" && nextConfig.mcp ? { ...(nextConfig.mcp as Record<string, unknown>) } : {};
      mcp[name] = {
        type: "remote",
        url,
        enabled: advancedMcpEnabled(),
        ...(advancedMcpOAuth() ? { oauth: {} } : { oauth: false }),
      };

      nextConfig.mcp = mcp;
      const formatted = JSON.stringify(nextConfig, null, 2);

      const result = await writeOpencodeConfig("project", projectDir, `${formatted}\n`);
      if (!result.ok) {
        throw new Error(result.stderr || result.stdout || "Failed to update opencode.json");
      }

      markReloadRequired("mcp");
      setMcpStatus("Reload required to activate the new MCP.");
      setAdvancedMcpName("");
      setAdvancedMcpUrl("");
      await refreshMcpServers();
    } catch (e) {
      setMcpStatus(e instanceof Error ? e.message : "Failed to add MCP.");
    }
  }

  async function testAdvancedMcp() {
    if (!advancedMcpUrl().trim()) {
      setMcpStatus("Enter a server URL first.");
      return;
    }

    setMcpStatus("Use opencode mcp debug <name> to validate connection.");
  }

  async function createSessionAndOpen() {
    console.log("[DEBUG] createSessionAndOpen");
    console.log("[DEBUG] current baseUrl:", baseUrl());
    console.log("[DEBUG] engine info:", engine());
    if (isDemoMode()) {
      setView("session");
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
    setBusyLabel("Creating new task");
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
        throw new Error("Server connection lost. Please reload.");
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
      setBusyLabel("Loading session");
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
      setView("session");
    } catch (e) {
      mark("error caught", e);
      const message = e instanceof Error ? e.message : "Unknown error";
      setError(addOpencodeCacheHint(message));
    } finally {
      setCreatingSession(false);
      setBusy(false);
    }
  }

  async function loadWorkspaceTemplates(options?: {
    workspaceRoot?: string;
    quiet?: boolean;
  }) {
    const c = client();
    const root = (
      options?.workspaceRoot ?? workspaceStore.activeWorkspaceRoot()
    ).trim();
    if (!c || !root) return;

    try {
      const templatesPath = ".openwork/templates";
      const nodes = unwrap(
        await c.file.list({ directory: root, path: templatesPath })
      );
      const entries = nodes.filter((n) => !n.ignored);
      const templateFiles = entries.filter((n) => n.type === "file");
      const templateDirs = entries.filter((n) => n.type === "directory");

      const loaded: WorkspaceTemplate[] = [];
      const seenIds = new Set<string>();

      const pushTemplate = (template: WorkspaceTemplate) => {
        if (seenIds.has(template.id)) return;
        seenIds.add(template.id);
        loaded.push(template);
      };

      const parseTemplateContent = (raw: string, fallbackId: string) => {
        const parsedFrontmatter = parseTemplateFrontmatter(raw);
        if (parsedFrontmatter) {
          const meta = parsedFrontmatter.data;
          const title =
            typeof meta.title === "string" ? meta.title : "Untitled";
          const promptText = parsedFrontmatter.body ?? "";
          if (!promptText.trim()) return false;

          const createdAtValue = Number(meta.createdAt);
          pushTemplate({
            id: typeof meta.id === "string" ? meta.id : fallbackId,
            title,
            description:
              typeof meta.description === "string" ? meta.description : "",
            prompt: promptText,
            createdAt:
              Number.isFinite(createdAtValue) && createdAtValue > 0
                ? createdAtValue
                : Date.now(),
            scope: "workspace",
          });
          return true;
        }

        const parsed = safeParseJson<
          Partial<WorkspaceTemplate> & Record<string, unknown>
        >(raw);
        if (!parsed) return false;

        const title =
          typeof parsed.title === "string" ? parsed.title : "Untitled";
        const promptText =
          typeof parsed.prompt === "string" ? parsed.prompt : "";
        if (!promptText.trim()) return false;

        pushTemplate({
          id: typeof parsed.id === "string" ? parsed.id : fallbackId,
          title,
          description:
            typeof parsed.description === "string" ? parsed.description : "",
          prompt: promptText,
          createdAt:
            typeof parsed.createdAt === "number"
              ? parsed.createdAt
              : Date.now(),
          scope: "workspace",
        });

        return true;
      };

      const readTemplatePath = async (path: string, fallbackId: string) => {
        try {
          const content = unwrap(await c.file.read({ directory: root, path }));
          if (content.type !== "text") return false;
          return parseTemplateContent(content.content, fallbackId);
        } catch {
          return false;
        }
      };

      for (const dir of templateDirs) {
        const basePath = `${templatesPath}/${dir.name}`;
        const candidates = [
          `${basePath}/template.yml`,
          `${basePath}/template.yaml`,
          `${basePath}/template.json`,
        ];
        for (const candidate of candidates) {
          const loadedTemplate = await readTemplatePath(candidate, dir.name);
          if (loadedTemplate) break;
        }
      }

      const frontmatterFiles = templateFiles.filter((n) =>
        /\.(yml|yaml)$/i.test(n.name)
      );
      const jsonFiles = templateFiles.filter((n) =>
        n.name.toLowerCase().endsWith(".json")
      );

      for (const node of frontmatterFiles) {
        const fallbackId = node.name.replace(/\.(yml|yaml)$/i, "");
        await readTemplatePath(node.path, fallbackId);
      }

      for (const node of jsonFiles) {
        const fallbackId = node.name.replace(/\.json$/i, "");
        await readTemplatePath(node.path, fallbackId);
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
        const message = e instanceof Error ? e.message : safeStringify(e);
        setError(addOpencodeCacheHint(message));
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
        } else {
          setDefaultModel(DEFAULT_MODEL);
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
          setModelVariant(storedVariant.trim());
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

      // Mark global templates as loaded even if nothing was stored.
      setGlobalTemplatesLoaded(true);

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

      window.localStorage.setItem(
        "openwork.templates",
        JSON.stringify(payload)
      );
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
        scope
      ),
    openTemplateModal,
    runTemplate,
    deleteTemplate,
    refreshSkills: () => refreshSkills().catch(() => undefined),
    refreshPlugins: (scopeOverride?: PluginScope) =>
      refreshPlugins(scopeOverride).catch(() => undefined),
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
        modelVariant() ?? ""
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
    selectedMcp: selectedMcp(),
    setSelectedMcp,
    quickConnect: MCP_QUICK_CONNECT,
    connectMcp,
    addAdvancedMcp,
    testAdvancedMcp,
    refreshMcpServers,
    advancedName: advancedMcpName(),
    setAdvancedName: setAdvancedMcpName,
    advancedUrl: advancedMcpUrl(),
    setAdvancedUrl: setAdvancedMcpUrl,
    advancedOAuth: advancedMcpOAuth(),
    setAdvancedOAuth: setAdvancedMcpOAuth,
    advancedEnabled: advancedMcpEnabled(),
    setAdvancedEnabled: setAdvancedMcpEnabled,
    advancedCommand: advancedCommand(),
    advancedAuthCommand: advancedAuthCommand(),
  });

  return (
    <>
      <Show
        when={client()}
        fallback={<OnboardingView {...onboardingProps()} />}
      >
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
                showTryNotionPrompt={tryNotionPromptVisible() && notionIsActive()}
                onTryNotionPrompt={() => {
                  setPrompt("setup my crm");
                  setTryNotionPromptVisible(false);
                  setNotionSkillInstalled(true);
                  try {
                    window.localStorage.setItem("openwork.notionSkillInstalled", "1");
                  } catch {
                    // ignore
                  }
                }}
                sessionStatus={selectedSessionStatus()}
              error={error()}
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
        canReset={
          !resetModalBusy() &&
          !anyActiveRuns() &&
          resetModalText().trim().toUpperCase() === "RESET"
        }
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

      <WorkspacePicker
        open={workspaceStore.workspacePickerOpen()}
        workspaces={workspaceStore.filteredWorkspaces()}
        activeWorkspaceId={workspaceStore.activeWorkspaceId()}
        search={workspaceStore.workspaceSearch()}
        onSearch={workspaceStore.setWorkspaceSearch}
        onClose={() => workspaceStore.setWorkspacePickerOpen(false)}
        onSelect={workspaceStore.activateWorkspace}
        onCreateNew={() => workspaceStore.setCreateWorkspaceOpen(true)}
      />

      <CreateWorkspaceModal
        open={workspaceStore.createWorkspaceOpen()}
        onClose={() => workspaceStore.setCreateWorkspaceOpen(false)}
        onPickFolder={workspaceStore.pickWorkspaceFolder}
        onConfirm={(preset, folder) =>
          workspaceStore.createWorkspaceFlow(preset, folder)
        }
      />
    </>
  );
}
