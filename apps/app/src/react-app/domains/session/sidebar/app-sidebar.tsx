/** @jsxImportSource react */
import * as React from "react";
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  ChevronRight,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Share2,
  Trash2,
  RefreshCw,
  RotateCcw,
  Settings,
  FolderOpen,
  Tag,
} from "lucide-react";
import { LazyMotion, Reorder, domMax, m, useDragControls } from "motion/react";

import { getDisplaySessionTitle } from "../../../../app/lib/session-title";
import type { WorkspaceInfo } from "../../../../app/lib/desktop";
import { OpenWorkDenHelpLink } from "../../workspace/openwork-den-help-link";
import type {
  WorkspaceConnectionState,
  WorkspaceSessionGroup,
} from "../../../../app/types";
import {
  isRemoteConnectionErrorMessage,
  getWorkspaceTaskLoadErrorDisplay,
  isRemoteConnectionWorkspace,
  isWindowsPlatform,
} from "../../../../app/utils";
import { t } from "../../../../i18n";

import {
  Sidebar,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

import { SidebarContext, useSidebarContext } from "./app-sidebar-provider";
import type { SidebarContextValue } from "./app-sidebar-provider";
import {
  MAX_SESSIONS_PREVIEW,
  buildSessionTreeState,
  flattenSessionRows,
  getRootSessions,
  isSessionArchived,
  isStreamingSessionStatus,
  partitionArchivedSessions,
  workspaceKindLabel,
  workspaceLabel,
} from "./utils";
import type { FlattenedSessionRow, SessionListItem, SessionTreeState } from "./utils";
import {
  useSessionManagementStore,
  usePinnedSessionIds,
  useSessionOrder,
  useWorkspaceGroups,
  type SessionGroupDefinition,
} from "./session-management-store";
import { cn } from "@/lib/utils";
import { WorkspaceIcon } from "../../../design-system/workspace-icon";
import { getSessionActivityStatusLabel, type SessionActivityStatus } from "../status/session-activity-store";

interface SessionStatusIndicatorProps {
  className?: string;
  status?: string;
  isStreaming: boolean;
  isActive: boolean;
}

function SessionStatusIndicator({ className, status, isStreaming, isActive }: SessionStatusIndicatorProps) {
  const activityTitle = isSessionActivityStatus(status) && status !== "idle"
    ? getSessionActivityStatusLabel(status)
    : undefined;
  const title = activityTitle ?? (isStreaming ? t("workspace_list.session_streaming") : t("workspace_list.session_active"));

  if (isStreaming) {
    return (
      <span
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center",
          status === "waiting" && "text-sky-9",
          status === "error" && "text-red-9",
          className,
        )}
        title={title}
        aria-label={title}
      >
        <Loader2 className="size-3.5 animate-spin" />
      </span>
    );
  }

  if (isActive) {
    return (
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          status === "waiting" && "bg-sky-9",
          status === "error" && "bg-red-9",
          className,
        )}
        title={title}
        aria-label={title}
      />
    );
  }

  return null;
}

function useCanManageSession() {
  // Pin and group actions come from the Zustand store (always available).
  // Rename/delete/archive depend on wired callbacks but the menu should
  // always render so pin/group remain accessible.
  return true;
}

type SessionActionsProps = {
  className: string;
  sessionId: string;
  workspaceId: string;
  isPinned: boolean;
  isArchived: boolean;
};

type SessionMenuContentProps = {
  variant: "dropdown" | "context";
  sessionId: string;
  workspaceId: string;
  isPinned: boolean;
  isArchived: boolean;
};

function SessionMenuContent({ variant, sessionId, workspaceId, isPinned, isArchived }: SessionMenuContentProps) {
  const ctx = useSidebarContext();
  const { groups, assignments } = useWorkspaceGroups(workspaceId);
  const store = useSessionManagementStore;
  const assignedGroupId = assignments[sessionId] ?? null;

  if (variant === "dropdown") {
    return (
      <>
        <DropdownMenuItem onClick={() => store.getState().togglePin(sessionId)}>
          {isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
          {isPinned ? t("session_management.unpin_session") : t("session_management.pin_session")}
        </DropdownMenuItem>
        {ctx.onOpenRenameSession ? (
          <DropdownMenuItem onClick={() => ctx.onOpenRenameSession?.(sessionId)}>
            <Pencil className="size-4" />
            {t("workspace_list.rename_session")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Tag className="size-4" />
            {t("session_management.move_to_group")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            {groups.length === 0 ? (
              <DropdownMenuItem onClick={() => ctx.onOpenCreateGroupModal?.(workspaceId)}>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {t("session_management.no_groups_yet")}
                </span>
                <span className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-foreground">
                  <Plus className="size-3.5" />
                </span>
              </DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem
                  onClick={() => store.getState().assignGroup(workspaceId, sessionId, null)}
                  disabled={!assignedGroupId}
                >
                  {t("session_management.no_group")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {groups.map((group) => (
                  <DropdownMenuItem
                    key={group.id}
                    onClick={() => store.getState().assignGroup(workspaceId, sessionId, group.id)}
                    disabled={assignedGroupId === group.id}
                  >
                    {group.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => ctx.onOpenCreateGroupModal?.(workspaceId)}>
                  <FolderPlus className="size-4" />
                  {t("session_management.new_group")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {ctx.onArchiveSession ? (
          <DropdownMenuItem onClick={() => ctx.onArchiveSession?.(sessionId, !isArchived)}>
            {isArchived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
            {isArchived ? t("session_management.unarchive_session") : t("session_management.archive_session")}
          </DropdownMenuItem>
        ) : null}
        {ctx.onOpenDeleteSession ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => ctx.onOpenDeleteSession?.(sessionId)}>
              <Trash2 className="size-4" />
              {t("workspace_list.delete_session")}
            </DropdownMenuItem>
          </>
        ) : null}
      </>
    );
  }

  return (
    <>
      <ContextMenuItem onClick={() => store.getState().togglePin(sessionId)}>
        {isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
        {isPinned ? t("session_management.unpin_session") : t("session_management.pin_session")}
      </ContextMenuItem>
      {ctx.onOpenRenameSession ? (
        <ContextMenuItem onClick={() => ctx.onOpenRenameSession?.(sessionId)}>
          <Pencil className="size-4" />
          {t("workspace_list.rename_session")}
        </ContextMenuItem>
      ) : null}
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Tag className="mr-2 size-4" />
          {t("session_management.move_to_group")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {groups.length === 0 ? (
            <ContextMenuItem onClick={() => ctx.onOpenCreateGroupModal?.(workspaceId)}>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {t("session_management.no_groups_yet")}
              </span>
              <span className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-foreground">
                <Plus className="size-3.5" />
              </span>
            </ContextMenuItem>
          ) : (
            <>
              <ContextMenuItem
                onClick={() => store.getState().assignGroup(workspaceId, sessionId, null)}
                disabled={!assignedGroupId}
              >
                {t("session_management.no_group")}
              </ContextMenuItem>
              <ContextMenuSeparator />
              {groups.map((group) => (
                <ContextMenuItem
                  key={group.id}
                  onClick={() => store.getState().assignGroup(workspaceId, sessionId, group.id)}
                  disabled={assignedGroupId === group.id}
                >
                  {group.label}
                </ContextMenuItem>
              ))}
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => ctx.onOpenCreateGroupModal?.(workspaceId)}>
                <FolderPlus className="size-4" />
                {t("session_management.new_group")}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuSubContent>
      </ContextMenuSub>
      {ctx.onArchiveSession ? (
        <ContextMenuItem onClick={() => ctx.onArchiveSession?.(sessionId, !isArchived)}>
          {isArchived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
          {isArchived ? t("session_management.unarchive_session") : t("session_management.archive_session")}
        </ContextMenuItem>
      ) : null}
      {ctx.onOpenDeleteSession ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={() => ctx.onOpenDeleteSession?.(sessionId)}>
            <Trash2 className="size-4" />
            {t("workspace_list.delete_session")}
          </ContextMenuItem>
        </>
      ) : null}
    </>
  );
}

function SessionActions({ className, sessionId, workspaceId, isPinned, isArchived }: SessionActionsProps) {
  if (!useCanManageSession()) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="size-6 text-muted-foreground"
        render={
          <Button variant="ghost" size="icon-sm" className={cn("size-6", className)}>
            <MoreHorizontal className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" side="bottom" sideOffset={4} alignOffset={-4} className="w-56">
        <SessionMenuContent
          variant="dropdown"
          sessionId={sessionId}
          workspaceId={workspaceId}
          isPinned={isPinned}
          isArchived={isArchived}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type SessionContextMenuProps = {
  children: React.ReactElement;
  sessionId: string;
  workspaceId: string;
  isPinned: boolean;
  isArchived: boolean;
};

function SessionContextMenu({ children, sessionId, workspaceId, isPinned, isArchived }: SessionContextMenuProps) {
  if (!useCanManageSession()) return children;

  return (
    <ContextMenu>
      <ContextMenuTrigger render={children} />
      <ContextMenuContent className="w-56">
        <SessionMenuContent
          variant="context"
          sessionId={sessionId}
          workspaceId={workspaceId}
          isPinned={isPinned}
          isArchived={isArchived}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

type WorkspaceActionsMenuProps = {
  workspace: WorkspaceInfo;
  isConnectionActionBusy: boolean;
  canRecover: boolean;
  className: string;
};

function WorkspaceActionsMenu({ workspace, isConnectionActionBusy, canRecover, className }: WorkspaceActionsMenuProps) {
  const ctx = useSidebarContext();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-6", className)}
            onClick={(e) => {
              e.stopPropagation();
            }}
            aria-label={t("workspace_list.workspace_options")}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" side="bottom" sideOffset={4} className="w-56">
        <DropdownMenuItem onClick={() => ctx.onOpenRenameWorkspace(workspace.id)}>
          <Pencil className="size-4" />
          {t("workspace_list.edit_name")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => ctx.onShareWorkspace(workspace.id)}>
          <Share2 className="size-4" />
          {t("workspace_list.share")}
        </DropdownMenuItem>
        {workspace.workspaceType === "local" ? (
          <DropdownMenuItem onClick={() => ctx.onRevealWorkspace(workspace.id)}>
            <FolderOpen className="size-4" />
            {isWindowsPlatform() ? t("workspace_list.reveal_explorer") : t("workspace_list.reveal_finder")}
          </DropdownMenuItem>
        ) : null}
        {workspace.workspaceType === "remote" ? (
          <>
            {canRecover ? (
              <DropdownMenuItem
                onClick={() => void Promise.resolve(ctx.onRecoverWorkspace(workspace.id))}
                disabled={isConnectionActionBusy}
              >
                <RefreshCw className="size-4" />
                {t("workspace_list.recover")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              onClick={() => void Promise.resolve(ctx.onTestWorkspaceConnection(workspace.id))}
              disabled={isConnectionActionBusy}
            >
              <RefreshCw className="size-4" />
              {t("workspace_list.test_connection")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => ctx.onEditWorkspaceConnection(workspace.id)}
              disabled={isConnectionActionBusy}
            >
              <Settings className="size-4" />
              {t("workspace_list.edit_connection")}
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => ctx.onOpenCreateGroupModal?.(workspace.id)}>
          <FolderPlus className="size-4" />
          {t("session_management.new_group")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => ctx.onForgetWorkspace(workspace.id)}
        >
          <Trash2 className="size-4" />
          {t("workspace_list.remove_workspace")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RemoteConnectionIssueCard(props: {
  message: string;
  tone: "error" | "offline";
  canRecover: boolean;
  busy: boolean;
  onRecover: () => void;
  onTest: () => void;
  onEdit: () => void;
}) {
  const isOffline = props.tone === "offline";

  return (
    <SidebarMenuSubItem>
      <div
        className={cn(
          "w-full rounded-[15px] border border-red-7/35 bg-red-1/40 px-3 py-3 text-left",
          isOffline && "border-amber-7/35 bg-amber-2/45",
        )}
      >
        <div className="flex items-start gap-2.5">
          <div
            className={cn(
              "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-red-3/60 text-red-11",
              isOffline && "bg-amber-3/60 text-amber-11",
            )}
          >
            <AlertCircle size={14} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-medium text-dls-text">
              {t("workspace_list.remote_worker_unavailable")}
            </div>
            <div className="mt-1 text-[11px] leading-5 text-gray-10">
              {t("workspace_list.remote_worker_unavailable_hint")}
            </div>
            <div
              className={cn(
                "mt-2 rounded-lg border border-red-7/25 bg-red-1/40 px-2 py-1.5 text-[11px] leading-4 text-red-11 whitespace-pre-wrap wrap-anywhere",
                isOffline && "border-amber-7/25 bg-amber-1/40 text-amber-11",
              )}
              title={props.message}
            >
              {props.message}
            </div>
            <OpenWorkDenHelpLink />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {props.canRecover ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 rounded-lg px-2 text-[11px]"
                  onClick={props.onRecover}
                  disabled={props.busy}
                >
                  <RotateCcw size={12} />
                  {t("workspace_list.recover")}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 rounded-lg px-2 text-[11px]"
                onClick={props.onTest}
                disabled={props.busy}
              >
                <RefreshCw size={12} />
                {t("workspace_list.test_connection")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 rounded-lg px-2 text-[11px]"
                onClick={props.onEdit}
                disabled={props.busy}
              >
                <Settings size={12} />
                {t("common.edit")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </SidebarMenuSubItem>
  );
}

export type AppSidebarProps = {
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
  onOpenRenameSession?: (sessionId: string) => void;
  onOpenDeleteSession?: (sessionId: string) => void;
  onArchiveSession?: (sessionId: string, archived: boolean) => void;
  onOpenCreateGroupModal?: (workspaceId: string) => void;
  onOpenRenameWorkspace: (workspaceId: string) => void;
  onShareWorkspace: (workspaceId: string) => void;
  onRevealWorkspace: (workspaceId: string) => void;
  onRecoverWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  onTestWorkspaceConnection: (workspaceId: string) => Promise<boolean> | boolean | void;
  onEditWorkspaceConnection: (workspaceId: string) => void;
  onForgetWorkspace: (workspaceId: string) => void;
  onOpenCreateWorkspace: () => void;
  onReorderWorkspaces?: (workspaceIds: string[]) => void;
  onStartResize?: React.PointerEventHandler<HTMLButtonElement>;
};

function useSessionTree(
  sessions: WorkspaceSessionGroup["sessions"],
  sessionStatusById: Record<string, string> | undefined,
) {
  return React.useMemo(
    () => buildSessionTreeState(sessions, sessionStatusById),
    [sessions, sessionStatusById],
  );
}

function isSessionActivityStatus(status: string | undefined): status is SessionActivityStatus {
  return status === "idle" || status === "thinking" || status === "responding" || status === "error" || status === "compacting" || status === "waiting";
}

export function AppSidebar(props: AppSidebarProps) {
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [previewCountByWorkspaceId, setPreviewCountByWorkspaceId] = React.useState<Record<string, number>>({});
  const [expandedSessionIds, setExpandedSessionIds] = React.useState<Set<string>>(
    () => new Set(),
  );

  const expandWorkspace = React.useCallback((workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    setExpandedWorkspaceIds((previous) => {
      if (previous.has(id)) return previous;
      const next = new Set(previous);
      next.add(id);
      return next;
    });
  }, []);

  const toggleWorkspaceExpanded = React.useCallback((workspaceId: string) => {
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
  }, []);

  const toggleSessionExpanded = React.useCallback((sessionId: string) => {
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
  }, []);

  React.useEffect(() => {
    const id = props.selectedWorkspaceId.trim();
    if (!id) return;
    expandWorkspace(id);
  }, [props.selectedWorkspaceId, expandWorkspace]);

  const previewCount = (workspaceId: string) =>
    previewCountByWorkspaceId[workspaceId] ?? MAX_SESSIONS_PREVIEW;

  const showMoreSessions = (workspaceId: string, totalRoots: number) => {
    expandWorkspace(workspaceId);
    setPreviewCountByWorkspaceId((current) => ({
      ...current,
      [workspaceId]: Math.min((current[workspaceId] ?? MAX_SESSIONS_PREVIEW) + MAX_SESSIONS_PREVIEW, totalRoots),
    }));
  };

  React.useEffect(() => {
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

  const contextValue: SidebarContextValue = {
    selectedWorkspaceId: props.selectedWorkspaceId,
    selectedSessionId: props.selectedSessionId,
    developerMode: props.developerMode,
    showSessionActions: props.showSessionActions,
    sessionStatusById: props.sessionStatusById,
    newTaskDisabled: props.newTaskDisabled,
    connectingWorkspaceId: props.connectingWorkspaceId,
    workspaceConnectionStateById: props.workspaceConnectionStateById,
    onSelectWorkspace: props.onSelectWorkspace,
    onOpenSession: props.onOpenSession,
    onPrefetchSession: props.onPrefetchSession,
    onCreateTaskInWorkspace: props.onCreateTaskInWorkspace,
    onOpenRenameSession: props.onOpenRenameSession,
    onOpenDeleteSession: props.onOpenDeleteSession,
    onArchiveSession: props.onArchiveSession,
    onOpenCreateGroupModal: props.onOpenCreateGroupModal,
    onOpenRenameWorkspace: props.onOpenRenameWorkspace,
    onShareWorkspace: props.onShareWorkspace,
    onRevealWorkspace: props.onRevealWorkspace,
    onRecoverWorkspace: props.onRecoverWorkspace,
    onTestWorkspaceConnection: props.onTestWorkspaceConnection,
    onEditWorkspaceConnection: props.onEditWorkspaceConnection,
    onForgetWorkspace: props.onForgetWorkspace,
    expandWorkspace,
    toggleWorkspaceExpanded,
    toggleSessionExpanded,
    expandedWorkspaceIds,
    expandedSessionIds,
  };

  return (
    <SidebarContext.Provider value={contextValue}>
      <Sidebar
        collapsible="offcanvas"
        className="mac:**:data-[sidebar=sidebar]:bg-transparent"
      >
        <div className="hidden h-14 mac:block mac:titlebar-drag"/>
        <LazyMotion features={domMax}>
          <m.div
            layoutScroll
            data-slot="sidebar-content"
            data-sidebar="content"
            className="no-scrollbar flex min-h-0 flex-1 flex-col gap-px overflow-auto [--radius:var(--radius-xl)] group-data-[collapsible=icon]:overflow-hidden"
          >
            <Reorder.Group
              as="div"
              axis="y"
              values={props.workspaceSessionGroups.map((group) => group.workspace.id)}
              onReorder={(workspaceIds) => props.onReorderWorkspaces?.(workspaceIds)}
              className="flex flex-col gap-px"
            >
              {props.workspaceSessionGroups.map((group, index) => (
                <WorkspaceReorderItem
                  key={group.workspace.id}
                  group={group}
                  className={cn(index === 0 && "mac:pt-0")}
                  showInitialLoading={props.showInitialLoading}
                  previewCount={previewCount(group.workspace.id)}
                  showMoreSessions={showMoreSessions}
                />
              ))}
            </Reorder.Group>
          </m.div>
        </LazyMotion>

        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={props.onOpenCreateWorkspace}>
                <Plus className="size-4" />
                {t("workspace_list.add_workspace")}
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail
          aria-label={props.onStartResize ? t("session.resize_workspace_column") : undefined}
          title={props.onStartResize ? t("session.resize_workspace_column") : undefined}
          onClick={props.onStartResize ? (event) => {
            event.preventDefault();
          } : undefined}
          onPointerDown={props.onStartResize}
        />
      </Sidebar>
    </SidebarContext.Provider>
  );
}

type WorkspaceReorderItemProps = {
  className: string;
  group: WorkspaceSessionGroup;
  showInitialLoading?: boolean;
  previewCount: number;
  showMoreSessions: (workspaceId: string, totalRoots: number) => void;
};

function WorkspaceReorderItem({
  className,
  group,
  showInitialLoading,
  previewCount,
  showMoreSessions,
}: WorkspaceReorderItemProps) {
  const dragControls = useDragControls();

  return (
    <Reorder.Item
      as="div"
      value={group.workspace.id}
      id={group.workspace.id}
      layout="position"
      dragElastic={0}
      dragListener={false}
      dragControls={dragControls}
      transformTemplate={(_latest, generated) =>
        // Keep Motion's translate-based reorder movement, but drop projection scale
        // so expanded workspace contents don't stretch during collapse/expand.
        generated.replace(/ ?scale[XY]?\([^)]*\)/g, "")
      }
      className="relative"
    >
      <WorkspaceSidebarGroup
        className={className}
        group={group}
        showInitialLoading={showInitialLoading}
        previewCount={previewCount}
        showMoreSessions={showMoreSessions}
        onWorkspaceTitlePointerDown={(event) => dragControls.start(event)}
      />
    </Reorder.Item>
  );
}

type WorkspaceHeaderProps = React.ComponentProps<typeof SidebarMenuButton> & {
  workspace: WorkspaceInfo;
  statusLabel: string;
  isError: boolean;
  isLoading: boolean;
  onTitlePointerDown: React.PointerEventHandler<HTMLDivElement>;
};

function WorkspaceHeader({
  workspace,
  statusLabel,
  isError,
  isLoading,
  onTitlePointerDown,
  onClick,
  ...props
}: WorkspaceHeaderProps) {
  const ctx = useSidebarContext();

  const handleSelectWorkspace = () => {
    void Promise.resolve(ctx.onSelectWorkspace(workspace.id));
  };

  return (
    <SidebarMenuButton
      {...props}
      className={cn(
        "group-hover/workspace-header:bg-sidebar-accent group-hover/workspace-header:text-sidebar-accent-foreground mac:group-hover/workspace-header:bg-black/5 dark:mac:group-hover/workspace-header:bg-white/10",
        statusLabel && "h-10",
      )}
      onClick={(event) => {
        onClick?.(event);
        handleSelectWorkspace();
      }}
    >
      <WorkspaceIcon workspaceId={workspace.id} sizeClass="size-4" />
      <div
        className={cn(
          "min-w-0 flex-1 cursor-grab touch-none transition-[padding] duration-75 active:cursor-grabbing group-hover/workspace-header:pr-16 group-has-[[data-workspace-actions]:focus-within]/workspace-header:pr-16 group-has-data-popup-open/workspace-header:pr-11 group-hover/workspace-header:group-has-data-popup-open/workspace-header:pr-16 pr-2",
          isLoading && "pr-6",
        )}
        onPointerDown={onTitlePointerDown}
      >
        <span className="block truncate">{workspaceLabel(workspace)}</span>
        {statusLabel ? (
          <span className={cn("block text-xs", isError ? "text-destructive" : "text-muted-foreground")}>
            {statusLabel}
          </span>
        ) : null}
      </div>
      <span className="ml-auto flex items-center gap-1 pl-0">
        {isLoading ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground transition-opacity group-hover/workspace-header:opacity-0" />
        ) : null}
      </span>
    </SidebarMenuButton>
  );
}

type WorkspaceSidebarGroupProps = {
  className: string;
  group: WorkspaceSessionGroup;
  showInitialLoading?: boolean;
  previewCount: number;
  showMoreSessions: (workspaceId: string, totalRoots: number) => void;
  onWorkspaceTitlePointerDown: React.PointerEventHandler<HTMLDivElement>;
};

function WorkspaceSidebarGroup({
  className,
  group,
  showInitialLoading,
  previewCount,
  showMoreSessions,
  onWorkspaceTitlePointerDown,
}: WorkspaceSidebarGroupProps) {
  const ctx = useSidebarContext();
  const workspace = group.workspace;
  const tree = useSessionTree(group.sessions, ctx.sessionStatusById);

  const forcedExpandedSessionIds = React.useMemo(
    () => new Set(
      ctx.selectedSessionId
        ? tree.ancestorIdsBySessionId.get(ctx.selectedSessionId) ?? []
        : [],
    ),
    [ctx.selectedSessionId, tree.ancestorIdsBySessionId],
  );

  const isConnecting = ctx.connectingWorkspaceId === workspace.id;
  const connectionState: WorkspaceConnectionState = ctx.workspaceConnectionStateById[workspace.id] ?? {
    status: "idle",
    message: null,
  };
  const isConnectionActionBusy = isConnecting || connectionState.status === "connecting";
  const isRemoteWorkspace = isRemoteConnectionWorkspace(workspace);
  const canRecover = isRemoteWorkspace && connectionState.status === "error";
  const taskLoadError = getWorkspaceTaskLoadErrorDisplay(workspace, group.error);
  const connectionIssueMessage = connectionState.status === "error"
    ? connectionState.message?.trim() || taskLoadError.message
    : group.error?.trim() || taskLoadError.message;
  const showRemoteConnectionIssue =
    (isRemoteWorkspace || isRemoteConnectionErrorMessage(connectionIssueMessage)) &&
    Boolean(connectionIssueMessage) &&
    (connectionState.status === "error" || group.status === "error");
  const isExpanded = ctx.expandedWorkspaceIds.has(workspace.id);
  const isSelected = ctx.selectedWorkspaceId === workspace.id;

  const statusLabel = (() => {
    if (showRemoteConnectionIssue) return t("workspace_list.unavailable");
    if (connectionState.status === "error") return connectionState.message?.trim() || taskLoadError.message;
    if (group.status === "error") return taskLoadError.label;
    if (isConnectionActionBusy) return t("workspace_list.connecting");
    if (isRemoteWorkspace && connectionState.status === "connected") return connectionState.message?.trim() || t("workspace_list.connected");
    if (!ctx.developerMode) return "";
    if (isSelected) return t("workspace.selected");
    return workspaceKindLabel(workspace);
  })();

  const pinnedIds = usePinnedSessionIds();
  const orderIds = useSessionOrder(workspace.id);
  const { groups: wsGroups, assignments: wsAssignments } = useWorkspaceGroups(workspace.id);
  const store = useSessionManagementStore;

  const { active: activeSessions, archived: archivedSessions } = React.useMemo(
    () => partitionArchivedSessions(group.sessions),
    [group.sessions],
  );
  const sessionRows = flattenSessionRows(
    group.sessions,
    wsGroups.length > 0 ? Number.MAX_SAFE_INTEGER : previewCount,
    tree,
    ctx.expandedSessionIds,
    forcedExpandedSessionIds,
    pinnedIds,
    orderIds,
  );
  const visibleRootIds = React.useMemo(
    () => sessionRows.flatMap((row) => (row.depth === 0 ? [row.session.id] : [])),
    [sessionRows],
  );
  const activeRootCount = React.useMemo(
    () => getRootSessions(activeSessions).length,
    [activeSessions],
  );
  const [archivedExpanded, setArchivedExpanded] = React.useState(false);
  const remainingRootSessions = Math.max(0, activeRootCount - previewCount);
  const showMoreLabel = remainingRootSessions > 0
    ? t("workspace_list.show_more", {
      count: Math.min(MAX_SESSIONS_PREVIEW, remainingRootSessions),
    })
    : t("workspace_list.show_more_fallback");

  return (
    <SidebarGroup className={className}>
      <SidebarGroupContent>
        <SidebarMenu>
          <Collapsible
            render={<SidebarMenuItem />}
            open={isExpanded}
            onOpenChange={() => ctx.toggleWorkspaceExpanded(workspace.id)}
            className="group/collapsible"
          >
            <div className="group/workspace-header relative max-md:hidden">
              <WorkspaceHeader
                workspace={workspace}
                statusLabel={statusLabel}
                isError={group.status === "error"}
                isLoading={group.status === "loading" || isConnecting}
                onTitlePointerDown={onWorkspaceTitlePointerDown}
              />
              <div data-workspace-actions className="group/workspace-actions absolute right-9 top-1/2 flex -translate-y-1/2 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground opacity-0 group-hover/workspace-header:opacity-100 group-focus-within/workspace-actions:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    ctx.onCreateTaskInWorkspace(workspace.id);
                  }}
                  disabled={ctx.newTaskDisabled}
                  aria-label={t("session.new_task")}
                >
                  <Plus className="size-4" />
                </Button>
                <WorkspaceActionsMenu
                  workspace={workspace}
                  isConnectionActionBusy={isConnectionActionBusy}
                  canRecover={canRecover}
                  className="size-6 text-muted-foreground opacity-0 group-hover/workspace-header:opacity-100 group-focus-within/workspace-actions:opacity-100 data-popup-open:opacity-100"
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-2 top-1/2 size-6 -translate-y-1/2 text-muted-foreground flex items-center justify-center group/expand-collapse-button"
                aria-label={isExpanded ? t("sidebar.collapse") : t("sidebar.expand")}
                aria-expanded={isExpanded}
                onClick={(e) => {
                  e.stopPropagation();
                  ctx.toggleWorkspaceExpanded(workspace.id);
                }}
              >
                <ChevronRight className={cn("size-4 transition-transform duration-200 text-muted-foreground group-hover/expand-collapse-button:text-foreground", isExpanded && "rotate-90")} />
              </Button>
            </div>

            <CollapsibleContent className="pt-px">
              <SidebarMenuSub>
                {showRemoteConnectionIssue ? (
                  <RemoteConnectionIssueCard
                    message={connectionIssueMessage}
                    tone={taskLoadError.tone}
                    canRecover={canRecover}
                    busy={isConnectionActionBusy}
                    onRecover={() => {
                      void Promise.resolve(ctx.onRecoverWorkspace(workspace.id));
                    }}
                    onTest={() => {
                      void Promise.resolve(ctx.onTestWorkspaceConnection(workspace.id));
                    }}
                    onEdit={() => {
                      ctx.onEditWorkspaceConnection(workspace.id);
                    }}
                  />
                ) : showInitialLoading || (group.status === "loading" && group.sessions.length === 0) ? (
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton aria-disabled className="text-muted-foreground text-xs truncate">
                      <span className="truncate">{t("workspace.loading_tasks")}</span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ) : activeSessions.length > 0 || archivedSessions.length > 0 ? (
                  <>
                    {wsGroups.length > 0 ? (
                      <GroupedSessionList
                        sessionRows={sessionRows}
                        groups={wsGroups}
                        assignments={wsAssignments}
                        pinnedIds={pinnedIds}
                        tree={tree}
                        workspaceId={workspace.id}
                        forcedExpandedSessionIds={forcedExpandedSessionIds}
                        store={store}
                      />
                    ) : (
                      <Reorder.Group
                        as="div"
                        axis="y"
                        values={visibleRootIds}
                        onReorder={(ids) => {
                          const visible = new Set(ids);
                          const allRootIds = getRootSessions(activeSessions).map((s) => s.id);
                          const full = [...ids, ...allRootIds.filter((id) => !visible.has(id))];
                          store.getState().reorderSessions(workspace.id, full);
                        }}
                        className="flex flex-col"
                      >
                        {sessionRows.map((row) => (
                          <SessionMenuItem
                            key={row.session.id}
                            session={row.session}
                            depth={row.depth}
                            tree={tree}
                            workspaceId={workspace.id}
                            forcedExpandedSessionIds={forcedExpandedSessionIds}
                            isPinned={pinnedIds.has(row.session.id)}
                            draggable={row.depth === 0}
                          />
                        ))}
                      </Reorder.Group>
                    )}
                    {wsGroups.length === 0 && activeRootCount > previewCount ? (
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton
                          className="text-muted-foreground text-xs"
                          onClick={() => showMoreSessions(workspace.id, activeRootCount)}
                        >
                          <span className="flex min-w-0 items-center gap-1">
                            <span className="truncate">{showMoreLabel}</span>
                            <span aria-hidden className="shrink-0">⋅</span>
                            <span
                              role="button"
                              tabIndex={0}
                              className="shrink-0 hover:text-foreground"
                              onClick={(event) => {
                                event.stopPropagation();
                                ctx.onOpenCreateGroupModal?.(workspace.id);
                              }}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter" && event.key !== " ") return;
                                event.preventDefault();
                                event.stopPropagation();
                                ctx.onOpenCreateGroupModal?.(workspace.id);
                              }}
                            >
                              {t("session_management.create_group")}
                            </span>
                          </span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ) : null}
                    {archivedSessions.length > 0 ? (
                      <ArchivedSessionsSection
                        sessions={archivedSessions}
                        tree={tree}
                        workspaceId={workspace.id}
                        forcedExpandedSessionIds={forcedExpandedSessionIds}
                        expanded={archivedExpanded}
                        onToggle={() => setArchivedExpanded((value) => !value)}
                      />
                    ) : null}
                  </>
                ) : group.status === "error" ? (
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton
                      aria-disabled
                      className={cn("text-xs", taskLoadError.tone === "offline" ? "text-amber-600" : "text-destructive")}
                    >
                      <span className="truncate">{taskLoadError.message}</span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ) : (
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton
                      className="text-muted-foreground text-xs"
                      onClick={() => ctx.onCreateTaskInWorkspace(workspace.id)}
                      aria-disabled={ctx.newTaskDisabled}
                    >
                      <span className="truncate">
                        {isRemoteWorkspace && connectionState.status === "connected"
                          ? connectionState.message?.trim() || t("workspace.connected_no_tasks")
                          : t("workspace.no_tasks")}
                      </span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                )}
              </SidebarMenuSub>
            </CollapsibleContent>
          </Collapsible>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

const SESSION_DRAG_TYPE = "application/x-openwork-session-id";
const UNGROUPED_GROUP_ID = "__openwork_ungrouped";

function SessionGroupSeparator({ label, count, expanded, onToggle, onRemove, onTitlePointerDown }: {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  onRemove?: () => void;
  onTitlePointerDown?: React.PointerEventHandler<HTMLSpanElement>;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="group/separator flex w-full items-center gap-1.5 rounded px-2 pb-1 pt-2.5 text-left transition-colors first:pt-1 hover:bg-sidebar-accent/50"
      aria-expanded={expanded}
    >
      <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-200", expanded && "rotate-90")} />
      <span
        className="min-w-0 flex-1 cursor-grab touch-none truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground active:cursor-grabbing"
        onPointerDown={onTitlePointerDown}
      >
        {label}
      </span>
      <span className="text-[10px] tabular-nums text-muted-foreground/70">{count}</span>
      {onRemove ? (
        <span
          role="button"
          tabIndex={0}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            onRemove();
          }}
          className="ml-auto size-4 shrink-0 text-muted-foreground/50 opacity-0 transition-opacity hover:text-destructive group-hover/separator:opacity-100"
          aria-label={t("session_management.remove_group")}
        >
          <Trash2 className="size-3" />
        </span>
      ) : null}
    </button>
  );
}

/** Drop zone wrapping a group's header + sessions. Dropping a session anywhere in the zone assigns it to this group. */
function GroupDropZone({ groupId, workspaceId, children }: {
  groupId: string | null;
  workspaceId: string;
  children: React.ReactNode;
}) {
  const [dragOver, setDragOver] = React.useState(false);
  const store = useSessionManagementStore;

  return (
    <div
      className={cn(
        "rounded transition-colors",
        dragOver && "bg-accent/40 ring-1 ring-accent/60",
      )}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(SESSION_DRAG_TYPE)) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        // Only clear when leaving this container, not when entering a child.
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setDragOver(false);
        }
      }}
      onDrop={(e) => {
        setDragOver(false);
        const sessionId = e.dataTransfer.getData(SESSION_DRAG_TYPE);
        if (sessionId) {
          store.getState().assignGroup(workspaceId, sessionId, groupId);
        }
      }}
    >
      {children}
    </div>
  );
}

/** Renders sessions partitioned by group. Empty groups always show. Ungrouped sessions render at the end. */
function GroupedSessionList({ sessionRows, groups, assignments, pinnedIds, tree, workspaceId, forcedExpandedSessionIds, store }: {
  sessionRows: FlattenedSessionRow[];
  groups: SessionGroupDefinition[];
  assignments: Record<string, string>;
  pinnedIds: Set<string>;
  tree: SessionTreeState;
  workspaceId: string;
  forcedExpandedSessionIds: Set<string>;
  store: typeof useSessionManagementStore;
}) {
  const [previewCountByGroup, setPreviewCountByGroup] = React.useState<Record<string, number>>({});

  const groupPreviewCount = (groupId: string) =>
    previewCountByGroup[groupId] ?? MAX_SESSIONS_PREVIEW;

  const showMoreInGroup = React.useCallback((groupId: string, totalCount: number) => {
    setPreviewCountByGroup((current) => ({
      ...current,
      [groupId]: Math.min(
        (current[groupId] ?? MAX_SESSIONS_PREVIEW) + MAX_SESSIONS_PREVIEW,
        totalCount,
      ),
    }));
  }, []);

  // Partition root rows into per-group buckets + ungrouped.
  const rootRowsByGroup = new Map<string, FlattenedSessionRow[]>();
  const ungroupedRows: FlattenedSessionRow[] = [];
  // Child rows follow their parent regardless of group.
  const childrenByParent = new Map<string, FlattenedSessionRow[]>();
  const rowIndexById = new Map(sessionRows.map((row, index) => [row.session.id, index]));

  for (const row of sessionRows) {
    if (row.depth > 0) {
      const rowIndex = rowIndexById.get(row.session.id);
      if (rowIndex === undefined) continue;
      let parentId: string | null = null;
      for (let j = rowIndex - 1; j >= 0; j--) {
        if (sessionRows[j].depth < row.depth) { parentId = sessionRows[j].session.id; break; }
      }
      if (parentId) {
        const kids = childrenByParent.get(parentId) ?? [];
        kids.push(row);
        childrenByParent.set(parentId, kids);
      }
      continue;
    }
    const groupId = assignments[row.session.id];
    if (groupId && groups.some((g) => g.id === groupId)) {
      const bucket = rootRowsByGroup.get(groupId) ?? [];
      bucket.push(row);
      rootRowsByGroup.set(groupId, bucket);
    } else {
      ungroupedRows.push(row);
    }
  }

  const renderRow = (row: FlattenedSessionRow) => (
    <React.Fragment key={row.session.id}>
      <SessionMenuItem
        session={row.session}
        depth={row.depth}
        tree={tree}
        workspaceId={workspaceId}
        forcedExpandedSessionIds={forcedExpandedSessionIds}
        isPinned={pinnedIds.has(row.session.id)}
      />
      {(childrenByParent.get(row.session.id) ?? []).map(renderRow)}
    </React.Fragment>
  );

  const renderGroup = (group: SessionGroupDefinition) => {
    const rows = rootRowsByGroup.get(group.id) ?? [];
    const expanded = !(store.getState().groupsByWorkspace[workspaceId]?.collapsedGroupIds ?? []).includes(group.id);
    const limit = groupPreviewCount(group.id);

    return (
      <SessionGroupSection
        key={group.id}
        group={group}
        rows={rows}
        expanded={expanded}
        workspaceId={workspaceId}
        store={store}
        renderRow={renderRow}
        previewCount={limit}
        onShowMore={() => showMoreInGroup(group.id, rows.length)}
      />
    );
  };

  const ungroupedExpanded = !(store.getState().groupsByWorkspace[workspaceId]?.collapsedGroupIds ?? []).includes(UNGROUPED_GROUP_ID);
  const ungroupedLimit = groupPreviewCount(UNGROUPED_GROUP_ID);
  const visibleUngroupedRows = ungroupedRows.slice(0, ungroupedLimit);
  const ungroupedRemaining = Math.max(0, ungroupedRows.length - ungroupedLimit);
  const visibleUngroupedRootIds = visibleUngroupedRows.map((r) => r.session.id);

  return (
    <>
      <Reorder.Group
        as="div"
        axis="y"
        values={groups.map((group) => group.id)}
        onReorder={(ids) => store.getState().reorderGroups(workspaceId, ids)}
        className="flex flex-col"
      >
        {groups.map(renderGroup)}
      </Reorder.Group>
      {ungroupedRows.length > 0 ? (
        <GroupDropZone groupId={null} workspaceId={workspaceId}>
          <Collapsible
            open={ungroupedExpanded}
            onOpenChange={() => store.getState().toggleGroupExpanded(workspaceId, UNGROUPED_GROUP_ID)}
          >
            <SessionGroupSeparator
              label={t("session_management.ungrouped")}
              count={ungroupedRows.length}
              expanded={ungroupedExpanded}
              onToggle={() => store.getState().toggleGroupExpanded(workspaceId, UNGROUPED_GROUP_ID)}
            />
            <CollapsibleContent>
              <Reorder.Group
                as="div"
                axis="y"
                values={visibleUngroupedRootIds}
                onReorder={(ids) => {
                  const allRootIds = sessionRows.filter((r) => r.depth === 0).map((r) => r.session.id);
                  const ungroupedSet = new Set(ungroupedRows.map((r) => r.session.id));
                  const visibleSet = new Set(ids);
                  const fullUngrouped = [...ids, ...ungroupedRows.map((r) => r.session.id).filter((id) => !visibleSet.has(id))];
                  let ui = 0;
                  const full = allRootIds.map((id) => ungroupedSet.has(id) ? fullUngrouped[ui++] : id);
                  store.getState().reorderSessions(workspaceId, full);
                }}
                className="flex flex-col"
              >
                {visibleUngroupedRows.map((row) => (
                  <React.Fragment key={row.session.id}>
                    <SessionMenuItem
                      session={row.session}
                      depth={row.depth}
                      tree={tree}
                      workspaceId={workspaceId}
                      forcedExpandedSessionIds={forcedExpandedSessionIds}
                      isPinned={pinnedIds.has(row.session.id)}
                      draggable={row.depth === 0}
                    />
                    {(childrenByParent.get(row.session.id) ?? []).map(renderRow)}
                  </React.Fragment>
                ))}
              </Reorder.Group>
              {ungroupedRemaining > 0 ? (
                <SidebarMenuSubItem>
                  <SidebarMenuSubButton
                    className="text-muted-foreground text-xs"
                    onClick={() => showMoreInGroup(UNGROUPED_GROUP_ID, ungroupedRows.length)}
                  >
                    <span className="truncate">
                      {t("workspace_list.show_more", { count: Math.min(MAX_SESSIONS_PREVIEW, ungroupedRemaining) })}
                    </span>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              ) : null}
            </CollapsibleContent>
          </Collapsible>
        </GroupDropZone>
      ) : null}
    </>
  );
}

function SessionGroupSection({ group, rows, expanded, workspaceId, store, renderRow, previewCount, onShowMore }: {
  group: SessionGroupDefinition;
  rows: FlattenedSessionRow[];
  expanded: boolean;
  workspaceId: string;
  store: typeof useSessionManagementStore;
  renderRow: (row: FlattenedSessionRow) => React.ReactNode;
  previewCount: number;
  onShowMore: () => void;
}) {
  const dragControls = useDragControls();
  const visibleRows = rows.slice(0, previewCount);
  const remaining = Math.max(0, rows.length - previewCount);

  return (
    <Reorder.Item
      as="div"
      value={group.id}
      id={group.id}
      layout="position"
      dragElastic={0}
      dragListener={false}
      dragControls={dragControls}
      transformTemplate={(_latest, generated) => generated.replace(/ ?scale[XY]?\([^)]*\)/g, "")}
    >
      <GroupDropZone groupId={group.id} workspaceId={workspaceId}>
        <Collapsible
          open={expanded}
          onOpenChange={() => store.getState().toggleGroupExpanded(workspaceId, group.id)}
          className="group/session-group"
        >
          <SessionGroupSeparator
            label={group.label}
            count={rows.length}
            expanded={expanded}
            onToggle={() => store.getState().toggleGroupExpanded(workspaceId, group.id)}
            onRemove={() => store.getState().removeGroup(workspaceId, group.id)}
            onTitlePointerDown={(event) => dragControls.start(event)}
          />
          <CollapsibleContent>
            {visibleRows.length > 0
              ? (
                <>
                  {visibleRows.map(renderRow)}
                  {remaining > 0 ? (
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton
                        className="text-muted-foreground text-xs"
                        onClick={onShowMore}
                      >
                        <span className="truncate">
                          {t("workspace_list.show_more", { count: Math.min(MAX_SESSIONS_PREVIEW, remaining) })}
                        </span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  ) : null}
                </>
              )
              : (
                <SidebarMenuSubItem>
                  <SidebarMenuSubButton aria-disabled className="text-muted-foreground text-xs italic">
                    <span className="truncate">{t("session_management.empty_group")}</span>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              )}
          </CollapsibleContent>
        </Collapsible>
      </GroupDropZone>
    </Reorder.Item>
  );
}

function PinnedIndicator({ isPinned }: { isPinned: boolean }) {
  if (!isPinned) return null;
  return (
    <Pin
      className="size-3 shrink-0 text-muted-foreground/70"
      aria-label={t("session_management.pinned")}
    />
  );
}

type SessionMenuItemProps = {
  session: SessionListItem;
  depth: number;
  tree: SessionTreeState;
  workspaceId: string;
  forcedExpandedSessionIds: Set<string>;
  isPinned?: boolean;
  draggable?: boolean;
};

function SessionMenuItem({
  session,
  tree,
  workspaceId,
  forcedExpandedSessionIds,
  depth,
  isPinned = false,
  draggable = false,
}: SessionMenuItemProps) {
  const ctx = useSidebarContext();
  const isSelected = ctx.selectedSessionId === session.id;
  const displayTitle = getDisplaySessionTitle(session.title);
  const hasChildren = (tree.descendantCountBySessionId.get(session.id) ?? 0) > 0;
  const isExpanded = ctx.expandedSessionIds.has(session.id) || forcedExpandedSessionIds.has(session.id);
  const sessionActivityStatus = ctx.sessionStatusById?.[session.id];
  const isSessionActive = tree.activeIds.has(session.id);
  const isSessionStreaming = tree.streamingIds.has(session.id) || isStreamingSessionStatus(sessionActivityStatus);
  const isArchived = isSessionArchived(session);

  const openSession = () => {
    ctx.onOpenSession(workspaceId, session.id);
  };

  const prefetchSession = () => {
    if (workspaceId !== ctx.selectedWorkspaceId) {
      return;
    }

    ctx.onPrefetchSession?.(workspaceId, session.id);
  };

  const dragProps = depth === 0 ? {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(SESSION_DRAG_TYPE, session.id);
      e.dataTransfer.effectAllowed = "move";
    },
  } : {};

  const item = hasChildren ? (
    <Collapsible
      open={isExpanded}
      onOpenChange={() => ctx.toggleSessionExpanded(session.id)}
      className="group/session-collapsible"
    >
      <SidebarMenuSubItem {...dragProps}>
        <SessionContextMenu sessionId={session.id} workspaceId={workspaceId} isPinned={isPinned} isArchived={isArchived}>
          <CollapsibleTrigger
            render={
              <SidebarMenuSubButton
                className={cn("relative", depth > 0 && "ps-13")}
                isActive={isSelected}
                onClick={openSession}
                onPointerEnter={prefetchSession}
                onFocus={prefetchSession}
              >
                <PinnedIndicator isPinned={isPinned} />
                <span
                  className={cn("min-w-0 flex-1 truncate transition-[padding] duration-75 group-hover/menu-sub-item:pe-12 group-has-data-popup-open/menu-sub-item:pe-12 pe-4", isSessionStreaming || isSessionActive && "pe-12")}
                  title={displayTitle}
                >
                  {displayTitle}
                </span>
                <span className="flex items-center justify-center size-6 absolute right-2 top-1/2 -translate-y-1/2">
                  <ChevronRight className="size-4 text-muted-foreground transition-transform duration-200 group-data-open/session-collapsible:rotate-90 hover:text-foreground" />
                </span>
              </SidebarMenuSubButton>
            }
          />
        </SessionContextMenu>
        <SessionActions
          sessionId={session.id}
          workspaceId={workspaceId}
          isPinned={isPinned}
          isArchived={isArchived}
          className="absolute right-9 top-1/2 -translate-y-1/2 opacity-0 group-hover/menu-sub-item:opacity-100 data-popup-open:opacity-100"
        />
        <SessionStatusIndicator className="absolute right-9 top-1/2 -translate-y-1/2 opacity-0 group-hover/menu-sub-item:opacity-0 group-has-data-popup-open/menu-sub-item:opacity-0 pointer-events-none select-none" status={sessionActivityStatus} isStreaming={isSessionStreaming} isActive={isSessionActive} />
      </SidebarMenuSubItem>
    </Collapsible>
  ) : (
    <SidebarMenuSubItem {...dragProps}>
      <SessionContextMenu sessionId={session.id} workspaceId={workspaceId} isPinned={isPinned} isArchived={isArchived}>
        <SidebarMenuSubButton
          isActive={isSelected}
          onClick={openSession}
          onPointerEnter={prefetchSession}
          onFocus={prefetchSession}
          className={cn("transition-[padding] duration-75 group-hover/menu-sub-item:pe-8 group-has-data-popup-open/menu-sub-item:pe-8", depth > 0 && "ps-13", isSessionStreaming || isSessionActive && "pe-8")}
        >
          <PinnedIndicator isPinned={isPinned} />
          <span className="truncate" title={displayTitle}>{displayTitle}</span>
        </SidebarMenuSubButton>
      </SessionContextMenu>
      <SessionActions
        sessionId={session.id}
        workspaceId={workspaceId}
        isPinned={isPinned}
        isArchived={isArchived}
        className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover/menu-sub-item:opacity-100 data-popup-open:opacity-100"
      />
      <SessionStatusIndicator className="absolute right-3 top-1/2 -translate-y-1/2 opacity-100 group-hover/menu-sub-item:opacity-0 group-has-data-popup-open/menu-sub-item:opacity-0 pointer-events-none select-none" status={sessionActivityStatus} isStreaming={isSessionStreaming} isActive={isSessionActive} />
    </SidebarMenuSubItem>
  );

  if (!draggable) return item;

  return (
    <Reorder.Item
      as="div"
      value={session.id}
      id={session.id}
      layout="position"
      dragElastic={0}
      transformTemplate={(_latest, generated) => generated.replace(/ ?scale[XY]?\([^)]*\)/g, "")}
    >
      {item}
    </Reorder.Item>
  );
}

type ArchivedSessionsSectionProps = {
  sessions: SessionListItem[];
  tree: SessionTreeState;
  workspaceId: string;
  forcedExpandedSessionIds: Set<string>;
  expanded: boolean;
  onToggle: () => void;
};

function ArchivedSessionsSection({
  sessions,
  tree,
  workspaceId,
  forcedExpandedSessionIds,
  expanded,
  onToggle,
}: ArchivedSessionsSectionProps) {
  const pinned = usePinnedSessionIds();
  return (
    <Collapsible open={expanded} onOpenChange={onToggle} className="group/archived">
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="group/separator flex w-full cursor-pointer items-center gap-1.5 px-2 pb-1 pt-2.5 rounded transition-colors hover:bg-sidebar-accent/50"
          >
            <Archive className="size-3 shrink-0 text-muted-foreground" />
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("session_management.archived_label")}
            </span>
            <span className="text-[10px] tabular-nums text-muted-foreground/70">{sessions.length}</span>
            <ChevronRight className="ml-auto size-3.5 text-muted-foreground transition-transform duration-200 group-data-open/archived:rotate-90" />
          </button>
        }
      />
      <CollapsibleContent>
        {sessions.map((session) => (
          <SessionMenuItem
            key={session.id}
            session={session}
            depth={0}
            tree={tree}
            workspaceId={workspaceId}
            forcedExpandedSessionIds={forcedExpandedSessionIds}
            isPinned={pinned.has(session.id)}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
