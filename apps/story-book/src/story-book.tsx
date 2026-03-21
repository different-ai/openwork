import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { Component, JSX } from "solid-js";
import {
  Box,
  ChevronLeft,
  ChevronRight,
  History,
  MessageCircle,
  Redo2,
  Search,
  SlidersHorizontal,
  Undo2,
  X,
  Zap,
} from "lucide-solid";

import Button from "../../app/src/app/components/button";
import DenSettingsPanel from "../../app/src/app/components/den-settings-panel";
import ModelPickerModal from "../../app/src/app/components/model-picker-modal";
import ShareWorkspaceModal from "../../app/src/app/components/share-workspace-modal";
import StatusBar from "../../app/src/app/components/status-bar";
import Composer from "../../app/src/app/components/session/composer";
import InboxPanel from "../../app/src/app/components/session/inbox-panel";
import MessageList from "../../app/src/app/components/session/message-list";
import WorkspaceSessionList from "../../app/src/app/components/session/workspace-session-list";
import { createWorkspaceShellLayout } from "../../app/src/app/lib/workspace-shell-layout";
import { getModelBehaviorSummary, sanitizeModelBehaviorValue } from "../../app/src/app/lib/model-behavior";
import {
  applyThemeMode,
  getInitialThemeMode,
  persistThemeMode,
  subscribeToSystemTheme,
  type ThemeMode,
} from "../../app/src/app/theme";
import type {
  ComposerDraft,
  McpStatusMap,
  MessageWithParts,
  ModelOption,
  ModelRef,
  ProviderListItem,
  SlashCommandOption,
  WorkspaceConnectionState,
  WorkspaceSessionGroup,
} from "../../app/src/app/types";
import { sessionMessages, storyWorkspaces } from "./mock-data";

type RightRailNav = "automations" | "skills" | "extensions" | "messaging" | "advanced";
type CommandPaletteMode = "root" | "sessions";

type CommandPaletteItem = {
  id: string;
  title: string;
  detail?: string;
  meta?: string;
  action: () => void;
};

const localWorkspace = storyWorkspaces[0] ?? {
  id: "local-foundation",
  name: "Local Foundation",
  displayName: "OpenWork App",
  path: "~/OpenWork/app",
  preset: "starter",
  workspaceType: "local" as const,
};

const remoteWorkspace = storyWorkspaces[1] ?? {
  id: "remote-worker",
  name: "Remote Worker",
  displayName: "Ops Worker",
  path: "remote://ops-worker",
  preset: "automation",
  workspaceType: "remote" as const,
  remoteType: "openwork" as const,
  baseUrl: "https://worker.openworklabs.com/opencode",
  openworkHostUrl: "https://worker.openworklabs.com",
  openworkWorkspaceName: "Ops Worker",
  sandboxBackend: "docker" as const,
  sandboxContainerName: "openwork-ops-worker",
};

const now = Date.now();

const workspaceSessionGroups: WorkspaceSessionGroup[] = [
  {
    workspace: localWorkspace,
    status: "ready",
    sessions: [
      {
        id: "sb-session-shell",
        title: "Story shell parity with session.tsx",
        slug: "story-shell-parity",
        time: { updated: now - 2 * 60 * 1000, created: now - 22 * 60 * 1000 },
      },
      {
        id: "sb-session-provider",
        title: "Provider states and status rail",
        slug: "provider-states",
        time: { updated: now - 18 * 60 * 1000, created: now - 56 * 60 * 1000 },
      },
      {
        id: "sb-session-mobile",
        title: "Mobile shell spacing pass",
        slug: "mobile-shell-pass",
        time: { updated: now - 56 * 60 * 1000, created: now - 3 * 60 * 60 * 1000 },
      },
    ],
  },
  {
    workspace: remoteWorkspace,
    status: "ready",
    sessions: [
      {
        id: "sb-session-remote",
        title: "Remote worker onboarding",
        slug: "remote-worker-onboarding",
        time: { updated: now - 7 * 60 * 1000, created: now - 2 * 60 * 60 * 1000 },
      },
      {
        id: "sb-session-inbox",
        title: "Inbox upload behavior",
        slug: "inbox-upload",
        time: { updated: now - 35 * 60 * 1000, created: now - 6 * 60 * 60 * 1000 },
      },
    ],
  },
];

const workspaceConnectionStateById: Record<string, WorkspaceConnectionState> = {
  [localWorkspace.id]: { status: "connected", message: "Local engine ready" },
  [remoteWorkspace.id]: { status: "connected", message: "Connected via token" },
};

const sessionStatusById: Record<string, string> = {
  "sb-session-shell": "running",
  "sb-session-provider": "idle",
  "sb-session-mobile": "idle",
  "sb-session-remote": "idle",
  "sb-session-inbox": "idle",
};

const mcpStatuses: McpStatusMap = {
  browser: { status: "connected" },
  notion: { status: "connected" },
  linear: { status: "needs_auth" },
};

const workingFiles = [
  "apps/story-book/src/story-book.tsx",
  "apps/app/src/app/pages/session.tsx",
  "apps/app/src/app/components/session/workspace-session-list.tsx",
  "apps/app/src/app/components/session/inbox-panel.tsx",
];

const commandOptions: SlashCommandOption[] = [
  { id: "design-review", name: "design-review", description: "Open a design review pass", source: "command" },
  { id: "test-flow", name: "test-flow", description: "Run shell flow checks", source: "skill" },
];

const storyModels: Array<{
  ref: ModelRef;
  title: string;
  description: string;
  isConnected: boolean;
  model: ProviderListItem["models"][string];
}> = [
  {
    ref: { providerID: "anthropic", modelID: "claude-sonnet-4-5-20250929" },
    title: "Claude Sonnet 4.5",
    description: "Anthropic",
    isConnected: true,
    model: {
      id: "claude-sonnet-4-5-20250929",
      name: "Claude Sonnet 4.5",
      reasoning: true,
      variants: { high: {}, max: {} },
    } as unknown as ProviderListItem["models"][string],
  },
  {
    ref: { providerID: "openai", modelID: "gpt-5" },
    title: "GPT-5",
    description: "OpenAI",
    isConnected: true,
    model: {
      id: "gpt-5",
      name: "GPT-5",
      reasoning: true,
      variants: { none: {}, minimal: {}, low: {}, medium: {}, high: {}, xhigh: {} },
    } as unknown as ProviderListItem["models"][string],
  },
  {
    ref: { providerID: "deepseek", modelID: "deepseek-r1" },
    title: "DeepSeek R1",
    description: "DeepSeek",
    isConnected: true,
    model: {
      id: "deepseek-r1",
      name: "DeepSeek R1",
      reasoning: true,
      variants: {},
    } as unknown as ProviderListItem["models"][string],
  },
  {
    ref: { providerID: "openrouter", modelID: "grok-4" },
    title: "Grok 4",
    description: "OpenRouter",
    isConnected: false,
    model: {
      id: "grok-4",
      name: "Grok 4",
      reasoning: false,
      variants: {},
    } as unknown as ProviderListItem["models"][string],
  },
];

const mockShareFields = [
  {
    label: "Worker URL",
    value: "https://worker.openworklabs.com/opencode",
    hint: "Paste this into Add worker -> Connect remote.",
  },
  {
    label: "Password",
    value: "ow_story_worker_owner_password_7f9a1b3c",
    secret: true,
    hint: "Use when the remote client must answer permission prompts.",
  },
  {
    label: "Collaborator token",
    value: "ow_story_worker_collab_token_1c4d2e8a",
    secret: true,
    hint: "Routine access when you do not need owner-only actions.",
  },
] as const;

function toMessageParts(id: string, role: "user" | "assistant", text: string): MessageWithParts {
  return {
    info: {
      id,
      sessionID: "story-shell-session",
      role,
      time: { created: Date.now() },
    } as MessageWithParts["info"],
    parts: [{ type: "text", text } as MessageWithParts["parts"][number]],
  };
}

const RightRailButton: Component<{
  label: string;
  icon: JSX.Element;
  active: boolean;
  expanded: boolean;
  onClick: () => void;
}> = (props) => (
  <button
    type="button"
    class={`flex h-10 w-full items-center rounded-xl px-2.5 text-sm transition-colors ${
      props.active
        ? "bg-dls-surface text-dls-text shadow-[var(--dls-card-shadow)]"
        : "text-gray-10 hover:bg-gray-2/70 hover:text-dls-text"
    }`}
    onClick={props.onClick}
    title={props.label}
    aria-label={props.label}
  >
    <span class={`inline-flex h-8 w-8 shrink-0 items-center justify-center ${props.active ? "text-dls-text" : "text-gray-9"}`}>
      {props.icon}
    </span>
    <Show when={props.expanded}>
      <span class="truncate">{props.label}</span>
    </Show>
  </button>
);

export default function StoryBookApp() {
  const [activeWorkspaceId, setActiveWorkspaceId] = createSignal(localWorkspace.id);
  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>("sb-session-shell");
  const [rightRailNav, setRightRailNav] = createSignal<RightRailNav>("automations");
  const [themeMode] = createSignal<ThemeMode>(getInitialThemeMode());
  const [composerPrompt, setComposerPrompt] = createSignal(
    "Use this mock shell to design layout changes before touching the live session runtime.",
  );
  const [composerToast, setComposerToast] = createSignal<string | null>(null);
  const [selectedAgent, setSelectedAgent] = createSignal<string | null>(null);
  const [selectedModel, setSelectedModel] = createSignal<ModelRef>(storyModels[0].ref);
  const [modelVariant, setModelVariant] = createSignal<string | null>("medium");
  const [modelPickerOpen, setModelPickerOpen] = createSignal(false);
  const [modelPickerTarget, setModelPickerTarget] = createSignal<"default" | "session">("session");
  const [modelPickerQuery, setModelPickerQuery] = createSignal("");
  const [agentPickerOpen, setAgentPickerOpen] = createSignal(false);
  const [shareWorkspaceId, setShareWorkspaceId] = createSignal<string | null>(null);
  const [shareWorkspaceProfileBusy, setShareWorkspaceProfileBusy] = createSignal(false);
  const [shareWorkspaceProfileUrl, setShareWorkspaceProfileUrl] = createSignal<string | null>(null);
  const [shareSkillsSetBusy, setShareSkillsSetBusy] = createSignal(false);
  const [shareSkillsSetUrl, setShareSkillsSetUrl] = createSignal<string | null>(null);
  const [messageRows, setMessageRows] = createSignal<MessageWithParts[]>(sessionMessages);
  const [expandedStepIds, setExpandedStepIds] = createSignal(new Set<string>());
  const [headerActionBusy, setHeaderActionBusy] = createSignal<"undo" | "redo" | "compact" | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = createSignal(false);
  const [commandPaletteMode, setCommandPaletteMode] = createSignal<CommandPaletteMode>("root");
  const [commandPaletteQuery, setCommandPaletteQuery] = createSignal("");
  const [commandPaletteActiveIndex, setCommandPaletteActiveIndex] = createSignal(0);
  let commandPaletteInputEl: HTMLInputElement | undefined;
  const commandPaletteOptionRefs: HTMLButtonElement[] = [];

  const {
    leftSidebarWidth,
    rightSidebarExpanded,
    rightSidebarWidth,
    startLeftSidebarResize,
    toggleRightSidebar,
  } = createWorkspaceShellLayout({ expandedRightWidth: 320 });

  createEffect(() => {
    const mode = themeMode();
    persistThemeMode(mode);
    applyThemeMode(mode);
  });

  createEffect(() => {
    const unsubscribeSystemTheme = subscribeToSystemTheme(() => {
      if (themeMode() === "system") {
        applyThemeMode("system");
      }
    });
    onCleanup(() => unsubscribeSystemTheme());
  });

  const selectedSessionTitle = createMemo(() => {
    const target = selectedSessionId();
    if (!target) return "New session";
    for (const group of workspaceSessionGroups) {
      const found = group.sessions.find((session) => session.id === target);
      if (found) return found.title;
    }
    return "New session";
  });
  const showingSettings = createMemo(() => rightRailNav() === "advanced");
  const activeWorkspace = createMemo(
    () => workspaceSessionGroups.find((group) => group.workspace.id === activeWorkspaceId())?.workspace ?? localWorkspace,
  );
  const shareWorkspace = createMemo(
    () => storyWorkspaces.find((workspace) => workspace.id === shareWorkspaceId()) ?? null,
  );
  const shareWorkspaceName = createMemo(
    () => shareWorkspace()?.displayName?.trim() || shareWorkspace()?.name?.trim() || "Workspace",
  );
  const shareWorkspaceDetail = createMemo(() => {
    const workspace = shareWorkspace();
    if (!workspace) return null;
    if (workspace.workspaceType === "remote") return workspace.baseUrl ?? workspace.path ?? null;
    return workspace.path ?? null;
  });

  const agentLabel = createMemo(() => (selectedAgent() ? `@${selectedAgent()}` : "Auto"));

  const selectedStoryModel = createMemo(
    () => storyModels.find((entry) => entry.ref.providerID === selectedModel().providerID && entry.ref.modelID === selectedModel().modelID)
      ?? storyModels[0],
  );

  const selectedBehavior = createMemo(() =>
    getModelBehaviorSummary(
      selectedStoryModel().ref.providerID,
      selectedStoryModel().model,
      modelVariant(),
    ),
  );

  const selectedModelLabel = createMemo(() => selectedStoryModel().title);

  const storyModelOptions = createMemo<ModelOption[]>(() =>
    storyModels.map((entry) => {
      const behavior = getModelBehaviorSummary(entry.ref.providerID, entry.model, modelVariant());
      return {
        providerID: entry.ref.providerID,
        modelID: entry.ref.modelID,
        title: entry.title,
        description: entry.description,
        footer: entry.ref.providerID === selectedModel().providerID && entry.ref.modelID === selectedModel().modelID
          ? "Current model"
          : undefined,
        behaviorTitle: behavior.title,
        behaviorLabel: behavior.label,
        behaviorDescription: behavior.description,
        behaviorValue: sanitizeModelBehaviorValue(entry.ref.providerID, entry.model, modelVariant()),
        behaviorOptions: behavior.options,
        isFree: false,
        isConnected: entry.isConnected,
      };
    }),
  );

  const filteredStoryModelOptions = createMemo(() => {
    const query = modelPickerQuery().trim().toLowerCase();
    if (!query) return storyModelOptions();
    return storyModelOptions().filter((option) =>
      [
        option.title,
        option.description ?? "",
        option.footer ?? "",
        option.behaviorTitle,
        option.behaviorLabel,
        option.behaviorDescription,
        `${option.providerID}/${option.modelID}`,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  });

  const openModelPicker = (target: "default" | "session" = "session") => {
    setModelPickerTarget(target);
    setModelPickerQuery("");
    setModelPickerOpen(true);
  };

  const applyStoryModelSelection = (next: ModelRef) => {
    const entry = storyModels.find((item) => item.ref.providerID === next.providerID && item.ref.modelID === next.modelID);
    setSelectedModel(next);
    if (entry) {
      setModelVariant(sanitizeModelBehaviorValue(next.providerID, entry.model, modelVariant()) ?? null);
    }
    setModelPickerOpen(false);
  };

  const handleDraftChange = (draft: ComposerDraft) => {
    setComposerPrompt(draft.text);
  };

  const handleSend = (draft: ComposerDraft) => {
    const text = (draft.resolvedText ?? draft.text ?? "").trim();
    if (!text) return;
    const nowStamp = Date.now();
    setMessageRows((current) => [
      ...current,
      toMessageParts(`sb-user-${nowStamp}`, "user", text),
      toMessageParts(
        `sb-assistant-${nowStamp}`,
        "assistant",
        "Story-book mock response: message accepted. This uses app MessageList + Composer with local mock state.",
      ),
    ]);
    setComposerPrompt("");
  };

  const runMockHeaderAction = (action: "undo" | "redo" | "compact", label: string) => {
    if (headerActionBusy()) return;
    setHeaderActionBusy(action);
    setComposerToast(`Story-book: ${label} is mocked in this shell.`);
    window.setTimeout(() => setHeaderActionBusy(null), 240);
  };

  const openMockShareModal = (workspaceId?: string | null) => {
    const nextId = workspaceId?.trim() || activeWorkspaceId();
    setShareWorkspaceId(nextId);
    setShareWorkspaceProfileUrl(null);
    setShareSkillsSetUrl(null);
  };

  const publishMockWorkspaceProfile = () => {
    if (shareWorkspaceProfileBusy()) return;
    setShareWorkspaceProfileBusy(true);
    window.setTimeout(() => {
      const workspace = shareWorkspace();
      const slug = (workspace?.name || "workspace").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
      setShareWorkspaceProfileUrl(`https://share.openworklabs.com/workspaces/${slug || "workspace"}`);
      setShareWorkspaceProfileBusy(false);
    }, 260);
  };

  const publishMockSkillsSet = () => {
    if (shareSkillsSetBusy()) return;
    setShareSkillsSetBusy(true);
    window.setTimeout(() => {
      const workspace = shareWorkspace();
      const slug = (workspace?.name || "workspace").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
      setShareSkillsSetUrl(`https://share.openworklabs.com/skills/${slug || "workspace"}`);
      setShareSkillsSetBusy(false);
    }, 260);
  };

  const totalSessionCount = createMemo(() =>
    workspaceSessionGroups.reduce((count, group) => count + group.sessions.length, 0),
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

    for (const group of workspaceSessionGroups) {
      const workspaceId = group.workspace.id?.trim() ?? "";
      if (!workspaceId) continue;
      const workspaceTitle = group.workspace.displayName?.trim() || group.workspace.name;
      for (const session of group.sessions) {
        const sessionId = session.id?.trim() ?? "";
        if (!sessionId) continue;
        const title = session.title;
        const updatedAt = session.time?.updated ?? session.time?.created ?? 0;
        out.push({
          workspaceId,
          sessionId,
          title,
          workspaceTitle,
          updatedAt,
          searchText: `${title} ${workspaceTitle}`.toLowerCase(),
        });
      }
    }

    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  });

  const focusCommandPaletteInput = () => {
    queueMicrotask(() => {
      commandPaletteInputEl?.focus();
      commandPaletteInputEl?.select();
    });
  };

  const openCommandPalette = (mode: CommandPaletteMode = "root") => {
    setCommandPaletteMode(mode);
    setCommandPaletteOpen(true);
    setCommandPaletteQuery("");
    setCommandPaletteActiveIndex(0);
    focusCommandPaletteInput();
  };

  const closeCommandPalette = () => {
    setCommandPaletteOpen(false);
    setCommandPaletteMode("root");
    setCommandPaletteQuery("");
    setCommandPaletteActiveIndex(0);
  };

  const returnToCommandRoot = () => {
    if (commandPaletteMode() === "root") return;
    setCommandPaletteMode("root");
    setCommandPaletteQuery("");
    setCommandPaletteActiveIndex(0);
    focusCommandPaletteInput();
  };

  const commandPaletteRootItems = createMemo<CommandPaletteItem[]>(() => {
    const selectedTitle = selectedSessionTitle().trim() || "Give your selected session a clearer name";
    const items: CommandPaletteItem[] = [
      {
        id: "new-session",
        title: "Create new session",
        detail: "Start a fresh task in the current workspace",
        meta: "Create",
        action: () => {
          closeCommandPalette();
          setComposerToast("Story-book: create new session is mocked in this shell.");
        },
      },
      {
        id: "rename-session",
        title: "Rename current session",
        detail: selectedTitle,
        meta: "Rename",
        action: () => {
          closeCommandPalette();
          setComposerToast("Story-book: rename session flow is mocked in this shell.");
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
        detail: `${selectedModelLabel()} · ${selectedBehavior().label}`,
        meta: "Open",
        action: () => {
          closeCommandPalette();
          openModelPicker("session");
        },
      },
      {
        id: "provider",
        title: "Connect provider",
        detail: "Open provider connection flow",
        meta: "Open",
        action: () => {
          closeCommandPalette();
          setComposerToast("Story-book: provider connection flow is mocked in this shell.");
        },
      },
      {
        id: "settings",
        title: "Open settings",
        detail: "Show the real settings panel in the shell",
        meta: "Open",
        action: () => {
          closeCommandPalette();
          if (!rightSidebarExpanded()) toggleRightSidebar();
          setRightRailNav("advanced");
        },
      },
      {
        id: "share",
        title: "Share current workspace",
        detail: activeWorkspace().displayName ?? activeWorkspace().name,
        meta: "Share",
        action: () => {
          closeCommandPalette();
          openMockShareModal(activeWorkspaceId());
        },
      },
    ];

    const query = commandPaletteQuery().trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) => `${item.title} ${item.detail ?? ""}`.toLowerCase().includes(query));
  });

  const commandPaletteSessionItems = createMemo<CommandPaletteItem[]>(() => {
    const query = commandPaletteQuery().trim().toLowerCase();
    const candidates = query
      ? commandPaletteSessionOptions().filter((item) => item.searchText.includes(query))
      : commandPaletteSessionOptions();

    return candidates.slice(0, 80).map((item) => ({
      id: `session:${item.workspaceId}:${item.sessionId}`,
      title: item.title,
      detail: item.workspaceTitle,
      meta: item.workspaceId === activeWorkspaceId() ? "Current workspace" : "Switch",
      action: () => {
        closeCommandPalette();
        setActiveWorkspaceId(item.workspaceId);
        setSelectedSessionId(item.sessionId);
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

  const runCommandPaletteItem = (item: CommandPaletteItem) => {
    closeCommandPalette();
    item.action();
  };

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (commandPaletteOpen()) {
          closeCommandPalette();
        } else {
          openCommandPalette();
        }
        return;
      }

      if (!commandPaletteOpen()) return;

      if (event.key === "Escape") {
        event.preventDefault();
        closeCommandPalette();
        return;
      }

      if (event.key === "Backspace" && !commandPaletteQuery().trim() && commandPaletteMode() !== "root") {
        event.preventDefault();
        returnToCommandRoot();
        return;
      }

      const items = commandPaletteItems();
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (!items.length) return;
        setCommandPaletteActiveIndex((index) => (index + 1) % items.length);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (!items.length) return;
        setCommandPaletteActiveIndex((index) => (index - 1 + items.length) % items.length);
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        const item = items[commandPaletteActiveIndex()];
        if (!item) return;
        runCommandPaletteItem(item);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  createEffect(() => {
    const items = commandPaletteItems();
    const index = commandPaletteActiveIndex();
    if (items.length === 0) {
      setCommandPaletteActiveIndex(0);
      return;
    }
    if (index >= items.length) {
      setCommandPaletteActiveIndex(items.length - 1);
    }
  });

  createEffect(() => {
    if (!commandPaletteOpen()) return;
    const index = commandPaletteActiveIndex();
    queueMicrotask(() => {
      commandPaletteOptionRefs[index]?.scrollIntoView({ block: "nearest" });
    });
  });

  createEffect(() => {
    if (!commandPaletteOpen()) return;
    commandPaletteMode();
    commandPaletteQuery();
    commandPaletteOptionRefs.length = 0;
    setCommandPaletteActiveIndex(0);
  });

  const renderRightRail = (expanded: boolean) => (
    <div class="flex h-full w-full flex-col overflow-hidden rounded-[24px] border border-dls-border bg-dls-sidebar p-3 transition-[width] duration-200">
      <div class={`flex items-center pb-3 ${expanded ? "justify-end" : "justify-center"}`}>
        <button
          type="button"
          class="flex h-10 w-10 items-center justify-center rounded-[16px] text-gray-10 transition-colors hover:bg-dls-surface hover:text-dls-text"
          onClick={toggleRightSidebar}
          title={expanded ? "Collapse sidebar" : "Expand sidebar"}
          aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
        >
          <Show when={expanded} fallback={<ChevronLeft size={18} />}>
            <ChevronRight size={18} />
          </Show>
        </button>
      </div>

      <div class={`flex-1 overflow-y-auto ${expanded ? "space-y-5 pt-1" : "space-y-3 pt-1"}`}>
        <div class="space-y-1 mb-2">
          <RightRailButton
            label="Automations"
            icon={<History size={18} />}
            active={rightRailNav() === "automations"}
            expanded={expanded}
            onClick={() => setRightRailNav("automations")}
          />
          <RightRailButton
            label="Skills"
            icon={<Zap size={18} />}
            active={rightRailNav() === "skills"}
            expanded={expanded}
            onClick={() => setRightRailNav("skills")}
          />
          <RightRailButton
            label="Extensions"
            icon={<Box size={18} />}
            active={rightRailNav() === "extensions"}
            expanded={expanded}
            onClick={() => setRightRailNav("extensions")}
          />
          <RightRailButton
            label="Messaging"
            icon={<MessageCircle size={18} />}
            active={rightRailNav() === "messaging"}
            expanded={expanded}
            onClick={() => setRightRailNav("messaging")}
          />
          <RightRailButton
            label="Advanced"
            icon={<SlidersHorizontal size={18} />}
            active={rightRailNav() === "advanced"}
            expanded={expanded}
            onClick={() => setRightRailNav("advanced")}
          />
        </div>

        <Show when={expanded && activeWorkspaceId() === remoteWorkspace.id}>
          <div class="rounded-[20px] border border-dls-border bg-dls-surface p-3 shadow-[var(--dls-card-shadow)]">
            <InboxPanel
              id="sidebar-inbox"
              client={null}
              workspaceId={null}
              onToast={(message) => setComposerToast(message)}
            />
          </div>
        </Show>
      </div>
    </div>
  );

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
          <div class="min-h-0 flex-1">
            <WorkspaceSessionList
              developerMode
              workspaceSessionGroups={workspaceSessionGroups}
              activeWorkspaceId={activeWorkspaceId()}
              selectedSessionId={selectedSessionId()}
              showSessionActions
              sessionStatusById={sessionStatusById}
              connectingWorkspaceId={null}
              workspaceConnectionStateById={workspaceConnectionStateById}
              newTaskDisabled={false}
              importingWorkspaceConfig={false}
              onActivateWorkspace={(workspaceId) => {
                setActiveWorkspaceId(workspaceId);
                return true;
              }}
              onOpenSession={(workspaceId, sessionId) => {
                setActiveWorkspaceId(workspaceId);
                setSelectedSessionId(sessionId);
              }}
              onCreateTaskInWorkspace={(workspaceId) => {
                setActiveWorkspaceId(workspaceId);
              }}
              onOpenRenameSession={() => undefined}
              onOpenDeleteSession={() => undefined}
              onOpenRenameWorkspace={() => undefined}
              onShareWorkspace={(workspaceId) => openMockShareModal(workspaceId)}
              onRevealWorkspace={() => undefined}
              onRecoverWorkspace={() => true}
              onTestWorkspaceConnection={() => true}
              onEditWorkspaceConnection={() => undefined}
              onForgetWorkspace={() => undefined}
              onOpenCreateWorkspace={() => undefined}
              onOpenCreateRemoteWorkspace={() => undefined}
              onImportWorkspaceConfig={() => undefined}
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
              <h1 class="truncate text-[15px] font-semibold text-dls-text">
                {showingSettings() ? "Settings" : selectedSessionTitle()}
              </h1>
              <span class="hidden truncate text-[13px] text-dls-secondary lg:inline">
                {activeWorkspace().displayName ?? activeWorkspace().name}
              </span>
            </div>

            <div class="flex items-center gap-1.5 text-gray-10">
              <button
                type="button"
                class="hidden items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text sm:flex"
                onClick={() => openCommandPalette()}
                title="Open command palette"
                aria-label="Open command palette"
              >
                <span>Palette</span>
                <span class="ml-1 rounded border border-dls-border px-1 text-[10px] text-gray-9">⌘K</span>
              </button>
              <button
                type="button"
                class="flex h-9 w-9 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text"
                onClick={() => setComposerToast("Story-book: search is mocked in this shell.")}
                title="Search conversation (Ctrl/Cmd+F)"
                aria-label="Search conversation"
              >
                <Search size={16} />
              </button>
              <div class="hidden h-4 w-px bg-dls-border sm:block" />
              <button
                type="button"
                class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => runMockHeaderAction("undo", "undo")}
                disabled={headerActionBusy() !== null}
                title="Undo last message"
                aria-label="Undo last message"
              >
                <Show when={headerActionBusy() === "undo"} fallback={<Undo2 size={16} />}>
                  <span class="h-4 w-4 animate-spin rounded-full border-2 border-gray-8 border-t-transparent" />
                </Show>
                <span class="hidden lg:inline">Revert</span>
              </button>
              <button
                type="button"
                class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => runMockHeaderAction("redo", "redo")}
                disabled={headerActionBusy() !== null}
                title="Redo last reverted message"
                aria-label="Redo last reverted message"
              >
                <Show when={headerActionBusy() === "redo"} fallback={<Redo2 size={16} />}>
                  <span class="h-4 w-4 animate-spin rounded-full border-2 border-gray-8 border-t-transparent" />
                </Show>
                <span class="hidden lg:inline">Redo</span>
              </button>
              <div class="hidden h-4 w-px bg-dls-border sm:block" />
            </div>
          </header>

          <div class="flex-1 min-h-0 overflow-hidden">
            <div class="h-full overflow-y-auto bg-dls-surface px-4 pt-6 pb-4 sm:px-6 lg:px-10">
              <div class="mx-auto w-full max-w-[800px]">
                <Show
                  when={showingSettings()}
                  fallback={
                    <MessageList
                      messages={messageRows()}
                      developerMode
                      showThinking={false}
                      isStreaming={false}
                      expandedStepIds={expandedStepIds()}
                      setExpandedStepIds={(updater) => setExpandedStepIds((current) => updater(current))}
                      workspaceRoot="/Users/benjaminshafii/openwork-enterprise/_repos/openwork"
                    />
                  }
                >
                  <div class="space-y-4">
                    <div class="rounded-[20px] border border-dls-border bg-dls-surface p-4 shadow-[var(--dls-card-shadow)] space-y-3">
                      <div>
                        <div class="text-sm font-medium text-dls-text">Model preferences</div>
                        <div class="text-xs text-dls-secondary mt-1">
                          This preview mirrors the default model and reasoning controls from the app picker.
                        </div>
                      </div>
                      <div class="rounded-2xl border border-dls-border bg-dls-sidebar px-4 py-3 flex items-center justify-between gap-3">
                        <div class="min-w-0">
                          <div class="text-sm text-dls-text truncate">{selectedModelLabel()}</div>
                          <div class="text-xs text-dls-secondary truncate">
                            {selectedModel().providerID}/{selectedModel().modelID}
                          </div>
                        </div>
                        <Button variant="outline" onClick={() => openModelPicker("default")}>
                          Open picker
                        </Button>
                      </div>
                      <div class="rounded-2xl border border-dls-border bg-dls-sidebar px-4 py-3">
                        <div class="text-sm text-dls-text">{selectedBehavior().title}</div>
                        <div class="mt-1 text-xs font-medium text-dls-text">{selectedBehavior().label}</div>
                        <div class="mt-1 text-xs text-dls-secondary">{selectedBehavior().description}</div>
                      </div>
                    </div>
                    <div class="rounded-[20px] border border-dls-border bg-dls-sidebar p-4 text-sm text-dls-secondary">
                      This is the real `DenSettingsPanel` from the app mounted inside story-book.
                    </div>
                    <DenSettingsPanel
                      developerMode
                      connectRemoteWorkspace={async () => true}
                    />
                  </div>
                </Show>
              </div>
            </div>
          </div>

          <Show when={!showingSettings()}>
            <Composer
              prompt={composerPrompt()}
              developerMode
              busy={false}
              isStreaming={false}
              onSend={handleSend}
              onStop={() => undefined}
              onDraftChange={handleDraftChange}
              selectedModelLabel={selectedModelLabel()}
              onModelClick={() => openModelPicker("session")}
              modelVariantLabel={`${selectedBehavior().title} · ${selectedBehavior().label}`}
              modelVariant={modelVariant()}
              onModelVariantChange={(value) => setModelVariant(value)}
              agentLabel={agentLabel()}
              selectedAgent={selectedAgent()}
              agentPickerOpen={agentPickerOpen()}
              agentPickerBusy={false}
              agentPickerError={null}
              agentOptions={[]}
              onToggleAgentPicker={() => setAgentPickerOpen((current) => !current)}
              onSelectAgent={(agent) => {
                setSelectedAgent(agent);
                setAgentPickerOpen(false);
              }}
              setAgentPickerRef={() => undefined}
              showNotionBanner={false}
              onNotionBannerClick={() => undefined}
              toast={composerToast()}
              onToast={(message) => setComposerToast(message)}
              listAgents={async () => []}
              recentFiles={workingFiles}
              searchFiles={async (query) => {
                const normalized = query.trim().toLowerCase();
                if (!normalized) return workingFiles.slice(0, 8);
                return workingFiles.filter((path) => path.toLowerCase().includes(normalized)).slice(0, 8);
              }}
              isRemoteWorkspace={activeWorkspaceId() === remoteWorkspace.id}
              isSandboxWorkspace={activeWorkspaceId() === remoteWorkspace.id}
              attachmentsEnabled
              attachmentsDisabledReason={null}
              listCommands={async () => commandOptions}
            />
          </Show>

          <StatusBar
            clientConnected
            openworkServerStatus="connected"
            developerMode
            settingsOpen={showingSettings()}
            showSettingsButton={false}
            onSendFeedback={() => undefined}
            onOpenSettings={() => {
              if (showingSettings()) {
                setRightRailNav("automations");
                return;
              }
              if (!rightSidebarExpanded()) toggleRightSidebar();
              setRightRailNav("advanced");
            }}
            onOpenMessaging={() => undefined}
            onOpenProviders={() => undefined}
            onOpenMcp={() => undefined}
            providerConnectedIds={["anthropic", "openai"]}
            mcpStatuses={mcpStatuses}
            statusLabel="Session Ready"
          />
        </main>

        <aside
          class="hidden shrink-0 md:flex"
          style={{
            width: `${rightSidebarWidth()}px`,
            "min-width": `${rightSidebarWidth()}px`,
          }}
        >
          {renderRightRail(rightSidebarExpanded())}
        </aside>
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
                  onInput={(event) => {
                    setCommandPaletteQuery(event.currentTarget.value);
                    setCommandPaletteActiveIndex(0);
                  }}
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
              <div class="text-[11px] text-dls-secondary">{commandPaletteTitle()}</div>
            </div>

            <div class="max-h-[56vh] overflow-y-auto p-2">
              <Show
                when={commandPaletteItems().length > 0}
                fallback={<div class="px-3 py-6 text-sm text-dls-secondary text-center">No matches.</div>}
              >
                <For each={commandPaletteItems()}>
                  {(item, idx) => (
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
                      onClick={() => runCommandPaletteItem(item)}
                    >
                      <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                          <div class="text-sm font-medium truncate">{item.title}</div>
                          <Show when={item.detail}>
                            <div class="text-xs text-dls-secondary mt-1 truncate">{item.detail}</div>
                          </Show>
                        </div>
                        <Show when={item.meta}>
                          <span class="text-[10px] uppercase tracking-wide text-dls-secondary shrink-0">
                            {item.meta}
                          </span>
                        </Show>
                      </div>
                    </button>
                  )}
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

      <ShareWorkspaceModal
        open={Boolean(shareWorkspaceId())}
        onClose={() => setShareWorkspaceId(null)}
        workspaceName={shareWorkspaceName()}
        workspaceDetail={shareWorkspaceDetail()}
        fields={[...mockShareFields]}
        note="This is the real share modal from the app, mounted with safe mock values for shell review."
        publisherBaseUrl="https://share.openworklabs.com"
        onShareWorkspaceProfile={publishMockWorkspaceProfile}
        shareWorkspaceProfileBusy={shareWorkspaceProfileBusy()}
        shareWorkspaceProfileUrl={shareWorkspaceProfileUrl()}
        shareWorkspaceProfileError={null}
        shareWorkspaceProfileDisabledReason={null}
        onShareSkillsSet={publishMockSkillsSet}
        onOpenSingleSkillShare={() => setComposerToast("Story-book: single skill share is mocked in this shell.")}
        shareSkillsSetBusy={shareSkillsSetBusy()}
        shareSkillsSetUrl={shareSkillsSetUrl()}
        shareSkillsSetError={null}
        shareSkillsSetDisabledReason={null}
        onExportConfig={() => setComposerToast("Story-book: export config is mocked in this shell.")}
        exportDisabledReason={null}
        onOpenBots={() => setComposerToast("Story-book: bots sharing flow is mocked in this shell.")}
      />

      <ModelPickerModal
        open={modelPickerOpen()}
        options={storyModelOptions()}
        filteredOptions={filteredStoryModelOptions()}
        query={modelPickerQuery()}
        setQuery={setModelPickerQuery}
        target={modelPickerTarget()}
        current={selectedModel()}
        onSelect={applyStoryModelSelection}
        onBehaviorChange={(model, value) => {
          if (model.providerID !== selectedModel().providerID || model.modelID !== selectedModel().modelID) return;
          const entry = storyModels.find((item) => item.ref.providerID === model.providerID && item.ref.modelID === model.modelID);
          if (!entry) return;
          setModelVariant(sanitizeModelBehaviorValue(model.providerID, entry.model, value) ?? null);
        }}
        onOpenSettings={() => {
          setModelPickerOpen(false);
          if (!rightSidebarExpanded()) toggleRightSidebar();
          setRightRailNav("advanced");
        }}
        onClose={() => setModelPickerOpen(false)}
      />
    </div>
  );
}
