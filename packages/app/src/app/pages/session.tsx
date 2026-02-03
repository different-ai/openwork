import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { Agent, Part } from "@opencode-ai/sdk/v2/client";
import type {
  ArtifactItem,
  DashboardTab,
  ComposerDraft,
  CommandRegistryItem,
  CommandTriggerContext,
  MessageGroup,
  MessageWithParts,
  McpServerEntry,
  McpStatusMap,
  PendingPermission,
  ProviderListItem,
  SettingsTab,
  SkillCard,
  TodoItem,
  View,
  WorkspaceCommand,
  WorkspaceDisplay,
} from "../types";

import { ArrowRight, ChevronDown, HardDrive, Shield, Zap } from "lucide-solid";

import Button from "../components/button";
import RenameSessionModal from "../components/rename-session-modal";
import WorkspaceChip from "../components/workspace-chip";
import ProviderAuthModal from "../components/provider-auth-modal";
import StatusBar from "../components/status-bar";
import type { OpenworkServerStatus } from "../lib/openwork-server";
import { join } from "@tauri-apps/api/path";
import browserSetupCommandTemplate from "../data/commands/browser-setup.md?raw";
import { opencodeCommandWrite } from "../lib/tauri";
import { isTauriRuntime, parseTemplateFrontmatter } from "../utils";

import MessageList from "../components/session/message-list";
import Composer from "../components/session/composer";
import SessionSidebar, { type SidebarSectionState } from "../components/session/sidebar";
import ContextPanel from "../components/session/context-panel";
import FlyoutItem from "../components/flyout-item";

export type SessionViewProps = {
  selectedSessionId: string | null;
  setView: (view: View, sessionId?: string) => void;
  setTab: (tab: DashboardTab) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  activeWorkspaceDisplay: WorkspaceDisplay;
  activeWorkspaceRoot: string;
  setWorkspaceSearch: (value: string) => void;
  setWorkspacePickerOpen: (open: boolean) => void;
  clientConnected: boolean;
  openworkServerStatus: OpenworkServerStatus;
  stopHost: () => void;
  headerStatus: string;
  busyHint: string | null;
  createSessionAndOpen: () => void;
  sendPromptAsync: (draft: ComposerDraft) => Promise<void>;
  newTaskDisabled: boolean;
  sessions: Array<{ id: string; title: string; slug?: string | null; workspaceLabel?: string | null }>;
  selectSession: (sessionId: string) => Promise<void> | void;
  messages: MessageWithParts[];
  todos: TodoItem[];
  busyLabel: string | null;
  developerMode: boolean;
  showThinking: boolean;
  groupMessageParts: (parts: Part[], messageId: string) => MessageGroup[];
  summarizeStep: (part: Part) => { title: string; detail?: string };
  expandedStepIds: Set<string>;
  setExpandedStepIds: (updater: (current: Set<string>) => Set<string>) => Set<string>;
  expandedSidebarSections: SidebarSectionState;
  setExpandedSidebarSections: (
    updater: (current: SidebarSectionState) => SidebarSectionState,
  ) => SidebarSectionState;
  artifacts: ArtifactItem[];
  workingFiles: string[];
  authorizedDirs: string[];
  activePlugins: string[];
  activePluginStatus: string | null;
  mcpServers: McpServerEntry[];
  mcpStatuses: McpStatusMap;
  mcpStatus: string | null;
  skills: SkillCard[];
  skillsStatus: string | null;
  busy: boolean;
  prompt: string;
  setPrompt: (value: string) => void;
  selectedSessionModelLabel: string;
  openSessionModelPicker: () => void;
  modelVariantLabel: string;
  modelVariant: string | null;
  setModelVariant: (value: string) => void;
  activePermission: PendingPermission | null;
  showTryNotionPrompt: boolean;
  onTryNotionPrompt: () => void;
  permissionReplyBusy: boolean;
  respondPermission: (requestID: string, reply: "once" | "always" | "reject") => void;
  respondPermissionAndRemember: (requestID: string, reply: "once" | "always" | "reject") => void;
  safeStringify: (value: unknown) => string;
  error: string | null;
  sessionStatus: string;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  openConnect: () => void;
  startProviderAuth: (providerId?: string) => Promise<string>;
  submitProviderApiKey: (providerId: string, apiKey: string) => Promise<string | void>;
  openProviderAuthModal: () => Promise<void>;
  closeProviderAuthModal: () => void;
  providerAuthModalOpen: boolean;
  providerAuthBusy: boolean;
  providerAuthError: string | null;
  providerAuthMethods: Record<string, { type: "oauth" | "api"; label: string }[]>;
  providers: ProviderListItem[];
  providerConnectedIds: string[];
  listAgents: () => Promise<Agent[]>;
  searchFiles: (query: string) => Promise<string[]>;
  selectedSessionAgent: string | null;
  setSessionAgent: (sessionId: string, agent: string | null) => void;
  saveSession: (sessionId: string) => Promise<string>;
  sessionStatusById: Record<string, string>;
  commands: WorkspaceCommand[];
  runCommand: (command: WorkspaceCommand, details?: string) => Promise<void>;
  openCommandRunModal: (command: WorkspaceCommand) => void;
  commandRegistryItems: () => CommandRegistryItem[];
  registerCommand: (command: CommandRegistryItem) => () => void;
  deleteSession: (sessionId: string) => Promise<void>;
};

export default function SessionView(props: SessionViewProps) {
  let messagesEndEl: HTMLDivElement | undefined;
  let chatContainerEl: HTMLDivElement | undefined;
  let agentPickerRef: HTMLDivElement | undefined;

  const [commandToast, setCommandToast] = createSignal<string | null>(null);
  const [providerAuthActionBusy, setProviderAuthActionBusy] = createSignal(false);
  const [renameModalOpen, setRenameModalOpen] = createSignal(false);
  const [renameTitle, setRenameTitle] = createSignal("");
  const [renameBusy, setRenameBusy] = createSignal(false);
  const [deleteBusy, setDeleteBusy] = createSignal(false);
  const [agentPickerOpen, setAgentPickerOpen] = createSignal(false);
  const [agentPickerBusy, setAgentPickerBusy] = createSignal(false);
  const [agentPickerReady, setAgentPickerReady] = createSignal(false);
  const [agentPickerError, setAgentPickerError] = createSignal<string | null>(null);
  const [agentOptions, setAgentOptions] = createSignal<Agent[]>([]);
  const [autoScrollEnabled, setAutoScrollEnabled] = createSignal(false);
  const [scrollOnNextUpdate, setScrollOnNextUpdate] = createSignal(false);
  const [unreadCount, setUnreadCount] = createSignal(0);

  const COMMAND_ARGS_RE = /\$(ARGUMENTS|\d+)/i;

  const commandNeedsDetails = (command: { template: string }) => COMMAND_ARGS_RE.test(command.template);

  const agentLabel = createMemo(() => props.selectedSessionAgent ?? "Default agent");

  const isNearBottom = (el: HTMLElement, threshold = 80) => {
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distance <= threshold;
  };

  const scrollToLatest = (behavior: ScrollBehavior = "auto") => {
    messagesEndEl?.scrollIntoView({ behavior, block: "end" });
  };

  const isAbsolutePath = (value: string) =>
    /^(?:[a-zA-Z]:[\\/]|\\\\|\/|~\/)/.test(value.trim());

  const handleWorkingFileClick = async (file: string) => {
    const trimmed = file.trim();
    if (!trimmed) return;

    if (props.activeWorkspaceDisplay.workspaceType === "remote") {
      setCommandToast("File open is unavailable for remote workspaces.");
      return;
    }

    if (!isTauriRuntime()) {
      setCommandToast("File open is available in the desktop app.");
      return;
    }

    try {
      const { openPath } = await import("@tauri-apps/plugin-opener");
      const root = props.activeWorkspaceRoot.trim();
      if (!isAbsolutePath(trimmed) && !root) {
        setCommandToast("Pick a workspace to open files.");
        return;
      }
      const target = !isAbsolutePath(trimmed) && root ? await join(root, trimmed) : trimmed;
      await openPath(target);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to open file";
      setCommandToast(message);
    }
  };

  const buildBrowserSetupCommand = () => {
    const parsed = parseTemplateFrontmatter(browserSetupCommandTemplate);
    const name = parsed?.data.name?.trim() || "browser-setup";
    const description =
      parsed?.data.description?.trim() || "Guide user through Chrome browser automation setup";
    const template = parsed?.body?.trim() || browserSetupCommandTemplate.trim();

    return { name, description, template };
  };

  const ensureBrowserSetupCommand = async (): Promise<WorkspaceCommand | null> => {
    const existing = props.commands.find((item) => item.name === "browser-setup");
    if (existing) return existing;

    if (props.activeWorkspaceDisplay.workspaceType === "remote") {
      setCommandToast("Browser setup command is only available in local workspaces.");
      return null;
    }

    if (!isTauriRuntime()) {
      setCommandToast("Browser setup is available in the desktop app.");
      return null;
    }

    const root = props.activeWorkspaceDisplay.path?.trim() ?? "";
    if (!root) {
      setCommandToast("Pick a workspace folder to install the command.");
      return null;
    }

    try {
      const draft = buildBrowserSetupCommand();
      await opencodeCommandWrite({
        scope: "workspace",
        projectDir: root,
        command: draft,
      });

      return {
        name: draft.name,
        description: draft.description,
        template: draft.template,
        scope: "workspace",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to install browser setup command";
      setCommandToast(message);
      return null;
    }
  };
  const loadAgentOptions = async (force = false) => {
    if (agentPickerBusy()) return agentOptions();
    if (agentPickerReady() && !force) return agentOptions();
    setAgentPickerBusy(true);
    setAgentPickerError(null);
    try {
      const agents = await props.listAgents();
      const sorted = agents.slice().sort((a, b) => a.name.localeCompare(b.name));
      setAgentOptions(sorted);
      setAgentPickerReady(true);
      return sorted;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load agents";
      setAgentPickerError(message);
      setAgentOptions([]);
      return [];
    } finally {
      setAgentPickerBusy(false);
    }
  };

  type Flyout = {
    id: string;
    rect: { top: number; left: number; width: number; height: number };
    targetRect: { top: number; left: number; width: number; height: number };
    label: string;
    icon: "file" | "check" | "folder";
  };
  const [flyouts, setFlyouts] = createSignal<Flyout[]>([]);
  const [prevTodoCount, setPrevTodoCount] = createSignal(0);
  const [prevFileCount, setPrevFileCount] = createSignal(0);
  const [isInitialLoad, setIsInitialLoad] = createSignal(true);
  const [runStartedAt, setRunStartedAt] = createSignal<number | null>(null);
  const [runHasBegun, setRunHasBegun] = createSignal(false);
  const [runTick, setRunTick] = createSignal(Date.now());
  const [runBaseline, setRunBaseline] = createSignal<{ assistantId: string | null; partCount: number }>({
    assistantId: null,
    partCount: 0,
  });
  const [thinkingExpanded, setThinkingExpanded] = createSignal(false);

  const lastAssistantSnapshot = createMemo(() => {
    for (let i = props.messages.length - 1; i >= 0; i -= 1) {
      const msg = props.messages[i];
      const info = msg?.info as { id?: string | number; role?: string } | undefined;
      if (info?.role === "assistant") {
        const id = typeof info.id === "string" ? info.id : typeof info.id === "number" ? String(info.id) : null;
        return { id, partCount: msg.parts.length };
      }
    }
    return { id: null, partCount: 0 };
  });

  const captureRunBaseline = () => {
    const snapshot = lastAssistantSnapshot();
    setRunBaseline({ assistantId: snapshot.id, partCount: snapshot.partCount });
  };

  const startRun = () => {
    if (runStartedAt()) return;
    setRunStartedAt(Date.now());
    setRunHasBegun(false);
    captureRunBaseline();
  };

  const responseStarted = createMemo(() => {
    if (!runStartedAt()) return false;
    const baseline = runBaseline();
    const snapshot = lastAssistantSnapshot();
    if (!snapshot.id && !baseline.assistantId) return false;
    if (snapshot.id && snapshot.id !== baseline.assistantId) return true;
    return snapshot.id === baseline.assistantId && snapshot.partCount > baseline.partCount;
  });

  const runPhase = createMemo(() => {
    if (props.error) return "error";
    const status = props.sessionStatus;
    const started = runStartedAt() !== null;
    if (status === "idle") {
      if (!started) return "idle";
      return responseStarted() ? "responding" : "sending";
    }
    if (status === "retry") return responseStarted() ? "responding" : "retrying";
    if (responseStarted()) return "responding";
    return "thinking";
  });

  const showRunIndicator = createMemo(() => runPhase() !== "idle");

  const latestRunPart = createMemo<Part | null>(() => {
    if (!showRunIndicator()) return null;
    const baseline = runBaseline();
    for (let i = props.messages.length - 1; i >= 0; i -= 1) {
      const msg = props.messages[i];
      const info = msg?.info as { id?: string | number; role?: string } | undefined;
      if (info?.role !== "assistant") continue;
      const messageId =
        typeof info.id === "string" ? info.id : typeof info.id === "number" ? String(info.id) : null;
      if (!messageId) continue;
      if (baseline.assistantId && messageId === baseline.assistantId && msg.parts.length <= baseline.partCount) {
        continue;
      }
      if (!msg.parts.length) continue;
      return msg.parts[msg.parts.length - 1] ?? null;
    }
    return null;
  });

  const computeStatusFromPart = (part: Part | null) => {
    if (!part) return null;
    if (part.type === "tool") {
      const record = part as any;
      const tool = typeof record.tool === "string" ? record.tool : "";
      switch (tool) {
        case "task":
          return "Delegating";
        case "todowrite":
        case "todoread":
          return "Planning";
        case "read":
          return "Gathering context";
        case "list":
        case "grep":
        case "glob":
          return "Searching codebase";
        case "webfetch":
          return "Searching the web";
        case "edit":
        case "write":
          return "Making edits";
        case "bash":
          return "Running commands";
        default:
          return "Working";
      }
    }
    if (part.type === "reasoning") {
      const text = typeof (part as any).text === "string" ? (part as any).text : "";
      const match = text.trimStart().match(/^\*\*(.+?)\*\*/);
      if (match) return `Thinking about ${match[1].trim()}`;
      return "Thinking";
    }
    if (part.type === "text") {
      return "Gathering thoughts";
    }
    return null;
  };

  const truncateDetail = (value: string, max = 240) => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length <= max) return trimmed;
    return `${trimmed.slice(0, max)}...`;
  };

  const thinkingStatus = createMemo(() => {
    const status = computeStatusFromPart(latestRunPart());
    if (status) return status;
    if (runPhase() === "thinking") return "Thinking";
    return null;
  });

  const thinkingDetail = createMemo<null | { title: string; detail?: string }>(() => {
    const part = latestRunPart();
    if (!part) return null;
    if (part.type === "tool") {
      const record = part as any;
      const state = record.state ?? {};
      const title =
        typeof state.title === "string" && state.title.trim() ? state.title.trim() : String(record.tool ?? "Tool");
      const output = typeof state.output === "string" ? truncateDetail(state.output) : null;
      const error = typeof state.error === "string" ? truncateDetail(state.error) : null;
      return { title, detail: output ?? error ?? undefined };
    }
    if (part.type === "reasoning") {
      const text = typeof (part as any).text === "string" ? (part as any).text : "";
      const detail = truncateDetail(text);
      return detail ? { title: "Reasoning", detail } : { title: "Reasoning" };
    }
    if (part.type === "text") {
      const text = typeof (part as any).text === "string" ? (part as any).text : "";
      const detail = truncateDetail(text);
      return detail ? { title: "Draft", detail } : { title: "Draft" };
    }
    return null;
  });

  const runLabel = createMemo(() => {
    switch (runPhase()) {
      case "sending":
        return "Sending";
      case "retrying":
        return "Retrying";
      case "responding":
        return "Responding";
      case "thinking":
        return "Thinking";
      case "error":
        return "Run failed";
      default:
        return "";
    }
  });

  const runElapsedMs = createMemo(() => {
    const start = runStartedAt();
    if (!start) return 0;
    return Math.max(0, runTick() - start);
  });

  const runElapsedLabel = createMemo(() => `${Math.round(runElapsedMs()).toLocaleString()}ms`);

  onMount(() => {
    setTimeout(() => setIsInitialLoad(false), 2000);
  });

  onMount(() => {
    const container = chatContainerEl;
    if (!container) return;
    const update = () => setAutoScrollEnabled(isNearBottom(container));
    update();
    container.addEventListener("scroll", update, { passive: true });
    onCleanup(() => container.removeEventListener("scroll", update));
  });

  createEffect(() => {
    const status = props.sessionStatus;
    if (status === "running" || status === "retry") {
      startRun();
      setRunHasBegun(true);
    }
  });

  createEffect(() => {
    if (responseStarted()) {
      setRunHasBegun(true);
    }
  });

  createEffect(() => {
    if (!runStartedAt()) return;
    if (props.sessionStatus === "idle" && runHasBegun() && !props.error) {
      setRunStartedAt(null);
      setRunHasBegun(false);
      setRunBaseline({ assistantId: null, partCount: 0 });
    }
  });

  createEffect(() => {
    if (!showRunIndicator()) return;
    setRunTick(Date.now());
    const id = window.setInterval(() => setRunTick(Date.now()), 50);
    onCleanup(() => window.clearInterval(id));
  });

  createEffect(() => {
    if (!thinkingStatus()) {
      setThinkingExpanded(false);
    }
  });

  createEffect(
    on(
      () => [
        props.messages.length,
        props.todos.length,
        props.messages.reduce((acc, m) => acc + m.parts.length, 0),
      ],
      (current, previous) => {
        if (!previous) return;
        const [mLen, tLen, pCount] = current;
        const [prevM, prevT, prevP] = previous;
        if (mLen > prevM || tLen > prevT || pCount > prevP) {
          const shouldScroll = scrollOnNextUpdate() || autoScrollEnabled();
          if (shouldScroll) {
            scrollToLatest(scrollOnNextUpdate() ? "smooth" : "auto");
          }
          if (scrollOnNextUpdate()) {
            setScrollOnNextUpdate(false);
          }
        }
      },
    ),
  );

  createEffect(
    on(
      () => props.messages.length,
      (current, previous) => {
        if (previous == null) return;
        if (current < previous) {
          setUnreadCount(0);
          return;
        }
        if (current > previous && !autoScrollEnabled()) {
          setUnreadCount((count) => count + (current - previous));
        }
      },
    ),
  );

  createEffect(() => {
    if (autoScrollEnabled()) {
      setUnreadCount(0);
    }
  });

  const triggerFlyout = (
    sourceEl: Element | null,
    targetId: string,
    label: string,
    icon: Flyout["icon"]
  ) => {
    if (isInitialLoad() || !sourceEl) return;
    const targetEl = document.getElementById(targetId);
    if (!targetEl) return;

    const rect = sourceEl.getBoundingClientRect();
    const targetRect = targetEl.getBoundingClientRect();

    const id = Math.random().toString(36);
    setFlyouts((prev) => [
      ...prev,
      {
        id,
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        targetRect: { top: targetRect.top, left: targetRect.left, width: targetRect.width, height: targetRect.height },
        label,
        icon,
      },
    ]);

    setTimeout(() => {
      setFlyouts((prev) => prev.filter((f) => f.id !== id));
    }, 1000);
  };

  createEffect(() => {
    const todos = props.todos.filter((t) => t.content.trim());
    const count = todos.length;
    const prev = prevTodoCount();
    if (count > prev && prev > 0) {
      const lastMsg = chatContainerEl?.querySelector('[data-message-role="assistant"]:last-child');
      triggerFlyout(lastMsg ?? null, "sidebar-progress", "New Task", "check");
    }
    setPrevTodoCount(count);
  });

  createEffect(() => {
     const files = props.workingFiles;
     const count = files.length;
     const prev = prevFileCount();
     if (count > prev && prev > 0) {
        const lastMsg = chatContainerEl?.querySelector('[data-message-role="assistant"]:last-child');
        triggerFlyout(lastMsg ?? null, "sidebar-context", "File Modified", "folder");
     }
     setPrevFileCount(count);
  });

  createEffect(() => {
    if (!commandToast()) return;
    const id = window.setTimeout(() => setCommandToast(null), 2400);
    return () => window.clearTimeout(id);
  });

  const selectedSessionTitle = createMemo(() => {
    const id = props.selectedSessionId;
    if (!id) return "";
    return props.sessions.find((session) => session.id === id)?.title ?? "";
  });

  const workspaceLabel = createMemo(() => {
    const name = props.activeWorkspaceDisplay.name.trim();
    if (name) return name;
    return "Workspace";
  });

  const pickFallbackSessionId = (targetId: string) => {
    const list = props.sessions.map((session) => session.id);
    if (list.length <= 1) return null;
    const index = list.indexOf(targetId);
    if (index === -1) return list[0] ?? null;
    return list[index + 1] ?? list[index - 1] ?? null;
  };

  const renameCanSave = createMemo(() => {
    if (renameBusy()) return false;
    const next = renameTitle().trim();
    if (!next) return false;
    return next !== selectedSessionTitle().trim();
  });

  const openRenameModal = () => {
    if (!props.selectedSessionId) {
      setCommandToast("No session selected");
      return;
    }
    setRenameTitle(selectedSessionTitle());
    setRenameModalOpen(true);
  };

  const closeRenameModal = () => {
    if (renameBusy()) return;
    setRenameModalOpen(false);
  };

  const submitRename = async () => {
    const sessionId = props.selectedSessionId;
    if (!sessionId) return;
    const next = renameTitle().trim();
    if (!next || !renameCanSave()) return;
    setRenameBusy(true);
    try {
      await props.renameSession(sessionId, next);
      setRenameModalOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : props.safeStringify(error);
      setCommandToast(message);
    } finally {
      setRenameBusy(false);
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    if (deleteBusy()) return;
    const targetId = sessionId?.trim();
    if (!targetId) {
      setCommandToast("No session selected");
      return;
    }
    const targetTitle = props.sessions.find((session) => session.id === targetId)?.title ?? "this session";
    const confirmed = window.confirm(`Delete session "${targetTitle}"?`);
    if (!confirmed) return;
    const fallbackId = pickFallbackSessionId(targetId);
    setDeleteBusy(true);
    try {
      await props.deleteSession(targetId);
      setCommandToast("Session deleted");
      if (props.selectedSessionId !== targetId) return;
      if (fallbackId) {
        await Promise.resolve(props.selectSession(fallbackId));
        props.setView("session", fallbackId);
        props.setTab("sessions");
        return;
      }
      props.setView("dashboard");
      props.setTab("sessions");
    } catch (error) {
      const message = error instanceof Error ? error.message : props.safeStringify(error);
      setCommandToast(message);
    } finally {
      setDeleteBusy(false);
    }
  };

  const clearPrompt = () => props.setPrompt("");

  const extractCommandArgs = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("/")) return "";
    const body = trimmed.slice(1).trim();
    const spaceIndex = body.indexOf(" ");
    if (spaceIndex === -1) return "";
    return body.slice(spaceIndex + 1).trim();
  };

  const requireSessionId = () => {
    const sessionId = props.selectedSessionId;
    if (!sessionId) {
      setCommandToast("No session selected");
      return null;
    }
    return sessionId;
  };

  const formatListHint = (items: string[]) => {
    if (!items.length) return "";
    const preview = items.slice(0, 4).join(", ");
    return items.length > 4 ? `${preview}, ...` : preview;
  };

  const MODEL_VARIANT_OPTIONS = ["none", "low", "medium", "high", "xhigh"];

  const normalizeVariantInput = (value: string) => {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "balance" || trimmed === "balanced") return "none";
    return MODEL_VARIANT_OPTIONS.includes(trimmed) ? trimmed : null;
  };

  const openAgentPicker = () => {
    setAgentPickerOpen((current) => !current);
    if (!agentPickerReady()) {
      void loadAgentOptions();
    }
  };

  const applySessionAgent = (agent: string | null) => {
    const sessionId = requireSessionId();
    if (!sessionId) return;
    props.setSessionAgent(sessionId, agent);
  };

  const cycleAgent = async (direction: "next" | "prev") => {
    const sessionId = requireSessionId();
    if (!sessionId) return;
    try {
      const agents = await loadAgentOptions(true);
      if (!agents.length) {
        setCommandToast("No agents available");
        return;
      }
      const names = agents.map((agent) => agent.name);
      const current = props.selectedSessionAgent ?? "";
      const currentIndex = current ? names.findIndex((name) => name === current) : -1;
      let nextIndex = 0;
      if (currentIndex === -1) {
        nextIndex = direction === "next" ? 0 : names.length - 1;
      } else if (direction === "next") {
        nextIndex = (currentIndex + 1) % names.length;
      } else {
        nextIndex = (currentIndex - 1 + names.length) % names.length;
      }
      const nextAgent = names[nextIndex] ?? null;
      if (!nextAgent) {
        setCommandToast("No agents available");
        return;
      }
      props.setSessionAgent(sessionId, nextAgent);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agent selection failed";
      setCommandToast(message);
    }
  };

  createEffect(() => {
    if (!agentPickerOpen()) return;
    const handler = (event: MouseEvent) => {
      if (!agentPickerRef) return;
      if (agentPickerRef.contains(event.target as Node)) return;
      setAgentPickerOpen(false);
    };
    window.addEventListener("mousedown", handler);
    onCleanup(() => window.removeEventListener("mousedown", handler));
  });

  const handleProviderAuthSelect = async (providerId: string) => {
    if (providerAuthActionBusy()) return;
    setProviderAuthActionBusy(true);
    try {
      const message = await props.startProviderAuth(providerId);
      setCommandToast(message || "Auth flow started");
      props.closeProviderAuthModal();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Auth failed";
      setCommandToast(message);
    } finally {
      setProviderAuthActionBusy(false);
    }
  };

  const handleProviderAuthApiKey = async (providerId: string, apiKey: string) => {
    if (providerAuthActionBusy()) return;
    setProviderAuthActionBusy(true);
    try {
      const message = await props.submitProviderApiKey(providerId, apiKey);
      setCommandToast(message || "API key saved");
      props.closeProviderAuthModal();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save API key";
      setCommandToast(message);
    } finally {
      setProviderAuthActionBusy(false);
    }
  };

  const runOpenCodeCommand = (command: WorkspaceCommand, context?: CommandTriggerContext) => {
    const details = context?.source === "slash" ? extractCommandArgs(props.prompt) : "";
    const shouldClear = context?.source === "slash";

    if (details) {
      void props.runCommand(command, details);
      if (shouldClear) clearPrompt();
      return;
    }

    if (commandNeedsDetails(command)) {
      props.openCommandRunModal(command);
      if (shouldClear) clearPrompt();
      return;
    }

    void props.runCommand(command);
    if (shouldClear) clearPrompt();
  };

  const buildHelpPreview = () => {
    const commands = slashCommands().map((command) => `/${command.slash}`);
    return formatListHint(commands);
  };
  const registerSessionCommands = () => {
    const commands: CommandRegistryItem[] = [
      {
        id: "session.models",
        title: "Choose a model",
        category: "Session",
        description: "Choose a model",
        slash: "models",
        scope: "session",
        onSelect: () => {
          props.openSessionModelPicker();
          clearPrompt();
        },
      },
      {
        id: "session.connect",
        title: "Connect a provider",
        category: "Session",
        description: "Connect a provider",
        slash: "connect",
        scope: "session",
        onSelect: async () => {
          try {
            await props.openProviderAuthModal();
            setCommandToast("Select a provider to connect");
            clearPrompt();
          } catch (error) {
            const message = error instanceof Error ? error.message : "Connect failed";
            setCommandToast(message);
          }
        },
      },
      {
        id: "session.variant",
        title: "Change model variant",
        category: "Session",
        description: "Adjust the model variant",
        slash: "variant",
        scope: "session",
        onSelect: () => {
          const rawArg = extractCommandArgs(props.prompt);
          if (!rawArg) {
            setCommandToast(`Use /variant ${MODEL_VARIANT_OPTIONS.join("/")}`);
            return;
          }
          const normalized = normalizeVariantInput(rawArg);
          if (!normalized) {
            setCommandToast(`Variant must be: ${MODEL_VARIANT_OPTIONS.join(", ")}`);
            return;
          }
          props.setModelVariant(normalized);
          setCommandToast(`Variant set to ${normalized}`);
          clearPrompt();
        },
      },
      {
        id: "session.new",
        title: "Start a new task",
        category: "Session",
        description: "Start a new task",
        slash: "new",
        scope: "session",
        onSelect: () => {
          props.createSessionAndOpen();
          clearPrompt();
        },
      },
      {
        id: "session.agent",
        title: "Choose an agent",
        category: "Session",
        description: "Choose an agent",
        slash: "agent",
        scope: "session",
        onSelect: async () => {
          const sessionId = requireSessionId();
          if (!sessionId) return;

          try {
            const rawArg = extractCommandArgs(props.prompt);
            if (/^(next|prev|previous)$/i.test(rawArg)) {
              await cycleAgent(/^prev/i.test(rawArg) ? "prev" : "next");
              clearPrompt();
              return;
            }
            if (/^(none|clear|default)$/i.test(rawArg)) {
              props.setSessionAgent(sessionId, null);
              setCommandToast("Agent cleared");
              clearPrompt();
              return;
            }

            const agents = await props.listAgents();
            if (!agents.length) {
              setCommandToast("No agents available");
              clearPrompt();
              return;
            }

            const agentNames = agents.map((agent) => agent.name);
            let candidate = rawArg;
            if (!candidate) {
              const hint = formatListHint(agentNames);
              const promptLabel = hint ? `Agent name (e.g. ${hint})` : "Agent name";
              const prompted = window.prompt(promptLabel, agentNames[0] ?? "");
              if (prompted == null) return;
              candidate = prompted.trim();
            }

            if (!candidate) {
              setCommandToast("Agent name is required");
              clearPrompt();
              return;
            }

            const match = agents.find(
              (agent) => agent.name.toLowerCase() === candidate.toLowerCase(),
            );
            if (!match) {
              setCommandToast(`Unknown agent. Available: ${formatListHint(agentNames)}`);
              clearPrompt();
              return;
            }

              props.setSessionAgent(sessionId, match.name);
            clearPrompt();
          } catch (error) {
            const message = error instanceof Error ? error.message : "Agent selection failed";
            setCommandToast(message);
          }
        },
      },
      {
        id: "session.agent.next",
        title: "Next agent",
        category: "Session",
        description: "Cycle to the next agent",
        slash: "agent-next",
        scope: "session",
        onSelect: async () => {
          await cycleAgent("next");
          clearPrompt();
        },
      },
      {
        id: "session.agent.prev",
        title: "Previous agent",
        category: "Session",
        description: "Cycle to the previous agent",
        slash: "agent-prev",
        scope: "session",
        onSelect: async () => {
          await cycleAgent("prev");
          clearPrompt();
        },
      },
      {
        id: "session.export",
        title: "Export session JSON",
        category: "Session",
        description: "Export session JSON",
        slash: "export",
        scope: "session",
        onSelect: async () => {
          const sessionId = requireSessionId();
          if (!sessionId) return;

          try {
            const fileName = await props.saveSession(sessionId);
            setCommandToast(`Exported ${fileName}`);
            clearPrompt();
          } catch (error) {
            const message = error instanceof Error ? error.message : "Export failed";
            setCommandToast(message);
          }
        },
      },
      {
        id: "session.rename",
        title: "Rename this session",
        category: "Session",
        description: "Rename this session",
        slash: "rename",
        scope: "session",
        onSelect: () => {
          openRenameModal();
          clearPrompt();
        },
      },
      {
        id: "session.help",
        title: "Show available commands",
        category: "Session",
        description: "Show available commands",
        slash: "help",
        scope: "session",
        onSelect: () => {
          const preview = buildHelpPreview();
          setCommandToast(preview ? `Commands: ${preview}` : "No commands available");
          clearPrompt();
        },
      },
    ];

    const cleanups = commands.map((command) => props.registerCommand(command));
    onCleanup(() => cleanups.forEach((cleanup) => cleanup()));
  };

  createEffect(() => {
    registerSessionCommands();
  });

  createEffect(() => {
    const cleanups = props.commands.map((command) =>
      props.registerCommand({
        id: `command.${command.name}`,
        title: `/${command.name}`,
        category: "Commands",
        description: command.description || "Run a saved command",
        slash: command.name,
        scope: "session",
        onSelect: (context) => runOpenCodeCommand(command, context),
      }),
    );
    onCleanup(() => cleanups.forEach((cleanup) => cleanup()));
  });

  const slashCommands = createMemo(() =>
    props
      .commandRegistryItems()
      .filter((command) => command.slash)
      .sort((a, b) => (a.slash ?? "").localeCompare(b.slash ?? "")),
  );

  const slashCommandIndex = createMemo(() => {
    const map = new Map<string, CommandRegistryItem>();
    for (const command of slashCommands()) {
      if (command.slash) map.set(command.slash, command);
    }
    return map;
  });

  const commandNeedsArgs = createMemo(() => {
    const map = new Map<string, boolean>();
    for (const command of props.commands) {
      map.set(command.name, commandNeedsDetails(command));
    }
    return map;
  });

  const commandMatches = createMemo(() => {
    const value = props.prompt;
    if (!value.startsWith("/")) return [];
    const token = value.slice(1).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    const list = slashCommands();
    const matches = token
      ? list.filter((command) => command.slash?.toLowerCase().startsWith(token))
      : list;
    return matches.map((command) => ({
      id: command.slash!,
      description: command.description || "Run a command",
      needsArgs: commandNeedsArgs().get(command.slash ?? "") ?? false,
    }));
  });

  const handleRunCommand = (commandId: string) => {
    const command = slashCommandIndex().get(commandId);
    if (command) {
      command.onSelect({ source: "slash" });
    }
  };

  const handleInsertCommand = (commandId: string) => {
    props.setPrompt(`/${commandId} `);
    window.dispatchEvent(new CustomEvent("openwork:focusPrompt"));
  };

  const handleSendPrompt = (draft: ComposerDraft) => {
    const trimmed = draft.text.trim();
    if (draft.mode === "prompt" && trimmed.startsWith("/")) {
      const active = commandMatches()[0];
      if (active) {
        const args = extractCommandArgs(trimmed);
        if (active.needsArgs && !args) {
          handleInsertCommand(active.id);
        } else {
          handleRunCommand(active.id);
        }
      }
      return;
    }
    setScrollOnNextUpdate(true);
    scrollToLatest("auto");
    startRun();
    props.sendPromptAsync(draft).catch(() => undefined);
  };

  const handleDraftChange = (draft: ComposerDraft) => {
    props.setPrompt(draft.text);
  };

  const openSettings = (tab: SettingsTab = "general") => {
    props.setSettingsTab(tab);
    props.setTab("settings");
    props.setView("dashboard");
  };

  const openMcp = () => {
    props.setTab("mcp");
    props.setView("dashboard");
  };

  const openProviderAuth = () => {
    void props.openProviderAuthModal().catch((error) => {
      const message = error instanceof Error ? error.message : "Connect failed";
      setCommandToast(message);
    });
  };

  const jumpToLatest = () => {
    setScrollOnNextUpdate(true);
    scrollToLatest("smooth");
    setUnreadCount(0);
  };

  return (
    <div class="h-screen flex flex-col bg-gray-1 text-gray-12 relative pb-16 md:pb-12">
        <header class="h-16 border-b border-gray-6 flex items-center justify-between px-6 bg-gray-1/80 backdrop-blur-md z-10 sticky top-0">
          <div class="flex items-center gap-3">
            <Button
              variant="ghost"
              class="!p-2 rounded-full md:!px-3 md:!py-2 md:rounded-xl"
              onClick={() => {
                props.setTab("sessions");
                props.setView("dashboard");
              }}
              title="Back to dashboard"
            >
              <ArrowRight class="rotate-180 w-5 h-5" />
              <span class="hidden md:inline text-xs">Back</span>
            </Button>
             <WorkspaceChip
               workspace={props.activeWorkspaceDisplay}
               onClick={() => {
                 props.setWorkspaceSearch("");
                 props.setWorkspacePickerOpen(true);
               }}
             />
             <Show when={props.developerMode}>
               <span class="text-xs text-gray-7">{props.headerStatus}</span>
             </Show>
             <Show when={props.busyHint}>
               <span class="text-xs text-gray-10">· {props.busyHint}</span>
             </Show>

          </div>
        </header>

        <Show when={props.error}>
          <div class="mx-auto max-w-5xl w-full px-6 md:px-10 pt-4">
            <div class="rounded-2xl bg-red-1/40 px-5 py-4 text-sm text-red-12 border border-red-7/20">
              {props.error}
            </div>
          </div>
        </Show>

        <div class="flex-1 flex overflow-hidden">
          <aside class="hidden lg:flex w-72 border-r border-gray-6 bg-gray-1 flex-col">
              <SessionSidebar
                todos={props.todos}
                expandedSections={props.expandedSidebarSections}
                onToggleSection={(section) => {
                  props.setExpandedSidebarSections((curr) => ({...curr, [section]: !curr[section]}));
                }}
                workspaceName={workspaceLabel()}
                sessions={props.sessions}
                selectedSessionId={props.selectedSessionId}
                 onSelectSession={async (id) => {
                   await props.selectSession(id);
                   props.setView("session", id);
                   props.setTab("sessions");
                 }}
                sessionStatusById={props.sessionStatusById}
                onCreateSession={props.createSessionAndOpen}
                onDeleteSession={handleDeleteSession}
                newTaskDisabled={props.newTaskDisabled}
              />
          </aside>

          <div
            class="flex-1 overflow-y-auto pt-6 md:pt-10 scroll-smooth relative"
            ref={(el) => (chatContainerEl = el)}
          >
            <Show when={props.messages.length === 0}>
              <div class="text-center py-16 px-6 space-y-6">
                <div class="w-16 h-16 bg-gray-2 rounded-3xl mx-auto flex items-center justify-center border border-gray-6">
                  <Zap class="text-gray-7" />
                </div>
                <div class="space-y-2">
                  <h3 class="text-xl font-medium">What do you want to do?</h3>
                  <p class="text-gray-10 text-sm max-w-sm mx-auto">
                    Pick a starting point or just type below.
                  </p>
                </div>
                <div class="flex justify-center">
                  <button
                    type="button"
                    class="px-4 py-2.5 rounded-xl border border-gray-6 bg-gray-2 text-sm text-gray-12 hover:bg-gray-3 hover:border-gray-7 transition-all"
                    onClick={() => {
                      void (async () => {
                        const command = await ensureBrowserSetupCommand();
                        if (command) {
                          runOpenCodeCommand(command);
                        }
                      })();
                    }}
                  >
                    Automate your browser
                  </button>
                </div>
              </div>
            </Show>

            <MessageList 
              messages={props.messages}
              developerMode={props.developerMode}
              showThinking={props.showThinking}
              expandedStepIds={props.expandedStepIds}
              setExpandedStepIds={props.setExpandedStepIds}
              footer={
                showRunIndicator() ? (
                  <div class="flex justify-start pl-2">
                    <div class="w-full max-w-[68ch] space-y-2">
                      <Show when={thinkingStatus()}>
                        <div class="rounded-xl border border-gray-6/70 bg-gray-2/40 px-3 py-2 text-xs text-gray-11">
                          <button
                            type="button"
                            class="w-full flex items-center justify-between gap-3 text-left"
                            onClick={() => setThinkingExpanded((prev) => !prev)}
                            aria-expanded={thinkingExpanded()}
                          >
                            <div class="flex items-center gap-2 min-w-0">
                              <span class="text-[10px] uppercase tracking-wide text-gray-9">Thinking</span>
                              <span class="truncate text-gray-12">{thinkingStatus()}</span>
                            </div>
                            <ChevronDown
                              size={12}
                              class={`text-gray-8 transition-transform ${thinkingExpanded() ? "rotate-180" : ""}`}
                            />
                          </button>
                          <Show when={thinkingExpanded() && thinkingDetail()}>
                            {(detail) => (
                              <div class="mt-2 text-xs text-gray-11">
                                <div class="text-gray-12">{detail().title}</div>
                                <Show when={detail().detail}>
                                  <div class="mt-1 whitespace-pre-wrap text-gray-10">{detail().detail}</div>
                                </Show>
                              </div>
                            )}
                          </Show>
                        </div>
                      </Show>
                      <div
                        class={`w-full flex items-center justify-between gap-3 text-xs ${
                          runPhase() === "error" ? "text-red-11" : "text-gray-9"
                        }`}
                        role="status"
                        aria-live="polite"
                      >
                        <div class="flex items-center gap-2 min-w-0">
                          <Show
                            when={runPhase() === "responding"}
                            fallback={
                              <span
                                class={`h-1.5 w-1.5 rounded-full ${
                                  runPhase() === "error" ? "bg-red-9/80" : "bg-gray-8/80"
                                }`}
                              />
                            }
                          >
                            <span class="flex items-center gap-1">
                              <span
                                class={`h-1.5 w-1.5 rounded-full animate-pulse ${
                                  runPhase() === "error" ? "bg-red-9/80" : "bg-gray-8/80"
                                }`}
                              />
                              <span
                                class={`h-1.5 w-1.5 rounded-full animate-pulse ${
                                  runPhase() === "error" ? "bg-red-9/60" : "bg-gray-8/60"
                                }`}
                                style={{ "animation-delay": "120ms" }}
                              />
                              <span
                                class={`h-1.5 w-1.5 rounded-full animate-pulse ${
                                  runPhase() === "error" ? "bg-red-9/40" : "bg-gray-8/40"
                                }`}
                                style={{ "animation-delay": "240ms" }}
                              />
                            </span>
                          </Show>
                          <span class="truncate">{runLabel()}</span>
                        </div>
                        <Show when={props.developerMode}>
                          <span class="shrink-0 text-[10px] text-gray-8">{runElapsedLabel()}</span>
                        </Show>
                      </div>
                    </div>
                  </div>
                ) : undefined
              }
            />

            <Show when={!autoScrollEnabled() && props.messages.length > 0}>
              <div class="sticky bottom-24 z-20 flex justify-center pointer-events-none px-4">
                <button
                  type="button"
                  class="pointer-events-auto rounded-full border border-gray-6 bg-gray-1/90 px-4 py-2 text-xs text-gray-11 shadow-lg shadow-gray-12/5 backdrop-blur-md hover:bg-gray-2 transition-colors"
                  onClick={() => scrollToLatest("smooth")}
                >
                  Jump to latest
                </button>
              </div>
            </Show>

            <div ref={(el) => (messagesEndEl = el)} />
          </div>

          <aside class="hidden lg:flex w-72 border-l border-gray-6 bg-gray-1 flex-col">
            <ContextPanel
              activePlugins={props.activePlugins}
              activePluginStatus={props.activePluginStatus}
              mcpServers={props.mcpServers}
              mcpStatuses={props.mcpStatuses}
              mcpStatus={props.mcpStatus}
              skills={props.skills}
              skillsStatus={props.skillsStatus}
              authorizedDirs={props.authorizedDirs}
              workingFiles={props.workingFiles}
              workspaceRoot={props.activeWorkspaceRoot}
              expandedSections={props.expandedSidebarSections}
              onToggleSection={(section) =>
                props.setExpandedSidebarSections((curr) => ({
                  ...curr,
                  [section]: !curr[section],
                }))
              }
              onFileClick={handleWorkingFileClick}
            />
          </aside>
        </div>

        <Composer
          prompt={props.prompt}
          busy={props.busy}
          onSend={handleSendPrompt}
          onDraftChange={handleDraftChange}
          commandMatches={commandMatches()}
          onRunCommand={handleRunCommand}
          onInsertCommand={handleInsertCommand}
          selectedModelLabel={props.selectedSessionModelLabel || "Model"}
          onModelClick={props.openSessionModelPicker}
          modelVariantLabel={props.modelVariantLabel}
          modelVariant={props.modelVariant}
          onModelVariantChange={props.setModelVariant}
          agentLabel={agentLabel()}
          selectedAgent={props.selectedSessionAgent}
          agentPickerOpen={agentPickerOpen()}
          agentPickerBusy={agentPickerBusy()}
          agentPickerError={agentPickerError()}
          agentOptions={agentOptions()}
          onToggleAgentPicker={openAgentPicker}
          onSelectAgent={(agent) => {
            applySessionAgent(agent);
            setAgentPickerOpen(false);
          }}
          setAgentPickerRef={(el) => {
            agentPickerRef = el;
          }}
          showNotionBanner={props.showTryNotionPrompt}
          onNotionBannerClick={props.onTryNotionPrompt}
          toast={commandToast()}
          onToast={(message) => setCommandToast(message)}
          listAgents={props.listAgents}
          recentFiles={props.workingFiles}
          searchFiles={props.searchFiles}
          isRemoteWorkspace={props.activeWorkspaceDisplay.workspaceType === "remote"}
        />

        <Show when={unreadCount() > 0}>
          <div class="fixed bottom-24 right-6 z-40">
            <button
              type="button"
              onClick={jumpToLatest}
              class="flex items-center gap-2 rounded-full border border-gray-6 bg-gray-2/90 px-3 py-2 text-xs text-gray-11 shadow-lg shadow-gray-12/10 transition-all hover:text-gray-12 hover:border-gray-7"
              aria-label="Jump to latest message"
            >
              <span>New messages</span>
              <span class="rounded-full bg-gray-12/10 px-2 py-0.5 text-[10px] font-semibold text-gray-12">
                {unreadCount()}
              </span>
              <ChevronDown size={12} class="text-gray-9" />
            </button>
          </div>
        </Show>

        <div class="fixed bottom-0 left-0 right-0">
          <StatusBar
            clientConnected={props.clientConnected}
            openworkServerStatus={props.openworkServerStatus}
            developerMode={props.developerMode}
            onOpenSettings={() => openSettings("general")}
            onOpenMessaging={() => openSettings("messaging")}
            onOpenProviders={openProviderAuth}
            onOpenMcp={openMcp}
            providerConnectedIds={props.providerConnectedIds}
            mcpStatuses={props.mcpStatuses}
          />
        </div>

        <ProviderAuthModal
          open={props.providerAuthModalOpen}
          loading={props.providerAuthBusy}
          submitting={providerAuthActionBusy()}
          error={props.providerAuthError}
          providers={props.providers}
          connectedProviderIds={props.providerConnectedIds}
          authMethods={props.providerAuthMethods}
          onSelect={handleProviderAuthSelect}
          onSubmitApiKey={handleProviderAuthApiKey}
          onClose={props.closeProviderAuthModal}
        />

        <RenameSessionModal
          open={renameModalOpen()}
          title={renameTitle()}
          busy={renameBusy()}
          canSave={renameCanSave()}
          onClose={closeRenameModal}
          onSave={submitRename}
          onTitleChange={setRenameTitle}
        />

        <Show when={props.activePermission}>
          <div class="absolute inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-center justify-center p-4">
            <div class="bg-gray-2 border border-amber-7/30 w-full max-w-md rounded-2xl shadow-2xl overflow-hidden">
              <div class="p-6">
                <div class="flex items-start gap-4 mb-4">
                  <div class="p-3 bg-amber-7/10 rounded-full text-amber-6">
                    <Shield size={24} />
                  </div>
                  <div>
                    <h3 class="text-lg font-semibold text-gray-12">Permission Required</h3>
                    <p class="text-sm text-gray-11 mt-1">OpenCode is requesting permission to continue.</p>
                  </div>
                </div>

                <div class="bg-gray-1/50 rounded-xl p-4 border border-gray-6 mb-6">
                  <div class="text-xs text-gray-10 uppercase tracking-wider mb-2 font-semibold">Permission</div>
                  <div class="text-sm text-gray-12 font-mono">{props.activePermission?.permission}</div>

                  <div class="text-xs text-gray-10 uppercase tracking-wider mt-4 mb-2 font-semibold">Scope</div>
                  <div class="flex items-center gap-2 text-sm font-mono text-amber-12 bg-amber-1/30 px-2 py-1 rounded border border-amber-7/20">
                    <HardDrive size={12} />
                    {props.activePermission?.patterns.join(", ")}
                  </div>

                  <Show when={Object.keys(props.activePermission?.metadata ?? {}).length > 0}>
                    <details class="mt-4 rounded-lg bg-gray-1/20 p-2">
                      <summary class="cursor-pointer text-xs text-gray-11">Details</summary>
                      <pre class="mt-2 whitespace-pre-wrap break-words text-xs text-gray-12">
                        {props.safeStringify(props.activePermission?.metadata)}
                      </pre>
                    </details>
                  </Show>
                </div>

                <div class="grid grid-cols-2 gap-3">
                    <Button
                      variant="outline"
                      class="w-full border-red-7/20 text-red-11 hover:bg-red-1/30"
                      onClick={() =>
                        props.activePermission && props.respondPermission(props.activePermission.id, "reject")
                      }
                      disabled={props.permissionReplyBusy}
                    >

                    Deny
                  </Button>
                  <div class="grid grid-cols-2 gap-2">
                    <Button
                      variant="secondary"
                      class="text-xs"
                      onClick={() => props.activePermission && props.respondPermission(props.activePermission.id, "once")}
                      disabled={props.permissionReplyBusy}
                    >
                      Once
                    </Button>
                    <Button
                      variant="primary"
                      class="text-xs font-bold bg-amber-7 hover:bg-amber-8 text-gray-12 border-none shadow-amber-6/20"
                      onClick={() =>
                        props.activePermission &&
                        props.respondPermissionAndRemember(props.activePermission.id, "always")
                      }
                      disabled={props.permissionReplyBusy}
                    >
                      Allow for session
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Show>

        <For each={flyouts()}>
          {(item) => <FlyoutItem item={item} />}
        </For>
    </div>
  );
}
