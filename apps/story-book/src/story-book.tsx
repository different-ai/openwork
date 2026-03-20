import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { Component, JSX } from "solid-js";
import "@radix-ui/colors/gray.css";
import "@radix-ui/colors/gray-alpha.css";
import "@radix-ui/colors/blue.css";
import "@radix-ui/colors/blue-alpha.css";
import "@radix-ui/colors/orange.css";
import "@radix-ui/colors/orange-alpha.css";
import "@radix-ui/colors/red.css";
import "@radix-ui/colors/red-alpha.css";
import {
  Box,
  ChevronLeft,
  ChevronRight,
  Command,
  History,
  Layers3,
  MessageCircle,
  Moon,
  Search,
  SlidersHorizontal,
  Sun,
  Zap,
} from "lucide-solid";

import Button from "../../app/src/app/components/button";
import DenSettingsPanel from "../../app/src/app/components/den-settings-panel";
import OpenWorkLogo from "../../app/src/app/components/openwork-logo";
import StatusBar from "../../app/src/app/components/status-bar";
import ArtifactsPanel from "../../app/src/app/components/session/artifacts-panel";
import Composer from "../../app/src/app/components/session/composer";
import InboxPanel from "../../app/src/app/components/session/inbox-panel";
import MessageList from "../../app/src/app/components/session/message-list";
import WorkspaceSessionList from "../../app/src/app/components/session/workspace-session-list";
import { createWorkspaceShellLayout } from "../../app/src/app/lib/workspace-shell-layout";
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
  SlashCommandOption,
  WorkspaceConnectionState,
  WorkspaceSessionGroup,
} from "../../app/src/app/types";
import { sessionMessages, storyWorkspaces } from "./mock-data";

type RightRailNav = "automations" | "skills" | "extensions" | "messaging" | "advanced";

const themeModes: ThemeMode[] = ["system", "light", "dark"];

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

const artifactFiles = [
  "apps/story-book/pr/mock-shell-wireframe.md",
  "apps/story-book/pr/right-rail-context.png",
  "apps/story-book/pr/status-bar-provider-state.png",
  "apps/story-book/pr/session-layout-notes.md",
];

const commandOptions: SlashCommandOption[] = [
  { id: "design-review", name: "design-review", description: "Open a design review pass", source: "command" },
  { id: "test-flow", name: "test-flow", description: "Run shell flow checks", source: "skill" },
];

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

function initialStoryMessages(): MessageWithParts[] {
  return sessionMessages.map((message, index) => {
    const header = `${message.title}${message.detail ? ` - ${message.detail}` : ""}`;
    const body = [header, ...message.body].filter(Boolean).join("\n\n");
    return toMessageParts(`sb-msg-${index + 1}`, message.role, body);
  });
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
  const [themeMode, setThemeMode] = createSignal<ThemeMode>(getInitialThemeMode());
  const [composerPrompt, setComposerPrompt] = createSignal(
    "Use this mock shell to design layout changes before touching the live session runtime.",
  );
  const [composerToast, setComposerToast] = createSignal<string | null>(null);
  const [selectedAgent, setSelectedAgent] = createSignal<string | null>(null);
  const [agentPickerOpen, setAgentPickerOpen] = createSignal(false);
  const [messageRows, setMessageRows] = createSignal<MessageWithParts[]>(initialStoryMessages());
  const [expandedStepIds, setExpandedStepIds] = createSignal(new Set<string>());

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

  const agentLabel = createMemo(() => (selectedAgent() ? `@${selectedAgent()}` : "Auto"));

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

        <Show when={expanded}>
          <div class="rounded-[20px] border border-dls-border bg-dls-surface p-3 shadow-[var(--dls-card-shadow)]">
            <ArtifactsPanel
              id="sidebar-artifacts"
              files={artifactFiles}
              workspaceRoot="/Users/benjaminshafii/openwork-enterprise/_repos/openwork"
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
              onShareWorkspace={() => undefined}
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
              <OpenWorkLogo size={18} />
              <span class="shrink-0 rounded-md bg-dls-hover px-2 py-1 text-[11px] font-medium text-dls-secondary">
                Workspace
              </span>
              <h1 class="truncate text-[15px] font-semibold text-dls-text">
                {showingSettings() ? "Settings" : selectedSessionTitle()}
              </h1>
            </div>

            <div class="flex items-center gap-1.5 text-gray-10">
              <button
                type="button"
                class="flex h-9 w-9 items-center justify-center rounded-md transition-colors hover:bg-gray-2/70 hover:text-dls-text"
                title="Search conversation"
                aria-label="Search conversation"
              >
                <Search size={16} />
              </button>
              <button
                type="button"
                class="hidden h-9 w-9 items-center justify-center rounded-md transition-colors hover:bg-gray-2/70 hover:text-dls-text sm:flex"
                title="Command palette"
                aria-label="Command palette"
              >
                <Command size={16} />
              </button>
              <div class="hidden items-center gap-1 sm:flex">
                <For each={themeModes}>
                  {(mode) => (
                    <button
                      type="button"
                      onClick={() => setThemeMode(mode)}
                      class={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors ${
                        themeMode() === mode
                          ? "border-dls-border bg-dls-hover text-dls-text"
                          : "border-transparent text-dls-secondary hover:bg-gray-2/70 hover:text-dls-text"
                      }`}
                    >
                      <Show
                        when={mode === "light"}
                        fallback={<Show when={mode === "dark"} fallback={<Layers3 size={12} />}><Moon size={12} /></Show>}
                      >
                        <Sun size={12} />
                      </Show>
                      <span class="capitalize">{mode}</span>
                    </button>
                  )}
                </For>
              </div>
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
              selectedModelLabel="Claude Sonnet 4"
              onModelClick={() => undefined}
              modelVariantLabel="Reasoning"
              modelVariant="medium"
              onModelVariantChange={() => undefined}
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
            settingsOpen={false}
            onSendFeedback={() => undefined}
            onOpenSettings={() => undefined}
            onOpenMessaging={() => undefined}
            onOpenProviders={() => undefined}
            onOpenMcp={() => undefined}
            providerConnectedIds={["anthropic", "openai"]}
            mcpStatuses={mcpStatuses}
            statusLabel="Session Ready"
            statusDetail="Story shell mode · app components mounted with mock data"
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
    </div>
  );
}
