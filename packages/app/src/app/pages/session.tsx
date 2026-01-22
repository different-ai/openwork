import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { Part } from "@opencode-ai/sdk/v2/client";
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
  Check,
  ChevronDown,
  Circle,
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
import WorkspaceChip from "../components/workspace-chip";
import { isTauriRuntime, isWindowsPlatform } from "../utils";
import { t } from "../../i18n";

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
};

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

  let promptInputEl: HTMLTextAreaElement | undefined;

  createEffect(() => {
    const handler = () => {
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

  const artifactActionLabel = () => (isWindowsPlatform() ? t("session.open") : t("session.reveal"));

  const artifactActionToast = () => (isWindowsPlatform() ? t("session.opened_toast") : t("session.revealed_toast"));

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
      setArtifactToast(t("session.artifact_path_missing"));
      return;
    }

    if (!isTauriRuntime()) {
      setArtifactToast(t("session.desktop_only"));
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
      setArtifactToast(error instanceof Error ? error.message : t("session.open_failed"));
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
    const label = props.selectedSessionModelLabel || t("session.model");
    const [provider, model] = label.split(" · ");
    return {
      provider: provider?.trim() || label,
      model: model?.trim() || t("session.ready"),
    };
  });

  const isModelUnknown = createMemo(() =>
    ["model", "unknown", "default"].includes((props.selectedSessionModelLabel || "").trim().toLowerCase()),
  );

  const modelUnavailableDetail = createMemo(() => {
    if (props.selectedSessionModelLabel) return null;
    return t("session.connect_provider");
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
    if (props.busyLabel !== t("session.running") && props.sessionStatus !== "running") return false;
    return !hasAssistantTextAfterLastUser();
  });

  const clearPrompt = () => {
    props.setPrompt("");
    queueMicrotask(syncPromptHeight);
  };

  const commandList = createMemo(() => [
    {
      id: "models",
      label: t("session.model"),
      description: t("settings.model_description_session"),
      run: () => {
        props.openSessionModelPicker();
        clearPrompt();
      },
    },
    {
      id: "help",
      label: "Help",
      description: "Show available commands",
      run: () => {
        setCommandToast("Commands: /models, /help, /clear");
        clearPrompt();
      },
    },
    {
      id: "clear",
      label: "Clear",
      description: "Clear the input",
      run: () => clearPrompt(),
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
      setCommandToast(t("session.unknown_command"));
      return;
    }
    const command = commandList().find((entry) => entry.id === commandId);
    if (!command) {
      setCommandToast(t("session.unknown_command"));
      return;
    }
    command.run();
  };

  const handlePrimaryAction = () => {
    if (commandMenuOpen()) {
      const matches = commandMatches();
      const active = matches[commandIndex()];
      runCommand(active?.id);
      return;
    }
    props.sendPromptAsync().catch(() => undefined);
  };

  const handlePromptKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && event.shiftKey) return;
    if (event.isComposing && event.key !== "Enter") return;

    const menuOpen = commandMenuOpen();
    const matches = commandMatches();

    if (menuOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (!matches.length) return;
        setCommandIndex((current) => Math.min(current + 1, matches.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (!matches.length) return;
        setCommandIndex((current) => Math.max(current - 1, 0));
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        clearPrompt();
        return;
      }
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
            <div class="text-lg font-medium">{t("session.no_selected")}</div>
            <Button
              onClick={() => {
                props.setView("dashboard");
                props.setTab("sessions");
              }}
            >
              {t("session.back_to_dashboard")}
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
                {t("session.new_task")}
              </button>
            </div>

            <div class="flex-1 overflow-y-auto px-4 py-4">
              <div class="text-xs text-gray-10 uppercase tracking-wide mb-3">{t("session.recents")}</div>
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
                      <div class="flex items-center justify-between gap-2">
                        <span class="truncate">{session.title}</span>
                      </div>
                    </button>
                  )}
                </For>
              </div>
              <div class="mt-6 text-xs text-gray-10">
                {t("session.recents_notice")}
              </div>
            </div>
          </aside>

          <div class="flex-1 overflow-y-auto p-6 md:p-10 scroll-smooth">
            <div class="max-w-2xl mx-auto space-y-6 pb-32">
              <Show when={props.messages.length === 0}>
                <div class="text-center py-20 space-y-4">
                  <div class="w-16 h-16 bg-gray-2 rounded-3xl mx-auto flex items-center justify-center border border-gray-6">
                    <Zap class="text-gray-7" />
                  </div>
                  <h3 class="text-xl font-medium">{t("session.ready_to_work_title")}</h3>
                  <p class="text-gray-10 text-sm max-w-xs mx-auto">
                    {t("session.ready_to_work_description")}
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
                      <div class={`flex ${isUser() ? "justify-end" : "justify-start"}`.trim()}>
                        <div
                          class={`w-full ${
                            isUser()
                              ? "max-w-[520px] rounded-2xl bg-gray-4 text-gray-12 shadow-sm border-gray-5 border-1 shadow-gray-12/5 p-4 text-sm leading-relaxed rounded-br-none"
                              : "max-w-[68ch] text-[15px] leading-7 text-gray-12"
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
                                        {props.expandedStepIds.has((group as any).id) ? t("session.hide_steps") : t("session.view_steps")}
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
                              <div class="text-[11px] uppercase tracking-wide text-gray-9">{t("session.artifacts")}</div>
                              <For each={messageArtifacts()}>
                                {(artifact) => (
                                  <div class="rounded-2xl border border-gray-6 bg-gray-1/60 px-4 py-3 flex items-center justify-between">
                                    <div class="flex items-center gap-3">
                                      <div class="h-9 w-9 rounded-lg bg-gray-2 flex items-center justify-center">
                                        <FileText size={16} class="text-gray-10" />
                                      </div>
                                      <div>
                                        <div class="text-sm text-gray-12">{artifact.name}</div>
                                        <div class="text-xs text-gray-10">{t("session.document_label")}</div>
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
                  <div class="text-[11px] uppercase tracking-wide text-gray-9">{t("session.artifacts")}</div>
                  <For each={unlinkedArtifacts()}>
                    {(artifact) => (
                      <div class="rounded-2xl border border-gray-6 bg-gray-1/60 px-4 py-3 flex items-center justify-between">
                        <div class="flex items-center gap-3">
                          <div class="h-9 w-9 rounded-lg bg-gray-2 flex items-center justify-center">
                            <FileText size={16} class="text-gray-10" />
                          </div>
                          <div>
                            <div class="text-sm text-gray-12">{artifact.name}</div>
                            <div class="text-xs text-gray-10">{t("session.document_label")}</div>
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

          <Show when={artifactToast()}>
            <div class="fixed bottom-24 right-8 z-30 rounded-xl bg-gray-2 border border-gray-6 px-4 py-2 text-xs text-gray-11 shadow-lg">
              {artifactToast()}
            </div>
          </Show>

          <aside class="hidden lg:flex w-80 border-l border-gray-6 bg-gray-1 flex-col">
            <div class="p-4 space-y-4 overflow-y-auto flex-1">
              <Show when={realTodos().length > 0}>
                <div class="rounded-2xl border border-gray-6 bg-gray-1/60">
                  <button
                    class="w-full px-4 py-3 flex items-center justify-between text-sm text-gray-12"
                    onClick={() => toggleSidebar("progress")}
                  >
                    <span>{t("session.progress")}</span>
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
                      <div class="mt-2 text-xs text-gray-10">{t("session.steps_notice")}</div>
                    </div>
                  </Show>
                </div>
              </Show>

              <div class="rounded-2xl border border-gray-6 bg-gray-1/60">
                <button
                  class="w-full px-4 py-3 flex items-center justify-between text-sm text-gray-12"
                  onClick={() => toggleSidebar("artifacts")}
                >
                  <span>{t("session.artifacts")}</span>
                  <ChevronDown
                    size={16}
                    class={`transition-transform ${props.expandedSidebarSections.artifacts ? "rotate-180" : ""}`.trim()}
                  />
                </button>
                <Show when={props.expandedSidebarSections.artifacts}>
                  <div class="px-4 pb-4 pt-1 space-y-3">
                    <Show
                      when={props.artifacts.length}
                      fallback={<div class="text-xs text-gray-7">{t("session.no_artifacts_fallback")}</div>}
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

              <div class="rounded-2xl border border-gray-6 bg-gray-1/60">
                <button
                  class="w-full px-4 py-3 flex items-center justify-between text-sm text-gray-12"
                  onClick={() => toggleSidebar("context")}
                >
                  <span>{t("session.context")}</span>
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
                          <span>{t("session.active_plugins_label")}</span>
                          <span>{props.activePlugins.length}</span>
                        </div>
                        <div class="mt-2 space-y-2">
                          <Show
                            when={props.activePlugins.length}
                            fallback={
                              <div class="text-xs text-gray-7">{props.activePluginStatus ?? t("session.no_plugins_loaded")}</div>
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
                        <span>{t("session.selected_folders_label")}</span>
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
                      <div class="text-xs text-gray-10">{t("session.working_files_label")}</div>
                      <div class="mt-2 space-y-2">
                        <Show
                          when={props.workingFiles.length}
                          fallback={<div class="text-xs text-gray-7">{t("session.none_yet_label")}</div>}
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
            <div class="bg-gray-2 border border-gray-6 rounded-2xl overflow-visible focus-within:ring-1 focus-within:ring-gray-7 transition-all shadow-2xl relative group/input">
              <button
                type="button"
                class="absolute top-2 left-4 flex items-center gap-1 text-[10px] font-bold text-gray-7 hover:text-gray-11 transition-colors uppercase tracking-widest z-10"
                onClick={() => props.openSessionModelPicker()}
                disabled={props.busy}
              >
                <Zap size={10} class="text-gray-7 group-hover:text-amber-11 transition-colors" />
                <span>{isModelUnknown() ? t("session.standard_label") : modelLabelParts().model}</span>
              </button>

              <div class="p-2 pt-6 pb-3 px-4">
                <Show when={props.showTryNotionPrompt}>
                  <button
                    type="button"
                    class="w-full mb-2 flex items-center justify-between gap-3 rounded-xl border border-green-7/20 bg-green-7/10 px-3 py-2 text-left text-sm text-green-12 transition-colors hover:bg-green-7/15"
                    onClick={() => props.onTryNotionPrompt()}
                  >
                    <span>{t("session.try_notion_prompt")}</span>
                    <span class="text-xs text-green-12 font-medium">{t("session.insert_prompt")}</span>
                  </button>
                </Show>

                <div class="relative">
                  <Show when={commandMenuOpen()}>
                    <div class="absolute bottom-full left-0 right-0 mb-2 z-30">
                      <div class="rounded-2xl border border-gray-6/70 bg-gray-1/95 shadow-xl backdrop-blur-sm">
                        <div class="px-3 pt-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-gray-8">
                          Commands
                        </div>
                        <div class="space-y-1 px-2 pb-2">
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
                                    runCommand(command.id);
                                  }}
                                  onMouseEnter={() => setCommandIndex(idx())}
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
                      placeholder={t("session.placeholder")}
                      class="flex-1 bg-transparent border-none p-0 text-gray-12 placeholder-gray-6 focus:ring-0 text-[15px] leading-relaxed resize-none min-h-[24px] max-h-[160px]"
                    />

                    <button
                      disabled={!props.prompt.trim() || props.busy}
                      onClick={handlePrimaryAction}
                      class="p-1.5 bg-gray-12 text-gray-1 rounded-lg hover:scale-105 active:scale-95 transition-all disabled:opacity-0 disabled:scale-75 shadow-lg shrink-0"
                      title={t("session.run")}
                    >
                      <ArrowRight size={18} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <Show when={props.activePermission}>
          <div class="absolute inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-center justify-center p-4">
            <div class="bg-gray-2 border border-amber-7/30 w-full max-w-md rounded-2xl shadow-2xl overflow-hidden">
              <div class="p-6">
                <div class="flex items-start gap-4 mb-4">
                  <div class="p-3 bg-amber-7/10 rounded-full text-amber-6">
                    <Shield size={24} />
                  </div>
                  <div>
                    <h3 class="text-lg font-semibold text-gray-12">{t("session.permission_required_title")}</h3>
                    <p class="text-sm text-gray-11 mt-1">{t("session.permission_required_description")}</p>
                  </div>
                </div>

                <div class="bg-gray-1/50 rounded-xl p-4 border border-gray-6 mb-6">
                  <div class="text-xs text-gray-10 uppercase tracking-wider mb-2 font-semibold">{t("session.permission_label_uppercase")}</div>
                  <div class="text-sm text-gray-12 font-mono">{props.activePermission?.permission}</div>

                  <div class="text-xs text-gray-10 uppercase tracking-wider mt-4 mb-2 font-semibold">{t("session.scope_label_uppercase")}</div>
                  <div class="flex items-center gap-2 text-sm font-mono text-amber-12 bg-amber-1/30 px-2 py-1 rounded border border-amber-7/20">
                    <HardDrive size={12} />
                    {props.activePermission?.patterns.join(", ")}
                  </div>

                  <Show when={Object.keys(props.activePermission?.metadata ?? {}).length > 0}>
                    <details class="mt-4 rounded-lg bg-gray-1/20 p-2">
                      <summary class="cursor-pointer text-xs text-gray-11">{t("session.details_label")}</summary>
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
                    {t("session.deny")}
                  </Button>
                  <div class="grid grid-cols-2 gap-2">
                    <Button
                      variant="secondary"
                      class="text-xs"
                      onClick={() => props.activePermission && props.respondPermission(props.activePermission.id, "once")}
                      disabled={props.permissionReplyBusy}
                    >
                      {t("session.once")}
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
                      {t("session.allow_for_session")}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  );
}
