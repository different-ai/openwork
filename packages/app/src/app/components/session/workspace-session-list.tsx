import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { ChevronDown, ChevronRight, HeartPulse, Loader2, MoreHorizontal, Plus } from "lucide-solid";

import type { OpenworkSoulStatus } from "../../lib/openwork-server";
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
  soulStatusByWorkspaceId: Record<string, OpenworkSoulStatus | null>;
  onActivateWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  onOpenSession: (workspaceId: string, sessionId: string) => void;
  onCreateTaskInWorkspace: (workspaceId: string) => void;
  onOpenRenameWorkspace: (workspaceId: string) => void;
  onShareWorkspace: (workspaceId: string) => void;
  onOpenSoul: (workspaceId: string) => void;
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
      <div class="space-y-5 mb-3">
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
            const soulStatus = () => props.soulStatusByWorkspaceId[workspace().id] ?? null;
            const soulEnabled = () => Boolean(soulStatus()?.enabled);

            return (
              <div class="space-y-2">
                <div class="relative group">
                  <div
                    role="button"
                    tabIndex={0}
                    class="w-full flex items-center justify-between min-h-11 px-3 rounded-xl text-left transition-colors text-gray-12 hover:bg-gray-3/70"
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
                    <button
                      type="button"
                      class="mr-2 -ml-1 p-1 rounded-md text-gray-9 hover:text-gray-11 hover:bg-gray-4/80"
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
                      <div class="text-[14px] font-medium truncate">{workspaceLabel(workspace())}</div>
                      <div class="text-[11px] text-gray-10 flex items-center gap-1.5">
                        <span>{workspaceKindLabel(workspace())}</span>
                        <Show when={soulEnabled()}>
                          <span class="inline-flex items-center gap-1 rounded-full border border-ruby-7 bg-ruby-3 px-1.5 py-0.5 text-[10px] text-ruby-11">
                            <HeartPulse size={10} />
                            Soul
                          </span>
                        </Show>
                      </div>
                    </div>

                    <Show when={group.status === "loading"}>
                      <Loader2 size={14} class="animate-spin text-gray-10 mr-1" />
                    </Show>

                    <Show when={group.status === "error"}>
                      <span
                        class={`text-[10px] px-2 py-0.5 rounded-full border ${
                          taskLoadError().tone === "offline"
                            ? "border-amber-7 text-amber-11 bg-amber-3"
                            : "border-red-7 text-red-11 bg-red-3"
                        }`}
                        title={taskLoadError().title}
                      >
                        {taskLoadError().label}
                      </span>
                    </Show>

                    <Show when={isConnecting()}>
                      <Loader2 size={14} class="animate-spin text-gray-10" />
                    </Show>
                  </div>

                  <div class="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                    <button
                      type="button"
                      class="p-1 rounded-md text-gray-9 hover:text-gray-11 hover:bg-gray-4/80"
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
                      class="p-1 rounded-md text-gray-9 hover:text-gray-11 hover:bg-gray-4/80"
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

                  <Show when={isMenuOpen()}>
                    <div
                      ref={(el) => (workspaceMenuRef = el)}
                      class="absolute right-2 top-[calc(100%+4px)] z-20 w-44 rounded-lg border border-gray-6 bg-gray-1 shadow-lg p-1"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3"
                        onClick={() => {
                          props.onOpenRenameWorkspace(workspace().id);
                          setWorkspaceMenuId(null);
                        }}
                      >
                        Edit name
                      </button>
                      <button
                        type="button"
                        class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3"
                        onClick={() => {
                          props.onShareWorkspace(workspace().id);
                          setWorkspaceMenuId(null);
                        }}
                      >
                        Share...
                      </button>
                      <button
                        type="button"
                        class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3"
                        onClick={() => {
                          props.onOpenSoul(workspace().id);
                          setWorkspaceMenuId(null);
                        }}
                      >
                        {soulEnabled() ? "Soul settings" : "Enable soul"}
                      </button>
                      <Show when={workspace().workspaceType === "local"}>
                        <button
                          type="button"
                          class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3"
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
                            class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3"
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
                          class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3"
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
                          class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3"
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
                        class="w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3 text-red-11"
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

                <div class="mt-0.5 space-y-0.5 border-l border-gray-6 ml-2">
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
                                class={`group flex items-center justify-between min-h-9 px-3 rounded-lg cursor-pointer relative overflow-hidden ml-2 w-[calc(100%-0.5rem)] ${
                                  isSelected() ? "bg-gray-4/90 text-gray-12" : "hover:bg-gray-3/70"
                                }`}
                                onClick={() => props.onOpenSession(workspace().id, session.id)}
                                onKeyDown={(event) => {
                                  if (event.key !== "Enter" && event.key !== " ") return;
                                  if (event.isComposing || event.keyCode === 229) return;
                                  event.preventDefault();
                                  props.onOpenSession(workspace().id, session.id);
                                }}
                              >
                                <div class="flex min-w-0 items-center gap-1.5 mr-2">
                                  <Show when={isSessionActive()}>
                                    <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-9" />
                                  </Show>
                                  <span class="text-[13px] text-gray-11 truncate font-medium">{session.title}</span>
                                </div>
                                <Show when={session.time?.updated}>
                                  <span class="text-[11px] text-gray-9 whitespace-nowrap group-hover:text-gray-10 transition-colors">
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
                                    ? "text-amber-11 bg-amber-3 border-amber-7"
                                    : "text-red-11 bg-red-3 border-red-7"
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
                                  class={`group flex items-center justify-between min-h-9 px-3 rounded-lg cursor-pointer relative overflow-hidden ml-2 w-[calc(100%-0.5rem)] ${
                                    isSelected() ? "bg-gray-4/90 text-gray-12" : "hover:bg-gray-3/70"
                                  }`}
                                  onClick={() => props.onOpenSession(workspace().id, session.id)}
                                  onKeyDown={(event) => {
                                    if (event.key !== "Enter" && event.key !== " ") return;
                                    if (event.isComposing || event.keyCode === 229) return;
                                    event.preventDefault();
                                    props.onOpenSession(workspace().id, session.id);
                                  }}
                                >
                                  <div class="flex min-w-0 items-center gap-1.5 mr-2">
                                    <Show when={isSessionActive()}>
                                      <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-9" />
                                    </Show>
                                    <span class="text-[13px] text-gray-11 truncate font-medium">{session.title}</span>
                                  </div>
                                  <Show when={session.time?.updated}>
                                    <span class="text-[11px] text-gray-9 whitespace-nowrap group-hover:text-gray-10 transition-colors">
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
                              class="group/empty w-full px-3 py-2 text-xs text-gray-10 ml-2 text-left rounded-lg hover:bg-gray-3/70 hover:text-gray-11 transition-colors"
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
                              class="ml-2 w-[calc(100%-0.5rem)] px-3 py-2 text-xs text-gray-10 hover:text-gray-11 hover:bg-gray-3/70 rounded-lg transition-colors text-left"
                              onClick={() => showMoreSessions(workspace().id, group.sessions.length)}
                            >
                              {showMoreLabel(workspace().id, group.sessions.length)}
                            </button>
                          </Show>
                        </Show>
                      }
                    >
                      <div class="w-full px-3 py-2 text-xs text-gray-10 ml-2 text-left rounded-lg">
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
          class="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-[13px] font-medium text-gray-11 border border-gray-6 bg-gray-1 hover:bg-gray-2 shadow-sm transition-colors"
          onClick={() => setAddWorkspaceMenuOpen((prev) => !prev)}
        >
          <Plus size={14} />
          Add a worker
        </button>

        <Show when={addWorkspaceMenuOpen()}>
          <div class="absolute left-0 right-0 top-full mt-2 rounded-lg border border-gray-6 bg-gray-1 shadow-xl overflow-hidden z-20">
            <button
              type="button"
              class="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-11 hover:text-gray-12 hover:bg-gray-3 transition-colors"
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
              class="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-11 hover:text-gray-12 hover:bg-gray-3 transition-colors"
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
              class="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-11 hover:text-gray-12 hover:bg-gray-3 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
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
