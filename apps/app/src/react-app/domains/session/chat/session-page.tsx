/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { Check, HardDrive, Loader2, Minimize2, RefreshCcw, Redo2, Shield, Undo2, Zap } from "lucide-react";

import { t } from "../../../../i18n";
import { buildOpenworkWorkspaceBaseUrl, type OpenworkServerClient, type OpenworkServerStatus } from "../../../../app/lib/openwork-server";
import { getDisplaySessionTitle } from "../../../../app/lib/session-title";
import type { BootPhase } from "../../../../app/lib/startup-boot";
import type { WorkspaceInfo } from "../../../../app/lib/tauri";
import type {
  PendingPermission,
  PendingQuestion,
  ProviderListItem,
  TodoItem,
  WorkspaceConnectionState,
  WorkspaceSessionGroup,
} from "../../../../app/types";
import type { ShareWorkspaceModalProps } from "../../workspace/types";
import { Button } from "../../../design-system/button";
import { ConfirmModal } from "../../../design-system/modals/confirm-modal";
import ProviderAuthModal, { type ProviderAuthModalProps } from "../../connections/provider-auth/provider-auth-modal";
import { QuestionModal } from "../modals/question-modal";
import { RenameSessionModal } from "../modals/rename-session-modal";
import { WorkspaceSessionList } from "../sidebar/workspace-session-list";
import { SessionSurface, type SessionSurfaceProps } from "../surface/session-surface";
import { ShareWorkspaceModal } from "../../workspace/share-workspace-modal";
import { StatusBar, type StatusBarProps } from "./status-bar";
import {
  DEFAULT_WORKSPACE_LEFT_SIDEBAR_WIDTH,
  useWorkspaceShellLayout,
} from "../../../shell/workspace-shell-layout";

type StatusBarOverrides = Pick<
  StatusBarProps,
  | "statusLabel"
  | "statusDetail"
  | "statusDotClass"
  | "statusPingClass"
  | "statusPulse"
  | "showSettingsButton"
  | "settingsOpen"
>;

export type SessionPageHistoryControls = {
  canUndo: boolean;
  canRedo: boolean;
  busyAction: "undo" | "redo" | null;
  onUndo: () => void | Promise<void>;
  onRedo: () => void | Promise<void>;
};

export type SessionPageSidebarProps = {
  workspaceSessionGroups: WorkspaceSessionGroup[];
  selectedWorkspaceId: string;
  selectedSessionId: string | null;
  developerMode: boolean;
  sessionStatusById: Record<string, string>;
  connectingWorkspaceId: string | null;
  workspaceConnectionStateById: Record<string, WorkspaceConnectionState>;
  newTaskDisabled: boolean;
  sidebarHydratedFromCache: boolean;
  startupPhase: BootPhase;
  onSelectWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  onOpenSession: (workspaceId: string, sessionId: string) => void;
  onPrefetchSession?: (workspaceId: string, sessionId: string) => void;
  onCreateTaskInWorkspace: (workspaceId: string) => void;
  onOpenRenameWorkspace: (workspaceId: string) => void;
  onShareWorkspace: (workspaceId: string) => void;
  onRevealWorkspace: (workspaceId: string) => void;
  onRecoverWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  onTestWorkspaceConnection: (workspaceId: string) => Promise<boolean> | boolean | void;
  onEditWorkspaceConnection: (workspaceId: string) => void;
  onForgetWorkspace: (workspaceId: string) => void;
  onOpenCreateWorkspace: () => void;
};

export type SessionPageSurfaceProps = Omit<
  SessionSurfaceProps,
  "client" | "workspaceId" | "sessionId" | "opencodeBaseUrl" | "openworkToken"
>;

export type SessionPageProps = {
  selectedSessionId: string | null;
  selectedWorkspaceId: string;
  selectedWorkspaceDisplay: {
    id?: string;
    name?: string;
    displayName?: string;
    workspaceType?: WorkspaceInfo["workspaceType"];
  };
  selectedWorkspaceRoot: string;
  runtimeWorkspaceId: string | null;
  workspaces: WorkspaceInfo[];
  clientConnected: boolean;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerClient: OpenworkServerClient | null;
  openworkServerToken?: string | null;
  developerMode: boolean;
  headerStatus: string;
  busyHint: string | null;
  startupPhase: BootPhase;
  providerConnectedIds: string[];
  providers?: ProviderListItem[];
  mcpConnectedCount: number;
  onSendFeedback: () => void;
  onOpenSettings: () => void;
  sidebar: SessionPageSidebarProps;
  surface?: SessionPageSurfaceProps | null;
  history?: SessionPageHistoryControls | null;
  todos: TodoItem[];
  sessionLoadingById: (sessionId: string | null) => boolean;
  shareWorkspaceModal?: ShareWorkspaceModalProps | null;
  providerAuthModal?: ProviderAuthModalProps | null;
  activePermission?: PendingPermission | null;
  permissionReplyBusy?: boolean;
  respondPermission?: (requestID: string, reply: "once" | "always" | "reject") => void;
  respondPermissionAndRemember?: (requestID: string, reply: "once" | "always" | "reject") => void;
  safeStringify?: (value: unknown) => string;
  activeQuestion?: PendingQuestion | null;
  questionReplyBusy?: boolean;
  respondQuestion?: (requestID: string, answers: string[][]) => void;
  statusBar?: Partial<StatusBarOverrides>;
  onRenameSession?: (sessionId: string, title: string) => Promise<void> | void;
  onDeleteSession?: (sessionId: string) => Promise<void> | void;
};

function describePermissionRequest(permission: PendingPermission | null | undefined) {
  if (!permission) {
    return {
      title: t("session.permission_required"),
      message: t("session.permission_message"),
      permissionLabel: "",
      scopeLabel: t("session.scope_label"),
      scopeValue: "",
      isDoomLoop: false,
      note: null as string | null,
    };
  }

  const patterns = permission.patterns.filter((pattern) => pattern.trim().length > 0);
  if (permission.permission === "doom_loop") {
    const tool =
      permission.metadata && typeof permission.metadata === "object" && typeof permission.metadata.tool === "string"
        ? permission.metadata.tool
        : null;
    return {
      title: t("session.doom_loop_title"),
      message: t("session.doom_loop_message"),
      permissionLabel: t("session.doom_loop_label"),
      scopeLabel: tool ? t("session.doom_loop_tool_label") : t("session.doom_loop_repeated_call_label"),
      scopeValue: tool ?? (patterns.length ? patterns.join(", ") : t("session.doom_loop_repeated_tool_call")),
      isDoomLoop: true,
      note: t("session.doom_loop_note"),
    };
  }

  return {
    title: t("session.permission_required"),
    message: t("session.permission_message"),
    permissionLabel: permission.permission,
    scopeLabel: t("session.scope_label"),
    scopeValue: patterns.join(", "),
    isDoomLoop: false,
    note: null as string | null,
  };
}

function getSidebarInitialLoading(props: SessionPageSidebarProps) {
  if (props.workspaceSessionGroups.some((group) => group.sessions.length > 0)) {
    return false;
  }
  if (props.sidebarHydratedFromCache) return false;
  if (
    props.startupPhase !== "sessionIndexReady" &&
    props.startupPhase !== "firstSessionReady" &&
    props.startupPhase !== "ready"
  ) {
    return true;
  }
  return props.workspaceSessionGroups.some(
    (group) => group.status === "loading" || group.status === "idle",
  );
}

function sessionTitleForId(groups: WorkspaceSessionGroup[], id: string | null | undefined) {
  if (!id) return "";
  for (const group of groups) {
    const match = group.sessions.find((session) => session.id === id);
    if (match) return getDisplaySessionTitle(match.title);
  }
  return "";
}

export function SessionPage(props: SessionPageProps) {
  const { leftSidebarWidth, startLeftSidebarResize } = useWorkspaceShellLayout({
    defaultLeftWidth: DEFAULT_WORKSPACE_LEFT_SIDEBAR_WIDTH,
    expandedRightWidth: 280,
  });

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [todoExpanded, setTodoExpanded] = useState(true);
  const [showDelayedSessionLoadingState, setShowDelayedSessionLoadingState] = useState(false);

  const selectedSessionTitle = useMemo(
    () => sessionTitleForId(props.sidebar.workspaceSessionGroups, props.selectedSessionId),
    [props.selectedSessionId, props.sidebar.workspaceSessionGroups],
  );
  const workspaceName =
    props.selectedWorkspaceDisplay.displayName?.trim() ||
    props.selectedWorkspaceDisplay.name?.trim() ||
    t("session.workspace_fallback");
  const providerCount = props.providerConnectedIds.length;
  const messageCountVisible = props.selectedSessionId ? 1 : 0;
  const showWorkspaceSetupEmptyState = props.workspaces.length === 0 && !props.selectedSessionId;
  const showStartupSkeleton =
    !props.selectedSessionId &&
    !props.clientConnected &&
    props.startupPhase !== "sessionIndexReady" &&
    props.startupPhase !== "firstSessionReady" &&
    props.startupPhase !== "ready";
  const showSessionLoadingState =
    Boolean(props.selectedSessionId) && props.sessionLoadingById(props.selectedSessionId) && !showWorkspaceSetupEmptyState;
  const permissionPresentation = useMemo(
    () => describePermissionRequest(props.activePermission),
    [props.activePermission],
  );
  const todos = useMemo(() => props.todos.filter((todo) => todo.content.trim()), [props.todos]);
  const completedTodos = useMemo(
    () => todos.filter((todo) => todo.status === "completed").length,
    [todos],
  );
  const sidebarInitialLoading = useMemo(() => getSidebarInitialLoading(props.sidebar), [props.sidebar]);

  const reactSessionBaseUrl = useMemo(() => {
    const workspaceId = props.runtimeWorkspaceId?.trim() ?? "";
    const baseUrl = props.openworkServerClient?.baseUrl?.trim() ?? "";
    if (!workspaceId || !baseUrl) return "";
    const mounted = buildOpenworkWorkspaceBaseUrl(baseUrl, workspaceId) ?? baseUrl;
    return `${mounted.replace(/\/+$/, "")}/opencode`;
  }, [props.openworkServerClient?.baseUrl, props.runtimeWorkspaceId]);

  const reactSessionToken = props.openworkServerClient?.token?.trim() || props.openworkServerToken?.trim() || "";
  const canRenderReactSurface = Boolean(
    props.selectedSessionId &&
      props.runtimeWorkspaceId &&
      props.openworkServerClient &&
      reactSessionBaseUrl &&
      reactSessionToken &&
      props.surface,
  );

  useEffect(() => {
    if (!showSessionLoadingState) {
      setShowDelayedSessionLoadingState(false);
      return;
    }
    const id = window.setTimeout(() => {
      setShowDelayedSessionLoadingState(true);
    }, 1000);
    return () => window.clearTimeout(id);
  }, [showSessionLoadingState]);

  useEffect(() => {
    setRenameOpen(false);
    setDeleteOpen(false);
    setRenameBusy(false);
    setDeleteBusy(false);
  }, [props.selectedSessionId]);

  const openRenameModal = () => {
    if (!props.selectedSessionId || !props.onRenameSession) return;
    setRenameTitle(selectedSessionTitle);
    setRenameOpen(true);
  };

  const submitRename = async () => {
    const sessionId = props.selectedSessionId;
    const nextTitle = renameTitle.trim();
    if (!sessionId || !props.onRenameSession || !nextTitle || nextTitle === selectedSessionTitle.trim()) return;
    setRenameBusy(true);
    try {
      await props.onRenameSession(sessionId, nextTitle);
      setRenameOpen(false);
    } finally {
      setRenameBusy(false);
    }
  };

  const confirmDelete = async () => {
    const sessionId = props.selectedSessionId;
    if (!sessionId || !props.onDeleteSession) return;
    setDeleteBusy(true);
    try {
      await props.onDeleteSession(sessionId);
      setDeleteOpen(false);
    } finally {
      setDeleteBusy(false);
    }
  };

  const todoLabel =
    completedTodos > 0
      ? t("session.todo_progress_label", undefined, { completed: completedTodos, total: todos.length })
      : t("session.todo_label", undefined, { count: todos.length });

  return (
    <div className="flex h-full min-h-0 flex-col bg-[radial-gradient(circle_at_top,rgba(74,111,255,0.12),transparent_42%),var(--app-bg,#0b1020)] text-dls-text">
      <div className="flex min-h-0 flex-1 gap-4 p-3 md:p-4">
        <aside
          className="relative hidden min-h-0 shrink-0 overflow-hidden rounded-[24px] border border-dls-border bg-dls-sidebar shadow-[var(--dls-shell-shadow)] lg:flex lg:flex-col"
          style={{ width: leftSidebarWidth }}
        >
          <div className="flex min-h-0 flex-1">
            <WorkspaceSessionList
              workspaceSessionGroups={props.sidebar.workspaceSessionGroups}
              selectedWorkspaceId={props.sidebar.selectedWorkspaceId}
              developerMode={props.sidebar.developerMode}
              selectedSessionId={props.sidebar.selectedSessionId}
              showInitialLoading={sidebarInitialLoading}
              showSessionActions={Boolean(props.onRenameSession || props.onDeleteSession)}
              sessionStatusById={props.sidebar.sessionStatusById}
              connectingWorkspaceId={props.sidebar.connectingWorkspaceId}
              workspaceConnectionStateById={props.sidebar.workspaceConnectionStateById}
              newTaskDisabled={props.sidebar.newTaskDisabled}
              onSelectWorkspace={props.sidebar.onSelectWorkspace}
              onOpenSession={props.sidebar.onOpenSession}
              onPrefetchSession={props.sidebar.onPrefetchSession}
              onCreateTaskInWorkspace={props.sidebar.onCreateTaskInWorkspace}
              onOpenRenameSession={props.onRenameSession ? openRenameModal : undefined}
              onOpenDeleteSession={props.onDeleteSession ? () => setDeleteOpen(true) : undefined}
              onOpenRenameWorkspace={props.sidebar.onOpenRenameWorkspace}
              onShareWorkspace={props.sidebar.onShareWorkspace}
              onRevealWorkspace={props.sidebar.onRevealWorkspace}
              onRecoverWorkspace={props.sidebar.onRecoverWorkspace}
              onTestWorkspaceConnection={props.sidebar.onTestWorkspaceConnection}
              onEditWorkspaceConnection={props.sidebar.onEditWorkspaceConnection}
              onForgetWorkspace={props.sidebar.onForgetWorkspace}
              onOpenCreateWorkspace={props.sidebar.onOpenCreateWorkspace}
            />
          </div>
          <div
            className="absolute right-0 top-3 hidden h-[calc(100%-24px)] w-2 translate-x-1/2 cursor-col-resize rounded-full bg-transparent transition-colors hover:bg-gray-6/40 lg:block"
            onPointerDown={startLeftSidebarResize}
            title={t("session.resize_workspace_column")}
            aria-label={t("session.resize_workspace_column")}
          />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[24px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]">
          <header className="z-10 flex h-12 shrink-0 items-center justify-between border-b border-dls-border bg-dls-surface px-4 md:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <h1 className="truncate text-[15px] font-semibold text-dls-text">
                {showWorkspaceSetupEmptyState
                  ? t("session.create_or_connect_workspace")
                  : selectedSessionTitle || t("session.default_title")}
              </h1>
              <span className="hidden truncate text-[13px] text-dls-secondary lg:inline">
                {workspaceName}
              </span>
              {props.developerMode ? (
                <span className="hidden text-[12px] text-dls-secondary lg:inline">
                  {props.headerStatus}
                </span>
              ) : null}
              {props.busyHint ? (
                <span className="hidden text-[12px] text-dls-secondary lg:inline">
                  {props.busyHint}
                </span>
              ) : null}
            </div>

            <div className="flex items-center gap-1.5 text-gray-10">
              {props.history ? (
                <>
                  <button
                    type="button"
                    className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => void props.history?.onUndo()}
                    disabled={!props.history.canUndo || props.history.busyAction !== null}
                    title={t("session.undo_title")}
                    aria-label={t("session.undo_label")}
                  >
                    {props.history.busyAction === "undo" ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <Undo2 size={16} />
                    )}
                    <span className="hidden lg:inline">{t("session.revert_label")}</span>
                  </button>
                  <button
                    type="button"
                    className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => void props.history?.onRedo()}
                    disabled={!props.history.canRedo || props.history.busyAction !== null}
                    title={t("session.redo_title")}
                    aria-label={t("session.redo_aria_label")}
                  >
                    {props.history.busyAction === "redo" ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <Redo2 size={16} />
                    )}
                    <span className="hidden lg:inline">{t("session.redo_label")}</span>
                  </button>
                </>
              ) : null}
            </div>
          </header>

          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div className="relative min-w-0 flex-1 overflow-hidden bg-dls-surface">
              {showStartupSkeleton ? (
                <div className="px-6 py-14" role="status" aria-live="polite">
                  <div className="mx-auto max-w-2xl space-y-6">
                    <div className="space-y-2">
                      <div className="h-4 w-32 animate-pulse rounded-full bg-dls-hover/80" />
                      <div className="h-3 w-64 animate-pulse rounded-full bg-dls-hover/60" />
                    </div>
                    <div className="space-y-3">
                      {[0, 1, 2].map((idx) => (
                        <div key={idx} className="rounded-2xl border border-dls-border bg-dls-hover/40 p-4">
                          <div
                            className="mb-3 h-3 animate-pulse rounded-full bg-dls-hover/80"
                            style={{ width: idx === 0 ? "42%" : idx === 1 ? "56%" : "36%" }}
                          />
                          <div className="space-y-2">
                            <div className="h-2.5 animate-pulse rounded-full bg-dls-hover/70" />
                            <div
                              className="h-2.5 animate-pulse rounded-full bg-dls-hover/60"
                              style={{ width: idx === 2 ? "74%" : "88%" }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              {showDelayedSessionLoadingState ? (
                <div className="px-6 py-24">
                  <div className="mx-auto flex max-w-sm flex-col items-center gap-4 rounded-3xl border border-dls-border bg-dls-hover/60 px-8 py-10 text-center" role="status" aria-live="polite">
                    <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-dls-border bg-dls-surface">
                      <Loader2 size={20} className="animate-spin text-dls-secondary" />
                    </div>
                    <div className="space-y-1">
                      <h3 className="text-base font-medium text-dls-text">{t("session.loading_title")}</h3>
                      <p className="text-sm text-dls-secondary">{t("session.loading_detail")}</p>
                    </div>
                  </div>
                </div>
              ) : null}

              {!showDelayedSessionLoadingState && canRenderReactSurface ? (
                <SessionSurface
                  client={props.openworkServerClient!}
                  workspaceId={props.runtimeWorkspaceId!}
                  sessionId={props.selectedSessionId!}
                  opencodeBaseUrl={reactSessionBaseUrl}
                  openworkToken={reactSessionToken}
                  {...props.surface!}
                />
              ) : null}

              {!showDelayedSessionLoadingState && !canRenderReactSurface && !showStartupSkeleton ? (
                <div className={`mx-auto max-w-[800px] px-6 ${showWorkspaceSetupEmptyState ? "pt-20" : "pt-10"}`}>
                  {showWorkspaceSetupEmptyState ? (
                    <div className="space-y-6 px-6 text-center">
                      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl border border-dls-border bg-dls-hover">
                        <Zap className="text-dls-secondary" />
                      </div>
                      <div className="space-y-2">
                        <h3 className="text-xl font-medium">{t("session.create_or_connect_workspace")}</h3>
                        <p className="mx-auto max-w-sm text-sm text-dls-secondary">
                          {t("workspace.empty_state_body")}
                        </p>
                      </div>
                      <div className="flex justify-center">
                        <Button onClick={props.sidebar.onOpenCreateWorkspace}>{t("workspace.create_workspace")}</Button>
                      </div>
                    </div>
                  ) : (
                    <div className="px-6 py-16 text-center text-sm text-dls-secondary">
                      {props.selectedSessionId
                        ? t("session.loading_detail")
                        : t("session.select_or_create_session")}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>

          {todos.length > 0 ? (
            <div className="mx-auto w-full max-w-[800px] px-4">
              <div className="rounded-t-[20px] border border-b-0 border-dls-border bg-dls-surface shadow-[var(--dls-card-shadow)]">
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-t-[20px] px-4 py-3 text-xs text-gray-9 transition-colors hover:bg-gray-2/50"
                  onClick={() => setTodoExpanded((current) => !current)}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-gray-11 font-medium">{todoLabel}</span>
                  </div>
                  <Minimize2 size={12} className={`text-gray-8 transition-transform ${todoExpanded ? "" : "rotate-180"}`} />
                </button>
                {todoExpanded ? (
                  <div className="max-h-60 space-y-2.5 overflow-auto border-t border-dls-border px-4 pb-3">
                    {todos.map((todo, index) => {
                      const done = todo.status === "completed";
                      const cancelled = todo.status === "cancelled";
                      const active = todo.status === "in_progress";
                      return (
                        <div key={`${todo.content}-${index}`} className="flex items-start gap-2.5 pt-2.5 first:pt-2.5">
                          <div className="flex items-center gap-1.5 pt-0.5">
                            <div
                              className={`flex h-4.5 w-4.5 items-center justify-center rounded-full border ${
                                done
                                  ? "border-green-6 bg-green-2 text-green-11"
                                  : active
                                    ? "border-amber-6 bg-amber-2 text-amber-11"
                                    : cancelled
                                      ? "border-gray-6 bg-gray-2 text-gray-8"
                                      : "border-gray-6 bg-gray-1 text-gray-8"
                              }`}
                            >
                              {done ? <Check size={10} /> : active ? <span className="h-1.5 w-1.5 rounded-full bg-amber-9" /> : null}
                            </div>
                          </div>
                          <div className={`flex-1 text-sm leading-relaxed ${cancelled ? "text-gray-9 line-through" : "text-gray-12"}`}>
                            <span className="mr-1.5 text-gray-9">{index + 1}.</span>
                            {todo.content}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          <StatusBar
            clientConnected={props.clientConnected}
            openworkServerStatus={props.openworkServerStatus}
            developerMode={props.developerMode}
            settingsOpen={props.statusBar?.settingsOpen ?? false}
            onSendFeedback={props.onSendFeedback}
            onOpenSettings={props.onOpenSettings}
            providerConnectedIds={props.providerConnectedIds}
            mcpConnectedCount={props.mcpConnectedCount}
            statusLabel={props.statusBar?.statusLabel}
            statusDetail={props.statusBar?.statusDetail}
            statusDotClass={props.statusBar?.statusDotClass}
            statusPingClass={props.statusBar?.statusPingClass}
            statusPulse={props.statusBar?.statusPulse}
            showSettingsButton={props.statusBar?.showSettingsButton}
          />
        </main>
      </div>

      {props.providerAuthModal ? <ProviderAuthModal {...props.providerAuthModal} /> : null}

      {props.onRenameSession ? (
        <RenameSessionModal
          open={renameOpen}
          title={renameTitle}
          busy={renameBusy}
          canSave={renameTitle.trim().length > 0 && renameTitle.trim() !== selectedSessionTitle.trim()}
          onClose={() => {
            if (!renameBusy) setRenameOpen(false);
          }}
          onSave={() => void submitRename()}
          onTitleChange={setRenameTitle}
        />
      ) : null}

      {props.onDeleteSession ? (
        <ConfirmModal
          open={deleteOpen}
          title={t("session.delete_session_title")}
          message={
            selectedSessionTitle.trim()
              ? t("session.delete_named_session_message", undefined, { title: selectedSessionTitle.trim() })
              : t("session.delete_session_generic")
          }
          confirmLabel={deleteBusy ? t("session.deleting") : t("session.delete")}
          cancelLabel={t("common.cancel")}
          variant="danger"
          onConfirm={() => void confirmDelete()}
          onCancel={() => {
            if (!deleteBusy) setDeleteOpen(false);
          }}
        />
      ) : null}

      {props.shareWorkspaceModal ? <ShareWorkspaceModal {...props.shareWorkspaceModal} /> : null}

      {props.activePermission ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-gray-1/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md overflow-hidden rounded-2xl border border-amber-7/30 bg-gray-2 shadow-2xl">
            <div className="p-6">
              <div className="mb-4 flex items-start gap-4">
                <div className="rounded-full bg-amber-7/10 p-3 text-amber-6">
                  {permissionPresentation.isDoomLoop ? <RefreshCcw size={24} /> : <Shield size={24} />}
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-12">{permissionPresentation.title}</h3>
                  <p className="mt-1 text-sm text-gray-11">{permissionPresentation.message}</p>
                </div>
              </div>

              <div className="mb-6 rounded-xl border border-gray-6 bg-gray-1/50 p-4">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-10">
                  {t("session.permission_label")}
                </div>
                <div className="font-mono text-sm text-gray-12">{permissionPresentation.permissionLabel}</div>

                {permissionPresentation.note ? (
                  <p className="mt-2 text-sm text-gray-11">{permissionPresentation.note}</p>
                ) : null}

                <div className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wider text-gray-10">
                  {permissionPresentation.scopeLabel}
                </div>
                <div className="flex items-center gap-2 rounded border border-amber-7/20 bg-amber-1/30 px-2 py-1 font-mono text-sm text-amber-12">
                  <HardDrive size={12} />
                  {permissionPresentation.scopeValue}
                </div>

                {Object.keys(props.activePermission.metadata ?? {}).length > 0 ? (
                  <details className="mt-4 rounded-lg bg-gray-1/20 p-2">
                    <summary className="cursor-pointer text-xs text-gray-11">{t("session.details_label")}</summary>
                    <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-gray-12">
                      {(props.safeStringify ?? JSON.stringify)(props.activePermission.metadata, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Button
                  variant="outline"
                  className="w-full border-red-7/20 text-red-11 hover:bg-red-1/30"
                  onClick={() => props.respondPermission?.(props.activePermission!.id, "reject")}
                  disabled={props.permissionReplyBusy}
                >
                  {t("session.deny")}
                </Button>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="secondary"
                    className="text-xs"
                    onClick={() => props.respondPermission?.(props.activePermission!.id, "once")}
                    disabled={props.permissionReplyBusy}
                  >
                    {t("session.allow_once")}
                  </Button>
                  <Button
                    variant="primary"
                    className="border-none bg-amber-7 text-xs font-bold text-gray-12 shadow-amber-6/20 hover:bg-amber-8"
                    onClick={() => props.respondPermissionAndRemember?.(props.activePermission!.id, "always")}
                    disabled={props.permissionReplyBusy}
                  >
                    {t("session.allow_for_session")}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <QuestionModal
        open={Boolean(props.activeQuestion)}
        questions={props.activeQuestion?.questions ?? []}
        busy={props.questionReplyBusy ?? false}
        onReply={(answers) => {
          if (props.activeQuestion) {
            props.respondQuestion?.(props.activeQuestion.id, answers);
          }
        }}
      />
    </div>
  );
}
