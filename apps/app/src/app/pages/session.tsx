import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import type { Agent, Part, Session } from "@opencode-ai/sdk/v2/client";
import type {
  ComposerDraft,
  MessageWithParts,
  PendingPermission,
  PendingQuestion,
  PromptMode,
  ProviderListItem,
  SessionCompactionState,
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
  type EngineInfo,
  type OpenCodeRouterInfo,
  type OpenworkServerInfo,
  type OrchestratorStatus,
  type WorkspaceInfo,
} from "../lib/tauri";
import { usePlatform } from "../context/platform";
import { useSessionActions } from "../session/actions-provider";
import { useModelControls } from "../app-settings/model-controls-provider";
import { buildFeedbackUrl } from "../lib/feedback";
import { getOpenWorkDeployment } from "../lib/openwork-deployment";
import { createWorkspaceShellLayout } from "../lib/workspace-shell-layout";

import {
  ArrowDownToLine,
  Check,
  FolderOpen,
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
import { ProviderAuthModal,
  type ProviderAuthMethod,
  type ProviderOAuthStartResult,
} from "../context/providers";
import StatusBar from "../components/status-bar";
import { ShareWorkspaceModal } from "../workspace";
import type {
  OpenworkServerClient,
  OpenworkServerDiagnostics,
  OpenworkServerSettings,
  OpenworkServerStatus,
} from "../lib/openwork-server";
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
import { useSessionDisplayPreferences } from "../app-settings/session-display-preferences";

import MessageList from "../components/session/message-list";
import Composer from "../components/session/composer";
import type { ComposerNotice } from "../components/session/composer-notice";
import { createSessionScrollController } from "../components/session/scroll-controller";
import WorkspaceSessionList from "../components/session/workspace-session-list";
import type { SidebarSectionState } from "../components/session/sidebar";
import FlyoutItem from "../components/flyout-item";
import QuestionModal from "../components/question-modal";
import {
  useStatusToasts,
  type AppStatusToastTone,
} from "../shell/status-toasts";
import { createShareWorkspaceState } from "../session/share-workspace";
import {
  getSessionDraft,
  saveSessionDraft,
  sessionDraftScopeKey,
} from "../session/draft-store";

export type SessionViewProps = {
  selectedSessionId: string | null;
  setView: (view: View, sessionId?: string) => void;
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
  toggleSettings: () => void;
  selectedWorkspaceDisplay: WorkspaceDisplay;
  selectedWorkspaceRoot: string;
  activeWorkspaceConfig: WorkspaceOpenworkConfig | null;
  workspaces: WorkspaceInfo[];
  selectedWorkspaceId: string;
  connectingWorkspaceId: string | null;
  workspaceConnectionStateById: Record<string, WorkspaceConnectionState>;
  selectWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  switchWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  testWorkspaceConnection: (workspaceId: string) => Promise<boolean> | boolean;
  recoverWorkspace: (workspaceId: string) => Promise<boolean> | boolean;
  editWorkspaceConnection: (workspaceId: string) => void;
  forgetWorkspace: (workspaceId: string) => void;
  openCreateWorkspace: () => void;
  pickFolderWorkspace: () => Promise<boolean>;
  openCreateRemoteWorkspace: () => void;
  importWorkspaceConfig: () => void;
  importingWorkspaceConfig: boolean;
  exportWorkspaceConfig: (workspaceId?: string) => void;
  exportWorkspaceBusy: boolean;
  clientConnected: boolean;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerClient: OpenworkServerClient | null;
  openworkServerDiagnostics: OpenworkServerDiagnostics | null;
  openworkServerSettings: OpenworkServerSettings;
  openworkServerHostInfo: OpenworkServerInfo | null;
  shareRemoteAccessBusy: boolean;
  shareRemoteAccessError: string | null;
  saveShareRemoteAccess: (enabled: boolean) => Promise<void>;
  runtimeWorkspaceId: string | null;
  engineInfo: EngineInfo | null;
  engineDoctorVersion: string | null;
  orchestratorStatus: OrchestratorStatus | null;
  opencodeRouterInfo: OpenCodeRouterInfo | null;
  appVersion: string | null;
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
  sessionCompactionState: SessionCompactionState | null;
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
  skills: SkillCard[];
  skillsStatus: string | null;
  busy: boolean;
  prompt: string;
  setPrompt: (value: string) => void;
  activePermission: PendingPermission | null;
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
  sessionStatusById: Record<string, string>;
  hasEarlierMessages: boolean;
  loadingEarlierMessages: boolean;
  loadEarlierMessages: (sessionId: string) => Promise<void>;
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
const STREAM_RENDER_BATCH_MS = 48;
const MAIN_THREAD_LAG_INTERVAL_MS = 200;
const MAIN_THREAD_LAG_WARN_MS = 180;

type CommandPaletteMode = "root" | "sessions";

function describePermissionRequest(permission: PendingPermission | null) {
  if (!permission) {
    return {
      title: "Permission Required",
      message: "OpenCode is requesting permission to continue.",
      permissionLabel: "",
      scopeLabel: "Scope",
      scopeValue: "",
      isDoomLoop: false,
      note: null as string | null,
    };
  }

  const patterns = permission.patterns.filter((pattern) => pattern.trim().length > 0);
  if (permission.permission === "doom_loop") {
    const tool =
      permission.metadata && typeof permission.metadata === "object" && typeof permission.metadata.tool === "string"
        ? permission.metadata.tool
        : null;
    return {
      title: "Doom Loop Detected",
      message: "OpenCode detected repeated tool calls with identical input and is asking whether it should continue after repeated failures.",
      permissionLabel: "Doom Loop",
      scopeLabel: tool ? "Tool" : "Repeated call",
      scopeValue: tool ?? (patterns.length ? patterns.join(", ") : "Repeated tool call"),
      isDoomLoop: true,
      note: "Reject to stop the loop, or allow if you want the agent to keep trying.",
    };
  }

  return {
    title: "Permission Required",
    message: "OpenCode is requesting permission to continue.",
    permissionLabel: permission.permission,
    scopeLabel: "Scope",
    scopeValue: patterns.join(", "),
    isDoomLoop: false,
    note: null as string | null,
  };
}

export default function SessionView(props: SessionViewProps) {
  const FLUSH_PROMPT_EVENT = "openwork:flushPromptDraft";
  const { showThinking } = useSessionDisplayPreferences();
  const platform = usePlatform();
  const sessionActions = useSessionActions();
  const modelControls = useModelControls();
  const statusToasts = useStatusToasts();
  let chatContainerEl: HTMLDivElement | undefined;
  let chatContentEl: HTMLDivElement | undefined;
  let scrollMessageIntoViewById:
    | ((messageId: string, behavior?: ScrollBehavior) => boolean)
    | null = null;
  let agentPickerRef: HTMLDivElement | undefined;
  let searchInputEl: HTMLInputElement | undefined;
  let streamRenderBatchTimer: number | undefined;
  let streamRenderBatchQueuedAt = 0;
  let streamRenderBatchReschedules = 0;

  const [composerNotice, setComposerNotice] = createSignal<ComposerNotice | null>(
    null,
  );
  const activePermissionPresentation = createMemo(() =>
    describePermissionRequest(props.activePermission),
  );
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
  const [jumpControlsSuppressed, setJumpControlsSuppressed] = createSignal(false);
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchQueryDebounced, setSearchQueryDebounced] = createSignal("");
  const [composerDraftMode, setComposerDraftMode] = createSignal<PromptMode>("prompt");
  const [composerDraftScopeKey, setComposerDraftScopeKey] = createSignal("");
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

  const showStatusToast = (
    title: string,
    tone: AppStatusToastTone = "info",
    description?: string | null,
  ) => {
    statusToasts.showToast({ title, tone, description });
  };

  const showComposerNotice = (notice: ComposerNotice) => {
    setComposerNotice(notice);
  };

  const flushComposerDraft = () => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(FLUSH_PROMPT_EVENT));
  };

  const persistDraftForSession = (
    workspaceId: string,
    sessionId: string | null | undefined,
    draft: Pick<ComposerDraft, "mode" | "text">,
  ) => {
    saveSessionDraft(workspaceId, sessionId, {
      text: draft.text,
      mode: draft.mode,
    });
  };

  let commandPaletteInputEl: HTMLInputElement | undefined;
  const commandPaletteOptionRefs: HTMLButtonElement[] = [];
  const {
    leftSidebarWidth,
    startLeftSidebarResize,
  } = createWorkspaceShellLayout({ expandedRightWidth: 280 });

  const openFeedback = () => {
    const resolved = buildFeedbackUrl({
      entrypoint: "session-status-bar",
      deployment: getOpenWorkDeployment(),
      appVersion: props.appVersion,
      openworkServerVersion: props.openworkServerDiagnostics?.version ?? null,
      opencodeVersion:
        props.orchestratorStatus?.binaries?.opencode?.actualVersion ??
        props.engineDoctorVersion ??
        null,
      orchestratorVersion: props.orchestratorStatus?.cliVersion ?? null,
      opencodeRouterVersion: props.opencodeRouterInfo?.version ?? null,
    });
    if (!resolved) return;
    platform.openLink(resolved);
  };

  const agentLabel = createMemo(() => {
    const name = sessionActions.selectedSessionAgent() ?? "Default agent";
    return name.charAt(0).toUpperCase() + name.slice(1);
  });
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
      const aActive = a.workspaceId === props.selectedWorkspaceId;
      const bActive = b.workspaceId === props.selectedWorkspaceId;
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
    const revert = sessionActions.sessionRevertMessageId();
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
    return Boolean(sessionActions.sessionRevertMessageId());
  });

  const canCompactSession = createMemo(
    () => Boolean(props.selectedSessionId) && hasUserMessages(),
  );

  const resolveLocalFileCandidates = async (file: string) => {
    const trimmed = normalizeLocalFilePath(file).trim();
    if (!trimmed) return [];
    if (isAbsolutePath(trimmed)) return [trimmed];

    const root = props.selectedWorkspaceRoot.trim();
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

  const revealWorkspaceInFinder = async (workspaceId: string) => {
    const workspace =
      props.workspaces.find((entry) => entry.id === workspaceId) ?? null;
    if (!workspace || workspace.workspaceType !== "local") return;
    const target = workspace.path?.trim() ?? "";
    if (!target) {
      showStatusToast("Workspace path is unavailable.", "warning");
      return;
    }
    if (!isTauriRuntime()) {
      showStatusToast("Reveal is available in the desktop app.", "warning");
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
      showStatusToast(message, "error");
    }
  };
  const todoLabel = createMemo(() => {
    const total = todoCount();
    if (!total) return "";
    return `${todoCompletedCount()} out of ${total} tasks completed`;
  });
  const shareWorkspaceState = createShareWorkspaceState({
    workspaces: () => props.workspaces,
    openworkServerHostInfo: () => props.openworkServerHostInfo,
    openworkServerSettings: () => props.openworkServerSettings,
    engineInfo: () => props.engineInfo,
    exportWorkspaceBusy: () => props.exportWorkspaceBusy,
    openLink: (url) => platform.openLink(url),
    workspaceLabel,
  });
  let jumpControlsSuppressTimer: ReturnType<typeof setTimeout> | undefined;
  const attachmentsEnabled = createMemo(() => {
    if (props.selectedWorkspaceDisplay.workspaceType !== "remote") return true;
    return props.openworkServerStatus === "connected";
  });
  const attachmentsDisabledReason = createMemo(() => {
    if (attachmentsEnabled()) return null;
    if (props.openworkServerStatus === "limited") {
      return "Add a server token to attach files.";
    }
    return "Connect to OpenWork server to attach files.";
  });

  onCleanup(() => {
    if (jumpControlsSuppressTimer !== undefined) {
      clearTimeout(jumpControlsSuppressTimer);
      jumpControlsSuppressTimer = undefined;
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

        if (sessionScroll.isAtBottom() && targetStart > currentStart) {
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

    if (props.selectedWorkspaceDisplay.workspaceType === "remote") {
      showStatusToast("File open is unavailable for remote workspaces.", "warning");
      return;
    }

    if (!isTauriRuntime()) {
      showStatusToast("File open is available in the desktop app.", "warning");
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
        showStatusToast("Pick a workspace to open files.", "warning");
        return;
      }
      if (!result.ok) {
        showStatusToast(result.reason, "error");
        return;
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to open file";
      showStatusToast(message, "error");
    }
  };

  const loadAgentOptions = async (force = false) => {
    if (agentPickerBusy()) return agentOptions();
    if (agentPickerReady() && !force) return agentOptions();
    setAgentPickerBusy(true);
    setAgentPickerError(null);
    try {
      const agents = await sessionActions.listAgents();
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
  const showCompactionIndicator = createMemo(
    () => props.sessionCompactionState?.running === true,
  );
  const bootStatusCopy = createMemo(() => {
    if (props.clientConnected) return null;
    const detail = props.busyHint?.trim() ?? "";
    if (!detail) return null;

    const label =
      props.busyLabel === "status.connecting"
        ? "Connecting to OpenCode"
        : props.busyLabel === "status.starting_engine"
          ? "Starting OpenWork"
          : "Preparing OpenWork";

    return {
      label,
      detail,
      dotClass: "bg-blue-9",
      pingClass: "bg-blue-9/35 animate-ping",
      pulse: true,
    };
  });
  const compactionStatusDetail = createMemo(() => {
    if (!showCompactionIndicator()) return "";
    return props.sessionCompactionState?.mode === "auto"
      ? "OpenCode is auto-compacting this session"
      : "OpenCode is compacting this session";
  });
  const statusBarCopy = createMemo(() => {
    if (showCompactionIndicator()) {
      return {
        label: "Compacting Context",
        detail: compactionStatusDetail(),
        dotClass: "bg-blue-9",
        pingClass: "bg-blue-9/35 animate-ping",
        pulse: true,
      };
    }

    if (showRunIndicator()) {
      return {
        label: "Session Active",
        detail: undefined,
        dotClass: "bg-green-9",
        pingClass: "bg-green-9/45 animate-ping",
        pulse: true,
      };
    }

    const bootCopy = bootStatusCopy();
    if (bootCopy) return bootCopy;

    if (props.selectedSessionId) {
      return {
        label: "Session Ready",
        detail: undefined,
        dotClass: "bg-green-9",
        pingClass: "bg-green-9/35",
        pulse: false,
      };
    }

    return {
      label: "Ready",
      detail: undefined,
      dotClass: "bg-gray-8",
      pingClass: "bg-green-9/35",
      pulse: false,
    };
  });

  createEffect(
    on(
      () => props.sessionCompactionState?.startedAt ?? null,
      (startedAt, previous) => {
        if (!startedAt || startedAt === previous) return;
        if (props.sessionCompactionState?.mode === "manual") return;
        showStatusToast("OpenCode started compacting the session context.", "info");
      },
    ),
  );

  createEffect(
    on(
      () => props.sessionCompactionState?.finishedAt ?? null,
      (finishedAt, previous) => {
        if (!finishedAt || finishedAt === previous) return;
        if (props.sessionCompactionState?.mode === "manual") return;
        showStatusToast("OpenCode finished compacting the session context.", "success");
      },
    ),
  );

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
      return "Thinking";
    }
    if (part.type === "text") {
      return null;
    }
    return null;
  };

  const thinkingStatus = createMemo(() => {
    const status = computeStatusFromPart(latestRunPart());
    if (status) return status;
    if (runPhase() === "thinking") return "Thinking";
    return null;
  });

  const showFooterRunStatus = createMemo(() => {
    if (!showRunIndicator()) return false;
    const part = latestRunPart();
    if (part?.type === "reasoning" && showThinking()) {
      return false;
    }
    return true;
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

  createEffect(
    on(
      () => [props.selectedWorkspaceId, props.selectedSessionId] as const,
      ([workspaceId, sessionId], previous) => {
        const previousWorkspaceId = previous?.[0] ?? null;
        const previousSessionId = previous?.[1] ?? null;
        if (workspaceId === previousWorkspaceId && sessionId === previousSessionId) {
          return;
        }

        const restoredDraft = getSessionDraft(workspaceId, sessionId) ?? {
          text: "",
          mode: "prompt" as const,
        };

        batch(() => {
          setComposerDraftMode(restoredDraft.mode);
          props.setPrompt(restoredDraft.text);
          setComposerDraftScopeKey(sessionDraftScopeKey(workspaceId, sessionId));
          setSearchOpen(false);
          setSearchQuery("");
          setSearchQueryDebounced("");
          setActiveSearchHitIndex(0);
        });
      },
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
      showStatusToast("No session selected", "warning");
      return;
    }

    setAbortBusy(true);
    showStatusToast("Stopping the run...", "info");
    try {
      await sessionActions.abortSession(props.selectedSessionId);
      showStatusToast("Stopped.", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to stop";
      showStatusToast(message, "error");
    } finally {
      setAbortBusy(false);
    }
  };

  const retryRun = async () => {
    const text = sessionActions.lastPromptSent().trim();
    if (!text) {
      showStatusToast("Nothing to retry yet", "warning");
      return;
    }

    if (abortBusy()) return;
    setAbortBusy(true);
    showStatusToast("Trying again...", "info");
    try {
      if (showRunIndicator() && props.selectedSessionId) {
        await sessionActions.abortSession(props.selectedSessionId);
      }
    } catch {
      // If abort fails, still allow the retry. Users care more about forward motion.
    } finally {
      setAbortBusy(false);
    }

    sessionActions.retryLastPrompt();
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
      showStatusToast("Nothing to undo yet.", "warning");
      return;
    }

    setHistoryActionBusy("undo");
    try {
      await sessionActions.undoLastUserMessage();
      showStatusToast("Reverted the last user message.", "success");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : props.safeStringify(error);
      showStatusToast(message || "Failed to undo", "error");
    } finally {
      setHistoryActionBusy(null);
    }
  };

  const redoLastMessage = async () => {
    if (historyActionBusy()) return;
    if (!canRedoLastMessage()) {
      showStatusToast("Nothing to redo.", "warning");
      return;
    }

    setHistoryActionBusy("redo");
    try {
      await sessionActions.redoLastUserMessage();
      showStatusToast("Restored the reverted message.", "success");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : props.safeStringify(error);
      showStatusToast(message || "Failed to redo", "error");
    } finally {
      setHistoryActionBusy(null);
    }
  };

  const compactSessionHistory = async () => {
    if (historyActionBusy()) return;
    if (!canCompactSession()) {
      showStatusToast("Nothing to compact yet.", "warning");
      return;
    }

    const sessionID = props.selectedSessionId;
    const startedAt = perfNow();
    setHistoryActionBusy("compact");
    showStatusToast("Compacting session context...", "info");
    try {
      await sessionActions.compactCurrentSession();
      showStatusToast("Session compacted.", "success");
      finishPerf(props.developerMode, "session.compact", "ui-done", startedAt, {
        sessionID,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : props.safeStringify(error);
      showStatusToast(message || "Failed to compact session", "error");
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
    if (!composerNotice()) return;
    const id = window.setTimeout(() => setComposerNotice(null), 2400);
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
  const [pendingSessionTransition, setPendingSessionTransition] = createSignal<{
    workspaceId: string;
    sessionId: string;
  } | null>(null);
  const hasWorkspaceConfigured = createMemo(() => props.workspaces.length > 0);
  const showWorkspaceSetupEmptyState = createMemo(
    () =>
      !hasWorkspaceConfigured() &&
      !props.selectedSessionId &&
      props.messages.length === 0,
  );
  const showPendingSessionTransition = createMemo(() => {
    const pending = pendingSessionTransition();
    if (!pending) return false;
    return pending.sessionId !== props.selectedSessionId;
  });
  const showSessionLoadingState = createMemo(() => {
    if (showPendingSessionTransition()) return true;
    const sessionId = props.selectedSessionId;
    if (!sessionId) return false;
    if (props.messages.length > 0) return false;
    return props.sessionLoadingById(sessionId);
  });
  const [showDelayedSessionLoadingState, setShowDelayedSessionLoadingState] = createSignal(false);
  const pendingSessionTransitionTitle = createMemo(() => {
    const pending = pendingSessionTransition();
    if (!pending) return "";
    return sessionTitleForId(pending.sessionId);
  });
  const sessionHeaderTitle = createMemo(() => {
    if (showWorkspaceSetupEmptyState()) return "Create or connect a workspace";
    if (showPendingSessionTransition()) {
      return pendingSessionTransitionTitle() || "Loading session";
    }
    return selectedSessionTitle() || DEFAULT_SESSION_TITLE;
  });

  createEffect(() => {
    const pending = pendingSessionTransition();
    if (!pending) return;
    if (props.selectedSessionId === pending.sessionId) {
      setPendingSessionTransition(null);
    }
  });

  createEffect(() => {
    if (!showSessionLoadingState()) {
      setShowDelayedSessionLoadingState(false);
      return;
    }

    const id = window.setTimeout(() => {
      setShowDelayedSessionLoadingState(true);
    }, 1000);
    onCleanup(() => window.clearTimeout(id));
  });

  const sessionScroll = createSessionScrollController({
    selectedSessionId: () => props.selectedSessionId,
    renderedMessages: () => batchedRenderedMessages(),
    containerRef: () => chatContainerEl,
    contentRef: () => chatContentEl,
  });

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
      showStatusToast("No session selected", "warning");
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
      await sessionActions.renameSessionTitle(sessionId, next);
      finishRenameModal();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : props.safeStringify(error);
      showStatusToast(message, "error");
    } finally {
      setRenameBusy(false);
    }
  };

  const openDeleteSessionModal = () => {
    const sessionId = props.selectedSessionId;
    if (!sessionId) {
      showStatusToast("No session selected", "warning");
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
      await sessionActions.deleteSessionById(sessionId);
      setDeleteSessionOpen(false);
      setDeleteSessionId(null);
      showStatusToast("Session deleted", "success");
      // Route away from the deleted session id.
      props.setView("session");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : props.safeStringify(error);
      showStatusToast(message || "Failed to delete session", "error");
    } finally {
      setDeleteSessionBusy(false);
    }
  };

  const requireSessionId = () => {
    const sessionId = props.selectedSessionId;
    if (!sessionId) {
      showStatusToast("No session selected", "warning");
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
      sessionId = (await sessionActions.createSessionAndOpen()) ?? null;
      if (!sessionId) return;
    }
    sessionActions.setSessionAgent(sessionId, agent);
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
        showStatusToast(result.message || "Provider connected", "success");
        props.closeProviderAuthModal();
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "OAuth failed";
      showStatusToast(message, "error");
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
      showStatusToast(message || "API key saved", "success");
      props.closeProviderAuthModal();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to save API key";
      showStatusToast(message, "error");
    } finally {
      setProviderAuthActionBusy(false);
    }
  };

  const handleSendPrompt = (draft: ComposerDraft) => {
    suppressJumpControlsTemporarily();
    sessionScroll.scrollToBottom();
    startRun();
    sessionActions.sendPrompt(draft).catch(() => undefined);
  };

  const isSandboxWorkspace = createMemo(() =>
    Boolean(
      (props.selectedWorkspaceDisplay as any)?.sandboxContainerName?.trim(),
    ),
  );

  const uploadInboxFiles = async (
    files: File[],
    options?: { notify?: boolean },
  ): Promise<Array<{ name: string; path: string }>> => {
    const notify = options?.notify ?? true;
    const client = props.openworkServerClient;
    const workspaceId = props.runtimeWorkspaceId?.trim() ?? "";
    if (!client || !workspaceId) {
      if (notify) {
        showComposerNotice({
          title: "Connect to the OpenWork server to upload files to the shared folder.",
          tone: "warning",
        });
      }
      return [];
    }
    if (!files.length) return [];

    const label =
      files.length === 1 ? (files[0]?.name ?? "file") : `${files.length} files`;
    if (notify) {
      showComposerNotice({
        title: `Uploading ${label} to the shared folder...`,
        tone: "info",
      });
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
        showComposerNotice({
          title: summary
            ? `Uploaded to the shared folder: ${summary}`
            : "Uploaded to the shared folder.",
          tone: "success",
        });
      }
      return uploaded;
    } catch (error) {
      if (notify) {
        const message =
          error instanceof Error
            ? error.message
            : "Shared folder upload failed";
        showComposerNotice({ title: message, tone: "error" });
      }
      return [];
    }
  };

  const handleDraftChange = (draft: ComposerDraft) => {
    props.setPrompt(draft.text);
    persistDraftForSession(props.selectedWorkspaceId, props.selectedSessionId, draft);
  };

  const openSessionFromList = (
    workspaceId: string,
    sessionId: string,
    options?: { focusComposer?: boolean },
  ) => {
    if (!sessionId) return;
    flushComposerDraft();
    setPendingSessionTransition({ workspaceId, sessionId });
    const shouldFocusComposer = options?.focusComposer === true;
    void (async () => {
      const ready = await Promise.resolve(props.switchWorkspace(workspaceId));
      if (!ready) {
        setPendingSessionTransition((current) =>
          current?.workspaceId === workspaceId && current?.sessionId === sessionId
            ? null
            : current,
        );
        return;
      }
      props.setView("session", sessionId);
      if (shouldFocusComposer) {
        focusComposer();
      }
    })();
  };

  const createTaskInWorkspace = (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    flushComposerDraft();
    void (async () => {
      await Promise.resolve(sessionActions.createSessionInWorkspace(id));
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
          void Promise.resolve(sessionActions.createSessionAndOpen())
            .then((sessionId) => {
              if (!sessionId) return;
              focusComposer();
            })
            .catch((error) => {
              const message =
                error instanceof Error
                  ? error.message
                  : "Failed to create session";
              showStatusToast(message, "error");
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
        id: "compact-session",
        title: "Compact Conversation",
        detail: canCompactSession()
          ? "Send a compact instruction to OpenCode for this session"
          : "No user messages to compact yet",
        meta: "Compact",
        action: () => {
          closeCommandPalette();
          void compactSessionHistory();
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
        detail: `${modelControls.selectedSessionModelLabel() || "Model"} · ${modelControls.sessionModelVariantLabel()}`,
        meta: "Open",
        action: () => {
          closeCommandPalette();
          modelControls.openSessionModelPicker({ returnFocusTarget: "composer" });
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
              showStatusToast(message, "error");
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
        item.workspaceId === props.selectedWorkspaceId
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
    props.setView("settings");
  };

  const openConfig = () => {
    props.setSettingsTab(props.developerMode ? "advanced" : "messaging");
    props.setView("settings");
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
    return "text-dls-secondary hover:text-dls-secondary hover:bg-lime-3/15";
  });

  const updatePillBorderTone = createMemo(() => {
    const state = props.updateStatus?.state;
    if (state === "ready") {
      return props.anyActiveRuns ? "border-amber-7/35" : "border-green-7/35";
    }
    if (state === "downloading") {
      return "border-blue-7/35";
    }
    return "border-lime-8/60";
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
    return "text-lime-11 fill-lime-11";
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
    openSettings("general");
  };

  const openMcp = () => {
    props.setSettingsTab("extensions");
    props.setView("settings");
  };

  const openProviderAuth = (preferredProviderId?: string) => {
    void props.openProviderAuthModal({ preferredProviderId }).catch((error) => {
      const message = error instanceof Error ? error.message : "Connect failed";
      showStatusToast(message, "error");
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
      props.selectedWorkspaceDisplay.preset ||
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
                class={`group relative mb-3 flex w-full items-center gap-1.5 rounded-xl border px-3.5 py-2 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.2)] ${updatePillBorderTone()} ${updatePillButtonTone()}`}
                onClick={handleUpdatePillClick}
                title={updatePillTitle()}
                aria-label={updatePillTitle()}
              >
                <Show
                  when={props.updateStatus?.state === "downloading"}
                  fallback={
                    <ArrowDownToLine
                      size={12}
                      class={`${updatePillDotTone()} shrink-0 ${props.updateStatus?.state === "available" ? "animate-pulse" : ""}`}
                      style={props.updateStatus?.state === "available" ? { "animation-duration": "3.5s" } : undefined}
                    />
                  }
                >
                  <Loader2
                    size={13}
                    class={`animate-spin shrink-0 ${updatePillDotTone()}`}
                  />
                </Show>
                <span class="min-w-0 flex-1 truncate whitespace-nowrap text-left">{updatePillLabel()}</span>
                <Show when={props.updateStatus?.version}>
                  {(version) => (
                    <span
                      class={`ml-auto shrink-0 font-mono text-[10px] ${updatePillVersionTone()}`}
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
              selectedWorkspaceId={props.selectedWorkspaceId}
              developerMode={props.developerMode}
              selectedSessionId={props.selectedSessionId}
              showSessionActions
              sessionStatusById={props.sessionStatusById}
              connectingWorkspaceId={props.connectingWorkspaceId}
              workspaceConnectionStateById={props.workspaceConnectionStateById}
              newTaskDisabled={props.newTaskDisabled}
              onSelectWorkspace={props.selectWorkspace}
              onOpenSession={openSessionFromList}
              onCreateTaskInWorkspace={createTaskInWorkspace}
              onOpenRenameSession={openRenameModal}
              onOpenDeleteSession={openDeleteSessionModal}
              onOpenRenameWorkspace={props.openRenameWorkspace}
              onShareWorkspace={shareWorkspaceState.openShareWorkspace}
              onRevealWorkspace={revealWorkspaceInFinder}
              onRecoverWorkspace={props.recoverWorkspace}
              onTestWorkspaceConnection={props.testWorkspaceConnection}
              onEditWorkspaceConnection={props.editWorkspaceConnection}
              onForgetWorkspace={props.forgetWorkspace}
              onOpenCreateWorkspace={props.openCreateWorkspace}
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
                      <ArrowDownToLine
                        size={12}
                        class={`${updatePillDotTone()} shrink-0 ${props.updateStatus?.state === "available" ? "animate-pulse" : ""}`}
                        style={props.updateStatus?.state === "available" ? { "animation-duration": "3.5s" } : undefined}
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
                {sessionHeaderTitle()}
              </h1>
              <span class="hidden truncate text-[13px] text-dls-secondary lg:inline">
                {props.selectedWorkspaceDisplay.displayName || props.selectedWorkspaceDisplay.name || "Workspace"}
              </span>
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

          <div class="flex-1 flex overflow-hidden">
            <div class="relative min-w-0 flex-1 overflow-hidden bg-dls-surface">
              <div
                class={`h-full overflow-y-auto px-4 sm:px-6 lg:px-10 ${showWorkspaceSetupEmptyState() ? "pt-20 pb-10" : "pt-10 pb-10"} scroll-smooth bg-dls-surface`}
                style={{ contain: "layout paint style" }}
                onScroll={sessionScroll.handleScroll}
                ref={(el) => {
                  chatContainerEl = el;
                }}
              >
                <div
                  class="mx-auto w-full max-w-[800px]"
                  ref={(el) => {
                    chatContentEl = el;
                  }}
                >
                  <Show when={showDelayedSessionLoadingState()}>
                    <div class="px-6 py-24">
                      <div
                        class="mx-auto flex max-w-sm flex-col items-center gap-4 rounded-3xl border border-dls-border bg-dls-hover/60 px-8 py-10 text-center"
                        role="status"
                        aria-live="polite"
                      >
                        <div class="flex h-14 w-14 items-center justify-center rounded-2xl border border-dls-border bg-dls-surface">
                          <Loader2 size={20} class="animate-spin text-dls-secondary" />
                        </div>
                        <div class="space-y-1">
                          <h3 class="text-base font-medium text-dls-text">Loading session</h3>
                          <p class="text-sm text-dls-secondary">
                            Pulling in the latest messages for this task.
                          </p>
                        </div>
                      </div>
                    </div>
                  </Show>


                  <Show
                    when={
                      props.messages.length === 0 &&
                      !showWorkspaceSetupEmptyState() &&
                      !showSessionLoadingState()
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

                  <Show when={!showDelayedSessionLoadingState()}>
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

                    <div>
                      <MessageList
                        messages={batchedRenderedMessages()}
                        isStreaming={showRunIndicator()}
                        developerMode={props.developerMode}
                        showThinking={showThinking()}
                        getSessionById={props.getSessionById}
                        getMessagesBySessionId={props.getMessagesBySessionId}
                        ensureSessionLoaded={props.ensureSessionLoaded}
                        sessionLoadingById={props.sessionLoadingById}
                        workspaceRoot={props.selectedWorkspaceRoot}
                        expandedStepIds={props.expandedStepIds}
                        setExpandedStepIds={props.setExpandedStepIds}
                        openSessionById={(sessionId) => {
                          flushComposerDraft();
                          props.setView("session", sessionId);
                        }}
                        searchMatchMessageIds={searchMatchMessageIds()}
                        activeSearchMessageId={activeSearchHit()?.messageId ?? null}
                        searchHighlightQuery={searchQueryDebounced().trim()}
                        scrollElement={() => chatContainerEl}
                        setScrollToMessageById={(handler) => {
                          scrollMessageIntoViewById = handler;
                        }}
                        footer={
                          showRunIndicator() && showFooterRunStatus() ? (
                            <div class="flex justify-start">
                              <div class="w-full max-w-[760px]">
                                <div
                                  class={`mt-3 flex items-center gap-2 py-1 text-xs ${runPhase() === "error" ? "text-red-11" : "text-gray-9"}`}
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
                    </div>
                  </Show>
                </div>
              </div>

              <Show when={!showDelayedSessionLoadingState() && props.messages.length > 0 && !jumpControlsSuppressed() && (!sessionScroll.isAtBottom() || Boolean(sessionScroll.topClippedMessageId()))}>
                <div class="absolute bottom-4 left-0 right-0 z-20 flex justify-center pointer-events-none">
                  <div class="pointer-events-auto flex items-center gap-2 rounded-full border border-dls-border bg-dls-surface/95 p-1 shadow-[var(--dls-card-shadow)] backdrop-blur-md">
                    <Show when={Boolean(sessionScroll.topClippedMessageId())}>
                      <button
                        type="button"
                        class="rounded-full px-3 py-1.5 text-xs text-gray-11 transition-colors hover:bg-gray-2"
                        onClick={() => {
                          suppressJumpControlsTemporarily();
                          sessionScroll.jumpToStartOfMessage("smooth");
                        }}
                      >
                        Jump to start of message
                      </button>
                    </Show>
                    <Show when={!sessionScroll.isAtBottom()}>
                      <button
                        type="button"
                        class="rounded-full px-3 py-1.5 text-xs text-gray-11 transition-colors hover:bg-gray-2"
                        onClick={() => {
                          suppressJumpControlsTemporarily();
                          sessionScroll.jumpToLatest("smooth");
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
              draftMode={composerDraftMode()}
              draftScopeKey={composerDraftScopeKey()}
              developerMode={props.developerMode}
              busy={props.busy}
              isStreaming={showRunIndicator()}
              compactTopSpacing={todoCount() > 0}
              onSend={handleSendPrompt}
              onStop={cancelRun}
              onDraftChange={handleDraftChange}
              selectedModelLabel={modelControls.selectedSessionModelLabel() || "Model"}
              onModelClick={() => modelControls.openSessionModelPicker()}
              modelVariantLabel={modelControls.sessionModelVariantLabel()}
              modelVariant={modelControls.sessionModelVariant()}
              modelBehaviorOptions={modelControls.sessionModelBehaviorOptions()}
              onModelVariantChange={modelControls.setSessionModelVariant}
              agentLabel={agentLabel()}
              selectedAgent={sessionActions.selectedSessionAgent()}
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
              notice={composerNotice()}
              onNotice={showComposerNotice}
              listAgents={sessionActions.listAgents}
              recentFiles={props.workingFiles}
              searchFiles={sessionActions.searchWorkspaceFiles}
              listCommands={sessionActions.listCommands}
              isRemoteWorkspace={
                props.selectedWorkspaceDisplay.workspaceType === "remote"
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
            showSettingsButton={true}
            onOpenSettings={props.toggleSettings}
            onOpenMessaging={() => {
              props.setSettingsTab("messaging");
              props.setView("settings");
            }}
            onOpenProviders={openProviderAuth}
            onOpenMcp={openMcp}
            providerConnectedIds={props.providerConnectedIds}
            statusLabel={statusBarCopy().label}
            statusDetail={statusBarCopy().detail}
            statusDotClass={statusBarCopy().dotClass}
            statusPingClass={statusBarCopy().pingClass}
            statusPulse={statusBarCopy().pulse}
          />
        </main>
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
        open={shareWorkspaceState.shareWorkspaceOpen()}
        onClose={shareWorkspaceState.closeShareWorkspace}
        workspaceName={shareWorkspaceState.shareWorkspaceName()}
        workspaceDetail={shareWorkspaceState.shareWorkspaceDetail()}
        fields={shareWorkspaceState.shareFields()}
        remoteAccess={shareWorkspaceState.shareWorkspace()?.workspaceType === "local"
          ? {
              enabled: props.openworkServerHostInfo?.remoteAccessEnabled === true,
              busy: props.shareRemoteAccessBusy,
              error: props.shareRemoteAccessError,
              onSave: props.saveShareRemoteAccess,
            }
          : undefined}
        note={shareWorkspaceState.shareNote()}
        onShareWorkspaceProfile={shareWorkspaceState.publishWorkspaceProfileLink}
        shareWorkspaceProfileBusy={shareWorkspaceState.shareWorkspaceProfileBusy()}
        shareWorkspaceProfileUrl={shareWorkspaceState.shareWorkspaceProfileUrl()}
        shareWorkspaceProfileError={shareWorkspaceState.shareWorkspaceProfileError()}
        shareWorkspaceProfileDisabledReason={shareWorkspaceState.shareServiceDisabledReason()}
        shareWorkspaceProfileSensitiveWarnings={shareWorkspaceState.shareWorkspaceProfileSensitiveWarnings()}
        shareWorkspaceProfileSensitiveMode={shareWorkspaceState.shareWorkspaceProfileSensitiveMode()}
        onShareWorkspaceProfileSensitiveModeChange={shareWorkspaceState.setShareWorkspaceProfileSensitiveMode}
        onShareWorkspaceProfileToTeam={shareWorkspaceState.shareWorkspaceProfileToTeam}
        shareWorkspaceProfileToTeamBusy={shareWorkspaceState.shareWorkspaceProfileTeamBusy()}
        shareWorkspaceProfileToTeamError={shareWorkspaceState.shareWorkspaceProfileTeamError()}
        shareWorkspaceProfileToTeamSuccess={shareWorkspaceState.shareWorkspaceProfileTeamSuccess()}
        shareWorkspaceProfileToTeamDisabledReason={shareWorkspaceState.shareWorkspaceProfileTeamDisabledReason()}
        shareWorkspaceProfileToTeamOrgName={shareWorkspaceState.shareWorkspaceProfileTeamOrgName()}
        shareWorkspaceProfileToTeamNeedsSignIn={shareWorkspaceState.shareWorkspaceProfileToTeamNeedsSignIn()}
        onShareWorkspaceProfileToTeamSignIn={shareWorkspaceState.startShareWorkspaceProfileToTeamSignIn}
        templateContentSummary={{
          skillNames: props.skills.map((s) => s.name),
          commandNames: [],
          configFiles: ["opencode.json", "openwork.json"],
        }}
        onShareSkillsSet={shareWorkspaceState.publishSkillsSetLink}
        shareSkillsSetBusy={shareWorkspaceState.shareSkillsSetBusy()}
        shareSkillsSetUrl={shareWorkspaceState.shareSkillsSetUrl()}
        shareSkillsSetError={shareWorkspaceState.shareSkillsSetError()}
        shareSkillsSetDisabledReason={shareWorkspaceState.shareServiceDisabledReason()}
        onExportConfig={
          shareWorkspaceState.exportDisabledReason()
            ? undefined
            : () => {
                const id = shareWorkspaceState.shareWorkspaceId();
                if (!id) return;
                props.exportWorkspaceConfig(id);
              }
        }
        exportDisabledReason={shareWorkspaceState.exportDisabledReason()}
        onOpenBots={openConfig}
      />

      <Show when={props.activePermission}>
        <div class="absolute inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="bg-gray-2 border border-amber-7/30 w-full max-w-md rounded-2xl shadow-2xl overflow-hidden">
            <div class="p-6">
              <div class="flex items-start gap-4 mb-4">
                <div class="p-3 bg-amber-7/10 rounded-full text-amber-6">
                  <Show when={activePermissionPresentation().isDoomLoop} fallback={<Shield size={24} />}>
                    <RefreshCcw size={24} />
                  </Show>
                </div>
                <div>
                  <h3 class="text-lg font-semibold text-gray-12">
                    {activePermissionPresentation().title}
                  </h3>
                  <p class="text-sm text-gray-11 mt-1">
                    {activePermissionPresentation().message}
                  </p>
                </div>
              </div>

              <div class="bg-gray-1/50 rounded-xl p-4 border border-gray-6 mb-6">
                <div class="text-xs text-gray-10 uppercase tracking-wider mb-2 font-semibold">
                  Permission
                </div>
                <div class="text-sm text-gray-12 font-mono">
                  {activePermissionPresentation().permissionLabel}
                </div>

                <Show when={activePermissionPresentation().note}>
                  <p class="mt-2 text-sm text-gray-11">
                    {activePermissionPresentation().note}
                  </p>
                </Show>

                <div class="text-xs text-gray-10 uppercase tracking-wider mt-4 mb-2 font-semibold">
                  {activePermissionPresentation().scopeLabel}
                </div>
                <div class="flex items-center gap-2 text-sm font-mono text-amber-12 bg-amber-1/30 px-2 py-1 rounded border border-amber-7/20">
                  <HardDrive size={12} />
                  {activePermissionPresentation().scopeValue}
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
