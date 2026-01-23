import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { Agent, Part, Provider } from "@opencode-ai/sdk/v2/client";
import type {
  ArtifactItem,
  DashboardTab,
  MessageGroup,
  MessageWithParts,
  PendingPermission,
  TodoItem,
  View,
  WorkspaceDisplay,
} from "../types";

import {
  AlertTriangle,
  ArrowRight,
  HardDrive,
  Shield,
  Zap,
} from "lucide-solid";

import Button from "../components/button";
import RenameSessionModal from "../components/rename-session-modal";
import WorkspaceChip from "../components/workspace-chip";
import ProviderAuthModal from "../components/provider-auth-modal";
import { isTauriRuntime, isWindowsPlatform } from "../utils";

import MessageList from "../components/session/message-list";
import Composer, { type CommandItem } from "../components/session/composer";
import SessionSidebar, { type SidebarSectionState } from "../components/session/sidebar";
import Minimap from "../components/session/minimap";
import FlyoutItem from "../components/flyout-item";

export type SessionViewProps = {
  selectedSessionId: string | null;
  setView: (view: View) => void;
  setTab: (tab: DashboardTab) => void;
  activeWorkspaceDisplay: WorkspaceDisplay;
  setWorkspaceSearch: (value: string) => void;
  setWorkspacePickerOpen: (open: boolean) => void;
  headerStatus: string;
  busyHint: string | null;
  createSessionAndOpen: () => void;
  sendPromptAsync: () => Promise<void>;
  newTaskDisabled: boolean;
  sessions: Array<{ id: string; title: string; slug?: string | null }>;
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
  busy: boolean;
  prompt: string;
  setPrompt: (value: string) => void;
  sendPrompt: () => Promise<void>;
  selectedSessionModelLabel: string;
  openSessionModelPicker: () => void;
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
  openProviderAuthModal: () => Promise<void>;
  closeProviderAuthModal: () => void;
  providerAuthModalOpen: boolean;
  providerAuthBusy: boolean;
  providerAuthError: string | null;
  providerAuthMethods: Record<string, { type: "oauth" | "api"; label: string }[]>;
  providers: Provider[];
  providerConnectedIds: string[];
  listAgents: () => Promise<Agent[]>;
  setSessionAgent: (sessionId: string, agent: string | null) => void;
  saveSession: (sessionId: string) => Promise<string>;
  sessionStatusById: Record<string, string>;
};

export default function SessionView(props: SessionViewProps) {
  let messagesEndEl: HTMLDivElement | undefined;
  let chatContainerEl: HTMLDivElement | undefined;

  const [artifactToast, setArtifactToast] = createSignal<string | null>(null);
  const [commandToast, setCommandToast] = createSignal<string | null>(null);
  const [providerAuthActionBusy, setProviderAuthActionBusy] = createSignal(false);
  const [renameModalOpen, setRenameModalOpen] = createSignal(false);
  const [renameTitle, setRenameTitle] = createSignal("");
  const [renameBusy, setRenameBusy] = createSignal(false);

  type Flyout = {
    id: string;
    rect: { top: number; left: number; width: number; height: number };
    targetRect: { top: number; left: number; width: number; height: number };
    label: string;
    icon: "file" | "check" | "folder";
  };
  const [flyouts, setFlyouts] = createSignal<Flyout[]>([]);
  const [prevTodoCount, setPrevTodoCount] = createSignal(0);
  const [prevArtifactCount, setPrevArtifactCount] = createSignal(0);
  const [prevFileCount, setPrevFileCount] = createSignal(0);
  const [isInitialLoad, setIsInitialLoad] = createSignal(true);
  const [runStartedAt, setRunStartedAt] = createSignal<number | null>(null);
  const [runHasBegun, setRunHasBegun] = createSignal(false);
  const [runTick, setRunTick] = createSignal(Date.now());
  const [runBaseline, setRunBaseline] = createSignal<{ assistantId: string | null; partCount: number }>({
    assistantId: null,
    partCount: 0,
  });
  
  const pendingArtifactRafIds = new Set<number>();

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

  const runDetail = createMemo(() => {
    if (props.error) return props.error;
    const status = props.sessionStatus;
    if (runPhase() === "responding") return "Streaming response";
    if (status === "retry") return "Retrying the last step";
    if (status === "running") return "Working on your request";
    if (status === "idle" && runStartedAt()) return "Queued";
    return "";
  });

  const runLine = createMemo(() => {
    const label = runLabel();
    const detail = runDetail();
    if (!detail) return label;
    return `${label} · ${detail}`;
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
    props.messages.length;
    props.todos.length;
    messagesEndEl?.scrollIntoView({ behavior: "smooth" });
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
    const artifacts = props.artifacts;
    const count = artifacts.length;
    const prev = prevArtifactCount();
    if (count > prev && prev > 0) {
      const last = artifacts[artifacts.length - 1];
      const scheduleAttempt = (attempts: number) => {
        const rafId = requestAnimationFrame(() => {
          pendingArtifactRafIds.delete(rafId);
          const card = document.querySelector(`[data-artifact-id="${last.id}"]`);
          if (card) {
            triggerFlyout(card, "sidebar-artifacts", last.name, "file");
            return;
          }
          if (attempts > 0) {
            scheduleAttempt(attempts - 1);
          }
        });
        pendingArtifactRafIds.add(rafId);
      };
      scheduleAttempt(3);
    }
    setPrevArtifactCount(count);
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
    if (!artifactToast()) return;
    const id = window.setTimeout(() => setArtifactToast(null), 3000);
    return () => window.clearTimeout(id);
  });

  createEffect(() => {
    if (!commandToast()) return;
    const id = window.setTimeout(() => setCommandToast(null), 2400);
    return () => window.clearTimeout(id);
  });

  const artifactActionToast = () => (isWindowsPlatform() ? "Opened in default app." : "Revealed in file manager.");

  const resolveArtifactPath = (artifact: ArtifactItem) => {
    const rawPath = artifact.path?.trim();
    if (!rawPath) return null;
    if (/^(?:[a-zA-Z]:[\\/]|~[\\/]|\/)/.test(rawPath)) {
      return rawPath;
    }

    const root = props.activeWorkspaceDisplay.path?.trim();
    if (!root) return rawPath;

    const separator = root.includes("\\") ? "\\" : "/";
    const trimmedRoot = root.replace(/[\\/]+$/, "");
    const trimmedPath = rawPath.replace(/^[\\/]+/, "");
    return `${trimmedRoot}${separator}${trimmedPath}`;
  };

  const handleOpenArtifact = async (artifact: ArtifactItem) => {
    const resolvedPath = resolveArtifactPath(artifact);
    if (!resolvedPath) {
      setArtifactToast("Artifact path missing.");
      return;
    }

    if (!isTauriRuntime()) {
      setArtifactToast("Open is only available in the desktop app.");
      return;
    }

    try {
      const { openPath, revealItemInDir } = await import("@tauri-apps/plugin-opener");
      if (isWindowsPlatform()) {
        await openPath(resolvedPath);
      } else {
        await revealItemInDir(resolvedPath);
      }
      setArtifactToast(artifactActionToast());
    } catch (error) {
      setArtifactToast(error instanceof Error ? error.message : "Could not open artifact.");
    }
  };

  const selectedSessionTitle = createMemo(() => {
    const id = props.selectedSessionId;
    if (!id) return "";
    return props.sessions.find((session) => session.id === id)?.title ?? "";
  });

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

  const commandList = createMemo(() => [
    {
      id: "models",
      description: "Choose a model",
      run: () => {
        props.openSessionModelPicker();
        clearPrompt();
      },
    },
    {
      id: "connect",
      description: "Connect a provider",
      run: async () => {
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
      id: "new",
      description: "Start a new task",
      run: () => {
        props.createSessionAndOpen();
        clearPrompt();
      },
    },
    {
      id: "agent",
      description: "Choose an agent",
      run: async () => {
        const sessionId = requireSessionId();
        if (!sessionId) return;

        try {
          const rawArg = extractCommandArgs(props.prompt);
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
          setCommandToast(`Agent set to ${match.name}`);
          clearPrompt();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Agent selection failed";
          setCommandToast(message);
        }
      },
    },
    {
      id: "export",
      description: "Export session JSON",
      run: async () => {
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
      id: "rename",
      description: "Rename this session",
      run: () => {
        openRenameModal();
        clearPrompt();
      },
    },
    {
      id: "help",
      description: "Show available commands",
      run: () => {
        setCommandToast("Commands: /models, /connect, /new, /agent, /export, /rename, /help");
        clearPrompt();
      },
    },
  ]);

  const commandMatches = createMemo(() => {
    const value = props.prompt;
    if (!value.startsWith("/")) return [];
    const token = value.slice(1).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    const list = commandList();
    if (!token) return list;
    return list.filter((command) => command.id.startsWith(token));
  });

  const handleRunCommand = (commandId: string) => {
     const command = commandList().find(c => c.id === commandId);
     if (command) {
       command.run();
     }
  };

  const handleSendPrompt = () => {
    startRun();
    props.sendPromptAsync().catch(() => undefined);
  };

  return (
    <Show
      when={props.selectedSessionId}
      fallback={
        <div class="min-h-screen flex items-center justify-center bg-gray-1 text-gray-12 p-6">
          <div class="text-center space-y-4">
            <div class="text-lg font-medium">No session selected</div>
            <Button
              onClick={() => {
                props.setView("dashboard");
                props.setTab("sessions");
              }}
            >
              Back to dashboard
            </Button>
          </div>
        </div>
      }
    >
      <div class="h-screen flex flex-col bg-gray-1 text-gray-12 relative">
        <header class="h-16 border-b border-gray-6 flex items-center justify-between px-6 bg-gray-1/80 backdrop-blur-md z-10 sticky top-0">
          <div class="flex items-center gap-3">
            <Button
              variant="ghost"
              class="!p-2 rounded-full"
              onClick={() => {
                props.setView("dashboard");
                props.setTab("sessions");
              }}
            >
              <ArrowRight class="rotate-180 w-5 h-5" />
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
               artifacts={props.artifacts}
               activePlugins={props.activePlugins}
               activePluginStatus={props.activePluginStatus}
               authorizedDirs={props.authorizedDirs}
               workingFiles={props.workingFiles}
               expandedSections={props.expandedSidebarSections}
               onToggleSection={(section) => {
                 props.setExpandedSidebarSections((curr) => ({...curr, [section]: !curr[section]}));
               }}
               onOpenArtifact={handleOpenArtifact}
               sessions={props.sessions}
               selectedSessionId={props.selectedSessionId}
               onSelectSession={async (id) => {
                 await props.selectSession(id);
                 props.setView("session");
                 props.setTab("sessions");
               }}
               sessionStatusById={props.sessionStatusById}
               onCreateSession={props.createSessionAndOpen}
               newTaskDisabled={props.newTaskDisabled}
             />
          </aside>

          <div
            class="flex-1 overflow-y-auto pt-6 md:pt-10 scroll-smooth relative no-scrollbar"
            ref={(el) => (chatContainerEl = el)}
          >
            <style>
              {`
                .no-scrollbar::-webkit-scrollbar {
                  display: none;
                }
                .no-scrollbar {
                  -ms-overflow-style: none;
                  scrollbar-width: none;
                }
              `}
            </style>
            
            <Show when={props.messages.length === 0}>
              <div class="text-center py-20 space-y-4">
                <div class="w-16 h-16 bg-gray-2 rounded-3xl mx-auto flex items-center justify-center border border-gray-6">
                  <Zap class="text-gray-7" />
                </div>
                <h3 class="text-xl font-medium">Ready to work</h3>
                <p class="text-gray-10 text-sm max-w-xs mx-auto">
                  Describe a task. I'll show progress and ask for permissions when needed.
                </p>
              </div>
            </Show>

            <MessageList 
              messages={props.messages}
              artifacts={props.artifacts}
              developerMode={props.developerMode}
              showThinking={props.showThinking}
              expandedStepIds={props.expandedStepIds}
              setExpandedStepIds={props.setExpandedStepIds}
              onOpenArtifact={handleOpenArtifact}
              footer={
                showRunIndicator() ? (
                  <div class="flex justify-start pl-2">
                    <div
                      class={`w-full max-w-[68ch] flex items-center justify-between gap-3 text-xs font-mono ${
                        runPhase() === "error" ? "text-red-11" : "text-gray-9"
                      }`}
                      role="status"
                      aria-live="polite"
                    >
                      <div class="flex items-center gap-2 min-w-0">
                        <Show
                          when={runPhase() !== "error"}
                          fallback={<AlertTriangle size={12} class="shrink-0" />}
                        >
                          <Zap size={12} class="shrink-0" />
                        </Show>
                        <span class="truncate">{runLine()}</span>
                      </div>
                      <span class="shrink-0">{runElapsedLabel()}</span>
                    </div>
                  </div>
                ) : undefined
              }
            />

            <div ref={(el) => (messagesEndEl = el)} />
          </div>
          
          <Minimap containerRef={() => chatContainerEl} messages={props.messages} />

          <Show when={artifactToast()}>
            <div class="fixed bottom-24 right-8 z-30 rounded-xl bg-gray-2 border border-gray-6 px-4 py-2 text-xs text-gray-11 shadow-lg">
              {artifactToast()}
            </div>
          </Show>
        </div>

        <Composer 
           prompt={props.prompt}
           setPrompt={props.setPrompt}
           busy={props.busy}
           onSend={handleSendPrompt}
           commandMatches={commandMatches()}
           onRunCommand={handleRunCommand}
           selectedModelLabel={props.selectedSessionModelLabel || "Model"}
           onModelClick={props.openSessionModelPicker}
           showNotionBanner={props.showTryNotionPrompt}
           onNotionBannerClick={props.onTryNotionPrompt}
           toast={commandToast()}
        />

        <ProviderAuthModal
          open={props.providerAuthModalOpen}
          loading={props.providerAuthBusy}
          submitting={providerAuthActionBusy()}
          error={props.providerAuthError}
          providers={props.providers}
          connectedProviderIds={props.providerConnectedIds}
          authMethods={props.providerAuthMethods}
          onSelect={handleProviderAuthSelect}
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
    </Show>
  );
}
