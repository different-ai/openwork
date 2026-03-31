import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Plus,
} from "lucide-solid";

import { DEFAULT_SESSION_TITLE, getDisplaySessionTitle } from "../../lib/session-title";
import type { WorkspaceInfo } from "../../lib/tauri";
import type {
  WorkspaceConnectionState,
  WorkspaceSessionGroup,
} from "../../types";
import {
  formatRelativeTime,
  getWorkspaceTaskLoadErrorDisplay,
  isWindowsPlatform,
} from "../../utils";

type Props = {
  workspaceSessionGroups: WorkspaceSessionGroup[];
  selectedWorkspaceId: string;
  developerMode: boolean;
  selectedSessionId: string | null;
  showSessionActions?: boolean;
  sessionStatusById?: Record<string, string>;
  connectingWorkspaceId: string | null;
  workspaceConnectionStateById: Record<string, WorkspaceConnectionState>;
  newTaskDisabled: boolean;
  onSelectWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  onOpenSession: (workspaceId: string, sessionId: string) => void;
  onPrefetchSession?: (workspaceId: string, sessionId: string) => void;
  onCreateTaskInWorkspace: (workspaceId: string) => void;
  onOpenRenameSession?: () => void;
  onOpenDeleteSession?: () => void;
  onOpenRenameWorkspace: (workspaceId: string) => void;
  onShareWorkspace: (workspaceId: string) => void;
  onRevealWorkspace: (workspaceId: string) => void;
  onRecoverWorkspace: (
    workspaceId: string,
  ) => Promise<boolean> | boolean | void;
  onTestWorkspaceConnection: (
    workspaceId: string,
  ) => Promise<boolean> | boolean | void;
  onEditWorkspaceConnection: (workspaceId: string) => void;
  onForgetWorkspace: (workspaceId: string) => void;
  onOpenCreateWorkspace: () => void;
};

const MAX_SESSIONS_PREVIEW = 6;
const COLLAPSED_SESSIONS_PREVIEW = MAX_SESSIONS_PREVIEW;

type SessionListItem = WorkspaceSessionGroup["sessions"][number];
type FlattenedSessionRow = { session: SessionListItem; depth: number };
type SessionTreeState = {
  childrenByParent: Map<string, SessionListItem[]>;
  ancestorIdsBySessionId: Map<string, string[]>;
  descendantCountBySessionId: Map<string, number>;
  activeIds: Set<string>;
};

const normalizeSessionParentID = (session: SessionListItem) => {
  const parentID = session.parentID?.trim();
  return parentID || "";
};

const getRootSessions = (sessions: WorkspaceSessionGroup["sessions"]) => {
  const byID = new Set(sessions.map((session) => session.id));
  return sessions.filter((session) => {
    const parentID = normalizeSessionParentID(session);
    return !parentID || !byID.has(parentID);
  });
};

const buildSessionTreeState = (
  sessions: WorkspaceSessionGroup["sessions"],
  sessionStatusById: Record<string, string> | undefined,
): SessionTreeState => {
  const childrenByParent = new Map<string, SessionListItem[]>();
  const ancestorIdsBySessionId = new Map<string, string[]>();
  const descendantCountBySessionId = new Map<string, number>();
  const activeIds = new Set<string>();
  const sessionIds = new Set(sessions.map((session) => session.id));

  sessions.forEach((session) => {
    const parentID = normalizeSessionParentID(session);
    if (!parentID || !sessionIds.has(parentID)) return;
    const siblings = childrenByParent.get(parentID) ?? [];
    siblings.push(session);
    childrenByParent.set(parentID, siblings);
  });

  const walk = (session: SessionListItem, ancestors: string[]) => {
    ancestorIdsBySessionId.set(session.id, ancestors);
    const children = childrenByParent.get(session.id) ?? [];
    let descendantCount = 0;
    let subtreeActive = (sessionStatusById?.[session.id] ?? "idle") !== "idle";

    children.forEach((child) => {
      const childState = walk(child, [...ancestors, session.id]);
      descendantCount += 1 + childState.descendantCount;
      subtreeActive = subtreeActive || childState.subtreeActive;
    });

    descendantCountBySessionId.set(session.id, descendantCount);
    if (subtreeActive) activeIds.add(session.id);
    return { descendantCount, subtreeActive };
  };

  getRootSessions(sessions).forEach((session) => {
    walk(session, []);
  });

  return {
    childrenByParent,
    ancestorIdsBySessionId,
    descendantCountBySessionId,
    activeIds,
  };
};

const flattenSessionRows = (
  sessions: WorkspaceSessionGroup["sessions"],
  rootLimit: number,
  tree: SessionTreeState,
  expandedSessionIds: Set<string>,
  forcedExpandedSessionIds: Set<string>,
) => {
  const roots = getRootSessions(sessions).slice(0, rootLimit);
  const rows: FlattenedSessionRow[] = [];
  const visited = new Set<string>();

  const walk = (session: SessionListItem, depth: number) => {
    if (visited.has(session.id)) return;
    visited.add(session.id);
    rows.push({ session, depth });
    const children = tree.childrenByParent.get(session.id) ?? [];
    if (!children.length) return;
    const expanded =
      expandedSessionIds.has(session.id) || forcedExpandedSessionIds.has(session.id);
    if (!expanded) return;
    children.forEach((child) => walk(child, depth + 1));
  };

  roots.forEach((root) => walk(root, 0));
  return rows;
};

const workspaceLabel = (workspace: WorkspaceInfo) =>
  workspace.displayName?.trim() ||
  workspace.openworkWorkspaceName?.trim() ||
  workspace.name?.trim() ||
  workspace.path?.trim() ||
  "Workspace";

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
  const value = seed.trim() || "workspace";
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return WORKSPACE_SWATCHES[Math.abs(hash) % WORKSPACE_SWATCHES.length];
};

export default function WorkspaceSessionList(props: Props) {
  const revealLabel = isWindowsPlatform()
    ? "Reveal in Explorer"
    : "Reveal in Finder";
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = createSignal<
    Set<string>
  >(new Set());
  const [previewCountByWorkspaceId, setPreviewCountByWorkspaceId] =
    createSignal<Record<string, number>>({});
  const [workspaceMenuId, setWorkspaceMenuId] = createSignal<string | null>(
    null,
  );
  const [sessionMenuOpen, setSessionMenuOpen] = createSignal(false);
  const [expandedSessionIds, setExpandedSessionIds] = createSignal<Set<string>>(
    new Set(),
  );
  let workspaceMenuRef: HTMLDivElement | undefined;
  let sessionMenuRef: HTMLDivElement | undefined;

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
    expandWorkspace(props.selectedWorkspaceId);
  });

  createEffect(() => {
    expandWorkspace(props.selectedWorkspaceId);
  });

  const previewCount = (workspaceId: string) => {
    const base =
      previewCountByWorkspaceId()[workspaceId] ?? MAX_SESSIONS_PREVIEW;
    return isWorkspaceExpanded(workspaceId)
      ? base
      : Math.min(COLLAPSED_SESSIONS_PREVIEW, base);
  };

  const previewSessions = (
    workspaceId: string,
    sessions: WorkspaceSessionGroup["sessions"],
    tree: SessionTreeState,
    forcedExpandedSessionIds: Set<string>,
  ) =>
    flattenSessionRows(
      sessions,
      previewCount(workspaceId),
      tree,
      expandedSessionIds(),
      forcedExpandedSessionIds,
    );

  const toggleSessionExpanded = (sessionId: string) => {
    const id = sessionId.trim();
    if (!id) return;
    setExpandedSessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const showMoreSessions = (workspaceId: string, totalRoots: number) => {
    expandWorkspace(workspaceId);
    setPreviewCountByWorkspaceId((current) => {
      const next = { ...current };
      const existing = next[workspaceId] ?? MAX_SESSIONS_PREVIEW;
      next[workspaceId] = Math.min(existing + MAX_SESSIONS_PREVIEW, totalRoots);
      return next;
    });
  };

  const showMoreLabel = (workspaceId: string, totalRoots: number) => {
    const remaining = Math.max(0, totalRoots - previewCount(workspaceId));
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
    props.selectedSessionId;
    setSessionMenuOpen(false);
  });

  createEffect(() => {
    const workspaceId = props.selectedWorkspaceId.trim();
    if (!workspaceId) return;

    const group = props.workspaceSessionGroups.find(
      (entry) => entry.workspace.id === workspaceId,
    );
    if (!group?.sessions.length) return;

    const selectedId = props.selectedSessionId?.trim() ?? "";
    const selectedIndex = selectedId
      ? group.sessions.findIndex((session) => session.id === selectedId)
      : -1;
    const start = selectedIndex >= 0 ? Math.max(0, selectedIndex - 2) : 0;
    const end = selectedIndex >= 0
      ? Math.min(group.sessions.length, selectedIndex + 3)
      : Math.min(group.sessions.length, 4);

    group.sessions.slice(start, end).forEach((session) => {
      props.onPrefetchSession?.(workspaceId, session.id);
    });
  });

  createEffect(() => {
    if (!sessionMenuOpen()) return;
    const closeMenu = (event: PointerEvent) => {
      if (!sessionMenuRef) return;
      const target = event.target as Node | null;
      if (target && sessionMenuRef.contains(target)) return;
      setSessionMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeMenu);
    onCleanup(() => window.removeEventListener("pointerdown", closeMenu));
  });

  const renderSessionRow = (
    workspaceId: string,
    row: FlattenedSessionRow,
    tree: SessionTreeState,
    forcedExpandedSessionIds: Set<string>,
  ) => {
    const session = () => row.session;
    const depth = () => row.depth;
    const isSelected = () => props.selectedSessionId === session().id;
    const displayTitle = () =>
      getDisplaySessionTitle(session().title, DEFAULT_SESSION_TITLE);
    const hasChildren = () =>
      (tree.descendantCountBySessionId.get(session().id) ?? 0) > 0;
    const hiddenChildCount = () =>
      tree.descendantCountBySessionId.get(session().id) ?? 0;
    const isExpanded = () =>
      expandedSessionIds().has(session().id) ||
      forcedExpandedSessionIds.has(session().id);
    const isSessionActive = () => tree.activeIds.has(session().id);
    const canManageSession = () =>
      Boolean(
        props.showSessionActions &&
        isSelected() &&
        (props.onOpenRenameSession || props.onOpenDeleteSession),
      );

    const openSession = () => {
      setSessionMenuOpen(false);
      props.onOpenSession(workspaceId, session().id);
    };

    const prefetchSession = () => {
      if (workspaceId !== props.selectedWorkspaceId) return;
      props.onPrefetchSession?.(workspaceId, session().id);
    };

    return (
      <div class="relative">
        <div
          role="button"
          tabIndex={0}
          class={`group flex min-h-9 w-full items-center justify-between rounded-xl px-3 py-1.5 text-left text-[13px] transition-colors ${
            isSelected()
              ? "bg-gray-3 text-gray-12"
              : "text-gray-10 hover:bg-gray-1/70 hover:text-gray-11"
          }`}
          style={{ "margin-left": `${Math.min(depth(), 4) * 16}px` }}
          onPointerEnter={prefetchSession}
          onFocusIn={prefetchSession}
          onClick={openSession}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            if (event.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            openSession();
          }}
        >
          <div class="mr-2.5 flex min-w-0 flex-1 items-center gap-2">
            <Show
              when={hasChildren()}
              fallback={
                <Show when={depth() > 0}>
                  <span class="h-[1px] w-3 shrink-0 rounded-full bg-dls-border" />
                </Show>
              }
            >
              <button
                type="button"
                class="-ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-9 transition-colors hover:bg-gray-3/80 hover:text-gray-11"
                aria-label={isExpanded() ? "Hide child sessions" : "Show child sessions"}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  toggleSessionExpanded(session().id);
                }}
              >
                <Show when={isExpanded()} fallback={<ChevronRight size={13} />}>
                  <ChevronDown size={13} />
                </Show>
              </button>
            </Show>
            <Show when={isSessionActive()}>
              <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-9" />
            </Show>
            <span
              class={`block min-w-0 truncate ${
                isSelected() ? "font-medium text-gray-12" : "font-normal text-current"
              }`}
              title={displayTitle()}
            >
              {displayTitle()}
            </span>
          </div>

          <div class="ml-auto flex shrink-0 items-center gap-1">
            <Show when={canManageSession()}>
              <button
                type="button"
                class="flex h-7 w-7 items-center justify-center rounded-md text-gray-9 transition-colors hover:bg-gray-3/80 hover:text-gray-11"
                aria-label="Session actions"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setSessionMenuOpen((current) => !current);
                }}
              >
                <MoreHorizontal size={14} />
              </button>
            </Show>
          </div>
        </div>

        <Show when={canManageSession() && sessionMenuOpen()}>
          <div
            ref={(el) => (sessionMenuRef = el)}
            class="absolute right-0 top-[calc(100%+6px)] z-20 w-48 rounded-[18px] border border-dls-border bg-dls-surface p-1.5 shadow-[var(--dls-shell-shadow)]"
            onClick={(event) => event.stopPropagation()}
          >
            <Show when={props.onOpenRenameSession}>
              <button
                type="button"
                class="w-full rounded-xl px-3 py-2 text-left text-sm text-gray-11 transition-colors hover:bg-gray-2"
                onClick={() => {
                  setSessionMenuOpen(false);
                  props.onOpenRenameSession?.();
                }}
              >
                Rename session
              </button>
            </Show>

            <Show when={props.onOpenDeleteSession}>
              <button
                type="button"
                class="w-full rounded-xl px-3 py-2 text-left text-sm text-red-11 transition-colors hover:bg-red-1/40"
                onClick={() => {
                  setSessionMenuOpen(false);
                  props.onOpenDeleteSession?.();
                }}
              >
                Delete session
              </button>
            </Show>
          </div>
        </Show>
      </div>
    );
  };

  return (
    <div class="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div class="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto pr-1">
        <div class="space-y-2 pb-3">
        <For each={props.workspaceSessionGroups}>
          {(group) => {
            const tree = buildSessionTreeState(
              group.sessions,
              props.sessionStatusById,
            );
            const forcedExpandedSessionIds = new Set(
              props.selectedSessionId
                ? tree.ancestorIdsBySessionId.get(props.selectedSessionId) ?? []
                : [],
            );
            const workspace = () => group.workspace;
            const isConnecting = () =>
              props.connectingWorkspaceId === workspace().id;
            const connectionState = () =>
              props.workspaceConnectionStateById[workspace().id] ?? {
                status: "idle",
                message: null,
              };
            const isConnectionActionBusy = () =>
              isConnecting() || connectionState().status === "connecting";
            const canRecover = () =>
              workspace().workspaceType === "remote" &&
              connectionState().status === "error";
            const isMenuOpen = () => workspaceMenuId() === workspace().id;
            const taskLoadError = () =>
              getWorkspaceTaskLoadErrorDisplay(workspace(), group.error);
            const statusLabel = () => {
              if (group.status === "error") return taskLoadError().label;
              if (isConnectionActionBusy()) return "Connecting";
              if (!props.developerMode) return "";
              if (props.selectedWorkspaceId === workspace().id) return "Selected";
              return workspaceKindLabel(workspace());
            };
            const statusTone = () => {
              if (group.status === "error") {
                return taskLoadError().tone === "offline"
                  ? "text-amber-11"
                  : "text-red-11";
              }
              return "text-gray-9";
            };

            return (
              <div class="space-y-2">
                <div class="relative group">
                  <div
                    role="button"
                    tabIndex={0}
                    class={`w-full flex items-center justify-between rounded-xl px-3.5 py-2.5 text-left text-[13px] transition-colors ${
                      props.selectedWorkspaceId === workspace().id
                        ? "bg-gray-2/70 text-gray-12"
                        : "text-gray-10 hover:bg-gray-1/70 hover:text-gray-12"
                    } ${isConnecting() ? "opacity-75" : ""}`}
                    onClick={() => {
                      expandWorkspace(workspace().id);
                      void Promise.resolve(
                        props.onSelectWorkspace(workspace().id),
                      );
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      if (event.isComposing || event.keyCode === 229) return;
                      event.preventDefault();
                      expandWorkspace(workspace().id);
                      void Promise.resolve(
                        props.onSelectWorkspace(workspace().id),
                      );
                    }}
                   >
                     <div class="flex min-w-0 items-center gap-3.5">
                        <div
                          class="flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-full"
                         style={{
                           "background-color": workspaceSwatchColor(
                             workspace().id || workspaceLabel(workspace()),
                           ),
                         }}
                       />
                       <div class="min-w-0 flex-1">
                         <div class="min-w-0 truncate text-[14px] font-normal text-dls-text">
                           {workspaceLabel(workspace())}
                         </div>
                         <Show when={statusLabel()}>
                           <div class={`mt-0.5 text-[11px] ${statusTone()}`}>
                             {statusLabel()}
                           </div>
                         </Show>
                       </div>
                     </div>

                     <div class="ml-4 flex shrink-0 items-center gap-1.5">
                       <Show when={group.status === "loading" || isConnecting()}>
                         <Loader2 size={14} class="animate-spin text-gray-9" />
                       </Show>

                      <div class="hidden items-center gap-0.5 group-hover:flex group-focus-within:flex">
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
                              current === workspace().id
                                ? null
                                : workspace().id,
                            );
                          }}
                          aria-label="Workspace options"
                        >
                          <MoreHorizontal size={14} />
                        </button>
                      </div>

                      <button
                        type="button"
                        class="rounded-md p-1 text-gray-9 hover:bg-gray-3/80 hover:text-gray-11"
                        aria-label={
                          isWorkspaceExpanded(workspace().id)
                            ? "Collapse"
                            : "Expand"
                        }
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
                              void Promise.resolve(
                                props.onRecoverWorkspace(workspace().id),
                              );
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
                            void Promise.resolve(
                              props.onTestWorkspaceConnection(workspace().id),
                            );
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

                <div class="mt-3 px-1 pb-1">
                  <div class="relative flex flex-col gap-1 pl-2.5 before:absolute before:bottom-2 before:left-0 before:top-2 before:w-[2px] before:bg-gray-3 before:content-['']">
                   <Show
                     when={isWorkspaceExpanded(workspace().id)}
                     fallback={
                       <Show when={group.sessions.length > 0}>
                          <For
                            each={previewSessions(
                              workspace().id,
                              group.sessions,
                              tree,
                              forcedExpandedSessionIds,
                            )}
                          >
                            {(row) =>
                              renderSessionRow(
                                workspace().id,
                                row,
                                tree,
                                forcedExpandedSessionIds,
                              )}
                          </For>

                          <Show
                            when={
                              getRootSessions(group.sessions).length >
                              previewCount(workspace().id)
                            }
                          >
                            <button
                              type="button"
                              class="w-full rounded-[15px] border border-transparent px-3 py-2.5 text-left text-[11px] text-gray-10 transition-colors hover:bg-gray-2/60 hover:text-gray-11"
                              onClick={() =>
                                showMoreSessions(
                                  workspace().id,
                                  getRootSessions(group.sessions).length,
                                )
                              }
                            >
                              {showMoreLabel(
                                workspace().id,
                                getRootSessions(group.sessions).length,
                              )}
                            </button>
                          </Show>
                        </Show>
                      }
                    >
                    <Show
                      when={
                        group.status === "loading" &&
                        group.sessions.length === 0
                      }
                      fallback={
                        <Show
                          when={group.sessions.length > 0}
                          fallback={
                            <Show when={group.status === "error"}>
                              <div
                                class={`w-full rounded-[15px] border px-3 py-2.5 text-left text-[11px] ${
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
                          <For
                            each={previewSessions(
                              workspace().id,
                              group.sessions,
                              tree,
                              forcedExpandedSessionIds,
                            )}
                          >
                            {(row) =>
                              renderSessionRow(
                                workspace().id,
                                row,
                                tree,
                                forcedExpandedSessionIds,
                              )}
                          </For>

                          <Show
                            when={
                              group.sessions.length === 0 &&
                              group.status === "ready"
                            }
                          >
                            <button
                              type="button"
                              class="group/empty w-full rounded-[15px] border border-transparent px-3 py-2.5 text-left text-[11px] text-gray-10 transition-colors hover:bg-gray-2/60 hover:text-gray-11"
                              onClick={() =>
                                props.onCreateTaskInWorkspace(workspace().id)
                              }
                              disabled={props.newTaskDisabled}
                            >
                              <span class="group-hover/empty:hidden">
                                No tasks yet.
                              </span>
                              <span class="hidden group-hover/empty:inline font-medium">
                                + New task
                              </span>
                            </button>
                          </Show>

                          <Show
                            when={
                              getRootSessions(group.sessions).length >
                              previewCount(workspace().id)
                            }
                          >
                            <button
                              type="button"
                              class="w-full rounded-[15px] border border-transparent px-3 py-2.5 text-left text-[11px] text-gray-10 transition-colors hover:bg-gray-2/60 hover:text-gray-11"
                              onClick={() =>
                                showMoreSessions(
                                  workspace().id,
                                  getRootSessions(group.sessions).length,
                                )
                              }
                            >
                              {showMoreLabel(
                                workspace().id,
                                getRootSessions(group.sessions).length,
                              )}
                            </button>
                          </Show>
                        </Show>
                      }
                    >
                      <div class="w-full rounded-[15px] px-3 py-2.5 text-left text-[11px] text-gray-10">
                        Loading tasks...
                      </div>
                    </Show>
                  </Show>
                  </div>
                </div>
              </div>
            );
          }}
        </For>
        </div>
      </div>

      <div class="relative mt-auto border-t border-dls-border/80 bg-dls-sidebar pt-3">
        <button
          type="button"
          class="w-full flex items-center justify-center gap-2 rounded-[18px] border border-dls-border bg-dls-surface px-3.5 py-2.5 text-[12px] font-medium text-gray-11 shadow-[var(--dls-card-shadow)] transition-colors hover:bg-gray-2"
          onClick={props.onOpenCreateWorkspace}
        >
          <Plus size={14} />
          Add workspace
        </button>
      </div>
    </div>
  );
}
