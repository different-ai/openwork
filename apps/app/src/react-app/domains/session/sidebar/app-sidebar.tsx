/** @jsxImportSource react */
import * as React from "react";
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowRight,
  Blocks,
  Clock3,
  ChevronRight,
  Columns2,
  FolderPlus,
  LayoutGrid,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  PanelRightOpen,
  Plus,
  Search,
  Share2,
  Trash2,
  RefreshCw,
  RotateCcw,
  Settings,
  FolderOpen,
  SquarePen,
  Tag,
  X,
} from "lucide-react";
import { LazyMotion, Reorder, domMax, m, useDragControls } from "motion/react";

import { getDisplaySessionTitle } from "../../../../app/lib/session-title";
import type { WorkspaceInfo } from "../../../../app/lib/desktop";
import { OpenWorkDenHelpLink } from "../../workspace/openwork-den-help-link";
import { NotificationBell } from "../../../shell/notification-center";
import { useUiStateStore } from "../../../shell/ui-state-store";
import type {
  WorkspaceConnectionState,
  WorkspaceSessionGroup,
} from "../../../../app/types";
import {
  isRemoteConnectionErrorMessage,
  getWorkspaceTaskLoadErrorDisplay,
  isRemoteConnectionWorkspace,
  isMacPlatform,
  isWindowsPlatform,
} from "../../../../app/utils";
import { t } from "../../../../i18n";
import { resolveExtensionIconSrc } from "../../../design-system/extension-icon-src";
import { useBrandAppName, useBrandLogoUrl } from "../../cloud/brand-theme";
import { canCreateWorkspaces } from "../../../../app/lib/workspace-creation-policy";

import {
  Sidebar,
  SidebarGroup,
  SidebarHeader,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { SidebarContext, useSidebarContext } from "./app-sidebar-provider";
import { AccountStatusMenu, type AccountStatusMenuProps } from "./account-status-menu";
import { usePlatform } from "../../../kernel/platform";
import {
  sessionNumberAriaKeyShortcut,
  sessionNumberShortcutDescription,
  sessionNumberShortcutLabel,
  sessionNumberShortcutTargetKey,
  type SessionNumberShortcutsState,
} from "../../../shell/session-number-shortcuts";
import type { SidebarContextValue } from "./app-sidebar-provider";
import {
  MAX_SESSIONS_PREVIEW,
  flattenSessionRows,
  formatSessionRelativeTime,
  getRootSessions,
  isActiveWorkSessionStatus,
  isNeedsAttentionSessionStatus,
  isSessionArchived,
  partitionArchivedSessions,
  workspaceKindLabel,
  workspaceLabel,
} from "./utils";
import type { FlattenedSessionRow, SessionListItem } from "./utils";
import {
  useSessionManagementStore,
  usePinnedSessionIds,
  useUnreadSessionIds,
  useSessionOrder,
  useWorkspaceGroups,
  type SessionGroupDefinition,
} from "./session-management-store";
import { cn } from "@/lib/utils";
import { getSessionActivityStatusLabel, type SessionActivityStatus } from "../status/session-activity-store";
import { SessionDotMatrixLoader } from "./session-dot-matrix-loader";
import {
  SIDEBAR_ROW_LANE,
  SIDEBAR_SECTION_LABEL,
  SIDEBAR_SECTION_LANE,
  SidebarGlyphSlot,
  sidebarRowPaddingInlineStart,
} from "./sidebar-lanes";
import { WorkspaceAvatarPicker } from "./workspace-avatar-picker";
import { isSameWorkbenchSession, useWorkbenchStore, workbenchSessionKey } from "../chat/workbench-store";
import { SidebarDestination } from "./sidebar-destination";
import { SessionTitle } from "./session-title";

/** Paper Desktop: unread #2FBE54, needs-action #E8933A (14px artboard → ~8px app). */
const OUTCOME_DOT_UNREAD = "#2FBE54";
const OUTCOME_DOT_NEEDS_ACTION = "#E8933A";

interface SessionStatusIndicatorProps {
  status?: string;
  isActiveWork: boolean;
  isUnread: boolean;
}

function ShowMoreSessionsButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        className="h-8 text-[13px] text-muted-foreground"
        style={{ paddingInlineStart: sidebarRowPaddingInlineStart(0) }}
        onClick={onClick}
      >
        <SidebarGlyphSlot />
        <span className="truncate">{label}</span>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

/** Activity and outcomes share the fixed glyph slot before the session title. */
function SessionStatusIndicator({ status, isActiveWork, isUnread }: SessionStatusIndicatorProps) {
  return (
    <SidebarGlyphSlot>
      {isActiveWork ? (
        <SessionDotMatrixLoader label={isSessionActivityStatus(status) && status !== "idle"
          ? getSessionActivityStatusLabel(status)
          : t("workspace_list.session_streaming")} />
      ) : (
        <SessionOutcomeIndicator status={status} isUnread={isUnread} />
      )}
    </SidebarGlyphSlot>
  );
}

/** Orange = needs you, green = unread result, none = read/idle. */
function SessionOutcomeIndicator({ status, isUnread }: { status?: string; isUnread: boolean }) {
  if (isNeedsAttentionSessionStatus(status)) {
    const title = isSessionActivityStatus(status)
      ? getSessionActivityStatusLabel(status)
      : t("workspace_list.session_needs_attention");
    return (
      <span
        data-session-attention-indicator
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: OUTCOME_DOT_NEEDS_ACTION }}
        title={title}
        aria-label={title}
      />
    );
  }

  if (!isUnread) return null;

  return (
    <span
      data-session-attention-indicator
      className="size-2 shrink-0 rounded-full"
      style={{ backgroundColor: OUTCOME_DOT_UNREAD }}
      title={t("workspace_list.session_unread")}
      aria-label={t("workspace_list.session_unread")}
    />
  );
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
  sessionTitle?: string;
  workspaceTitle?: string;
  isPinned: boolean;
  isArchived: boolean;
};

type SessionMenuContentProps = {
  variant: "dropdown" | "context";
  sessionId: string;
  workspaceId: string;
  sessionTitle?: string;
  workspaceTitle?: string;
  isPinned: boolean;
  isArchived: boolean;
};

function SessionMenuContent({
  variant,
  sessionId,
  workspaceId,
  sessionTitle,
  workspaceTitle,
  isPinned,
  isArchived,
}: SessionMenuContentProps) {
  const ctx = useSidebarContext();
  const { groups, assignments } = useWorkspaceGroups(workspaceId);
  const store = useSessionManagementStore;
  const assignedGroupId = assignments[sessionId] ?? null;

  // Sidebar rows are the vertical tabs: any session can be opened beside the
  // primary session, including one owned by another workspace.
  const primary = useWorkbenchStore((state) => state.primary);
  const secondary = useWorkbenchStore((state) => state.secondary);
  const sessionRef = { workspaceId, sessionId };
  const isInSplit = Boolean(secondary)
    && (isSameWorkbenchSession(sessionRef, primary) || isSameWorkbenchSession(sessionRef, secondary));
  const canOpenInSplit = Boolean(primary)
    && !isSameWorkbenchSession(sessionRef, primary)
    && !isSameWorkbenchSession(sessionRef, secondary);
  const canCreateNewSplit = isSameWorkbenchSession(sessionRef, primary);
  const openInSplitView = () => {
    const tab = {
      workspaceId,
      workspaceTitle: workspaceTitle?.trim() || workspaceId,
      sessionId,
      title: sessionTitle,
    };
    const workbench = useWorkbenchStore.getState();
    workbench.openTab(tab);
    workbench.setSplit(tab);
  };
  const closeSplitView = () => useWorkbenchStore.getState().setSplit(null);

  if (variant === "dropdown") {
    return (
      <>
        <DropdownMenuItem onClick={() => store.getState().togglePin(sessionId)}>
          {isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
          {isPinned ? t("session_management.unpin_session") : t("session_management.pin_session")}
        </DropdownMenuItem>
        {canOpenInSplit ? (
          <DropdownMenuItem data-session-menu-open-split onClick={openInSplitView}>
            <Columns2 className="size-4" />
            {t("session_management.open_in_split_view")}
          </DropdownMenuItem>
        ) : null}
        {canCreateNewSplit ? (
          <DropdownMenuItem data-session-menu-new-split onClick={() => ctx.onCreateSplitTaskInWorkspace(workspaceId)}>
            <PanelRightOpen className="size-4" />
            {t("session_management.new_split")}
          </DropdownMenuItem>
        ) : null}
        {isInSplit ? (
          <DropdownMenuItem data-session-menu-close-split onClick={closeSplitView}>
            <Columns2 className="size-4" />
            {t("session_management.close_split_view")}
          </DropdownMenuItem>
        ) : null}
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
                <span className="min-w-0 flex-1 ow-fade-truncate text-muted-foreground">
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
      {canOpenInSplit ? (
        <ContextMenuItem data-session-menu-open-split onClick={openInSplitView}>
          <Columns2 className="size-4" />
          {t("session_management.open_in_split_view")}
        </ContextMenuItem>
      ) : null}
      {canCreateNewSplit ? (
        <ContextMenuItem data-session-menu-new-split onClick={() => ctx.onCreateSplitTaskInWorkspace(workspaceId)}>
          <PanelRightOpen className="size-4" />
          {t("session_management.new_split")}
        </ContextMenuItem>
      ) : null}
      {isInSplit ? (
        <ContextMenuItem data-session-menu-close-split onClick={closeSplitView}>
          <Columns2 className="size-4" />
          {t("session_management.close_split_view")}
        </ContextMenuItem>
      ) : null}
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
              <span className="min-w-0 flex-1 ow-fade-truncate text-muted-foreground">
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

function SessionActions({ className, sessionId, workspaceId, sessionTitle, workspaceTitle, isPinned, isArchived }: SessionActionsProps) {
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
          sessionTitle={sessionTitle}
          workspaceTitle={workspaceTitle}
          isPinned={isPinned}
          isArchived={isArchived}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type SessionHoverQuickActionsProps = {
  className?: string;
  sessionId: string;
  isPinned: boolean;
  isArchived: boolean;
  relativeTime: string | null;
};

/** Pin → Archive → relative time — same trailing slot as status dots (Paper hover). */
function SessionHoverQuickActions({
  className,
  sessionId,
  isPinned,
  isArchived,
  relativeTime,
}: SessionHoverQuickActionsProps) {
  const ctx = useSidebarContext();
  const store = useSessionManagementStore;

  return (
    <div
      data-session-hover-actions
      className={cn(
        "absolute right-2 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 opacity-0 pointer-events-none transition-opacity group-hover/menu-sub-item:opacity-100 group-hover/menu-sub-item:pointer-events-auto group-has-data-popup-open/menu-sub-item:opacity-100 group-has-data-popup-open/menu-sub-item:pointer-events-auto max-lg:opacity-100 max-lg:pointer-events-auto pointer-coarse:opacity-100 pointer-coarse:pointer-events-auto",
        className,
      )}
    >
      <Button
        variant="ghost"
        size="icon"
        className="size-5 text-muted-foreground hover:bg-transparent hover:text-foreground"
        aria-label={isPinned ? t("session_management.unpin_session") : t("session_management.pin_session")}
        onClick={(event) => {
          event.stopPropagation();
          store.getState().togglePin(sessionId);
        }}
      >
        {isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
      </Button>
      {ctx.onArchiveSession ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-5 text-muted-foreground hover:bg-transparent hover:text-foreground"
          aria-label={isArchived ? t("session_management.unarchive_session") : t("session_management.archive_session")}
          onClick={(event) => {
            event.stopPropagation();
            ctx.onArchiveSession?.(sessionId, !isArchived);
          }}
        >
          {isArchived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
        </Button>
      ) : null}
      {relativeTime ? (
        <span className="min-w-[1.25rem] text-right text-[11px] tabular-nums text-muted-foreground/80">
          {relativeTime}
        </span>
      ) : null}
    </div>
  );
}

type SessionContextMenuProps = {
  children: React.ReactElement;
  sessionId: string;
  workspaceId: string;
  sessionTitle?: string;
  workspaceTitle?: string;
  isPinned: boolean;
  isArchived: boolean;
};

function SessionContextMenu({
  children,
  sessionId,
  workspaceId,
  sessionTitle,
  workspaceTitle,
  isPinned,
  isArchived,
}: SessionContextMenuProps) {
  if (!useCanManageSession()) return children;

  return (
    <ContextMenu>
      <ContextMenuTrigger render={children} />
      <ContextMenuContent className="w-56">
        <SessionMenuContent
          variant="context"
          sessionId={sessionId}
          workspaceId={workspaceId}
          sessionTitle={sessionTitle}
          workspaceTitle={workspaceTitle}
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
  const platform = usePlatform();

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
        {workspace.workspaceType === "local" && platform.capabilities.revealInFileManager ? (
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

/** The split travels with its owning session, including when that row is pinned. */
function SessionSideChatControl({ workspaceId, sessionId, title }: {
  workspaceId: string;
  sessionId: string;
  title: string;
}) {
  const ctx = useSidebarContext();
  const sideChat = useWorkbenchStore((state) => state.sideChats[workbenchSessionKey({ workspaceId, sessionId })]);
  const primary = useWorkbenchStore((state) => state.primary);
  const focusedPane = useWorkbenchStore((state) => state.focusedPane);
  const [focusRequested, setFocusRequested] = React.useState(false);
  const unreadIds = useUnreadSessionIds();
  const selected = isSameWorkbenchSession(primary, { workspaceId, sessionId });
  const status = sideChat ? ctx.sessionStatusById?.[sideChat.sessionId] : undefined;
  const isUnread = Boolean(sideChat && unreadIds.has(sideChat.sessionId) && !selected);
  const isActiveWork = isActiveWorkSessionStatus(status);

  React.useEffect(() => {
    if (!focusRequested || !selected || !sideChat) return;
    useWorkbenchStore.getState().focusPane("secondary");
    setFocusRequested(false);
  }, [focusRequested, selected, sideChat]);

  if (!sideChat && !selected) return null;

  return (
    <button
      type="button"
      data-session-side-chat={sideChat?.sessionId ?? "new"}
      aria-label={sideChat ? `${t("session_management.split_view")} · ${title}` : t("session_management.new_split")}
      aria-pressed={Boolean(sideChat && selected && focusedPane === "secondary")}
      aria-description={isSessionActivityStatus(status) && status !== "idle" ? getSessionActivityStatusLabel(status) : undefined}
      disabled={!sideChat && ctx.newTaskDisabled}
      title={sideChat?.title || t("session_management.new_split")}
      className={cn(
        "flex h-8 shrink-0 items-center gap-1 rounded-r-md border-l border-sidebar-border/60 px-2 text-[11px] text-sidebar-foreground/60 hover:bg-sidebar-accent disabled:opacity-50",
        selected && focusedPane === "secondary" && "bg-sidebar-accent text-sidebar-accent-foreground",
      )}
      onClick={() => {
        if (!sideChat) {
          ctx.onCreateSplitTaskInWorkspace(workspaceId);
          return;
        }
        useSessionManagementStore.getState().clearUnread(sideChat.sessionId);
        setFocusRequested(true);
        if (!selected) ctx.onOpenSession(workspaceId, sessionId);
      }}
    >
      {isActiveWork || isNeedsAttentionSessionStatus(status) || isUnread
        ? <SessionStatusIndicator status={status} isActiveWork={isActiveWork} isUnread={isUnread} />
        : <Plus className="size-3" />}
      {sideChat ? <span>{t("session_management.split_view")}</span> : null}
    </button>
  );
}

export type AppSidebarProps = {
  sessionNumberShortcuts: SessionNumberShortcutsState;
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
  onCreateTaskInWorkspace: (workspaceId: string, groupId?: string) => void;
  onCreateSplitTaskInWorkspace: (workspaceId: string) => void;
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
  automationsActive?: boolean;
  automationsNeedAttention?: boolean;
  onOpenAutomations?: () => void;
  dashboardActive?: boolean;
  onOpenDashboard?: () => void;
  /** Opens the cross-session message search dialog (Cmd/Ctrl+Shift+F). */
  onOpenSessionSearch?: () => void;
  /** Back/forward across recently viewed conversations, rendered at the top of the sidebar. */
  conversationHistory?: {
    canGoBack: boolean;
    canGoForward: boolean;
    onNavigate: (direction: "back" | "forward") => void;
  };
  onReorderWorkspaces?: (workspaceIds: string[]) => void;
  onStartResize?: React.PointerEventHandler<HTMLButtonElement>;
  onOpenAccountSettings?: () => void;
  onOpenExtensions: () => void;
  extensionsActive?: boolean;
  /** Live app status, shown inside the footer account menu. */
  status: Omit<AccountStatusMenuProps, "onOpenAccountSettings">;
};

function isSessionActivityStatus(status: string | undefined): status is SessionActivityStatus {
  return status === "idle" || status === "thinking" || status === "responding" || status === "error" || status === "compacting" || status === "waiting";
}

export function AppSidebar(props: AppSidebarProps) {
  // Lives in the UI store (not component state) so the open/closed state of
  // each workspace group survives this sidebar unmounting, e.g. while the
  // user is in Settings.
  const expandedWorkspaceIdList = useUiStateStore((state) => state.expandedWorkspaceIds);
  const expandWorkspace = useUiStateStore((state) => state.expandWorkspace);
  const toggleWorkspaceExpanded = useUiStateStore((state) => state.toggleWorkspaceExpanded);
  const expandedWorkspaceIds = React.useMemo(
    () => new Set(expandedWorkspaceIdList),
    [expandedWorkspaceIdList],
  );
  const [previewCountByWorkspaceId, setPreviewCountByWorkspaceId] = React.useState<Record<string, number>>({});
  const previousSessionStatusRef = React.useRef<Record<string, string>>({});
  const sessionNumberShortcutByTarget = React.useMemo(
    () => new Map(props.sessionNumberShortcuts.targets.map((target) => [
      sessionNumberShortcutTargetKey(target.workspaceId, target.sessionId),
      target.digit,
    ])),
    [props.sessionNumberShortcuts.targets],
  );

  // Green unread dots: agent finished while the user was on another session.
  React.useEffect(() => {
    const statuses = props.sessionStatusById ?? {};
    const previous = previousSessionStatusRef.current;
    const selectedId = props.selectedSessionId;
    const store = useSessionManagementStore.getState();

    for (const [sessionId, status] of Object.entries(statuses)) {
      if (sessionId === selectedId) {
        store.clearUnread(sessionId);
        continue;
      }
      const prior = previous[sessionId];
      if (isActiveWorkSessionStatus(prior) && status === "idle") {
        store.markUnread(sessionId);
      }
    }

    if (selectedId) store.clearUnread(selectedId);
    previousSessionStatusRef.current = statuses;
  }, [props.selectedSessionId, props.sessionStatusById]);

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
    onCreateSplitTaskInWorkspace: props.onCreateSplitTaskInWorkspace,
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
    expandedWorkspaceIds,
    sessionNumberShortcutOs: props.sessionNumberShortcuts.os,
    sessionNumberShortcutByTarget,
  };

  const brandLogoUrl = useBrandLogoUrl();
  const brandAppName = useBrandAppName();
  const pinnedIds = useSessionManagementStore((state) => state.pinnedIds);
  const pinnedSessions = React.useMemo(() => {
    const sessionsById = new Map<string, GlobalPinnedSessionEntry>();
    for (const group of props.workspaceSessionGroups) {
      const roots = getRootSessions(partitionArchivedSessions(group.sessions).active);
      for (const session of roots) {
        sessionsById.set(session.id, { group, sessionId: session.id });
      }
    }
    return pinnedIds.flatMap((sessionId) => {
      const entry = sessionsById.get(sessionId);
      return entry ? [entry] : [];
    });
  }, [pinnedIds, props.workspaceSessionGroups]);
  const archivedSessions = React.useMemo(() => {
    const entries: GlobalArchivedSessionEntry[] = [];
    for (const group of props.workspaceSessionGroups) {
      for (const session of partitionArchivedSessions(group.sessions).archived) {
        entries.push({ group, session });
      }
    }
    return entries;
  }, [props.workspaceSessionGroups]);

  return (
    <SidebarContext.Provider value={contextValue}>
      <Sidebar
        collapsible="offcanvas"
        className="border-e-0 group-data-[side=left]:border-e-0 mac:**:data-[sidebar=sidebar]:bg-transparent"
      >
        <div className="hidden h-12 mac:block mac:titlebar-drag"/>
        {brandLogoUrl ? (
          <div
            data-testid="brand-logo"
            className="flex h-14 shrink-0 items-center px-3 pb-3 pt-2 mac:pt-0"
          >
            <img
              src={brandLogoUrl}
              alt="Organization logo"
              className="max-h-9 w-auto max-w-[140px] object-contain object-left"
            />
          </div>
        ) : (
          <div data-sidebar-brand className="flex h-11 shrink-0 items-center gap-2 px-4 mac:titlebar-drag">
            <img src={resolveExtensionIconSrc("/openwork-mark.svg")} alt="" className="size-5 shrink-0 object-contain dark:invert" />
            <span className="truncate text-[15px] font-medium tracking-[-0.4px]" title={brandAppName}>{brandAppName}</span>
          </div>
        )}
        {props.conversationHistory ? (
          <div
            className="flex shrink-0 items-center justify-end gap-0.5 px-2 pb-1 max-lg:hidden mac:absolute mac:right-1.5 mac:top-[7px] mac:z-50 mac:p-0 mac:titlebar-no-drag"
            role="group"
            aria-label="Conversation history controls"
          >
            <Button
              variant="ghost"
              size="icon-xs"
              className="rounded-lg text-sidebar-foreground/60 transition-colors hover:text-sidebar-foreground disabled:opacity-40"
              aria-label="Back in conversation history"
              title="Back in conversation history"
              data-conversation-history-control="back"
              disabled={!props.conversationHistory.canGoBack}
              onClick={() => props.conversationHistory?.onNavigate("back")}
            >
              <ArrowLeft size={14} />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="rounded-lg text-sidebar-foreground/60 transition-colors hover:text-sidebar-foreground disabled:opacity-40"
              aria-label="Forward in conversation history"
              title="Forward in conversation history"
              data-conversation-history-control="forward"
              disabled={!props.conversationHistory.canGoForward}
              onClick={() => props.conversationHistory?.onNavigate("forward")}
            >
              <ArrowRight size={14} />
            </Button>
          </div>
        ) : null}
        <SidebarHeader className="mb-0 mt-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                type="button"
                data-sidebar-new-chat
                className="bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                aria-label={t("session.new_task")}
                tooltip={t("session.new_task")}
                disabled={props.newTaskDisabled}
                onClick={() => props.onCreateTaskInWorkspace(props.selectedWorkspaceId)}
              >
                <SquarePen className="size-4" />
                <span className="flex-1 truncate">{t("session.new_task")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {props.onOpenSessionSearch ? (
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={props.onOpenSessionSearch}
                  aria-keyshortcuts={isMacPlatform() ? "Meta+Shift+F" : "Control+Shift+F"}
                  className="text-sidebar-foreground/70"
                >
                  <Search className="size-4" />
                  <span className="flex-1 truncate">{t("workspace_list.search_sessions")}</span>
                  <kbd className="ml-auto font-sans text-[11px] tracking-wide text-sidebar-foreground/50 max-lg:hidden pointer-coarse:hidden">
                    {isMacPlatform() ? "⌘⇧F" : "Ctrl+Shift+F"}
                  </kbd>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}
            {props.onOpenDashboard ? (
              <SidebarDestination
                active={props.dashboardActive === true}
                icon={Blocks}
                label="Dashboard"
                onSelect={props.onOpenDashboard}
              />
            ) : null}
            {props.onOpenAutomations ? (
              <SidebarDestination
                active={props.automationsActive === true}
                icon={Clock3}
                label="Automations"
                labelContent={(
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate">Automations</span>
                    {props.automationsNeedAttention ? (
                      <AlertTriangle
                        data-automations-attention-indicator
                        className="ml-auto size-3.5 shrink-0 text-warning"
                        aria-label="An Automation needs attention"
                      />
                    ) : null}
                  </span>
                )}
                onSelect={props.onOpenAutomations}
              />
            ) : null}
            <SidebarDestination
              active={props.extensionsActive === true}
              icon={LayoutGrid}
              label={t("settings.tab_extensions")}
              onSelect={props.onOpenExtensions}
            />
            <SidebarMenuItem>
              <NotificationBell variant="sidebar-row" />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <LazyMotion features={domMax}>
          <m.div
            layoutScroll
            data-slot="sidebar-content"
            data-sidebar="content"
            data-session-number-modifier-held={props.sessionNumberShortcuts.modifierHeld ? "true" : undefined}
            className="no-scrollbar flex min-h-0 flex-1 flex-col gap-0 overflow-x-hidden overflow-y-auto [--radius:var(--radius-md)] group-data-[collapsible=icon]:overflow-hidden"
          >
            {pinnedSessions.length > 0 ? (
              <GlobalPinnedSessions entries={pinnedSessions} />
            ) : null}
            <div className={cn("group/workspaces-header flex h-6 items-center mt-4", SIDEBAR_SECTION_LANE)}>
              <span className={SIDEBAR_SECTION_LABEL}>
                {t("workspace_list.title")}
              </span>
              {canCreateWorkspaces() ? (
                <button
                  type="button"
                  className="ml-auto flex size-5 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-foreground"
                  onClick={props.onOpenCreateWorkspace}
                  aria-label={t("workspace_list.add_workspace")}
                  title={t("workspace_list.add_workspace")}
                >
                  <Plus className="size-3.5" />
                </button>
              ) : null}
            </div>
            <Reorder.Group
              as="div"
              axis="y"
              values={props.workspaceSessionGroups.map((group) => group.workspace.id)}
              onReorder={(workspaceIds) => props.onReorderWorkspaces?.(workspaceIds)}
              className="flex flex-col gap-0.5"
            >
              {props.workspaceSessionGroups.map((group, index) => (
                <WorkspaceReorderItem
                  key={group.workspace.id}
                  group={group}
                  className={cn(index === 0 && "mac:pt-0")}
                  previewCount={previewCount(group.workspace.id)}
                  showMoreSessions={showMoreSessions}
                />
              ))}
            </Reorder.Group>
            {archivedSessions.length > 0 ? (
              <GlobalArchivedSessions entries={archivedSessions} />
            ) : null}
          </m.div>
        </LazyMotion>

        <SidebarFooter className="border-t border-sidebar-border/60 p-1.5 pe-0">
          <AccountStatusMenu {...props.status} onOpenAccountSettings={props.onOpenAccountSettings} />
        </SidebarFooter>

        <SidebarRail
          style={{ cursor: "col-resize" }}
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

type GlobalPinnedSessionEntry = {
  group: WorkspaceSessionGroup;
  sessionId: string;
};

function GlobalPinnedSessions({ entries }: { entries: GlobalPinnedSessionEntry[] }) {
  return (
    <SidebarGroup data-global-pinned-sessions className="pb-0 pt-4">
      <SidebarGroupContent>
        <div className="flex h-6 items-center pe-2 ps-2.5">
          <span className={SIDEBAR_SECTION_LABEL}>{t("session_management.pinned")}</span>
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuSub>
              {entries.map((entry) => (
                <GlobalPinnedSessionTree
                  key={`${entry.group.workspace.id}:${entry.sessionId}`}
                  group={entry.group}
                  sessionId={entry.sessionId}
                />
              ))}
            </SidebarMenuSub>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

type GlobalArchivedSessionEntry = {
  group: WorkspaceSessionGroup;
  session: SessionListItem;
};

function GlobalArchivedSessions({ entries }: { entries: GlobalArchivedSessionEntry[] }) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <SidebarGroup data-global-archived-sessions className="mt-4 pb-1 pt-0">
      <SidebarGroupContent>
        <Collapsible open={expanded} onOpenChange={setExpanded} className="group/archived">
          <CollapsibleTrigger
            render={
              <button
                type="button"
                className={cn("group/separator flex h-6 w-full cursor-pointer items-center gap-2 pe-2 rounded-md transition-colors hover:bg-sidebar-accent/50", SIDEBAR_ROW_LANE)}
              >
                <SidebarGlyphSlot>
                  <Archive className="size-3.5 text-muted-foreground" />
                </SidebarGlyphSlot>
                <span className={SIDEBAR_SECTION_LABEL}>
                  {t("session_management.archived_label")}
                </span>
                <span className="text-[10px] tabular-nums text-muted-foreground/70">{entries.length}</span>
                <ChevronRight className="ml-auto size-3.5 text-muted-foreground transition-transform duration-200 group-data-open/archived:rotate-90" />
              </button>
            }
          />
          <CollapsibleContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuSub>
                  {entries.map((entry) => (
                    <GlobalArchivedSessionItem
                      key={`${entry.group.workspace.id}:${entry.session.id}`}
                      group={entry.group}
                      session={entry.session}
                    />
                  ))}
                </SidebarMenuSub>
              </SidebarMenuItem>
            </SidebarMenu>
          </CollapsibleContent>
        </Collapsible>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function GlobalArchivedSessionItem({ group, session }: GlobalArchivedSessionEntry) {
  const pinnedIds = usePinnedSessionIds();

  return (
    <SessionMenuItem
      session={session}
      workspaceId={group.workspace.id}
      isPinned={pinnedIds.has(session.id)}
      workspaceName={workspaceLabel(group.workspace)}
    />
  );
}

function GlobalPinnedSessionTree({ group, sessionId }: GlobalPinnedSessionEntry) {
  const pinnedIds = usePinnedSessionIds();
  const rootIds = React.useMemo(() => new Set([sessionId]), [sessionId]);
  const rows = flattenSessionRows(
    group.sessions,
    1,
    pinnedIds,
    [],
    { include: rootIds },
  );

  return rows.map((row) => (
    <SessionMenuItem
      key={row.session.id}
      session={row.session}
      workspaceId={group.workspace.id}
      isPinned={pinnedIds.has(row.session.id)}
      workspaceName={workspaceLabel(group.workspace)}
    />
  ));
}

type WorkspaceReorderItemProps = {
  className: string;
  group: WorkspaceSessionGroup;
  previewCount: number;
  showMoreSessions: (workspaceId: string, totalRoots: number) => void;
};

function WorkspaceReorderItem({
  className,
  group,
  previewCount,
  showMoreSessions,
}: WorkspaceReorderItemProps) {
  const dragControls = useDragControls();

  return (
    <Reorder.Item
      as="div"
      value={group.workspace.id}
      id={group.workspace.id}
      data-sidebar-workspace-id={group.workspace.id}
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
        previewCount={previewCount}
        showMoreSessions={showMoreSessions}
        onWorkspaceTitlePointerDown={(event) => dragControls.start(event)}
      />
    </Reorder.Item>
  );
}

type WorkspaceHeaderProps = {
  workspace: WorkspaceInfo;
  statusLabel: string;
  isError: boolean;
  isLoading: boolean;
  onTitlePointerDown: React.PointerEventHandler<HTMLButtonElement>;
};

function WorkspaceHeader({
  workspace,
  statusLabel,
  isError,
  isLoading,
  onTitlePointerDown,
}: WorkspaceHeaderProps) {
  const ctx = useSidebarContext();
  const label = workspaceLabel(workspace);
  // Same reveal pattern as task rows: the name fades only where text is
  // hidden and scrolls into view on mouse hover or keyboard focus.
  const [isTitleHovered, setIsTitleHovered] = React.useState(false);
  const [isTitleFocused, setIsTitleFocused] = React.useState(false);
  const titleIntent = isTitleFocused ? "focus" : isTitleHovered ? "hover" : null;

  const handleSelectWorkspace = () => {
    void Promise.resolve(ctx.onSelectWorkspace(workspace.id));
  };

  return (
    <SidebarMenuButton
      render={<div />}
      className={cn(
        "gap-2 group-hover/workspace-header:bg-sidebar-accent group-hover/workspace-header:text-sidebar-accent-foreground mac:group-hover/workspace-header:bg-black/5 dark:mac:group-hover/workspace-header:bg-white/10",
        statusLabel && "h-10",
      )}
    >
      <SidebarGlyphSlot>
        {isLoading ? (
          <SessionDotMatrixLoader label={t("workspace.loading_tasks")} />
        ) : (
          <WorkspaceAvatarPicker workspaceId={workspace.id} label={label} />
        )}
      </SidebarGlyphSlot>
      <button
        type="button"
        data-sidebar-workspace-drag-handle
        data-sidebar-workspace-title
        // `items-stretch` (not `items-start`) so the title viewport spans the
        // row up to the reserved action padding instead of shrinking to its
        // text, which put the fade on the last letters of every name.
        className="min-w-0 flex h-full flex-1 cursor-grab touch-none flex-col items-stretch justify-center border-0 bg-transparent p-0 text-left text-inherit active:cursor-grabbing pr-8 group-hover/workspace-header:pr-20 group-has-[[data-workspace-actions]:focus-within]/workspace-header:pr-20 group-has-data-popup-open/workspace-header:pr-20"
        aria-label={statusLabel ? `${label}, ${statusLabel}` : label}
        onPointerDown={onTitlePointerDown}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") setIsTitleHovered(true);
        }}
        onPointerLeave={() => setIsTitleHovered(false)}
        onFocus={() => setIsTitleFocused(true)}
        onBlur={() => setIsTitleFocused(false)}
        onClick={handleSelectWorkspace}
      >
        <span className="flex min-w-0 items-center">
          <SessionTitle intent={titleIntent} title={label} tooltip={label} />
        </span>
        {statusLabel ? (
          <span className={cn("block text-xs", isError ? "text-destructive" : "text-muted-foreground")}>
            {statusLabel}
          </span>
        ) : null}
      </button>
    </SidebarMenuButton>
  );
}

type WorkspaceSidebarGroupProps = {
  className: string;
  group: WorkspaceSessionGroup;
  previewCount: number;
  showMoreSessions: (workspaceId: string, totalRoots: number) => void;
  onWorkspaceTitlePointerDown: React.PointerEventHandler<HTMLButtonElement>;
};

function WorkspaceSidebarGroup({
  className,
  group,
  previewCount,
  showMoreSessions,
  onWorkspaceTitlePointerDown,
}: WorkspaceSidebarGroupProps) {
  const ctx = useSidebarContext();
  const workspace = group.workspace;

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

  const { active: activeSessions } = React.useMemo(
    () => partitionArchivedSessions(group.sessions),
    [group.sessions],
  );
  const sessionRows = flattenSessionRows(
    group.sessions,
    wsGroups.length > 0 ? Number.MAX_SAFE_INTEGER : previewCount,
    EMPTY_PINNED_IDS,
    orderIds,
    { exclude: pinnedIds },
  );
  const visibleRootIds = React.useMemo(
    () => sessionRows.map((row) => row.session.id),
    [sessionRows],
  );
  const activeRootCount = React.useMemo(
    () => getRootSessions(activeSessions).filter((session) => !pinnedIds.has(session.id)).length,
    [activeSessions, pinnedIds],
  );
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
                isLoading={isConnecting}
                onTitlePointerDown={onWorkspaceTitlePointerDown}
              />
              <div
                data-workspace-actions
                className="group/workspace-actions absolute right-8 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 opacity-0 pointer-events-none transition-opacity group-hover/workspace-header:opacity-100 group-hover/workspace-header:pointer-events-auto group-focus-within/workspace-actions:opacity-100 group-focus-within/workspace-actions:pointer-events-auto group-has-data-popup-open/workspace-header:opacity-100 group-has-data-popup-open/workspace-header:pointer-events-auto"
              >
                <Button
                  variant="ghost"
                  size="icon"
                  data-workspace-new-task
                  className="size-5 text-muted-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    ctx.onCreateTaskInWorkspace(workspace.id);
                  }}
                  aria-label={`${t("session.new_task")} · ${workspaceLabel(workspace)}`}
                  title={t("session.new_task")}
                >
                  <Plus className="size-4" />
                </Button>
                <WorkspaceActionsMenu
                  workspace={workspace}
                  isConnectionActionBusy={isConnectionActionBusy}
                  canRecover={canRecover}
                  className="size-5 text-muted-foreground"
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-2 top-1/2 z-10 size-5 -translate-y-1/2 text-muted-foreground flex items-center justify-center group/expand-collapse-button"
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
                ) : group.status === "loading" && group.sessions.length === 0 ? null : activeSessions.length > 0 ? (
                  <>
                    {wsGroups.length > 0 ? (
                      <GroupedSessionList
                        sessionRows={sessionRows}
                        groups={wsGroups}
                        assignments={wsAssignments}
                        pinnedIds={pinnedIds}
                        workspaceId={workspace.id}
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
                        className="flex flex-col gap-0.5"
                      >
                        {sessionRows.map((row) => (
                          <SessionMenuItem
                            key={row.session.id}
                            session={row.session}
                            workspaceId={workspace.id}
                            isPinned={pinnedIds.has(row.session.id)}
                            draggable
                          />
                        ))}
                      </Reorder.Group>
                    )}
                    {wsGroups.length === 0 && activeRootCount > previewCount ? (
                      <ShowMoreSessionsButton
                        label={showMoreLabel}
                        onClick={() => showMoreSessions(workspace.id, activeRootCount)}
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
const EMPTY_PINNED_IDS = new Set<string>();
const UNGROUPED_GROUP_ID = "__openwork_ungrouped";

function SessionGroupActions({ group, groups, workspaceId, count }: {
  group: SessionGroupDefinition;
  groups: SessionGroupDefinition[];
  workspaceId: string;
  count: number;
}) {
  const ctx = useSidebarContext();
  const [expanded, setExpanded] = React.useState(false);
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [renameLabel, setRenameLabel] = React.useState(group.label);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleteDestination, setDeleteDestination] = React.useState(UNGROUPED_GROUP_ID);
  const otherGroups = groups.filter((candidate) => candidate.id !== group.id);
  const trimmedRenameLabel = renameLabel.trim();
  const deleteDestinationLabel = deleteDestination === UNGROUPED_GROUP_ID
    ? t("session_management.ungrouped")
    : otherGroups.find((candidate) => candidate.id === deleteDestination)?.label;

  React.useEffect(() => {
    if (!renameOpen) setRenameLabel(group.label);
  }, [group.label, renameOpen]);

  const saveRename = () => {
    if (!trimmedRenameLabel) return;
    useSessionManagementStore.getState().renameGroup(workspaceId, group.id, trimmedRenameLabel);
    setRenameOpen(false);
  };

  return (
    <>
      <span
        data-session-group-actions={group.id}
        className={cn(
          "relative ml-auto flex h-5 shrink-0 items-center justify-end overflow-hidden transition-[width] duration-150",
          expanded ? "w-15" : "w-4",
        )}
        onMouseLeave={() => setExpanded(false)}
      >
        <span data-session-group-count className="text-[10px] tabular-nums text-muted-foreground/70 group-hover/separator:hidden">
          {count}
        </span>
        {!expanded ? (
          <button
            type="button"
            className="hidden size-5 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-foreground group-hover/separator:flex"
            onMouseEnter={() => setExpanded(true)}
            onFocus={() => setExpanded(true)}
            onClick={(event) => event.stopPropagation()}
            aria-label={t("session_management.group_actions")}
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        ) : (
          <span className="flex items-center">
            <button
              type="button"
              className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                ctx.onCreateTaskInWorkspace(workspaceId, group.id);
                setExpanded(false);
              }}
              aria-label={t("session_management.new_session_in_group")}
            >
              <Plus className="size-3" />
            </button>
            <button
              type="button"
              className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                setRenameLabel(group.label);
                setRenameOpen(true);
              }}
              aria-label={t("session_management.rename_group")}
            >
              <Pencil className="size-3" />
            </button>
            <button
              type="button"
              className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              onClick={(event) => {
                event.stopPropagation();
                setDeleteDestination(UNGROUPED_GROUP_ID);
                setDeleteOpen(true);
              }}
              aria-label={t("session_management.delete_group")}
            >
              <Trash2 className="size-3" />
            </button>
          </span>
        )}
      </span>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("session_management.rename_group")}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={renameLabel}
            onChange={(event) => setRenameLabel(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") saveRename();
            }}
            aria-label={t("session_management.group_name")}
          />
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>
              {t("common.cancel")}
            </DialogClose>
            <Button type="button" disabled={!trimmedRenameLabel} onClick={saveRename}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("session_management.delete_group")}</DialogTitle>
          </DialogHeader>
          <label className="grid gap-2 text-sm font-medium">
            {t("session_management.move_sessions_to")}
            <Select
              value={deleteDestination}
              onValueChange={(value) => setDeleteDestination(value ?? UNGROUPED_GROUP_ID)}
            >
              <SelectTrigger className="w-full rounded-xl" data-destination-group-id={deleteDestination}>
                <SelectValue>{deleteDestinationLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent align="start">
                <SelectItem value={UNGROUPED_GROUP_ID}>{t("session_management.ungrouped")}</SelectItem>
                {otherGroups.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>{candidate.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>
              {t("common.cancel")}
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                useSessionManagementStore.getState().removeGroup(
                  workspaceId,
                  group.id,
                  deleteDestination === UNGROUPED_GROUP_ID ? null : deleteDestination,
                );
                setDeleteOpen(false);
              }}
            >
              {t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SessionGroupSeparator({ label, count, expanded, onToggle, group, groups, workspaceId, onTitlePointerDown }: {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  group?: SessionGroupDefinition;
  groups?: SessionGroupDefinition[];
  workspaceId?: string;
  onTitlePointerDown?: React.PointerEventHandler<HTMLSpanElement>;
}) {
  return (
    <div
      data-session-group={group?.id}
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        onToggle();
      }}
      className={cn("group/separator flex h-8 w-full items-center gap-2 rounded-md pe-2 text-left transition-colors hover:bg-sidebar-accent/50")}
      style={{ paddingInlineStart: sidebarRowPaddingInlineStart(0) }}
      aria-expanded={expanded}
    >
      <SidebarGlyphSlot>
        <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform duration-200", expanded && "rotate-90")} />
      </SidebarGlyphSlot>
      <span
        className={cn("min-w-0 flex-1 cursor-grab touch-none ow-fade-truncate active:cursor-grabbing", SIDEBAR_SECTION_LABEL)}
        onPointerDown={onTitlePointerDown}
      >
        {label}
      </span>
      {group && groups && workspaceId ? (
        <SessionGroupActions group={group} groups={groups} workspaceId={workspaceId} count={count} />
      ) : (
        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/70">{count}</span>
      )}
    </div>
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
function GroupedSessionList({ sessionRows, groups, assignments, pinnedIds, workspaceId, store }: {
  sessionRows: FlattenedSessionRow[];
  groups: SessionGroupDefinition[];
  assignments: Record<string, string>;
  pinnedIds: Set<string>;
  workspaceId: string;
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

  for (const row of sessionRows) {
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
    <SessionMenuItem
      key={row.session.id}
      session={row.session}
      workspaceId={workspaceId}
      isPinned={pinnedIds.has(row.session.id)}
    />
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
        className="flex flex-col gap-0.5"
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
                  const allRootIds = sessionRows.map((r) => r.session.id);
                  const ungroupedSet = new Set(ungroupedRows.map((r) => r.session.id));
                  const visibleSet = new Set(ids);
                  const fullUngrouped = [...ids, ...ungroupedRows.map((r) => r.session.id).filter((id) => !visibleSet.has(id))];
                  let ui = 0;
                  const full = allRootIds.map((id) => ungroupedSet.has(id) ? fullUngrouped[ui++] : id);
                  store.getState().reorderSessions(workspaceId, full);
                }}
                className="flex flex-col gap-0.5"
              >
                {visibleUngroupedRows.map((row) => (
                  <SessionMenuItem
                    key={row.session.id}
                    session={row.session}
                    workspaceId={workspaceId}
                    isPinned={pinnedIds.has(row.session.id)}
                    draggable
                  />
                ))}
              </Reorder.Group>
              {ungroupedRemaining > 0 ? (
                <ShowMoreSessionsButton
                  label={t("workspace_list.show_more", { count: Math.min(MAX_SESSIONS_PREVIEW, ungroupedRemaining) })}
                  onClick={() => showMoreInGroup(UNGROUPED_GROUP_ID, ungroupedRows.length)}
                />
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
            group={group}
            groups={store.getState().groupsByWorkspace[workspaceId]?.groups ?? []}
            workspaceId={workspaceId}
            onTitlePointerDown={(event) => dragControls.start(event)}
          />
          <CollapsibleContent className="flex flex-col gap-0.5">
            {visibleRows.length > 0
              ? (
                <>
                  {visibleRows.map(renderRow)}
                  {remaining > 0 ? (
                    <ShowMoreSessionsButton
                      label={t("workspace_list.show_more", { count: Math.min(MAX_SESSIONS_PREVIEW, remaining) })}
                      onClick={onShowMore}
                    />
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

type SessionMenuItemProps = {
  session: SessionListItem;
  workspaceId: string;
  isPinned?: boolean;
  draggable?: boolean;
  workspaceName?: string;
};

function SessionNumberShortcutSlot({ digit }: { digit: number | undefined }) {
  const ctx = useSidebarContext();
  if (digit === undefined) return null;

  const label = sessionNumberShortcutLabel(ctx.sessionNumberShortcutOs, digit);

  return (
    <span
      data-session-action-slot="number-shortcut"
      aria-hidden="true"
      className={cn(
        "flex h-5 shrink-0 items-center justify-center",
        ctx.sessionNumberShortcutOs === "macos" ? "w-8" : "w-11",
      )}
    >
      <kbd
        data-session-shortcut-badge={digit}
        className="inline-flex h-5 items-center justify-center rounded-md border border-sidebar-border/70 bg-sidebar-accent/80 px-1.5 font-sans text-[10px] font-medium leading-none tracking-tight text-sidebar-foreground/70 shadow-xs"
      >
        {label}
      </kbd>
    </span>
  );
}

function SessionMenuItem({
  session,
  workspaceId,
  isPinned = false,
  draggable = false,
  workspaceName,
}: SessionMenuItemProps) {
  const ctx = useSidebarContext();
  const attachedAsSideChat = useWorkbenchStore((state) => Object.values(state.sideChats).some((chat) =>
    isSameWorkbenchSession(chat, { workspaceId, sessionId: session.id })));
  const [isTitleHovered, setIsTitleHovered] = React.useState(false);
  const [isTitleFocused, setIsTitleFocused] = React.useState(false);
  const unreadIds = useUnreadSessionIds();
  const isSelected = ctx.selectedSessionId === session.id;
  const displayTitle = getDisplaySessionTitle(session.title);
  const itemTitle = workspaceName ? `${displayTitle} — ${workspaceName}` : displayTitle;
  const sessionActivityStatus = ctx.sessionStatusById?.[session.id];
  const resolvedActiveWork = isActiveWorkSessionStatus(sessionActivityStatus);
  const isUnread = unreadIds.has(session.id) && !isSelected;
  const isArchived = isSessionArchived(session);
  const relativeTime = formatSessionRelativeTime(session.time?.updated ?? session.time?.created);
  const shortcutDigit = ctx.sessionNumberShortcutByTarget.get(
    sessionNumberShortcutTargetKey(workspaceId, session.id),
  );
  const ariaKeyShortcuts = shortcutDigit === undefined
    ? undefined
    : sessionNumberAriaKeyShortcut(ctx.sessionNumberShortcutOs, shortcutDigit);

  const openSession = () => {
    useSessionManagementStore.getState().clearUnread(session.id);
    ctx.onOpenSession(workspaceId, session.id);
  };

  const prefetchSession = () => {
    if (workspaceId !== ctx.selectedWorkspaceId) {
      return;
    }

    ctx.onPrefetchSession?.(workspaceId, session.id);
  };

  const handlePointerEnter = (event: React.PointerEvent) => {
    prefetchSession();
    if (event.pointerType === "mouse") setIsTitleHovered(true);
  };

  const titleIntent = isTitleFocused ? "focus" : isTitleHovered ? "hover" : null;

  const dragProps = {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(SESSION_DRAG_TYPE, session.id);
      e.dataTransfer.effectAllowed = "move";
    },
  };

  const accessibleState = resolvedActiveWork && isSessionActivityStatus(sessionActivityStatus)
    ? `${displayTitle}, ${getSessionActivityStatusLabel(sessionActivityStatus)}`
    : isNeedsAttentionSessionStatus(sessionActivityStatus)
      ? `${displayTitle}, ${t("workspace_list.session_needs_attention")}`
      : isUnread
        ? `${displayTitle}, ${t("workspace_list.session_unread")}`
        : itemTitle;

  const rowButtonClass = cn(
    // Soft pill @ 11px radius from Paper; overlay tint adapts to theme
    // (light: --ow-light-hover ≈ black/5, dark: #FFFFFF17 ≈ white/9).
    // The end padding tracks SessionHoverQuickActions: reserve their width
    // whenever they show, including the layouts that show them without hover.
    "relative h-8 rounded-md transition-[padding,background-color] duration-75 pe-7 group-hover/menu-sub-item:pe-18 group-has-data-popup-open/menu-sub-item:pe-18 max-lg:pe-18 pointer-coarse:pe-18 group-hover/menu-sub-item:bg-black/[0.05] dark:group-hover/menu-sub-item:bg-white/[0.09] data-active:bg-black/[0.07] dark:data-active:bg-white/[0.12] text-[13px] text-sidebar-foreground/80 data-active:text-sidebar-foreground",
  );
  const rowButtonStyle = {
    paddingInlineStart: sidebarRowPaddingInlineStart(0),
  } as const;

  // Pinned/archived rows identify their workspace via the tooltip title
  // only — no workspace color dot in these sections.
  const leading = (
    <SessionStatusIndicator status={sessionActivityStatus} isActiveWork={resolvedActiveWork} isUnread={isUnread} />
  );

  const trailing = (
    <>
      <SessionHoverQuickActions
        sessionId={session.id}
        isPinned={isPinned}
        isArchived={isArchived}
        relativeTime={relativeTime}
      />
    </>
  );

  const item = (
    <SidebarMenuSubItem
      {...dragProps}
      className="flex items-center"
      data-sidebar-session-id={session.id}
      data-sidebar-session-workspace-id={workspaceId}
    >
      <SessionContextMenu
        sessionId={session.id}
        workspaceId={workspaceId}
        sessionTitle={displayTitle}
        workspaceTitle={workspaceName}
        isPinned={isPinned}
        isArchived={isArchived}
      >
        <div className="relative min-w-0 flex-1">
          <SidebarMenuSubButton
            isActive={isSelected}
            data-session-tab-id={session.id}
            data-session-tab-active={isSelected ? "true" : undefined}
            onClick={openSession}
            onPointerEnter={handlePointerEnter}
            onPointerLeave={() => setIsTitleHovered(false)}
            onFocus={() => {
              prefetchSession();
              setIsTitleFocused(true);
            }}
            onBlur={() => setIsTitleFocused(false)}
            aria-label={accessibleState}
            aria-description={shortcutDigit === undefined ? undefined : sessionNumberShortcutDescription(ctx.sessionNumberShortcutOs, shortcutDigit)}
            aria-keyshortcuts={ariaKeyShortcuts}
            className={rowButtonClass}
            style={rowButtonStyle}
          >
            {leading}
            <SessionTitle intent={titleIntent} title={displayTitle} tooltip={itemTitle} />
            <SessionNumberShortcutSlot digit={shortcutDigit} />
          </SidebarMenuSubButton>
          {trailing}
        </div>
      </SessionContextMenu>
      <SessionSideChatControl workspaceId={workspaceId} sessionId={session.id} title={displayTitle} />
    </SidebarMenuSubItem>
  );

  if (attachedAsSideChat && !isSelected) return null;
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
