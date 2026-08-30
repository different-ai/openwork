/** @jsxImportSource react */
import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePanelRef } from "react-resizable-panels";
import { ArrowLeft, Cloud, FileText, Globe, Mic2, MoreHorizontal, PanelRight, TextSearch, X, Zap } from "lucide-react";

import { resolveExtensionIconSrc } from "@/react-app/design-system/extension-icon-src";
import { t } from "../../../../i18n";
import { OPENWORK_EXTENSION_CATALOG } from "../../../../app/constants";
import { buildDenAuthUrl, readDenBootstrapConfig } from "../../../../app/lib/den";
import { markDesktopSignInInitiated } from "../../../../app/lib/den-sign-in-intent";
import { type OpenworkServerClient, type OpenworkServerStatus } from "../../../../app/lib/openwork-server";
import { getDisplaySessionTitle } from "../../../../app/lib/session-title";
import type { BootPhase } from "../../../../app/lib/startup-boot";
import { openDesktopPath, revealDesktopItemInDir, type WorkspaceInfo } from "../../../../app/lib/desktop";
import type {
  ComposerAttachment,
  PendingPermission,
  PendingQuestion,
  ProviderListItem,
  TodoItem,
  WorkspaceConnectionState,
  WorkspaceSessionGroup,
} from "../../../../app/types";
import type { ShareWorkspaceModalProps } from "../../workspace/types";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ConfirmModal } from "../../../design-system/modals/confirm-modal";
import { usePlatform } from "../../../kernel/platform";
import { useDenAuth } from "../../cloud/den-auth-provider";
import ProviderAuthModal, { type ProviderAuthModalProps } from "../../connections/provider-auth/provider-auth-modal";
import { RenameSessionModal } from "../modals/rename-session-modal";
import { AppSidebar } from "../sidebar/app-sidebar";
import { useSessionManagementStore } from "../sidebar/session-management-store";
import { SessionSurface, type SessionSurfaceProps } from "../surface/session-surface";
import { useSessionFindStore } from "../surface/find-store";
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
import { SessionEmptyHero } from "./session-empty-hero";
import type { NewTaskComposerContext } from "./new-task-composer";
import type { SessionCloudMcpMaintenanceState } from "../../connections/use-session-mcp-maintenance";
import { OwDotTicker } from "../../../shell/dot-ticker";
import { useReactRenderWatchdog } from "../../../shell/react-render-watchdog";
import { useShellConfig } from "../../../shell/shell-config";
import { type SidePanelItem, useUiStateStore } from "../../../shell/ui-state-store";
import type { SessionNumberShortcutsState } from "../../../shell/session-number-shortcuts";
import { useBootOverlayVisible } from "../../../shell/boot-state";

import { isElectronRuntime } from "../../../../app/utils";
import { isCollectibleArtifactTarget, isLocalhostBrowserTarget, isOpenableFileTarget, type OpenTarget } from "../artifacts/open-target";
import { resolveCollectibleOpenTarget } from "../artifacts/resolve-open-target";
import type { OpenTargetOptions } from "@/lib/target-provider";
import { VoicePanel } from "../voice/voice-panel";
import { SidePanel } from "../panel/side-panel";
import { getSidePanelSessionKey } from "../panel/side-panel-session";
import { TerminalDock } from "../terminal/terminal-dock";
import { useActivePanelTab, usePanelTabStore, useSessionPanelState } from "../panel/panel-tab-store";
import { useWorkspaceShellLayout } from "../../../shell/workspace-shell-layout";
import { useControlAction, type OpenworkControlAction } from "../../../shell/control/control-provider";
import { getExtensionId, isOpenWorkExtensionEnabled, OPENWORK_EXTENSION_STATE_CHANGED } from "../../settings/extension-state";
import { cn } from "@/lib/utils";
import {
  canNavigateSelectedConversationHistory,
  createConversationTabHistory,
  navigateConversationTabHistory,
  syncConversationTabHistory,
  type ConversationTabHistory,
  type ConversationHistoryDirection,
} from "./conversation-tab-history";
import { useWorkbenchStore, type WorkbenchSessionTab } from "./workbench-store";
import { isSameWorkbenchSession } from "./workbench-store";
import { ReactSessionRuntime } from "../sync/runtime-sync";
import {
  availableNarrowPane,
  NarrowPaneSwitcher,
  shouldShowNarrowPaneSwitcher,
  type NarrowPaneOption,
  type NarrowSessionPane,
} from "./responsive-session-layout";

const STARTUP_SKELETON_ROWS = [
  { id: "intro", titleWidth: "42%", bodyWidth: "88%" },
  { id: "middle", titleWidth: "56%", bodyWidth: "88%" },
  { id: "final", titleWidth: "36%", bodyWidth: "74%" },
];
const GLOBAL_VOICE_SIDE_PANEL_KEY = "__openwork_voice__";
const EMPTY_TRANSCRIPT_TARGETS: OpenTarget[] = [];
const EMPTY_SESSION_TABS: WorkbenchSessionTab[] = [];

export type OpenSessionTab = WorkbenchSessionTab;

type PendingConversationHistoryNavigation = {
  history: ConversationTabHistory;
  fromWorkspaceId: string;
  fromSessionId: string | null;
  targetSessionId: string;
  targetSplitSessionId: string | null;
};

/** Live status the route feeds into the sidebar footer account menu. */
type StatusBarOverrides = {
  showSettingsButton: boolean;
  reloadBusy: boolean;
  reloadError: string | null;
  openWorkConnectState: SessionCloudMcpMaintenanceState;
};

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
  onCreateTaskInWorkspace: (workspaceId: string, groupId?: string) => void;
  onCreateTaskWithPrompt?: (workspaceId: string, prompt: string, attachments?: ComposerAttachment[]) => void;
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
  onReorderWorkspaces?: (workspaceIds: string[]) => void;
};

export type SessionPageSurfaceProps = Omit<
  SessionSurfaceProps,
  "client" | "workspaceId" | "sessionId" | "opencodeBaseUrl" | "openworkToken" | "isControlTarget"
>;

export type SessionPagePaneRuntime = {
  status: "ready";
  workspaceId: string;
  workspaceTitle: string;
  workspaceRoot: string;
  workspaceType?: WorkspaceInfo["workspaceType"];
  runtimeWorkspaceId: string;
  opencodeBaseUrl: string;
  openworkToken: string;
  client: OpenworkServerClient;
  environmentClient?: OpenworkServerClient | null;
  surface: SessionPageSurfaceProps;
} | {
  status: "unavailable";
  workspaceId: string;
  workspaceTitle: string;
  message: string;
};

export type SessionPageProps = {
  sessionNumberShortcuts: SessionNumberShortcutsState;
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
  environmentClient?: OpenworkServerClient | null;
  openworkServerToken?: string | null;
  developerMode: boolean;
  headerStatus: string;
  busyHint: string | null;
  startupPhase: BootPhase;
  providerConnectedIds: string[];
  hasUsableModel?: boolean;
  providers?: ProviderListItem[];
  mcpConnectedCount: number;
  onSendFeedback: () => void;
  onOpenSettings: () => void;
  onOpenExtensions: () => void;
  sidebar: SessionPageSidebarProps;
  surface?: SessionPageSurfaceProps | null;
  resolvePaneRuntime?: (session: OpenSessionTab) => SessionPagePaneRuntime;
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
  mainContentTakeover?: React.ReactNode;
  mainContentTitle?: string;
  extensionsActive?: boolean;
  onOpenProviderAuth?: () => void;
  /** Chat-first: create a default workspace and start a task from the empty-state composer. */
  onChatFirstTask?: (prompt: string, attachments?: ComposerAttachment[]) => void;
  chatFirstBusy?: boolean;
  /** Workspace-scoped wiring for the empty-state hero's full composer. */
  newTaskComposer?: NewTaskComposerContext | null;
  onRenameSession?: (sessionId: string, title: string) => Promise<void> | void;
  onDeleteSession?: (sessionId: string) => Promise<void> | void;
  onArchiveSession?: (sessionId: string, archived: boolean) => Promise<void> | void;
  onAccessibleTargetsChange?: (targets: OpenTarget[]) => void;
  /** Settings content rendered inside the right pane when the settings rail icon is active. */
  settingsSlot?: React.ReactNode;
  /** Workspace-scoped first-class surface rendered in place of the conversation. */
  primarySlot?: React.ReactNode;
  primaryTitle?: string;
  terminalOpen?: boolean;
  onTerminalOpenChange?: (open: boolean) => void;
  onSessionTabsChange?: (tabs: OpenSessionTab[]) => void;
};

function sessionTitleForId(groups: WorkspaceSessionGroup[], id: string | null | undefined, workspaceId?: string) {
  if (!id) return "";
  const matchingGroups = workspaceId ? groups.filter((group) => group.workspace.id === workspaceId) : groups;
  const sessionsById = new Map(matchingGroups.flatMap((group) => group.sessions.map((session) => [session.id, session] as const)));
  const match = sessionsById.get(id);
  return match ? getDisplaySessionTitle(match.title) : "";
}

function workspaceTitleForId(groups: WorkspaceSessionGroup[], workspaceId: string) {
  const workspace = groups.find((group) => group.workspace.id === workspaceId)?.workspace;
  return workspace?.displayName?.trim()
    || workspace?.name?.trim()
    || workspace?.path?.trim()
    || workspaceId;
}

function WorkbenchPaneHeader(props: {
  pane: "primary" | "secondary";
  session: OpenSessionTab;
  workspaceTitle: string;
  showWorkspace: boolean;
  focused: boolean;
  onFocus: () => void;
  onClose: () => void;
}) {
  const title = props.session.title?.trim() || t("session.default_title");
  return (
    <div
      className={cn(
        "flex h-10 shrink-0 items-center gap-2 border-b border-border px-3",
        props.focused && "bg-muted/40",
      )}
      data-workbench-pane-header={props.pane}
      data-workbench-pane-workspace-name={props.workspaceTitle}
    >
      <button type="button" className="min-w-0 flex-1 text-left" onClick={props.onFocus}>
        <span className="block truncate text-xs font-medium text-foreground">{title}</span>
        {props.showWorkspace ? (
          <span className="block truncate text-[10px] text-muted-foreground">{props.workspaceTitle}</span>
        ) : null}
      </button>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Close ${props.pane} split pane`}
              onClick={props.onClose}
            >
              <X data-icon="inline-start" />
            </Button>
          }
        />
        <TooltipContent>{props.pane === "primary" ? "Keep the other session" : "Close split view"}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function UnavailableWorkbenchPane(props: {
  workspaceTitle: string;
  message: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center p-6"
      data-workbench-pane-unavailable
      role="status"
    >
      <div className="flex max-w-sm flex-col gap-3 text-center">
        <div>
          <h2 className="text-sm font-medium text-foreground">{props.workspaceTitle} is unavailable</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{props.message}</p>
        </div>
        <div className="flex justify-center gap-2">
          <Button variant="outline" size="sm" onClick={props.onRetry}>Retry connection</Button>
          <Button variant="ghost" size="sm" onClick={props.onClose}>Close pane</Button>
        </div>
      </div>
    </div>
  );
}

function isTrackableAccessibleTarget(target: OpenTarget) {
  return isOpenableFileTarget(target) || isLocalhostBrowserTarget(target);
}

function absoluteWorkspacePath(root: string | null | undefined, value: string) {
  const target = value.trim();
  if (!target) return "";
  if (/^file:\/\//i.test(target)) {
    try {
      const pathname = new URL(target).pathname;
      return /^\/[a-zA-Z]:/.test(pathname) ? pathname.slice(1) : pathname;
    } catch {
      return target.replace(/^file:\/\//i, "");
    }
  }
  if (target.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(target)) return target;
  const cleanRoot = root?.trim().replace(/[/\\]+$/, "") ?? "";
  const cleanTarget = target.replace(/^[.][\\/]/, "");
  return cleanRoot ? `${cleanRoot}/${cleanTarget}` : cleanTarget;
}

function hiddenAccessibleTargetsStorageKey(workspaceId: string | null | undefined, sessionId: string | null | undefined) {
  if (!workspaceId || !sessionId) return null;
  return `openwork.session.hiddenAccessibleTargets.v1:${workspaceId}:${sessionId}`;
}

function readHiddenAccessibleTargetIds(workspaceId: string | null | undefined, sessionId: string | null | undefined): Set<string> {
  const key = hiddenAccessibleTargetsStorageKey(workspaceId, sessionId);
  if (!key || typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string" && id.trim().length > 0));
  } catch {
    return new Set();
  }
}

function writeHiddenAccessibleTargetIds(workspaceId: string | null | undefined, sessionId: string | null | undefined, ids: Set<string>) {
  const key = hiddenAccessibleTargetsStorageKey(workspaceId, sessionId);
  if (!key || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(Array.from(ids)));
  } catch {
    // ignore storage failures
  }
}

function controlObjectArg(args: unknown) {
  return args && typeof args === "object" && !Array.isArray(args) ? args : null;
}

function controlStringArg(args: unknown, key: string) {
  const object = controlObjectArg(args);
  const value = object ? Reflect.get(object, key) : null;
  return typeof value === "string" ? value.trim() : "";
}

export function SessionPage(props: SessionPageProps) {
  const { config: shellConfig } = useShellConfig();
  const platform = usePlatform();
  const denAuth = useDenAuth();
  const isMobile = useIsMobile();
  const bootOverlayVisible = useBootOverlayVisible();
  const sidebarOpen = useUiStateStore((state) => state.sidebarOpen);
  const setSidebarOpen = useUiStateStore((state) => state.setSidebarOpen);
  const sidePanelSessionKey = getSidePanelSessionKey(props.selectedSessionId);
  const sessionSidePanel = useUiStateStore((state) => (
    state.sidePanelState[sidePanelSessionKey] ?? null
  ));
  const voiceSidePanelOpen = useUiStateStore((state) => state.sidePanelState[GLOBAL_VOICE_SIDE_PANEL_KEY] === "voice");
  const setSidePanelState = useUiStateStore((state) => state.setSidePanelState);
  const toggleSidePanelState = useUiStateStore((state) => state.toggleSidePanelState);
  const openTab = usePanelTabStore((state) => state.openTab);
  const closeTab = usePanelTabStore((state) => state.closeTab);
  const selectTab = usePanelTabStore((state) => state.selectTab);
  const transcriptTargets = usePanelTabStore((state) => (
    props.selectedSessionId ? state.transcriptArtifactTargets[props.selectedSessionId] ?? EMPTY_TRANSCRIPT_TARGETS : EMPTY_TRANSCRIPT_TARGETS
  ));
  const sessionPanelState = useSessionPanelState(sidePanelSessionKey);
  const activePanelTab = useActivePanelTab(sidePanelSessionKey);
  const [hiddenTargetRevision, setHiddenTargetRevision] = useState(0);
  const [, setExtensionStateVersion] = useState(0);
  const hiddenAccessibleTargetIds = useMemo(
    () => readHiddenAccessibleTargetIds(props.selectedWorkspaceId, props.selectedSessionId),
    [props.selectedSessionId, props.selectedWorkspaceId, hiddenTargetRevision],
  );
  const accessibleTargets = useMemo(
    () => transcriptTargets.filter((target) => isTrackableAccessibleTarget(target) && !hiddenAccessibleTargetIds.has(target.id)),
    [hiddenAccessibleTargetIds, transcriptTargets],
  );
  const artifactFileTargets = useMemo(() => accessibleTargets.filter(isCollectibleArtifactTarget), [accessibleTargets]);
  const artifactTargetCount = artifactFileTargets.length;
  const hasArtifactTargets = artifactTargetCount > 0;
  const hasBrowserTabs = sessionPanelState.tabs.some((tab) => tab.type === "browser");
  const activeSidePanel = voiceSidePanelOpen ? "voice" : sessionSidePanel;
  const sidePanelOpen = activeSidePanel !== null;
  const panelRailActive = activeSidePanel === "panel";
  const voiceRailActive = activeSidePanel === "voice";
  const voiceExtension = useMemo(
    () => OPENWORK_EXTENSION_CATALOG.find((entry) => getExtensionId(entry) === "openwork-voice") ?? null,
    [],
  );
  const voiceExtensionEnabled = voiceExtension ? isOpenWorkExtensionEnabled(voiceExtension) : false;
  const showCloudSignIn = shellConfig.cloudSignin && !denAuth.isSignedIn && denAuth.status !== "checking";
  const openCloudSignIn = useCallback(() => {
    const baseUrl = readDenBootstrapConfig().baseUrl;
    markDesktopSignInInitiated();
    // Label stays "Sign in"; opens the sign-up tab so new users aren't defaulted into sign-in.
    platform.openLink(buildDenAuthUrl(baseUrl, "sign-up"));
  }, [platform]);

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
  const workbenchPrimary = useWorkbenchStore((state) => state.primary);
  const workbenchTabs = useWorkbenchStore((state) => state.tabs);
  const workbenchSecondary = useWorkbenchStore((state) => state.secondary);
  const focusedWorkbenchPane = useWorkbenchStore((state) => state.focusedPane);
  const [narrowPane, setNarrowPane] = useState<NarrowSessionPane>("chat");
  const narrowPaneNavigationRef = useRef<HTMLElement>(null);
  const activeWorkbenchPane = isMobile
    ? narrowPane === "split" ? "secondary" : "primary"
    : focusedWorkbenchPane;
  const syncWorkbench = useWorkbenchStore((state) => state.sync);
  const openWorkbenchTab = useWorkbenchStore((state) => state.openTab);
  const setWorkbenchSplit = useWorkbenchStore((state) => state.setSplit);
  const focusWorkbenchPane = useWorkbenchStore((state) => state.focusPane);
  const selectedSessionRef = props.selectedSessionId
    ? { workspaceId: props.selectedWorkspaceId, sessionId: props.selectedSessionId }
    : null;
  const workbenchOwnsSelectedRoute = isSameWorkbenchSession(workbenchPrimary, selectedSessionRef);
  const sessionTabs = workbenchOwnsSelectedRoute ? workbenchTabs : EMPTY_SESSION_TABS;
  const splitSession = workbenchOwnsSelectedRoute ? workbenchSecondary : null;
  const [conversationHistory, setConversationHistory] = useState(() => (
    createConversationTabHistory(props.selectedWorkspaceId, props.selectedSessionId)
  ));
  const [pendingConversationHistoryNavigation, setPendingConversationHistoryNavigation] = useState<PendingConversationHistoryNavigation | null>(null);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [createGroupLabel, setCreateGroupLabel] = useState("");
  const [createGroupWorkspaceId, setCreateGroupWorkspaceId] = useState<string | null>(null);
  const browserPanelRef = usePanelRef();
  const preserveSidePanelOnPanelOpenRef = useRef(false);

  const selectNarrowPane = useCallback((pane: NarrowSessionPane) => {
    setNarrowPane(pane);
    if (pane === "chat") focusWorkbenchPane("primary");
    if (pane === "split") focusWorkbenchPane("secondary");
  }, [focusWorkbenchPane]);

  useEffect(() => {
    if (!isMobile) return;
    const availablePane = availableNarrowPane(narrowPane, Boolean(splitSession), sidePanelOpen);
    if (availablePane !== narrowPane) selectNarrowPane(availablePane);
  }, [isMobile, narrowPane, selectNarrowPane, sidePanelOpen, splitSession]);

  useEffect(() => {
    if (!isMobile) return;
    if (focusedWorkbenchPane === "secondary" && splitSession) {
      setNarrowPane("split");
      return;
    }
    setNarrowPane("chat");
  }, [focusedWorkbenchPane, isMobile, splitSession]);

  useEffect(() => {
    if (isMobile && sidePanelOpen) setNarrowPane("panel");
  }, [isMobile, sidePanelOpen]);

  // Roving focus follows an actual pane change only; the initial mount must
  // never steal focus from the composer or another control.
  const lastFocusedNarrowPaneRef = useRef<NarrowSessionPane | null>(null);
  useEffect(() => {
    if (!isMobile) {
      lastFocusedNarrowPaneRef.current = null;
      return;
    }
    if (lastFocusedNarrowPaneRef.current === null) {
      lastFocusedNarrowPaneRef.current = narrowPane;
      return;
    }
    if (lastFocusedNarrowPaneRef.current === narrowPane) return;
    lastFocusedNarrowPaneRef.current = narrowPane;
    const frame = window.requestAnimationFrame(() => {
      narrowPaneNavigationRef.current
        ?.querySelector<HTMLElement>("[role='tab'][aria-selected='true']")
        ?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isMobile, narrowPane]);

  const setCurrentSidePanel = useCallback((panel: SidePanelItem | null) => {
    setSidePanelState(GLOBAL_VOICE_SIDE_PANEL_KEY, panel === "voice" ? "voice" : null);
    if (panel === "voice") return;
    setSidePanelState(sidePanelSessionKey, panel);
  }, [setSidePanelState, sidePanelSessionKey]);

  const toggleCurrentSidePanel = useCallback((panel: SidePanelItem) => {
    if (panel === "voice") {
      toggleSidePanelState(GLOBAL_VOICE_SIDE_PANEL_KEY, "voice");
      return;
    }
    setSidePanelState(GLOBAL_VOICE_SIDE_PANEL_KEY, null);
    toggleSidePanelState(sidePanelSessionKey, panel);
  }, [setSidePanelState, sidePanelSessionKey, toggleSidePanelState]);

  // When the agent calls a built-in browser tool, the main process opens
  // the WebContentsView and sends panel-opened; when hide_browser is called
  // it sends panel-closed. Without this listener the React UI never knows
  // the panel opened and doesn't render the unified panel chrome.
  useEffect(() => {
    if (!isElectronRuntime()) return;
    const browser = (window as Window).__OPENWORK_ELECTRON__?.browser;
    if (!browser) return;
    const unsubOpen = browser.onPanelOpened?.(() => {
      if (preserveSidePanelOnPanelOpenRef.current) {
        preserveSidePanelOnPanelOpenRef.current = false;
        return;
      }
      setCurrentSidePanel("panel");
    });
    const unsubClose = browser.onPanelClosed?.(() => setCurrentSidePanel(null));
    return () => { unsubOpen?.(); unsubClose?.(); };
  }, [setCurrentSidePanel]);
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
    if (sidePanelOpen) return;
    setBrowserPanelDefaultWidth(browserPanelWidth);
  }, [sidePanelOpen, browserPanelWidth]);
  useEffect(() => {
    props.onAccessibleTargetsChange?.(accessibleTargets);
  }, [accessibleTargets, props.onAccessibleTargetsChange]);
  const commitBrowserPanelWidth = useCallback(() => {
    const size = browserPanelRef.current?.getSize();
    if (size?.inPixels) setBrowserPanelWidth(Math.round(size.inPixels));
  }, [browserPanelRef, setBrowserPanelWidth]);
  const browserUrlForTarget = useCallback((target: OpenTarget) => {
    if (/^wss?:\/\//i.test(target.value)) return target.value.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:");
    return target.value;
  }, []);
  const openTargetForRuntime = useCallback((runtime: {
    client: OpenworkServerClient | null;
    runtimeWorkspaceId: string | null;
    workspaceRoot: string;
    workspaceType?: WorkspaceInfo["workspaceType"];
  }, target: OpenTarget, options?: OpenTargetOptions, sourceSessionId?: string) => {
    if (target.kind === "url" || target.preview === "browser") {
      const url = browserUrlForTarget(target);
      if (isElectronRuntime()) {
        setCurrentSidePanel("panel");
        void window.__OPENWORK_ELECTRON__?.browser?.createTab?.(url);
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
      return;
    }

    const openFileTarget = (fileTarget: OpenTarget) => {
      if (options?.external && runtime.workspaceType !== "remote") {
        const path = absoluteWorkspacePath(runtime.workspaceRoot, fileTarget.value);
        if (path && isElectronRuntime()) {
          void (async () => {
            try {
              if (options.reveal) {
                await revealDesktopItemInDir(path);
              } else {
                await openDesktopPath(path);
              }
            } catch {
              await revealDesktopItemInDir(path).catch(() => undefined);
            }
          })();
        }
        return;
      }

      if (!isCollectibleArtifactTarget(fileTarget)) {
        if (isOpenableFileTarget(fileTarget)) {
          if (runtime.workspaceType === "remote" && runtime.client && runtime.runtimeWorkspaceId) {
            void runtime.client.downloadWorkspaceFile(runtime.runtimeWorkspaceId, fileTarget.value)
              .then((result) => {
                const url = URL.createObjectURL(new Blob([result.data], {
                  type: result.contentType ?? "application/octet-stream",
                }));
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = fileTarget.name;
                anchor.click();
                window.setTimeout(() => URL.revokeObjectURL(url), 1000);
              })
              .catch(() => undefined);
          } else if (isElectronRuntime()) {
            void openDesktopPath(absoluteWorkspacePath(runtime.workspaceRoot, fileTarget.value)).catch(() => undefined);
          }
        }
        return;
      }

      const sessionId = sourceSessionId ?? props.selectedSessionId;
      if (!sessionId) return;
      if (options?.auto && activePanelTab?.id === fileTarget.id) return;
      openTab(sessionId, {
        id: fileTarget.id,
        type: "artifact",
        label: fileTarget.name,
        preview: fileTarget.preview,
        target: fileTarget,
      });
      preserveSidePanelOnPanelOpenRef.current = true;
      setCurrentSidePanel("panel");
    };

    if (target.exists !== true) {
      if (!runtime.client || !runtime.runtimeWorkspaceId) return;
      void resolveCollectibleOpenTarget(runtime.client, runtime.runtimeWorkspaceId, target)
        .then((resolvedTarget) => {
          if (resolvedTarget) openFileTarget(resolvedTarget);
        })
        .catch(() => undefined);
      return;
    }

    openFileTarget(target);
  }, [activePanelTab?.id, browserUrlForTarget, openTab, props.selectedSessionId, setCurrentSidePanel]);
  const openTarget = useCallback((target: OpenTarget, options?: OpenTargetOptions, sourceSessionId?: string) => {
    openTargetForRuntime({
      client: props.openworkServerClient,
      runtimeWorkspaceId: props.runtimeWorkspaceId,
      workspaceRoot: props.selectedWorkspaceRoot,
      workspaceType: props.selectedWorkspaceDisplay.workspaceType,
    }, target, options, sourceSessionId);
  }, [
    openTargetForRuntime,
    props.openworkServerClient,
    props.runtimeWorkspaceId,
    props.selectedWorkspaceDisplay.workspaceType,
    props.selectedWorkspaceRoot,
  ]);
  const closeRightPane = useCallback(() => {
    setCurrentSidePanel(null);
  }, [setCurrentSidePanel]);
  const openGeneralSidePanel = useCallback(() => {
    setCurrentSidePanel("panel");
  }, [setCurrentSidePanel]);
  const openBrowserRailPane = useCallback(() => {
    if (!hasBrowserTabs) return;
    // Opening the browser pane should land on a usable page, not an empty
    // panel that forces the user to click "+".
    toggleCurrentSidePanel("panel");
  }, [hasBrowserTabs, toggleCurrentSidePanel]);
  const openBrowserUrlControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "browser.open_url",
    label: "Open URL in built-in browser",
    description: "Create or select an OpenWork built-in browser tab, navigate it to a URL, and return the CDP handle for browser automation.",
    sideEffect: "navigation",
    requiresArgs: true,
    args: [
      { name: "url", type: "string", required: true, description: "The website URL to open." },
      { name: "provider", type: "string", description: "Browser provider. Use builtin or auto. External is reserved for future support." },
    ],
    previewArgs: { url: "https://example.com", provider: "builtin" },
    disabled: !isElectronRuntime(),
    execute: async (args) => {
      const url = controlStringArg(args, "url");
      if (!url) return { ok: false, error: "Missing URL." };
      const provider = controlStringArg(args, "provider") || "builtin";
      if (provider !== "auto" && provider !== "builtin") {
        return { ok: false, error: `Browser provider is not available yet: ${provider}` };
      }
      setCurrentSidePanel("panel");
      return window.__OPENWORK_ELECTRON__?.browser?.openUrl?.(url, provider);
    },
  }), [setCurrentSidePanel]);
  useControlAction(openBrowserUrlControlAction);
  const setBrowserProxyControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "browser.set_proxy",
    label: "Set built-in browser proxy",
    description: "Route all built-in browser traffic through an HTTP/SOCKS proxy (e.g. to browse from another location). Applies to every built-in browser tab until cleared. Pass an empty proxy to restore system network settings.",
    sideEffect: "mutation",
    args: [
      { name: "proxy", type: "string", description: "Proxy URL like http://user:pass@host:8080 or socks5://host:1080, env:NAME to use the OPENWORK_BROWSER_PROXY_NAME environment variable, or empty to clear." },
    ],
    previewArgs: { proxy: "env:DE" },
    disabled: !isElectronRuntime(),
    execute: async (args) => {
      const proxy = controlStringArg(args, "proxy") || "";
      const setProxy = window.__OPENWORK_ELECTRON__?.browser?.setProxy;
      if (!setProxy) return { ok: false, error: "Built-in browser is not available." };
      return setProxy(proxy);
    },
  }), []);
  useControlAction(setBrowserProxyControlAction);
  const openArtifactRailPane = useCallback(() => {
    if (!hasArtifactTargets) {
      setCurrentSidePanel("panel");
      return;
    }
    if (!props.selectedSessionId) return;
    const activeTab = sessionPanelState.tabs.find((tab) => tab.id === sessionPanelState.activeTabId);
    const artifactTargetIds = new Set(artifactFileTargets.map((target) => target.id));
    const currentArtifactTab = activeTab?.type === "artifact" && artifactTargetIds.has(activeTab.id) ? activeTab : null;
    const artifactTab = sessionPanelState.tabs.find((tab) => (
      tab.type === "artifact" && artifactTargetIds.has(tab.id)
    ));
    const firstArtifact = artifactFileTargets[0];
    const tabToSelect = currentArtifactTab?.id ?? artifactTab?.id ?? firstArtifact?.id ?? null;

    for (const target of artifactFileTargets) {
      if (sessionPanelState.tabs.some((tab) => tab.id === target.id)) continue;
      openTab(props.selectedSessionId, {
        id: target.id,
        type: "artifact",
        label: target.name,
        preview: target.preview,
      });
    }

    if (tabToSelect) {
      selectTab(props.selectedSessionId, tabToSelect);
    }

    if (panelRailActive && activeTab?.type === "artifact") {
      toggleCurrentSidePanel("panel");
      return;
    }
    if (!panelRailActive) {
      preserveSidePanelOnPanelOpenRef.current = true;
    }
    if (!panelRailActive) {
      toggleCurrentSidePanel("panel");
    }
  }, [artifactFileTargets, hasArtifactTargets, openTab, panelRailActive, props.selectedSessionId, selectTab, sessionPanelState, setCurrentSidePanel, toggleCurrentSidePanel]);
  const openVoiceRailPane = useCallback(() => {
    toggleCurrentSidePanel("voice");
  }, [toggleCurrentSidePanel]);
  const removeAccessibleTarget = useCallback((target: OpenTarget) => {
    const nextHiddenIds = new Set(hiddenAccessibleTargetIds);
    nextHiddenIds.add(target.id);
    writeHiddenAccessibleTargetIds(props.selectedWorkspaceId, props.selectedSessionId, nextHiddenIds);
    setHiddenTargetRevision((value) => value + 1);
    if (props.selectedSessionId) {
      closeTab(props.selectedSessionId, target.id);
    }
  }, [closeTab, hiddenAccessibleTargetIds, props.selectedSessionId, props.selectedWorkspaceId]);
  useEffect(() => {
    const open = (event: Event) => {
      const requested = (event as CustomEvent<OpenTarget>).detail;
      const target = accessibleTargets.find((item) => item.id === requested?.id || item.value === requested?.value) ?? (
        requested?.kind && requested?.value ? requested : null
      );
      if (target) openTarget(target);
    };
    const hide = (event: Event) => {
      const requested = (event as CustomEvent<OpenTarget>).detail;
      const target = accessibleTargets.find((item) => item.id === requested?.id || item.value === requested?.value);
      if (target) removeAccessibleTarget(target);
    };
    window.addEventListener("openwork-open-accessible-target", open);
    window.addEventListener("openwork-hide-accessible-target", hide);
    return () => {
      window.removeEventListener("openwork-open-accessible-target", open);
      window.removeEventListener("openwork-hide-accessible-target", hide);
    };
  }, [accessibleTargets, openTarget, removeAccessibleTarget]);
  useEffect(() => {
    const handler = () => setCurrentSidePanel(null);
    window.addEventListener("openwork-close-right-pane", handler);
    return () => window.removeEventListener("openwork-close-right-pane", handler);
  }, [setCurrentSidePanel]);
  useEffect(() => {
    const refresh = () => setExtensionStateVersion((value) => value + 1);
    window.addEventListener(OPENWORK_EXTENSION_STATE_CHANGED, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(OPENWORK_EXTENSION_STATE_CHANGED, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  useEffect(() => {
    if (activeSidePanel === "voice" && !voiceExtensionEnabled) {
      setCurrentSidePanel(null);
    }
  }, [activeSidePanel, setCurrentSidePanel, voiceExtensionEnabled]);

  const openVoicePanelControlAction = useMemo<OpenworkControlAction | null>(() => (
    voiceExtensionEnabled ? {
      id: "voice.panel.open",
      label: "Open Voice Mode",
      description: "Open the sticky Voice Mode right-side panel.",
      effects: { data: "none", ui: "layout", external: false },
      sideEffect: "none",
      execute: () => {
        setCurrentSidePanel("voice");
        return { open: true };
      },
    } : null
  ), [setCurrentSidePanel, voiceExtensionEnabled]);
  useControlAction(openVoicePanelControlAction);

  const closeVoicePanelControlAction = useMemo<OpenworkControlAction | null>(() => (
    voiceExtensionEnabled && activeSidePanel === "voice" ? {
      id: "voice.panel.close",
      label: "Close Voice Mode",
      description: "Close the Voice Mode right-side panel.",
      effects: { data: "none", ui: "layout", external: false },
      sideEffect: "none",
      execute: () => {
        setCurrentSidePanel(null);
        return { open: false };
      },
    } : null
  ), [activeSidePanel, setCurrentSidePanel, voiceExtensionEnabled]);
  useControlAction(closeVoicePanelControlAction);
  const [showDelayedSessionLoadingState, setShowDelayedSessionLoadingState] = useState(false);

  const selectedSessionTitle = useMemo(
    () => sessionTitleForId(props.sidebar.workspaceSessionGroups, props.selectedSessionId, props.selectedWorkspaceId),
    [props.selectedSessionId, props.sidebar.workspaceSessionGroups],
  );
  const workspaceName =
    props.selectedWorkspaceDisplay.displayName?.trim() ||
    props.selectedWorkspaceDisplay.name?.trim() ||
    t("session.workspace_fallback");
  useEffect(() => {
    if (pendingConversationHistoryNavigation) {
      if (
        pendingConversationHistoryNavigation.history.workspaceId === props.selectedWorkspaceId &&
        pendingConversationHistoryNavigation.targetSessionId === props.selectedSessionId
      ) {
        setConversationHistory(pendingConversationHistoryNavigation.history);
        // Restore the split layout recorded at this history step.
        const targetSplit = pendingConversationHistoryNavigation.targetSplitSessionId;
        if (targetSplit) {
          openWorkbenchTab({
            workspaceId: props.selectedWorkspaceId,
            sessionId: targetSplit,
            title: sessionTitleForId(props.sidebar.workspaceSessionGroups, targetSplit, props.selectedWorkspaceId),
            workspaceTitle: workspaceTitleForId(props.sidebar.workspaceSessionGroups, props.selectedWorkspaceId),
          });
        }
        setWorkbenchSplit(targetSplit ? { workspaceId: props.selectedWorkspaceId, sessionId: targetSplit } : null);
        setPendingConversationHistoryNavigation(null);
        return;
      }
      if (
        pendingConversationHistoryNavigation.fromWorkspaceId === props.selectedWorkspaceId &&
        pendingConversationHistoryNavigation.fromSessionId === props.selectedSessionId
      ) {
        return;
      }
      setPendingConversationHistoryNavigation(null);
    }

    setConversationHistory((current) => syncConversationTabHistory(
      current,
      props.selectedWorkspaceId,
      props.selectedSessionId,
      splitSession?.sessionId ?? null,
    ));
  }, [
    openWorkbenchTab,
    pendingConversationHistoryNavigation,
    props.selectedSessionId,
    props.selectedWorkspaceId,
    props.sidebar.workspaceSessionGroups,
    setWorkbenchSplit,
    splitSession,
  ]);
  useEffect(() => {
    if (!pendingConversationHistoryNavigation) return undefined;
    const id = window.setTimeout(() => {
      setPendingConversationHistoryNavigation((current) => current === pendingConversationHistoryNavigation ? null : current);
    }, 5000);
    return () => window.clearTimeout(id);
  }, [pendingConversationHistoryNavigation]);
  useEffect(() => {
    const workspaceGroup = props.sidebar.workspaceSessionGroups.find(
      (group) => group.workspace.id === props.selectedWorkspaceId,
    );
    syncWorkbench({
      workspaceId: props.selectedWorkspaceId,
      workspaceTitle: workspaceName,
      primarySessionId: props.selectedSessionId,
      sessionsKnown: workspaceGroup?.status === "ready",
      sessions: (workspaceGroup?.sessions ?? []).map((session) => ({
        workspaceId: props.selectedWorkspaceId,
        sessionId: session.id,
        title: getDisplaySessionTitle(session.title),
        workspaceTitle: workspaceName,
      })),
    });
  }, [
    props.selectedSessionId,
    props.selectedWorkspaceId,
    props.sidebar.workspaceSessionGroups,
    syncWorkbench,
    workspaceName,
  ]);
  useEffect(() => {
    props.onSessionTabsChange?.(sessionTabs);
  }, [sessionTabs, props.onSessionTabsChange]);
  const sessionActionTitle = useMemo(
    () => sessionTitleForId(props.sidebar.workspaceSessionGroups, sessionActionId),
    [props.sidebar.workspaceSessionGroups, sessionActionId],
  );
  const providerCount = props.hasUsableModel ? 1 : props.providerConnectedIds.length;
  const messageCountVisible = props.selectedSessionId ? 1 : 0;
  const hasMainContentTakeover = Boolean(props.mainContentTakeover);
  const showWorkspaceSetupEmptyState = props.workspaces.length === 0 && !props.selectedSessionId;
  const showStartupSkeleton =
    !bootOverlayVisible &&
    !props.primarySlot &&
    !hasMainContentTakeover &&
    !props.selectedSessionId &&
    !props.clientConnected &&
    props.startupPhase !== "sessionIndexReady" &&
    props.startupPhase !== "firstSessionReady" &&
    props.startupPhase !== "ready";
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
  const selectedWorkspaceErrorTitle =
    props.selectedWorkspaceDisplay.workspaceType === "remote"
      ? "Remote workspace unavailable"
      : "OpenCode unavailable";

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
  const canRenderSplitSurface = Boolean(canRenderReactSurface && splitSession);
  const splitWorkspaceTitle = splitSession
    ? splitSession.workspaceTitle ?? workspaceTitleForId(props.sidebar.workspaceSessionGroups, splitSession.workspaceId)
    : "";
  const splitPaneRuntime: SessionPagePaneRuntime | null = (() => {
    if (!splitSession) return null;
    if (splitSession.workspaceId !== props.selectedWorkspaceId) {
      return props.resolvePaneRuntime?.(splitSession) ?? {
        status: "unavailable",
        workspaceId: splitSession.workspaceId,
        workspaceTitle: splitWorkspaceTitle,
        message: "This workspace does not have a connected runtime.",
      };
    }
    if (
      props.runtimeWorkspaceId
      && props.openworkServerClient
      && reactSessionBaseUrl
      && reactSessionToken
      && props.surface
    ) {
      return {
        status: "ready",
        workspaceId: splitSession.workspaceId,
        workspaceTitle: splitWorkspaceTitle,
        workspaceRoot: props.selectedWorkspaceRoot,
        workspaceType: props.selectedWorkspaceDisplay.workspaceType,
        runtimeWorkspaceId: props.runtimeWorkspaceId,
        opencodeBaseUrl: reactSessionBaseUrl,
        openworkToken: reactSessionToken,
        client: props.openworkServerClient,
        environmentClient: props.environmentClient,
        surface: props.surface,
      };
    }
    return {
      status: "unavailable",
      workspaceId: splitSession.workspaceId,
      workspaceTitle: splitWorkspaceTitle,
      message: selectedWorkspaceErrorMessage || "This workspace is disconnected.",
    };
  })();
  const narrowPaneOptions = useMemo<NarrowPaneOption[]>(() => {
    const options: NarrowPaneOption[] = [{ id: "chat", label: "Chat" }];
    if (splitSession) options.push({ id: "split", label: "Split chat" });
    if (sidePanelOpen) {
      options.push({
        id: "panel",
        label: activeSidePanel === "voice"
          ? "Voice"
          : activeSidePanel === "extensions"
            ? "Extensions"
            : "Tools",
      });
    }
    return options;
  }, [activeSidePanel, sidePanelOpen, splitSession]);
  const showNarrowPaneSwitcher = shouldShowNarrowPaneSwitcher(
    isMobile,
    Boolean(splitSession),
    sidePanelOpen,
  );
  const crossWorkspaceSplit = Boolean(splitSession && splitSession.workspaceId !== props.selectedWorkspaceId);
  // Route-level refreshes must only gate the very first paint of a session.
  // Once the surface can mount it owns its own data stream, so replacing a
  // rendered chat with a loading pane (and leaving it there when a refresh
  // hangs) is never correct.
  const showSessionLoadingState =
    !bootOverlayVisible &&
    !props.primarySlot &&
    Boolean(props.selectedSessionId) &&
    props.sessionLoadingById(props.selectedSessionId) &&
    !hasMainContentTakeover &&
    !showWorkspaceSetupEmptyState &&
    !canRenderReactSurface;
  const selectedWorkspaceIsRemote = props.workspaces.some(
    (workspace) => workspace.id === props.selectedWorkspaceId && workspace.workspaceType === "remote",
  );
  const findButtonSessionId = props.selectedSessionId;
  const canGoBackInConversationHistory = !pendingConversationHistoryNavigation && canNavigateSelectedConversationHistory(
    conversationHistory,
    props.selectedWorkspaceId,
    props.selectedSessionId,
    "back",
  );
  const canGoForwardInConversationHistory = !pendingConversationHistoryNavigation && canNavigateSelectedConversationHistory(
    conversationHistory,
    props.selectedWorkspaceId,
    props.selectedSessionId,
    "forward",
  );

  const openSessionTab = useCallback((workspaceId: string, sessionId: string) => {
    openWorkbenchTab({
      workspaceId,
      sessionId,
      title: sessionTitleForId(props.sidebar.workspaceSessionGroups, sessionId, workspaceId),
      workspaceTitle: workspaceTitleForId(props.sidebar.workspaceSessionGroups, workspaceId),
    });
    focusWorkbenchPane("primary");
    props.sidebar.onOpenSession(workspaceId, sessionId);
  }, [focusWorkbenchPane, openWorkbenchTab, props.sidebar]);

  const closeSecondaryWorkbenchPane = useCallback(() => {
    setWorkbenchSplit(null);
  }, [setWorkbenchSplit]);

  const closePrimaryWorkbenchPane = useCallback(() => {
    if (!splitSession) return;
    setWorkbenchSplit(null);
    openSessionTab(splitSession.workspaceId, splitSession.sessionId);
  }, [openSessionTab, setWorkbenchSplit, splitSession]);

  // Sub-agent sessions open in the main chat surface from their task card in
  // the parent transcript (they no longer live in the sidebar).
  const openSubagentSession = useCallback((sessionId: string) => {
    const workspaceId = props.runtimeWorkspaceId ?? props.selectedWorkspaceId;
    if (!workspaceId || !sessionId.trim()) return;
    openSessionTab(workspaceId, sessionId.trim());
  }, [openSessionTab, props.runtimeWorkspaceId, props.selectedWorkspaceId]);

  // When viewing a sub-agent (child) session, the header shows a control back
  // to its parent chat.
  const parentSessionLink = useMemo(() => {
    const sessionId = props.selectedSessionId;
    if (!sessionId) return null;
    for (const group of props.sidebar.workspaceSessionGroups) {
      const session = group.sessions.find((entry) => entry.id === sessionId);
      if (!session) continue;
      const parentID = session.parentID?.trim();
      if (!parentID) return null;
      const parent = group.sessions.find((entry) => entry.id === parentID);
      if (!parent) return null;
      return {
        workspaceId: group.workspace.id,
        sessionId: parent.id,
        title: getDisplaySessionTitle(parent.title),
      };
    }
    return null;
  }, [props.selectedSessionId, props.sidebar.workspaceSessionGroups]);

  const focusWorkbenchSessionControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "workbench.session.focus",
    label: "Focus an open session",
    description: "Focus a session already visible in either split-screen pane, or reuse its existing tab without opening a duplicate.",
    effects: { data: "none", ui: "navigate", external: false },
    sideEffect: "navigation",
    requiresArgs: true,
    args: [{
      name: "sessionId",
      type: "string",
      required: true,
      description: "Session id from the OpenWork context resources or conversation tabs.",
    }],
    execute: (args) => {
      if (!args || typeof args !== "object" || !("sessionId" in args) || typeof args.sessionId !== "string") {
        return { ok: false, error: "sessionId is required" };
      }
      const sessionId = args.sessionId.trim();
      if (!sessionId) return { ok: false, error: "sessionId is required" };
      if (sessionId === workbenchPrimary?.sessionId) {
        focusWorkbenchPane("primary");
        return { ok: true, sessionId, reused: "primary-pane" };
      }
      if (sessionId === splitSession?.sessionId) {
        focusWorkbenchPane("secondary");
        return { ok: true, sessionId, reused: "secondary-pane" };
      }
      const tab = sessionTabs.find((entry) => entry.sessionId === sessionId);
      if (tab) {
        focusWorkbenchPane("primary");
        props.sidebar.onOpenSession(tab.workspaceId, tab.sessionId);
        return { ok: true, sessionId, reused: "tab" };
      }
      const workspace = props.sidebar.workspaceSessionGroups.find((group) => (
        group.sessions.some((session) => session.id === sessionId)
      ));
      if (!workspace) return { ok: false, error: `Session is unavailable: ${sessionId}` };
      openSessionTab(workspace.workspace.id, sessionId);
      return { ok: true, sessionId, reused: "new-tab" };
    },
  }), [
    focusWorkbenchPane,
    openSessionTab,
    props.sidebar,
    sessionTabs,
    splitSession,
    workbenchPrimary,
  ]);
  useControlAction(focusWorkbenchSessionControlAction);

  const navigateConversationHistory = useCallback((direction: ConversationHistoryDirection) => {
    if (!canNavigateSelectedConversationHistory(
      conversationHistory,
      props.selectedWorkspaceId,
      props.selectedSessionId,
      direction,
    )) return;
    const next = navigateConversationTabHistory(conversationHistory, direction);
    if (!next.entry) return;
    setPendingConversationHistoryNavigation({
      history: next.history,
      fromWorkspaceId: props.selectedWorkspaceId,
      fromSessionId: props.selectedSessionId,
      targetSessionId: next.entry.sessionId,
      targetSplitSessionId: next.entry.splitSessionId,
    });
    props.sidebar.onOpenSession(next.history.workspaceId, next.entry.sessionId);
  }, [conversationHistory, props.selectedSessionId, props.selectedWorkspaceId, props.sidebar]);

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

  const sidePanelContent = activeSidePanel === "extensions" && props.settingsSlot ? (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background">
      {props.settingsSlot}
    </div>
  ) : activeSidePanel === "voice" ? (
    <VoicePanel
      client={props.openworkServerClient}
      sessionId={props.selectedSessionId}
      opencodeBaseUrl={reactSessionBaseUrl}
      openworkToken={reactSessionToken}
      onClose={closeRightPane}
    />
  ) : activeSidePanel === "panel" ? (
    <SidePanel
      sessionId={sidePanelSessionKey}
      client={props.openworkServerClient}
      workspaceId={props.runtimeWorkspaceId}
      workspaceRoot={props.selectedWorkspaceRoot}
      isRemoteWorkspace={props.surface?.isRemoteWorkspace ?? false}
      onClose={closeRightPane}
      onOpenExtensions={props.settingsSlot ? () => setCurrentSidePanel("extensions") : undefined}
      onOpenVoice={voiceExtensionEnabled ? openVoiceRailPane : undefined}
    />
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[radial-gradient(circle_at_top,rgba(74,111,255,0.12),transparent_42%),var(--app-bg,#0b1020)] text-dls-text max-lg:pt-[env(safe-area-inset-top)] mac:bg-transparent">
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
          sessionNumberShortcuts={props.sessionNumberShortcuts}
          workspaceSessionGroups={props.sidebar.workspaceSessionGroups}
          selectedWorkspaceId={props.sidebar.selectedWorkspaceId}
          developerMode={props.sidebar.developerMode}
          selectedSessionId={props.sidebar.selectedSessionId}
          showSessionActions={Boolean(props.onRenameSession || props.onDeleteSession || props.onArchiveSession)}
          sessionStatusById={props.sidebar.sessionStatusById}
          connectingWorkspaceId={props.sidebar.connectingWorkspaceId}
          workspaceConnectionStateById={props.sidebar.workspaceConnectionStateById}
          newTaskDisabled={props.sidebar.newTaskDisabled}
          onSelectWorkspace={props.sidebar.onSelectWorkspace}
          onOpenSession={openSessionTab}
          onPrefetchSession={props.sidebar.onPrefetchSession}
          onCreateTaskInWorkspace={props.sidebar.onCreateTaskInWorkspace}
          onOpenRenameSession={props.onRenameSession ? openRenameModal : undefined}
          onOpenDeleteSession={props.onDeleteSession ? (sessionId) => {
            setSessionActionId(sessionId);
            setDeleteOpen(true);
          } : undefined}
          onArchiveSession={props.onArchiveSession ? (sessionId, archived) => {
            void props.onArchiveSession?.(sessionId, archived);
          } : undefined}
          onOpenCreateGroupModal={(workspaceId) => {
            setCreateGroupWorkspaceId(workspaceId);
            setCreateGroupLabel("");
            setCreateGroupOpen(true);
          }}
          onOpenRenameWorkspace={props.sidebar.onOpenRenameWorkspace}
          onShareWorkspace={props.sidebar.onShareWorkspace}
          onRevealWorkspace={props.sidebar.onRevealWorkspace}
          onRecoverWorkspace={props.sidebar.onRecoverWorkspace}
          onTestWorkspaceConnection={props.sidebar.onTestWorkspaceConnection}
          onEditWorkspaceConnection={props.sidebar.onEditWorkspaceConnection}
          onForgetWorkspace={props.sidebar.onForgetWorkspace}
          onOpenCreateWorkspace={props.sidebar.onOpenCreateWorkspace}
          onOpenSessionSearch={props.sidebar.onOpenSessionSearch}
          automationsActive={props.sidebar.automationsActive}
          automationsNeedAttention={props.sidebar.automationsNeedAttention}
          onOpenAutomations={props.sidebar.onOpenAutomations}
          dashboardActive={props.sidebar.dashboardActive}
          onOpenDashboard={props.sidebar.onOpenDashboard}
          conversationHistory={{
            canGoBack: canGoBackInConversationHistory,
            canGoForward: canGoForwardInConversationHistory,
            onNavigate: navigateConversationHistory,
          }}
          onReorderWorkspaces={props.sidebar.onReorderWorkspaces}
          onStartResize={startLeftSidebarResize}
          onOpenAccountSettings={props.onOpenSettings}
          onOpenExtensions={props.onOpenExtensions}
          extensionsActive={props.extensionsActive}
          status={{
            clientConnected: props.clientConnected,
            openworkServerStatus: props.openworkServerStatus,
            developerMode: props.developerMode,
            showConnectionStatus: Boolean(props.selectedWorkspaceId),
            providerConnectedIds: props.providerConnectedIds,
            mcpConnectedCount: props.mcpConnectedCount,
            showSettingsButton: props.statusBar?.showSettingsButton,
            reloadBusy: props.statusBar?.reloadBusy,
            reloadError: props.statusBar?.reloadError,
            openWorkConnectState: props.statusBar?.openWorkConnectState,
            onSendFeedback: props.onSendFeedback,
          }}
        />
        <SidebarInset
          className={cn(
            "min-h-0 overflow-hidden bg-sidebar mac:bg-transparent mac:[&_header]:transition-[padding-left] mac:[&_header]:duration-200 mac:[&_header]:ease-linear mac:peer-data-[state=collapsed]:[&_header]:pl-34 mac:max-md:[&_header]:pl-34",
            !shellConfig.sidebar && "mac:[&_header]:pl-34",
          )}
        >
          <div className="flex min-h-0 flex-1 max-lg:p-0 lg:py-2 lg:pl-2">
          <ResizablePanelGroup
            orientation="horizontal"
            onLayoutChanged={sidePanelOpen ? commitBrowserPanelWidth : undefined}
            className="min-h-0 flex-1 max-lg:rounded-none lg:rounded-[14px]"
          >
            <ResizablePanel minSize={isMobile ? "0px" : "360px"} className="min-w-0">
              <main className="flex h-full min-w-0 flex-col overflow-hidden bg-dls-surface max-lg:rounded-none max-lg:border-0 max-lg:shadow-none lg:rounded-[14px] lg:border lg:border-border lg:shadow-[0_8px_24px_rgba(15,23,42,0.06)] dark:lg:shadow-[0_10px_30px_rgba(0,0,0,0.45)] mac:bg-dls-surface/85 mac:backdrop-blur-2xl mac:backdrop-saturate-150">
          <header className="z-10 flex h-9 shrink-0 items-center justify-between border-b border-border px-3 max-lg:h-12 lg:px-6 mac:titlebar-drag  mac:backdrop-blur-2xl mac:backdrop-saturate-150 @container/titlebar">
            <div className="flex min-w-0 items-center gap-3">
              {shellConfig.sidebar ? <SidebarTrigger className="mac:hidden" /> : null}
              {parentSessionLink && !props.primarySlot && !hasMainContentTakeover ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 shrink-0 cursor-pointer gap-1 rounded-lg px-1.5 text-[12px] text-gray-10 transition-colors hover:bg-muted hover:text-foreground mac:titlebar-no-drag"
                        data-parent-session-back={parentSessionLink.sessionId}
                        aria-label={`Back to ${parentSessionLink.title || "parent chat"}`}
                        onClick={() => openSessionTab(parentSessionLink.workspaceId, parentSessionLink.sessionId)}
                      >
                        <ArrowLeft size={14} />
                        <span className="max-w-40 truncate max-lg:hidden">
                          {parentSessionLink.title || t("session.default_title")}
                        </span>
                      </Button>
                    }
                  />
                  <TooltipContent>Back to parent chat</TooltipContent>
                </Tooltip>
              ) : null}
              <h1 className="truncate text-[13px] font-medium text-dls-text">
                {props.primaryTitle
                  ? props.primaryTitle
                  : props.mainContentTitle
                  ? props.mainContentTitle
                  : showWorkspaceSetupEmptyState
                  ? t("session.create_or_connect_workspace")
                  : selectedSessionTitle || t("session.default_title")}
              </h1>
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
              {!props.primarySlot && findButtonSessionId && !hasMainContentTakeover ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="hidden rounded-xl text-gray-10 transition-colors hover:bg-muted hover:text-foreground lg:inline-flex"
                        aria-label="Find in conversation"
                        onClick={() => useSessionFindStore.getState().openFind({ sessionId: findButtonSessionId })}
                      >
                        <TextSearch size={16} />
                      </Button>
                    }
                  />
                  <TooltipContent>Find in conversation (⌘F)</TooltipContent>
                </Tooltip>
              ) : null}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className={cn(
                        "hidden rounded-xl text-gray-10 transition-colors hover:bg-muted hover:text-foreground lg:inline-flex",
                        sidePanelOpen && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
                      )}
                      aria-label={sidePanelOpen ? "Close side panel" : "Open side panel"}
                      aria-pressed={sidePanelOpen}
                      onClick={() => {
                        if (sidePanelOpen) {
                          closeRightPane();
                        } else {
                          openGeneralSidePanel();
                        }
                      }}
                    >
                      <PanelRight size={16} />
                    </Button>
                  }
                />
                <TooltipContent>{sidePanelOpen ? "Close side panel" : "Open side panel"}</TooltipContent>
              </Tooltip>
              {showCloudSignIn ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="hidden lg:inline-flex"
                  onClick={openCloudSignIn}
                  title={t("den.signin_title")}
                  aria-label={t("den.signin_title")}
                >
                  <Cloud className="size-3.5" />
                  <span>{t("den.signin_button")}</span>
                </Button>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="rounded-xl text-gray-10 transition-colors hover:bg-muted hover:text-foreground lg:hidden"
                      aria-label="More actions"
                    >
                      <MoreHorizontal size={18} />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" className="w-56">
                  {!props.primarySlot && findButtonSessionId && !hasMainContentTakeover ? (
                    <DropdownMenuItem
                      onClick={() => useSessionFindStore.getState().openFind({ sessionId: findButtonSessionId })}
                    >
                      <TextSearch className="size-4" />
                      Find in conversation
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem onClick={openArtifactRailPane}>
                    <FileText className="size-4" />
                    Files{artifactTargetCount > 0 ? ` (${artifactTargetCount})` : ""}
                  </DropdownMenuItem>
                  {voiceExtensionEnabled ? (
                    <DropdownMenuItem onClick={openVoiceRailPane}>
                      <Mic2 className="size-4" />
                      Voice Mode
                    </DropdownMenuItem>
                  ) : null}
                  {showCloudSignIn ? (
                    <DropdownMenuItem onClick={openCloudSignIn}>
                      <Cloud className="size-4" />
                      {t("den.signin_button")}
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
              {props.developerMode ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="hidden lg:inline-flex"
                  onClick={() => {
                    try {
                      window.localStorage.removeItem("openwork.acknowledgedProviders");
                      window.localStorage.removeItem("openwork.orgOnboardingSeen");
                    } catch {}
                  }}
                  title="Clears acknowledged providers + org onboarding so they trigger again"
                >
                  Reset notifications
                </Button>
              ) : null}
            </div>
          </header>

          {showNarrowPaneSwitcher ? (
            <NarrowPaneSwitcher
              activePane={narrowPane}
              options={narrowPaneOptions}
              navigationRef={narrowPaneNavigationRef}
              onSelect={selectNarrowPane}
            />
          ) : null}

          {showNarrowPaneSwitcher ? narrowPaneOptions
            .filter((option) => option.id !== narrowPane)
            .map((option) => (
              <div
                key={option.id}
                id={`narrow-session-pane-${option.id}`}
                role="tabpanel"
                aria-labelledby={`narrow-session-tab-${option.id}`}
                hidden
              />
            )) : null}

          {isMobile && narrowPane === "panel" && sidePanelOpen ? (
            <div
              id="narrow-session-pane-panel"
              role="tabpanel"
              aria-labelledby="narrow-session-tab-panel"
              className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-dls-surface"
            >
              {sidePanelContent}
            </div>
          ) : (
          <ResizablePanelGroup
            id={`narrow-session-pane-${narrowPane}`}
            role={showNarrowPaneSwitcher ? "tabpanel" : undefined}
            aria-labelledby={showNarrowPaneSwitcher ? `narrow-session-tab-${narrowPane}` : undefined}
            orientation="vertical"
            className="min-h-0 flex-1 overflow-hidden"
          >
            <ResizablePanel minSize="180px" className="min-h-0">
            <div className="relative h-full min-w-0 overflow-hidden bg-dls-surface mac:bg-dls-surface/85 mac:backdrop-blur-2xl mac:backdrop-saturate-150">
              {props.primarySlot ? (
                <div className="h-full overflow-y-auto" data-workspace-primary-slot>
                  {props.primarySlot}
                </div>
              ) : null}
              {hasMainContentTakeover ? props.mainContentTakeover : null}
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

              {!hasMainContentTakeover && showDelayedSessionLoadingState ? (
                selectedWorkspaceIsRemote ? (
                  // Cloud workers sync over the network all the time; the full
                  // loading pane reads as "something is wrong". Keep it to a
                  // quiet text shimmer.
                  <div className="px-6 py-16 text-center" role="status" aria-live="polite">
                    <span className="ow-text-shimmer text-[12px] leading-5">
                      {t("session.loading_detail")}
                    </span>
                  </div>
                ) : (
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
                )
              ) : null}

              {!props.primarySlot && !hasMainContentTakeover && !showDelayedSessionLoadingState && canRenderReactSurface ? (
                <div className="flex h-full min-h-0 flex-col">
                  <ResizablePanelGroup
                    key={canRenderSplitSurface ? "workbench-split" : "workbench-single"}
                    orientation="horizontal"
                    className="min-h-0 flex-1"
                  >
                    {!isMobile || narrowPane === "chat" ? (
                      <ResizablePanel
                        minSize={isMobile ? "0px" : "320px"}
                        className="min-h-0 min-w-0"
                        data-workbench-pane="primary"
                        data-workbench-workspace-id={props.selectedWorkspaceId}
                        data-workbench-pane-focused={activeWorkbenchPane === "primary" ? "true" : undefined}
                        onPointerDown={() => focusWorkbenchPane("primary")}
                        onFocusCapture={() => focusWorkbenchPane("primary")}
                      >
                      <div className="flex h-full min-h-0 flex-col">
                        {canRenderSplitSurface && workbenchPrimary ? (
                          <WorkbenchPaneHeader
                            pane="primary"
                            session={workbenchPrimary}
                            workspaceTitle={workbenchPrimary.workspaceTitle ?? workspaceName}
                            showWorkspace={crossWorkspaceSplit}
                            focused={activeWorkbenchPane === "primary"}
                            onFocus={() => focusWorkbenchPane("primary")}
                            onClose={closePrimaryWorkbenchPane}
                          />
                        ) : null}
                        <div className="min-h-0 flex-1">
                          <SessionSurface
                            // Spread `surface` first so the explicit per-workspace
                            // routing props below CAN'T be silently overridden by
                            // anything that leaks into `surface`. SessionSurface's
                            // server target (client/workspaceId/sessionId/opencodeBaseUrl/openworkToken)
                            // must come from the resolved workspace endpoint passed by
                            // SessionRoute, not from anything in `surface`.
                            {...props.surface!}
                            client={props.openworkServerClient!}
                            environmentClient={props.environmentClient}
                            workspaceId={props.runtimeWorkspaceId!}
                            sessionId={props.selectedSessionId!}
                            isControlTarget={activeWorkbenchPane === "primary"}
                            opencodeBaseUrl={reactSessionBaseUrl}
                            openworkToken={reactSessionToken}
                            todos={props.todos}
                            activePermission={props.activePermission}
                            permissionReplyBusy={props.permissionReplyBusy}
                            respondPermission={props.respondPermission}
                            activeQuestion={props.activeQuestion}
                            questionReplyBusy={props.questionReplyBusy}
                            respondQuestion={props.respondQuestion}
                            safeStringify={props.safeStringify}
                            onOpenTarget={props.surface?.onOpenTarget ?? openTarget}
                            onOpenSubagentSession={openSubagentSession}
                          />
                        </div>
                      </div>
                      </ResizablePanel>
                    ) : null}
                    {canRenderSplitSurface && splitSession && splitPaneRuntime && (!isMobile || narrowPane === "split") ? (
                      <>
                        {!isMobile ? <ResizableHandle /> : null}
                        <ResizablePanel
                          minSize={isMobile ? "0px" : "320px"}
                          className="min-h-0 min-w-0"
                          data-workbench-pane="secondary"
                          data-workbench-workspace-id={splitSession.workspaceId}
                          data-workbench-pane-focused={activeWorkbenchPane === "secondary" ? "true" : undefined}
                          onPointerDown={() => focusWorkbenchPane("secondary")}
                          onFocusCapture={() => focusWorkbenchPane("secondary")}
                        >
                          <div className="flex h-full min-h-0 flex-col">
                            <WorkbenchPaneHeader
                              pane="secondary"
                              session={splitSession}
                              workspaceTitle={splitPaneRuntime.workspaceTitle}
                              showWorkspace={crossWorkspaceSplit}
                              focused={activeWorkbenchPane === "secondary"}
                              onFocus={() => focusWorkbenchPane("secondary")}
                              onClose={closeSecondaryWorkbenchPane}
                            />
                            {splitPaneRuntime.status === "ready" ? (
                              <div className="min-h-0 flex-1">
                                {crossWorkspaceSplit ? (
                                  <ReactSessionRuntime
                                    workspaceId={splitPaneRuntime.runtimeWorkspaceId}
                                    sessionId={splitSession.sessionId}
                                    opencodeBaseUrl={splitPaneRuntime.opencodeBaseUrl}
                                    openworkToken={splitPaneRuntime.openworkToken}
                                  />
                                ) : null}
                                <SessionSurface
                                  {...splitPaneRuntime.surface}
                                  client={splitPaneRuntime.client}
                                  environmentClient={splitPaneRuntime.environmentClient}
                                  workspaceId={splitPaneRuntime.runtimeWorkspaceId}
                                  workspaceRoot={splitPaneRuntime.workspaceRoot}
                                  sessionId={splitSession.sessionId}
                                  isControlTarget={activeWorkbenchPane === "secondary"}
                                  opencodeBaseUrl={splitPaneRuntime.opencodeBaseUrl}
                                  openworkToken={splitPaneRuntime.openworkToken}
                                  todos={[]}
                                  onOpenTarget={(target, options, sourceSessionId) => openTargetForRuntime({
                                    client: splitPaneRuntime.client,
                                    runtimeWorkspaceId: splitPaneRuntime.runtimeWorkspaceId,
                                    workspaceRoot: splitPaneRuntime.workspaceRoot,
                                    workspaceType: splitPaneRuntime.workspaceType,
                                  }, target, options, sourceSessionId)}
                                  onOpenSubagentSession={(sessionId) => openSessionTab(splitSession.workspaceId, sessionId)}
                                />
                              </div>
                            ) : (
                              <UnavailableWorkbenchPane
                                workspaceTitle={splitPaneRuntime.workspaceTitle}
                                message={splitPaneRuntime.message}
                                onRetry={() => void Promise.resolve(
                                  props.sidebar.onTestWorkspaceConnection(splitPaneRuntime.workspaceId),
                                )}
                                onClose={closeSecondaryWorkbenchPane}
                              />
                            )}
                          </div>
                        </ResizablePanel>
                      </>
                    ) : null}
                  </ResizablePanelGroup>
                </div>
              ) : null}

              {!props.primarySlot && !hasMainContentTakeover && !showDelayedSessionLoadingState && !canRenderReactSurface && !showStartupSkeleton ? (
                <div className={`mx-auto max-w-[800px] px-6 ${showWorkspaceSetupEmptyState ? "pt-20" : "pt-10"}`}>
                  {props.notFoundMessage ? (
                    <div className="px-6 py-16 text-center">
                      <div className="mx-auto max-w-md rounded-2xl border border-dls-border bg-dls-card px-5 py-6 shadow-[var(--dls-card-shadow)]">
                        <h3 className="text-base font-medium text-dls-text">Workspace or session not found</h3>
                        <p className="mt-2 text-sm leading-6 text-dls-secondary">{props.notFoundMessage}</p>
                      </div>
                    </div>
                  ) : showWorkspaceSetupEmptyState ? (
                    // Chat-first: no workspace yet — the composer creates a
                    // default chat workspace instead of asking where to put it.
                    <SessionEmptyHero
                      providerCount={providerCount}
                      busy={props.chatFirstBusy}
                      onRunTask={(prompt, attachments) => props.onChatFirstTask?.(prompt, attachments)}
                      onOpenProviderAuth={props.onOpenProviderAuth}
                      composer={props.newTaskComposer}
                    />
                  ) : showSelectedWorkspaceError ? (
                    <div className="px-6 py-16">
                      <div className="mx-auto max-w-lg rounded-2xl border border-red-7/35 bg-red-1/40 p-5 text-left shadow-[var(--dls-card-shadow)]">
                        <div className="text-sm font-medium text-red-11">{selectedWorkspaceErrorTitle}</div>
                        <p className="mt-2 whitespace-pre-wrap wrap-anywhere text-sm leading-6 text-red-11/90">
                          {selectedWorkspaceErrorMessage}
                        </p>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => props.sidebar.onCreateTaskInWorkspace(props.selectedWorkspaceId)}
                          >
                            Retry
                          </Button>
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
                    <div className="flex flex-1 items-center justify-center py-16">
                      <SessionEmptyHero
                        providerCount={providerCount}
                        onRunTask={(prompt, attachments) =>
                          props.sidebar.onCreateTaskWithPrompt?.(props.selectedWorkspaceId, prompt, attachments)
                        }
                        onOpenProviderAuth={props.onOpenProviderAuth}
                        composer={props.newTaskComposer}
                      />
                    </div>
                  )}
                </div>
              ) : null}
            </div>
            </ResizablePanel>
            {props.terminalOpen && !isMobile ? (
              <>
                <ResizableHandle />
                <ResizablePanel defaultSize="280px" minSize="160px" maxSize="55%" className="min-h-0">
                  <TerminalDock
                    workspaceRoot={props.selectedWorkspaceRoot}
                    isRemoteWorkspace={props.selectedWorkspaceDisplay.workspaceType === "remote"}
                    onClose={() => props.onTerminalOpenChange?.(false)}
                  />
                </ResizablePanel>
              </>
            ) : null}
          </ResizablePanelGroup>
          )}

              </main>
            </ResizablePanel>
              {sidePanelOpen && !isMobile ? (
              <>
                <ResizableHandle className="hidden bg-transparent lg:flex" />
                <ResizablePanel
                  panelRef={browserPanelRef}
                  defaultSize={`${activeSidePanel === "extensions" ? Math.max(browserPanelDefaultWidth, 480) : browserPanelDefaultWidth}px`}
                  minSize={activeSidePanel === "extensions" ? "420px" : "320px"}
                  maxSize="70%"
                  className="min-h-0 overflow-hidden pl-2 lg:flex lg:flex-col"
                >
                  <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[14px] border border-border bg-dls-surface shadow-[0_8px_24px_rgba(15,23,42,0.06)] dark:shadow-[0_10px_30px_rgba(0,0,0,0.45)] mac:bg-dls-surface/85 mac:backdrop-blur-2xl mac:backdrop-saturate-150">
                    {sidePanelContent}
                  </div>
                </ResizablePanel>
              </>
            ) : null}
          </ResizablePanelGroup>
          <aside className="hidden w-10 shrink-0 flex-col items-center gap-1 px-1 py-2 text-muted-foreground lg:flex mac:titlebar-no-drag">
            {isElectronRuntime() ? (
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn(
                  "rounded-xl transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
                  panelRailActive && hasBrowserTabs && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
                )}
                onClick={openBrowserRailPane}
                title={hasBrowserTabs ? "Browser" : "Browser opens when a page is available"}
                aria-label={hasBrowserTabs ? "Browser" : "Browser opens when a page is available"}
                aria-pressed={panelRailActive && hasBrowserTabs}
                disabled={!hasBrowserTabs}
              >
                <Globe size={15} />
              </Button>
            ) : null}
            {voiceExtensionEnabled ? (
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn(
                  "rounded-xl transition-colors hover:bg-muted hover:text-foreground",
                  voiceRailActive && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
                )}
                onClick={openVoiceRailPane}
                title="Voice Mode"
                aria-label="Voice Mode"
                aria-pressed={voiceRailActive}
              >
                <Mic2 size={15} />
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(
                "rounded-xl transition-colors hover:bg-muted hover:text-foreground",
                panelRailActive && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
              )}
              onClick={openArtifactRailPane}
              title={`Files (${artifactTargetCount})`}
              aria-label={`Files (${artifactTargetCount})`}
              aria-pressed={panelRailActive}
            >
              <FileText size={15} />
              {artifactTargetCount > 0 ? (
                <span className="absolute right-0 top-0 flex min-w-3.5 translate-x-1 -translate-y-1 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-3 text-primary-foreground">
                  {artifactTargetCount > 9 ? "9+" : artifactTargetCount}
                </span>
              ) : null}
            </Button>
          </aside>
          </div>
        </SidebarInset>
        {shellConfig.sidebar ? <SidebarTrigger className="hidden mac:absolute mac:left-[88px] mac:size-8! top-[3px] z-50 mac:flex titlebar-no-drag" /> : null}
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

      <Dialog open={createGroupOpen} onOpenChange={(open) => { if (!open) setCreateGroupOpen(false); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("session_management.new_group")}</DialogTitle>
          </DialogHeader>
          <Input
            type="text"
            value={createGroupLabel}
            onChange={(e) => setCreateGroupLabel(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && createGroupLabel.trim()) {
                if (createGroupWorkspaceId) useSessionManagementStore.getState().createGroup(createGroupWorkspaceId, createGroupLabel.trim());
                setCreateGroupOpen(false);
              }
            }}
            placeholder={t("session_management.new_group_prompt")}
          />
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>{t("common.cancel")}</DialogClose>
            <Button
              type="button"
              disabled={!createGroupLabel.trim()}
              onClick={() => {
                if (createGroupWorkspaceId) useSessionManagementStore.getState().createGroup(createGroupWorkspaceId, createGroupLabel.trim());
                setCreateGroupOpen(false);
              }}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {props.shareWorkspaceModal ? <ShareWorkspaceModal {...props.shareWorkspaceModal} /> : null}

      {/* Cloud provider notifications are now handled globally by CloudProvidersToast in app-root.tsx */}
    </div>
  );
}
