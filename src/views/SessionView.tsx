import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
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
} from "../app/types";

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

import Button from "../components/Button";
import PartView from "../components/PartView";
import WorkspaceChip from "../components/WorkspaceChip";
import { isTauriRuntime, isWindowsPlatform } from "../app/utils";
import { useI18n } from "../i18n";

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
  const [t] = useI18n();
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

  createEffect(() => {
    if (!artifactToast()) return;
    const id = window.setTimeout(() => setArtifactToast(null), 3000);
    return () => window.clearTimeout(id);
  });

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

  const artifactActionLabel = () => (isWindowsPlatform() ? t("session.open") : t("session.reveal"));

  const artifactActionToast = () => (isWindowsPlatform() ? t("session.open_toast") : t("session.reveal_toast"));

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
      setArtifactToast(t("session.open_error"));
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

  return (
    <Show
      when={props.selectedSessionId}
      fallback={
        <div class="min-h-screen flex items-center justify-center bg-zinc-950 text-white p-6">
          <div class="text-center space-y-4">
            <div class="text-lg font-medium">{t("session.no_session")}</div>
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
      <div class="h-screen flex flex-col bg-zinc-950 text-white relative">
        <header class="h-16 border-b border-zinc-800 flex items-center justify-between px-6 bg-zinc-950/80 backdrop-blur-md z-10 sticky top-0">
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
              <span class="text-xs text-zinc-600">{props.headerStatus}</span>
            </Show>
            <Show when={props.busyHint}>
              <span class="text-xs text-zinc-500">· {props.busyHint}</span>
            </Show>

          </div>
        </header>

        <Show when={props.error}>
          <div class="mx-auto max-w-5xl w-full px-6 md:px-10 pt-4">
            <div class="rounded-2xl bg-red-950/40 px-5 py-4 text-sm text-red-200 border border-red-500/20">
              {props.error}
            </div>
          </div>
        </Show>

        <div class="flex-1 flex overflow-hidden">
          <aside class="hidden lg:flex w-72 border-r border-zinc-800 bg-zinc-950 flex-col">
            <div class="px-4 pt-4">
              <button
                class="w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-white text-black text-sm font-medium shadow-lg shadow-white/10"
                onClick={props.createSessionAndOpen}
                disabled={props.newTaskDisabled}
              >
                <Plus size={16} />
                {t("session.new_task")}
              </button>
            </div>

            <div class="flex-1 overflow-y-auto px-4 py-4">
              <div class="text-xs text-zinc-500 uppercase tracking-wide mb-3">{t("session.recents")}</div>
              <div class="space-y-2">
                <For each={props.sessions.slice(0, 8)}>
                  {(session) => (
                    <button
                      class={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${session.id === props.selectedSessionId
                          ? "bg-zinc-900 text-zinc-100"
                          : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900/50"
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
              <div class="mt-6 text-xs text-zinc-500">
                {t("session.recents_desc")}
              </div>
            </div>
          </aside>

          <div class="flex-1 overflow-y-auto p-6 md:p-10 scroll-smooth">
            <div class="max-w-2xl mx-auto space-y-6 pb-32">
              <Show when={props.messages.length === 0}>
                <div class="text-center py-20 space-y-4">
                  <div class="w-16 h-16 bg-zinc-900 rounded-3xl mx-auto flex items-center justify-center border border-zinc-800">
                    <Zap class="text-zinc-600" />
                  </div>
                  <h3 class="text-xl font-medium">{t("session.ready")}</h3>
                  <p class="text-zinc-500 text-sm max-w-xs mx-auto">
                    {t("session.ready_desc")}
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

                  return (
                    <Show when={renderableParts().length > 0}>
                      <div class={`flex ${isUser() ? "justify-end" : "justify-start"}`.trim()}>
                        <div
                          class={`w-full ${isUser()
                              ? "max-w-[520px] rounded-2xl bg-white text-black shadow-xl shadow-white/5 p-4 text-sm leading-relaxed"
                              : "max-w-[68ch] text-[15px] leading-7 text-zinc-200"
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
                                  />
                                </Show>
                                <Show when={group.kind === "steps"}>
                                  <div class={isUser() ? "mt-2" : "mt-3 border-t border-zinc-800/60 pt-3"}>
                                    <button
                                      class={`flex items-center gap-2 text-xs ${isUser() ? "text-zinc-500 hover:text-zinc-300" : "text-zinc-500 hover:text-zinc-200"
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
                                        class={`mt-3 space-y-3 rounded-xl border p-3 ${isUser()
                                            ? "border-zinc-800 bg-zinc-950/60"
                                            : "border-zinc-800/70 bg-zinc-900/40"
                                          }`}
                                      >
                                        <For each={(group as any).parts as Part[]}>
                                          {(part) => {
                                            const summary = props.summarizeStep(part);
                                            return (
                                              <div class="flex items-start gap-3 text-xs text-zinc-300">
                                                <div class="mt-0.5 h-5 w-5 rounded-full border border-zinc-700 flex items-center justify-center text-zinc-500">
                                                  {part.type === "tool" ? <File size={12} /> : <Circle size={8} />}
                                                </div>
                                                <div>
                                                  <div class="text-zinc-200">{summary.title}</div>
                                                  <Show when={summary.detail}>
                                                    <div class="mt-1 text-zinc-500">{summary.detail}</div>
                                                  </Show>
                                                  <Show when={props.developerMode && (part.type !== "tool" || props.showThinking)}>
                                                    <div class="mt-2 text-xs text-zinc-500">
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
                        </div>
                      </div>
                    </Show>
                  );
                }}
              </For>

              <Show when={showAnticipatoryCursor()}>
                <div class="flex justify-start py-4 px-2">
                  <Zap size={14} class="text-zinc-600 animate-soft-pulse" />
                </div>
              </Show>

              <For each={props.artifacts}>
                {(artifact) => (
                  <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4 flex items-center justify-between">
                    <div class="flex items-center gap-3">
                      <div class="h-10 w-10 rounded-xl bg-zinc-900 flex items-center justify-center">
                        <FileText size={18} class="text-zinc-400" />
                      </div>
                      <div>
                        <div class="text-sm text-zinc-100">{artifact.name}</div>
                        <div class="text-xs text-zinc-500">Document</div>
                      </div>
                    </div>
                    <Button variant="outline" class="text-xs" onClick={() => handleOpenArtifact(artifact)}>
                      {artifactActionLabel()}
                    </Button>
                  </div>
                )}
              </For>

              <div ref={(el) => (messagesEndEl = el)} />
            </div>
          </div>

          <Show when={artifactToast()}>
            <div class="fixed bottom-24 right-8 z-30 rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-2 text-xs text-zinc-300 shadow-lg">
              {artifactToast()}
            </div>
          </Show>

          <aside class="hidden lg:flex w-80 border-l border-zinc-800 bg-zinc-950 flex-col">
            <div class="p-4 space-y-4 overflow-y-auto flex-1">
              <Show when={realTodos().length > 0}>
                <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60">
                  <button
                    class="w-full px-4 py-3 flex items-center justify-between text-sm text-zinc-200"
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
                              class={`h-6 w-6 rounded-full border flex items-center justify-center ${done ? "border-emerald-400 text-emerald-400" : "border-zinc-700 text-zinc-700"
                                }`}
                            >
                              <Show when={done}>
                                <Check size={14} />
                              </Show>
                            </div>
                          )}
                        </For>
                      </div>
                      <div class="mt-2 text-xs text-zinc-500">{t("session.steps_desc")}</div>
                    </div>
                  </Show>
                </div>
              </Show>

              <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60">
                <button
                  class="w-full px-4 py-3 flex items-center justify-between text-sm text-zinc-200"
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
                      fallback={<div class="text-xs text-zinc-600">{t("session.no_artifacts")}</div>}
                    >
                      <For each={props.artifacts}>
                        {(artifact) => (
                          <div class="flex items-center gap-3 text-sm text-zinc-300">
                            <div class="h-8 w-8 rounded-lg bg-zinc-900 flex items-center justify-center">
                              <FileText size={16} class="text-zinc-500" />
                            </div>
                            <div class="min-w-0">
                              <div class="truncate text-zinc-200">{artifact.name}</div>
                            </div>
                          </div>
                        )}
                      </For>
                    </Show>
                  </div>
                </Show>
              </div>

              <div class="rounded-2xl border border-zinc-800 bg-zinc-950/60">
                <button
                  class="w-full px-4 py-3 flex items-center justify-between text-sm text-zinc-200"
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
                        <div class="flex items-center justify-between text-xs text-zinc-500">
                          <span>{t("session.active_plugins")}</span>
                          <span>{props.activePlugins.length}</span>
                        </div>
                        <div class="mt-2 space-y-2">
                          <Show
                            when={props.activePlugins.length}
                            fallback={
                              <div class="text-xs text-zinc-600">{props.activePluginStatus ?? t("session.no_plugins")}</div>
                            }
                          >
                            <For each={props.activePlugins}>
                              {(plugin) => (
                                <div class="flex items-center gap-2 text-xs text-zinc-300">
                                  <Circle size={8} class="text-zinc-500" />
                                  <span class="truncate">{humanizePlugin(plugin) || plugin}</span>
                                </div>
                              )}
                            </For>
                          </Show>
                        </div>
                      </div>
                    </Show>

                    <div>
                      <div class="flex items-center justify-between text-xs text-zinc-500">
                        <span>{t("session.selected_folders")}</span>
                        <span>{props.authorizedDirs.length}</span>
                      </div>
                      <div class="mt-2 space-y-2">
                        <For each={props.authorizedDirs.slice(0, 3)}>
                          {(folder) => (
                            <div class="flex items-center gap-2 text-xs text-zinc-300">
                              <Folder size={12} class="text-zinc-500" />
                              <span class="truncate">{folder}</span>
                            </div>
                          )}
                        </For>
                      </div>
                    </div>

                    <div>
                      <div class="text-xs text-zinc-500">{t("session.working_files")}</div>
                      <div class="mt-2 space-y-2">
                        <Show
                          when={props.workingFiles.length}
                          fallback={<div class="text-xs text-zinc-600">None yet.</div>}
                        >
                          <For each={props.workingFiles}>
                            {(file) => (
                              <div class="flex items-center gap-2 text-xs text-zinc-300">
                                <File size={12} class="text-zinc-500" />
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

        <div class="p-4 border-t border-zinc-800 bg-zinc-950 sticky bottom-0 z-20">
          <div class="max-w-2xl mx-auto">
            <div class="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden focus-within:ring-1 focus-within:ring-zinc-700 transition-all shadow-2xl relative group/input">
              <button
                type="button"
                class="absolute top-2 left-4 flex items-center gap-1 text-[10px] font-bold text-zinc-600 hover:text-zinc-300 transition-colors uppercase tracking-widest z-10"
                onClick={() => props.openSessionModelPicker()}
                disabled={props.busy}
              >
                <Zap size={10} class="text-zinc-600 group-hover:text-amber-400 transition-colors" />
                <span>{isModelUnknown() ? t("session.standard") : modelLabelParts().model}</span>
              </button>

              <div class="p-2 pt-6 pb-3 px-4">
                <Show when={props.showTryNotionPrompt}>
                  <button
                    type="button"
                    class="w-full mb-2 flex items-center justify-between gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-left text-sm text-emerald-100 transition-colors hover:bg-emerald-500/15"
                    onClick={() => props.onTryNotionPrompt()}
                  >
                    <span>{t("session.try_notion")}</span>
                    <span class="text-xs text-emerald-200 font-medium">{t("session.insert_prompt")}</span>
                  </button>
                </Show>

                <div class="relative flex items-center">
                  <input
                    type="text"
                    disabled={props.busy}
                    value={props.prompt}
                    onInput={(e) => props.setPrompt(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        props.sendPromptAsync().catch(() => undefined);
                      }
                    }}
                    placeholder={t("session.input_placeholder")}
                    class="flex-1 bg-transparent border-none p-0 text-zinc-100 placeholder-zinc-500 focus:ring-0 text-[15px] leading-relaxed"
                  />

                  <button
                    disabled={!props.prompt.trim() || props.busy}
                    onClick={() => props.sendPromptAsync().catch(() => undefined)}
                    class="p-1.5 bg-white text-black rounded-lg hover:scale-105 active:scale-95 transition-all disabled:opacity-0 disabled:scale-75 shadow-lg shrink-0 ml-2"
                    title={t("session.run")}
                  >
                    <ArrowRight size={18} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <Show when={props.activePermission}>
          <div class="absolute inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
            <div class="bg-zinc-900 border border-amber-500/30 w-full max-w-md rounded-2xl shadow-2xl overflow-hidden">
              <div class="p-6">
                <div class="flex items-start gap-4 mb-4">
                  <div class="p-3 bg-amber-500/10 rounded-full text-amber-500">
                    <Shield size={24} />
                  </div>
                  <div>
                    <h3 class="text-lg font-semibold text-white">{t("permissions.title")}</h3>
                    <p class="text-sm text-zinc-400 mt-1">{t("permissions.subtitle")}</p>
                  </div>
                </div>

                <div class="bg-zinc-950/50 rounded-xl p-4 border border-zinc-800 mb-6">
                  <div class="text-xs text-zinc-500 uppercase tracking-wider mb-2 font-semibold">{t("permissions.permission")}</div>
                  <div class="text-sm text-zinc-200 font-mono">{props.activePermission?.permission}</div>

                  <div class="text-xs text-zinc-500 uppercase tracking-wider mt-4 mb-2 font-semibold">{t("permissions.scope")}</div>
                  <div class="flex items-center gap-2 text-sm font-mono text-amber-200 bg-amber-950/30 px-2 py-1 rounded border border-amber-500/20">
                    <HardDrive size={12} />
                    {props.activePermission?.patterns.join(", ")}
                  </div>

                  <Show when={Object.keys(props.activePermission?.metadata ?? {}).length > 0}>
                    <details class="mt-4 rounded-lg bg-black/20 p-2">
                      <summary class="cursor-pointer text-xs text-zinc-400">{t("permissions.details")}</summary>
                      <pre class="mt-2 whitespace-pre-wrap break-words text-xs text-zinc-200">
                        {props.safeStringify(props.activePermission?.metadata)}
                      </pre>
                    </details>
                  </Show>
                </div>

                <div class="grid grid-cols-2 gap-3">
                  <Button
                    variant="outline"
                    class="w-full border-red-500/20 text-red-400 hover:bg-red-950/30"
                    onClick={() =>
                      props.activePermission && props.respondPermission(props.activePermission.id, "reject")
                    }
                    disabled={props.permissionReplyBusy}
                  >

                    {t("permissions.deny")}
                  </Button>
                  <div class="grid grid-cols-2 gap-2">
                    <Button
                      variant="secondary"
                      class="text-xs"
                      onClick={() => props.activePermission && props.respondPermission(props.activePermission.id, "once")}
                      disabled={props.permissionReplyBusy}
                    >
                      {t("permissions.once")}
                    </Button>
                    <Button
                      variant="primary"
                      class="text-xs font-bold bg-amber-500 hover:bg-amber-400 text-black border-none shadow-amber-500/20"
                      onClick={() =>
                        props.activePermission &&
                        props.respondPermissionAndRemember(props.activePermission.id, "always")
                      }
                      disabled={props.permissionReplyBusy}
                    >
                      {t("permissions.allow_session")}
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
