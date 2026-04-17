/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, MoreHorizontal, Plus } from "lucide-react";

import { getDisplaySessionTitle } from "../../../../app/lib/session-title";
import type { WorkspaceInfo } from "../../../../app/lib/tauri";
import type {
  WorkspaceConnectionState,
  WorkspaceSessionGroup,
} from "../../../../app/types";
import {
  getWorkspaceTaskLoadErrorDisplay,
  isSandboxWorkspace,
  isWindowsPlatform,
} from "../../../../app/utils";
import { t } from "../../../../i18n";

type Props = {
  workspaceSessionGroups: WorkspaceSessionGroup[];
  showInitialLoading?: boolean;
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
  onRecoverWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  onTestWorkspaceConnection: (workspaceId: string) => Promise<boolean> | boolean | void;
  onEditWorkspaceConnection: (workspaceId: string) => void;
  onForgetWorkspace: (workspaceId: string) => void;
  onOpenCreateWorkspace: () => void;
};

const MAX_SESSIONS_PREVIEW = 6;

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
    const expanded = expandedSessionIds.has(session.id) || forcedExpandedSessionIds.has(session.id);
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
  t("workspace_list.workspace_fallback");

const workspaceKindLabel = (workspace: WorkspaceInfo) =>
  workspace.workspaceType === "remote"
    ? isSandboxWorkspace(workspace)
      ? t("workspace.sandbox_badge")
      : t("workspace.remote_badge")
    : t("workspace.local_badge");

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

export function WorkspaceSessionList(props: Props) {
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [previewCountByWorkspaceId, setPreviewCountByWorkspaceId] = useState<Record<string, number>>({});
  const [workspaceMenuId, setWorkspaceMenuId] = useState<string | null>(null);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const workspaceMenuRef = useRef<HTMLDivElement | null>(null);
  const sessionMenuRef = useRef<HTMLDivElement | null>(null);

  const revealLabel = isWindowsPlatform()
    ? t("workspace_list.reveal_explorer")
    : t("workspace_list.reveal_finder");

  const expandWorkspace = (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    setExpandedWorkspaceIds((previous) => {
      if (previous.has(id)) return previous;
      const next = new Set(previous);
      next.add(id);
      return next;
    });
  };

  const toggleWorkspaceExpanded = (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    setExpandedWorkspaceIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  useEffect(() => {
    const id = props.selectedWorkspaceId.trim();
    if (!id) return;
    // Keep the selected workspace expanded and collapse the rest by default.
    // Without this, repeated switching leaves multiple large session trees open
    // at once, which makes the sidebar increasingly expensive to render as
    // histories grow.
    setExpandedWorkspaceIds((previous) => {
      if (previous.size === 1 && previous.has(id)) return previous;
      return new Set([id]);
    });
  }, [props.selectedWorkspaceId]);

  const previewCount = (workspaceId: string) =>
    previewCountByWorkspaceId[workspaceId] ?? MAX_SESSIONS_PREVIEW;

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
    return nextCount > 0
      ? t("workspace_list.show_more", undefined, { count: nextCount })
      : t("workspace_list.show_more_fallback");
  };

  const toggleSessionExpanded = (sessionId: string) => {
    const id = sessionId.trim();
    if (!id) return;
    setExpandedSessionIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  useEffect(() => {
    if (!workspaceMenuId) return;
    const closeMenu = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && workspaceMenuRef.current?.contains(target)) return;
      setWorkspaceMenuId(null);
    };
    window.addEventListener("pointerdown", closeMenu);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
    };
  }, [workspaceMenuId]);

  useEffect(() => {
    setSessionMenuOpen(false);
  }, [props.selectedSessionId]);

  useEffect(() => {
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
  }, [
    props.onPrefetchSession,
    props.selectedSessionId,
    props.selectedWorkspaceId,
    props.workspaceSessionGroups,
  ]);

  useEffect(() => {
    if (!sessionMenuOpen) return;
    const closeMenu = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && sessionMenuRef.current?.contains(target)) return;
      setSessionMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeMenu);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
    };
  }, [sessionMenuOpen]);

  const renderSessionRow = (
    workspaceId: string,
    row: FlattenedSessionRow,
    tree: SessionTreeState,
    forcedExpandedSessionIds: Set<string>,
  ) => {
    const session = row.session;
    const isSelected = props.selectedSessionId === session.id;
    const displayTitle = getDisplaySessionTitle(session.title);
    const hasChildren = (tree.descendantCountBySessionId.get(session.id) ?? 0) > 0;
    const isExpanded = expandedSessionIds.has(session.id) || forcedExpandedSessionIds.has(session.id);
    const isSessionActive = tree.activeIds.has(session.id);
    const canManageSession = Boolean(
      props.showSessionActions &&
      isSelected &&
      (props.onOpenRenameSession || props.onOpenDeleteSession),
    );

    const openSession = () => {
      setSessionMenuOpen(false);
      props.onOpenSession(workspaceId, session.id);
    };

    const prefetchSession = () => {
      if (workspaceId !== props.selectedWorkspaceId) return;
      props.onPrefetchSession?.(workspaceId, session.id);
    };

    return (
      <div key={session.id} className="relative">
        <div
          role="button"
          tabIndex={0}
          className={`group flex min-h-9 w-full items-center justify-between rounded-xl px-3 py-1.5 text-left text-[13px] transition-colors ${
            isSelected
              ? "bg-gray-3 text-gray-12"
              : "text-gray-10 hover:bg-gray-1/70 hover:text-gray-11"
          }`}
          style={{ marginLeft: `${Math.min(row.depth, 4) * 16}px` }}
          onPointerEnter={prefetchSession}
          onFocus={prefetchSession}
          onClick={openSession}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            openSession();
          }}
        >
          <div className="mr-2.5 flex min-w-0 flex-1 items-center gap-2">
            {hasChildren ? (
              <button
                type="button"
                className="-ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-9 transition-colors hover:bg-gray-3/80 hover:text-gray-11"
                aria-label={isExpanded ? t("workspace_list.hide_child_sessions") : t("workspace_list.show_child_sessions")}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  toggleSessionExpanded(session.id);
                }}
              >
                {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
            ) : row.depth > 0 ? (
              <span className="h-[1px] w-3 shrink-0 rounded-full bg-dls-border" />
            ) : null}

            {isSessionActive ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-9" /> : null}
            <span
              className={`block min-w-0 truncate ${
                isSelected ? "font-medium text-gray-12" : "font-normal text-current"
              }`}
              title={displayTitle}
            >
              {displayTitle}
            </span>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1">
            {canManageSession ? (
              <button
                type="button"
                className="flex h-7 w-7 items-center justify-center rounded-md text-gray-9 transition-colors hover:bg-gray-3/80 hover:text-gray-11"
                aria-label={t("workspace_list.session_actions")}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setSessionMenuOpen((current) => !current);
                }}
              >
                <MoreHorizontal size={14} />
              </button>
            ) : null}
          </div>
        </div>

        {canManageSession && sessionMenuOpen ? (
          <div
            ref={sessionMenuRef}
            className="absolute right-0 top-[calc(100%+6px)] z-20 w-48 rounded-[18px] border border-dls-border bg-dls-surface p-1.5 shadow-[var(--dls-shell-shadow)]"
            onClick={(event) => event.stopPropagation()}
          >
            {props.onOpenRenameSession ? (
              <button
                type="button"
                className="w-full rounded-xl px-3 py-2 text-left text-sm text-gray-11 transition-colors hover:bg-gray-2"
                onClick={() => {
                  setSessionMenuOpen(false);
                  props.onOpenRenameSession?.();
                }}
              >
                {t("workspace_list.rename_session")}
              </button>
            ) : null}

            {props.onOpenDeleteSession ? (
              <button
                type="button"
                className="w-full rounded-xl px-3 py-2 text-left text-sm text-red-11 transition-colors hover:bg-red-1/40"
                onClick={() => {
                  setSessionMenuOpen(false);
                  props.onOpenDeleteSession?.();
                }}
              >
                {t("workspace_list.delete_session")}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto pr-1">
        <div className="space-y-2 pb-3">
          {props.workspaceSessionGroups.map((group) => {
            const tree = buildSessionTreeState(group.sessions, props.sessionStatusById);
            const forcedExpandedSessionIds = new Set(
              props.selectedSessionId
                ? tree.ancestorIdsBySessionId.get(props.selectedSessionId) ?? []
                : [],
            );
            const workspace = group.workspace;
            const isConnecting = props.connectingWorkspaceId === workspace.id;
            const connectionState = props.workspaceConnectionStateById[workspace.id] ?? {
              status: "idle" as const,
              message: null,
            };
            const isConnectionActionBusy =
              isConnecting || connectionState.status === "connecting";
            const canRecover =
              workspace.workspaceType === "remote" && connectionState.status === "error";
            const isMenuOpen = workspaceMenuId === workspace.id;
            const taskLoadError = getWorkspaceTaskLoadErrorDisplay(workspace, group.error);
            const statusLabel = (() => {
              if (group.status === "error") return taskLoadError.label;
              if (isConnectionActionBusy) return t("workspace_list.connecting");
              if (!props.developerMode) return "";
              if (props.selectedWorkspaceId === workspace.id) return t("workspace.selected");
              return workspaceKindLabel(workspace);
            })();
            const statusTone = group.status === "error"
              ? taskLoadError.tone === "offline"
                ? "text-amber-11"
                : "text-red-11"
              : "text-gray-9";
            const rootSessions = getRootSessions(group.sessions);
            const sessionRows = flattenSessionRows(
              group.sessions,
              previewCount(workspace.id),
              tree,
              expandedSessionIds,
              forcedExpandedSessionIds,
            );

            return (
              <div key={workspace.id} className="space-y-2">
                <div className="relative group">
                  <div
                    role="button"
                    tabIndex={0}
                    className={`w-full flex items-center justify-between rounded-xl px-3.5 py-2.5 text-left text-[13px] transition-colors ${
                      props.selectedWorkspaceId === workspace.id
                        ? "bg-gray-2/70 text-gray-12"
                        : "text-gray-10 hover:bg-gray-1/70 hover:text-gray-12"
                    } ${isConnecting ? "opacity-75" : ""}`}
                    onClick={() => {
                      expandWorkspace(workspace.id);
                      void Promise.resolve(props.onSelectWorkspace(workspace.id));
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                      event.preventDefault();
                      expandWorkspace(workspace.id);
                      void Promise.resolve(props.onSelectWorkspace(workspace.id));
                    }}
                  >
                    <div className="flex min-w-0 items-center gap-3.5">
                      <div
                        className="flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-full"
                        style={{
                          backgroundColor: workspaceSwatchColor(workspace.id || workspaceLabel(workspace)),
                        }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="min-w-0 truncate text-[14px] font-normal text-dls-text">
                          {workspaceLabel(workspace)}
                        </div>
                        {statusLabel ? (
                          <div className={`mt-0.5 text-[11px] ${statusTone}`}>{statusLabel}</div>
                        ) : null}
                      </div>
                    </div>

                    <div className="ml-4 flex shrink-0 items-center gap-1.5">
                      {group.status === "loading" || isConnecting ? (
                        <Loader2 size={14} className="animate-spin text-gray-9" />
                      ) : null}

                      <div
                        className={`items-center gap-0.5 ${
                          props.selectedWorkspaceId === workspace.id
                            ? "flex"
                            : "hidden group-hover:flex group-focus-within:flex"
                        }`}
                      >
                        <button
                          type="button"
                          className="rounded-md p-1 text-gray-9 hover:bg-gray-3/80 hover:text-gray-11"
                          onClick={(event) => {
                            event.stopPropagation();
                            props.onCreateTaskInWorkspace(workspace.id);
                          }}
                          disabled={props.newTaskDisabled}
                          aria-label={t("session.new_task")}
                        >
                          <Plus size={14} />
                        </button>

                        <button
                          type="button"
                          className="rounded-md p-1 text-gray-9 hover:bg-gray-3/80 hover:text-gray-11"
                          onClick={(event) => {
                            event.stopPropagation();
                            setWorkspaceMenuId((current) => (current === workspace.id ? null : workspace.id));
                          }}
                          aria-label={t("workspace_list.workspace_options")}
                        >
                          <MoreHorizontal size={14} />
                        </button>
                      </div>

                      <button
                        type="button"
                        className="rounded-md p-1 text-gray-9 hover:bg-gray-3/80 hover:text-gray-11"
                        aria-label={
                          expandedWorkspaceIds.has(workspace.id)
                            ? t("sidebar.collapse")
                            : t("sidebar.expand")
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleWorkspaceExpanded(workspace.id);
                        }}
                      >
                        {expandedWorkspaceIds.has(workspace.id) ? (
                          <ChevronDown size={14} />
                        ) : (
                          <ChevronRight size={14} />
                        )}
                      </button>
                    </div>
                  </div>

                  {isMenuOpen ? (
                    <div
                      ref={workspaceMenuRef}
                      className="absolute right-0 top-[calc(100%+6px)] z-20 w-48 rounded-[18px] border border-dls-border bg-dls-surface p-1.5 shadow-[var(--dls-shell-shadow)]"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="w-full rounded-xl px-3 py-2 text-left text-sm text-gray-11 transition-colors hover:bg-gray-2"
                        onClick={() => {
                          props.onOpenRenameWorkspace(workspace.id);
                          setWorkspaceMenuId(null);
                        }}
                      >
                        {t("workspace_list.edit_name")}
                      </button>
                      <button
                        type="button"
                        className="w-full rounded-xl px-3 py-2 text-left text-sm text-gray-11 transition-colors hover:bg-gray-2"
                        onClick={() => {
                          props.onShareWorkspace(workspace.id);
                          setWorkspaceMenuId(null);
                        }}
                      >
                        {t("workspace_list.share")}
                      </button>
                      {workspace.workspaceType === "local" ? (
                        <button
                          type="button"
                          className="w-full rounded-xl px-3 py-2 text-left text-sm text-gray-11 transition-colors hover:bg-gray-2"
                          onClick={() => {
                            props.onRevealWorkspace(workspace.id);
                            setWorkspaceMenuId(null);
                          }}
                        >
                          {revealLabel}
                        </button>
                      ) : null}
                      {workspace.workspaceType === "remote" ? (
                        <>
                          {canRecover ? (
                            <button
                              type="button"
                              className="w-full rounded-xl px-3 py-2 text-left text-sm text-gray-11 transition-colors hover:bg-gray-2"
                              onClick={() => {
                                void Promise.resolve(props.onRecoverWorkspace(workspace.id));
                                setWorkspaceMenuId(null);
                              }}
                              disabled={isConnectionActionBusy}
                            >
                              {t("workspace_list.recover")}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="w-full rounded-xl px-3 py-2 text-left text-sm text-gray-11 transition-colors hover:bg-gray-2"
                            onClick={() => {
                              void Promise.resolve(props.onTestWorkspaceConnection(workspace.id));
                              setWorkspaceMenuId(null);
                            }}
                            disabled={isConnectionActionBusy}
                          >
                            {t("workspace_list.test_connection")}
                          </button>
                          <button
                            type="button"
                            className="w-full rounded-xl px-3 py-2 text-left text-sm text-gray-11 transition-colors hover:bg-gray-2"
                            onClick={() => {
                              props.onEditWorkspaceConnection(workspace.id);
                              setWorkspaceMenuId(null);
                            }}
                            disabled={isConnectionActionBusy}
                          >
                            {t("workspace_list.edit_connection")}
                          </button>
                        </>
                      ) : null}
                      <button
                        type="button"
                        className="w-full rounded-xl px-3 py-2 text-left text-sm text-red-11 transition-colors hover:bg-red-1/40"
                        onClick={() => {
                          props.onForgetWorkspace(workspace.id);
                          setWorkspaceMenuId(null);
                        }}
                      >
                        {t("workspace_list.remove_workspace")}
                      </button>
                    </div>
                  ) : null}
                </div>

                {expandedWorkspaceIds.has(workspace.id) ? (
                  <div className="mt-3 px-1 pb-1">
                    <div className="relative flex flex-col gap-1 pl-2.5 before:absolute before:bottom-2 before:left-0 before:top-2 before:w-[2px] before:bg-gray-3 before:content-['']">
                      {props.showInitialLoading ? (
                        <div className="space-y-2">
                          {[0, 1, 2].map((idx) => (
                            <div
                              key={`${workspace.id}:skeleton:${idx}`}
                              className="w-full rounded-[15px] border border-dls-border/70 bg-dls-hover/30 px-3 py-2.5"
                            >
                              <div
                                className="h-2.5 rounded-full bg-dls-hover/80 animate-pulse"
                                style={{ width: idx === 0 ? "62%" : idx === 1 ? "78%" : "54%" }}
                              />
                            </div>
                          ))}
                        </div>
                      ) : group.status === "loading" && group.sessions.length === 0 ? (
                        <div className="w-full rounded-[15px] px-3 py-2.5 text-left text-[11px] text-gray-10">
                          {t("workspace.loading_tasks")}
                        </div>
                      ) : group.sessions.length > 0 ? (
                        <>
                          {sessionRows.map((row) => renderSessionRow(workspace.id, row, tree, forcedExpandedSessionIds))}

                          {group.sessions.length === 0 && group.status === "ready" ? (
                            <button
                              type="button"
                              className="group/empty w-full rounded-[15px] border border-transparent px-3 py-2.5 text-left text-[11px] text-gray-10 transition-colors hover:bg-gray-2/60 hover:text-gray-11"
                              onClick={() => props.onCreateTaskInWorkspace(workspace.id)}
                              disabled={props.newTaskDisabled}
                            >
                              <span className="group-hover/empty:hidden">{t("workspace.no_tasks")}</span>
                              <span className="hidden group-hover/empty:inline font-medium">
                                {t("workspace.new_task_inline")}
                              </span>
                            </button>
                          ) : null}

                          {rootSessions.length > previewCount(workspace.id) ? (
                            <button
                              type="button"
                              className="w-full rounded-[15px] border border-transparent px-3 py-2.5 text-left text-[11px] text-gray-10 transition-colors hover:bg-gray-2/60 hover:text-gray-11"
                              onClick={() => showMoreSessions(workspace.id, rootSessions.length)}
                            >
                              {showMoreLabel(workspace.id, rootSessions.length)}
                            </button>
                          ) : null}
                        </>
                      ) : group.status === "error" ? (
                        <div
                          className={`w-full rounded-[15px] border px-3 py-2.5 text-left text-[11px] ${
                            taskLoadError.tone === "offline"
                              ? "border-amber-7/35 bg-amber-2/50 text-amber-11"
                              : "border-red-7/35 bg-red-1/40 text-red-11"
                          }`}
                          title={taskLoadError.title}
                        >
                          {taskLoadError.message}
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="group/empty w-full rounded-[15px] border border-transparent px-3 py-2.5 text-left text-[11px] text-gray-10 transition-colors hover:bg-gray-2/60 hover:text-gray-11"
                          onClick={() => props.onCreateTaskInWorkspace(workspace.id)}
                          disabled={props.newTaskDisabled}
                        >
                          <span className="group-hover/empty:hidden">{t("workspace.no_tasks")}</span>
                          <span className="hidden group-hover/empty:inline font-medium">
                            {t("workspace.new_task_inline")}
                          </span>
                        </button>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <div className="relative mt-auto border-t border-dls-border/80 bg-dls-sidebar pt-3">
        <button
          type="button"
          className="w-full flex items-center justify-center gap-2 rounded-[18px] border border-dls-border bg-dls-surface px-3.5 py-2.5 text-[12px] font-medium text-gray-11 shadow-[var(--dls-card-shadow)] transition-colors hover:bg-gray-2"
          onClick={props.onOpenCreateWorkspace}
        >
          <Plus size={14} />
          {t("workspace_list.add_workspace")}
        </button>
      </div>
    </div>
  );
}
