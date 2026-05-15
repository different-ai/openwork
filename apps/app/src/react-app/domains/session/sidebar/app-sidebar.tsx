/** @jsxImportSource react */
import * as React from "react";
import {
  AlertCircle,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Share2,
  Trash2,
  RefreshCw,
  RotateCcw,
  Settings,
  FolderOpen,
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
  SidebarMenuSkeleton,
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
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
  workspaceKindLabel,
  workspaceLabel,
} from "./utils";
import type { SessionListItem, SessionTreeState } from "./utils";
import { cn } from "@/lib/utils";
import { WorkspaceIcon } from "../../../design-system/workspace-icon";

const WORKSPACE_MENU_SKELETON_ROWS = ["short", "medium", "compact"];

type SessionActionsProps = {
  className: string;
  sessionId: string;
};

function SessionActions({ className, sessionId }: SessionActionsProps) {
  const ctx = useSidebarContext();
  const canManage = Boolean(
    ctx.showSessionActions && (ctx.onOpenRenameSession || ctx.onOpenDeleteSession),
  );

  if (!canManage) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="size-4"
        render={
          <Button variant="ghost" size="icon-sm" className={cn("size-4", className)}>
            <MoreHorizontal className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" side="bottom" sideOffset={4} alignOffset={-4} className="w-56">
        {ctx.onOpenRenameSession ? (
          <DropdownMenuItem onClick={() => ctx.onOpenRenameSession?.(sessionId)}>
            <Pencil className="size-4" />
            {t("workspace_list.rename_session")}
          </DropdownMenuItem>
        ) : null}
        {ctx.onOpenDeleteSession ? (
          <DropdownMenuItem variant="destructive" onClick={() => ctx.onOpenDeleteSession?.(sessionId)}>
            <Trash2 className="size-4" />
            {t("workspace_list.delete_session")}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type SessionContextMenuProps = {
  children: React.ReactElement;
  sessionId: string;
};

function SessionContextMenu({ children, sessionId }: SessionContextMenuProps) {
  const ctx = useSidebarContext();
  const canManage = Boolean(
    ctx.showSessionActions && (ctx.onOpenRenameSession || ctx.onOpenDeleteSession),
  );

  if (!canManage) return children;

  return (
    <ContextMenu>
      <ContextMenuTrigger render={children} />
      <ContextMenuContent className="w-56">
        {ctx.onOpenRenameSession ? (
          <ContextMenuItem onClick={() => ctx.onOpenRenameSession?.(sessionId)}>
            <Pencil className="size-4" />
            {t("workspace_list.rename_session")}
          </ContextMenuItem>
        ) : null}
        {ctx.onOpenDeleteSession ? (
          <ContextMenuItem variant="destructive" onClick={() => ctx.onOpenDeleteSession?.(sessionId)}>
            <Trash2 className="size-4" />
            {t("workspace_list.delete_session")}
          </ContextMenuItem>
        ) : null}
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
            className={className}
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
            className="no-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-auto [--radius:var(--radius-xl)] group-data-[collapsible=icon]:overflow-hidden"
          >
            <Reorder.Group
              as="div"
              axis="y"
              values={props.workspaceSessionGroups.map((group) => group.workspace.id)}
              onReorder={(workspaceIds) => props.onReorderWorkspaces?.(workspaceIds)}
              className="flex flex-col gap-2"
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
      className={cn("h-8 group-hover/workspace-header:bg-sidebar-accent group-hover/workspace-header:text-sidebar-accent-foreground mac:group-hover/workspace-header:bg-black/5 dark:mac:group-hover/workspace-header:bg-white/10", statusLabel && "h-10")}
      onClick={(event) => {
        onClick?.(event);
        handleSelectWorkspace();
      }}
    >
      <WorkspaceIcon seed={workspaceLabel(workspace)} sizeClass="size-4" />
      <div
        className={cn(
          "min-w-0 flex-1 cursor-grab touch-none transition-[padding] duration-75 active:cursor-grabbing group-hover/menu-item:pr-12 group-focus-within/menu-item:pr-12 group-hover/workspace-header:pr-12 group-focus-within/workspace-header:pr-12",
          isLoading && "pr-6",
        )}
        onPointerDown={onTitlePointerDown}
      >
        <span className="block truncate">{workspaceLabel(workspace)}</span>
        {statusLabel ? (
          <span className={`block text-xs ${isError ? "text-destructive" : "text-muted-foreground"}`}>
            {statusLabel}
          </span>
        ) : null}
      </div>
      <span className="ml-auto flex items-center gap-1 pl-0">
        {isLoading ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground transition-opacity group-hover/menu-item:opacity-0 group-hover/workspace-header:opacity-0" />
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
    if (!ctx.developerMode) return "";
    if (isSelected) return t("workspace.selected");
    return workspaceKindLabel(workspace);
  })();

  const rootSessions = getRootSessions(group.sessions);
  const sessionRows = flattenSessionRows(
    group.sessions,
    previewCount,
    tree,
    ctx.expandedSessionIds,
    forcedExpandedSessionIds,
  );
  const remainingRootSessions = Math.max(0, rootSessions.length - previewCount);
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
            <div className="group/workspace-header relative">
              <WorkspaceHeader
                workspace={workspace}
                statusLabel={statusLabel}
                isError={group.status === "error"}
                isLoading={group.status === "loading" || isConnecting}
                onTitlePointerDown={onWorkspaceTitlePointerDown}
              />
              <div className="absolute right-8 top-1/2 flex -translate-y-1/2 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground opacity-0 group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100"
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
                  className="size-6 text-muted-foreground opacity-0 group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 data-popup-open:opacity-100"
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 size-6 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={isExpanded ? t("sidebar.collapse") : t("sidebar.expand")}
                aria-expanded={isExpanded}
                onClick={(e) => {
                  e.stopPropagation();
                  ctx.toggleWorkspaceExpanded(workspace.id);
                }}
              >
                <ChevronRight className={cn("size-4 transition-transform duration-200", isExpanded && "rotate-90")} />
              </Button>
            </div>

            <CollapsibleContent className="pt-1">
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
                ) : showInitialLoading ? (
                  <>
                    {WORKSPACE_MENU_SKELETON_ROWS.map((rowId) => (
                      <SidebarMenuSubItem key={`skeleton-${rowId}`}>
                        <SidebarMenuSkeleton showIcon />
                      </SidebarMenuSubItem>
                    ))}
                  </>
                ) : group.status === "loading" && group.sessions.length === 0 ? (
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton aria-disabled className="text-muted-foreground text-xs truncate">
                      <span className="truncate">{t("workspace.loading_tasks")}</span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ) : group.sessions.length > 0 ? (
                  <>
                    {sessionRows.map((row) => (
                      <SessionMenuItem
                        key={row.session.id}
                        session={row.session}
                        depth={row.depth}
                        tree={tree}
                        workspaceId={workspace.id}
                        forcedExpandedSessionIds={forcedExpandedSessionIds}
                      />
                    ))}
                    {rootSessions.length > previewCount ? (
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton
                          className="text-muted-foreground text-xs"
                          onClick={() => showMoreSessions(workspace.id, rootSessions.length)}
                        >
                          <span className="truncate">{showMoreLabel}</span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
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
                      <span className="truncate">{t("workspace.no_tasks")}</span>
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

type SessionMenuItemProps = {
  session: SessionListItem;
  depth: number;
  tree: SessionTreeState;
  workspaceId: string;
  forcedExpandedSessionIds: Set<string>;
};

function SessionMenuItem({ session, tree, workspaceId, forcedExpandedSessionIds, depth }: SessionMenuItemProps) {
  const ctx = useSidebarContext();
  const isSelected = ctx.selectedSessionId === session.id;
  const displayTitle = getDisplaySessionTitle(session.title);
  const hasChildren = (tree.descendantCountBySessionId.get(session.id) ?? 0) > 0;
  const isExpanded = ctx.expandedSessionIds.has(session.id) || forcedExpandedSessionIds.has(session.id);
  const isSessionActive = tree.activeIds.has(session.id);

  const openSession = () => {
    ctx.onOpenSession(workspaceId, session.id);
  };

  const prefetchSession = () => {
    if (workspaceId !== ctx.selectedWorkspaceId) {
      return;
    }

    ctx.onPrefetchSession?.(workspaceId, session.id);
  };

  if (hasChildren) {
    return (
      <Collapsible
        open={isExpanded}
        onOpenChange={() => ctx.toggleSessionExpanded(session.id)}
        className="group/session-collapsible"
      >
        <SidebarMenuSubItem>
          <SessionContextMenu sessionId={session.id}>
            <CollapsibleTrigger
              render={
                <SidebarMenuSubButton
                  className={cn(depth > 0 && "ps-13")}
                  isActive={isSelected}
                  onClick={openSession}
                  onPointerEnter={prefetchSession}
                  onFocus={prefetchSession}
                >
                  {isSessionActive ? <span className="size-1.5 shrink-0 rounded-full bg-amber-500" /> : null}
                  <span
                    className="min-w-0 flex-1 truncate transition-[padding] duration-75 group-hover/menu-sub-item:pe-5 group-focus-within/menu-sub-item:pe-5"
                    title={displayTitle}
                  >
                    {displayTitle}
                  </span>
                  <span className="ml-auto flex shrink-0 items-center pl-0">
                    <ChevronRight className="size-4 text-muted-foreground transition-transform duration-200 group-data-open/session-collapsible:rotate-90 hover:text-foreground" />
                  </span>
                </SidebarMenuSubButton>
              }
            />
          </SessionContextMenu>
          <SessionActions
            sessionId={session.id}
            className="absolute right-9 top-1/2 -translate-y-1/2 opacity-0 group-hover/menu-sub-item:opacity-100 data-popup-open:opacity-100"
          />
        </SidebarMenuSubItem>
      </Collapsible>
    );
  }

  return (
    <SidebarMenuSubItem>
      <SessionContextMenu sessionId={session.id}>
        <SidebarMenuSubButton
          isActive={isSelected}
          onClick={openSession}
          onPointerEnter={prefetchSession}
          onFocus={prefetchSession}
          className={cn("transition-[padding] duration-75 group-hover/menu-sub-item:pe-8 group-focus-within/menu-sub-item:pe-8", depth > 0 && "ps-13")}
        >
          {isSessionActive ? <span className="size-1.5 shrink-0 rounded-full bg-amber-500" /> : null}
          <span className="truncate" title={displayTitle}>{displayTitle}</span>
        </SidebarMenuSubButton>
      </SessionContextMenu>
      <SessionActions
        sessionId={session.id}
        className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover/menu-sub-item:opacity-100 data-popup-open:opacity-100"
      />
    </SidebarMenuSubItem>
  );
}
