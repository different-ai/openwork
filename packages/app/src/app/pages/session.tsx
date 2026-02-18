import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { Agent, Part } from "@opencode-ai/sdk/v2/client";
import type {
  ArtifactItem,
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
  WorkspaceSessionGroup,
} from "../types";

import type { EngineInfo, OpenworkServerInfo, WorkspaceInfo } from "../lib/tauri";

import {
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  HeartPulse,
  HardDrive,
  History,
  ListTodo,
  Loader2,
  MessageCircle,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Plus,
  Redo2,
  Search,
  Settings,
  Shield,
  SlidersHorizontal,
  Undo2,
  X,
  Zap,
} from "lucide-solid";

import Button from "../components/button";
import ConfirmModal from "../components/confirm-modal";
import RenameSessionModal from "../components/rename-session-modal";
import ProviderAuthModal from "../components/provider-auth-modal";
import ShareWorkspaceModal from "../components/share-workspace-modal";
import StatusBar from "../components/status-bar";
import { buildOpenworkWorkspaceBaseUrl, createOpenworkServerClient } from "../lib/openwork-server";
import type {
  OpenworkServerClient,
  OpenworkServerSettings,
  OpenworkServerStatus,
  OpenworkSoulStatus,
} from "../lib/openwork-server";
import { join } from "@tauri-apps/api/path";
import {
  formatRelativeTime,
  getWorkspaceTaskLoadErrorDisplay,
  isTauriRuntime,
  normalizeDirectoryPath,
  parseTemplateFrontmatter,
} from "../utils";

import browserSetupTemplate from "../data/commands/browser-setup.md?raw";
import soulSetupTemplate from "../data/commands/give-me-a-soul.md?raw";

import MessageList from "../components/session/message-list";
import Composer from "../components/session/composer";
import type { SidebarSectionState } from "../components/session/sidebar";
import FlyoutItem from "../components/flyout-item";
import QuestionModal from "../components/question-modal";
import ArtifactsPanel from "../components/session/artifacts-panel";
import InboxPanel from "../components/session/inbox-panel";
import ArtifactMarkdownEditor from "../components/session/artifact-markdown-editor";

export type SessionViewProps = {
  selectedSessionId: string | null;
  setView: (view: View, sessionId?: string) => void;
  tab: DashboardTab;
  setTab: (tab: DashboardTab) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  activeWorkspaceDisplay: WorkspaceDisplay;
  activeWorkspaceRoot: string;
  workspaces: WorkspaceInfo[];
  activeWorkspaceId: string;
  connectingWorkspaceId: string | null;
  workspaceConnectionStateById: Record<string, WorkspaceConnectionState>;
  activateWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  testWorkspaceConnection: (workspaceId: string) => Promise<boolean> | boolean;
  editWorkspaceConnection: (workspaceId: string) => void;
  forgetWorkspace: (workspaceId: string) => void;
  soulStatusByWorkspaceId: Record<string, OpenworkSoulStatus | null>;
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
  lastPromptSent: string;
  retryLastPrompt: () => void;
  newTaskDisabled: boolean;
  workspaceSessionGroups: WorkspaceSessionGroup[];
  openRenameWorkspace: (workspaceId: string) => void;
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
  activeQuestion: PendingQuestion | null;
  questionReplyBusy: boolean;
  respondQuestion: (requestID: string, answers: string[][]) => void;
  safeStringify: (value: unknown) => string;
  error: string | null;
  sessionStatus: string;
  renameSession: (sessionId: string, title: string) => Promise<void>;
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
  listCommands: () => Promise<{ id: string; name: string; description?: string; source?: "command" | "mcp" | "skill" }[]>;
  selectedSessionAgent: string | null;
  setSessionAgent: (sessionId: string, agent: string | null) => void;
  saveSession: (sessionId: string) => Promise<string>;
  sessionStatusById: Record<string, string>;
  deleteSession: (sessionId: string) => Promise<void>;
};

const BROWSER_SETUP_TEMPLATE = (() => {
  const parsed = parseTemplateFrontmatter(browserSetupTemplate);
  const name = parsed?.data?.name?.trim() || "browser-setup";
  const description = parsed?.data?.description?.trim() || "Guide the user through browser automation setup";
  const body = (parsed?.body ?? browserSetupTemplate).trim();
  return { name, description, body };
})();

const SOUL_SETUP_TEMPLATE = (() => {
  const parsed = parseTemplateFrontmatter(soulSetupTemplate);
  const name = parsed?.data?.name?.trim() || "give-me-a-soul";
  const description =
    parsed?.data?.description?.trim() ||
    "Enable optional soul mode with persistent memory and scheduled check-ins";
  const body = (parsed?.body ?? soulSetupTemplate).trim();
  return { name, description, body };
})();

const INITIAL_MESSAGE_WINDOW = 140;
const MESSAGE_WINDOW_LOAD_CHUNK = 120;

export default function SessionView(props: SessionViewProps) {
  let messagesEndEl: HTMLDivElement | undefined;
  let chatContainerEl: HTMLDivElement | undefined;
  let agentPickerRef: HTMLDivElement | undefined;
  let sessionMenuRef: HTMLDivElement | undefined;
  let searchInputEl: HTMLInputElement | undefined;

  const [toastMessage, setToastMessage] = createSignal<string | null>(null);
  const [providerAuthActionBusy, setProviderAuthActionBusy] = createSignal(false);
  const [renameModalOpen, setRenameModalOpen] = createSignal(false);
  const [renameTitle, setRenameTitle] = createSignal("");
  const [renameBusy, setRenameBusy] = createSignal(false);

  const [sessionMenuOpen, setSessionMenuOpen] = createSignal(false);
  const [deleteSessionOpen, setDeleteSessionOpen] = createSignal(false);
  const [deleteSessionBusy, setDeleteSessionBusy] = createSignal(false);
  const [agentPickerOpen, setAgentPickerOpen] = createSignal(false);
  const [agentPickerBusy, setAgentPickerBusy] = createSignal(false);
  const [agentPickerReady, setAgentPickerReady] = createSignal(false);
  const [agentPickerError, setAgentPickerError] = createSignal<string | null>(null);
  const [agentOptions, setAgentOptions] = createSignal<Agent[]>([]);
  const [autoScrollEnabled, setAutoScrollEnabled] = createSignal(false);
  const [scrollOnNextUpdate, setScrollOnNextUpdate] = createSignal(false);
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [activeSearchHitIndex, setActiveSearchHitIndex] = createSignal(0);
  const [historyActionBusy, setHistoryActionBusy] = createSignal<"undo" | "redo" | null>(null);
  const [messageWindowStart, setMessageWindowStart] = createSignal(0);
  const [messageWindowSessionId, setMessageWindowSessionId] = createSignal<string | null>(null);
  const [messageWindowExpanded, setMessageWindowExpanded] = createSignal(false);

  const [markdownEditorOpen, setMarkdownEditorOpen] = createSignal(false);
  const [markdownEditorPath, setMarkdownEditorPath] = createSignal<string | null>(null);

  // When a session is selected (i.e. we are in SessionView), the right sidebar is
  // navigation-only. Avoid showing any tab as "selected" to reduce confusion.
  const showRightSidebarSelection = createMemo(() => !props.selectedSessionId);

  const agentLabel = createMemo(() => props.selectedSessionAgent ?? "Default agent");
  const workspaceLabel = (workspace: WorkspaceInfo) =>
    workspace.displayName?.trim() ||
    workspace.openworkWorkspaceName?.trim() ||
    workspace.name?.trim() ||
    workspace.path?.trim() ||
    "Worker";
  const workspaceKindLabel = (workspace: WorkspaceInfo) =>
    workspace.workspaceType === "remote"
      ? workspace.sandboxBackend === "docker" ||
        Boolean(workspace.sandboxRunId?.trim()) ||
        Boolean(workspace.sandboxContainerName?.trim())
        ? "Sandbox"
        : "Remote"
      : "Local";
  const todoList = createMemo(() => props.todos.filter((todo) => todo.content.trim()));
  const todoCount = createMemo(() => todoList().length);
  const todoCompletedCount = createMemo(() =>
    todoList().filter((todo) => todo.status === "completed").length
  );

  type SearchHit = {
    messageId: string;
  };

  const messageIdFromInfo = (message: MessageWithParts) => {
    const id = (message.info as { id?: string | number }).id;
    if (typeof id === "string") return id;
    if (typeof id === "number") return String(id);
    return "";
  };

  const messageTextForSearch = (message: MessageWithParts) => {
    const chunks: string[] = [];
    for (const part of message.parts) {
      if (part.type === "text") {
        const text = (part as { text?: string }).text ?? "";
        if (text) chunks.push(text);
        continue;
      }
      if (part.type === "agent") {
        const name = (part as { name?: string }).name ?? "";
        if (name) chunks.push(`@${name}`);
        continue;
      }
      if (part.type === "file") {
        const file = part as { label?: string; path?: string; filename?: string };
        const label = file.label ?? file.path ?? file.filename ?? "";
        if (label) chunks.push(label);
        continue;
      }
      if (part.type === "tool") {
        const state = (part as { state?: { title?: string; output?: string; error?: string } }).state;
        if (state?.title) chunks.push(state.title);
        if (state?.output) chunks.push(state.output);
        if (state?.error) chunks.push(state.error);
      }
    }
    return chunks.join("\n");
  };

  const searchHits = createMemo<SearchHit[]>(() => {
    const query = searchQuery().trim().toLowerCase();
    if (!query) return [];

    const hits: SearchHit[] = [];
    for (const message of props.messages) {
      const messageId = messageIdFromInfo(message);
      if (!messageId) continue;
      const haystack = messageTextForSearch(message).toLowerCase();
      if (!haystack) continue;
      let index = haystack.indexOf(query);
      while (index !== -1) {
        hits.push({ messageId });
        index = haystack.indexOf(query, index + Math.max(1, query.length));
      }
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

  const searchActive = createMemo(() => searchOpen() && searchQuery().trim().length > 0);
  const renderedMessages = createMemo(() => {
    if (messageWindowExpanded() || searchActive()) return props.messages;

    const start = messageWindowStart();
    if (start <= 0) return props.messages;
    if (start >= props.messages.length) return [];
    return props.messages.slice(start);
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

  const revealEarlierMessages = () => {
    const hidden = hiddenMessageCount();
    if (hidden <= 0) return;
    const nextStart = Math.max(0, messageWindowStart() - MESSAGE_WINDOW_LOAD_CHUNK);
    setMessageWindowStart(nextStart);
    if (nextStart === 0) {
      setMessageWindowExpanded(true);
    }
  };

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

  const canRedoLastMessage = createMemo(() => {
    if (!props.selectedSessionId) return false;
    return Boolean(props.sessionRevertMessageId);
  });

  const touchedFiles = createMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (value: string) => {
      const normalized = String(value ?? "").trim().replace(/[\\/]+/g, "/");
      if (!normalized) return;
      const key = normalized.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(normalized);
    };

    const artifacts = props.artifacts;
    for (let idx = artifacts.length - 1; idx >= 0; idx -= 1) {
      const item = artifacts[idx];
      add(item?.path ?? item?.name ?? "");
      if (out.length >= 48) break;
    }

    if (out.length === 0) {
      const working = props.workingFiles;
      for (let idx = working.length - 1; idx >= 0; idx -= 1) {
        add(working[idx] ?? "");
        if (out.length >= 48) break;
      }
    }

    return out;
  });

  const normalizeSidebarPath = (value: string) => String(value ?? "").trim().replace(/[\\/]+/g, "/");

  const toWorkspaceRelativeForApi = (file: string) => {
    const normalized = normalizeSidebarPath(file).replace(/^file:\/\//i, "");
    if (!normalized) return "";

    const root = normalizeSidebarPath(props.activeWorkspaceRoot).replace(/\/+$/, "");
    const rootKey = root.toLowerCase();
    const fileKey = normalized.toLowerCase();

    if (root && fileKey.startsWith(`${rootKey}/`)) {
      return normalized.slice(root.length + 1);
    }
    if (root && fileKey === rootKey) {
      return "";
    }

    let relative = normalized.replace(/^\.\/+/, "");
    if (!relative) return "";

    // Tool output paths sometimes carry git-style prefixes (a/ or b/).
    if (/^[ab]\/.+\.(md|mdx|markdown)$/i.test(relative)) {
      relative = relative.slice(2);
    }

    // Some tool outputs include a leading "workspace/" prefix.
    if (/^workspace\//i.test(relative)) {
      relative = relative.replace(/^workspace\//i, "");
    }

    // Other surfaces include an absolute-style "/workspace/<path>" prefix.
    if (/^\/+workspace\//i.test(relative)) {
      relative = relative.replace(/^\/+workspace\//i, "");
    }
    if (relative.startsWith("/") || relative.startsWith("~") || /^[a-zA-Z]:\//.test(relative)) return "";
    if (relative.split("/").some((part) => part === "." || part === "..")) return "";
    return relative;
  };

  const openMarkdownEditor = (file: string) => {
    const relative = toWorkspaceRelativeForApi(file);
    if (!relative) {
      setToastMessage("Only worker-relative files can be opened here.");
      return;
    }
    if (!/\.(md|mdx|markdown)$/i.test(relative)) {
      setToastMessage("Only markdown files can be edited here right now.");
      return;
    }
    setMarkdownEditorPath(relative);
    setMarkdownEditorOpen(true);
  };

  const closeMarkdownEditor = () => {
    setMarkdownEditorOpen(false);
    setMarkdownEditorPath(null);
  };
  const todoLabel = createMemo(() => {
    const total = todoCount();
    if (!total) return "";
    return `${todoCompletedCount()} out of ${total} tasks completed`;
  });
  const MAX_SESSIONS_PREVIEW = 3;
  const COLLAPSED_SESSIONS_PREVIEW = 1;
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = createSignal<Set<string>>(
    new Set()
  );
  const isWorkspaceExpanded = (workspaceId: string) =>
    expandedWorkspaceIds().has(workspaceId);
  const expandWorkspace = (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    setExpandedWorkspaceIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };
  const toggleWorkspaceExpanded = (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    setExpandedWorkspaceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  onMount(() => {
    expandWorkspace(props.activeWorkspaceId);
  });

  createEffect(() => {
    expandWorkspace(props.activeWorkspaceId);
  });
  const [previewCountByWorkspaceId, setPreviewCountByWorkspaceId] = createSignal<
    Record<string, number>
  >({});
  const previewCount = (workspaceId: string) => {
    const base = previewCountByWorkspaceId()[workspaceId] ?? MAX_SESSIONS_PREVIEW;
    return isWorkspaceExpanded(workspaceId)
      ? base
      : Math.min(COLLAPSED_SESSIONS_PREVIEW, base);
  };
  const previewSessions = (workspaceId: string, sessions: WorkspaceSessionGroup["sessions"]) =>
    sessions.slice(0, previewCount(workspaceId));
  const showMoreSessions = (workspaceId: string, total: number) => {
    expandWorkspace(workspaceId);
    setPreviewCountByWorkspaceId((current) => {
      const next = { ...current };
      const existing = next[workspaceId] ?? MAX_SESSIONS_PREVIEW;
      next[workspaceId] = Math.min(existing + MAX_SESSIONS_PREVIEW, total);
      return next;
    });
  };
  const showMoreLabel = (workspaceId: string, total: number) => {
    const remaining = Math.max(0, total - previewCount(workspaceId));
    const nextCount = Math.min(MAX_SESSIONS_PREVIEW, remaining);
    return nextCount > 0 ? `Show ${nextCount} more` : "Show more";
  };
  const [workspaceMenuId, setWorkspaceMenuId] = createSignal<string | null>(null);
  let workspaceMenuRef: HTMLDivElement | undefined;
  const [shareWorkspaceId, setShareWorkspaceId] = createSignal<string | null>(null);
  const [addWorkspaceMenuOpen, setAddWorkspaceMenuOpen] = createSignal(false);
  let addWorkspaceMenuRef: HTMLDivElement | undefined;

  createEffect(() => {
    if (!workspaceMenuId()) return;
    const closeMenu = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (workspaceMenuRef && target && workspaceMenuRef.contains(target)) return;
      setWorkspaceMenuId(null);
    };
    window.addEventListener("click", closeMenu);
    onCleanup(() => window.removeEventListener("click", closeMenu));
  });
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

  createEffect(() => {
    if (!addWorkspaceMenuOpen()) return;
    const closeMenu = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (addWorkspaceMenuRef && target && addWorkspaceMenuRef.contains(target)) return;
      setAddWorkspaceMenuOpen(false);
    };
    window.addEventListener("click", closeMenu);
    onCleanup(() => window.removeEventListener("click", closeMenu));
  });

  createEffect(() => {
    if (!addWorkspaceMenuOpen()) return;
    const closeMenu = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (addWorkspaceMenuRef && target && addWorkspaceMenuRef.contains(target)) return;
      setAddWorkspaceMenuOpen(false);
    };
    window.addEventListener("click", closeMenu);
    onCleanup(() => window.removeEventListener("click", closeMenu));
  });

  const isNearBottom = (el: HTMLElement, threshold = 80) => {
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distance <= threshold;
  };

  const scrollToLatest = (behavior: ScrollBehavior = "auto") => {
    messagesEndEl?.scrollIntoView({ behavior, block: "end" });
  };

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

        const targetStart = count > INITIAL_MESSAGE_WINDOW ? count - INITIAL_MESSAGE_WINDOW : 0;
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

        if (autoScrollEnabled() && targetStart > currentStart) {
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
      setToastMessage("File open is unavailable for remote workers.");
      return;
    }

    if (!isTauriRuntime()) {
      setToastMessage("File open is available in the desktop app.");
      return;
    }

    try {
      const { openPath } = await import("@tauri-apps/plugin-opener");
      const root = props.activeWorkspaceRoot.trim();
      if (!isAbsolutePath(trimmed) && !root) {
        setToastMessage("Pick a worker to open files.");
        return;
      }
      const target = !isAbsolutePath(trimmed) && root ? await join(root, trimmed) : trimmed;
      await openPath(target);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to open file";
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
  const [runLastProgressAt, setRunLastProgressAt] = createSignal<number | null>(null);
  const [runBaseline, setRunBaseline] = createSignal<{ assistantId: string | null; partCount: number }>({
    assistantId: null,
    partCount: 0,
  });
  const [abortBusy, setAbortBusy] = createSignal(false);
  const [todoExpanded, setTodoExpanded] = createSignal(false);

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

  const cleanReasoning = (value: string) => value.replace(/\[REDACTED\]/g, "").trim();

  const latestRunReasoning = createMemo<string | null>(() => {
    if (!showRunIndicator()) return null;
    const baseline = runBaseline();
    for (let i = props.messages.length - 1; i >= 0; i -= 1) {
      const msg = props.messages[i];
      const info = msg?.info as { id?: string | number; role?: string } | undefined;
      if (info?.role !== "assistant") continue;
      const messageId =
        typeof info.id === "string" ? info.id : typeof info.id === "number" ? String(info.id) : null;
      if (!messageId) continue;

      const minIndex = baseline.assistantId && messageId === baseline.assistantId ? baseline.partCount - 1 : -1;
      for (let partIndex = msg.parts.length - 1; partIndex > minIndex; partIndex -= 1) {
        const part = msg.parts[partIndex];
        if (part?.type !== "reasoning") continue;
        const raw = typeof (part as { text?: unknown }).text === "string" ? String((part as { text?: string }).text) : "";
        const text = cleanReasoning(raw);
        if (text) return text;
      }

      if (baseline.assistantId && messageId === baseline.assistantId) {
        break;
      }
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
        case "apply_patch":
          return "Writing file";
        case "bash":
          return "Running shell";
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
    const reasoning = latestRunReasoning();
    if (reasoning) {
      const detail = truncateDetail(reasoning);
      return detail ? { title: "Reasoning", detail } : { title: "Reasoning" };
    }

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
      const text = cleanReasoning(typeof (part as any).text === "string" ? (part as any).text : "");
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

  createEffect(
    on(
      () => props.selectedSessionId,
      () => {
        setSearchOpen(false);
        setSearchQuery("");
        setActiveSearchHitIndex(0);
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
    const container = chatContainerEl;
    if (!container) return;
    const escapedId = active.messageId.replace(/"/g, '\\"');
    const target = container.querySelector(`[data-message-id="${escapedId}"]`) as HTMLElement | null;
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  createEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
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
    if (props.sessionStatus === "idle" && runHasBegun() && !props.error) {
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
          if (showRunIndicator()) {
            setRunLastProgressAt(Date.now());
          }
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

  const openSearch = () => {
    setSearchOpen(true);
    focusSearchInput();
  };

  const closeSearch = () => {
    setSearchOpen(false);
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
      const message = error instanceof Error ? error.message : props.safeStringify(error);
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
      const message = error instanceof Error ? error.message : props.safeStringify(error);
      setToastMessage(message || "Failed to redo");
    } finally {
      setHistoryActionBusy(null);
    }
  };


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
    const count = todoCount();
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
    if (!toastMessage()) return;
    const id = window.setTimeout(() => setToastMessage(null), 2400);
    return () => window.clearTimeout(id);
  });

  const selectedSessionTitle = createMemo(() => {
    const id = props.selectedSessionId;
    if (!id) return "";
    for (const group of props.workspaceSessionGroups) {
      const match = group.sessions.find((session) => session.id === id);
      if (match) return match.title ?? "";
    }
    return "";
  });

  const renameCanSave = createMemo(() => {
    if (renameBusy()) return false;
    const next = renameTitle().trim();
    if (!next) return false;
    return next !== selectedSessionTitle().trim();
  });

  const openRenameModal = () => {
    setSessionMenuOpen(false);
    if (!props.selectedSessionId) {
      setToastMessage("No session selected");
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
      setToastMessage(message);
    } finally {
      setRenameBusy(false);
    }
  };

  const openDeleteSessionModal = () => {
    setSessionMenuOpen(false);
    if (!props.selectedSessionId) {
      setToastMessage("No session selected");
      return;
    }
    setDeleteSessionOpen(true);
  };

  const closeDeleteSessionModal = () => {
    if (deleteSessionBusy()) return;
    setDeleteSessionOpen(false);
  };

  const confirmDeleteSession = async () => {
    if (deleteSessionBusy()) return;
    const sessionId = props.selectedSessionId;
    if (!sessionId) return;
    setDeleteSessionBusy(true);
    try {
      await props.deleteSession(sessionId);
      setDeleteSessionOpen(false);
      setToastMessage("Session deleted");
      // Route away from the deleted session id.
      props.setView("session");
    } catch (error) {
      const message = error instanceof Error ? error.message : props.safeStringify(error);
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

  createEffect(() => {
    if (!sessionMenuOpen()) return;
    const handler = (event: MouseEvent) => {
      if (!sessionMenuRef) return;
      if (sessionMenuRef.contains(event.target as Node)) return;
      setSessionMenuOpen(false);
    };
    window.addEventListener("mousedown", handler);
    onCleanup(() => window.removeEventListener("mousedown", handler));
  });

  const handleProviderAuthSelect = async (providerId: string) => {
    if (providerAuthActionBusy()) return;
    setProviderAuthActionBusy(true);
    try {
      const message = await props.startProviderAuth(providerId);
      setToastMessage(message || "Auth flow started");
      props.closeProviderAuthModal();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Auth failed";
      setToastMessage(message);
    } finally {
      setProviderAuthActionBusy(false);
    }
  };

  const handleProviderAuthApiKey = async (providerId: string, apiKey: string) => {
    if (providerAuthActionBusy()) return;
    setProviderAuthActionBusy(true);
    try {
      const message = await props.submitProviderApiKey(providerId, apiKey);
      setToastMessage(message || "API key saved");
      props.closeProviderAuthModal();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save API key";
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
        const mounted = buildOpenworkWorkspaceBaseUrl(hostUrl, ws.openworkWorkspaceId);
        return mounted || hostUrl;
      }
      return ws.baseUrl?.trim() || "";
    }
    return ws.path?.trim() || "";
  });

  const [shareLocalOpenworkWorkspaceId, setShareLocalOpenworkWorkspaceId] = createSignal<string | null>(null);

  createEffect(() => {
    const ws = shareWorkspace();
    const baseUrl = props.openworkServerHostInfo?.baseUrl?.trim() ?? "";
    const token = props.openworkServerHostInfo?.clientToken?.trim() ?? "";
    const workspacePath = ws?.workspaceType === "local" ? ws.path?.trim() ?? "" : "";

    if (!ws || ws.workspaceType !== "local" || !workspacePath || !baseUrl || !token) {
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
        const match = items.find((entry) => normalizeDirectoryPath(entry.path) === targetPath);
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
        ? buildOpenworkWorkspaceBaseUrl(hostUrl, shareLocalOpenworkWorkspaceId())
        : null;
      const url = mountedUrl || hostUrl;
      const token = props.openworkServerHostInfo?.clientToken?.trim() || "";
      return [
        {
          label: "OpenWork worker URL",
          value: url,
          placeholder: !isTauriRuntime() ? "Desktop app required" : "Starting server...",
          hint: mountedUrl
            ? "Use on phones or laptops connecting to this worker."
            : hostUrl
              ? "Worker URL is resolving; host URL shown as fallback."
              : undefined,
        },
        {
          label: "Access token",
          value: token,
          secret: true,
          placeholder: isTauriRuntime() ? "-" : "Desktop app required",
          hint: mountedUrl
            ? "Use on phones or laptops connecting to this worker."
            : "Use on phones or laptops connecting to this host.",
        },
      ];
    }

    if (ws.remoteType === "openwork") {
      const hostUrl = ws.openworkHostUrl?.trim() || ws.baseUrl?.trim() || "";
      const url = buildOpenworkWorkspaceBaseUrl(hostUrl, ws.openworkWorkspaceId) || hostUrl;
      const token =
        ws.openworkToken?.trim() ||
        props.openworkServerSettings.token?.trim() ||
        "";
      return [
        {
          label: "OpenWork worker URL",
          value: url,
        },
        {
          label: "Access token",
          value: token,
          secret: true,
          placeholder: token ? undefined : "Set token in workspace settings",
          hint: "This token grants access to the worker on that host.",
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
    if (ws.workspaceType === "local" && props.engineInfo?.runtime === "direct") {
      return "Engine runtime is set to Direct. Switching local workers can restart the host and disconnect clients. The token may change after a restart.";
    }
    return null;
  });

  const exportDisabledReason = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) return "Export is available for local workers in the desktop app.";
    if (ws.workspaceType === "remote") return "Export is only supported for local workers.";
    if (!isTauriRuntime()) return "Export is available in the desktop app.";
    if (props.exportWorkspaceBusy) return "Export is already running.";
    return null;
  });

  const handleSendPrompt = (draft: ComposerDraft) => {
    setScrollOnNextUpdate(true);
    scrollToLatest("auto");
    startRun();
    props.sendPromptAsync(draft).catch(() => undefined);
  };

  const handleBrowserAutomationQuickstart = async () => {
    const name = BROWSER_SETUP_TEMPLATE.name;
    try {
      const commands = await props.listCommands();
      const hasCommand = commands.some((cmd) => cmd.name === name);
      if (hasCommand) {
        handleSendPrompt({
          mode: "prompt",
          text: `/${name}`,
          resolvedText: `/${name}`,
          parts: [{ type: "text", text: `/${name}` }],
          attachments: [],
          command: { name, arguments: "" },
        });
        return;
      }
    } catch {
      // Fall back to prompt-based setup below.
    }

    const text = BROWSER_SETUP_TEMPLATE.body || "Help me set up browser automation.";
    handleSendPrompt({
      mode: "prompt",
      text,
      resolvedText: text,
      parts: [{ type: "text", text }],
      attachments: [],
    });
  };

  const handleSoulQuickstart = async () => {
    const name = SOUL_SETUP_TEMPLATE.name;
    try {
      const commands = await props.listCommands();
      const hasCommand = commands.some((cmd) => cmd.name === name);
      if (hasCommand) {
        handleSendPrompt({
          mode: "prompt",
          text: `/${name}`,
          resolvedText: `/${name}`,
          parts: [{ type: "text", text: `/${name}` }],
          attachments: [],
          command: { name, arguments: "" },
        });
        return;
      }
    } catch {
      // Fall back to prompt-based setup below.
    }

    const text = SOUL_SETUP_TEMPLATE.body || "Give me a soul.";
    handleSendPrompt({
      mode: "prompt",
      text,
      resolvedText: text,
      parts: [{ type: "text", text }],
      attachments: [],
    });
  };

  const isSandboxWorkspace = createMemo(() => Boolean((props.activeWorkspaceDisplay as any)?.sandboxContainerName?.trim()));

  const uploadInboxFiles = async (
    files: File[],
    options?: { notify?: boolean },
  ): Promise<Array<{ name: string; path: string }>> => {
    const notify = options?.notify ?? true;
    const client = props.openworkServerClient;
    const workspaceId = props.openworkServerWorkspaceId?.trim() ?? "";
    if (!client || !workspaceId) {
      if (notify) {
        setToastMessage("Connect to the OpenWork server to upload inbox files.");
      }
      return [];
    }
    if (!files.length) return [];

    const label = files.length === 1 ? files[0]?.name ?? "file" : `${files.length} files`;
    if (notify) {
      setToastMessage(`Uploading ${label} to inbox...`);
    }

    try {
      const uploaded: Array<{ name: string; path: string }> = [];
      for (const file of files) {
        const result = await client.uploadInbox(workspaceId, file);
        const path = result.path?.trim() || file.name;
        uploaded.push({ name: file.name || path, path });
      }
      if (notify) {
        const summary = uploaded.map((file) => file.name).filter(Boolean).join(", ");
        setToastMessage(summary ? `Uploaded to inbox: ${summary}` : "Uploaded to inbox.");
      }
      return uploaded;
    } catch (error) {
      if (notify) {
        const message = error instanceof Error ? error.message : "Inbox upload failed";
        setToastMessage(message);
      }
      return [];
    }
  };

  const handleDraftChange = (draft: ComposerDraft) => {
    props.setPrompt(draft.text);
  };

  const openSessionFromList = (workspaceId: string, sessionId: string) => {
    if (!sessionId) return;
    // For same-workspace clicks, just select the session without workspace activation
    if (workspaceId === props.activeWorkspaceId) {
      void props.selectSession(sessionId);
      props.setView("session", sessionId);
      return;
    }
    // For different workspace, activate workspace first
    void (async () => {
      await Promise.resolve(props.activateWorkspace(workspaceId));
      void props.selectSession(sessionId);
      props.setView("session", sessionId);
    })();
  };

  const createTaskInWorkspace = (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    expandWorkspace(id);
    if (id === props.activeWorkspaceId) {
      props.createSessionAndOpen();
      return;
    }
    void (async () => {
      await Promise.resolve(props.activateWorkspace(id));
      props.createSessionAndOpen();
    })();
  };

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
    return state === "available" || state === "downloading" || state === "ready";
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

  const updatePillTone = createMemo(() => {
    const state = props.updateStatus?.state;
    if (state === "ready") {
      return "border-transparent bg-green-9 text-white shadow-[0_2px_10px_rgba(22,163,74,0.35)] hover:bg-green-10";
    }
    return "border-transparent bg-dls-accent text-white shadow-[0_2px_10px_rgba(var(--dls-accent-rgb),0.35)] hover:bg-[var(--dls-accent-hover)]";
  });

  const updatePillTitle = createMemo(() => {
    const version = props.updateStatus?.version ? `v${props.updateStatus.version}` : "";
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

  const openSoul = (workspaceId?: string) => {
    const id = (workspaceId ?? props.activeWorkspaceId).trim();
    if (!id) return;
    void (async () => {
      if (id !== props.activeWorkspaceId) {
        await Promise.resolve(props.activateWorkspace(id));
      }
      props.setTab("soul");
      props.setView("dashboard");
    })();
  };

  const soulModeEnabled = createMemo(() =>
    Boolean(props.soulStatusByWorkspaceId[props.activeWorkspaceId]?.enabled)
  );

  const soulNavIconClass = () => (soulModeEnabled() ? "soul-nav-icon-active" : "");

  const openProviderAuth = () => {
    void props.openProviderAuthModal().catch((error) => {
      const message = error instanceof Error ? error.message : "Connect failed";
      setToastMessage(message);
    });
  };

  return (
    <div class="flex h-screen w-full bg-dls-surface text-dls-text font-sans overflow-hidden">
      <aside class="w-64 hidden md:flex flex-col bg-dls-sidebar border-r border-dls-border p-4">
        <div class="flex-1 overflow-y-auto">
          <Show when={showUpdatePill()}>
            <button
              type="button"
              class={`mb-3 w-full flex h-9 items-center gap-2 rounded-xl border px-3 text-xs font-medium transition-all hover:-translate-y-[1px] ${updatePillTone()}`}
              onClick={handleUpdatePillClick}
              title={updatePillTitle()}
              aria-label={updatePillTitle()}
            >
              <Show
                when={props.updateStatus?.state === "downloading"}
                fallback={
                  <span class="w-2 h-2 rounded-full bg-white/85" />
                }
              >
                <Loader2 size={14} class="animate-spin text-white/90" />
              </Show>
              <span class="text-[11px] font-semibold text-white">{updatePillLabel()}</span>
              <Show when={props.updateStatus?.version}>
                {(version) => (
                  <span class="ml-auto text-[11px] text-white/80 font-mono">v{version()}</span>
                )}
              </Show>
            </button>
          </Show>
          <div class="space-y-3 mb-3">
            <For each={props.workspaceSessionGroups}>
              {(group) => {
                const workspace = () => group.workspace;
                const isConnecting = () => props.connectingWorkspaceId === workspace().id;
                const isMenuOpen = () => workspaceMenuId() === workspace().id;
                const taskLoadError = () => getWorkspaceTaskLoadErrorDisplay(workspace(), group.error);
                const soulStatus = () => props.soulStatusByWorkspaceId[workspace().id] ?? null;
                const soulEnabled = () => Boolean(soulStatus()?.enabled);

                return (
                  <div class="space-y-1">
                    <div class="relative group">
                        <div
                          role="button"
                          tabIndex={0}
                          class="w-full flex items-center justify-between h-10 px-3 rounded-lg text-left transition-colors text-dls-text hover:bg-dls-hover"
                          onClick={() => {
                            expandWorkspace(workspace().id);
                            props.activateWorkspace(workspace().id);
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ") return;
                            if (event.isComposing || event.keyCode === 229) return;
                            event.preventDefault();
                            expandWorkspace(workspace().id);
                            props.activateWorkspace(workspace().id);
                          }}
                        >
                          <button
                            type="button"
                            class="mr-2 -ml-1 p-1 rounded-md text-dls-secondary hover:text-dls-text hover:bg-dls-active"
                            aria-label={isWorkspaceExpanded(workspace().id) ? "Collapse" : "Expand"}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleWorkspaceExpanded(workspace().id);
                            }}
                          >
                            <Show
                              when={isWorkspaceExpanded(workspace().id)}
                              fallback={<ChevronRight size={14} />}
                            >
                              <ChevronDown size={14} />
                            </Show>
                          </button>
                          <div class="min-w-0 flex-1">
                            <div class="text-sm font-medium truncate">{workspaceLabel(workspace())}</div>
                            <div class="text-[11px] text-dls-secondary flex items-center gap-1.5">
                              <span>{workspaceKindLabel(workspace())}</span>
                              <Show when={soulEnabled()}>
                                <span class="inline-flex items-center gap-1 rounded-full border border-rose-7/40 bg-rose-3/40 px-1.5 py-0.5 text-[10px] text-rose-11">
                                  <HeartPulse size={10} />
                                  Soul
                                </span>
                              </Show>
                            </div>
                          </div>
                          <Show when={group.status === "loading"}>
                            <Loader2 size={14} class="animate-spin text-dls-secondary mr-1" />
                          </Show>
                          <Show when={group.status === "error"}>
                            <span
                              class={`text-[10px] px-2 py-0.5 rounded-full border ${
                                taskLoadError().tone === "offline"
                                  ? "border-amber-7/50 text-amber-11 bg-amber-3/30"
                                  : "border-red-7/50 text-red-11 bg-red-3/30"
                              }`}
                              title={taskLoadError().title}
                            >
                              {taskLoadError().label}
                            </span>
                          </Show>
                          <Show when={isConnecting()}>
                            <Loader2 size={14} class="animate-spin text-dls-secondary" />
                          </Show>
                        </div>
                      <div class="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          type="button"
                          class="p-1 rounded-md text-dls-secondary hover:text-dls-text hover:bg-dls-active"
                          onClick={(event) => {
                            event.stopPropagation();
                            createTaskInWorkspace(workspace().id);
                          }}
                          disabled={props.newTaskDisabled}
                          aria-label="New task"
                        >
                          <Plus size={14} />
                        </button>
                        <button
                          type="button"
                          class="p-1 rounded-md text-dls-secondary hover:text-dls-text hover:bg-dls-active"
                          onClick={(event) => {
                            event.stopPropagation();
                            setWorkspaceMenuId((current) =>
                              current === workspace().id ? null : workspace().id
                            );
                          }}
                          aria-label="Worker options"
                        >
                          <MoreHorizontal size={14} />
                        </button>
                      </div>
                      <Show when={isMenuOpen()}>
                        <div
                          ref={(el) => (workspaceMenuRef = el)}
                          class="absolute right-2 top-[calc(100%+4px)] z-20 w-44 rounded-lg border border-dls-border bg-dls-surface shadow-lg p-1"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <button
                            type="button"
                            class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-dls-hover"
                            onClick={() => {
                              props.openRenameWorkspace(workspace().id);
                              setWorkspaceMenuId(null);
                            }}
                          >
                            Edit name
                          </button>
                          <button
                            type="button"
                            class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-dls-hover"
                            onClick={() => {
                              setShareWorkspaceId(workspace().id);
                              setWorkspaceMenuId(null);
                            }}
                          >
                            Share...
                          </button>
                          <button
                            type="button"
                            class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-dls-hover"
                            onClick={() => {
                              openSoul(workspace().id);
                              setWorkspaceMenuId(null);
                            }}
                          >
                            {soulEnabled() ? "Soul settings" : "Enable soul"}
                          </button>
                          <Show when={workspace().workspaceType === "remote"}>
                            <button
                              type="button"
                              class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-dls-hover"
                              onClick={() => {
                                void props.testWorkspaceConnection(workspace().id);
                                setWorkspaceMenuId(null);
                              }}
                              disabled={isConnecting()}
                            >
                              Test connection
                            </button>
                            <button
                              type="button"
                              class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-dls-hover"
                              onClick={() => {
                                props.editWorkspaceConnection(workspace().id);
                                setWorkspaceMenuId(null);
                              }}
                              disabled={isConnecting()}
                            >
                              Edit connection
                            </button>
                          </Show>
                          <button
                            type="button"
                            class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-dls-hover text-red-11"
                            onClick={() => {
                              props.forgetWorkspace(workspace().id);
                              setWorkspaceMenuId(null);
                            }}
                          >
                            Remove workspace
                          </button>
                        </div>
                      </Show>
                    </div>

                    <div class="mt-0.5 space-y-0.5 border-l border-dls-border ml-2">
                      <Show
                        when={isWorkspaceExpanded(workspace().id)}
                        fallback={
                          <Show when={group.sessions.length > 0}>
                            <For each={previewSessions(workspace().id, group.sessions)}>
                              {(session) => {
                                const isSelected = () => props.selectedSessionId === session.id;
                                return (
                                  <div
                                    role="button"
                                    tabIndex={0}
                                    class={`group flex items-center justify-between h-8 px-3 rounded-lg cursor-pointer relative overflow-hidden ml-2 w-[calc(100%-0.5rem)] ${
                                      isSelected()
                                        ? "bg-dls-active text-dls-text"
                                        : "hover:bg-dls-hover"
                                    }`}
                                    onClick={() => openSessionFromList(workspace().id, session.id)}
                                    onKeyDown={(event) => {
                                      if (event.key !== "Enter" && event.key !== " ") return;
                                      if (event.isComposing || event.keyCode === 229) return;
                                      event.preventDefault();
                                      openSessionFromList(workspace().id, session.id);
                                    }}
                                  >
                                    <span class="text-sm text-dls-text truncate mr-2 font-medium">
                                      {session.title}
                                    </span>
                                    <Show when={session.time?.updated}>
                                      <span class="text-xs text-dls-secondary whitespace-nowrap">
                                        {formatRelativeTime(session.time?.updated ?? Date.now())}
                                      </span>
                                    </Show>
                                  </div>
                                );
                              }}
                            </For>
                          </Show>
                        }
                      >
                        <Show
                          when={group.status === "loading" && group.sessions.length === 0}
                          fallback={
                            <Show
                              when={group.sessions.length > 0}
                              fallback={
                                <Show when={group.status === "error"}>
                                  <div
                                    class={`w-full px-3 py-2 text-xs ml-2 text-left rounded-lg border ${
                                      taskLoadError().tone === "offline"
                                        ? "text-amber-11 bg-amber-3/20 border-amber-7/40"
                                        : "text-red-11 bg-red-3/20 border-red-7/40"
                                    }`}
                                    title={taskLoadError().title}
                                  >
                                    {taskLoadError().message}
                                  </div>
                                </Show>
                              }
                            >
                              <For each={previewSessions(workspace().id, group.sessions)}>
                                {(session) => {
                                  const isSelected = () => props.selectedSessionId === session.id;
                                  return (
                                    <div
                                      role="button"
                                      tabIndex={0}
                                      class={`group flex items-center justify-between h-8 px-3 rounded-lg cursor-pointer relative overflow-hidden ml-2 w-[calc(100%-0.5rem)] ${
                                        isSelected()
                                          ? "bg-dls-active text-dls-text"
                                          : "hover:bg-dls-hover"
                                      }`}
                                      onClick={() => openSessionFromList(workspace().id, session.id)}
                                      onKeyDown={(event) => {
                                        if (event.key !== "Enter" && event.key !== " ") return;
                                        if (event.isComposing || event.keyCode === 229) return;
                                        event.preventDefault();
                                        openSessionFromList(workspace().id, session.id);
                                      }}
                                    >
                                      <span class="text-sm text-dls-text truncate mr-2 font-medium">
                                        {session.title}
                                      </span>
                                      <Show when={session.time?.updated}>
                                        <span class="text-xs text-dls-secondary whitespace-nowrap">
                                          {formatRelativeTime(session.time?.updated ?? Date.now())}
                                        </span>
                                      </Show>
                                    </div>
                                  );
                                }}
                              </For>

                              <Show when={group.sessions.length === 0 && group.status === "ready"}>
                                <button
                                  type="button"
                                  class="group/empty w-full px-3 py-2 text-xs text-dls-secondary ml-2 text-left rounded-lg hover:bg-dls-hover hover:text-dls-text transition-colors"
                                  onClick={() => createTaskInWorkspace(workspace().id)}
                                  disabled={props.newTaskDisabled}
                                >
                                  <span class="group-hover/empty:hidden">No tasks yet.</span>
                                  <span class="hidden group-hover/empty:inline font-medium">+ New task</span>
                                </button>
                              </Show>

                              <Show when={group.sessions.length > previewCount(workspace().id)}>
                                <button
                                  type="button"
                                  class="ml-2 w-[calc(100%-0.5rem)] px-3 py-2 text-xs text-dls-secondary hover:text-dls-text hover:bg-dls-hover rounded-lg transition-colors text-left"
                                  onClick={() => showMoreSessions(workspace().id, group.sessions.length)}
                                >
                                  {showMoreLabel(workspace().id, group.sessions.length)}
                                </button>
                              </Show>
                            </Show>
                          }
                        >
                          <div class="w-full px-3 py-2 text-xs text-dls-secondary ml-2 text-left rounded-lg">
                            Loading tasks...
                          </div>
                        </Show>
                      </Show>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>

          <div class="relative" ref={(el) => (addWorkspaceMenuRef = el)}>
            <button
              type="button"
              class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
              onClick={() => setAddWorkspaceMenuOpen((prev) => !prev)}
            >
              <Plus size={14} />
              Add a worker
            </button>
            <Show when={addWorkspaceMenuOpen()}>
              <div class="absolute left-0 right-0 top-full mt-2 rounded-lg border border-dls-border bg-dls-surface shadow-xl overflow-hidden z-20">
                <button
                  type="button"
                  class="w-full flex items-center gap-2 px-3 py-2 text-xs text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors"
                  onClick={() => {
                    props.openCreateWorkspace();
                    setAddWorkspaceMenuOpen(false);
                  }}
                >
                  <Plus size={12} />
                  New worker
                </button>
                <button
                  type="button"
                  class="w-full flex items-center gap-2 px-3 py-2 text-xs text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors"
                  onClick={() => {
                    props.openCreateRemoteWorkspace();
                    setAddWorkspaceMenuOpen(false);
                  }}
                >
                  <Plus size={12} />
                  Connect remote
                </button>
                <button
                  type="button"
                  class="w-full flex items-center gap-2 px-3 py-2 text-xs text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                  disabled={props.importingWorkspaceConfig}
                  onClick={() => {
                    props.importWorkspaceConfig();
                    setAddWorkspaceMenuOpen(false);
                  }}
                >
                  <Plus size={12} />
                  Import config
                </button>
              </div>
            </Show>
          </div>
        </div>

      </aside>

      <main class="flex-1 flex flex-col overflow-hidden bg-dls-surface">
        <header class="h-14 border-b border-dls-border flex items-center justify-between px-6 bg-dls-surface z-10 shrink-0">
          <div class="flex items-center gap-3 min-w-0">
            <Show when={showUpdatePill()}>
              <button
                type="button"
                class={`md:hidden flex h-8 items-center gap-2 rounded-full border px-3 text-xs font-medium transition-colors ${updatePillTone()}`}
                onClick={handleUpdatePillClick}
                title={updatePillTitle()}
                aria-label={updatePillTitle()}
              >
                <Show
                  when={props.updateStatus?.state === "downloading"}
                  fallback={
                    <span class="w-2 h-2 rounded-full bg-white/85" />
                  }
                >
                  <Loader2 size={14} class="animate-spin text-white/90" />
                </Show>
                <span class="text-[11px] font-semibold text-white">{updatePillLabel()}</span>
                <Show when={props.updateStatus?.version}>
                  {(version) => (
                    <span class="hidden sm:inline text-[11px] text-white/80 font-mono">v{version()}</span>
                  )}
                </Show>
              </button>
            </Show>

            <h1 class="text-sm font-semibold text-dls-text truncate">{selectedSessionTitle() || "New task"}</h1>
            <Show when={props.developerMode}>
              <span class="text-xs text-dls-secondary">{props.headerStatus}</span>
            </Show>
            <Show when={props.busyHint}>
              <span class="text-xs text-dls-secondary">· {props.busyHint}</span>
            </Show>
          </div>

          <div class="flex items-center gap-2">
            <button
              type="button"
              class={`h-9 w-9 flex items-center justify-center rounded-lg transition-colors ${
                searchOpen()
                  ? "bg-dls-active text-dls-text"
                  : "text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
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
            <button
              type="button"
              class="h-9 w-9 flex items-center justify-center rounded-lg text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              onClick={undoLastMessage}
              disabled={!canUndoLastMessage() || historyActionBusy() !== null}
              title="Undo last message"
              aria-label="Undo last message"
            >
              <Show when={historyActionBusy() === "undo"} fallback={<Undo2 size={16} />}>
                <Loader2 size={16} class="animate-spin" />
              </Show>
            </button>
            <button
              type="button"
              class="h-9 w-9 flex items-center justify-center rounded-lg text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              onClick={redoLastMessage}
              disabled={!canRedoLastMessage() || historyActionBusy() !== null}
              title="Redo last reverted message"
              aria-label="Redo last reverted message"
            >
              <Show when={historyActionBusy() === "redo"} fallback={<Redo2 size={16} />}>
                <Loader2 size={16} class="animate-spin" />
              </Show>
            </button>
            <div ref={(el) => (sessionMenuRef = el)} class="relative">
              <button
                type="button"
                class="h-9 w-9 flex items-center justify-center rounded-lg text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                disabled={!props.selectedSessionId}
                title={props.selectedSessionId ? "Session actions" : "Select a session to manage it"}
                aria-label={props.selectedSessionId ? "Session actions" : "Select a session to manage it"}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setSessionMenuOpen((current) => !current);
                }}
              >
                <MoreHorizontal size={18} />
              </button>

              <Show when={sessionMenuOpen() && props.selectedSessionId}>
                <div
                  class="absolute right-0 top-[calc(100%+4px)] z-20 w-44 rounded-lg border border-dls-border bg-dls-surface shadow-lg p-1"
                  onClick={(event) => event.stopPropagation()}
                >
                  <button
                    type="button"
                    class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-dls-hover"
                    onClick={openRenameModal}
                  >
                    Rename session
                  </button>
                  <button
                    type="button"
                    class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-dls-hover text-red-11"
                    onClick={openDeleteSessionModal}
                  >
                    Delete session
                  </button>
                </div>
              </Show>
            </div>
          </div>
        </header>

        <Show when={searchOpen()}>
          <div class="border-b border-dls-border bg-dls-hover/40 px-6 py-2">
            <div class="mx-auto flex w-full max-w-5xl items-center gap-2 rounded-xl border border-dls-border bg-dls-surface px-3 py-2">
              <Search size={14} class="text-dls-secondary" />
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
                class="min-w-0 flex-1 bg-transparent text-sm text-dls-text placeholder:text-dls-secondary focus:outline-none"
                placeholder="Search in this chat"
                aria-label="Search in this chat"
              />
              <span class="text-[11px] text-dls-secondary tabular-nums">{activeSearchPositionLabel()}</span>
              <button
                type="button"
                class="rounded-md border border-dls-border px-2 py-1 text-[11px] text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors disabled:opacity-60"
                disabled={searchHits().length === 0}
                onClick={() => moveSearchHit(-1)}
                aria-label="Previous match"
              >
                Prev
              </button>
              <button
                type="button"
                class="rounded-md border border-dls-border px-2 py-1 text-[11px] text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors disabled:opacity-60"
                disabled={searchHits().length === 0}
                onClick={() => moveSearchHit(1)}
                aria-label="Next match"
              >
                Next
              </button>
              <button
                type="button"
                class="h-7 w-7 flex items-center justify-center rounded-md text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors"
                onClick={closeSearch}
                aria-label="Close search"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        </Show>

      <Show when={props.error}>
        <div class="mx-auto max-w-5xl w-full px-6 md:px-10 pt-4">
          <div class="rounded-2xl bg-red-1/40 px-5 py-4 text-sm text-red-12 border border-red-7/20">
            {props.error}
          </div>
        </div>
      </Show>

       <div class="flex-1 flex overflow-hidden">
         <div class="flex-1 min-w-0 relative overflow-hidden">
           <div
             class="h-full overflow-y-auto px-12 py-10 scroll-smooth bg-dls-surface"
             ref={(el) => (chatContainerEl = el)}
           >
             <div class="max-w-5xl mx-auto w-full">
           <Show when={props.messages.length === 0}>
             <div class="text-center py-16 px-6 space-y-6">
               <div class="w-16 h-16 bg-dls-hover rounded-3xl mx-auto flex items-center justify-center border border-dls-border">
                 <Zap class="text-dls-secondary" />
               </div>
              <div class="space-y-2">
                <h3 class="text-xl font-medium">What do you want to do?</h3>
                <p class="text-dls-secondary text-sm max-w-sm mx-auto">
                  Pick a starting point or just type below.
                </p>
              </div>
              <div class="grid gap-3 sm:grid-cols-2 max-w-2xl mx-auto text-left">
                <button
                  type="button"
                  class="rounded-2xl border border-dls-border bg-dls-hover p-4 transition-all hover:bg-dls-active hover:border-gray-7"
                  onClick={() => {
                    void handleBrowserAutomationQuickstart();
                  }}
                >
                  <div class="text-sm font-semibold text-dls-text">Automate your browser</div>
                  <div class="mt-1 text-xs text-dls-secondary leading-relaxed">
                    Set up browser actions and run reliable web tasks from OpenWork.
                  </div>
                </button>
                <button
                  type="button"
                  class="rounded-2xl border border-dls-border bg-dls-hover p-4 transition-all hover:bg-dls-active hover:border-gray-7"
                  onClick={() => {
                    void handleSoulQuickstart();
                  }}
                >
                  <div class="text-sm font-semibold text-dls-text">Give me a soul</div>
                  <div class="mt-1 text-xs text-dls-secondary leading-relaxed">
                    Keep your goals and preferences across sessions with light scheduled check-ins.
                    Tradeoff: more autonomy can create extra background runs, but revert is one command.
                  </div>
                </button>
              </div>
            </div>
          </Show>

          <Show when={hiddenMessageCount() > 0}>
            <div class="mb-4 flex justify-center">
              <button
                type="button"
                class="rounded-full border border-dls-border bg-dls-hover/70 px-3 py-1 text-xs text-dls-secondary transition-colors hover:bg-dls-active hover:text-dls-text"
                onClick={revealEarlierMessages}
              >
                Show {nextRevealCount().toLocaleString()} earlier message
                {nextRevealCount() === 1 ? "" : "s"}
              </button>
            </div>
          </Show>

          <MessageList
            messages={renderedMessages()}
            developerMode={props.developerMode}
            showThinking={props.showThinking}
            workspaceRoot={props.activeWorkspaceRoot}
            expandedStepIds={props.expandedStepIds}
            setExpandedStepIds={props.setExpandedStepIds}
            searchMatchMessageIds={searchMatchMessageIds()}
            activeSearchMessageId={activeSearchHit()?.messageId ?? null}
            footer={
              showRunIndicator() ? (
                <div class="flex justify-start pl-2">
                  <div class="w-full max-w-[68ch]">
                    <div
                      class={`flex items-center gap-2 text-xs py-1 ${runPhase() === "error" ? "text-red-11" : "text-gray-9"}`}
                      role="status"
                      aria-live="polite"
                    >
                      <span
                        class={`h-1.5 w-1.5 rounded-full shrink-0 ${
                          runPhase() === "error" ? "bg-red-9" : "bg-gray-8 animate-pulse"
                        }`}
                      />
                      <span class="truncate">{thinkingStatus() || runLabel()}</span>
                      <Show when={props.developerMode}>
                        <span class="text-[10px] text-gray-8 ml-auto shrink-0">{runElapsedLabel()}</span>
                      </Show>
                    </div>
                    <Show when={thinkingDetail()?.detail}>
                      {(detail) => (
                        <div class="pl-3 pr-2 pt-0.5 text-[11px] leading-relaxed text-gray-10 whitespace-pre-wrap break-words">
                          {thinkingDetail()?.title === "Reasoning" ? detail() : `${thinkingDetail()?.title}: ${detail()}`}
                        </div>
                      )}
                    </Show>
                  </div>
                </div>
              ) : undefined
            }
          />

           <div ref={(el) => (messagesEndEl = el)} />
           </div>
           </div>

           <Show when={!autoScrollEnabled() && props.messages.length > 0}>
             <div class="absolute bottom-4 left-0 right-0 z-20 flex justify-center pointer-events-none">
               <button
                 type="button"
                 class="pointer-events-auto rounded-full border border-gray-6 bg-gray-1/90 px-4 py-2 text-xs text-gray-11 shadow-lg shadow-gray-12/5 backdrop-blur-md hover:bg-gray-2 transition-colors"
                 onClick={() => scrollToLatest("smooth")}
               >
                 Jump to latest
               </button>
             </div>
           </Show>
         </div>

          <Show when={markdownEditorOpen()}>
            <aside class="hidden lg:flex w-[520px] shrink-0 border-l border-dls-border bg-dls-sidebar">
              <ArtifactMarkdownEditor
                open={markdownEditorOpen()}
                path={markdownEditorPath()}
                workspaceId={props.openworkServerWorkspaceId}
                client={props.openworkServerClient}
                onClose={closeMarkdownEditor}
                onToast={(message) => setToastMessage(message)}
              />
            </aside>
          </Show>
        </div>

      <Show when={todoCount() > 0}>
        <div class="mx-auto w-full max-w-[68ch] px-4">
          <div class="rounded-t-xl border border-b-0 border-gray-6/70 bg-gray-1/70 shadow-sm shadow-gray-12/5">
            <button
              type="button"
              class="w-full flex items-center justify-between px-4 py-2.5 text-xs text-gray-9 hover:bg-gray-2/50 transition-colors rounded-t-xl"
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
              <div class="px-4 pb-3 space-y-2.5 max-h-60 overflow-auto border-t border-gray-6/50">
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
                            cancelled() ? "text-gray-9 line-through" : "text-gray-12"
                          }`}
                        >
                          <span class="text-gray-9 mr-1.5">{index() + 1}.</span>
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

      <Composer
        prompt={props.prompt}
        busy={props.busy}
        isStreaming={showRunIndicator()}
        onSend={handleSendPrompt}
        onStop={cancelRun}
        onDraftChange={handleDraftChange}
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
        toast={toastMessage()}
        onToast={(message) => setToastMessage(message)}
        listAgents={props.listAgents}
        recentFiles={props.workingFiles}
        searchFiles={props.searchFiles}
        listCommands={props.listCommands}
        isRemoteWorkspace={props.activeWorkspaceDisplay.workspaceType === "remote"}
        isSandboxWorkspace={isSandboxWorkspace()}
        onUploadInboxFiles={uploadInboxFiles}
        attachmentsEnabled={attachmentsEnabled()}
        attachmentsDisabledReason={attachmentsDisabledReason()}
      />

        <StatusBar
          clientConnected={props.clientConnected}
          openworkServerStatus={props.openworkServerStatus}
          developerMode={props.developerMode}
          onOpenSettings={() => openSettings("general")}
          onOpenMessaging={openConfig}
          onOpenProviders={openProviderAuth}
          onOpenMcp={openMcp}
          providerConnectedIds={props.providerConnectedIds}
          mcpStatuses={props.mcpStatuses}
        />
      </main>

      <aside class="w-56 hidden md:flex flex-col bg-dls-sidebar border-l border-dls-border p-4">
        <div class="flex-1 overflow-y-auto space-y-3 pt-2">
          <div class="space-y-1">
          <button
            type="button"
            class={`w-full h-10 flex items-center gap-3 px-3 rounded-lg text-sm font-medium transition-colors ${
              showRightSidebarSelection() && props.tab === "scheduled"
                ? "bg-dls-active text-dls-text"
                : "text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
            }`}
            onClick={() => {
              props.setTab("scheduled");
              props.setView("dashboard");
            }}
          >
            <History size={18} />
            Automations
          </button>
          <button
            type="button"
            class={`w-full h-10 flex items-center gap-3 px-3 rounded-lg text-sm font-medium transition-colors ${
              showRightSidebarSelection() && props.tab === "soul"
                ? "bg-dls-active text-dls-text"
                : "text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
            }`}
            onClick={() => openSoul()}
          >
            <HeartPulse size={18} class={soulNavIconClass()} />
            Soul
          </button>
          <button
            type="button"
            class={`w-full h-10 flex items-center gap-3 px-3 rounded-lg text-sm font-medium transition-colors ${
              showRightSidebarSelection() && props.tab === "skills"
                ? "bg-dls-active text-dls-text"
                : "text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
            }`}
            onClick={() => {
              props.setTab("skills");
              props.setView("dashboard");
            }}
          >
            <Zap size={18} />
            Skills
          </button>
          <button
            type="button"
            class={`w-full h-10 flex items-center gap-3 px-3 rounded-lg text-sm font-medium transition-colors ${
              showRightSidebarSelection() && (props.tab === "mcp" || props.tab === "plugins")
                ? "bg-dls-active text-dls-text"
                : "text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
            }`}
            onClick={() => {
              props.setTab("mcp");
              props.setView("dashboard");
            }}
          >
            <Box size={18} />
            Extensions
          </button>
          <button
            type="button"
            class={`w-full h-10 flex items-center gap-3 px-3 rounded-lg text-sm font-medium transition-colors ${
              showRightSidebarSelection() && props.tab === "identities"
                ? "bg-dls-active text-dls-text"
                : "text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
            }`}
            onClick={() => {
              props.setTab("identities");
              props.setView("dashboard");
            }}
          >
            <MessageCircle size={18} />
            Messaging
          </button>
          <Show when={props.developerMode}>
            <button
              type="button"
              class={`w-full h-10 flex items-center gap-3 px-3 rounded-lg text-sm font-medium transition-colors ${
                showRightSidebarSelection() && props.tab === "config"
                  ? "bg-dls-active text-dls-text"
                  : "text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
              }`}
              onClick={openConfig}
            >
              <SlidersHorizontal size={18} />
              Advanced
            </button>
          </Show>
          </div>

          <InboxPanel
            id="sidebar-inbox"
            client={props.openworkServerClient}
            workspaceId={props.openworkServerWorkspaceId}
            onToast={(message) => setToastMessage(message)}
          />

          <ArtifactsPanel
            id="sidebar-artifacts"
            files={touchedFiles()}
            workspaceRoot={props.activeWorkspaceRoot}
            onOpenMarkdown={openMarkdownEditor}
          />
        </div>
      </aside>

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

      <ConfirmModal
        open={deleteSessionOpen()}
        title="Delete session?"
        message={
          selectedSessionTitle().trim()
            ? `This will permanently delete \"${selectedSessionTitle().trim()}\" and its messages.`
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

      <QuestionModal
        open={Boolean(props.activeQuestion)}
        questions={props.activeQuestion?.questions ?? []}
        busy={props.questionReplyBusy}
        onClose={() => { }}
        onReply={(answers) => {
          if (props.activeQuestion) {
            props.respondQuestion(props.activeQuestion.id, answers);
          }
        }}
      />

      <For each={flyouts()}>
        {(item) => <FlyoutItem item={item} />}
      </For>
    </div>
  );
}
