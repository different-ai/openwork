import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import type { Agent, Part, Session } from "@opencode-ai/sdk/v2/client";
import type {
  DashboardTab,
  ComposerDraft,
  MessageGroup,
  MessageWithParts,
  McpServerEntry,
  McpStatusMap,
  PendingPermission,
  PendingQuestion,
  ProviderListItem,
  SettingsTab,
  SkillCard,
  TodoItem,
  View,
  WorkspaceConnectionState,
  WorkspaceDisplay,
  WorkspaceOpenworkConfig,
  WorkspaceSessionGroup,
} from "../types";

import {
  readObsidianMirrorFile,
  writeObsidianMirrorFile,
  type EngineInfo,
  type OpenworkServerInfo,
  type WorkspaceInfo,
} from "../lib/tauri";
import { usePlatform } from "../context/platform";
import { FEEDBACK_EMAIL_URL } from "../lib/feedback";
import { createWorkspaceShellLayout } from "../lib/workspace-shell-layout";

import {
  AlertTriangle,
  Check,
  Circle,
  HardDrive,
  ListTodo,
  Loader2,
  Menu,
  Minimize2,
  RefreshCcw,
  Redo2,
  Search,
  Shield,
  Undo2,
  X,
  Zap,
} from "lucide-solid";

import Button from "../components/button";
import ConfirmModal from "../components/confirm-modal";
import RenameSessionModal from "../components/rename-session-modal";
import ProviderAuthModal, {
  type ProviderAuthMethod,
  type ProviderOAuthStartResult,
} from "../components/provider-auth-modal";
import ShareWorkspaceModal from "../components/share-workspace-modal";
import StatusBar from "../components/status-bar";
import {
  buildOpenworkWorkspaceBaseUrl,
  createOpenworkServerClient,
  OpenworkServerError,
  parseOpenworkWorkspaceIdFromUrl,
} from "../lib/openwork-server";
import type {
  OpenworkFileSession,
  OpenworkServerClient,
  OpenworkServerSettings,
  OpenworkServerStatus,
  OpenworkWorkspaceExport,
} from "../lib/openwork-server";
import {
  DEFAULT_OPENWORK_PUBLISHER_BASE_URL,
  publishOpenworkBundleJson,
} from "../lib/publisher";
import { join } from "@tauri-apps/api/path";
import {
  isUserVisiblePart,
  isTauriRuntime,
  isWindowsPlatform,
  normalizeDirectoryPath,
} from "../utils";
import { finishPerf, perfNow, recordPerfLog } from "../lib/perf-log";
import { normalizeLocalFilePath } from "../lib/local-file-path";
import {
  defaultBlueprintCopyForPreset,
  defaultBlueprintStartersForPreset,
} from "../lib/workspace-blueprints";
import { DEFAULT_SESSION_TITLE, getDisplaySessionTitle } from "../lib/session-title";

import MessageList from "../components/session/message-list";
import Composer from "../components/session/composer";
import WorkspaceSessionList from "../components/session/workspace-session-list";
import type { SidebarSectionState } from "../components/session/sidebar";
import FlyoutItem from "../components/flyout-item";
import MobileSidebarDrawer from "../components/mobile-sidebar-drawer";
import QuestionModal from "../components/question-modal";
import WorkspaceRightSidebar from "../components/workspace-right-sidebar";

export type SessionViewProps = {
  selectedSessionId: string | null;
  setView: (view: View, sessionId?: string) => void;
  tab: DashboardTab;
  setTab: (tab: DashboardTab) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  toggleSettings: () => void;
  activeWorkspaceDisplay: WorkspaceDisplay;
  activeWorkspaceRoot: string;
  activeWorkspaceConfig: WorkspaceOpenworkConfig | null;
  workspaces: WorkspaceInfo[];
  activeWorkspaceId: string;
  connectingWorkspaceId: string | null;
  workspaceConnectionStateById: Record<string, WorkspaceConnectionState>;
  activateWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  testWorkspaceConnection: (workspaceId: string) => Promise<boolean> | boolean;
  recoverWorkspace: (workspaceId: string) => Promise<boolean> | boolean;
  editWorkspaceConnection: (workspaceId: string) => void;
  forgetWorkspace: (workspaceId: string) => void;
  openCreateWorkspace: () => void;
  openCreateRemoteWorkspace: () => void;
  importWorkspaceConfig: () => void;
  importingWorkspaceConfig: boolean;
  exportWorkspaceConfig: (workspaceId?: string) => void;
  exportWorkspaceBusy: boolean;
  clientConnected: boolean;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerClient: OpenworkServerClient | null;
  openworkServerSettings: OpenworkServerSettings;
  openworkServerHostInfo: OpenworkServerInfo | null;
  openworkServerWorkspaceId: string | null;
  engineInfo: EngineInfo | null;
  stopHost: () => void;
  headerStatus: string;
  busyHint: string | null;
  updateStatus: {
    state: string;
    lastCheckedAt?: number | null;
    version?: string;
    date?: string;
    notes?: string;
    totalBytes?: number | null;
    downloadedBytes?: number;
    message?: string;
  } | null;
  updateEnv: { supported?: boolean; reason?: string | null } | null;
  anyActiveRuns: boolean;
  installUpdateAndRestart: () => void;
  createSessionAndOpen: () => Promise<string | undefined>;
  sendPromptAsync: (draft: ComposerDraft) => Promise<void>;
  abortSession: (sessionId?: string) => Promise<void>;
  sessionRevertMessageId: string | null;
  undoLastUserMessage: () => Promise<void>;
  redoLastUserMessage: () => Promise<void>;
  compactSession: () => Promise<void>;
  lastPromptSent: string;
  retryLastPrompt: () => void;
  newTaskDisabled: boolean;
  workspaceSessionGroups: WorkspaceSessionGroup[];
  openRenameWorkspace: (workspaceId: string) => void;
  selectSession: (sessionId: string) => Promise<void> | void;
  messages: MessageWithParts[];
  getSessionById: (sessionId: string | null) => Session | null;
  getMessagesBySessionId: (sessionId: string | null) => MessageWithParts[];
  ensureSessionLoaded: (sessionId: string) => Promise<void> | void;
  sessionLoadingById: (sessionId: string | null) => boolean;
  todos: TodoItem[];
  busyLabel: string | null;
  developerMode: boolean;
  showThinking: boolean;
  groupMessageParts: (parts: Part[], messageId: string) => MessageGroup[];
  summarizeStep: (part: Part) => { title: string; detail?: string };
  expandedStepIds: Set<string>;
  setExpandedStepIds: (
    updater: (current: Set<string>) => Set<string>,
  ) => Set<string>;
  expandedSidebarSections: SidebarSectionState;
  setExpandedSidebarSections: (
    updater: (current: SidebarSectionState) => SidebarSectionState,
  ) => SidebarSectionState;
  workingFiles: string[];
  authorizedDirs: string[];
  activePlugins: string[];
  activePluginStatus: string | null;
  mcpServers: McpServerEntry[];
  mcpStatuses: McpStatusMap;
  mcpStatus: string | null;
  skills: SkillCard[];
  skillsStatus: string | null;
  showSkillReloadBanner: boolean;
  reloadBannerTitle: string;
  reloadBannerBody: string;
  reloadBannerBlocked: boolean;
  reloadBannerActiveCount: number;
  canReloadWorkspace: boolean;
  reloadWorkspaceEngine: () => Promise<void>;
  forceStopActiveConversations: () => Promise<void>;
  dismissReloadBanner: () => void;
  reloadBusy: boolean;
  reloadError: string | null;
  busy: boolean;
  prompt: string;
  setPrompt: (value: string) => void;
  selectedSessionModelLabel: string;
  openSessionModelPicker: (options?: {
    returnFocusTarget?: "none" | "composer";
  }) => void;
  modelVariantLabel: string;
  modelVariant: string | null;
  setModelVariant: (value: string) => void;
  activePermission: PendingPermission | null;
  showTryNotionPrompt: boolean;
  onTryNotionPrompt: () => void;
  permissionReplyBusy: boolean;
  respondPermission: (
    requestID: string,
    reply: "once" | "always" | "reject",
  ) => void;
  respondPermissionAndRemember: (
    requestID: string,
    reply: "once" | "always" | "reject",
  ) => void;
  activeQuestion: PendingQuestion | null;
  questionReplyBusy: boolean;
  respondQuestion: (requestID: string, answers: string[][]) => void;
  safeStringify: (value: unknown) => string;
  error: string | null;
  sessionStatus: string;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  startProviderAuth: (providerId?: string, methodIndex?: number) => Promise<ProviderOAuthStartResult>;
  completeProviderAuthOAuth: (
    providerId: string,
    methodIndex: number,
    code?: string,
  ) => Promise<{ connected: boolean; pending?: boolean; message?: string }>;
  submitProviderApiKey: (
    providerId: string,
    apiKey: string,
  ) => Promise<string | void>;
  refreshProviders: () => Promise<unknown>;
  openProviderAuthModal: (options?: {
    returnFocusTarget?: "none" | "composer";
    preferredProviderId?: string;
  }) => Promise<void>;
  closeProviderAuthModal: (options?: { restorePromptFocus?: boolean }) => void;
  providerAuthModalOpen: boolean;
  providerAuthBusy: boolean;
  providerAuthError: string | null;
  providerAuthMethods: Record<string, ProviderAuthMethod[]>;
  providerAuthPreferredProviderId: string | null;
  providerAuthWorkerType: "local" | "remote";
  providers: ProviderListItem[];
  providerConnectedIds: string[];
  listAgents: () => Promise<Agent[]>;
  searchFiles: (query: string) => Promise<string[]>;
  listCommands: () => Promise<
    {
      id: string;
      name: string;
      description?: string;
      source?: "command" | "mcp" | "skill";
    }[]
  >;
  selectedSessionAgent: string | null;
  setSessionAgent: (sessionId: string, agent: string | null) => void;
  saveSession: (sessionId: string) => Promise<string>;
  sessionStatusById: Record<string, string>;
  hasEarlierMessages: boolean;
  loadingEarlierMessages: boolean;
  loadEarlierMessages: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
};

type SharedSkillItem = {
  name: string;
  description?: string;
  content: string;
  trigger?: string;
};

type WorkspaceProfileBundleV1 = {
  schemaVersion: 1;
  type: "workspace-profile";
  name: string;
  description: string;
  workspace: OpenworkWorkspaceExport;
};

type SkillsSetBundleV1 = {
  schemaVersion: 1;
  type: "skills-set";
  name: string;
  description: string;
  skills: SharedSkillItem[];
  sourceWorkspace?: {
    id?: string;
    name?: string;
  };
};

type ResolvedEmptyStateStarter = {
  id: string;
  kind: "prompt" | "session" | "action";
  title: string;
  description?: string;
  prompt?: string;
  action?: "connect-openai";
};

const INITIAL_MESSAGE_WINDOW = 140;
const MESSAGE_WINDOW_LOAD_CHUNK = 120;
const MAX_SEARCH_MESSAGE_CHARS = 4_000;
const MAX_SEARCH_HITS = 2_000;
const STREAM_SCROLL_MIN_INTERVAL_MS = 90;
const STREAM_RENDER_BATCH_MS = 48;
const MAIN_THREAD_LAG_INTERVAL_MS = 200;
const MAIN_THREAD_LAG_WARN_MS = 180;

type CommandPaletteMode = "root" | "sessions";

export default function SessionView(props: SessionViewProps) {
  const platform = usePlatform();
  let messagesEndEl: HTMLDivElement | undefined;
  let bottomVisibilityEl: HTMLDivElement | undefined;
  let chatContainerEl: HTMLDivElement | undefined;
  let scrollMessageIntoViewById:
    | ((messageId: string, behavior?: ScrollBehavior) => boolean)
    | null = null;
  const [isChatContainerReady, setIsChatContainerReady] = createSignal(false);
  let agentPickerRef: HTMLDivElement | undefined;
  let searchInputEl: HTMLInputElement | undefined;
  let scrollFrame: number | undefined;
  let pendingScrollBehavior: ScrollBehavior = "auto";
  let lastAutoScrollAt = 0;
  let lastKnownScrollTop = 0;
  let streamRenderBatchTimer: number | undefined;
  let streamRenderBatchQueuedAt = 0;
  let streamRenderBatchReschedules = 0;
  const topInitializedSessionIds = new Set<string>();

  const [toastMessage, setToastMessage] = createSignal<string | null>(null);
  const [providerAuthActionBusy, setProviderAuthActionBusy] =
    createSignal(false);
  const [renameModalOpen, setRenameModalOpen] = createSignal(false);
  const [renameSessionId, setRenameSessionId] = createSignal<string | null>(null);
  const [renameTitle, setRenameTitle] = createSignal("");
  const [renameBusy, setRenameBusy] = createSignal(false);
  const [renameReturnFocusToComposer, setRenameReturnFocusToComposer] =
    createSignal(false);

  const [deleteSessionOpen, setDeleteSessionOpen] = createSignal(false);
  const [deleteSessionId, setDeleteSessionId] = createSignal<string | null>(null);
  const [deleteSessionBusy, setDeleteSessionBusy] = createSignal(false);
  const [agentPickerOpen, setAgentPickerOpen] = createSignal(false);
  const [agentPickerBusy, setAgentPickerBusy] = createSignal(false);
  const [agentPickerReady, setAgentPickerReady] = createSignal(false);
  const [agentPickerError, setAgentPickerError] = createSignal<string | null>(
    null,
  );
  const [agentOptions, setAgentOptions] = createSignal<Agent[]>([]);
  const [isViewingLatest, setIsViewingLatest] = createSignal(true);
  const [topClippedMessageId, setTopClippedMessageId] = createSignal<string | null>(null);
  const [jumpControlsSuppressed, setJumpControlsSuppressed] = createSignal(false);
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchQueryDebounced, setSearchQueryDebounced] = createSignal("");
  const [activeSearchHitIndex, setActiveSearchHitIndex] = createSignal(0);
  const [commandPaletteOpen, setCommandPaletteOpen] = createSignal(false);
  const [commandPaletteMode, setCommandPaletteMode] =
    createSignal<CommandPaletteMode>("root");
  const [commandPaletteQuery, setCommandPaletteQuery] = createSignal("");
  const [commandPaletteActiveIndex, setCommandPaletteActiveIndex] =
    createSignal(0);
  const [historyActionBusy, setHistoryActionBusy] = createSignal<
    "undo" | "redo" | "compact" | null
  >(null);
  const [messageWindowStart, setMessageWindowStart] = createSignal(0);
  const [messageWindowSessionId, setMessageWindowSessionId] = createSignal<
    string | null
  >(null);
  const [messageWindowExpanded, setMessageWindowExpanded] = createSignal(false);
  const [initialAnchorPending, setInitialAnchorPending] = createSignal(false);

  const [mobileRightSidebarOpen, setMobileRightSidebarOpen] = createSignal(false);

  // In Session view the right sidebar is navigation-only; never pre-highlight a
  // dashboard tab here so first-run feels chat-first rather than Automations-first.
  const showRightSidebarSelection = createMemo(() => false);
  let commandPaletteInputEl: HTMLInputElement | undefined;
  const commandPaletteOptionRefs: HTMLButtonElement[] = [];
  const {
    leftSidebarWidth,
    rightSidebarExpanded,
    rightSidebarWidth,
    startLeftSidebarResize,
    toggleRightSidebar,
  } = createWorkspaceShellLayout({ expandedRightWidth: 280 });

  const openFeedback = () => {
    const resolved = FEEDBACK_EMAIL_URL.trim();
    if (!resolved) return;
    platform.openLink(resolved);
  };

  const agentLabel = createMemo(
    () => props.selectedSessionAgent ?? "Default agent",
  );
  const workspaceLabel = (workspace: WorkspaceInfo) =>
    workspace.displayName?.trim() ||
    workspace.openworkWorkspaceName?.trim() ||
    workspace.name?.trim() ||
    workspace.path?.trim() ||
    "Workspace";
  const todoList = createMemo(() =>
    props.todos.filter((todo) => todo.content.trim()),
  );
  const todoCount = createMemo(() => todoList().length);
  const todoCompletedCount = createMemo(
    () => todoList().filter((todo) => todo.status === "completed").length,
  );

  const commandPaletteSessionOptions = createMemo(() => {
    const out: Array<{
      workspaceId: string;
      sessionId: string;
      title: string;
      workspaceTitle: string;
      updatedAt: number;
      searchText: string;
    }> = [];

    for (const group of props.workspaceSessionGroups) {
      const workspaceId = group.workspace.id?.trim() ?? "";
      if (!workspaceId) continue;
      const workspaceTitle = workspaceLabel(group.workspace);
      for (const session of group.sessions) {
        const sessionId = session.id?.trim() ?? "";
        if (!sessionId) continue;
        const title = getDisplaySessionTitle(session.title, DEFAULT_SESSION_TITLE);
        const slug = session.slug?.trim() ?? "";
        const updatedAt = session.time?.updated ?? session.time?.created ?? 0;
        out.push({
          workspaceId,
          sessionId,
          title,
          workspaceTitle,
          updatedAt,
          searchText: [title, workspaceTitle, slug].join(" ").toLowerCase(),
        });
      }
    }

    out.sort((a, b) => {
      const aActive = a.workspaceId === props.activeWorkspaceId;
      const bActive = b.workspaceId === props.activeWorkspaceId;
      if (aActive !== bActive) return aActive ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });

    return out;
  });

  const totalSessionCount = createMemo(
    () => commandPaletteSessionOptions().length,
  );

  type SearchHit = {
    messageId: string;
  };

  type CommandPaletteItem = {
    id: string;
    title: string;
    detail?: string;
    meta?: string;
    action: () => void;
  };

  const messageIdFromInfo = (message: MessageWithParts) => {
    const id = (message.info as { id?: string | number }).id;
    if (typeof id === "string") return id;
    if (typeof id === "number") return String(id);
    return "";
  };

  const messageTextForSearch = (message: MessageWithParts) => {
    const chunks: string[] = [];
    let used = 0;
    const push = (value: string) => {
      const next = value.trim();
      if (!next) return;
      if (used >= MAX_SEARCH_MESSAGE_CHARS) return;
      const remaining = MAX_SEARCH_MESSAGE_CHARS - used;
      if (next.length > remaining) {
        chunks.push(next.slice(0, Math.max(0, remaining)));
        used = MAX_SEARCH_MESSAGE_CHARS;
        return;
      }
      chunks.push(next);
      used += next.length;
    };

    for (const part of message.parts) {
      if (!isUserVisiblePart(part)) {
        continue;
      }
      if (part.type === "text") {
        const text = (part as { text?: string }).text ?? "";
        push(text);
        continue;
      }
      if (part.type === "agent") {
        const name = (part as { name?: string }).name ?? "";
        push(name ? `@${name}` : "");
        continue;
      }
      if (part.type === "file") {
        const file = part as {
          label?: string;
          path?: string;
          filename?: string;
        };
        const label = file.label ?? file.path ?? file.filename ?? "";
        push(label);
        continue;
      }
      if (part.type === "tool") {
        const state = (
          part as {
            state?: { title?: string; output?: string; error?: string };
          }
        ).state;
        push(state?.title ?? "");
        push(state?.output ?? "");
        push(state?.error ?? "");
      }
    }
    return chunks.join("\n");
  };

  createEffect(() => {
    const value = searchQuery();
    if (typeof window === "undefined") {
      setSearchQueryDebounced(value);
      return;
    }
    const id = window.setTimeout(() => setSearchQueryDebounced(value), 90);
    onCleanup(() => window.clearTimeout(id));
  });

  const searchHits = createMemo<SearchHit[]>(() => {
    if (!searchOpen()) return [];
    const query = searchQueryDebounced().trim().toLowerCase();
    if (!query) return [];

    const startedAt = perfNow();
    const hits: SearchHit[] = [];
    let capped = false;

    outer: for (const message of props.messages) {
      const messageId = messageIdFromInfo(message);
      if (!messageId) continue;
      const haystack = messageTextForSearch(message).toLowerCase();
      if (!haystack) continue;
      let index = haystack.indexOf(query);
      while (index !== -1) {
        hits.push({ messageId });
        if (hits.length >= MAX_SEARCH_HITS) {
          capped = true;
          break outer;
        }
        index = haystack.indexOf(query, index + Math.max(1, query.length));
      }
    }

    const elapsedMs = Math.round((perfNow() - startedAt) * 100) / 100;
    if (props.developerMode && (elapsedMs >= 8 || capped)) {
      recordPerfLog(true, "session.search", "scan", {
        queryLength: query.length,
        messageCount: props.messages.length,
        hitCount: hits.length,
        capped,
        ms: elapsedMs,
      });
    }

    return hits;
  });

  const searchMatchMessageIds = createMemo(() => {
    const out = new Set<string>();
    for (const hit of searchHits()) out.add(hit.messageId);
    return out;
  });

  const activeSearchHit = createMemo<SearchHit | null>(() => {
    const hits = searchHits();
    if (!hits.length) return null;
    const size = hits.length;
    const raw = activeSearchHitIndex();
    const index = ((raw % size) + size) % size;
    return hits[index] ?? null;
  });

  const activeSearchPositionLabel = createMemo(() => {
    const hits = searchHits();
    if (!hits.length) return "No matches";
    const size = hits.length;
    const raw = activeSearchHitIndex();
    const index = ((raw % size) + size) % size;
    return `${index + 1} of ${size}`;
  });

  const searchActive = createMemo(
    () => searchOpen() && searchQuery().trim().length > 0,
  );
  const totalPartCount = createMemo(() =>
    props.messages.reduce((total, message) => total + message.parts.length, 0),
  );

  const renderedMessages = createMemo(() => {
    if (messageWindowExpanded() || searchActive()) return props.messages;

    const start = messageWindowStart();
    if (start <= 0) return props.messages;
    if (start >= props.messages.length) return [];
    return props.messages.slice(start);
  });

  const [batchedRenderedMessages, setBatchedRenderedMessages] =
    createSignal<MessageWithParts[]>(renderedMessages());

  createEffect(() => {
    const next = renderedMessages();
    const sourceMessageCount = props.messages.length;
    const sourcePartCount = totalPartCount();
    if (props.sessionStatus === "idle") {
      if (streamRenderBatchTimer !== undefined) {
        window.clearTimeout(streamRenderBatchTimer);
        streamRenderBatchTimer = undefined;
      }
      setBatchedRenderedMessages(next);
      streamRenderBatchQueuedAt = 0;
      streamRenderBatchReschedules = 0;
      return;
    }

    if (streamRenderBatchQueuedAt <= 0) {
      streamRenderBatchQueuedAt = perfNow();
    } else {
      streamRenderBatchReschedules += 1;
    }

    if (streamRenderBatchTimer !== undefined) {
      window.clearTimeout(streamRenderBatchTimer);
      streamRenderBatchTimer = undefined;
    }

    streamRenderBatchTimer = window.setTimeout(() => {
      const applyStartedAt = perfNow();
      setBatchedRenderedMessages(next);
      streamRenderBatchTimer = undefined;
      const applyMs = Math.round((perfNow() - applyStartedAt) * 100) / 100;
      const queuedMs =
        streamRenderBatchQueuedAt > 0
          ? Math.round((perfNow() - streamRenderBatchQueuedAt) * 100) / 100
          : 0;
      const reschedules = streamRenderBatchReschedules;
      streamRenderBatchQueuedAt = 0;
      streamRenderBatchReschedules = 0;

      if (props.developerMode) {
        window.requestAnimationFrame(() => {
          const paintMs = Math.round((perfNow() - applyStartedAt) * 100) / 100;
          if (
            queuedMs >= 180 ||
            applyMs >= 8 ||
            paintMs >= 24 ||
            reschedules >= 3
          ) {
            recordPerfLog(true, "session.render", "batch-commit", {
              queuedMs,
              applyMs,
              paintMs,
              reschedules,
              sessionID: props.selectedSessionId,
              status: props.sessionStatus,
              sourceMessageCount,
              sourcePartCount,
              renderedMessageCount: next.length,
            });
          }
        });
      }
    }, STREAM_RENDER_BATCH_MS);
  });

  createEffect(() => {
    if (!props.developerMode) return;
    if (typeof window === "undefined") return;

    let expectedAt = perfNow() + MAIN_THREAD_LAG_INTERVAL_MS;
    const interval = window.setInterval(() => {
      const now = perfNow();
      const lagMs = Math.round((now - expectedAt) * 100) / 100;
      expectedAt = now + MAIN_THREAD_LAG_INTERVAL_MS;
      if (lagMs < MAIN_THREAD_LAG_WARN_MS) return;

      recordPerfLog(true, "session.main-thread", "lag", {
        lagMs,
        sessionID: props.selectedSessionId,
        status: props.sessionStatus,
        messageCount: props.messages.length,
        partCount: totalPartCount(),
        renderedMessageCount: batchedRenderedMessages().length,
      });
    }, MAIN_THREAD_LAG_INTERVAL_MS);

    onCleanup(() => {
      window.clearInterval(interval);
    });
  });

  const hiddenMessageCount = createMemo(() => {
    if (messageWindowExpanded() || searchActive()) return 0;
    const hidden = props.messages.length - renderedMessages().length;
    return hidden > 0 ? hidden : 0;
  });

  const nextRevealCount = createMemo(() => {
    const hidden = hiddenMessageCount();
    if (hidden <= 0) return 0;
    return Math.min(hidden, MESSAGE_WINDOW_LOAD_CHUNK);
  });

  const hasServerEarlierMessages = createMemo(
    () =>
      !searchActive() &&
      Boolean(props.selectedSessionId) &&
      props.hasEarlierMessages,
  );

  const revealEarlierMessages = async () => {
    const hidden = hiddenMessageCount();
    if (hidden > 0) {
      const nextStart = Math.max(
        0,
        messageWindowStart() - MESSAGE_WINDOW_LOAD_CHUNK,
      );
      if (props.developerMode) {
        recordPerfLog(true, "session.window", "reveal", {
          sessionID: props.selectedSessionId,
          hiddenBefore: hidden,
          nextStart,
        });
      }
      setMessageWindowStart(nextStart);
      if (nextStart === 0) {
        setMessageWindowExpanded(true);
      }
      return;
    }

    if (!hasServerEarlierMessages()) return;
    if (!props.selectedSessionId) return;
    setMessageWindowExpanded(true);
    setMessageWindowStart(0);
    await props.loadEarlierMessages(props.selectedSessionId);
    if (props.developerMode) {
      recordPerfLog(true, "session.window", "load-earlier", {
        sessionID: props.selectedSessionId,
      });
    }
  };

  let lastWindowPerfSignature = "";
  createEffect(() => {
    if (!props.developerMode) {
      lastWindowPerfSignature = "";
      return;
    }

    const signature = [
      props.selectedSessionId ?? "",
      props.messages.length,
      totalPartCount(),
      renderedMessages().length,
      hiddenMessageCount(),
      messageWindowExpanded() ? "1" : "0",
      searchActive() ? "1" : "0",
    ].join("|");

    if (signature === lastWindowPerfSignature) return;
    lastWindowPerfSignature = signature;

    recordPerfLog(true, "session.window", "state", {
      sessionID: props.selectedSessionId,
      messageCount: props.messages.length,
      renderedMessageCount: renderedMessages().length,
      hiddenMessageCount: hiddenMessageCount(),
      partCount: totalPartCount(),
      expanded: messageWindowExpanded(),
      searchActive: searchActive(),
    });
  });

  const canUndoLastMessage = createMemo(() => {
    if (!props.selectedSessionId) return false;
    const revert = props.sessionRevertMessageId;
    for (const message of props.messages) {
      const role = (message.info as { role?: string }).role;
      if (role !== "user") continue;
      const id = messageIdFromInfo(message);
      if (!id) continue;
      if (!revert || id < revert) return true;
    }
    return false;
  });

  const hasUserMessages = createMemo(() =>
    props.messages.some(
      (message) => (message.info as { role?: string }).role === "user",
    ),
  );

  const canRedoLastMessage = createMemo(() => {
    if (!props.selectedSessionId) return false;
    return Boolean(props.sessionRevertMessageId);
  });

  const canCompactSession = createMemo(
    () => Boolean(props.selectedSessionId) && hasUserMessages(),
  );

  const resolveLocalFileCandidates = async (file: string) => {
    const trimmed = normalizeLocalFilePath(file).trim();
    if (!trimmed) return [];
    if (isAbsolutePath(trimmed)) return [trimmed];

    const root = props.activeWorkspaceRoot.trim();
    if (!root) return [];

    const normalized = trimmed
      .replace(/[\\/]+/g, "/")
      .replace(/^\.\/+/, "")
      .replace(/\/+$/, "");
    const candidates: string[] = [];
    const seen = new Set<string>();

    const pushCandidate = (value: string) => {
      const key = value
        .trim()
        .replace(/[\\/]+/g, "/")
        .toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      candidates.push(value);
    };

    pushCandidate(await join(root, normalized));

    if (normalized.startsWith(".opencode/openwork/outbox/")) {
      return candidates;
    }

    if (normalized.startsWith("openwork/outbox/")) {
      const suffix = normalized.slice("openwork/outbox/".length);
      if (suffix) {
        pushCandidate(
          await join(root, ".opencode", "openwork", "outbox", suffix),
        );
      }
      return candidates;
    }

    if (normalized.startsWith("outbox/")) {
      const suffix = normalized.slice("outbox/".length);
      if (suffix) {
        pushCandidate(
          await join(root, ".opencode", "openwork", "outbox", suffix),
        );
      }
      return candidates;
    }

    if (!normalized.startsWith(".opencode/")) {
      pushCandidate(
        await join(root, ".opencode", "openwork", "outbox", normalized),
      );
    }

    return candidates;
  };

  const runLocalFileAction = async (
    file: string,
    mode: "open" | "reveal",
    action: (candidate: string) => Promise<void>,
  ) => {
    const candidates = await resolveLocalFileCandidates(file);
    if (!candidates.length) {
      return { ok: false as const, reason: "missing-root" as const };
    }

    let lastError: unknown = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const startedAt = perfNow();
      try {
        recordPerfLog(props.developerMode, "session.file-open", "attempt", {
          mode,
          input: file,
          target: candidate,
          candidateIndex: index,
          candidateCount: candidates.length,
        });
        await action(candidate);
        finishPerf(
          props.developerMode,
          "session.file-open",
          "success",
          startedAt,
          {
            mode,
            input: file,
            target: candidate,
            candidateIndex: index,
            candidateCount: candidates.length,
          },
        );
        return { ok: true as const, path: candidate };
      } catch (error) {
        lastError = error;
        console.warn("[session.file-open] candidate failed", {
          mode,
          input: file,
          target: candidate,
          candidateIndex: index,
          candidateCount: candidates.length,
          error: error instanceof Error ? error.message : String(error),
        });
        finishPerf(
          props.developerMode,
          "session.file-open",
          "candidate-failed",
          startedAt,
          {
            mode,
            input: file,
            target: candidate,
            candidateIndex: index,
            candidateCount: candidates.length,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }

    const suffix =
      candidates.length > 1
        ? ` (tried ${candidates.length} paths: workspace root and outbox fallbacks)`
        : "";
    return {
      ok: false as const,
      reason: `${lastError instanceof Error ? lastError.message : "File open failed"}${suffix}`,
    };
  };

  type RemoteMirrorTrackedFile = {
    path: string;
    localPath: string;
    remoteRevision: string;
    localFingerprint: string;
    syncingLocal: boolean;
  };

  type RemoteFileSyncSession = OpenworkFileSession & { cursor: number };

  const remoteMirrorTrackedFiles = new Map<string, RemoteMirrorTrackedFile>();
  const [remoteFileSyncSession, setRemoteFileSyncSession] =
    createSignal<RemoteFileSyncSession | null>(null);
  const remoteMirrorWorkspaceKey = createMemo(
    () =>
      props.openworkServerWorkspaceId?.trim() ||
      props.activeWorkspaceDisplay.id?.trim() ||
      "remote-worker",
  );
  let remoteMirrorSyncTimer: number | undefined;
  let remoteMirrorSyncInFlight = false;
  let remoteMirrorLastErrorAt = 0;

  const textFingerprint = (value: string) => {
    let hash = 2166136261;
    for (let idx = 0; idx < value.length; idx += 1) {
      hash ^= value.charCodeAt(idx);
      hash = Math.imul(hash, 16777619);
    }
    return `${value.length}:${hash >>> 0}`;
  };

  const utf8ToBase64 = (value: string) => {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    const fallbackBuffer = (
      globalThis as {
        Buffer?: {
          from: (
            input: string,
            encoding: string,
          ) => { toString: (encoding: string) => string };
        };
      }
    ).Buffer;
    if (typeof btoa !== "function") {
      if (!fallbackBuffer) {
        throw new Error("Base64 encoder is unavailable");
      }
      return fallbackBuffer.from(value, "utf8").toString("base64");
    }
    return btoa(binary);
  };

  const base64ToUtf8 = (value: string) => {
    const fallbackBuffer = (
      globalThis as {
        Buffer?: {
          from: (
            input: string,
            encoding: string,
          ) => { toString: (encoding: string) => string };
        };
      }
    ).Buffer;
    if (typeof atob !== "function") {
      if (!fallbackBuffer) {
        throw new Error("Base64 decoder is unavailable");
      }
      return fallbackBuffer.from(value, "base64").toString("utf8");
    }
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  };

  const stopRemoteMirrorSyncLoop = () => {
    if (remoteMirrorSyncTimer !== undefined) {
      window.clearInterval(remoteMirrorSyncTimer);
      remoteMirrorSyncTimer = undefined;
    }
  };

  const closeRemoteFileSyncSession = async (
    session: RemoteFileSyncSession | null,
  ) => {
    const client = props.openworkServerClient;
    if (!client || !session) return;
    try {
      await client.closeFileSession(session.id);
    } catch {
      // best effort
    }
  };

  const resetRemoteFileSync = async () => {
    stopRemoteMirrorSyncLoop();
    remoteMirrorSyncInFlight = false;
    remoteMirrorTrackedFiles.clear();
    const existing = remoteFileSyncSession();
    setRemoteFileSyncSession(null);
    await closeRemoteFileSyncSession(existing);
  };

  const toWorkerRelativeArtifactPath = (file: string) => {
    const normalized = file
      .trim()
      .replace(/^file:\/\//i, "")
      .replace(/[\\/]+/g, "/");
    if (!normalized) return "";

    const root = props.activeWorkspaceRoot
      .trim()
      .replace(/[\\/]+/g, "/")
      .replace(/\/+$/, "");
    if (root) {
      const rootKey = root.toLowerCase();
      const fileKey = normalized.toLowerCase();
      if (fileKey === rootKey) return "";
      if (fileKey.startsWith(`${rootKey}/`)) {
        return normalized.slice(root.length + 1);
      }
    }

    let relative = normalized.replace(/^\.\/+/, "");

    if (/^[ab]\/.+\.(md|mdx|markdown)$/i.test(relative)) {
      relative = relative.slice(2);
    }

    if (/^workspace\//i.test(relative)) {
      relative = relative.replace(/^workspace\//i, "");
    }

    if (/^\/+workspace\//i.test(relative)) {
      relative = relative.replace(/^\/+workspace\//i, "");
    }

    if (!relative) return "";
    if (
      relative.startsWith("/") ||
      relative.startsWith("~") ||
      /^[a-zA-Z]:\//.test(relative)
    ) {
      return "";
    }
    if (relative.split("/").some((part) => part === "." || part === "..")) {
      return "";
    }
    return relative;
  };

  const toRemoteArtifactCandidates = (file: string) => {
    const target = toWorkerRelativeArtifactPath(file);
    if (!target) return [] as string[];
    const outboxPath = `.opencode/openwork/outbox/${target}`.replace(
      /\/+/g,
      "/",
    );
    if (
      target.startsWith(".opencode/openwork/outbox/") ||
      target.startsWith("./.opencode/openwork/outbox/") ||
      outboxPath === target
    ) {
      return [target];
    }
    return [target, outboxPath];
  };

  const ensureRemoteFileSyncSession =
    async (): Promise<RemoteFileSyncSession> => {
      const client = props.openworkServerClient;
      const workspaceId = props.openworkServerWorkspaceId?.trim() ?? "";
      if (!client || !workspaceId) {
        throw new Error("Connect to OpenWork server to sync remote files.");
      }

      const existing = remoteFileSyncSession();
      if (existing && existing.workspaceId === workspaceId) {
        if (Date.now() + 45_000 < existing.expiresAt) {
          return existing;
        }

        try {
          const renewed = await client.renewFileSession(existing.id, {
            ttlSeconds: 15 * 60,
          });
          const next: RemoteFileSyncSession = {
            ...renewed.session,
            cursor: existing.cursor,
          };
          setRemoteFileSyncSession(next);
          return next;
        } catch (error) {
          if (
            !(error instanceof OpenworkServerError) ||
            error.code !== "file_session_not_found"
          ) {
            throw error;
          }
        }
      }

      if (existing) {
        await closeRemoteFileSyncSession(existing);
        setRemoteFileSyncSession(null);
      }

      const created = await client.createFileSession(workspaceId, {
        ttlSeconds: 15 * 60,
        write: true,
      });
      const next: RemoteFileSyncSession = {
        ...created.session,
        cursor: 0,
      };
      setRemoteFileSyncSession(next);
      return next;
    };

  const refreshTrackedRemoteMirrorFile = async (
    session: RemoteFileSyncSession,
    path: string,
  ) => {
    const client = props.openworkServerClient;
    if (!client) throw new Error("OpenWork server client unavailable");

    const result = await client.readFileBatch(session.id, [path]);
    const item = result.items[0];
    if (!item?.ok) {
      if (item?.code === "file_not_found") {
        remoteMirrorTrackedFiles.delete(path);
        return null;
      }
      throw new Error(item?.message ?? `Unable to read ${path}`);
    }

    const content = base64ToUtf8(item.contentBase64);
    const localPath = await writeObsidianMirrorFile(
      remoteMirrorWorkspaceKey(),
      path,
      content,
    );
    const local = await readObsidianMirrorFile(
      remoteMirrorWorkspaceKey(),
      path,
    );
    const fingerprint = textFingerprint(local.content ?? content);

    const previous = remoteMirrorTrackedFiles.get(path);
    remoteMirrorTrackedFiles.set(path, {
      path,
      localPath,
      remoteRevision: item.revision,
      localFingerprint: fingerprint,
      syncingLocal: previous?.syncingLocal ?? false,
    });

    return localPath;
  };

  const createConflictPath = (path: string) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const marker = `.openwork-conflict-${stamp}`;
    const dot = path.lastIndexOf(".");
    if (dot <= 0) {
      return `${path}${marker}`;
    }
    return `${path.slice(0, dot)}${marker}${path.slice(dot)}`;
  };

  const runRemoteMirrorSyncTick = async () => {
    if (remoteMirrorSyncInFlight) return;
    if (remoteMirrorTrackedFiles.size === 0) {
      stopRemoteMirrorSyncLoop();
      return;
    }

    const client = props.openworkServerClient;
    if (!client) {
      stopRemoteMirrorSyncLoop();
      return;
    }

    remoteMirrorSyncInFlight = true;
    try {
      let session = await ensureRemoteFileSyncSession();

      const events = await client.listFileSessionEvents(session.id, {
        since: session.cursor,
      });
      if (events.cursor !== session.cursor) {
        session = { ...session, cursor: events.cursor };
        setRemoteFileSyncSession(session);
      }

      const refreshPaths = new Set<string>();
      for (const event of events.items) {
        if (
          event.type === "write" &&
          remoteMirrorTrackedFiles.has(event.path)
        ) {
          const tracked = remoteMirrorTrackedFiles.get(event.path);
          if (!tracked?.syncingLocal) {
            refreshPaths.add(event.path);
          }
          continue;
        }

        if (event.type === "rename") {
          const tracked = remoteMirrorTrackedFiles.get(event.path);
          if (!tracked) continue;
          remoteMirrorTrackedFiles.delete(event.path);
          if (event.toPath?.trim()) {
            const nextPath = event.toPath.trim();
            remoteMirrorTrackedFiles.set(nextPath, {
              ...tracked,
              path: nextPath,
            });
            refreshPaths.add(nextPath);
          }
          continue;
        }

        if (event.type === "delete") {
          remoteMirrorTrackedFiles.delete(event.path);
        }
      }

      for (const path of refreshPaths) {
        await refreshTrackedRemoteMirrorFile(session, path);
      }

      for (const [path, tracked] of remoteMirrorTrackedFiles) {
        if (tracked.syncingLocal) continue;

        const local = await readObsidianMirrorFile(
          remoteMirrorWorkspaceKey(),
          path,
        );
        if (!local.exists || local.content === null) continue;
        const nextFingerprint = textFingerprint(local.content);
        if (nextFingerprint === tracked.localFingerprint) continue;

        tracked.syncingLocal = true;
        try {
          const write = await client.writeFileBatch(session.id, [
            {
              path,
              contentBase64: utf8ToBase64(local.content),
              ifMatchRevision: tracked.remoteRevision,
            },
          ]);
          const item = write.items[0];
          if (item?.ok) {
            tracked.remoteRevision = item.revision;
            tracked.localFingerprint = nextFingerprint;
            continue;
          }

          if (!item?.ok && item?.code === "conflict") {
            const conflictPath = createConflictPath(path);
            await writeObsidianMirrorFile(
              remoteMirrorWorkspaceKey(),
              conflictPath,
              local.content,
            );
            await refreshTrackedRemoteMirrorFile(session, path);
            setToastMessage(
              `Conflict syncing ${path}. Saved local changes to ${conflictPath}.`,
            );
            continue;
          }

          throw new Error(item?.message ?? `Unable to sync ${path}`);
        } finally {
          tracked.syncingLocal = false;
        }
      }
    } catch (error) {
      if (Date.now() - remoteMirrorLastErrorAt > 6_000) {
        remoteMirrorLastErrorAt = Date.now();
        const message =
          error instanceof Error ? error.message : "Remote file sync failed";
        setToastMessage(message);
      }
    } finally {
      remoteMirrorSyncInFlight = false;
    }
  };

  const ensureRemoteMirrorSyncLoop = () => {
    if (!isTauriRuntime()) return;
    if (remoteMirrorTrackedFiles.size === 0) return;
    if (remoteMirrorSyncTimer !== undefined) return;
    remoteMirrorSyncTimer = window.setInterval(() => {
      void runRemoteMirrorSyncTick();
    }, 2500);
    void runRemoteMirrorSyncTick();
  };

  const mirrorRemoteArtifactForObsidian = async (file: string) => {
    const session = await ensureRemoteFileSyncSession();
    const client = props.openworkServerClient;
    if (!client) {
      throw new Error("Connect to OpenWork server to sync remote files.");
    }

    const candidates = toRemoteArtifactCandidates(file);
    if (candidates.length === 0) {
      throw new Error("Only worker-relative files can be opened in Obsidian.");
    }

    let lastError: Error | null = null;
    for (const candidate of candidates) {
      try {
        const result = await client.readFileBatch(session.id, [candidate]);
        const item = result.items[0];
        if (!item?.ok) {
          if (item?.code === "file_not_found") continue;
          throw new Error(item?.message ?? `Unable to read ${candidate}`);
        }

        const content = base64ToUtf8(item.contentBase64);
        const localPath = await writeObsidianMirrorFile(
          remoteMirrorWorkspaceKey(),
          candidate,
          content,
        );
        const local = await readObsidianMirrorFile(
          remoteMirrorWorkspaceKey(),
          candidate,
        );
        const fingerprint = textFingerprint(local.content ?? content);

        remoteMirrorTrackedFiles.set(candidate, {
          path: candidate,
          localPath,
          remoteRevision: item.revision,
          localFingerprint: fingerprint,
          syncingLocal: false,
        });
        ensureRemoteMirrorSyncLoop();
        return localPath;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new Error("Unable to open file in Obsidian");
  };

  createEffect(
    on(
      () =>
        [
          isTauriRuntime(),
          props.activeWorkspaceDisplay.workspaceType,
          props.openworkServerWorkspaceId?.trim() ?? "",
          Boolean(props.openworkServerClient),
        ] as const,
      ([desktopRuntime, workspaceType, workspaceId, hasClient], previous) => {
        const previousWorkspaceId = previous?.[2] ?? "";
        const hasRemoteContext =
          desktopRuntime &&
          workspaceType === "remote" &&
          workspaceId.length > 0 &&
          hasClient;
        if (!hasRemoteContext) {
          if (
            remoteFileSyncSession() ||
            remoteMirrorTrackedFiles.size > 0 ||
            remoteMirrorSyncTimer !== undefined
          ) {
            void resetRemoteFileSync();
          }
          return;
        }

        if (previousWorkspaceId && previousWorkspaceId !== workspaceId) {
          void resetRemoteFileSync();
        }
      },
    ),
  );

  onCleanup(() => {
    void resetRemoteFileSync();
  });

  const revealWorkspaceInFinder = async (workspaceId: string) => {
    const workspace =
      props.workspaces.find((entry) => entry.id === workspaceId) ?? null;
    if (!workspace || workspace.workspaceType !== "local") return;
    const target = workspace.path?.trim() ?? "";
    if (!target) {
      setToastMessage("Workspace path is unavailable.");
      return;
    }
    if (!isTauriRuntime()) {
      setToastMessage("Reveal is available in the desktop app.");
      return;
    }
    try {
      const { openPath, revealItemInDir } =
        await import("@tauri-apps/plugin-opener");
      if (isWindowsPlatform()) {
        await openPath(target);
      } else {
        await revealItemInDir(target);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to reveal workspace";
      setToastMessage(message);
    }
  };
  const todoLabel = createMemo(() => {
    const total = todoCount();
    if (!total) return "";
    return `${todoCompletedCount()} out of ${total} tasks completed`;
  });
  const [shareWorkspaceId, setShareWorkspaceId] = createSignal<string | null>(
    null,
  );
  let initialAnchorRafA: number | undefined;
  let initialAnchorRafB: number | undefined;
  let initialAnchorGuardTimer: ReturnType<typeof setTimeout> | undefined;
  let jumpControlsSuppressTimer: ReturnType<typeof setTimeout> | undefined;
  const attachmentsEnabled = createMemo(() => {
    if (props.activeWorkspaceDisplay.workspaceType !== "remote") return true;
    return props.openworkServerStatus === "connected";
  });
  const attachmentsDisabledReason = createMemo(() => {
    if (attachmentsEnabled()) return null;
    if (props.openworkServerStatus === "limited") {
      return "Add a server token to attach files.";
    }
    return "Connect to OpenWork server to attach files.";
  });

  const scrollToLatest = (behavior: ScrollBehavior = "auto") => {
    messagesEndEl?.scrollIntoView({ behavior, block: "end" });
  };

  const refreshTopClippedMessage = () => {
    const container = chatContainerEl;
    if (!container) {
      setTopClippedMessageId(null);
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const messageEls = container.querySelectorAll("[data-message-id]");
    const latestMessageEl = messageEls[messageEls.length - 1] as HTMLElement | undefined;
    const latestMessageId = latestMessageEl?.getAttribute("data-message-id")?.trim() ?? "";
    let nextId: string | null = null;

    for (const node of messageEls) {
      const el = node as HTMLElement;
      const rect = el.getBoundingClientRect();
      if (rect.bottom <= containerRect.top + 1) continue;
      if (rect.top >= containerRect.bottom - 1) break;

      if (
        rect.top < containerRect.top - 1
      ) {
        const id = el.getAttribute("data-message-id")?.trim() ?? "";
        if (id) {
          const isLatestMessage = id === latestMessageId;
          const fillsViewportTail = rect.bottom >= containerRect.bottom - 1;
          if (isLatestMessage || fillsViewportTail) {
            nextId = id;
          }
        }
      }
      break;
    }

    setTopClippedMessageId(nextId);
  };

  const pinToLatestNow = () => {
    setIsViewingLatest(true);
    messagesEndEl?.scrollIntoView({ behavior: "auto", block: "end" });
  };

  const pinToLatestAfterLayout = () => {
    setIsViewingLatest(true);
    setTopClippedMessageId(null);
    messagesEndEl?.scrollIntoView({ behavior: "auto", block: "end" });
    queueMicrotask(() => {
      messagesEndEl?.scrollIntoView({ behavior: "auto", block: "end" });
    });
    window.requestAnimationFrame(() => {
      messagesEndEl?.scrollIntoView({ behavior: "auto", block: "end" });
      window.requestAnimationFrame(() => {
        pinToLatestNow();
      });
    });
  };

  const scheduleScrollToLatest = (behavior: ScrollBehavior = "auto") => {
    if (behavior === "smooth") {
      pendingScrollBehavior = "smooth";
    }
    if (scrollFrame !== undefined) return;
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = undefined;
      const nextBehavior = pendingScrollBehavior;
      pendingScrollBehavior = "auto";
      const now = Date.now();
      if (
        nextBehavior === "auto" &&
        now - lastAutoScrollAt < STREAM_SCROLL_MIN_INTERVAL_MS
        ) {
          return;
        }
        lastAutoScrollAt = now;
        scrollToLatest(nextBehavior);
      });
  };

  const cancelInitialAnchorFrames = () => {
    if (initialAnchorRafA !== undefined) {
      window.cancelAnimationFrame(initialAnchorRafA);
      initialAnchorRafA = undefined;
    }
    if (initialAnchorRafB !== undefined) {
      window.cancelAnimationFrame(initialAnchorRafB);
      initialAnchorRafB = undefined;
    }
    if (initialAnchorGuardTimer) {
      clearTimeout(initialAnchorGuardTimer);
      initialAnchorGuardTimer = undefined;
    }
    if (jumpControlsSuppressTimer !== undefined) {
      clearTimeout(jumpControlsSuppressTimer);
      jumpControlsSuppressTimer = undefined;
    }
  };

  const applyInitialBottomAnchor = (sessionId: string) => {
    cancelInitialAnchorFrames();
    initialAnchorGuardTimer = setTimeout(() => {
      initialAnchorGuardTimer = undefined;
      if (props.selectedSessionId !== sessionId) return;
      setInitialAnchorPending(false);
    }, 200);
    pinToLatestNow();
    initialAnchorRafA = window.requestAnimationFrame(() => {
      initialAnchorRafA = undefined;
      pinToLatestNow();
      initialAnchorRafB = window.requestAnimationFrame(() => {
        initialAnchorRafB = undefined;
        pinToLatestNow();
        if (props.selectedSessionId !== sessionId) return;
        setInitialAnchorPending(false);
      });
    });
  };

  onCleanup(() => {
    cancelInitialAnchorFrames();
    if (scrollFrame !== undefined) {
      window.cancelAnimationFrame(scrollFrame);
      scrollFrame = undefined;
    }
    if (streamRenderBatchTimer !== undefined) {
      window.clearTimeout(streamRenderBatchTimer);
      streamRenderBatchTimer = undefined;
    }
    streamRenderBatchQueuedAt = 0;
    streamRenderBatchReschedules = 0;
  });

  createEffect(
    on(
      () => [props.selectedSessionId, props.messages.length] as const,
      ([sessionId, count], previous) => {
        const previousSessionId = previous?.[0] ?? null;
        if (sessionId !== previousSessionId) {
          setMessageWindowSessionId(null);
          setMessageWindowExpanded(false);
          setMessageWindowStart(0);
        }

        if (!sessionId) return;
        if (messageWindowExpanded()) return;
        if (count === 0) return;

        const targetStart =
          count > INITIAL_MESSAGE_WINDOW ? count - INITIAL_MESSAGE_WINDOW : 0;
        if (messageWindowSessionId() !== sessionId) {
          setMessageWindowStart(targetStart);
          setMessageWindowSessionId(sessionId);
          return;
        }

        const currentStart = messageWindowStart();
        if (currentStart <= 0 && targetStart > 0) {
          setMessageWindowStart(targetStart);
          return;
        }

        if (isViewingLatest() && targetStart > currentStart) {
          setMessageWindowStart(targetStart);
        }
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    const count = props.messages.length;
    const start = messageWindowStart();
    if (start <= count) return;
    setMessageWindowStart(count);
  });

  const isAbsolutePath = (value: string) =>
    /^(?:[a-zA-Z]:[\\/]|\\\\|\/|~\/)/.test(value.trim());

  const handleWorkingFileClick = async (file: string) => {
    const trimmed = file.trim();
    if (!trimmed) return;

    if (props.activeWorkspaceDisplay.workspaceType === "remote") {
      setToastMessage("File open is unavailable for remote workspaces.");
      return;
    }

    if (!isTauriRuntime()) {
      setToastMessage("File open is available in the desktop app.");
      return;
    }

    try {
      const { openPath } = await import("@tauri-apps/plugin-opener");
      const result = await runLocalFileAction(
        trimmed,
        "open",
        async (candidate) => {
          await openPath(candidate);
        },
      );
      if (!result.ok && result.reason === "missing-root") {
        setToastMessage("Pick a workspace to open files.");
        return;
      }
      if (!result.ok) {
        setToastMessage(result.reason);
        return;
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to open file";
      setToastMessage(message);
    }
  };

  const loadAgentOptions = async (force = false) => {
    if (agentPickerBusy()) return agentOptions();
    if (agentPickerReady() && !force) return agentOptions();
    setAgentPickerBusy(true);
    setAgentPickerError(null);
    try {
      const agents = await props.listAgents();
      const sorted = agents
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name));
      setAgentOptions(sorted);
      setAgentPickerReady(true);
      return sorted;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load agents";
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
  const [runLastProgressAt, setRunLastProgressAt] = createSignal<number | null>(
    null,
  );
  const [runBaseline, setRunBaseline] = createSignal<{
    assistantId: string | null;
    partCount: number;
  }>({
    assistantId: null,
    partCount: 0,
  });
  const [abortBusy, setAbortBusy] = createSignal(false);
  const [todoExpanded, setTodoExpanded] = createSignal(false);

  const lastAssistantSnapshot = createMemo(() => {
    for (let i = props.messages.length - 1; i >= 0; i -= 1) {
      const msg = props.messages[i];
      const info = msg?.info as
        | { id?: string | number; role?: string }
        | undefined;
      if (info?.role === "assistant") {
        const id =
          typeof info.id === "string"
            ? info.id
            : typeof info.id === "number"
              ? String(info.id)
              : null;
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
    const now = Date.now();
    setRunStartedAt(now);
    setRunLastProgressAt(now);
    setRunHasBegun(false);
    captureRunBaseline();
  };

  const responseStarted = createMemo(() => {
    if (!runStartedAt()) return false;
    const baseline = runBaseline();
    const snapshot = lastAssistantSnapshot();
    if (!snapshot.id && !baseline.assistantId) return false;
    if (snapshot.id && snapshot.id !== baseline.assistantId) return true;
    return (
      snapshot.id === baseline.assistantId &&
      snapshot.partCount > baseline.partCount
    );
  });

  const runPhase = createMemo(() => {
    if (props.error && (runStartedAt() !== null || runHasBegun()))
      return "error";
    const status = props.sessionStatus;
    const started = runStartedAt() !== null;
    if (status === "idle") {
      if (!started) return "idle";
      return responseStarted() ? "responding" : "sending";
    }
    if (status === "retry")
      return responseStarted() ? "responding" : "retrying";
    if (responseStarted()) return "responding";
    return "thinking";
  });

  const showRunIndicator = createMemo(() => runPhase() !== "idle");

  const latestRunPart = createMemo<Part | null>(() => {
    if (!showRunIndicator()) return null;
    const baseline = runBaseline();
    for (let i = props.messages.length - 1; i >= 0; i -= 1) {
      const msg = props.messages[i];
      const info = msg?.info as
        | { id?: string | number; role?: string }
        | undefined;
      if (info?.role !== "assistant") continue;
      const messageId =
        typeof info.id === "string"
          ? info.id
          : typeof info.id === "number"
            ? String(info.id)
            : null;
      if (!messageId) continue;
      if (baseline.assistantId && messageId === baseline.assistantId) {
        if (msg.parts.length <= baseline.partCount) {
          return null;
        }
        return msg.parts[msg.parts.length - 1] ?? null;
      }
      if (!msg.parts.length) continue;
      return msg.parts[msg.parts.length - 1] ?? null;
    }
    return null;
  });

  const cleanReasoning = (value: string) =>
    value
      .replace(/\[REDACTED\]/g, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .trim();

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
        case "apply_patch":
          return "Writing file";
        case "bash":
          return "Running shell";
        default:
          return "Working";
      }
    }
    if (part.type === "reasoning") {
      const text = cleanReasoning(
        typeof (part as any).text === "string" ? (part as any).text : "",
      );
      const first = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (first) {
        const clipped = first.length > 56 ? `${first.slice(0, 53)}...` : first;
        return `Thinking: ${clipped}`;
      }
      return "Thinking";
    }
    if (part.type === "text") {
      return "Gathering thoughts";
    }
    return null;
  };

  const thinkingStatus = createMemo(() => {
    const status = computeStatusFromPart(latestRunPart());
    if (status) return status;
    if (runPhase() === "thinking") return "Thinking";
    return null;
  });

  const runProgressSignature = createMemo(() => {
    if (!showRunIndicator()) return "";
    const part = latestRunPart();
    const partTotal = totalPartCount();
    if (!part) {
      return `messages:${props.messages.length}:parts:${partTotal}:todos:${props.todos.length}`;
    }

    if (part.type === "reasoning" || part.type === "text") {
      const text =
        typeof (part as any).text === "string" ? (part as any).text : "";
      return `${part.type}:${text.length}:${text.slice(-48)}:parts:${partTotal}:todos:${props.todos.length}`;
    }

    if (part.type === "tool") {
      const state = (part as any).state ?? {};
      const status = typeof state.status === "string" ? state.status : "";
      const outputSize =
        typeof state.output === "string"
          ? state.output.length
          : Array.isArray(state.output)
            ? state.output.length
            : 0;
      return `tool:${status}:${outputSize}:parts:${partTotal}:todos:${props.todos.length}`;
    }

    return `${part.type}:parts:${partTotal}:todos:${props.todos.length}`;
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

  const runElapsedLabel = createMemo(
    () => `${Math.round(runElapsedMs()).toLocaleString()}ms`,
  );

  onMount(() => {
    setTimeout(() => setIsInitialLoad(false), 2000);
  });

  const jumpToLatest = (behavior: ScrollBehavior = "smooth") => {
    setIsViewingLatest(true);
    scheduleScrollToLatest(behavior);
  };

  const jumpToStartOfMessage = (behavior: ScrollBehavior = "smooth") => {
    const messageId = topClippedMessageId();
    const container = chatContainerEl;
    if (!messageId || !container) return;

    const escapedId = messageId.replace(/"/g, '\\"');
    const target = container.querySelector(
      `[data-message-id="${escapedId}"]`,
    ) as HTMLElement | null;
    if (!target) return;

    setIsViewingLatest(false);
    target.scrollIntoView({ behavior, block: "start" });
  };

  const suppressJumpControlsTemporarily = () => {
    if (jumpControlsSuppressTimer !== undefined) {
      clearTimeout(jumpControlsSuppressTimer);
    }
    setJumpControlsSuppressed(true);
    jumpControlsSuppressTimer = setTimeout(() => {
      jumpControlsSuppressTimer = undefined;
      setJumpControlsSuppressed(false);
    }, 1000);
  };

  onMount(() => {
    const container = chatContainerEl;
    const sentinel = bottomVisibilityEl;
    if (!container || !sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        const atBottom = Boolean(entry?.isIntersecting);
        if (atBottom) {
          setIsViewingLatest(true);
        }
        refreshTopClippedMessage();
      },
      {
        root: container,
        rootMargin: "0px 0px 96px 0px",
        threshold: 0,
      },
    );

    observer.observe(sentinel);
    onCleanup(() => observer.disconnect());
  });

  createEffect(
    on(
      () => props.selectedSessionId,
      (sessionId, previousSessionId) => {
        if (sessionId === previousSessionId) {
          return;
        }
        setSearchOpen(false);
        setSearchQuery("");
        setSearchQueryDebounced("");
        setActiveSearchHitIndex(0);

        if (!sessionId) return;
        setIsViewingLatest(true);
        setTopClippedMessageId(null);
        const firstVisit = !topInitializedSessionIds.has(sessionId);
        topInitializedSessionIds.add(sessionId);
        setInitialAnchorPending(true);

        if (!firstVisit) {
          queueMicrotask(() => {
            applyInitialBottomAnchor(sessionId);
          });
          return;
        }

        queueMicrotask(() => {
          applyInitialBottomAnchor(sessionId);
        });
      },
    ),
  );

  createEffect(
    on(
      () =>
        [
          props.selectedSessionId,
          props.messages.length,
          isChatContainerReady(),
          initialAnchorPending(),
        ] as const,
      ([sessionId, count, ready, pending]) => {
        if (!pending) return;
        if (!sessionId) {
          setInitialAnchorPending(false);
          return;
        }
        if (!ready) return;
        if (count === 0) {
          setInitialAnchorPending(false);
          return;
        }
        queueMicrotask(() => applyInitialBottomAnchor(sessionId));
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    const hits = searchHits();
    if (!hits.length) {
      setActiveSearchHitIndex(0);
      return;
    }
    setActiveSearchHitIndex((current) => {
      if (current < 0 || current >= hits.length) return 0;
      return current;
    });
  });

  createEffect(() => {
    const active = activeSearchHit();
    if (!active) return;
    if (scrollMessageIntoViewById?.(active.messageId, "smooth")) return;
    const container = chatContainerEl;
    if (!container) return;
    const escapedId = active.messageId.replace(/"/g, '\\"');
    const target = container.querySelector(
      `[data-message-id="${escapedId}"]`,
    ) as HTMLElement | null;
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  createEffect(() => {
    if (!commandPaletteOpen()) return;
    focusCommandPaletteInput();
  });

  createEffect(() => {
    if (!commandPaletteOpen()) return;
    const total = commandPaletteItems().length;
    if (total === 0) {
      setCommandPaletteActiveIndex(0);
      return;
    }
    setCommandPaletteActiveIndex((current) =>
      Math.max(0, Math.min(current, total - 1)),
    );
  });

  createEffect(() => {
    if (!commandPaletteOpen()) return;
    const idx = commandPaletteActiveIndex();
    requestAnimationFrame(() => {
      commandPaletteOptionRefs[idx]?.scrollIntoView({ block: "nearest" });
    });
  });

  createEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (
        mod &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        if (commandPaletteOpen()) {
          closeCommandPalette();
        } else {
          openCommandPalette();
        }
        return;
      }

      if (commandPaletteOpen()) {
        if (event.key === "Escape") {
          event.preventDefault();
          closeCommandPalette();
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          stepCommandPaletteIndex(1, commandPaletteItems().length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          stepCommandPaletteIndex(-1, commandPaletteItems().length);
          return;
        }
        if (event.key === "Enter") {
          if (event.isComposing || event.keyCode === 229) return;
          const item = commandPaletteItems()[commandPaletteActiveIndex()];
          if (!item) return;
          event.preventDefault();
          item.action();
          return;
        }
        if (
          event.key === "Backspace" &&
          !commandPaletteQuery().trim() &&
          commandPaletteMode() !== "root"
        ) {
          event.preventDefault();
          returnToCommandRoot();
        }
        return;
      }

      if (mod && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        openSearch();
        return;
      }
      if (!searchOpen()) return;
      if (mod && !event.altKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        moveSearchHit(event.shiftKey ? -1 : 1);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeSearch();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
  });

  createEffect(() => {
    const status = props.sessionStatus;
    if (status === "running" || status === "retry") {
      startRun();
      setRunHasBegun(true);
      if (isViewingLatest()) {
        pinToLatestAfterLayout();
      }
    }
  });

  createEffect(() => {
    if (responseStarted()) {
      setRunHasBegun(true);
    }
  });

  createEffect(() => {
    if (!runStartedAt()) return;
    if (props.sessionStatus === "idle" && runHasBegun()) {
      setRunStartedAt(null);
      setRunHasBegun(false);
      setRunLastProgressAt(null);
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
    if (!showRunIndicator()) return;
    runProgressSignature();
    if (initialAnchorPending()) return;
    if (!isViewingLatest()) return;
    scheduleScrollToLatest("auto");
  });

  createEffect(() => {
    batchedRenderedMessages();
    initialAnchorPending();
    queueMicrotask(refreshTopClippedMessage);
  });

  createEffect(
    on(
      () => [props.messages.length, props.todos.length, totalPartCount()],
      (current, previous) => {
        if (!previous) return;
        const [mLen, tLen, pCount] = current;
        const [prevM, prevT, prevP] = previous;
        if (mLen > prevM || tLen > prevT || pCount > prevP) {
          if (showRunIndicator()) {
            setRunLastProgressAt(Date.now());
          }
        }
      },
    ),
  );

  const runStallMs = createMemo(() => {
    if (!showRunIndicator()) return 0;
    if (runPhase() === "error") return 0;
    const last = runLastProgressAt() ?? runStartedAt() ?? Date.now();
    return Math.max(0, runTick() - last);
  });

  const stallThresholds = createMemo(() => {
    // Keep these thresholds user-friendly:
    // - "Still working" should appear quickly enough to reassure, but not so quickly it feels noisy.
    // - "Taking longer than usual" should appear late enough to avoid false alarms.
    const phase = runPhase();
    if (phase === "sending" || phase === "retrying") {
      return { softMs: 8_000, hardMs: 20_000 };
    }
    if (phase === "thinking") {
      return { softMs: 25_000, hardMs: 70_000 };
    }
    if (phase === "responding") {
      return { softMs: 25_000, hardMs: 90_000 };
    }
    return { softMs: 0, hardMs: 0 };
  });

  const stallStage = createMemo<"none" | "soft" | "hard">(() => {
    if (!showRunIndicator()) return "none";
    if (runPhase() === "error") return "none";
    const ms = runStallMs();
    const { softMs, hardMs } = stallThresholds();
    if (!softMs || !hardMs) return "none";
    if (ms >= hardMs) return "hard";
    if (ms >= softMs) return "soft";
    return "none";
  });

  let lastStallPerfStage: "none" | "soft" | "hard" = "none";
  createEffect(() => {
    if (!props.developerMode) {
      lastStallPerfStage = "none";
      return;
    }

    const stage = stallStage();
    if (stage === lastStallPerfStage) return;

    const previous = lastStallPerfStage;
    lastStallPerfStage = stage;

    if (stage === "none") {
      if (previous !== "none") {
        recordPerfLog(true, "session.run", "stall-recovered", {
          sessionID: props.selectedSessionId,
          phase: runPhase(),
          elapsedMs: runElapsedMs(),
          messageCount: props.messages.length,
          partCount: totalPartCount(),
        });
      }
      return;
    }

    recordPerfLog(
      true,
      "session.run",
      stage === "soft" ? "stall-soft" : "stall-hard",
      {
        sessionID: props.selectedSessionId,
        phase: runPhase(),
        stallMs: runStallMs(),
        elapsedMs: runElapsedMs(),
        messageCount: props.messages.length,
        renderedMessageCount: renderedMessages().length,
        hiddenMessageCount: hiddenMessageCount(),
        partCount: totalPartCount(),
      },
    );
  });

  const cancelRun = async () => {
    if (abortBusy()) return;
    if (!props.selectedSessionId) {
      setToastMessage("No session selected");
      return;
    }

    setAbortBusy(true);
    setToastMessage("Stopping the run...");
    try {
      await props.abortSession(props.selectedSessionId);
      setToastMessage("Stopped.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to stop";
      setToastMessage(message);
    } finally {
      setAbortBusy(false);
    }
  };

  const retryRun = async () => {
    const text = props.lastPromptSent.trim();
    if (!text) {
      setToastMessage("Nothing to retry yet");
      return;
    }

    if (abortBusy()) return;
    setAbortBusy(true);
    setToastMessage("Trying again...");
    try {
      if (showRunIndicator() && props.selectedSessionId) {
        await props.abortSession(props.selectedSessionId);
      }
    } catch {
      // If abort fails, still allow the retry. Users care more about forward motion.
    } finally {
      setAbortBusy(false);
    }

    props.retryLastPrompt();
  };

  const focusSearchInput = () => {
    queueMicrotask(() => {
      searchInputEl?.focus();
      searchInputEl?.select();
    });
  };

  const focusCommandPaletteInput = () => {
    queueMicrotask(() => {
      commandPaletteInputEl?.focus();
      commandPaletteInputEl?.select();
    });
  };

  const focusComposer = () => {
    if (typeof window === "undefined") return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent("openwork:focusPrompt"));
      });
    });
  };

  const openCommandPalette = (mode: CommandPaletteMode = "root") => {
    setCommandPaletteMode(mode);
    setCommandPaletteQuery("");
    setCommandPaletteActiveIndex(0);
    setCommandPaletteOpen(true);
    focusCommandPaletteInput();
  };

  const closeCommandPalette = () => {
    setCommandPaletteOpen(false);
    setCommandPaletteMode("root");
    setCommandPaletteQuery("");
    setCommandPaletteActiveIndex(0);
  };

  const stepCommandPaletteIndex = (delta: number, total: number) => {
    if (total <= 0) {
      setCommandPaletteActiveIndex(0);
      return;
    }
    setCommandPaletteActiveIndex((current) => {
      const normalized = ((current % total) + total) % total;
      return (normalized + delta + total) % total;
    });
  };

  const returnToCommandRoot = () => {
    if (commandPaletteMode() === "root") return;
    setCommandPaletteMode("root");
    setCommandPaletteQuery("");
    setCommandPaletteActiveIndex(0);
    focusCommandPaletteInput();
  };

  const openSearch = () => {
    setSearchOpen(true);
    focusSearchInput();
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQueryDebounced("");
  };

  const moveSearchHit = (offset: number) => {
    const total = searchHits().length;
    if (!total) return;
    setActiveSearchHitIndex((current) => {
      const normalized = ((current % total) + total) % total;
      return (normalized + offset + total) % total;
    });
  };

  const undoLastMessage = async () => {
    if (historyActionBusy()) return;
    if (!canUndoLastMessage()) {
      setToastMessage("Nothing to undo yet.");
      return;
    }

    setHistoryActionBusy("undo");
    try {
      await props.undoLastUserMessage();
      setToastMessage("Reverted the last user message.");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : props.safeStringify(error);
      setToastMessage(message || "Failed to undo");
    } finally {
      setHistoryActionBusy(null);
    }
  };

  const redoLastMessage = async () => {
    if (historyActionBusy()) return;
    if (!canRedoLastMessage()) {
      setToastMessage("Nothing to redo.");
      return;
    }

    setHistoryActionBusy("redo");
    try {
      await props.redoLastUserMessage();
      setToastMessage("Restored the reverted message.");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : props.safeStringify(error);
      setToastMessage(message || "Failed to redo");
    } finally {
      setHistoryActionBusy(null);
    }
  };

  const compactSessionHistory = async () => {
    if (historyActionBusy()) return;
    if (!canCompactSession()) {
      setToastMessage("Nothing to compact yet.");
      return;
    }

    const sessionID = props.selectedSessionId;
    const startedAt = perfNow();
    setHistoryActionBusy("compact");
    setToastMessage("Compacting session context...");
    try {
      await props.compactSession();
      setToastMessage("Session compacted.");
      finishPerf(props.developerMode, "session.compact", "ui-done", startedAt, {
        sessionID,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : props.safeStringify(error);
      setToastMessage(message || "Failed to compact session");
      finishPerf(
        props.developerMode,
        "session.compact",
        "ui-error",
        startedAt,
        {
          sessionID,
          error: message,
        },
      );
    } finally {
      setHistoryActionBusy(null);
    }
  };

  const triggerFlyout = (
    sourceEl: Element | null,
    targetId: string,
    label: string,
    icon: Flyout["icon"],
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
        rect: {
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        },
        targetRect: {
          top: targetRect.top,
          left: targetRect.left,
          width: targetRect.width,
          height: targetRect.height,
        },
        label,
        icon,
      },
    ]);

    setTimeout(() => {
      setFlyouts((prev) => prev.filter((f) => f.id !== id));
    }, 1000);
  };

  createEffect(() => {
    const count = todoCount();
    const prev = prevTodoCount();
    if (count > prev && prev > 0) {
      const lastMsg = chatContainerEl?.querySelector(
        '[data-message-role="assistant"]:last-child',
      );
      triggerFlyout(lastMsg ?? null, "sidebar-progress", "New Task", "check");
    }
    setPrevTodoCount(count);
  });

  createEffect(() => {
    const files = props.workingFiles;
    const count = files.length;
    const prev = prevFileCount();
    if (count > prev && prev > 0) {
      const lastMsg = chatContainerEl?.querySelector(
        '[data-message-role="assistant"]:last-child',
      );
      triggerFlyout(
        lastMsg ?? null,
        "sidebar-context",
        "File Modified",
        "folder",
      );
    }
    setPrevFileCount(count);
  });

  createEffect(() => {
    if (!toastMessage()) return;
    const id = window.setTimeout(() => setToastMessage(null), 2400);
    return () => window.clearTimeout(id);
  });

  function sessionTitleForId(id: string | null | undefined) {
    if (!id) return "";
    for (const group of props.workspaceSessionGroups) {
      const match = group.sessions.find((session) => session.id === id);
      if (match) return getDisplaySessionTitle(match.title, DEFAULT_SESSION_TITLE);
    }
    return "";
  }
  const selectedSessionTitle = createMemo(() => {
    const id = props.selectedSessionId;
    if (!id) return "";
    return sessionTitleForId(id);
  });
  const hasWorkspaceConfigured = createMemo(() => props.workspaces.length > 0);
  const showWorkspaceSetupEmptyState = createMemo(
    () =>
      !hasWorkspaceConfigured() &&
      !props.selectedSessionId &&
      props.messages.length === 0,
  );

  const renameCanSave = createMemo(() => {
    if (renameBusy()) return false;
    const next = renameTitle().trim();
    if (!next) return false;
    return next !== sessionTitleForId(renameSessionId()).trim();
  });

  const finishRenameModal = (
    restoreComposerFocus = renameReturnFocusToComposer(),
  ) => {
    setRenameModalOpen(false);
    setRenameSessionId(null);
    setRenameReturnFocusToComposer(false);
    if (restoreComposerFocus) {
      focusComposer();
    }
  };

  const openRenameModal = (options?: { returnFocusToComposer?: boolean }) => {
    const sessionId = props.selectedSessionId;
    if (!sessionId) {
      setToastMessage("No session selected");
      if (options?.returnFocusToComposer) {
        focusComposer();
      }
      return;
    }
    setRenameSessionId(sessionId);
    setRenameTitle(sessionTitleForId(sessionId));
    setRenameReturnFocusToComposer(options?.returnFocusToComposer === true);
    setRenameModalOpen(true);
  };

  const closeRenameModal = () => {
    if (renameBusy()) return;
    finishRenameModal();
  };

  const submitRename = async () => {
    const sessionId = renameSessionId();
    if (!sessionId) return;
    const next = renameTitle().trim();
    if (!next || !renameCanSave()) return;
    setRenameBusy(true);
    try {
      await props.renameSession(sessionId, next);
      finishRenameModal();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : props.safeStringify(error);
      setToastMessage(message);
    } finally {
      setRenameBusy(false);
    }
  };

  const openDeleteSessionModal = () => {
    const sessionId = props.selectedSessionId;
    if (!sessionId) {
      setToastMessage("No session selected");
      return;
    }
    setDeleteSessionId(sessionId);
    setDeleteSessionOpen(true);
  };

  const closeDeleteSessionModal = () => {
    if (deleteSessionBusy()) return;
    setDeleteSessionOpen(false);
    setDeleteSessionId(null);
  };

  const confirmDeleteSession = async () => {
    if (deleteSessionBusy()) return;
    const sessionId = deleteSessionId();
    if (!sessionId) return;
    setDeleteSessionBusy(true);
    try {
      await props.deleteSession(sessionId);
      setDeleteSessionOpen(false);
      setDeleteSessionId(null);
      setToastMessage("Session deleted");
      // Route away from the deleted session id.
      props.setView("session");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : props.safeStringify(error);
      setToastMessage(message || "Failed to delete session");
    } finally {
      setDeleteSessionBusy(false);
    }
  };

  const requireSessionId = () => {
    const sessionId = props.selectedSessionId;
    if (!sessionId) {
      setToastMessage("No session selected");
      return null;
    }
    return sessionId;
  };

  const openAgentPicker = () => {
    setAgentPickerOpen((current) => !current);
    if (!agentPickerReady()) {
      void loadAgentOptions();
    }
  };

  const applySessionAgent = async (agent: string | null) => {
    let sessionId = props.selectedSessionId;
    if (!sessionId) {
      // Auto-create a session when none is selected (same pattern as sendPrompt)
      sessionId = (await props.createSessionAndOpen()) ?? null;
      if (!sessionId) return;
    }
    props.setSessionAgent(sessionId, agent);
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

  const handleProviderAuthSelect = async (
    providerId: string,
    methodIndex?: number,
  ): Promise<ProviderOAuthStartResult> => {
    if (providerAuthActionBusy()) {
      throw new Error("Provider auth is already in progress.");
    }
    setProviderAuthActionBusy(true);
    try {
      return await props.startProviderAuth(providerId, methodIndex);
    } finally {
      setProviderAuthActionBusy(false);
    }
  };

  const handleProviderAuthOAuth = async (
    providerId: string,
    methodIndex: number,
    code?: string,
  ) => {
    if (providerAuthActionBusy()) return { connected: false, pending: true };
    setProviderAuthActionBusy(true);
    try {
      const result = await props.completeProviderAuthOAuth(
        providerId,
        methodIndex,
        code,
      );
      if (result.connected) {
        setToastMessage(result.message || "Provider connected");
        props.closeProviderAuthModal();
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "OAuth failed";
      setToastMessage(message);
      return { connected: false };
    } finally {
      setProviderAuthActionBusy(false);
    }
  };

  const handleProviderAuthApiKey = async (
    providerId: string,
    apiKey: string,
  ) => {
    if (providerAuthActionBusy()) return;
    setProviderAuthActionBusy(true);
    try {
      const message = await props.submitProviderApiKey(providerId, apiKey);
      setToastMessage(message || "API key saved");
      props.closeProviderAuthModal();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to save API key";
      setToastMessage(message);
    } finally {
      setProviderAuthActionBusy(false);
    }
  };

  const shareWorkspace = createMemo(() => {
    const id = shareWorkspaceId();
    if (!id) return null;
    return props.workspaces.find((ws) => ws.id === id) ?? null;
  });

  const shareWorkspaceName = createMemo(() => {
    const ws = shareWorkspace();
    return ws ? workspaceLabel(ws) : "";
  });

  const shareWorkspaceDetail = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) return "";
    if (ws.workspaceType === "remote") {
      if (ws.remoteType === "openwork") {
        const hostUrl = ws.openworkHostUrl?.trim() || ws.baseUrl?.trim() || "";
        const mounted = buildOpenworkWorkspaceBaseUrl(
          hostUrl,
          ws.openworkWorkspaceId,
        );
        return mounted || hostUrl;
      }
      return ws.baseUrl?.trim() || "";
    }
    return ws.path?.trim() || "";
  });

  const [shareLocalOpenworkWorkspaceId, setShareLocalOpenworkWorkspaceId] =
    createSignal<string | null>(null);
  const [shareWorkspaceProfileBusy, setShareWorkspaceProfileBusy] =
    createSignal(false);
  const [shareWorkspaceProfileUrl, setShareWorkspaceProfileUrl] = createSignal<
    string | null
  >(null);
  const [shareWorkspaceProfileError, setShareWorkspaceProfileError] =
    createSignal<string | null>(null);
  const [shareSkillsSetBusy, setShareSkillsSetBusy] = createSignal(false);
  const [shareSkillsSetUrl, setShareSkillsSetUrl] = createSignal<string | null>(
    null,
  );
  const [shareSkillsSetError, setShareSkillsSetError] = createSignal<
    string | null
  >(null);

  createEffect(
    on(shareWorkspaceId, () => {
      setShareWorkspaceProfileBusy(false);
      setShareWorkspaceProfileUrl(null);
      setShareWorkspaceProfileError(null);
      setShareSkillsSetBusy(false);
      setShareSkillsSetUrl(null);
      setShareSkillsSetError(null);
    }),
  );

  createEffect(() => {
    const ws = shareWorkspace();
    const baseUrl = props.openworkServerHostInfo?.baseUrl?.trim() ?? "";
    const token =
      props.openworkServerHostInfo?.ownerToken?.trim() ||
      props.openworkServerHostInfo?.clientToken?.trim() ||
      "";
    const workspacePath =
      ws?.workspaceType === "local" ? (ws.path?.trim() ?? "") : "";

    if (
      !ws ||
      ws.workspaceType !== "local" ||
      !workspacePath ||
      !baseUrl ||
      !token
    ) {
      setShareLocalOpenworkWorkspaceId(null);
      return;
    }

    let cancelled = false;
    setShareLocalOpenworkWorkspaceId(null);

    void (async () => {
      try {
        const client = createOpenworkServerClient({ baseUrl, token });
        const response = await client.listWorkspaces();
        if (cancelled) return;
        const items = Array.isArray(response.items) ? response.items : [];
        const targetPath = normalizeDirectoryPath(workspacePath);
        const match = items.find(
          (entry) => normalizeDirectoryPath(entry.path) === targetPath,
        );
        setShareLocalOpenworkWorkspaceId(match?.id ?? null);
      } catch {
        if (!cancelled) setShareLocalOpenworkWorkspaceId(null);
      }
    })();

    onCleanup(() => {
      cancelled = true;
    });
  });

  const shareFields = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) {
      return [] as Array<{
        label: string;
        value: string;
        secret?: boolean;
        placeholder?: string;
        hint?: string;
      }>;
    }

    if (ws.workspaceType !== "remote") {
      const hostUrl =
        props.openworkServerHostInfo?.connectUrl?.trim() ||
        props.openworkServerHostInfo?.lanUrl?.trim() ||
        props.openworkServerHostInfo?.mdnsUrl?.trim() ||
        props.openworkServerHostInfo?.baseUrl?.trim() ||
        "";
      const mountedUrl = shareLocalOpenworkWorkspaceId()
        ? buildOpenworkWorkspaceBaseUrl(
            hostUrl,
            shareLocalOpenworkWorkspaceId(),
          )
        : null;
      const url = mountedUrl || hostUrl;
      const ownerToken = props.openworkServerHostInfo?.ownerToken?.trim() || "";
      const collaboratorToken = props.openworkServerHostInfo?.clientToken?.trim() || "";
      return [
        {
          label: "Worker URL",
          value: url,
          placeholder: !isTauriRuntime()
            ? "Desktop app required"
            : "Starting server...",
          hint: mountedUrl
            ? "Use on phones or laptops connecting to this worker."
            : hostUrl
              ? "Worker URL is resolving; host URL shown as fallback."
              : undefined,
        },
        {
          label: "Password",
          value: ownerToken,
          secret: true,
          placeholder: isTauriRuntime() ? "-" : "Desktop app required",
          hint: mountedUrl
            ? "Use on phones or laptops connecting to this worker."
            : "Use when the remote client must answer permission prompts.",
        },
        {
          label: "Collaborator token",
          value: collaboratorToken,
          secret: true,
          placeholder: isTauriRuntime() ? "-" : "Desktop app required",
          hint: mountedUrl
            ? "Routine remote access when you do not need owner-only actions."
            : "Routine remote access to this host without owner-only actions.",
        },
      ];
    }

    if (ws.remoteType === "openwork") {
      const hostUrl = ws.openworkHostUrl?.trim() || ws.baseUrl?.trim() || "";
      const url =
        buildOpenworkWorkspaceBaseUrl(hostUrl, ws.openworkWorkspaceId) ||
        hostUrl;
      const token =
        ws.openworkToken?.trim() ||
        props.openworkServerSettings.token?.trim() ||
        "";
      return [
        {
          label: "Worker URL",
          value: url,
        },
        {
          label: "Password",
          value: token,
          secret: true,
          placeholder: token ? undefined : "Set token in workspace settings",
          hint: "This workspace is currently connected with this password.",
        },
      ];
    }

    const baseUrl = ws.baseUrl?.trim() || ws.path?.trim() || "";
    const directory = ws.directory?.trim() || "";
    return [
      {
        label: "OpenCode base URL",
        value: baseUrl,
      },
      {
        label: "Directory",
        value: directory,
        placeholder: "(auto)",
      },
    ];
  });

  const shareNote = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) return null;
    if (
      ws.workspaceType === "local" &&
      props.engineInfo?.runtime === "direct"
    ) {
      return "Engine runtime is set to Direct. Switching local workers can restart the host and disconnect clients. The token may change after a restart.";
    }
    return null;
  });

  const shareServiceDisabledReason = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) return "Select a workspace first.";
    if (ws.workspaceType === "remote" && ws.remoteType !== "openwork") {
      return "Share service links are available for OpenWork workers.";
    }
    if (ws.workspaceType !== "remote") {
      const baseUrl = props.openworkServerHostInfo?.baseUrl?.trim() ?? "";
      const token =
        props.openworkServerHostInfo?.ownerToken?.trim() ||
        props.openworkServerHostInfo?.clientToken?.trim() ||
        "";
      if (!baseUrl || !token) {
        return "Local OpenWork host is not ready yet.";
      }
    } else {
      const hostUrl = ws.openworkHostUrl?.trim() || ws.baseUrl?.trim() || "";
      const token =
        ws.openworkToken?.trim() ||
        props.openworkServerSettings.token?.trim() ||
        "";
      if (!hostUrl) return "Missing OpenWork host URL.";
      if (!token) return "Missing OpenWork token.";
    }
    return null;
  });

  const resolveShareExportContext = async (): Promise<{
    client: OpenworkServerClient;
    workspaceId: string;
    workspace: WorkspaceInfo;
  }> => {
    const ws = shareWorkspace();
    if (!ws) {
      throw new Error("Select a workspace first.");
    }

    if (ws.workspaceType !== "remote") {
      const baseUrl = props.openworkServerHostInfo?.baseUrl?.trim() ?? "";
      const token =
        props.openworkServerHostInfo?.ownerToken?.trim() ||
        props.openworkServerHostInfo?.clientToken?.trim() ||
        "";
      if (!baseUrl || !token) {
        throw new Error("Local OpenWork host is not ready yet.");
      }
      const client = createOpenworkServerClient({ baseUrl, token });

      let workspaceId = shareLocalOpenworkWorkspaceId()?.trim() ?? "";
      if (!workspaceId) {
        const response = await client.listWorkspaces();
        const items = Array.isArray(response.items) ? response.items : [];
        const targetPath = normalizeDirectoryPath(ws.path?.trim() ?? "");
        const match = items.find(
          (entry) => normalizeDirectoryPath(entry.path) === targetPath,
        );
        workspaceId = (match?.id ?? "").trim();
        setShareLocalOpenworkWorkspaceId(workspaceId || null);
      }

      if (!workspaceId) {
        throw new Error(
          "Could not resolve this workspace on the local OpenWork host.",
        );
      }

      return { client, workspaceId, workspace: ws };
    }

    if (ws.remoteType !== "openwork") {
      throw new Error(
        "Share service links are available for OpenWork workers.",
      );
    }

    const hostUrl = ws.openworkHostUrl?.trim() || ws.baseUrl?.trim() || "";
    const token =
      ws.openworkToken?.trim() ||
      props.openworkServerSettings.token?.trim() ||
      "";
    if (!hostUrl || !token) {
      throw new Error("OpenWork host URL and token are required.");
    }

    const client = createOpenworkServerClient({ baseUrl: hostUrl, token });
    let workspaceId =
      ws.openworkWorkspaceId?.trim() ||
      parseOpenworkWorkspaceIdFromUrl(ws.openworkHostUrl ?? "") ||
      parseOpenworkWorkspaceIdFromUrl(ws.baseUrl ?? "") ||
      "";

    if (!workspaceId) {
      const response = await client.listWorkspaces();
      const items = Array.isArray(response.items) ? response.items : [];
      const directoryHint = normalizeDirectoryPath(
        ws.directory?.trim() ?? ws.path?.trim() ?? "",
      );
      const match = directoryHint
        ? items.find((entry) => {
            const entryPath = normalizeDirectoryPath(
              (
                entry.opencode?.directory ??
                entry.directory ??
                entry.path ??
                ""
              ).trim(),
            );
            return Boolean(entryPath && entryPath === directoryHint);
          })
        : ((response.activeId
            ? items.find((entry) => entry.id === response.activeId)
            : null) ?? items[0]);
      workspaceId = (match?.id ?? "").trim();
    }

    if (!workspaceId) {
      throw new Error("Could not resolve this workspace on the OpenWork host.");
    }

    return { client, workspaceId, workspace: ws };
  };

  const publishWorkspaceProfileLink = async () => {
    if (shareWorkspaceProfileBusy()) return;
    setShareWorkspaceProfileBusy(true);
    setShareWorkspaceProfileError(null);
    setShareWorkspaceProfileUrl(null);

    try {
      const { client, workspaceId, workspace } =
        await resolveShareExportContext();
      const exported = await client.exportWorkspace(workspaceId);
      const payload: WorkspaceProfileBundleV1 = {
        schemaVersion: 1,
        type: "workspace-profile",
        name: `${workspaceLabel(workspace)} profile`,
        description:
          "Full OpenWork workspace profile with config, MCP setup, commands, and skills.",
        workspace: exported,
      };

      const result = await publishOpenworkBundleJson({
        payload,
        bundleType: "workspace-profile",
        name: payload.name,
      });

      setShareWorkspaceProfileUrl(result.url);
      try {
        await navigator.clipboard.writeText(result.url);
      } catch {
        // ignore
      }
    } catch (error) {
      setShareWorkspaceProfileError(
        error instanceof Error
          ? error.message
          : "Failed to publish workspace profile",
      );
    } finally {
      setShareWorkspaceProfileBusy(false);
    }
  };

  const publishSkillsSetLink = async () => {
    if (shareSkillsSetBusy()) return;
    setShareSkillsSetBusy(true);
    setShareSkillsSetError(null);
    setShareSkillsSetUrl(null);

    try {
      const { client, workspaceId, workspace } =
        await resolveShareExportContext();
      const exported = await client.exportWorkspace(workspaceId);
      const skills = Array.isArray(exported.skills) ? exported.skills : [];
      if (!skills.length) {
        throw new Error("No skills found in this workspace.");
      }

      const payload: SkillsSetBundleV1 = {
        schemaVersion: 1,
        type: "skills-set",
        name: `${workspaceLabel(workspace)} skills`,
        description: "Complete skills set from an OpenWork workspace.",
        skills: skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          trigger: skill.trigger,
          content: skill.content,
        })),
        sourceWorkspace: {
          id: workspaceId,
          name: workspaceLabel(workspace),
        },
      };

      const result = await publishOpenworkBundleJson({
        payload,
        bundleType: "skills-set",
        name: payload.name,
      });

      setShareSkillsSetUrl(result.url);
      try {
        await navigator.clipboard.writeText(result.url);
      } catch {
        // ignore
      }
    } catch (error) {
      setShareSkillsSetError(
        error instanceof Error ? error.message : "Failed to publish skills set",
      );
    } finally {
      setShareSkillsSetBusy(false);
    }
  };

  const exportDisabledReason = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) return "Export is available for local workers in the desktop app.";
    if (ws.workspaceType === "remote")
      return "Export is only supported for local workers.";
    if (!isTauriRuntime()) return "Export is available in the desktop app.";
    if (props.exportWorkspaceBusy) return "Export is already running.";
    return null;
  });

  const handleSendPrompt = (draft: ComposerDraft) => {
    suppressJumpControlsTemporarily();
    pinToLatestAfterLayout();
    startRun();
    props.sendPromptAsync(draft).catch(() => undefined);
  };

  const isSandboxWorkspace = createMemo(() =>
    Boolean(
      (props.activeWorkspaceDisplay as any)?.sandboxContainerName?.trim(),
    ),
  );

  const uploadInboxFiles = async (
    files: File[],
    options?: { notify?: boolean },
  ): Promise<Array<{ name: string; path: string }>> => {
    const notify = options?.notify ?? true;
    const client = props.openworkServerClient;
    const workspaceId = props.openworkServerWorkspaceId?.trim() ?? "";
    if (!client || !workspaceId) {
      if (notify) {
        setToastMessage(
          "Connect to the OpenWork server to upload files to the shared folder.",
        );
      }
      return [];
    }
    if (!files.length) return [];

    const label =
      files.length === 1 ? (files[0]?.name ?? "file") : `${files.length} files`;
    if (notify) {
      setToastMessage(`Uploading ${label} to the shared folder...`);
    }

    try {
      const uploaded: Array<{ name: string; path: string }> = [];
      for (const file of files) {
        const result = await client.uploadInbox(workspaceId, file);
        const path = result.path?.trim() || file.name;
        uploaded.push({ name: file.name || path, path });
      }
      if (notify) {
        const summary = uploaded
          .map((file) => file.name)
          .filter(Boolean)
          .join(", ");
        setToastMessage(
          summary
            ? `Uploaded to the shared folder: ${summary}`
            : "Uploaded to the shared folder.",
        );
      }
      return uploaded;
    } catch (error) {
      if (notify) {
        const message =
          error instanceof Error
            ? error.message
            : "Shared folder upload failed";
        setToastMessage(message);
      }
      return [];
    }
  };

  const handleDraftChange = (draft: ComposerDraft) => {
    props.setPrompt(draft.text);
  };

  const openSessionFromList = (
    workspaceId: string,
    sessionId: string,
    options?: { focusComposer?: boolean },
  ) => {
    if (!sessionId) return;
    const shouldFocusComposer = options?.focusComposer === true;
    // Route-driven selection: navigate first and let the route effect own selectSession.
    if (workspaceId === props.activeWorkspaceId) {
      props.setView("session", sessionId);
      if (shouldFocusComposer) {
        focusComposer();
      }
      return;
    }
    // For different workspace, activate workspace first
    void (async () => {
      await Promise.resolve(props.activateWorkspace(workspaceId));
      props.setView("session", sessionId);
      if (shouldFocusComposer) {
        focusComposer();
      }
    })();
  };

  const createTaskInWorkspace = (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    if (id === props.activeWorkspaceId) {
      props.createSessionAndOpen();
      return;
    }
    void (async () => {
      await Promise.resolve(props.activateWorkspace(id));
      props.createSessionAndOpen();
    })();
  };

  const commandPaletteRootItems = createMemo<CommandPaletteItem[]>(() => {
    const items: CommandPaletteItem[] = [
      {
        id: "new-session",
        title: "Create new session",
        detail: "Start a fresh task in the current workspace",
        meta: "Create",
        action: () => {
          closeCommandPalette();
          void Promise.resolve(props.createSessionAndOpen())
            .then((sessionId) => {
              if (!sessionId) return;
              focusComposer();
            })
            .catch((error) => {
              const message =
                error instanceof Error
                  ? error.message
                  : "Failed to create session";
              setToastMessage(message);
            });
        },
      },
      {
        id: "rename-session",
        title: "Rename current session",
        detail:
          selectedSessionTitle().trim() ||
          "Give your selected session a clearer name",
        meta: "Rename",
        action: () => {
          closeCommandPalette();
          openRenameModal({ returnFocusToComposer: true });
        },
      },
      {
        id: "sessions",
        title: "Search sessions",
        detail: `${totalSessionCount().toLocaleString()} available across workspaces`,
        meta: "Jump",
        action: () => {
          setCommandPaletteMode("sessions");
          setCommandPaletteQuery("");
          setCommandPaletteActiveIndex(0);
          focusCommandPaletteInput();
        },
      },
      {
        id: "model",
        title: "Change model",
        detail: `${props.selectedSessionModelLabel || "Model"} · ${props.modelVariantLabel}`,
        meta: "Open",
        action: () => {
          closeCommandPalette();
          props.openSessionModelPicker({ returnFocusTarget: "composer" });
        },
      },
      {
        id: "provider",
        title: "Connect provider",
        detail: "Open provider connection flow",
        meta: "Open",
        action: () => {
          closeCommandPalette();
          void props
            .openProviderAuthModal({ returnFocusTarget: "composer" })
            .catch((error) => {
              const message =
                error instanceof Error
                  ? error.message
                  : "Failed to load providers";
              setToastMessage(message);
              focusComposer();
            });
        },
      },
    ];

    const query = commandPaletteQuery().trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) =>
      `${item.title} ${item.detail ?? ""}`.toLowerCase().includes(query),
    );
  });

  const commandPaletteSessionItems = createMemo<CommandPaletteItem[]>(() => {
    const query = commandPaletteQuery().trim().toLowerCase();
    const candidates = query
      ? commandPaletteSessionOptions().filter((item) =>
          item.searchText.includes(query),
        )
      : commandPaletteSessionOptions();

    return candidates.slice(0, 80).map((item) => ({
      id: `session:${item.workspaceId}:${item.sessionId}`,
      title: item.title,
      detail: item.workspaceTitle,
      meta:
        item.workspaceId === props.activeWorkspaceId
          ? "Current workspace"
          : "Switch",
      action: () => {
        closeCommandPalette();
        openSessionFromList(item.workspaceId, item.sessionId, {
          focusComposer: true,
        });
      },
    }));
  });

  const commandPaletteItems = createMemo<CommandPaletteItem[]>(() => {
    const mode = commandPaletteMode();
    if (mode === "sessions") return commandPaletteSessionItems();
    return commandPaletteRootItems();
  });

  const commandPaletteTitle = createMemo(() => {
    const mode = commandPaletteMode();
    if (mode === "sessions") return "Search sessions";
    return "Quick actions";
  });

  const commandPalettePlaceholder = createMemo(() => {
    const mode = commandPaletteMode();
    if (mode === "sessions") return "Find by session title or workspace";
    return "Search actions";
  });

  createEffect(
    on(
      () => [commandPaletteMode(), commandPaletteQuery()],
      () => {
        if (!commandPaletteOpen()) return;
        commandPaletteOptionRefs.length = 0;
        setCommandPaletteActiveIndex(0);
      },
    ),
  );

  const openSettings = (tab: SettingsTab = "general") => {
    props.setSettingsTab(tab);
    props.setTab("settings");
    props.setView("dashboard");
  };

  const openConfig = () => {
    props.setTab(props.developerMode ? "config" : "identities");
    props.setView("dashboard");
  };

  const showUpdatePill = createMemo(() => {
    if (!isTauriRuntime()) return false;
    const state = props.updateStatus?.state;
    return (
      state === "available" || state === "downloading" || state === "ready"
    );
  });

  const updateDownloadPercent = createMemo<number | null>(() => {
    const total = props.updateStatus?.totalBytes;
    if (total == null || total <= 0) return null;
    const downloaded = props.updateStatus?.downloadedBytes ?? 0;
    const clamped = Math.max(0, Math.min(1, downloaded / total));
    return Math.floor(clamped * 100);
  });

  const updatePillLabel = createMemo(() => {
    const state = props.updateStatus?.state;
    if (state === "ready") {
      return props.anyActiveRuns ? "Update ready" : "Install update";
    }
    if (state === "downloading") {
      const percent = updateDownloadPercent();
      return percent == null ? "Downloading" : `Downloading ${percent}%`;
    }
    return "Update available";
  });

  const updatePillButtonTone = createMemo(() => {
    const state = props.updateStatus?.state;
    if (state === "ready") {
      return props.anyActiveRuns
        ? "text-amber-11 hover:text-amber-11 hover:bg-amber-3/30"
        : "text-green-11 hover:text-green-11 hover:bg-green-3/30";
    }
    if (state === "downloading") {
      return "text-blue-11 hover:text-blue-11 hover:bg-blue-3/30";
    }
    return "text-dls-secondary hover:text-emerald-11 hover:bg-emerald-3/25";
  });

  const updatePillBorderTone = createMemo(() => {
    const state = props.updateStatus?.state;
    if (state === "ready") {
      return props.anyActiveRuns ? "border-amber-7/35" : "border-green-7/35";
    }
    if (state === "downloading") {
      return "border-blue-7/35";
    }
    return "border-dls-border";
  });

  const updatePillDotTone = createMemo(() => {
    const state = props.updateStatus?.state;
    if (state === "ready") {
      return props.anyActiveRuns
        ? "text-amber-10 fill-amber-10"
        : "text-green-10 fill-green-10";
    }
    if (state === "downloading") {
      return "text-blue-10";
    }
    return "text-emerald-10 fill-emerald-10";
  });

  const updatePillVersionTone = createMemo(() => {
    const state = props.updateStatus?.state;
    if (state === "ready") {
      return props.anyActiveRuns ? "text-amber-11/75" : "text-green-11/75";
    }
    if (state === "downloading") {
      return "text-blue-11/75";
    }
    return "text-dls-secondary";
  });

  const updatePillTitle = createMemo(() => {
    const version = props.updateStatus?.version
      ? `v${props.updateStatus.version}`
      : "";
    const state = props.updateStatus?.state;
    if (state === "ready") {
      return props.anyActiveRuns
        ? `Update ready ${version}. Stop active runs to restart.`
        : `Restart to apply update ${version}`;
    }
    if (state === "downloading") return `Downloading update ${version}`;
    return `Update available ${version}`;
  });

  const handleUpdatePillClick = () => {
    const state = props.updateStatus?.state;
    if (state === "ready" && !props.anyActiveRuns) {
      props.installUpdateAndRestart();
      return;
    }
    openSettings("advanced");
  };

  const openMcp = () => {
    props.setTab("mcp");
    props.setView("dashboard");
  };

  const openProviderAuth = (preferredProviderId?: string) => {
    void props.openProviderAuthModal({ preferredProviderId }).catch((error) => {
      const message = error instanceof Error ? error.message : "Connect failed";
      setToastMessage(message);
    });
  };

  const openNewSessionProviderCta = () => {
    openProviderAuth("openai");
  };

  const hasOpenAiProviderConnected = createMemo(() =>
    (props.providerConnectedIds ?? []).some((id) => id.trim().toLowerCase() === "openai")
  );
  const showNewSessionProviderCta = createMemo(() => !hasOpenAiProviderConnected());
  const emptyStatePreset = createMemo(
    () =>
      props.activeWorkspaceConfig?.workspace?.preset?.trim() ||
      props.activeWorkspaceDisplay.preset ||
      "starter",
  );
  const blueprintEmptyState = createMemo(
    () => props.activeWorkspaceConfig?.blueprint?.emptyState ?? null,
  );
  const emptyStateTitle = createMemo(() => {
    const configured = blueprintEmptyState()?.title?.trim();
    if (configured) return configured;
    return defaultBlueprintCopyForPreset(emptyStatePreset()).title;
  });
  const emptyStateBody = createMemo(() => {
    const configured = blueprintEmptyState()?.body?.trim();
    if (configured) return configured;
    return defaultBlueprintCopyForPreset(emptyStatePreset()).body;
  });
  const emptyStateStarters = createMemo<ResolvedEmptyStateStarter[]>(() => {
    const configured = blueprintEmptyState()?.starters;
    const source =
      Array.isArray(configured)
        ? configured
        : defaultBlueprintStartersForPreset(emptyStatePreset());

    const resolved: ResolvedEmptyStateStarter[] = [];

    for (const [index, starter] of source.entries()) {
      const title = starter.title?.trim();
      const description = starter.description?.trim() || undefined;
      const prompt = starter.prompt?.trim() || undefined;
      const action = starter.action ?? undefined;
      const kind = starter.kind ?? (action ? "action" : "prompt");

      if (!title) continue;
      if (kind === "action") {
        if (!action) continue;
        if (action === "connect-openai" && !showNewSessionProviderCta()) {
          continue;
        }
        resolved.push({
          id: starter.id?.trim() || `starter-${index}`,
          kind: "action",
          title,
          description,
          action,
        });
        continue;
      }

      if (!prompt) continue;
      resolved.push({
        id: starter.id?.trim() || `starter-${index}`,
        kind: kind === "session" ? "session" : "prompt",
        title,
        description,
        prompt,
      });
    }

    return resolved;
  });
  const applyStarterPrompt = (text: string) => {
    props.setPrompt(text);
    focusComposer();
  };
  const runStarterPrompt = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    handleSendPrompt({
      mode: "prompt",
      text: trimmed,
      resolvedText: trimmed,
      parts: [{ type: "text", text: trimmed }],
      attachments: [],
    });
  };
  const handleEmptyStateStarter = (starter: ResolvedEmptyStateStarter) => {
    if (starter.kind === "action") {
      if (starter.action === "connect-openai") {
        openNewSessionProviderCta();
      }
      return;
    }
    if (!starter.prompt) return;
    if (starter.kind === "session") {
      runStarterPrompt(starter.prompt);
      return;
    }
    applyStarterPrompt(starter.prompt);
  };
  return (
    <div class="h-[100dvh] min-h-screen w-full overflow-hidden bg-[var(--dls-app-bg)] p-3 md:p-4 text-gray-12 font-sans">
      <div class="flex h-full w-full gap-3 md:gap-4">
        <aside
          class="relative hidden lg:flex shrink-0 flex-col overflow-hidden rounded-[24px] border border-dls-border bg-dls-sidebar p-2.5"
          style={{
            width: `${leftSidebarWidth()}px`,
            "min-width": `${leftSidebarWidth()}px`,
          }}
        >
          <div class="shrink-0">
            <Show when={showUpdatePill()}>
              <button
                type="button"
                class={`group mb-3 w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.2)] ${updatePillButtonTone()}`}
                onClick={handleUpdatePillClick}
                title={updatePillTitle()}
                aria-label={updatePillTitle()}
              >
                <Show
                  when={props.updateStatus?.state === "downloading"}
                  fallback={
                    <Circle
                      size={8}
                      class={`${updatePillDotTone()} shrink-0 ${props.updateStatus?.state === "available" ? "group-hover:animate-pulse" : ""}`}
                    />
                  }
                >
                  <Loader2
                    size={13}
                    class={`animate-spin shrink-0 ${updatePillDotTone()}`}
                  />
                </Show>
                <span class="flex-1 text-left">{updatePillLabel()}</span>
                <Show when={props.updateStatus?.version}>
                  {(version) => (
                    <span
                      class={`ml-auto font-mono text-[10px] ${updatePillVersionTone()}`}
                    >
                      v{version()}
                    </span>
                  )}
                </Show>
              </button>
            </Show>
          </div>
          <div class="flex min-h-0 flex-1">
            <WorkspaceSessionList
              workspaceSessionGroups={props.workspaceSessionGroups}
              activeWorkspaceId={props.activeWorkspaceId}
              developerMode={props.developerMode}
              selectedSessionId={props.selectedSessionId}
              showSessionActions
              sessionStatusById={props.sessionStatusById}
              connectingWorkspaceId={props.connectingWorkspaceId}
              workspaceConnectionStateById={props.workspaceConnectionStateById}
              newTaskDisabled={props.newTaskDisabled}
              importingWorkspaceConfig={props.importingWorkspaceConfig}
              onActivateWorkspace={props.activateWorkspace}
              onOpenSession={openSessionFromList}
              onCreateTaskInWorkspace={createTaskInWorkspace}
              onOpenRenameSession={openRenameModal}
              onOpenDeleteSession={openDeleteSessionModal}
              onOpenRenameWorkspace={props.openRenameWorkspace}
              onShareWorkspace={(workspaceId) =>
                setShareWorkspaceId(workspaceId)
              }
              onRevealWorkspace={revealWorkspaceInFinder}
              onRecoverWorkspace={props.recoverWorkspace}
              onTestWorkspaceConnection={props.testWorkspaceConnection}
              onEditWorkspaceConnection={props.editWorkspaceConnection}
              onForgetWorkspace={props.forgetWorkspace}
              onOpenCreateWorkspace={props.openCreateWorkspace}
              onOpenCreateRemoteWorkspace={props.openCreateRemoteWorkspace}
              onImportWorkspaceConfig={props.importWorkspaceConfig}
            />
          </div>
          <div
            class="absolute right-0 top-3 hidden h-[calc(100%-24px)] w-2 translate-x-1/2 cursor-col-resize rounded-full bg-transparent transition-colors hover:bg-gray-6/40 lg:block"
            onPointerDown={startLeftSidebarResize}
            title="Resize workspace column"
            aria-label="Resize workspace column"
          />
        </aside>

        <main class="min-w-0 flex-1 flex flex-col overflow-hidden rounded-[24px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]">
          <header class="z-10 flex h-12 shrink-0 items-center justify-between border-b border-dls-border bg-dls-surface px-4 md:px-6">
            <div class="flex min-w-0 items-center gap-3">
              <Show when={showUpdatePill()}>
                <button
                  type="button"
                  class={`md:hidden flex items-center gap-1.5 rounded-full border bg-dls-surface px-2.5 py-1 text-xs font-medium shadow-sm transition-colors active:scale-[0.99] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.2)] ${updatePillBorderTone()} ${updatePillButtonTone()}`}
                  onClick={handleUpdatePillClick}
                  title={updatePillTitle()}
                  aria-label={updatePillTitle()}
                >
                  <Show
                    when={props.updateStatus?.state === "downloading"}
                    fallback={
                      <Circle
                        size={8}
                        class={`${updatePillDotTone()} shrink-0 ${props.updateStatus?.state === "available" ? "animate-pulse" : ""}`}
                      />
                    }
                  >
                    <Loader2
                      size={13}
                      class={`animate-spin shrink-0 ${updatePillDotTone()}`}
                    />
                  </Show>
                  <span class="text-[11px]">{updatePillLabel()}</span>
                  <Show when={props.updateStatus?.version}>
                    {(version) => (
                      <span
                        class={`hidden sm:inline font-mono text-[10px] ${updatePillVersionTone()}`}
                      >
                        v{version()}
                      </span>
                    )}
                  </Show>
                </button>
              </Show>

              <h1 class="truncate text-[15px] font-semibold text-dls-text">
                {showWorkspaceSetupEmptyState()
                  ? "Create or connect a workspace"
                  : selectedSessionTitle() || DEFAULT_SESSION_TITLE}
              </h1>
              <Show when={props.developerMode}>
                <span class="hidden text-[12px] text-dls-secondary lg:inline">
                  {props.headerStatus}
                </span>
              </Show>
              <Show when={props.busyHint}>
                <span class="hidden text-[12px] text-dls-secondary lg:inline">
                  {props.busyHint}
                </span>
              </Show>
            </div>

            <div class="flex items-center gap-1.5 text-gray-10">
              <button
                type="button"
                class={`hidden items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors sm:flex ${
                  commandPaletteOpen()
                    ? "bg-gray-2 text-dls-text"
                    : "text-gray-10 hover:bg-gray-2/70 hover:text-dls-text"
                }`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (commandPaletteOpen()) {
                    closeCommandPalette();
                    return;
                  }
                  window.setTimeout(() => openCommandPalette(), 0);
                }}
                title="Quick actions (Ctrl/Cmd+K)"
                aria-label="Quick actions"
              >
                <Menu size={15} />
                <span>Menu</span>
                <span class="ml-1 rounded border border-dls-border px-1 text-[10px] text-gray-9">
                  ⌘K
                </span>
              </button>
              <button
                type="button"
                class={`flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
                  searchOpen()
                    ? "bg-gray-2 text-dls-text"
                    : "text-gray-10 hover:bg-gray-2/70 hover:text-dls-text"
                }`}
                onClick={() => {
                  if (searchOpen()) {
                    closeSearch();
                    return;
                  }
                  openSearch();
                }}
                title="Search conversation (Ctrl/Cmd+F)"
                aria-label="Search conversation"
              >
                <Search size={16} />
              </button>
              <div class="hidden h-4 w-px bg-dls-border sm:block" />
              <button
                type="button"
                class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-60"
                onClick={undoLastMessage}
                disabled={!canUndoLastMessage() || historyActionBusy() !== null}
                title="Undo last message"
                aria-label="Undo last message"
              >
                <Show
                  when={historyActionBusy() === "undo"}
                  fallback={<Undo2 size={16} />}
                >
                  <Loader2 size={16} class="animate-spin" />
                </Show>
                <span class="hidden lg:inline">Revert</span>
              </button>
              <button
                type="button"
                class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-60"
                onClick={redoLastMessage}
                disabled={!canRedoLastMessage() || historyActionBusy() !== null}
                title="Redo last reverted message"
                aria-label="Redo last reverted message"
              >
                <Show
                  when={historyActionBusy() === "redo"}
                  fallback={<Redo2 size={16} />}
                >
                  <Loader2 size={16} class="animate-spin" />
                </Show>
                <span class="hidden lg:inline">Redo</span>
              </button>
              <div class="hidden h-4 w-px bg-dls-border sm:block" />
              <button
                type="button"
                class="flex h-9 w-9 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text md:hidden"
                onClick={() => setMobileRightSidebarOpen(true)}
                title="Open sidebar"
                aria-label="Open sidebar"
              >
                <Menu size={16} />
              </button>
            </div>
          </header>

          <Show when={searchOpen()}>
            <div class="border-b border-dls-border bg-dls-sidebar/70 px-4 py-2 md:px-6">
              <div class="mx-auto flex w-full max-w-[800px] items-center gap-2 rounded-[16px] border border-dls-border bg-dls-surface px-3 py-2 shadow-[var(--dls-card-shadow)]">
                <Search size={14} class="text-gray-9" />
                <input
                  ref={(el) => (searchInputEl = el)}
                  type="text"
                  value={searchQuery()}
                  onInput={(event) => {
                    setSearchQuery(event.currentTarget.value);
                    setActiveSearchHitIndex(0);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      moveSearchHit(event.shiftKey ? -1 : 1);
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      closeSearch();
                    }
                  }}
                  class="min-w-0 flex-1 bg-transparent text-sm text-gray-11 placeholder:text-gray-9 focus:outline-none"
                  placeholder="Search in this chat"
                  aria-label="Search in this chat"
                />
                <span class="text-[11px] text-gray-10 tabular-nums">
                  {activeSearchPositionLabel()}
                </span>
                <button
                  type="button"
                  class="rounded-md border border-dls-border px-2 py-1 text-[11px] text-gray-10 transition-colors hover:bg-gray-2 hover:text-gray-12 disabled:opacity-60"
                  disabled={searchHits().length === 0}
                  onClick={() => moveSearchHit(-1)}
                  aria-label="Previous match"
                >
                  Prev
                </button>
                <button
                  type="button"
                  class="rounded-md border border-dls-border px-2 py-1 text-[11px] text-gray-10 transition-colors hover:bg-gray-2 hover:text-gray-12 disabled:opacity-60"
                  disabled={searchHits().length === 0}
                  onClick={() => moveSearchHit(1)}
                  aria-label="Next match"
                >
                  Next
                </button>
                <button
                  type="button"
                  class="flex h-7 w-7 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-2 hover:text-gray-12"
                  onClick={closeSearch}
                  aria-label="Close search"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          </Show>

          <Show when={props.showSkillReloadBanner}>
            <div class="border-b border-dls-border/70 bg-dls-surface animate-in fade-in slide-in-from-top-3 duration-300">
              <div class="flex min-h-[104px] items-start gap-3 px-4 py-5 sm:px-6 lg:px-10">
                <div
                  class={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border ${
                    props.reloadBannerBlocked
                      ? "border-amber-6/40 bg-amber-4/80 text-amber-11"
                      : "border-sky-6/40 bg-sky-4/80 text-sky-11"
                  }`.trim()}
                >
                  <RefreshCcw size={18} class={props.reloadBusy ? "animate-spin" : ""} />
                </div>

                <div class="min-w-0 flex-1">
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="truncate text-sm font-semibold text-gray-12">{props.reloadBannerTitle}</span>
                        <Show when={props.reloadBannerBlocked}>
                          <span class="inline-flex items-center gap-1 rounded-full bg-amber-4 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-11">
                            Active tasks
                          </span>
                        </Show>
                      </div>

                      <div class="mt-1 space-y-1 text-sm leading-relaxed text-gray-10">
                        <div>
                          <Show
                            when={props.reloadBannerBlocked}
                            fallback={
                              <Show when={props.reloadError} fallback={props.reloadBannerBody}>
                                <span class="font-medium text-red-11">{props.reloadError}</span>
                              </Show>
                            }
                          >
                            <span class="font-medium text-amber-11">Reloading will stop active tasks.</span>
                          </Show>
                        </div>

                        <Show when={props.reloadBannerBlocked}>
                          <div class="flex items-start gap-2 rounded-2xl border border-amber-6/40 bg-amber-3/70 px-3 py-2 text-xs text-amber-11">
                            <AlertTriangle size={14} class="mt-0.5 shrink-0" />
                            <span>
                              {`Reloading stops ${props.reloadBannerActiveCount} active conversation${props.reloadBannerActiveCount === 1 ? "" : "s"}.`}
                            </span>
                          </div>
                        </Show>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={props.dismissReloadBanner}
                      class="rounded-full p-1 text-gray-9 transition hover:bg-gray-3 hover:text-gray-12"
                      aria-label="Dismiss reload prompt"
                    >
                      <X size={16} />
                    </button>
                  </div>

                  <div class="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                      variant={props.reloadBannerBlocked ? "danger" : "primary"}
                      class="rounded-full px-3 py-1.5 text-xs"
                      disabled={!props.canReloadWorkspace || props.reloadBusy}
                      onClick={() =>
                        void (props.reloadBannerBlocked
                          ? props.forceStopActiveConversations()
                          : props.reloadWorkspaceEngine())
                      }
                    >
                      {props.reloadBusy
                        ? "Reloading..."
                        : props.reloadBannerBlocked
                          ? "Reload & Stop Tasks"
                          : "Reload now"}
                    </Button>
                    <Button
                      variant="ghost"
                      class="rounded-full px-3 py-1.5 text-xs"
                      onClick={props.dismissReloadBanner}
                    >
                      Later
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </Show>

          <div class="flex-1 flex overflow-hidden">
            <div class="relative min-w-0 flex-1 overflow-hidden bg-dls-surface">
              <div
                class={`h-full overflow-y-auto px-4 sm:px-6 lg:px-10 ${showWorkspaceSetupEmptyState() ? "pt-20 pb-10" : "pt-10 pb-10"} scroll-smooth bg-dls-surface ${initialAnchorPending() ? "invisible" : "visible"}`}
                style={{ contain: "layout paint style" }}
                onScroll={(event) => {
                  const container = event.currentTarget as HTMLDivElement;
                  const bottomGap =
                    container.scrollHeight -
                    (container.scrollTop + container.clientHeight);
                  if (bottomGap <= 96) {
                    setIsViewingLatest(true);
                  } else if (container.scrollTop < lastKnownScrollTop - 1) {
                    setIsViewingLatest(false);
                  }
                  lastKnownScrollTop = container.scrollTop;
                  refreshTopClippedMessage();
                }}
                ref={(el) => {
                  chatContainerEl = el;
                  setIsChatContainerReady(Boolean(el));
                  lastKnownScrollTop = el?.scrollTop ?? 0;
                  queueMicrotask(refreshTopClippedMessage);
                }}
              >
                <div class="mx-auto w-full max-w-[800px]">
                  <Show when={showWorkspaceSetupEmptyState()}>
                    <div class="mx-auto max-w-xl rounded-[24px] border border-dls-border bg-dls-sidebar p-8 text-center shadow-[var(--dls-card-shadow)]">
                      <div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-dls-border bg-dls-surface text-gray-11">
                        <HardDrive size={24} />
                      </div>
                      <h3 class="text-2xl font-semibold text-gray-12">
                        Set up your first workspace
                      </h3>
                      <p class="mt-2 text-sm text-gray-10">
                        OpenWork needs a local or remote workspace before you can
                        start a session.
                      </p>
                      <div class="mt-6 grid gap-3 sm:grid-cols-2">
                        <button
                          type="button"
                          class="rounded-full border border-gray-7 bg-gray-12 px-5 py-3 text-sm font-semibold text-gray-1 transition-colors hover:bg-gray-11"
                          onClick={props.openCreateWorkspace}
                        >
                          Create local workspace
                        </button>
                        <button
                          type="button"
                          class="rounded-full border border-dls-border bg-dls-surface px-5 py-3 text-sm font-semibold text-gray-12 transition-colors hover:bg-gray-2"
                          onClick={props.openCreateRemoteWorkspace}
                        >
                          Connect remote workspace
                        </button>
                      </div>
                    </div>
                  </Show>
                  <Show
                    when={
                      props.messages.length === 0 &&
                      !showWorkspaceSetupEmptyState()
                    }
                  >
                    <div class="text-center py-16 px-6 space-y-6">
                      <div class="w-16 h-16 bg-dls-hover rounded-3xl mx-auto flex items-center justify-center border border-dls-border">
                        <Zap class="text-dls-secondary" />
                      </div>
                      <div class="space-y-2">
                        <h3 class="text-xl font-medium">
                          {emptyStateTitle()}
                        </h3>
                        <p class="text-dls-secondary text-sm max-w-sm mx-auto">
                          {emptyStateBody()}
                        </p>
                      </div>
                      <Show when={emptyStateStarters().length > 0}>
                        <div class="grid gap-3 max-w-lg mx-auto text-left">
                          <For each={emptyStateStarters()}>
                            {(starter) => (
                              <button
                                type="button"
                                class="rounded-2xl border border-dls-border bg-dls-hover p-4 transition-all hover:bg-dls-active hover:border-gray-7"
                                onClick={() => handleEmptyStateStarter(starter)}
                              >
                                <div class="text-sm font-semibold text-dls-text">
                                  {starter.title}
                                </div>
                                <Show when={starter.description}>
                                  <div class="mt-1 text-xs text-dls-secondary leading-relaxed">
                                    {starter.description}
                                  </div>
                                </Show>
                              </button>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  </Show>

                  <Show
                    when={
                      hiddenMessageCount() > 0 || hasServerEarlierMessages()
                    }
                  >
                    <div class="mb-4 flex justify-center">
                      <button
                        type="button"
                        class="rounded-full border border-dls-border bg-dls-hover/70 px-3 py-1 text-xs text-dls-secondary transition-colors hover:bg-dls-active hover:text-dls-text"
                        onClick={() => {
                          void revealEarlierMessages();
                        }}
                        disabled={props.loadingEarlierMessages}
                      >
                        {props.loadingEarlierMessages
                          ? "Loading earlier messages..."
                          : hiddenMessageCount() > 0
                            ? `Show ${nextRevealCount().toLocaleString()} earlier message${nextRevealCount() === 1 ? "" : "s"}`
                            : "Load earlier messages"}
                      </button>
                    </div>
                  </Show>

                  <MessageList
                    messages={batchedRenderedMessages()}
                    isStreaming={showRunIndicator()}
                    developerMode={props.developerMode}
                    showThinking={props.showThinking}
                    getSessionById={props.getSessionById}
                    getMessagesBySessionId={props.getMessagesBySessionId}
                    ensureSessionLoaded={props.ensureSessionLoaded}
                    sessionLoadingById={props.sessionLoadingById}
                    workspaceRoot={props.activeWorkspaceRoot}
                    expandedStepIds={props.expandedStepIds}
                    setExpandedStepIds={props.setExpandedStepIds}
                    openSessionById={(sessionId) =>
                      props.setView("session", sessionId)
                    }
                    searchMatchMessageIds={searchMatchMessageIds()}
                    activeSearchMessageId={activeSearchHit()?.messageId ?? null}
                    searchHighlightQuery={searchQueryDebounced().trim()}
                    scrollElement={() => chatContainerEl}
                    setScrollToMessageById={(handler) => {
                      scrollMessageIntoViewById = handler;
                    }}
                    footer={
                      showRunIndicator() ? (
                        <div class="flex justify-start pl-2">
                          <div class="w-full max-w-[68ch]">
                            <div
                              class={`ml-3 mt-3 flex items-center gap-2 text-xs py-1 ${runPhase() === "error" ? "text-red-11" : "text-gray-9"}`}
                              role="status"
                              aria-live="polite"
                            >
                              <span
                                class={`truncate ${
                                  runPhase() === "thinking" ||
                                  runPhase() === "responding"
                                    ? "animate-pulse"
                                    : ""
                                }`}
                              >
                                {thinkingStatus() || runLabel()}
                              </span>
                              <Show when={props.developerMode}>
                                <span class="text-[10px] text-gray-8 ml-auto shrink-0">
                                  {runElapsedLabel()}
                                </span>
                              </Show>
                            </div>
                          </div>
                        </div>
                      ) : undefined
                    }
                  />

                  <div
                    ref={(el) => {
                      messagesEndEl = el;
                      bottomVisibilityEl = el;
                    }}
                  />
                </div>
              </div>

              <Show when={props.messages.length > 0 && !jumpControlsSuppressed() && (!isViewingLatest() || Boolean(topClippedMessageId()))}>
                <div class="absolute bottom-4 left-0 right-0 z-20 flex justify-center pointer-events-none">
                  <div class="pointer-events-auto flex items-center gap-2 rounded-full border border-dls-border bg-dls-surface/95 p-1 shadow-[var(--dls-card-shadow)] backdrop-blur-md">
                    <Show when={Boolean(topClippedMessageId())}>
                      <button
                        type="button"
                        class="rounded-full px-3 py-1.5 text-xs text-gray-11 transition-colors hover:bg-gray-2"
                        onClick={() => {
                          suppressJumpControlsTemporarily();
                          jumpToStartOfMessage("smooth");
                        }}
                      >
                        Jump to start of message
                      </button>
                    </Show>
                    <Show when={!isViewingLatest()}>
                      <button
                        type="button"
                        class="rounded-full px-3 py-1.5 text-xs text-gray-11 transition-colors hover:bg-gray-2"
                        onClick={() => {
                          suppressJumpControlsTemporarily();
                          jumpToLatest("smooth");
                        }}
                      >
                        Jump to latest
                      </button>
                    </Show>
                  </div>
                </div>
              </Show>
            </div>
          </div>

          <Show when={todoCount() > 0}>
            <div class="mx-auto w-full max-w-[800px] px-4">
              <div class="rounded-t-[20px] border border-b-0 border-dls-border bg-dls-surface shadow-[var(--dls-card-shadow)]">
                <button
                  type="button"
                  class="flex w-full items-center justify-between rounded-t-[20px] px-4 py-3 text-xs text-gray-9 transition-colors hover:bg-gray-2/50"
                  onClick={() => setTodoExpanded((prev) => !prev)}
                >
                  <div class="flex items-center gap-2">
                    <ListTodo size={14} class="text-gray-8" />
                    <span class="text-gray-11 font-medium">{todoLabel()}</span>
                  </div>
                  <Minimize2
                    size={12}
                    class={`text-gray-8 transition-transform ${todoExpanded() ? "" : "rotate-180"}`}
                  />
                </button>
                <Show when={todoExpanded()}>
                  <div class="max-h-60 overflow-auto border-t border-dls-border px-4 pb-3 space-y-2.5">
                    <For each={todoList()}>
                      {(todo, index) => {
                        const done = () => todo.status === "completed";
                        const cancelled = () => todo.status === "cancelled";
                        const active = () => todo.status === "in_progress";
                        return (
                          <div class="flex items-start gap-2.5 pt-2.5 first:pt-2.5">
                            <div class="flex items-center gap-1.5 pt-0.5">
                              <div
                                class={`h-4.5 w-4.5 rounded-full border flex items-center justify-center ${
                                  done()
                                    ? "border-green-6 bg-green-2 text-green-11"
                                    : active()
                                      ? "border-amber-6 bg-amber-2 text-amber-11"
                                      : cancelled()
                                        ? "border-gray-6 bg-gray-2 text-gray-8"
                                        : "border-gray-6 bg-gray-1 text-gray-8"
                                }`}
                              >
                                <Show when={done()}>
                                  <Check size={10} />
                                </Show>
                                <Show when={!done() && active()}>
                                  <span class="h-1.5 w-1.5 rounded-full bg-amber-9" />
                                </Show>
                              </div>
                            </div>
                            <div
                              class={`flex-1 text-sm leading-relaxed ${
                                cancelled()
                                  ? "text-gray-9 line-through"
                                  : "text-gray-12"
                              }`}
                            >
                              <span class="text-gray-9 mr-1.5">
                                {index() + 1}.
                              </span>
                              {todo.content}
                            </div>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </Show>
              </div>
            </div>
          </Show>

          <Show when={!showWorkspaceSetupEmptyState()}>
            <Composer
              prompt={props.prompt}
              developerMode={props.developerMode}
              busy={props.busy}
              isStreaming={showRunIndicator()}
              compactTopSpacing={todoCount() > 0}
              onSend={handleSendPrompt}
              onStop={cancelRun}
              onDraftChange={handleDraftChange}
              selectedModelLabel={props.selectedSessionModelLabel || "Model"}
              onModelClick={() => props.openSessionModelPicker()}
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
              toast={toastMessage()}
              onToast={(message) => setToastMessage(message)}
              listAgents={props.listAgents}
              recentFiles={props.workingFiles}
              searchFiles={props.searchFiles}
              listCommands={props.listCommands}
              isRemoteWorkspace={
                props.activeWorkspaceDisplay.workspaceType === "remote"
              }
              isSandboxWorkspace={isSandboxWorkspace()}
              onUploadInboxFiles={uploadInboxFiles}
              attachmentsEnabled={attachmentsEnabled()}
              attachmentsDisabledReason={attachmentsDisabledReason()}
            />
          </Show>

          <StatusBar
            clientConnected={props.clientConnected}
            openworkServerStatus={props.openworkServerStatus}
            developerMode={props.developerMode}
            settingsOpen={false}
            onSendFeedback={openFeedback}
            showSettingsButton={false}
            onOpenSettings={props.toggleSettings}
            onOpenMessaging={openConfig}
            onOpenProviders={openProviderAuth}
            onOpenMcp={openMcp}
            providerConnectedIds={props.providerConnectedIds}
            mcpStatuses={props.mcpStatuses}
            statusLabel={
              showRunIndicator()
                ? "Session Active"
                : props.selectedSessionId
                  ? "Session Ready"
                  : "Ready"
            }
            statusDotClass={
              showRunIndicator()
                ? "bg-green-9"
                : props.selectedSessionId
                  ? "bg-green-9"
                  : "bg-gray-8"
            }
            statusPingClass={
              showRunIndicator()
                ? "bg-green-9/45 animate-ping"
                : "bg-green-9/35"
            }
            statusPulse={showRunIndicator()}
          />
        </main>

        <aside
          class="hidden shrink-0 md:flex"
          style={{
            width: `${rightSidebarWidth()}px`,
            "min-width": `${rightSidebarWidth()}px`,
          }}
        >
          <WorkspaceRightSidebar
            expanded={rightSidebarExpanded()}
            showSelection={showRightSidebarSelection()}
            tab={props.tab}
            developerMode={props.developerMode}
            activeWorkspaceLabel={props.activeWorkspaceDisplay.displayName || props.activeWorkspaceDisplay.name || "Workspace"}
            activeWorkspaceType={props.activeWorkspaceDisplay.workspaceType}
            openworkServerClient={props.openworkServerClient}
            openworkServerWorkspaceId={props.openworkServerWorkspaceId}
            inboxId="sidebar-inbox"
            onToggleExpanded={toggleRightSidebar}
            onOpenAutomations={() => {
              props.setTab("scheduled");
              props.setView("dashboard");
            }}
            onOpenSkills={() => {
              props.setTab("skills");
              props.setView("dashboard");
            }}
            onOpenExtensions={() => {
              props.setTab("mcp");
              props.setView("dashboard");
            }}
            onOpenAdvanced={openConfig}
            onOpenSettings={() => openSettings("general")}
            onInboxToast={(message) => setToastMessage(message)}
          />
        </aside>

        <MobileSidebarDrawer
          open={mobileRightSidebarOpen()}
          onClose={() => setMobileRightSidebarOpen(false)}
        >
          <WorkspaceRightSidebar
            expanded
            mobile
            showSelection={showRightSidebarSelection()}
            tab={props.tab}
            developerMode={props.developerMode}
            activeWorkspaceLabel={props.activeWorkspaceDisplay.displayName || props.activeWorkspaceDisplay.name || "Workspace"}
            activeWorkspaceType={props.activeWorkspaceDisplay.workspaceType}
            openworkServerClient={props.openworkServerClient}
            openworkServerWorkspaceId={props.openworkServerWorkspaceId}
            inboxId="mobile-sidebar-inbox"
            onToggleExpanded={toggleRightSidebar}
            onCloseMobile={() => setMobileRightSidebarOpen(false)}
            onOpenAutomations={() => {
              props.setTab("scheduled");
              props.setView("dashboard");
            }}
            onOpenSkills={() => {
              props.setTab("skills");
              props.setView("dashboard");
            }}
            onOpenExtensions={() => {
              props.setTab("mcp");
              props.setView("dashboard");
            }}
            onOpenAdvanced={openConfig}
            onOpenSettings={() => openSettings("general")}
            onInboxToast={(message) => setToastMessage(message)}
          />
        </MobileSidebarDrawer>
      </div>

      <Show when={commandPaletteOpen()}>
        <div
          class="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto"
          onClick={closeCommandPalette}
        >
          <div
            class="w-full max-w-2xl mt-12 rounded-2xl border border-dls-border bg-dls-surface shadow-2xl overflow-hidden"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="border-b border-dls-border px-4 py-3 space-y-2">
              <div class="flex items-center gap-2">
                <Show when={commandPaletteMode() !== "root"}>
                  <button
                    type="button"
                    class="h-8 px-2 rounded-md text-xs text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors"
                    onClick={returnToCommandRoot}
                  >
                    Back
                  </button>
                </Show>
                <Search size={14} class="text-dls-secondary shrink-0" />
                <input
                  ref={(el) => (commandPaletteInputEl = el)}
                  type="text"
                  value={commandPaletteQuery()}
                  onInput={(event) =>
                    setCommandPaletteQuery(event.currentTarget.value)
                  }
                  placeholder={commandPalettePlaceholder()}
                  class="min-w-0 flex-1 bg-transparent text-sm text-dls-text placeholder:text-dls-secondary focus:outline-none"
                  aria-label={commandPaletteTitle()}
                />
                <button
                  type="button"
                  class="h-8 w-8 flex items-center justify-center rounded-md text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors"
                  onClick={closeCommandPalette}
                  aria-label="Close quick actions"
                >
                  <X size={14} />
                </button>
              </div>
              <div class="text-[11px] text-dls-secondary">
                {commandPaletteTitle()}
              </div>
            </div>

            <div class="max-h-[56vh] overflow-y-auto p-2">
              <Show
                when={commandPaletteItems().length > 0}
                fallback={
                  <div class="px-3 py-6 text-sm text-dls-secondary text-center">
                    No matches.
                  </div>
                }
              >
                <For each={commandPaletteItems()}>
                  {(item, index) => {
                    const idx = () => index();
                    return (
                      <button
                        ref={(el) => {
                          commandPaletteOptionRefs[idx()] = el;
                        }}
                        type="button"
                        class={`w-full text-left rounded-xl px-3 py-2.5 transition-colors ${
                          idx() === commandPaletteActiveIndex()
                            ? "bg-dls-active text-dls-text"
                            : "text-dls-text hover:bg-dls-hover"
                        }`}
                        onMouseEnter={() => setCommandPaletteActiveIndex(idx())}
                        onClick={item.action}
                      >
                        <div class="flex items-start justify-between gap-3">
                          <div class="min-w-0">
                            <div class="text-sm font-medium truncate">
                              {item.title}
                            </div>
                            <Show when={item.detail}>
                              <div class="text-xs text-dls-secondary mt-1 truncate">
                                {item.detail}
                              </div>
                            </Show>
                          </div>
                          <Show when={item.meta}>
                            <span class="text-[10px] uppercase tracking-wide text-dls-secondary shrink-0">
                              {item.meta}
                            </span>
                          </Show>
                        </div>
                      </button>
                    );
                  }}
                </For>
              </Show>
            </div>

            <div class="border-t border-dls-border px-3 py-2 text-[11px] text-dls-secondary flex items-center justify-between gap-2">
              <span>Arrow keys to navigate</span>
              <span>Enter to run · Esc to close</span>
            </div>
          </div>
        </div>
      </Show>

      <ProviderAuthModal
        open={props.providerAuthModalOpen}
        loading={props.providerAuthBusy}
        submitting={providerAuthActionBusy()}
        error={props.providerAuthError}
        preferredProviderId={props.providerAuthPreferredProviderId}
        workerType={props.providerAuthWorkerType}
        providers={props.providers}
        connectedProviderIds={props.providerConnectedIds}
        authMethods={props.providerAuthMethods}
        onSelect={handleProviderAuthSelect}
        onSubmitApiKey={handleProviderAuthApiKey}
        onSubmitOAuth={handleProviderAuthOAuth}
        onRefreshProviders={props.refreshProviders}
        onClose={() => props.closeProviderAuthModal()}
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

      <ConfirmModal
        open={deleteSessionOpen()}
        title="Delete session?"
        message={
          sessionTitleForId(deleteSessionId()).trim()
            ? `This will permanently delete \"${sessionTitleForId(deleteSessionId()).trim()}\" and its messages.`
            : "This will permanently delete the selected session and its messages."
        }
        confirmLabel={deleteSessionBusy() ? "Deleting..." : "Delete"}
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={confirmDeleteSession}
        onCancel={closeDeleteSessionModal}
      />

      <ShareWorkspaceModal
        open={Boolean(shareWorkspaceId())}
        onClose={() => setShareWorkspaceId(null)}
        workspaceName={shareWorkspaceName()}
        workspaceDetail={shareWorkspaceDetail()}
        fields={shareFields()}
        note={shareNote()}
        publisherBaseUrl={DEFAULT_OPENWORK_PUBLISHER_BASE_URL}
        onShareWorkspaceProfile={publishWorkspaceProfileLink}
        shareWorkspaceProfileBusy={shareWorkspaceProfileBusy()}
        shareWorkspaceProfileUrl={shareWorkspaceProfileUrl()}
        shareWorkspaceProfileError={shareWorkspaceProfileError()}
        shareWorkspaceProfileDisabledReason={shareServiceDisabledReason()}
        onShareSkillsSet={publishSkillsSetLink}
        onOpenSingleSkillShare={() => {
          setShareWorkspaceId(null);
          props.setTab("skills");
          props.setView("dashboard");
        }}
        shareSkillsSetBusy={shareSkillsSetBusy()}
        shareSkillsSetUrl={shareSkillsSetUrl()}
        shareSkillsSetError={shareSkillsSetError()}
        shareSkillsSetDisabledReason={shareServiceDisabledReason()}
        onExportConfig={
          exportDisabledReason()
            ? undefined
            : () => {
                const id = shareWorkspaceId();
                if (!id) return;
                props.exportWorkspaceConfig(id);
              }
        }
        exportDisabledReason={exportDisabledReason()}
        onOpenBots={openConfig}
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
                  <h3 class="text-lg font-semibold text-gray-12">
                    Permission Required
                  </h3>
                  <p class="text-sm text-gray-11 mt-1">
                    OpenCode is requesting permission to continue.
                  </p>
                </div>
              </div>

              <div class="bg-gray-1/50 rounded-xl p-4 border border-gray-6 mb-6">
                <div class="text-xs text-gray-10 uppercase tracking-wider mb-2 font-semibold">
                  Permission
                </div>
                <div class="text-sm text-gray-12 font-mono">
                  {props.activePermission?.permission}
                </div>

                <div class="text-xs text-gray-10 uppercase tracking-wider mt-4 mb-2 font-semibold">
                  Scope
                </div>
                <div class="flex items-center gap-2 text-sm font-mono text-amber-12 bg-amber-1/30 px-2 py-1 rounded border border-amber-7/20">
                  <HardDrive size={12} />
                  {props.activePermission?.patterns.join(", ")}
                </div>

                <Show
                  when={
                    Object.keys(props.activePermission?.metadata ?? {}).length >
                    0
                  }
                >
                  <details class="mt-4 rounded-lg bg-gray-1/20 p-2">
                    <summary class="cursor-pointer text-xs text-gray-11">
                      Details
                    </summary>
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
                    props.activePermission &&
                    props.respondPermission(props.activePermission.id, "reject")
                  }
                  disabled={props.permissionReplyBusy}
                >
                  Deny
                </Button>
                <div class="grid grid-cols-2 gap-2">
                  <Button
                    variant="secondary"
                    class="text-xs"
                    onClick={() =>
                      props.activePermission &&
                      props.respondPermission(props.activePermission.id, "once")
                    }
                    disabled={props.permissionReplyBusy}
                  >
                    Once
                  </Button>
                  <Button
                    variant="primary"
                    class="text-xs font-bold bg-amber-7 hover:bg-amber-8 text-gray-12 border-none shadow-amber-6/20"
                    onClick={() =>
                      props.activePermission &&
                      props.respondPermissionAndRemember(
                        props.activePermission.id,
                        "always",
                      )
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

      <QuestionModal
        open={Boolean(props.activeQuestion)}
        questions={props.activeQuestion?.questions ?? []}
        busy={props.questionReplyBusy}
        onClose={() => {}}
        onReply={(answers) => {
          if (props.activeQuestion) {
            props.respondQuestion(props.activeQuestion.id, answers);
          }
        }}
      />

      <For each={flyouts()}>{(item) => <FlyoutItem item={item} />}</For>
    </div>
  );
}
