/** @jsxImportSource react */
import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePanelRef } from "react-resizable-panels";
import { Globe, Loader2, Redo2, Undo2, Zap } from "lucide-react";

import { t } from "../../../../i18n";
import { type OpenworkServerClient, type OpenworkServerStatus } from "../../../../app/lib/openwork-server";
import { getDisplaySessionTitle } from "../../../../app/lib/session-title";
import type { BootPhase } from "../../../../app/lib/startup-boot";
import type { WorkspaceInfo } from "../../../../app/lib/desktop";
import type {
  PendingPermission,
  PendingQuestion,
  ProviderListItem,
  TodoItem,
  WorkspaceConnectionState,
  WorkspaceSessionGroup,
} from "../../../../app/types";
import type { ShareWorkspaceModalProps } from "../../workspace/types";
import { Button } from "@/components/ui/button";
import { ConfirmModal } from "../../../design-system/modals/confirm-modal";
import ProviderAuthModal, { type ProviderAuthModalProps } from "../../connections/provider-auth/provider-auth-modal";
import { QuestionModal } from "../modals/question-modal";
import { RenameSessionModal } from "../modals/rename-session-modal";
import { AppSidebar } from "../sidebar/app-sidebar";
import { SessionSurface, type SessionSurfaceProps } from "../surface/session-surface";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ShareWorkspaceModal } from "../../workspace/share-workspace-modal";
import { StatusBar, type StatusBarProps } from "./status-bar";
import { OwDotTicker } from "../../../shell/dot-ticker";
import { useReactRenderWatchdog } from "../../../shell/react-render-watchdog";
import { useShellConfig } from "../../../shell/shell-config";
import { useUiStateStore } from "../../../shell/ui-state-store";

import { isElectronRuntime } from "../../../../app/utils";
import { BrowserPanel } from "../browser/browser-panel";
import { useWorkspaceShellLayout } from "../../../shell/workspace-shell-layout";
import { cn } from "@/lib/utils";

const STARTUP_SKELETON_ROWS = [
  { id: "intro", titleWidth: "42%", bodyWidth: "88%" },
  { id: "middle", titleWidth: "56%", bodyWidth: "88%" },
  { id: "final", titleWidth: "36%", bodyWidth: "74%" },
];

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
  onCreateTaskWithPrompt?: (workspaceId: string, prompt: string) => void;
  onOpenRenameWorkspace: (workspaceId: string) => void;
  onShareWorkspace: (workspaceId: string) => void;
  onRevealWorkspace: (workspaceId: string) => void;
  onRecoverWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  onTestWorkspaceConnection: (workspaceId: string) => Promise<boolean> | boolean | void;
  onEditWorkspaceConnection: (workspaceId: string) => void;
  onForgetWorkspace: (workspaceId: string) => void;
  onOpenCreateWorkspace: () => void;
  onReorderWorkspaces?: (workspaceIds: string[]) => void;
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
  selectedWorkspaceError?: string | null;
  runtimeWorkspaceId: string | null;
  /**
   * Pre-built OpenCode SDK base URL for the selected workspace's owning
   * server. The parent route resolves this through `resolveWorkspaceEndpoint`
   * so we never compose `<baseUrl>/workspace/<id>/opencode` here.
   */
  opencodeBaseUrl?: string | null;
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
  safeStringify?: (value: unknown) => string;
  activeQuestion?: PendingQuestion | null;
  questionReplyBusy?: boolean;
  respondQuestion?: (requestID: string, answers: string[][]) => void;
  statusBar?: Partial<StatusBarOverrides>;
  notFoundMessage?: string | null;
  onRenameSession?: (sessionId: string, title: string) => Promise<void> | void;
  onDeleteSession?: (sessionId: string) => Promise<void> | void;
};

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
  const sessionsById = new Map(groups.flatMap((group) => group.sessions.map((session) => [session.id, session] as const)));
  const match = sessionsById.get(id);
  return match ? getDisplaySessionTitle(match.title) : "";
}

export function SessionPage(props: SessionPageProps) {
  const { config: shellConfig } = useShellConfig();
  const sidebarOpen = useUiStateStore((state) => state.sidebarOpen);
  const setSidebarOpen = useUiStateStore((state) => state.setSidebarOpen);
  const browserPanelOpen = useUiStateStore((state) => state.browserPanelOpen);
  const openBrowserPanel = useUiStateStore((state) => state.openBrowserPanel);
  const closeBrowserPanel = useUiStateStore((state) => state.closeBrowserPanel);
  const toggleBrowserPanel = useUiStateStore((state) => state.toggleBrowserPanel);

  useReactRenderWatchdog("SessionPage", {
    selectedSessionId: props.selectedSessionId,
    selectedWorkspaceId: props.selectedWorkspaceId,
    clientConnected: props.clientConnected,
    startupPhase: props.startupPhase,
    hasSurface: Boolean(props.surface),
    workspaceCount: props.workspaces.length,
  });

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [sessionActionId, setSessionActionId] = useState<string | null>(null);
  const browserPanelRef = usePanelRef();

  // Sync browser panel state with Electron main process IPC events.
  // When the agent calls a built-in browser tool, the main process opens
  // the WebContentsView and sends panel-opened; when hide_browser is called
  // it sends panel-closed.  Without this listener the React UI never knows
  // the panel opened and doesn't render the BrowserPanel toolbar.
  useEffect(() => {
    if (!isElectronRuntime()) return;
    const browser = (window as Window).__OPENWORK_ELECTRON__?.browser;
    if (!browser) return;
    const unsubOpen = browser.onPanelOpened?.(openBrowserPanel);
    const unsubClose = browser.onPanelClosed?.(closeBrowserPanel);
    return () => { unsubOpen?.(); unsubClose?.(); };
  }, [closeBrowserPanel, openBrowserPanel]);
  const {
    leftSidebarResizing,
    leftSidebarWidth,
    rightSidebarExpandedWidth: browserPanelWidth,
    setRightSidebarExpandedWidth: setBrowserPanelWidth,
    startLeftSidebarResize,
  } = useWorkspaceShellLayout({
    expandedRightWidth: 520,
    minRightWidth: 320,
  });
  const [browserPanelDefaultWidth, setBrowserPanelDefaultWidth] = useState(browserPanelWidth);
  const sidebarProviderStyle: CSSProperties & Record<"--sidebar-width", string> = {
    "--sidebar-width": `${leftSidebarWidth}px`,
  };
  useEffect(() => {
    if (browserPanelOpen) return;
    setBrowserPanelDefaultWidth(browserPanelWidth);
  }, [browserPanelOpen, browserPanelWidth]);
  const commitBrowserPanelWidth = useCallback(() => {
    const size = browserPanelRef.current?.getSize();
    if (size?.inPixels) setBrowserPanelWidth(Math.round(size.inPixels));
  }, [browserPanelRef, setBrowserPanelWidth]);
  const [showDelayedSessionLoadingState, setShowDelayedSessionLoadingState] = useState(false);

  const selectedSessionTitle = useMemo(
    () => sessionTitleForId(props.sidebar.workspaceSessionGroups, props.selectedSessionId),
    [props.selectedSessionId, props.sidebar.workspaceSessionGroups],
  );
  const sessionActionTitle = useMemo(
    () => sessionTitleForId(props.sidebar.workspaceSessionGroups, sessionActionId),
    [props.sidebar.workspaceSessionGroups, sessionActionId],
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
  const sidebarInitialLoading = useMemo(() => getSidebarInitialLoading(props.sidebar), [props.sidebar]);
  // Derive the main-pane error from the same data the sidebar uses so the two
  // panes can never disagree. We check (in priority order):
  // 1. selectedWorkspaceError (errorsByWorkspaceId[selectedWorkspaceId])
  // 2. workspaceConnectionStateById[selectedWorkspaceId].message (covers test/recover paths)
  // 3. group.error from workspaceSessionGroups (the same source the sidebar reads)
  const selectedWorkspaceConnectionMessage = (() => {
    const state = props.sidebar.workspaceConnectionStateById[props.selectedWorkspaceId];
    if (state?.status === "error") return state.message?.trim() ?? "";
    return "";
  })();
  const selectedWorkspaceGroupError = (() => {
    const group = props.sidebar.workspaceSessionGroups.find(
      (item) => item.workspace.id === props.selectedWorkspaceId,
    );
    return group?.error?.trim() ?? "";
  })();
  const selectedWorkspaceErrorMessage =
    props.selectedWorkspaceError?.trim() ||
    selectedWorkspaceConnectionMessage ||
    selectedWorkspaceGroupError ||
    "";
  const showSelectedWorkspaceError = Boolean(selectedWorkspaceErrorMessage);

  const reactSessionBaseUrl = props.opencodeBaseUrl?.trim() ?? "";
  const reactSessionToken =
    props.openworkServerToken?.trim() ||
    props.openworkServerClient?.token?.trim() ||
    "";
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
    setSessionActionId(null);
  }, [props.selectedSessionId]);

  const openRenameModal = (sessionId: string) => {
    if (!props.onRenameSession) return;
    setSessionActionId(sessionId);
    setRenameTitle(sessionTitleForId(props.sidebar.workspaceSessionGroups, sessionId));
    setRenameOpen(true);
  };

  const submitRename = async () => {
    const sessionId = sessionActionId;
    const nextTitle = renameTitle.trim();
    if (!sessionId || !props.onRenameSession || !nextTitle || nextTitle === sessionActionTitle.trim()) return;
    setRenameBusy(true);
    try {
      await props.onRenameSession(sessionId, nextTitle);
      setRenameOpen(false);
    } finally {
      setRenameBusy(false);
    }
  };

  const confirmDelete = async () => {
    const sessionId = sessionActionId;
    if (!sessionId || !props.onDeleteSession) return;
    setDeleteBusy(true);
    try {
      await props.onDeleteSession(sessionId);
      setDeleteOpen(false);
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[radial-gradient(circle_at_top,rgba(74,111,255,0.12),transparent_42%),var(--app-bg,#0b1020)] text-dls-text mac:bg-transparent">
      <SidebarProvider
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        className={cn(
          "relative min-h-0 flex-1 mac:bg-transparent",
          leftSidebarResizing &&
            "**:data-[slot=sidebar-container]:transition-none **:data-[slot=sidebar-gap]:transition-none",
          !shellConfig.sidebar && "**:data-[slot=sidebar-container]:hidden **:data-[slot=sidebar-gap]:hidden",
        )}
        style={sidebarProviderStyle}
      >
        <AppSidebar
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
          onOpenDeleteSession={props.onDeleteSession ? (sessionId) => {
            setSessionActionId(sessionId);
            setDeleteOpen(true);
          } : undefined}
          onOpenRenameWorkspace={props.sidebar.onOpenRenameWorkspace}
          onShareWorkspace={props.sidebar.onShareWorkspace}
          onRevealWorkspace={props.sidebar.onRevealWorkspace}
          onRecoverWorkspace={props.sidebar.onRecoverWorkspace}
          onTestWorkspaceConnection={props.sidebar.onTestWorkspaceConnection}
          onEditWorkspaceConnection={props.sidebar.onEditWorkspaceConnection}
          onForgetWorkspace={props.sidebar.onForgetWorkspace}
          onOpenCreateWorkspace={props.sidebar.onOpenCreateWorkspace}
          onReorderWorkspaces={props.sidebar.onReorderWorkspaces}
          onStartResize={startLeftSidebarResize}
        />
        <SidebarInset className="min-h-0 overflow-hidden bg-background mac:bg-background/80 mac:[&_header]:transition-[padding-left] mac:[&_header]:duration-200 mac:[&_header]:ease-linear mac:peer-data-[state=collapsed]:[&_header]:pl-28 mac:max-md:[&_header]:pl-28">
          <ResizablePanelGroup
            orientation="horizontal"
            onLayoutChanged={browserPanelOpen ? commitBrowserPanelWidth : undefined}
            className="min-h-0"
          >
            <ResizablePanel minSize="360px" className="min-w-0">
              <main className="flex h-full min-w-0 flex-col overflow-hidden border-r border-border">
          <header className="z-10 flex h-10 shrink-0 items-center justify-between border-b border-border px-4 md:px-6 mac:titlebar-drag  mac:backdrop-blur-2xl mac:backdrop-saturate-150 @container/titlebar">
            <div className="flex min-w-0 items-center gap-3">
              {shellConfig.sidebar ? <SidebarTrigger className="mac:hidden" /> : null}
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

            <div className="flex items-center gap-1.5 text-gray-10 mac:titlebar-no-drag">
              {isElectronRuntime() ? (
                <button
                  type="button"
                  className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors ${browserPanelOpen ? "bg-dls-accent/10 text-dls-accent" : "text-gray-10 hover:bg-gray-2/70 hover:text-dls-text"}`}
                  onClick={toggleBrowserPanel}
                  title="Toggle browser panel"
                  aria-label="Toggle browser panel"
                  aria-pressed={browserPanelOpen}
                >
                  <Globe size={16} />
                  <span className="hidden @lg/titlebar:inline">Browser</span>
                </button>
              ) : null}
              {/* Revert/redo moved to per-message actions */}
              {props.developerMode ? (
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-[10px] font-medium text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
                  onClick={() => {
                    try {
                      window.localStorage.removeItem("openwork.acknowledgedProviders");
                      window.localStorage.removeItem("openwork.orgOnboardingSeen");
                    } catch {}
                  }}
                  title="Clears acknowledged providers + org onboarding so they trigger again"
                >
                  Reset notifications
                </button>
              ) : null}
            </div>
          </header>

          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div className="relative min-w-0 flex-1 overflow-hidden bg-dls-surface mac:bg-dls-surface/85 mac:backdrop-blur-2xl mac:backdrop-saturate-150">
              {showStartupSkeleton ? (
                <div className="px-6 py-14" role="status" aria-live="polite">
                  <div className="mx-auto max-w-2xl space-y-6">
                    <div className="space-y-2">
                      <div className="h-4 w-32 animate-pulse rounded-full bg-dls-hover/80" />
                      <div className="h-3 w-64 animate-pulse rounded-full bg-dls-hover/60" />
                    </div>
                    <div className="space-y-3">
                      {STARTUP_SKELETON_ROWS.map((row) => (
                        <div key={row.id} className="rounded-2xl border border-dls-border bg-dls-hover/40 p-4">
                          <div
                            className="mb-3 h-3 animate-pulse rounded-full bg-dls-hover/80"
                            style={{ width: row.titleWidth }}
                          />
                          <div className="space-y-2">
                            <div className="h-2.5 animate-pulse rounded-full bg-dls-hover/70" />
                            <div
                              className="h-2.5 animate-pulse rounded-full bg-dls-hover/60"
                              style={{ width: row.bodyWidth }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              {showDelayedSessionLoadingState ? (
                <div className="px-6 py-16">
                  <div
                    className="mx-auto flex max-w-[320px] flex-col items-center gap-3 text-center"
                    role="status"
                    aria-live="polite"
                  >
                    <OwDotTicker size="md" />
                    <div className="text-[12px] leading-5 text-dls-secondary">
                      {t("session.loading_detail")}
                    </div>
                  </div>
                </div>
              ) : null}

              {!showDelayedSessionLoadingState && canRenderReactSurface ? (
                <SessionSurface
                  // Spread `surface` first so the explicit per-workspace
                  // routing props below CAN'T be silently overridden by
                  // anything that leaks into `surface`. SessionSurface's
                  // server target (client/workspaceId/sessionId/opencodeBaseUrl/openworkToken)
                  // must come from the resolved workspace endpoint passed by
                  // SessionRoute, not from anything in `surface`.
                  {...props.surface!}
                  client={props.openworkServerClient!}
                  workspaceId={props.runtimeWorkspaceId!}
                  sessionId={props.selectedSessionId!}
                  opencodeBaseUrl={reactSessionBaseUrl}
                  openworkToken={reactSessionToken}
                  todos={props.todos}
                  activePermission={props.activePermission}
                  permissionReplyBusy={props.permissionReplyBusy}
                  respondPermission={props.respondPermission}
                  safeStringify={props.safeStringify}
                />
              ) : null}

              {!showDelayedSessionLoadingState && !canRenderReactSurface && !showStartupSkeleton ? (
                <div className={`mx-auto max-w-[800px] px-6 ${showWorkspaceSetupEmptyState ? "pt-20" : "pt-10"}`}>
                  {props.notFoundMessage ? (
                    <div className="px-6 py-16 text-center">
                      <div className="mx-auto max-w-md rounded-2xl border border-dls-border bg-dls-card px-5 py-6 shadow-[var(--dls-card-shadow)]">
                        <h3 className="text-base font-medium text-dls-text">Workspace or session not found</h3>
                        <p className="mt-2 text-sm leading-6 text-dls-secondary">{props.notFoundMessage}</p>
                      </div>
                    </div>
                  ) : showWorkspaceSetupEmptyState ? (
                    <div className="space-y-6 px-6 text-center">
                      <div className="mx-auto flex size-16 items-center justify-center rounded-3xl border border-dls-border bg-dls-hover">
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
                  ) : showSelectedWorkspaceError ? (
                    <div className="px-6 py-16">
                      <div className="mx-auto max-w-lg rounded-2xl border border-red-7/35 bg-red-1/40 p-5 text-left shadow-[var(--dls-card-shadow)]">
                        <div className="text-sm font-medium text-red-11">Remote workspace unavailable</div>
                        <p className="mt-2 whitespace-pre-wrap wrap-anywhere text-sm leading-6 text-red-11/90">
                          {selectedWorkspaceErrorMessage}
                        </p>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void Promise.resolve(props.sidebar.onTestWorkspaceConnection(props.selectedWorkspaceId))}
                          >
                            {t("workspace_list.test_connection")}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => props.sidebar.onEditWorkspaceConnection(props.selectedWorkspaceId)}
                          >
                            {t("workspace_list.edit_connection")}
                          </Button>
                          {props.sidebar.workspaceConnectionStateById[props.selectedWorkspaceId]?.status === "error" ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void Promise.resolve(props.sidebar.onRecoverWorkspace(props.selectedWorkspaceId))}
                            >
                              {t("workspace_list.recover")}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ) : props.selectedSessionId ? (
                    <div className="px-6 py-16 text-center text-sm text-dls-secondary">
                      {t("session.loading_detail")}
                    </div>
                  ) : (
                    <div className="flex flex-1 items-center justify-center px-6 py-16">
                      <div className="w-full max-w-md space-y-6">
                        <div className="space-y-1 text-center">
                          <h2 className="text-lg font-semibold text-dls-text">
                            {t("session.select_or_create_session")}
                          </h2>
                          <p className="text-xs text-dls-secondary">Try one of these to get started:</p>
                        </div>
                        <div className="space-y-2">
                          <button
                            type="button"
                            className="flex w-full items-start gap-3 rounded-xl border border-dls-border bg-dls-surface p-3.5 text-left transition-colors hover:bg-dls-hover"
                            onClick={() => {
                              props.sidebar.onCreateTaskWithPrompt?.(
                                props.selectedWorkspaceId,
                                "Create a sample CSV file with 20 rows of fake customer data (name, email, company, revenue). Then show me a summary of the data.",
                              );
                            }}
                          >
                            <img src="https://cdn.simpleicons.org/googlesheets" alt="" width={20} height={20} className="mt-0.5 shrink-0" />
                            <div>
                              <div className="text-[13px] font-medium text-dls-text">Edit a CSV</div>
                              <div className="mt-0.5 text-[11px] text-dls-secondary">Create a sample spreadsheet with customer data</div>
                            </div>
                          </button>
                          <button
                            type="button"
                            className="flex w-full items-start gap-3 rounded-xl border border-dls-border bg-dls-surface p-3.5 text-left transition-colors hover:bg-dls-hover"
                            onClick={() => {
                              props.sidebar.onCreateTaskWithPrompt?.(
                                props.selectedWorkspaceId,
                                "Open craigslist.org in the browser and search for couches for sale. Show me the top 5 results with prices.",
                              );
                            }}
                          >
                            <img src="https://cdn.simpleicons.org/googlechrome" alt="" width={20} height={20} className="mt-0.5 shrink-0" />
                            <div>
                              <div className="text-[13px] font-medium text-dls-text">Automate a browser task</div>
                              <div className="mt-0.5 text-[11px] text-dls-secondary">Search Craigslist for couches and list the results</div>
                            </div>
                          </button>
                          <button
                            type="button"
                            className="flex w-full items-start gap-3 rounded-xl border border-dls-border bg-dls-surface p-3.5 text-left transition-colors hover:bg-dls-hover"
                            onClick={() => {
                              props.onOpenSettings?.();
                            }}
                          >
                            <img src="https://cdn.simpleicons.org/hackthebox" alt="" width={20} height={20} className="mt-0.5 shrink-0" />
                            <div>
                              <div className="text-[13px] font-medium text-dls-text">Connect an extension</div>
                              <div className="mt-0.5 text-[11px] text-dls-secondary">Add MCP servers, plugins, and integrations</div>
                            </div>
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>

          {shellConfig.statusBar ? (
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
          ) : null}
              </main>
            </ResizablePanel>
            {browserPanelOpen ? (
              <>
                <ResizableHandle withHandle className="hidden lg:flex" />
                <ResizablePanel
                  panelRef={browserPanelRef}
                  defaultSize={`${browserPanelDefaultWidth}px`}
                  minSize="320px"
                  maxSize="70%"
                  className="min-h-0 overflow-hidden lg:flex lg:flex-col"
                >
                  <BrowserPanel onClose={closeBrowserPanel} />
                </ResizablePanel>
              </>
            ) : null}
          </ResizablePanelGroup>
        </SidebarInset>
        {shellConfig.sidebar ? <SidebarTrigger className="hidden mac:absolute mac:left-[64px] top-[3px] z-50 mac:flex titlebar-no-drag" /> : null}
      </SidebarProvider>

      {props.providerAuthModal ? <ProviderAuthModal {...props.providerAuthModal} /> : null}

      {props.onRenameSession ? (
        <RenameSessionModal
          open={renameOpen}
          title={renameTitle}
          busy={renameBusy}
          canSave={renameTitle.trim().length > 0 && renameTitle.trim() !== sessionActionTitle.trim()}
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
            sessionActionTitle.trim()
              ? t("session.delete_named_session_message", { title: sessionActionTitle.trim() })
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

      {/* Cloud provider notifications are now handled globally by CloudProvidersToast in app-root.tsx */}
    </div>
  );
}
