import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { ChevronDown, ChevronRight, Loader2, MoreHorizontal, Plus } from "lucide-solid";

import type { WorkspaceInfo } from "../../lib/tauri";
import type { WorkspaceConnectionState, WorkspaceSessionGroup } from "../../types";
import { formatRelativeTime, getWorkspaceTaskLoadErrorDisplay, isWindowsPlatform } from "../../utils";

type Props = {
  workspaceSessionGroups: WorkspaceSessionGroup[];
  activeWorkspaceId: string;
  selectedSessionId: string | null;
  sessionStatusById?: Record<string, string>;
  connectingWorkspaceId: string | null;
  workspaceConnectionStateById: Record<string, WorkspaceConnectionState>;
  newTaskDisabled: boolean;
  importingWorkspaceConfig: boolean;
  onActivateWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  onOpenSession: (workspaceId: string, sessionId: string) => void;
  onCreateTaskInWorkspace: (workspaceId: string) => void;
  onOpenRenameWorkspace: (workspaceId: string) => void;
  onShareWorkspace: (workspaceId: string) => void;
  onRevealWorkspace: (workspaceId: string) => void;
  onRecoverWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  onTestWorkspaceConnection: (workspaceId: string) => Promise<boolean> | boolean | void;
  onEditWorkspaceConnection: (workspaceId: string) => void;
  onForgetWorkspace: (workspaceId: string) => void;
  onOpenCreateWorkspace: () => void;
  onOpenCreateRemoteWorkspace: () => void;
  onImportWorkspaceConfig: () => void;
};

const MAX_SESSIONS_PREVIEW = 6;
const COLLAPSED_SESSIONS_PREVIEW = 1;

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

const WORKSPACE_SWATCHES = ["#2563eb", "#5a67d8", "#f97316", "#10b981"];

const workspaceSwatchColor = (seed: string) => {
  const value = seed.trim() || "worker";
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return WORKSPACE_SWATCHES[Math.abs(hash) % WORKSPACE_SWATCHES.length];
};

export default function WorkspaceSessionList(props: Props) {
  const revealLabel = isWindowsPlatform() ? "Reveal in Explorer" : "Reveal in Finder";
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = createSignal<Set<string>>(new Set());
  const [previewCountByWorkspaceId, setPreviewCountByWorkspaceId] = createSignal<Record<string, number>>({});
  const [workspaceMenuId, setWorkspaceMenuId] = createSignal<string | null>(null);
  const [addWorkspaceMenuOpen, setAddWorkspaceMenuOpen] = createSignal(false);
  let workspaceMenuRef: HTMLDivElement | undefined;
  let addWorkspaceMenuRef: HTMLDivElement | undefined;

  const isWorkspaceExpanded = (workspaceId: string) => expandedWorkspaceIds().has(workspaceId);

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

  createEffect(() => {
    if (!workspaceMenuId()) return;
    const closeMenu = (event: PointerEvent) => {
      if (!workspaceMenuRef) return;
      const target = event.target as Node | null;
      if (target && workspaceMenuRef.contains(target)) return;
      setWorkspaceMenuId(null);
    };
    window.addEventListener("pointerdown", closeMenu);
    onCleanup(() => window.removeEventListener("pointerdown", closeMenu));
  });

  createEffect(() => {
    if (!addWorkspaceMenuOpen()) return;
    const closeMenu = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (addWorkspaceMenuRef && target && addWorkspaceMenuRef.contains(target)) return;
      setAddWorkspaceMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeMenu);
    onCleanup(() => window.removeEventListener("pointerdown", closeMenu));
  });

  return (
    <>
      <div class="mb-4 space-y-4">
        <For each={props.workspaceSessionGroups}>
          {(group) => {
            const workspace = () => group.workspace;
            const isConnecting = () => props.connectingWorkspaceId === workspace().id;
            const connectionState = () =>
              props.workspaceConnectionStateById[workspace().id] ?? { status: "idle", message: null };
            const isConnectionActionBusy = () =>
              isConnecting() || connectionState().status === "connecting";
            const canRecover = () =>
              workspace().workspaceType === "remote" && connectionState().status === "error";
            const isMenuOpen = () => workspaceMenuId() === workspace().id;
            const taskLoadError = () => getWorkspaceTaskLoadErrorDisplay(workspace(), group.error);
            const statusLabel = () => {
              if (group.status === "error") return taskLoadError().label;
              if (isConnectionActionBusy()) return "Connecting";
              if (props.activeWorkspaceId === workspace().id) return "Active";
              return workspaceKindLabel(workspace());
            };
            const statusTone = () => {
              if (group.status === "error") {
                return taskLoadError().tone === "offline" ? "text-amber-11" : "text-red-11";
              }
              return "text-gray-9";
            };

            return (
              <div class="space-y-2">
                <div class="relative group">
                  <div
                    role="button"
                    tabIndex={0}
                    class={`w-full flex items-center justify-between rounded-[20px] border px-4 py-3 text-left transition-[background-color,border-color,box-shadow] ${
                      props.activeWorkspaceId === workspace().id
                        ? "border-dls-border bg-dls-surface shadow-[var(--dls-card-shadow)]"
                        : "border-transparent text-gray-12 hover:bg-gray-2/70"
                    } ${isConnecting() ? "opacity-75" : ""}`}
                    onClick={() => {
                      expandWorkspace(workspace().id);
                      void Promise.resolve(props.onActivateWorkspace(workspace().id));
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      if (event.isComposing || event.keyCode === 229) return;
                      event.preventDefault();
                      expandWorkspace(workspace().id);
                      void Promise.resolve(props.onActivateWorkspace(workspace().id));
                    }}
                  >
                    <div class="flex min-w-0 items-center gap-4">
                      <div
                        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                        style={{ "background-color": workspaceSwatchColor(workspace().id || workspaceLabel(workspace())) }}
                      />
                      <div class="min-w-0">
                        <div class="truncate text-[16px] font-medium text-dls-text">{workspaceLabel(workspace())}</div>
                        <div class={`mt-0.5 truncate text-[13px] ${statusTone()}`}>{statusLabel()}</div>
                      </div>
                    </div>

                    <div class="ml-4 flex shrink-0 items-center gap-1.5">
                      <Show when={group.status === "loading" || isConnecting()}>
                        <Loader2 size={14} class="animate-spin text-gray-9" />
                      </Show>

                      <div class="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <button
                          type="button"
                          class="rounded-md p-1 text-gray-9 hover:bg-gray-3/80 hover:text-gray-11"
                          onClick={(event) => {
                            event.stopPropagation();
                            props.onCreateTaskInWorkspace(workspace().id);
                          }}
                          disabled={props.newTaskDisabled}
                          aria-label="New task"
                        >
                          <Plus size={14} />
                        </button>

                        <button
                          type="button"
                          class="rounded-md p-1 text-gray-9 hover:bg-gray-3/80 hover:text-gray-11"
                          onClick={(event) => {
                            event.stopPropagation();
                            setWorkspaceMenuId((current) =>
                              current === workspace().id ? null : workspace().id,
                            );
                          }}
                          aria-label="Worker options"
                        >
                          <MoreHorizontal size={14} />
                        </button>
                      </div>

                      <button
                        type="button"
                        class="rounded-md p-1 text-gray-9 hover:bg-gray-3/80 hover:text-gray-11"
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
                    </div>
                  </div>

                  <Show when={isMenuOpen()}>
                    <div
                      ref={(el) => (workspaceMenuRef = el)}
                      class="absolute right-0 top-[calc(100%+6px)] z-20 w-48 rounded-[18px] border border-dls-border bg-dls-surface p-1.5 shadow-[var(--dls-shell-shadow)]"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        class="w-full rounded-xl px-3 py-2 text-left text-sm text-gray-11 transition-colors hover:bg-gray-2"
                        onClick={() => {
                          props.onOpenRenameWorkspace(workspace().id);
                          setWorkspaceMenuId(null);
                        }}
                      >
                        Edit name
                      </button>
                      <button
                        type="button"
                        class="w-full rounded-xl px-3 py-2 text-left text-sm text-gray-11 transition-colors hover:bg-gray-2"
                        onClick={() => {
                          props.onShareWorkspace(workspace().id);
                          setWorkspaceMenuId(null);
                        }}
                      >
                        Share...
                      </button>
                      <Show when={workspace().workspaceType === "local"}>
                        <button
                          type="button"
                          class="w-full rounded-xl px-3 py-2 text-left text-sm text-gray-11 transition-colors hover:bg-gray-2"
                          onClick={() => {
                            props.onRevealWorkspace(workspace().id);
                            setWorkspaceMenuId(null);
                          }}
                        >
                          {revealLabel}
                        </button>
                      </Show>
                      <Show when={workspace().workspaceType === "remote"}>
                        <Show when={canRecover()}>
                          <button
                            type="button"
                            class="w-full rounded-xl px-3 py-2 text-left text-sm text-gray-11 transition-colors hover:bg-gray-2"
                            onClick={() => {
                              void Promise.resolve(props.onRecoverWorkspace(workspace().id));
                              setWorkspaceMenuId(null);
                            }}
                            disabled={isConnectionActionBusy()}
                          >
                            Recover
                          </button>
                        </Show>
                        <button
                          type="button"
                          class="w-full rounded-xl px-3 py-2 text-left text-sm text-gray-11 transition-colors hover:bg-gray-2"
                          onClick={() => {
                            void Promise.resolve(props.onTestWorkspaceConnection(workspace().id));
                            setWorkspaceMenuId(null);
                          }}
                          disabled={isConnectionActionBusy()}
                        >
                          Test connection
                        </button>
                        <button
                          type="button"
                          class="w-full rounded-xl px-3 py-2 text-left text-sm text-gray-11 transition-colors hover:bg-gray-2"
                          onClick={() => {
                            props.onEditWorkspaceConnection(workspace().id);
                            setWorkspaceMenuId(null);
                          }}
                          disabled={isConnectionActionBusy()}
                        >
                          Edit connection
                        </button>
                      </Show>
                      <button
                        type="button"
                        class="w-full rounded-xl px-3 py-2 text-left text-sm text-red-11 transition-colors hover:bg-red-1/40"
                        onClick={() => {
                          props.onForgetWorkspace(workspace().id);
                          setWorkspaceMenuId(null);
                        }}
                      >
                        Remove workspace
                      </button>
                    </div>
                  </Show>
                </div>

                <div class="ml-7 mt-1 space-y-1.5 border-l-2 border-dls-border pl-4">
                  <Show
                    when={isWorkspaceExpanded(workspace().id)}
                    fallback={
                      <Show when={group.sessions.length > 0}>
                        <For each={previewSessions(workspace().id, group.sessions)}>
                          {(session) => {
                            const isSelected = () => props.selectedSessionId === session.id;
                            const isSessionActive = () => (props.sessionStatusById?.[session.id] ?? "idle") !== "idle";
                            return (
                              <div
                                role="button"
                                tabIndex={0}
                                class={`group flex min-h-11 w-full items-center justify-between rounded-[16px] border px-3.5 py-3 transition-[background-color,border-color,box-shadow] ${
                                  isSelected()
                                    ? "border-dls-border bg-dls-surface text-dls-text shadow-[var(--dls-card-shadow)]"
                                    : "border-transparent text-gray-11 hover:bg-gray-2/60"
                                }`}
                                onClick={() => props.onOpenSession(workspace().id, session.id)}
                                onKeyDown={(event) => {
                                  if (event.key !== "Enter" && event.key !== " ") return;
                                  if (event.isComposing || event.keyCode === 229) return;
                                  event.preventDefault();
                                  props.onOpenSession(workspace().id, session.id);
                                }}
                              >
                                <div class="mr-3 flex min-w-0 items-center gap-2">
                                  <Show when={isSessionActive()}>
                                    <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-9" />
                                  </Show>
                                  <span class="truncate text-[14px] font-medium text-current">{session.title}</span>
                                </div>
                                <Show when={session.time?.updated}>
                                  <span class="whitespace-nowrap text-[12px] text-gray-9 transition-colors group-hover:text-gray-10">
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
                                class={`w-full rounded-[16px] border px-3.5 py-3 text-left text-xs ${
                                  taskLoadError().tone === "offline"
                                    ? "border-amber-7/35 bg-amber-2/50 text-amber-11"
                                    : "border-red-7/35 bg-red-1/40 text-red-11"
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
                              const isSessionActive = () => (props.sessionStatusById?.[session.id] ?? "idle") !== "idle";
                              return (
                                <div
                                  role="button"
                                  tabIndex={0}
                                  class={`group flex min-h-11 w-full items-center justify-between rounded-[16px] border px-3.5 py-3 transition-[background-color,border-color,box-shadow] ${
                                    isSelected()
                                      ? "border-dls-border bg-dls-surface text-dls-text shadow-[var(--dls-card-shadow)]"
                                      : "border-transparent text-gray-11 hover:bg-gray-2/60"
                                  }`}
                                  onClick={() => props.onOpenSession(workspace().id, session.id)}
                                  onKeyDown={(event) => {
                                    if (event.key !== "Enter" && event.key !== " ") return;
                                    if (event.isComposing || event.keyCode === 229) return;
                                    event.preventDefault();
                                    props.onOpenSession(workspace().id, session.id);
                                  }}
                                >
                                  <div class="mr-3 flex min-w-0 items-center gap-2">
                                    <Show when={isSessionActive()}>
                                      <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-9" />
                                    </Show>
                                    <span class="truncate text-[14px] font-medium text-current">{session.title}</span>
                                  </div>
                                  <Show when={session.time?.updated}>
                                    <span class="whitespace-nowrap text-[12px] text-gray-9 transition-colors group-hover:text-gray-10">
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
                              class="group/empty w-full rounded-[16px] border border-transparent px-3.5 py-3 text-left text-xs text-gray-10 transition-colors hover:bg-gray-2/60 hover:text-gray-11"
                              onClick={() => props.onCreateTaskInWorkspace(workspace().id)}
                              disabled={props.newTaskDisabled}
                            >
                              <span class="group-hover/empty:hidden">No tasks yet.</span>
                              <span class="hidden group-hover/empty:inline font-medium">+ New task</span>
                            </button>
                          </Show>

                          <Show when={group.sessions.length > previewCount(workspace().id)}>
                            <button
                              type="button"
                              class="w-full rounded-[16px] border border-transparent px-3.5 py-3 text-left text-xs text-gray-10 transition-colors hover:bg-gray-2/60 hover:text-gray-11"
                              onClick={() => showMoreSessions(workspace().id, group.sessions.length)}
                            >
                              {showMoreLabel(workspace().id, group.sessions.length)}
                            </button>
                          </Show>
                        </Show>
                      }
                    >
                      <div class="w-full rounded-[16px] px-3.5 py-3 text-left text-xs text-gray-10">
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
          class="w-full flex items-center justify-center gap-2 rounded-[18px] border border-dls-border bg-dls-surface px-4 py-3 text-[13px] font-medium text-gray-11 shadow-[var(--dls-card-shadow)] transition-colors hover:bg-gray-2"
          onClick={() => setAddWorkspaceMenuOpen((prev) => !prev)}
        >
          <Plus size={14} />
          Add a worker
        </button>

        <Show when={addWorkspaceMenuOpen()}>
          <div class="absolute left-0 right-0 top-full z-20 mt-2 overflow-hidden rounded-[18px] border border-dls-border bg-dls-surface p-1.5 shadow-[var(--dls-shell-shadow)]">
            <button
              type="button"
              class="w-full flex items-center gap-2 rounded-xl px-3 py-2 text-xs text-gray-11 transition-colors hover:bg-gray-2 hover:text-gray-12"
              onClick={() => {
                props.onOpenCreateWorkspace();
                setAddWorkspaceMenuOpen(false);
              }}
            >
              <Plus size={12} />
              New worker
            </button>
            <button
              type="button"
              class="w-full flex items-center gap-2 rounded-xl px-3 py-2 text-xs text-gray-11 transition-colors hover:bg-gray-2 hover:text-gray-12"
              onClick={() => {
                props.onOpenCreateRemoteWorkspace();
                setAddWorkspaceMenuOpen(false);
              }}
            >
              <Plus size={12} />
              Connect remote
            </button>
            <button
              type="button"
              class="w-full flex items-center gap-2 rounded-xl px-3 py-2 text-xs text-gray-11 transition-colors hover:bg-gray-2 hover:text-gray-12 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={props.importingWorkspaceConfig}
              onClick={() => {
                props.onImportWorkspaceConfig();
                setAddWorkspaceMenuOpen(false);
              }}
            >
              <Plus size={12} />
              Import config
            </button>
          </div>
        </Show>
      </div>
    </>
  );
}
