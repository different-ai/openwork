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
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  Circle,
  Copy,
  File,
  FileText,
  Folder,
  HardDrive,
  Plus,
  Shield,
  Zap,
} from "lucide-solid";

import Button from "../components/button";
import PartView from "../components/part-view";
import RenameSessionModal from "../components/rename-session-modal";
import WorkspaceChip from "../components/workspace-chip";
import ProviderAuthModal from "../components/provider-auth-modal";
import { isTauriRuntime, isWindowsPlatform } from "../utils";

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
  expandedSidebarSections: { progress: boolean; artifacts: boolean; context: boolean };
  setExpandedSidebarSections: (
    updater: (current: { progress: boolean; artifacts: boolean; context: boolean }) => {
      progress: boolean;
      artifacts: boolean;
      context: boolean;
    },
  ) => { progress: boolean; artifacts: boolean; context: boolean };
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

function FlyoutItem(props: {
  item: {
    id: string;
    rect: { top: number; left: number; width: number; height: number };
    targetRect: { top: number; left: number; width: number; height: number };
    label: string;
    icon: "file" | "check" | "folder";
  };
}) {
  const [active, setActive] = createSignal(false);
  onMount(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setActive(true);
      });
    });
  });

  return (
    <div
      class="fixed z-[100] pointer-events-none transition-all duration-1000 ease-[cubic-bezier(0.16,1,0.3,1)] flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-12 text-gray-1 shadow-xl border border-gray-11/20"
      style={{
        top: `${props.item.rect.top}px`,
        left: `${props.item.rect.left}px`,
        transform: active()
          ? `translate(${props.item.targetRect.left - props.item.rect.left}px, ${
              props.item.targetRect.top - props.item.rect.top
            }px) scale(0.3)`
          : "translate(0, 0) scale(1)",
        opacity: active() ? 0 : 1,
      }}
    >
      <Show when={props.item.icon === "check"}>
        <Check size={14} />
      </Show>
      <Show when={props.item.icon === "file"}>
        <FileText size={14} />
      </Show>
      <Show when={props.item.icon === "folder"}>
        <Folder size={14} />
      </Show>
      <span class="text-xs font-medium truncate max-w-[120px]">{props.item.label}</span>
    </div>
  );
}

export default function SessionView(props: SessionViewProps) {
  let messagesEndEl: HTMLDivElement | undefined;

  createEffect(() => {
    props.messages.length;
    props.todos.length;
    showAnticipatoryCursor();
    messagesEndEl?.scrollIntoView({ behavior: "smooth" });
  });

  const realTodos = createMemo(() => props.todos.filter((todo) => todo.content.trim()));

  const progressDots = createMemo(() => {
    const activeTodos = realTodos();
    const total = activeTodos.length;
    if (!total) return [] as boolean[];
    const completed = activeTodos.filter((todo) => todo.status === "completed").length;
    return Array.from({ length: total }, (_, idx) => idx < completed);
  });

  const [artifactToast, setArtifactToast] = createSignal<string | null>(null);
  const [commandToast, setCommandToast] = createSignal<string | null>(null);
  const [commandIndex, setCommandIndex] = createSignal(0);
  const [providerAuthActionBusy, setProviderAuthActionBusy] = createSignal(false);
  const [renameModalOpen, setRenameModalOpen] = createSignal(false);
  const [renameTitle, setRenameTitle] = createSignal("");
  const [renameBusy, setRenameBusy] = createSignal(false);
  const [copyingId, setCopyingId] = createSignal<string | null>(null);

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
  const [messageLines, setMessageLines] = createSignal<{ id: string; role: "user" | "assistant"; top: number; height: number }[]>([]);
  const [activeMessageId, setActiveMessageId] = createSignal<string | null>(null);

  let copyTimeout: number | undefined;
  let messageLinesRafId: number | null = null;
  const pendingArtifactRafIds = new Set<number>();

  onMount(() => {
    setTimeout(() => setIsInitialLoad(false), 2000);
    window.addEventListener("resize", handleResize);
  });

  onCleanup(() => {
    window.removeEventListener("resize", handleResize);
    if (copyTimeout !== undefined) {
      window.clearTimeout(copyTimeout);
    }
    if (messageLinesRafId !== null) {
      cancelAnimationFrame(messageLinesRafId);
    }
    pendingArtifactRafIds.forEach((id) => cancelAnimationFrame(id));
    pendingArtifactRafIds.clear();
  });

  const updateMessageLines = () => {
    if (!chatContainerEl) return;
    const containerRect = chatContainerEl.getBoundingClientRect();
    const scrollTop = chatContainerEl.scrollTop;
    
    // Find all message groups (bubbles)
    const elements = Array.from(chatContainerEl.querySelectorAll('[data-message-role]'));
    const lines = elements.map(el => {
      const rect = el.getBoundingClientRect();
      // Calculate relative top position inside the scrollable area
      // This maps the message vertical position to the container height proportionally? 
      // Actually for a scrollbar-like map, we need ratio:
      
      const relativeTop = rect.top - containerRect.top + scrollTop;
      const scrollHeight = chatContainerEl!.scrollHeight;
      const clientHeight = chatContainerEl!.clientHeight;
      
      // Map content position (0 to scrollHeight) to viewport position (0 to clientHeight)
      // position = (relativeTop / scrollHeight) * clientHeight
      // But we want it fixed? No, "minimap" style usually maps entire scrollHeight to viewport height.
      
      const mapTop = (relativeTop / scrollHeight) * clientHeight;
      // Fixed height for all lines as requested
      const mapHeight = 2; 

      return {
        id: el.getAttribute('data-message-id') || "",
        role: el.getAttribute('data-message-role') as "user" | "assistant",
        top: mapTop,
        height: mapHeight
      };
    });
    
    setMessageLines(lines);

    // Update active message based on center
    const center = containerRect.top + containerRect.height / 2;
    let closestId = null;
    let minDist = Infinity;
    
    elements.forEach(el => {
      const rect = el.getBoundingClientRect();
      const dist = Math.abs((rect.top + rect.height / 2) - center);
      if (dist < minDist) {
        minDist = dist;
        closestId = el.getAttribute('data-message-id');
      }
    });
    setActiveMessageId(closestId);
  };

  const scheduleMessageLinesUpdate = () => {
    if (messageLinesRafId !== null) {
      cancelAnimationFrame(messageLinesRafId);
    }
    messageLinesRafId = requestAnimationFrame(() => {
      updateMessageLines();
      messageLinesRafId = null;
    });
  };

  const handleScroll = () => {
    scheduleMessageLinesUpdate();
  };

  const handleResize = () => {
    scheduleMessageLinesUpdate();
  };

  createEffect(() => {
    props.messages.length;
    scheduleMessageLinesUpdate();
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
    const todos = realTodos();
    const count = todos.length;
    const prev = prevTodoCount();
    if (count > prev && prev > 0) {
      // New todo added
      // Source: Try to find the last message or just center screen?
      // Ideally we find the text part that generated it, but that's hard.
      // We'll fallback to the chat input or last message.
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
        // Source: Last message
        const lastMsg = chatContainerEl?.querySelector('[data-message-role="assistant"]:last-child');
        triggerFlyout(lastMsg ?? null, "sidebar-context", "File Modified", "folder");
     }
     setPrevFileCount(count);
  });

  let promptInputEl: HTMLTextAreaElement | undefined;
  let chatContainerEl: HTMLDivElement | undefined;

  const handleCopy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyingId(id);
      if (copyTimeout !== undefined) {
        window.clearTimeout(copyTimeout);
      }
      copyTimeout = window.setTimeout(() => {
        setCopyingId(null);
        copyTimeout = undefined;
      }, 2000);
      setCommandToast("Copied to clipboard");
    } catch {
      setCommandToast("Failed to copy");
    }
  };

  const jumpToRole = (direction: "up" | "down", targetRole: "user" | "assistant") => {
    if (!chatContainerEl) return;
    
    const messages = Array.from(chatContainerEl.querySelectorAll(`[data-message-role="${targetRole}"]`));
    if (!messages.length) return;

    const containerRect = chatContainerEl.getBoundingClientRect();
    const currentScroll = chatContainerEl.scrollTop;
    
    // Find current visible message or closest one
    // We want the one that is strictly below top edge for "down" or strictly above for "up"
    // Or simpler: find all relative positions
    
    const candidates = messages.map(el => {
      const rect = el.getBoundingClientRect();
      // Relative to container top
      const top = rect.top - containerRect.top + currentScroll;
      return { el, top };
    }).sort((a, b) => a.top - b.top);

    const threshold = currentScroll + (direction === "down" ? 10 : -10);

    let target;
    if (direction === "down") {
      target = candidates.find(c => c.top > threshold);
    } else {
      target = candidates.reverse().find(c => c.top < threshold);
    }

    if (target) {
      target.el.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (direction === "down" && candidates.length) {
       // If no next one, maybe wrap or just stay? Let's stay.
    } else if (direction === "up" && candidates.length) {
       // If no prev one, go to first?
       candidates[candidates.length - 1].el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  const focusPromptInput = () => {
    if (props.busy) return;
    const el = promptInputEl;
    if (!el) return;
    el.focus();
    try {
      const len = el.value.length;
      el.setSelectionRange(len, len);
    } catch {
      // ignore
    }
  };

  createEffect(() => {
    const handler = () => {
      focusPromptInput();
    };

    window.addEventListener("openwork:focusPrompt", handler);
    onCleanup(() => window.removeEventListener("openwork:focusPrompt", handler));
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

  const maxPromptHeight = 160;

  const syncPromptHeight = () => {
    if (!promptInputEl) return;
    promptInputEl.style.height = "auto";
    const nextHeight = Math.min(promptInputEl.scrollHeight, maxPromptHeight);
    promptInputEl.style.height = `${nextHeight}px`;
    promptInputEl.style.overflowY =
      promptInputEl.scrollHeight > maxPromptHeight ? "auto" : "hidden";
  };

  const artifactActionLabel = () => (isWindowsPlatform() ? "Open" : "Reveal");

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


  const humanizePlugin = (name: string) => {
    const cleaned = name
      .replace(/^@[^/]+\//, "")
      .replace(/[-_]+/g, " ")
      .replace(/\b(opencode|plugin)\b/gi, "")
      .trim();
    return cleaned
      .split(" ")
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
      .trim();
  };

  const toggleSteps = (id: string) => {
    props.setExpandedStepIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSidebar = (key: "progress" | "artifacts" | "context") => {
    props.setExpandedSidebarSections((current) => ({ ...current, [key]: !current[key] }));
  };

  const artifactsByMessage = createMemo(() => {
    const map = new Map<string, ArtifactItem[]>();
    for (const artifact of props.artifacts) {
      const key = artifact.messageId?.trim();
      if (!key) continue;
      const current = map.get(key);
      if (current) {
        current.push(artifact);
      } else {
        map.set(key, [artifact]);
      }
    }
    return map;
  });

  const unlinkedArtifacts = createMemo(() => props.artifacts.filter((artifact) => !artifact.messageId));


  const modelLabelParts = createMemo(() => {
    const label = props.selectedSessionModelLabel || "Model";
    const [provider, model] = label.split(" · ");
    return {
      provider: provider?.trim() || label,
      model: model?.trim() || "Ready",
    };
  });

  const isModelUnknown = createMemo(() =>
    ["model", "unknown", "default"].includes((props.selectedSessionModelLabel || "").trim().toLowerCase()),
  );

  const modelUnavailableDetail = createMemo(() => {
    if (props.selectedSessionModelLabel) return null;
    return "Connect a provider to customize this.";
  });

  const isAssistantMessage = (msg: MessageWithParts) => (msg.info as any).role === "assistant";
  const isUserMessage = (msg: MessageWithParts) => (msg.info as any).role === "user";

  const lastUserMessageId = createMemo(() => {
    const list = props.messages;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const msg = list[i];
      if (msg && isUserMessage(msg)) return String((msg.info as any).id ?? "");
    }
    return "";
  });

  const hasAssistantTextAfterLastUser = createMemo(() => {
    const pivot = lastUserMessageId();
    if (!pivot) return false;
    const list = props.messages;
    const pivotIndex = list.findIndex((msg) => String((msg.info as any).id ?? "") === pivot);
    if (pivotIndex < 0) return false;
    for (let i = pivotIndex + 1; i < list.length; i += 1) {
      const msg = list[i];
      if (!msg || !isAssistantMessage(msg)) continue;
      if (msg.parts.some((part) => part.type === "text" && part.text?.trim())) {
        return true;
      }
    }
    return false;
  });

  const showAnticipatoryCursor = createMemo(() => {
    if (props.busyLabel !== "Running" && props.sessionStatus !== "running") return false;
    return !hasAssistantTextAfterLastUser();
  });

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

  const clearPrompt = () => {
    props.setPrompt("");
    queueMicrotask(syncPromptHeight);
  };

  const extractCommandArgs = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("/")) return "";
    const body = trimmed.slice(1).trim();
    const spaceIndex = body.indexOf(" ");
    if (spaceIndex === -1) return "";
    return body.slice(spaceIndex + 1).trim();
  };

  const extractCommandRemainder = (raw: string) => {
    if (!raw.startsWith("/")) return "";
    const body = raw.slice(1);
    const spaceIndex = body.search(/\s/);
    if (spaceIndex === -1) return "";
    return body.slice(spaceIndex);
  };

  const applyCommandCompletion = (commandId: string) => {
    if (!commandId) return;
    const remainder = extractCommandRemainder(props.prompt);
    const next = `/${commandId}${remainder}`;
    if (next === props.prompt) return;
    props.setPrompt(next);
    queueMicrotask(() => {
      syncPromptHeight();
      if (!promptInputEl) return;
      const length = promptInputEl.value.length;
      promptInputEl.focus();
      promptInputEl.setSelectionRange(length, length);
    });
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
      label: "Models",
      description: "Choose a model",
      run: () => {
        props.openSessionModelPicker();
        clearPrompt();
      },
    },
    {
      id: "connect",
      label: "Connect",
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
      label: "New",
      description: "Start a new task",
      run: () => {
        props.createSessionAndOpen();
        clearPrompt();
      },
    },
    {
      id: "agent",
      label: "Agent",
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
      label: "Export",
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
      label: "Rename",
      description: "Rename this session",
      run: () => {
        openRenameModal();
        clearPrompt();
      },
    },
    {
      id: "help",
      label: "Help",
      description: "Show available commands",
      run: () => {
        setCommandToast("Commands: /models, /connect, /new, /agent, /export, /rename, /help");
        clearPrompt();
      },
    },
  ]);

  const commandInput = createMemo(() => {
    const value = props.prompt;
    if (!value.startsWith("/")) return null;
    return value.slice(1);
  });

  const commandToken = createMemo(() => {
    const value = commandInput();
    if (value == null) return null;
    const token = value.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    return token;
  });

  const commandMatches = createMemo(() => {
    const token = commandToken();
    if (token == null) return [];
    const list = commandList();
    if (!token) return list;
    return list.filter((command) => command.id.startsWith(token));
  });

  const commandMenuOpen = createMemo(() => commandInput() !== null && !props.busy);

  createEffect(() => {
    if (!commandMenuOpen()) return;
    queueMicrotask(focusPromptInput);
  });

  const moveCommandIndex = (delta: number) => {
    const matches = commandMatches();
    if (!matches.length) return;
    setCommandIndex((current) => {
      const next = current + delta;
      if (next < 0) return 0;
      if (next >= matches.length) return matches.length - 1;
      return next;
    });
  };


  createEffect(() => {
    const matches = commandMatches();
    if (!matches.length) {
      setCommandIndex(0);
      return;
    }
    setCommandIndex((current) => Math.min(current, matches.length - 1));
  });

  createEffect(() => {
    props.prompt;
    syncPromptHeight();
  });

  const runCommand = (commandId?: string) => {
    if (!commandId) {
      setCommandToast("Unknown command");
      return null;
    }
    const command = commandList().find((entry) => entry.id === commandId);
    if (!command) {
      setCommandToast("Unknown command");
      return null;
    }
    return command.run();
  };

  const selectCommand = (commandId?: string) => {
    if (!commandId) {
      setCommandToast("Unknown command");
      return;
    }
    applyCommandCompletion(commandId);
    const result = runCommand(commandId);
    if (result === null) return;
    Promise.resolve(result).finally(() => {
      clearPrompt();
    });
  };

  const handlePrimaryAction = () => {
    if (commandMenuOpen()) {
      const matches = commandMatches();
      const active = matches[commandIndex()] ?? matches[0];
      selectCommand(active?.id);
      return;
    }
    props.sendPromptAsync().catch(() => undefined);
  };

  const handlePromptKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && event.shiftKey) return;
    if (event.isComposing && event.key !== "Enter") return;

    const menuOpen = commandMenuOpen();
    if (menuOpen) {
      const matches = commandMatches();
      if (event.key === "Enter") {
        event.preventDefault();
        handlePrimaryAction();
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (!matches.length) return;
        moveCommandIndex(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (!matches.length) return;
        moveCommandIndex(-1);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        clearPrompt();
      }
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      handlePrimaryAction();
    }
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
            <div class="px-4 pt-4">
              <button
                class="w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-12 text-gray-1 text-sm font-medium shadow-lg shadow-gray-12/10"
                onClick={props.createSessionAndOpen}
                disabled={props.newTaskDisabled}
              >
                <Plus size={16} />
                New task
              </button>
            </div>

            <div class="flex-1 overflow-y-auto px-4 py-4">
              <div class="text-xs text-gray-10 uppercase tracking-wide mb-3">Recents</div>
              <div class="space-y-2">
                <For each={props.sessions.slice(0, 8)}>
                  {(session) => (
                    <button
                      class={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                        session.id === props.selectedSessionId
                          ? "bg-gray-2 text-gray-12"
                          : "text-gray-11 hover:text-gray-12 hover:bg-gray-2/50"
                      }`}
                      onClick={async () => {
                        await props.selectSession(session.id);
                        props.setView("session");
                        props.setTab("sessions");
                      }}
                    >
                      <div class="flex items-center justify-between gap-2 w-full overflow-hidden">
                        <span class="truncate">{session.title}</span>
                        <Show when={props.sessionStatusById[session.id] && props.sessionStatusById[session.id] !== "idle"}>
                          <span class={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full border flex items-center gap-1 ${
                            props.sessionStatusById[session.id] === "running"
                              ? "border-amber-7/50 text-amber-11 bg-amber-2/50"
                              : "border-gray-7/50 text-gray-10 bg-gray-2/50"
                          }`}>
                            <div class={`w-1 h-1 rounded-full ${
                              props.sessionStatusById[session.id] === "running" ? "bg-amber-9 animate-pulse" : "bg-gray-9"
                            }`} />
                            <span class="capitalize">{props.sessionStatusById[session.id]}</span>
                          </span>
                        </Show>
                      </div>
                    </button>
                  )}
                </For>
              </div>
              <div class="mt-6 text-xs text-gray-10">
                These tasks run locally and aren't synced across devices.
              </div>
            </div>
          </aside>

          <div
            class="flex-1 overflow-y-auto p-6 md:p-10 scroll-smooth relative no-scrollbar"
            ref={(el) => (chatContainerEl = el)}
            onScroll={handleScroll}
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
            <div class="max-w-2xl mx-auto space-y-6 pb-32">
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

              <For each={props.messages}>
                {(msg) => {
                  const isUser = () => (msg.info as any).role === "user";
                  const renderableParts = () =>
                    msg.parts.filter((p) => {
                      if (p.type === "reasoning") {
                        return props.developerMode && props.showThinking;
                      }

                      if (p.type === "step-start" || p.type === "step-finish") {
                        return props.developerMode;
                      }

                      if (p.type === "text" || p.type === "tool") {
                        return true;
                      }

                      return props.developerMode;
                    });

                  const groups = () =>
                    props.groupMessageParts(renderableParts(), String((msg.info as any).id ?? "message"));
                  const groupSpacing = () => (isUser() ? "mb-3" : "mb-4");
                  const messageId = () => String((msg.info as any).id ?? "");
                  const messageArtifacts = () => artifactsByMessage().get(messageId()) ?? [];

                  return (
                    <Show when={renderableParts().length > 0}>
                      <div
                        class={`flex group ${isUser() ? "justify-end" : "justify-start"}`.trim()}
                        data-message-role={isUser() ? "user" : "assistant"}
                        data-message-id={messageId()}
                      >
                        <div
                          class={`w-full relative ${
                            isUser()
                              ? "max-w-[520px] rounded-2xl bg-gray-4 text-gray-12 shadow-sm border-gray-5 border-1 shadow-gray-12/5 p-4 text-sm leading-relaxed rounded-br-none"
                              : "max-w-[68ch] text-[15px] leading-7 text-gray-12 group"
                          }`}
                        >
                          <For each={groups()}>
                            {(group, idx) => (
                              <div class={idx() === groups().length - 1 ? "" : groupSpacing()}>
                                <Show when={group.kind === "text"}>
                                  <PartView
                                      part={(group as { kind: "text"; part: Part }).part}
                                      developerMode={props.developerMode}
                                      showThinking={props.showThinking}
                                      tone={isUser() ? "dark" : "light"}
                                      renderMarkdown={!isUser()}
                                    />
                                </Show>
                                <Show when={group.kind === "steps"}>
                                  <div class={isUser() ? "mt-2" : "mt-3 border-t border-gray-6/60 pt-3"}>
                                    <button
                                      class={`flex items-center gap-2 text-xs ${
                                        isUser() ? "text-gray-10 hover:text-gray-11" : "text-gray-10 hover:text-gray-12"
                                      }`}
                                      onClick={() => toggleSteps((group as any).id)}
                                    >
                                      <span>
                                        {props.expandedStepIds.has((group as any).id) ? "Hide steps" : "View steps"}
                                      </span>
                                      <ChevronDown
                                        size={14}
                                        class={`transition-transform ${props.expandedStepIds.has((group as any).id) ? "rotate-180" : ""}`.trim()}
                                      />
                                    </button>
                                    <Show when={props.expandedStepIds.has((group as any).id)}>
                                      <div
                                        class={`mt-3 space-y-3 rounded-xl border p-3 ${
                                          isUser()
                                            ? "border-gray-6 bg-gray-1/60"
                                            : "border-gray-6/70 bg-gray-2/40"
                                        }`}
                                      >
                                        <For each={(group as any).parts as Part[]}>
                                          {(part) => {
                                            const summary = props.summarizeStep(part);
                                            return (
                                              <div class="flex items-start gap-3 text-xs text-gray-11">
                                                <div class="mt-0.5 h-5 w-5 rounded-full border border-gray-7 flex items-center justify-center text-gray-10">
                                                  {part.type === "tool" ? <File size={12} /> : <Circle size={8} />}
                                                </div>
                                                <div>
                                                  <div class="text-gray-12">{summary.title}</div>
                                                  <Show when={summary.detail}>
                                                    <div class="mt-1 text-gray-10">{summary.detail}</div>
                                                  </Show>
                                                  <Show when={props.developerMode && (part.type !== "tool" || props.showThinking)}>
                                                    <div class="mt-2 text-xs text-gray-10">
                                                      <PartView
                                                        part={part}
                                                        developerMode={props.developerMode}
                                                        showThinking={props.showThinking}
                                                        tone={isUser() ? "dark" : "light"}
                                                      />
                                                    </div>
                                                  </Show>
                                                </div>
                                              </div>
                                            );
                                          }}
                                        </For>
                                      </div>
                                    </Show>
                                  </div>
                                </Show>
                              </div>
                            )}
                          </For>
                          <Show when={messageArtifacts().length}>
                            <div class={`mt-4 space-y-2 ${isUser() ? "text-gray-12" : ""}`.trim()}>
                              <div class="text-[11px] uppercase tracking-wide text-gray-9">Artifacts</div>
                              <For each={messageArtifacts()}>
                                {(artifact) => (
                                  <div
                                    class="rounded-2xl border border-gray-6 bg-gray-1/60 px-4 py-3 flex items-center justify-between"
                                    data-artifact-id={artifact.id}
                                  >
                                    <div class="flex items-center gap-3">
                                      <div class="h-9 w-9 rounded-lg bg-gray-2 flex items-center justify-center">
                                        <FileText size={16} class="text-gray-10" />
                                      </div>
                                      <div>
                                        <div class="text-sm text-gray-12">{artifact.name}</div>
                                        <div class="text-xs text-gray-10">Document</div>
                                      </div>
                                    </div>
                                    <Button variant="outline" class="text-xs" onClick={() => handleOpenArtifact(artifact)}>
                                      {artifactActionLabel()}
                                    </Button>
                                  </div>
                                )}
                              </For>
                            </div>
                          </Show>
                          
                          <div class="mt-2 flex justify-end opacity-0 group-hover:opacity-100 transition-opacity select-none">
                            <button
                              class="text-gray-9 hover:text-gray-11 p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                              title="Copy message"
                              onClick={() => {
                                const text = renderableParts().map(p => "text" in p ? (p as any).text : "").join("\n");
                                handleCopy(text, messageId());
                              }}
                            >
                              <Show when={copyingId() === messageId()} fallback={<Copy size={12} />}>
                                <Check size={12} class="text-green-10" />
                              </Show>
                            </button>
                          </div>
                        </div>
                      </div>
                    </Show>
                  );
                }}
              </For>

              <Show when={showAnticipatoryCursor()}>
                <div class="flex justify-start py-4 px-2">
                  <Zap size={14} class="text-gray-7 animate-soft-pulse" />
                </div>
              </Show>

              <Show when={unlinkedArtifacts().length}>
                <div class="mt-6 space-y-2">
                  <div class="text-[11px] uppercase tracking-wide text-gray-9">Artifacts</div>
                  <For each={unlinkedArtifacts()}>
                    {(artifact) => (
                      <div class="rounded-2xl border border-gray-6 bg-gray-1/60 px-4 py-3 flex items-center justify-between">
                        <div class="flex items-center gap-3">
                          <div class="h-9 w-9 rounded-lg bg-gray-2 flex items-center justify-center">
                            <FileText size={16} class="text-gray-10" />
                          </div>
                          <div>
                            <div class="text-sm text-gray-12">{artifact.name}</div>
                            <div class="text-xs text-gray-10">Document</div>
                          </div>
                        </div>
                        <Button variant="outline" class="text-xs" onClick={() => handleOpenArtifact(artifact)}>
                          {artifactActionLabel()}
                        </Button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              <div ref={(el) => (messagesEndEl = el)} />
            </div>
          </div>

          <div class="hidden lg:flex w-5 bg-transparent flex-col items-center justify-start relative group/rail z-10 overflow-hidden py-1">
            <For each={messageLines()}>
              {(line, idx) => (
                <button
                  type="button"
                  aria-label={`${line.role === "user" ? "User" : "Agent"} message ${idx() + 1}`}
                  aria-current={line.id === activeMessageId() ? "true" : undefined}
                  class={`absolute left-1/2 -translate-x-1/2 rounded-full transition-all duration-300 ease-out cursor-pointer appearance-none border-none p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-6/70 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-1
                    ${
                      line.id === activeMessageId()
                        ? "w-4 h-[3px] opacity-100 z-20 shadow-[0_0_8px_rgba(235,0,41,0.6)] dark:shadow-[0_0_8px_rgba(255,255,255,0.6)]"
                        : "w-2.5 h-[2px] opacity-30 hover:opacity-80 hover:w-3.5"
                    }
                  `}
                  style={{
                    top: `${line.top}px`,
                    "background-color": line.role === "user" ? "#EB0029" : "var(--rail-agent-color, currentColor)",
                  }}
                  title={line.role === "user" ? "User" : "Agent"}
                  onClick={(e) => {
                    e.stopPropagation();
                    const el = chatContainerEl?.querySelector(`[data-message-id="${line.id}"]`);
                    el?.scrollIntoView({ behavior: "smooth", block: "center" });
                  }}
                >
                  <span aria-hidden="true" class="absolute -inset-x-2 -inset-y-1" />
                </button>
              )}
            </For>
            <style>
              {`
                :root { --rail-agent-color: #000; }
                [data-theme="dark"] { --rail-agent-color: #fff; }
              `}
            </style>
          </div>

          <Show when={artifactToast()}>
            <div class="fixed bottom-24 right-8 z-30 rounded-xl bg-gray-2 border border-gray-6 px-4 py-2 text-xs text-gray-11 shadow-lg">
              {artifactToast()}
            </div>
          </Show>

              <aside class="hidden lg:flex w-80 border-l border-gray-6 bg-gray-1 flex-col">
                <div class="p-4 space-y-4 overflow-y-auto flex-1">
                  <Show when={realTodos().length > 0}>
                    <div class="rounded-2xl border border-gray-6 bg-gray-1/60" id="sidebar-progress">
                      <button
                    class="w-full px-4 py-3 flex items-center justify-between text-sm text-gray-12"
                    onClick={() => toggleSidebar("progress")}
                  >
                    <span>Progress</span>
                    <ChevronDown
                      size={16}
                      class={`transition-transform ${props.expandedSidebarSections.progress ? "rotate-180" : ""}`.trim()}
                    />
                  </button>
                  <Show when={props.expandedSidebarSections.progress}>
                    <div class="px-4 pb-4 pt-1">
                      <div class="flex items-center gap-2">
                        <For each={progressDots()}>
                          {(done) => (
                            <div
                              class={`h-6 w-6 rounded-full border flex items-center justify-center ${
                                done ? "border-green-6 text-green-11" : "border-gray-7 text-gray-8"
                              }`}
                            >
                              <Show when={done}>
                                <Check size={14} />
                              </Show>
                            </div>
                          )}
                        </For>
                      </div>
                      <div class="mt-2 text-xs text-gray-10">Steps will show as the task unfolds.</div>
                    </div>
                  </Show>
                </div>
              </Show>

              <div class="rounded-2xl border border-gray-6 bg-gray-1/60" id="sidebar-artifacts">
                <button
                  class="w-full px-4 py-3 flex items-center justify-between text-sm text-gray-12"
                  onClick={() => toggleSidebar("artifacts")}
                >
                  <span>Artifacts</span>
                  <ChevronDown
                    size={16}
                    class={`transition-transform ${props.expandedSidebarSections.artifacts ? "rotate-180" : ""}`.trim()}
                  />
                </button>
                <Show when={props.expandedSidebarSections.artifacts}>
                  <div class="px-4 pb-4 pt-1 space-y-3">
                    <Show
                      when={props.artifacts.length}
                      fallback={<div class="text-xs text-gray-7">No artifacts yet.</div>}
                    >
                      <For each={props.artifacts}>
                        {(artifact) => (
                          <div class="flex items-center gap-3 text-sm text-gray-11">
                            <div class="h-8 w-8 rounded-lg bg-gray-2 flex items-center justify-center">
                              <FileText size={16} class="text-gray-10" />
                            </div>
                            <div class="min-w-0">
                              <div class="truncate text-gray-12">{artifact.name}</div>
                            </div>
                          </div>
                        )}
                      </For>
                    </Show>
                  </div>
                </Show>
              </div>

              <div class="rounded-2xl border border-gray-6 bg-gray-1/60" id="sidebar-context">
                <button
                  class="w-full px-4 py-3 flex items-center justify-between text-sm text-gray-12"
                  onClick={() => toggleSidebar("context")}
                >
                  <span>Context</span>
                  <ChevronDown
                    size={16}
                    class={`transition-transform ${props.expandedSidebarSections.context ? "rotate-180" : ""}`.trim()}
                  />
                </button>
                <Show when={props.expandedSidebarSections.context}>
                  <div class="px-4 pb-4 pt-1 space-y-4">
                    <Show when={props.activePlugins.length || props.activePluginStatus}>
                      <div>
                        <div class="flex items-center justify-between text-xs text-gray-10">
                          <span>Active plugins</span>
                          <span>{props.activePlugins.length}</span>
                        </div>
                        <div class="mt-2 space-y-2">
                          <Show
                            when={props.activePlugins.length}
                            fallback={
                              <div class="text-xs text-gray-7">{props.activePluginStatus ?? "No plugins loaded."}</div>
                            }
                          >
                            <For each={props.activePlugins}>
                              {(plugin) => (
                                <div class="flex items-center gap-2 text-xs text-gray-11">
                                  <Circle size={8} class="text-gray-10" />
                                  <span class="truncate">{humanizePlugin(plugin) || plugin}</span>
                                </div>
                              )}
                            </For>
                          </Show>
                        </div>
                      </div>
                    </Show>

                    <div>
                      <div class="flex items-center justify-between text-xs text-gray-10">
                        <span>Selected folders</span>
                        <span>{props.authorizedDirs.length}</span>
                      </div>
                      <div class="mt-2 space-y-2">
                        <For each={props.authorizedDirs.slice(0, 3)}>
                          {(folder) => (
                            <div class="flex items-center gap-2 text-xs text-gray-11">
                              <Folder size={12} class="text-gray-10" />
                              <span class="truncate">{folder}</span>
                            </div>
                          )}
                        </For>
                      </div>
                    </div>

                    <div>
                      <div class="text-xs text-gray-10">Working files</div>
                      <div class="mt-2 space-y-2">
                        <Show
                          when={props.workingFiles.length}
                          fallback={<div class="text-xs text-gray-7">None yet.</div>}
                        >
                          <For each={props.workingFiles}>
                            {(file) => (
                              <div class="flex items-center gap-2 text-xs text-gray-11">
                                <File size={12} class="text-gray-10" />
                                <span class="truncate">{file}</span>
                              </div>
                            )}
                          </For>
                        </Show>
                      </div>
                    </div>
                  </div>
                </Show>
              </div>
            </div>
          </aside>
        </div>

        <div class="p-4 border-t border-gray-6 bg-gray-1 sticky bottom-0 z-20">
          <div class="max-w-2xl mx-auto">
              <div
                class={`bg-gray-2 border border-gray-6 rounded-2xl overflow-visible transition-all shadow-2xl relative group/input ${
                  commandMenuOpen()
                    ? "rounded-t-none border-t-transparent"
                    : "focus-within:ring-1 focus-within:ring-gray-7"
                }`}
              >
                <Show when={commandMenuOpen()}>
                  <div class="absolute bottom-full left-[-1px] right-[-1px] z-30">
                    <div class="rounded-t-2xl border border-gray-6 border-b-0 bg-gray-2 shadow-2xl overflow-hidden">
                      <div class="px-3 pt-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-gray-8 border-b border-gray-6/30 bg-gray-2">
                        Commands
                      </div>
                      <div class="space-y-1 p-2 bg-gray-2">
                        <Show
                          when={commandMatches().length}
                          fallback={
                            <div class="px-3 py-2 text-xs text-gray-9">
                              No commands found.
                            </div>
                          }
                        >
                          <For each={commandMatches()}>
                            {(command, idx) => (
                              <button
                                type="button"
                                class={`w-full flex items-start gap-3 rounded-xl px-3 py-2 text-left transition-colors ${
                                  idx() === commandIndex()
                                    ? "bg-gray-12/10 text-gray-12"
                                    : "text-gray-11 hover:bg-gray-12/5"
                                }`}
                                onMouseDown={(event) => {
                                  event.preventDefault();
                                  selectCommand(command.id);
                                }}
                                onMouseEnter={() => {
                                  setCommandIndex(idx());
                                  promptInputEl?.focus();
                                }}
                              >
                                <div class="text-xs font-semibold text-gray-12">/{command.id}</div>
                                <div class="text-[11px] text-gray-9">{command.description}</div>
                              </button>
                            )}
                          </For>
                        </Show>
                      </div>
                    </div>
                  </div>
                </Show>

                <button
                  type="button"
                  class="absolute top-2 left-4 flex items-center gap-1 text-[10px] font-bold text-gray-7 hover:text-gray-11 transition-colors uppercase tracking-widest z-10"
                  onClick={() => props.openSessionModelPicker()}
                  disabled={props.busy}
                >
                  <Zap size={10} class="text-gray-7 group-hover:text-amber-11 transition-colors" />
                  <span>{isModelUnknown() ? "Standard" : modelLabelParts().model}</span>
                </button>

                <div class="p-2 pt-6 pb-3 px-4">
                  <Show when={props.showTryNotionPrompt}>
                    <button
                      type="button"
                      class="w-full mb-2 flex items-center justify-between gap-3 rounded-xl border border-green-7/20 bg-green-7/10 px-3 py-2 text-left text-sm text-green-12 transition-colors hover:bg-green-7/15"
                      onClick={() => props.onTryNotionPrompt()}
                    >
                      <span>Try it now: set up my CRM in Notion</span>
                      <span class="text-xs text-green-12 font-medium">Insert prompt</span>
                    </button>
                  </Show>

                  <div class="relative">

                  <Show when={commandToast()}>
                    <div class="absolute bottom-full right-0 mb-2 z-30 rounded-xl border border-gray-6 bg-gray-1/90 px-3 py-2 text-xs text-gray-11 shadow-lg">
                      {commandToast()}
                    </div>
                  </Show>

                  <div class="relative flex items-end gap-2">
                    <textarea
                      ref={(el) => (promptInputEl = el)}
                      rows={1}
                      disabled={props.busy}
                      value={props.prompt}
                      onInput={(e) => {
                        props.setPrompt(e.currentTarget.value);
                        syncPromptHeight();
                      }}
                      onKeyDown={handlePromptKeyDown}
                      placeholder="Ask OpenWork..."
                      class="flex-1 bg-transparent border-none p-0 text-gray-12 placeholder-gray-6 focus:ring-0 text-[15px] leading-relaxed resize-none min-h-[24px] max-h-[160px]"
                    />

                    <button
                      disabled={!props.prompt.trim() || props.busy}
                      onClick={handlePrimaryAction}
                      class="p-1.5 bg-gray-12 text-gray-1 rounded-lg hover:scale-105 active:scale-95 transition-all disabled:opacity-0 disabled:scale-75 shadow-lg shrink-0"
                      title="Run"
                    >
                      <ArrowRight size={18} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
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
