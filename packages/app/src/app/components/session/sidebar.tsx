import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Check, ChevronDown, GripVertical, Loader2, Plus, RefreshCcw, Settings, Square, Trash2 } from "lucide-solid";

import type { TodoItem, WorkspaceConnectionState } from "../../types";
import type { WorkspaceInfo } from "../../lib/tauri";

type SessionSummary = {
  id: string;
  title: string;
  slug?: string | null;
};

type WorkspaceSessionGroup = {
  workspace: WorkspaceInfo;
  sessions: SessionSummary[];
};

export type SidebarSectionState = {
  progress: boolean;
  artifacts: boolean;
  context: boolean;
  plugins: boolean;
  mcp: boolean;
  skills: boolean;
  authorizedFolders: boolean;
};

export type SidebarProps = {
  todos: TodoItem[];
  expandedSections: SidebarSectionState;
  onToggleSection: (section: keyof SidebarSectionState) => void;
  workspaceGroups: WorkspaceSessionGroup[];
  activeWorkspaceId: string;
  connectingWorkspaceId?: string | null;
  workspaceConnectionStateById: Record<string, WorkspaceConnectionState>;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: () => void;
  onCreateRemoteWorkspace: () => void;
  onImportWorkspace: () => void;
  importingWorkspaceConfig?: boolean;
  onEditWorkspace: (workspaceId: string) => void;
  onTestWorkspaceConnection: (workspaceId: string) => void;
  onForgetWorkspace: (workspaceId: string) => void;
  onStopSandbox?: (workspaceId: string) => void;
  onReorderWorkspace: (fromId: string, toId: string | null) => void;
  onSelectSession: (workspaceId: string, sessionId: string) => void;
  selectedSessionId: string | null;
  sessionStatusById: Record<string, string>;
  onCreateSession: () => void;
  onDeleteSession: (id: string) => void;
  newTaskDisabled: boolean;
};

export default function SessionSidebar(props: SidebarProps) {
  const MAX_SESSIONS_PREVIEW = 8;
  const realTodos = createMemo(() => props.todos.filter((todo) => todo.content.trim()));
  const WORKSPACE_COLLAPSE_KEY = "openwork.workspace-collapse.v1";
  const readWorkspaceCollapse = () => {
    if (typeof window === "undefined") return {} as Record<string, boolean>;
    try {
      const raw = window.localStorage.getItem(WORKSPACE_COLLAPSE_KEY);
      if (!raw) return {} as Record<string, boolean>;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return {} as Record<string, boolean>;
      return parsed as Record<string, boolean>;
    } catch {
      return {} as Record<string, boolean>;
    }
  };
  const writeWorkspaceCollapse = (next: Record<string, boolean>) => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(WORKSPACE_COLLAPSE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  };
  const [collapsedById, setCollapsedById] = createSignal<Record<string, boolean>>(readWorkspaceCollapse());
  const [draggingWorkspaceId, setDraggingWorkspaceId] = createSignal<string | null>(null);
  const [dragOverWorkspaceId, setDragOverWorkspaceId] = createSignal<string | null>(null);
  const [showAllSessionsByWorkspaceId, setShowAllSessionsByWorkspaceId] = createSignal<
    Record<string, boolean>
  >({});
  const [addWorkspaceMenuOpen, setAddWorkspaceMenuOpen] = createSignal(false);
  let addWorkspaceMenuRef: HTMLDivElement | undefined;

  const workspaceLabel = (workspace: WorkspaceInfo) =>
    workspace.displayName?.trim() ||
    workspace.openworkWorkspaceName?.trim() ||
    workspace.name?.trim() ||
    workspace.path?.trim() ||
    "Worker";

  const workspacePathLabel = (workspace: WorkspaceInfo) => {
    if (workspace.workspaceType === "remote") {
      if (workspace.remoteType === "openwork") {
        return (
          workspace.openworkHostUrl?.trim() ||
          workspace.baseUrl?.trim() ||
          workspace.path?.trim() ||
          ""
        );
      }
      return workspace.baseUrl?.trim() || workspace.path?.trim() || "";
    }
    return workspace.path?.trim() || "";
  };

  const workspaceDetailLabel = (workspace: WorkspaceInfo) => {
    if (workspace.workspaceType !== "remote") return "";
    return workspace.openworkWorkspaceName?.trim() || workspace.directory?.trim() || "";
  };

  const toggleWorkspaceCollapse = (workspaceId: string) => {
    setCollapsedById((prev) => {
      const next = { ...prev, [workspaceId]: !prev[workspaceId] };
      writeWorkspaceCollapse(next);
      return next;
    });
  };

  const isWorkspaceCollapsed = (workspaceId: string) => Boolean(collapsedById()[workspaceId]);
  const isShowingAllSessions = (workspaceId: string) =>
    Boolean(showAllSessionsByWorkspaceId()[workspaceId]);
  const toggleShowAllSessions = (workspaceId: string) => {
    setShowAllSessionsByWorkspaceId((prev) => ({
      ...prev,
      [workspaceId]: !prev[workspaceId],
    }));
  };

  const handleDragStart = (event: DragEvent, workspaceId: string) => {
    event.dataTransfer?.setData("text/plain", workspaceId);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
    }
    setDraggingWorkspaceId(workspaceId);
  };

  const handleDragOver = (event: DragEvent, workspaceId: string | null) => {
    if (!draggingWorkspaceId()) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    setDragOverWorkspaceId(workspaceId);
  };

  const handleDragLeave = (workspaceId: string | null) => {
    if (dragOverWorkspaceId() === workspaceId) {
      setDragOverWorkspaceId(null);
    }
  };

  const handleDrop = (event: DragEvent, workspaceId: string | null) => {
    event.preventDefault();
    const dragId = draggingWorkspaceId() ?? event.dataTransfer?.getData("text/plain") ?? null;
    if (!dragId) return;
    if (workspaceId && dragId === workspaceId) {
      setDraggingWorkspaceId(null);
      setDragOverWorkspaceId(null);
      return;
    }
    props.onReorderWorkspace(dragId, workspaceId);
    setDraggingWorkspaceId(null);
    setDragOverWorkspaceId(null);
  };

  const handleDragEnd = () => {
    setDraggingWorkspaceId(null);
    setDragOverWorkspaceId(null);
  };

  const progressDots = createMemo(() => {
    const activeTodos = realTodos();
    const total = activeTodos.length;
    if (!total) return [] as boolean[];
    const completed = activeTodos.filter((todo) => todo.status === "completed").length;
    return Array.from({ length: total }, (_, idx) => idx < completed);
  });

  const [contextMenu, setContextMenu] = createSignal<null | {
    sessionId: string;
    x: number;
    y: number;
  }>(null);
  let contextMenuRef: HTMLDivElement | undefined;
  const [contextMenuSize, setContextMenuSize] = createSignal({ width: 188, height: 96 });

  const closeContextMenu = () => setContextMenu(null);

  const openContextMenu = (event: MouseEvent, sessionId: string) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ sessionId, x: event.clientX, y: event.clientY });
  };

  const contextMenuStyle = createMemo(() => {
    const menu = contextMenu();
    if (!menu) return undefined;
    const size = contextMenuSize();
    const width = size.width;
    const height = size.height;
    if (typeof window === "undefined") {
      return { left: `${menu.x}px`, top: `${menu.y}px` };
    }
    const maxX = Math.max(12, window.innerWidth - width - 12);
    const maxY = Math.max(12, window.innerHeight - height - 12);
    return {
      left: `${Math.min(menu.x, maxX)}px`,
      top: `${Math.min(menu.y, maxY)}px`,
    };
  });

  createEffect(() => {
    if (!contextMenu()) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeContextMenu();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  createEffect(() => {
    const ids = new Set(props.workspaceGroups.map((group) => group.workspace.id));
    setCollapsedById((prev) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [id, value] of Object.entries(prev)) {
        if (ids.has(id)) {
          next[id] = value;
        } else {
          changed = true;
        }
      }
      if (!changed) return prev;
      writeWorkspaceCollapse(next);
      return next;
    });
    setShowAllSessionsByWorkspaceId((prev) => {
      const next: Record<string, boolean> = {};
      let changed = false;
      for (const [id, value] of Object.entries(prev)) {
        if (ids.has(id)) {
          next[id] = value;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  });

  createEffect(() => {
    if (!contextMenu()) return;
    queueMicrotask(() => {
      if (!contextMenuRef || typeof window === "undefined") return;
      const rect = contextMenuRef.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      setContextMenuSize({ width: rect.width, height: rect.height });
    });
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

  return (
    <div class="flex flex-col h-full overflow-hidden">
      <div class="px-4 pt-4 shrink-0">
        <button
          class="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl bg-gray-12 text-gray-1 text-sm font-medium shadow-lg shadow-gray-12/10 hover:bg-gray-11 transition-colors"
          onClick={props.onCreateSession}
          disabled={props.newTaskDisabled}
        >
          <Plus size={16} />
          New task
        </button>
      </div>

      <div class="flex-1 overflow-y-auto px-4 py-4 space-y-6">
        <div>
          <div class="flex items-center justify-between px-2 mb-2">
            <div class="text-xs text-gray-10 font-semibold uppercase tracking-wider">Workspaces</div>
          </div>
          <div class="space-y-4">
            <Show
              when={props.workspaceGroups.length > 0}
              fallback={
                <div class="px-3 py-2 rounded-lg border border-dashed border-gray-6 text-xs text-gray-9">
                  No workspaces in this session yet. Add one to get started.
                </div>
              }
            >
              <For each={props.workspaceGroups}>
                {(group) => {
                  const isActive = () => props.activeWorkspaceId === group.workspace.id;
                  const isConnecting = () => props.connectingWorkspaceId === group.workspace.id;
                  const pathLabel = () => workspacePathLabel(group.workspace);
                  const detailLabel = () => workspaceDetailLabel(group.workspace);
                  const isSandboxWorkspace = () =>
                    group.workspace.workspaceType === "remote" &&
                    (group.workspace.sandboxBackend === "docker" ||
                      Boolean(group.workspace.sandboxRunId?.trim()) ||
                      Boolean(group.workspace.sandboxContainerName?.trim()));
                  const sessions = () => group.sessions;
                  const allowActions = () => !props.connectingWorkspaceId || isConnecting();
                  const connectionState = () => props.workspaceConnectionStateById[group.workspace.id];
                  const connectionStatus = () => connectionState()?.status ?? "idle";
                  const connectionMessage = () => connectionState()?.message?.trim() ?? "";
                  const connectionDotClass = () => {
                    if (connectionStatus() === "connected") return "bg-green-9";
                    if (connectionStatus() === "connecting") return "bg-amber-9 animate-pulse";
                    if (connectionStatus() === "error") return "bg-red-9";
                    return "bg-gray-7";
                  };
                  const collapsed = () => isWorkspaceCollapsed(group.workspace.id);
                  const dragOver = () => dragOverWorkspaceId() === group.workspace.id;
                  const showingAll = () => isShowingAllSessions(group.workspace.id);
                  const visibleSessions = () =>
                    showingAll() ? sessions() : sessions().slice(0, MAX_SESSIONS_PREVIEW);
                  const hasMoreSessions = () => sessions().length > MAX_SESSIONS_PREVIEW;

                  return (
                    <div
                      class={`space-y-2 rounded-lg border transition-colors overflow-hidden ${
                        isActive()
                          ? "border-indigo-7/40 bg-indigo-2/20"
                          : "border-gray-6/40 bg-transparent"
                      } ${isConnecting() ? "opacity-70" : ""} ${dragOver() ? "ring-1 ring-indigo-7/50" : ""}`.trim()}
                      onDragOver={(event) => handleDragOver(event, group.workspace.id)}
                      onDragLeave={() => handleDragLeave(group.workspace.id)}
                      onDrop={(event) => handleDrop(event, group.workspace.id)}
                    >
                      <div class="flex items-start gap-2 px-2 py-2">
                        <button
                          type="button"
                          class={`flex-1 text-left rounded-md px-1.5 py-1 transition-colors ${
                            isActive()
                              ? "text-gray-12"
                              : "text-gray-11 hover:text-gray-12 hover:bg-gray-2"
                          }`}
                          onClick={() => {
                            if (isActive() || isConnecting()) return;
                            if (!allowActions()) return;
                            props.onSelectWorkspace(group.workspace.id);
                          }}
                          disabled={isActive() || isConnecting() || !allowActions()}
                        >
                          <div class="flex items-start justify-between gap-2">
                            <div class="min-w-0 space-y-0.5">
                              <div class="flex items-center gap-2">
                                <span class={`h-2 w-2 rounded-full ${connectionDotClass()}`} />
                                <span class="text-xs font-semibold truncate">
                                  {workspaceLabel(group.workspace)}
                                </span>
                                <Show when={group.workspace.workspaceType === "remote"}>
                                  <span class="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-gray-3 text-gray-11">
                                    {isSandboxWorkspace() ? "Sandbox" : "Remote"}
                                  </span>
                                </Show>
                              </div>
                              <Show when={pathLabel()}>
                                <div class="text-[9px] text-gray-8/80 font-mono truncate">{pathLabel()}</div>
                              </Show>
                              <Show when={detailLabel() && detailLabel() !== pathLabel()}>
                                <div class="text-[9px] text-gray-7/80 truncate">{detailLabel()}</div>
                              </Show>
                            </div>
                            <div class="flex items-center gap-2 text-[10px] shrink-0">
                              <Show when={isConnecting() || connectionStatus() === "connecting"}>
                                <Loader2 size={12} class="text-gray-10 animate-spin" />
                              </Show>
                              <Show when={!isConnecting() && connectionStatus() !== "connecting"}>
                                <Show when={connectionStatus() === "error"}>
                                  <span class="text-red-11 font-medium">Needs attention</span>
                                </Show>
                                <Show when={connectionStatus() !== "error"}>
                                  <Show when={isActive()} fallback={<span class="text-gray-9">Switch</span>}>
                                    <span class="text-green-11 font-medium">Active</span>
                                  </Show>
                                </Show>
                              </Show>
                            </div>
                          </div>
                        </button>
                        <div class="flex flex-col items-center gap-1">
                          <button
                            type="button"
                            class="p-1 rounded-md text-gray-9 hover:text-gray-12 hover:bg-gray-2"
                            onClick={() => toggleWorkspaceCollapse(group.workspace.id)}
                            title={collapsed() ? "Expand" : "Collapse"}
                          >
                            <ChevronDown
                              size={14}
                              class={`${collapsed() ? "-rotate-90" : "rotate-0"} transition-transform`}
                            />
                          </button>
                          <button
                            type="button"
                            class="p-1 rounded-md text-gray-9 hover:text-gray-12 hover:bg-gray-2 cursor-grab"
                            title="Drag to reorder"
                            draggable
                            onDragStart={(event) => handleDragStart(event, group.workspace.id)}
                            onDragEnd={handleDragEnd}
                          >
                            <GripVertical size={14} />
                          </button>
                        </div>
                      </div>
                      <Show when={!collapsed()}>
                        <div class="space-y-1 pl-2 pb-2">
                          <Show when={connectionStatus() === "error" && connectionMessage()}>
                            <div class="mx-3 rounded-lg border border-red-7/30 bg-red-1/40 px-3 py-2 text-[11px] text-red-11">
                              {connectionMessage()}
                            </div>
                          </Show>
                          <div class="flex flex-wrap gap-2 px-3 pb-1">
                            <Show when={group.workspace.workspaceType === "remote"}>
                              <button
                                type="button"
                                class="inline-flex items-center gap-1.5 rounded-md border border-gray-6 px-2 py-1 text-[10px] text-gray-10 hover:text-gray-12 hover:border-gray-7 hover:bg-gray-2 transition-colors"
                                onClick={() => props.onEditWorkspace(group.workspace.id)}
                                disabled={isConnecting()}
                              >
                                <Settings size={12} />
                                Edit connection
                              </button>
                              <button
                                type="button"
                                class="inline-flex items-center gap-1.5 rounded-md border border-gray-6 px-2 py-1 text-[10px] text-gray-10 hover:text-gray-12 hover:border-gray-7 hover:bg-gray-2 transition-colors"
                                onClick={() => props.onTestWorkspaceConnection(group.workspace.id)}
                                disabled={isConnecting()}
                              >
                                <RefreshCcw size={12} class={connectionStatus() === "connecting" ? "animate-spin" : ""} />
                                Test connection
                              </button>
                            </Show>
                            <Show when={group.workspace.sandboxContainerName?.trim() && props.onStopSandbox}>
                              <button
                                type="button"
                                class="inline-flex items-center gap-1.5 rounded-md border border-gray-6 px-2 py-1 text-[10px] text-gray-10 hover:text-gray-12 hover:border-gray-7 hover:bg-gray-2 transition-colors"
                                onClick={() => props.onStopSandbox?.(group.workspace.id)}
                                disabled={isConnecting()}
                              >
                                <Square size={12} />
                                Stop sandbox
                              </button>
                            </Show>
                            <button
                              type="button"
                              class="inline-flex items-center gap-1.5 rounded-md border border-gray-6 px-2 py-1 text-[10px] text-gray-10 hover:text-gray-12 hover:border-gray-7 hover:bg-gray-2 transition-colors"
                              onClick={() => props.onForgetWorkspace(group.workspace.id)}
                              disabled={isConnecting()}
                            >
                              <Trash2 size={12} />
                              Remove
                            </button>
                          </div>
                          <Show
                            when={sessions().length > 0}
                            fallback={
                              <div class="px-3 py-2 rounded-lg border border-dashed border-gray-6 text-xs text-gray-9">
                                No sessions yet.
                              </div>
                            }
                          >
                            <For each={visibleSessions()}>
                              {(session) => (
                                <button
                                  class={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                                    session.id === props.selectedSessionId
                                      ? "bg-gray-3 text-gray-12 font-medium"
                                      : "text-gray-11 hover:text-gray-12 hover:bg-gray-2"
                                  } ${!allowActions() ? "opacity-70" : ""}`}
                                  onClick={() => {
                                    if (!allowActions()) return;
                                    props.onSelectSession(group.workspace.id, session.id);
                                  }}
                                  onContextMenu={(event) => {
                                    if (!isActive()) return;
                                    openContextMenu(event, session.id);
                                  }}
                                  disabled={!allowActions()}
                                >
                                  <div class="flex items-center justify-between gap-2 w-full overflow-hidden">
                                    <div class="truncate">{session.title}</div>
                                    <Show
                                      when={
                                        props.sessionStatusById[session.id] &&
                                        props.sessionStatusById[session.id] !== "idle"
                                      }
                                    >
                                      <span
                                        class={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full border flex items-center gap-1 ${
                                          props.sessionStatusById[session.id] === "running"
                                            ? "border-amber-7/50 text-amber-11 bg-amber-2/50"
                                            : "border-gray-7/50 text-gray-10 bg-gray-2/50"
                                        }`}
                                      >
                                        <div
                                          class={`w-1 h-1 rounded-full ${
                                            props.sessionStatusById[session.id] === "running"
                                              ? "bg-amber-9 animate-pulse"
                                              : "bg-gray-9"
                                          }`}
                                        />
                                      </span>
                                    </Show>
                                  </div>
                                </button>
                              )}
                            </For>
                            <Show when={hasMoreSessions()}>
                              <button
                                type="button"
                                class="w-full px-3 py-2 rounded-lg text-xs text-gray-9 hover:text-gray-12 hover:bg-gray-2 transition-colors"
                                onClick={() => toggleShowAllSessions(group.workspace.id)}
                              >
                                {showingAll()
                                  ? "Show fewer"
                                  : `Show ${sessions().length - MAX_SESSIONS_PREVIEW} more`}
                              </button>
                            </Show>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </Show>
            <div class="relative" ref={(el) => (addWorkspaceMenuRef = el)}>
              <button
                type="button"
                class="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-gray-11 border border-dashed border-gray-6 hover:border-gray-7 hover:text-gray-12 hover:bg-gray-2 transition-colors"
                onClick={() => setAddWorkspaceMenuOpen((prev) => !prev)}
                onDragOver={(event) => handleDragOver(event, null)}
                onDragLeave={() => handleDragLeave(null)}
                onDrop={(event) => handleDrop(event, null)}
              >
                <Plus size={14} />
                Add new workspace
              </button>
              <Show when={addWorkspaceMenuOpen()}>
                <div class="mt-2 rounded-lg border border-gray-6 bg-gray-1 shadow-lg overflow-hidden">
                  <button
                    type="button"
                    class="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-11 hover:bg-gray-2 transition-colors"
                    onClick={() => {
                      props.onCreateWorkspace();
                      setAddWorkspaceMenuOpen(false);
                    }}
                  >
                    <Plus size={12} />
                    New worker
                  </button>
                  <button
                    type="button"
                    class="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-11 hover:bg-gray-2 transition-colors"
                    onClick={() => {
                      props.onCreateRemoteWorkspace();
                      setAddWorkspaceMenuOpen(false);
                    }}
                  >
                    <Plus size={12} />
                    Connect remote
                  </button>
                  <button
                    type="button"
                    class="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-11 hover:bg-gray-2 transition-colors disabled:opacity-60"
                    disabled={props.importingWorkspaceConfig}
                    onClick={() => {
                      props.onImportWorkspace();
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
        </div>

        <div class="space-y-4">
          <Show when={realTodos().length > 0}>
            <div class="rounded-2xl border border-gray-6 bg-gray-2/30" id="sidebar-progress">
              <button
                class="w-full px-4 py-3 flex items-center justify-between text-sm text-gray-12 font-medium"
                onClick={() => props.onToggleSection("progress")}
              >
                <span>Progress</span>
                <ChevronDown
                  size={16}
                  class={`transition-transform text-gray-10 ${
                    props.expandedSections.progress ? "rotate-180" : ""
                  }`.trim()}
                />
              </button>
              <Show when={props.expandedSections.progress}>
                <div class="px-4 pb-4 pt-1">
                  <div class="flex items-center gap-2 flex-wrap">
                    <For each={progressDots()}>
                      {(done) => (
                        <div
                          class={`h-6 w-6 rounded-full border flex items-center justify-center transition-colors ${
                            done
                              ? "border-green-6 bg-green-2 text-green-11"
                              : "border-gray-6 bg-gray-1 text-gray-8"
                          }`}
                        >
                          <Show when={done}>
                            <Check size={14} />
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </div>

      <Show when={contextMenu()}>
        {(menu) => (
          <div
            class="fixed inset-0 z-50"
            onClick={closeContextMenu}
            onContextMenu={(event) => {
              event.preventDefault();
              closeContextMenu();
            }}
          >
            <div
              class="fixed w-44 rounded-xl border border-gray-6 bg-gray-1 shadow-2xl shadow-gray-12/10 p-1"
              style={contextMenuStyle()}
              role="menu"
              onClick={(event) => event.stopPropagation()}
              ref={(el) => (contextMenuRef = el)}
            >
              <button
                class="w-full text-left px-3 py-2 text-sm rounded-lg text-gray-12 hover:bg-gray-2 transition-colors"
                role="menuitem"
                onClick={() => {
                  props.onCreateSession();
                  closeContextMenu();
                }}
              >
                New task
              </button>
              <button
                class="w-full text-left px-3 py-2 text-sm rounded-lg text-red-11 hover:bg-red-1/40 transition-colors"
                role="menuitem"
                onClick={() => {
                  props.onDeleteSession(menu().sessionId);
                  closeContextMenu();
                }}
              >
                Delete session
              </button>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
