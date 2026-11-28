"use client";

import { ArrowUp, Check, ChevronDown, CircleAlert, Copy, FileText, Globe, Lock, MessageCircle, Monitor, Pencil, Presentation, X } from "lucide-react";
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { calmChat, computerTabLabel, computerViews, setWorkbotHost, workbotHost, type WorkbotHost } from "./host";
import { OpenWorkMark } from "./mark";
import { createCloudCodingApprovals, useCloudCodingApprovals } from "./cloud-coding-approvals";
import { CloudCodingApprovalCard } from "./cloud-coding-card";
import { chatTitle, RemoveChatButton, SideChatTitle, useChatLocation } from "./chats";
import { DesktopNavigation, MobileNavigation, type NavigationProps } from "./navigation";
import { ProfileSheet, type ProfileTab } from "./profile-sheet";
import {
  useEditWorkbotMessage,
  useRetryWorkbotMessage,
  useSendWorkbotMessage,
  useStartWorkbot,
  useStopWorkbot,
  useStopWorkbotTask,
  useWorkbotChats,
  useWorkbotConnections,
  useWorkbotLive,
  useWorkbotLiveStatus,
  useWorkbotLiveText,
  useWorkbotThread,
  WorkbotChatProvider,
  WorkbotSendError,
  WORKBOT_FIRST_TURNS,
  workbotFilesKey,
  uploadWorkbotFile,
  type LiveText,
  type WorkbotAttachment,
  type WorkbotLiveStore,
  type WorkbotStep,
  type WorkbotTask,
  type WorkbotThread,
  type WorkbotTurn,
} from "./data";
import { AppMark, AttachButton, FilesPanel, SentAttachments, UploadTray, useFileDrop, type Upload } from "./files";
import { createComposerState, type ComposerState, type Pending } from "./composer-state";
import { browserTask, computerWork, finishedSummary, keepsCard, type ComputerSurface } from "./computer-work";
import { BrowserExperience, useBrowserPreview, type BrowserPreviewTask } from "./browser-preview";
import { AccountAvatar } from "./account-menu";
import { documentLinks, WorkbotMarkdown } from "./markdown";
import { OpenFileContext } from "./open-file";
import { ARTIFACT_PARAM } from "./artifact";
import { ArtifactCards } from "./artifact-card";
import { Welcome } from "./welcome";
import { ModelRecovery, AccessRecovery } from "./model-recovery";
import { hasAnsweredTurn, WorkbotSetupChip } from "./activation";
import { WorkbotCalendar } from "./lazy-surfaces";
import { WorkbotDocuments } from "./documents";
import { DeviceComputerNavigationContext, WorkbotDevices } from "./devices";
import { LastGlimpse, LiveGlimpse, WorkbotComputer } from "./computer";
import { readBrowserSkillRunPrompt, type BrowserTeachingContext } from "@openwork/types/browser-demonstration";
import { readWorkbotCorrectionPrompt, workbotCorrectionPrompt, workbotContextLabel, workbotViewContextSchema, type WorkbotViewContext } from "@openwork/types/workbot-context";
import type { DocumentOpenOutcome, DocumentOpenRequest } from "@openwork/documents";
import { ComputerNavigationContext, DockedChat, DocumentNavigationContext, DocumentNavigationStatus, DocumentOffers, type DocumentNavigationState, OpenDocumentContext, SentContext, TeachingNavigationContext, TeachingOffer, useWideScreen, WorkspaceNavigationContext } from "./workspace";
import { useQueryClient } from "@tanstack/react-query";
import { useNativeDictation } from "@openwork/ui/react";
import { WorkbotDictation } from "./native-dictation";
import { WorkbotCommandPalette, type WorkbotPaletteTab } from "./command-palette";
import { nextTaskQuietAt, workbotActivity, type WorkbotActivity } from "./activity";
import { ProfileBadge, WorkingName } from "./working-status";
import { firstReply } from "./first-reply";
import { remoteJobActivity, remoteWatcherTaskIds, useWorkbotRemoteJobs } from "./remote-jobs";
import { createConversationScrollState, useConversationScroll, type ConversationScrollState } from "./conversation-scroll";
import { useWorkbotViewport } from "./viewport";
import { useFloatingChrome } from "./floating-chrome";
import { FloatingGlass } from "./floating-glass";
import { fitTextarea } from "./auto-height";
import { connectorSummary } from "./connector-activity";
import { ConnectorLine } from "./connector-line";

const FIRST_TURNS = WORKBOT_FIRST_TURNS;
const PAGE_TURNS = 30;
const MAX_TURNS = 200;
const earlierWindow = (current: number) => Math.min(MAX_TURNS, current < PAGE_TURNS ? PAGE_TURNS : current + PAGE_TURNS);
const COLUMN = "min-w-0 w-full max-w-[800px]";
const column = () => (calmChat() ? "min-w-0 w-full max-w-[560px]" : COLUMN);
const CALM_TEXT = "text-[14px] leading-[21px] sm:text-[13px]";

const TOUCH_KEYBOARD = "(hover: none) and (pointer: coarse)";
function useTouchKeyboard() {
  return useSyncExternalStore(
    (changed) => { const query = window.matchMedia(TOUCH_KEYBOARD); query.addEventListener("change", changed); return () => query.removeEventListener("change", changed); },
    () => window.matchMedia(TOUCH_KEYBOARD).matches,
    () => false,
  );
}

function newMessageId() {
  return crypto.randomUUID().replaceAll("-", "");
}

type ChatNavigation = {
  chat: string | null;
  title: string;
  openChat: (chat: string | null) => void;
};

/** The Workbot page. `host` is the app it lives in: signed-in requests, the person, their apps (see WorkbotHost). */
export function WorkbotScreen({ host }: { host: WorkbotHost }) {
  setWorkbotHost(host);
  const sideChats = host.sideChats === true;
  const composers = useMemo(() => new Map<string | null, ComposerState>(), [host.identity?.organizationId, host.identity?.principalId]);
  const positions = useMemo(() => new Map<string | null, ConversationScrollState>(), [host.identity?.organizationId, host.identity?.principalId]);
  const viewport = useWorkbotViewport(true, "absolute");
  const disposeComposers = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    clearTimeout(disposeComposers.current);
    return () => { disposeComposers.current = setTimeout(() => { for (const owner of composers.values()) owner.dispose(); }, 0); };
  }, [composers]);
  const approvals = useMemo(() => createCloudCodingApprovals((path, init) => workbotHost().requestJson(path, init)), [host.identity?.organizationId, host.identity?.principalId]);
  const [workspaceDrafts, setWorkspaceDrafts] = useState(false);
  const [chat, openChat] = useChatLocation(sideChats, workspaceDrafts ? () => false : undefined);
  const chats = useWorkbotChats(sideChats);
  const navigation: ChatNavigation | null = sideChats
    ? { chat, title: chat ? chatTitle(chats.data?.side.find((entry) => entry.id === chat)?.title) : "Main chat", openChat }
    : null;
  let composer = composers.get(chat);
  if (!composer) {
    composer = createComposerState((file, progress, signal) => uploadWorkbotFile(file, progress, signal, chat));
    composers.set(chat, composer);
  }
  let position = positions.get(chat);
  if (!position) { position = createConversationScrollState(FIRST_TURNS); positions.set(chat, position); }
  return (
    <div ref={viewport} className="workbot-viewport">
    <WorkbotChatProvider value={chat}>
      <BrowserExperience key={`${host.identity?.organizationId ?? ""}:${host.identity?.principalId ?? ""}:${chat ?? "main"}`}>
        <ChatScreen host={host} approvalStore={approvals} composerState={composer} position={position} navigation={navigation} onDraftsChange={setWorkspaceDrafts} />
      </BrowserExperience>
    </WorkbotChatProvider>
    </div>
  );
}

function ChatScreen({ host, approvalStore, composerState, position, navigation, onDraftsChange }: { host: WorkbotHost; approvalStore: ReturnType<typeof createCloudCodingApprovals>; composerState: ComposerState; position: ConversationScrollState; navigation: ChatNavigation | null; onDraftsChange(dirty: boolean): void }) {
  const { user } = host;
  const side = navigation?.chat != null;
  const queryClient = useQueryClient();
  const readPending = () => composerState.getSnapshot().pending;
  const pending = useSyncExternalStore(composerState.subscribe, readPending, readPending);
  const [turnWindow, setTurnWindowState] = useState(position.turnWindow);
  const setTurnWindow = useCallback((next: number | ((current: number) => number)) => {
    const value = typeof next === "function" ? next(position.turnWindow) : next;
    position.turnWindow = value;
    setTurnWindowState(value);
  }, [position]);
  const [filesOpen, setFilesOpen] = useState(false);
  const [teaching, setTeaching] = useState<BrowserTeachingContext>();
  const browserChat = host.browser === true;
  const [workspaceShell, setWorkspaceShell] = useState(host.workspaceAssistant === true || host.browserDemonstrations === true || browserChat);
  useEffect(() => { if (host.workspaceAssistant || host.browserDemonstrations || browserChat) setWorkspaceShell(true); }, [host.workspaceAssistant, host.browserDemonstrations, browserChat]);
  const wideScreen = useWideScreen();
  const [documentContext, setDocumentContext] = useState<WorkbotViewContext | null>(null);
  const [calendarContext, setCalendarContext] = useState<WorkbotViewContext | null>(null);
  const [browserContext, setBrowserContext] = useState<WorkbotViewContext | null>(null);
  const [includeContext, setIncludeContext] = useState(true);
  const [askContext, setAskContext] = useState<WorkbotViewContext | null>(null);
  const [openDocument, setOpenDocument] = useState<DocumentOpenRequest>();
  const [documentsDirty, setDocumentsDirty] = useState(false);
  const reportDocumentDirty = useCallback((dirty: boolean) => { setDocumentsDirty(dirty); onDraftsChange(dirty); }, [onDraftsChange]);
  useEffect(() => () => onDraftsChange(false), [onDraftsChange]);
  const [leavingDocuments, setLeavingDocuments] = useState<WorkbotTab | null>(null);
  const [tab, setTab] = useWorkbotTab((next) => {
    if (!workspaceShell && documentsDirty && next !== "documents") { setLeavingDocuments(next); return false; }
    return true;
  }, true);
  const browserPreview = useBrowserPreview();
  useEffect(() => { if (browserPreview?.visible && tab === "computer") setTab("home"); }, [browserPreview?.visible, tab, setTab]);
  const [computerVisited, setComputerVisited] = useState(tab === "computer");
  const [computerView, setComputerView] = useState<"browser" | "computer" | null>(null);
  useEffect(() => { if (tab === "computer") setComputerVisited(true); }, [tab]);
  const [documentsVisited, setDocumentsVisited] = useState(tab === "documents");
  const [calendarVisited, setCalendarVisited] = useState(tab === "calendar");
  useEffect(() => { if (tab === "documents") setDocumentsVisited(true); if (tab === "calendar") setCalendarVisited(true); }, [tab]);
  const currentContext = browserPreview?.visible ? browserPreview.context : tab === "home" ? askContext : tab === "documents" ? documentContext : tab === "calendar" ? calendarContext : tab === "computer" ? browserContext : null;
  const shares = (context: WorkbotViewContext | undefined): context is WorkbotViewContext => context !== undefined
    && (context.kind === "browser" ? host.browser === true : host.workspaceAssistant === true && (context.kind === "calendar" || host.documents === true));
  const viewKey = !currentContext ? null : currentContext.kind === "browser" ? `browser:${currentContext.tabId}`
    : currentContext.kind === "document" ? `document:${currentContext.fileId}`
    : currentContext.kind === "documents" ? `documents:${currentContext.view}:${currentContext.folderId}`
    : `calendar:${currentContext.view}:${currentContext.start}:${currentContext.selected?.id ?? ""}`;
  useEffect(() => { if (viewKey) setIncludeContext(true); }, [viewKey]);
  const guided = host.workspaceAssistant === true && host.guidedNavigation === true;
  const [navigationStatus, setNavigationStatus] = useState<Readonly<Record<string, DocumentNavigationState>>>({});
  const navigationRequests = useRef(new Map<string, string>());
  const currentRequest = useRef<string | null>(null);
  const settleNavigation = useCallback((requestId: string, outcome: DocumentOpenOutcome) => {
    const receipt = navigationRequests.current.get(requestId);
    if (!receipt) return;
    setNavigationStatus(current => outcome === "superseded" && current[receipt] !== "opening" ? current : { ...current, [receipt]: outcome });
  }, []);
  const navigateDocument = (fileId: string) => {
    if (!host.workspaceAssistant || !host.documents) return null;
    const requestId = newMessageId();
    if (currentRequest.current) settleNavigation(currentRequest.current, "superseded");
    currentRequest.current = requestId;
    setOpenDocument({ fileId, requestId });
    setTab("documents");
    return requestId;
  };
  const navigateFromChat = navigateDocument;
  const followNavigation = (receipt: { id: string; fileId: string }) => {
    const requestId = navigateFromChat(receipt.fileId);
    if (!requestId) return;
    navigationRequests.current.set(requestId, receipt.id);
    setNavigationStatus(current => ({ ...current, [receipt.id]: "opening" }));
  };
  const view = tab !== "documents" ? tab : documentContext?.kind === "document" ? `documents:${documentContext.fileId}` : documentContext?.kind === "documents" ? `documents:${documentContext.folderId}:${documentContext.query}` : "documents";
  const viewRef = useRef(view);
  viewRef.current = view;
  const sentFrom = useRef(new Map<string, string>());
  const followed = useRef(new Set<string>());
  const navigateComputerFromChat = guided && computerViews(host).length > 0 && tab !== "computer"
    ? () => setTab("computer")
    : null;
  const [teachRequest, setTeachRequest] = useState(0);
  const settleTeachRequest = useCallback(() => setTeachRequest(0), []);
  const openTeaching = !side && host.browserDemonstrations === true && computerViews(host).includes("browser")
    ? () => { setTeachRequest(current => current + 1); setTab("computer"); }
    : null;
  const openFile = useContext(OpenFileContext);
  const [welcome, setWelcome] = useState<"pending" | "showing" | "done">(side ? "done" : "pending");
  const [greetingAwaited, setGreetingAwaited] = useState(false);
  const start = useStartWorkbot();
  const stream = useWorkbotLive(true);
  const thread = useWorkbotThread({ turns: turnWindow, awaiting: greetingAwaited || pending.some((entry) => !entry.failed), live: stream.connected });
  useWorkbotConnections({ enabled: welcome === "pending" && !side, waiting: false });
  const send = useSendWorkbotMessage();
  const retry = useRetryWorkbotMessage();
  const stop = useStopWorkbot();
  const editMessage = useEditWorkbotMessage();
  const data = thread.data?.available ? thread.data : null;
  const earlierToRead = data?.hasEarlier === true && !thread.isPlaceholderData;
  useEffect(() => {
    if (earlierToRead && turnWindow < PAGE_TURNS) setTurnWindow(PAGE_TURNS);
  }, [earlierToRead, turnWindow, setTurnWindow]);
  useEffect(() => {
    const anchor = position.anchor;
    if (position.following || !anchor || !data?.hasEarlier || thread.isFetching || thread.isPlaceholderData || turnWindow >= MAX_TURNS) return;
    if (!data.turns.some(turn => turn.id === anchor.key) && !pending.some(entry => entry.id === anchor.key)) setTurnWindow(earlierWindow);
  }, [data, pending, position, thread.isFetching, thread.isPlaceholderData, turnWindow, setTurnWindow]);
  const loading = thread.isPending;
  useEffect(() => {
    if (!guided || !host.documents || !data) return;
    for (const turn of data.turns) {
      const from = sentFrom.current.get(turn.id);
      const target = turn.navigation.at(-1);
      if (from === undefined || !target || followed.current.has(target.id)) continue;
      for (const receipt of turn.navigation) followed.current.add(receipt.id);
      if (from === viewRef.current) followNavigation(target);
      else setNavigationStatus(current => ({ ...current, [target.id]: "superseded" }));
    }
  });
  useEffect(() => {
    if (!openTeaching || !data) return;
    for (const turn of data.turns) {
      if (!turn.teaching || !sentFrom.current.has(turn.id) || followed.current.has(turn.teaching.id)) continue;
      followed.current.add(turn.teaching.id);
      openTeaching();
    }
  });
  const openedFile = browserPreview?.file ?? null;
  const updateOpenedFile = browserPreview?.updateFile;
  useEffect(() => {
    if (!openedFile || !data || !updateOpenedFile) return;
    let newest = openedFile;
    for (const turn of data.turns) {
      for (const file of [...turn.outputs, ...turn.attachments]) {
        if (file.id === openedFile.id && (file.updatedAt ?? 0) > (newest.updatedAt ?? 0)) newest = file;
      }
    }
    if (newest !== openedFile) updateOpenedFile(newest);
  }, [openedFile, data, updateOpenedFile]);
  const linkedFile = useRef(typeof window === "undefined" ? null : new URL(window.location.href).searchParams.get(ARTIFACT_PARAM));
  useEffect(() => {
    const id = linkedFile.current;
    if (!id || !data) return;
    linkedFile.current = null;
    const url = new URL(window.location.href);
    url.searchParams.delete(ARTIFACT_PARAM);
    window.history.replaceState(window.history.state, "", url);
    const file = data.turns.flatMap((turn) => [...turn.outputs, ...turn.attachments]).filter((entry) => entry.id === id).at(-1);
    if (file) openFile(file);
  }, [data, openFile]);
  const filesEnabled = data?.filesEnabled ?? false;
  const activityNow = useTaskClock(data?.turns);
  const liveStatus = useWorkbotLiveStatus(stream.live);
  const approvals = useCloudCodingApprovals(approvalStore, { ...host.identity, open: data !== null && (tab === "home" || (browserChat && wideScreen && tab === "computer")), busy: data?.status === "busy" || greetingAwaited || pending.some(entry => !entry.failed) });
  const approvalCards = approvals.entries.length || approvals.error ? <div className="max-h-[45dvh] overflow-y-auto">
    {approvals.error && <ErrorLine action={{ label: "Retry", onClick: () => void approvalStore.refresh() }}>{approvals.error}</ErrorLine>}
    {approvals.entries.map(entry => <CloudCodingApprovalCard key={entry.approval.id} entry={entry} icons={host.appIcons("GitHub", "github.com")}
      onDecide={decision => void approvalStore.decide(entry.approval.id, decision)} onRetry={() => void approvalStore.retry(entry.approval.id)} onDismiss={() => approvalStore.dismiss(entry.approval.id)} />)}
  </div> : null;
  const remote = useWorkbotRemoteJobs(data !== null, { follow: true });
  const watcherKey = [...remoteWatcherTaskIds(remote.data?.jobs ?? [])].join("\n");
  const watcherIds = useMemo(() => new Set(watcherKey ? watcherKey.split("\n") : []), [watcherKey]);
  const activity = useMemo(() => {
    const jobs = remote.data?.jobs ?? [];
    const watchers = remoteWatcherTaskIds(jobs);
    const turns = (data?.turns ?? []).map((turn) => ({ ...turn, tasks: turn.tasks.filter((task) => !watchers.has(task.id)) }));
    const local = { ...workbotActivity(turns, liveStatus, activityNow), connected: data !== null };
    const away = remoteJobActivity(jobs);
    const localTask = local.tasks.find((task) => !task.quiet && (task.status === "queued" || task.status === "working" || task.status === "paused"));
    if (!local.main && away && (!localTask || (away.since ?? 0) >= (localTask.startedAt ?? 0))) return { ...local, working: true, label: away.label, icon: "computer" as const, since: away.since, watch: null };
    return local;
  }, [host.browser, data, liveStatus, activityNow, remote.data]);
  const addFiles = composerState.add;
  const openFiles = filesEnabled ? () => { if (!workspaceShell && tab !== "home") setTab("home"); setFilesOpen(true); } : undefined;
  const chatListEnabled = navigation !== null;
  const paletteChats = useWorkbotChats(chatListEnabled);
  const refetchChatList = paletteChats.refetch;
  useEffect(() => {
    if (!wideScreen || !chatListEnabled) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refetchChatList(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [wideScreen, chatListEnabled, refetchChatList]);
  const computerFor = (workbotChat: string) => {
    if (computerViews(host).length === 0) return null;
    const target = workbotChat === "main" ? null : workbotChat;
    if (target === (navigation?.chat ?? null)) return () => setTab("computer");
    if (!navigation || documentsDirty || (target !== null && !paletteChats.data?.side.some(entry => entry.id === target))) return null;
    return () => {
      navigation.openChat(target);
      window.history.replaceState(null, "", `${pagePath("computer")}${window.location.search}`);
    };
  };
  const paletteTasks = useMemo(() => (data?.turns ?? []).flatMap((turn) => turn.tasks), [data?.turns]);
  const palette = (
    <WorkbotCommandPalette
      name={data?.name ?? "Workbot"}
      tab={tab}
      tabs={paletteTabs(host)}
      computerLabel={computerTabLabel(host)}
      onTab={(next) => setTab(next)}
      chats={navigation ? {
        current: navigation.chat,
        list: paletteChats.data,
        loading: paletteChats.isPending,
        failed: paletteChats.isError,
        retry: () => void paletteChats.refetch(),
        open: navigation.openChat,
        locked: documentsDirty,
      } : null}
      busy={data?.status === "busy" || pending.some((entry) => !entry.failed)}
      onStop={data ? () => stop.mutate() : null}
      onOpenFiles={openFiles ?? null}
      tasks={paletteTasks}
      onFocusComposer={data ? focusComposer : null}
      onShowTask={showTask}
      homeHref={host.homeHref}
      connectionsHref={host.connectionsHref ?? null}
    />
  );
  const dragging = useFileDrop(filesEnabled, addFiles);

  const [profileTab, setProfileTab] = useState<ProfileTab | null>(null);
  const showDesktopNavigation = wideScreen && !browserPreview?.panelOpen;
  const navigationProps: NavigationProps = {
    page: tab, onPage: setTab, currentChat: navigation?.chat ?? null,
    chats: paletteChats.data, loading: paletteChats.isPending, failed: paletteChats.isError,
    onRetry: () => void paletteChats.refetch(),
    onOpenChat: navigation ? next => { if (!documentsDirty) { setTab("home"); navigation.openChat(next); } } : undefined,
    drafts: documentsDirty,
    onOpen: () => void paletteChats.refetch(),
    search: showDesktopNavigation ? palette : undefined,
    onSearch: showDesktopNavigation ? undefined : () => document.querySelector<HTMLButtonElement>("[data-workbot-palette-trigger]")?.click(),
    account: <AccountAvatar userName={user?.name ?? null} />,
    onProfile: () => setProfileTab("tasks"), assistantName: data?.name ?? "Workbot",
  };
  const mobileNavigation = !showDesktopNavigation ? <MobileNavigation {...navigationProps} /> : null;
  const chrome = useFloatingChrome();
  const layout = (children: ReactNode, floating = false) => <DeviceComputerNavigationContext.Provider value={computerFor}><div className={`workbot workbot-layout flex min-h-0 min-w-0 bg-[var(--wb-bg)] antialiased ${floating ? "is-floating-chrome" : ""}`} data-workbot-look={calmChat() ? "calm" : undefined}>
    {showDesktopNavigation && <DesktopNavigation {...navigationProps} />}
    <div className="workbot-layout-main flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    {<ProfileSheet open={profileTab !== null} initialTab={profileTab ?? "tasks"} onClose={() => setProfileTab(null)} name={data?.name ?? "Workbot"} activity={activity} />}
  </div></DeviceComputerNavigationContext.Provider>;

  useEffect(() => {
    if (greetingAwaited && (start.isError || start.data?.started === false || (data?.turns.length ?? 0) > 0)) setGreetingAwaited(false);
  }, [data, greetingAwaited, start.isError, start.data]);
  useEffect(() => {
    if (welcome === "pending" && data) setWelcome(needsWelcome(data.turns) && pending.length === 0 ? "showing" : "done");
  }, [data, welcome, pending.length]);
  useEffect(() => {
    const hello = data?.turns[0];
    if (welcome === "done" && hello?.greeting && hello.sentAt) rememberWelcomed(hello.sentAt);
  }, [data, welcome]);

  useEffect(() => {
    if (data) composerState.acknowledge(new Set(data.turns.map(turn => turn.id)));
  }, [data, composerState]);

  const sendPending = (id: string, again = false) => {
    sentFrom.current.set(id, viewRef.current);
    return composerState.send(id, async (entry, attachments) => {
      const input = { text: entry.text, context: entry.context, attachments };
      if (entry.correctionOf) await editMessage.mutateAsync({ ...input, id: entry.correctionOf, newId: entry.id });
      else await send.mutateAsync({ ...input, id: entry.id, ...(entry.teachingId ? { teachingId: entry.teachingId, teachingStepId: entry.teachingStepId } : {}) });
      void queryClient.invalidateQueries({ queryKey: workbotFilesKey });
    }, again);
  };
  const submit = (text: string, retry?: Pending, runSkill = false, plain = false) => {
    if (retry) { sendPending(retry.id, true); return; }
    const trimmed = text.trim();
    if (!trimmed && (plain || composerState.getSnapshot().uploads.length === 0)) return;
    const parsed = workbotViewContextSchema.safeParse((browserPreview?.visible ? browserPreview.includeContext : includeContext) && !plain && !runSkill && !teaching ? currentContext : undefined);
    const context = parsed.success && shares(parsed.data) ? parsed.data : undefined;
    if (context && askContext && tab === "home" && !browserPreview?.visible) setAskContext(null);
    const id = composerState.enqueue({ id: newMessageId(), text: trimmed, context, keepDraft: plain, ...(!runSkill && !plain && teaching ? { teachingId: teaching.id, teachingStepId: teaching.stepId } : {}) });
    const delivery = sendPending(id);
    if (runSkill) return delivery.then(() => {
      const failure = composerState.getSnapshot().pending.find(entry => entry.id === id)?.failed;
      if (failure) throw new Error(failure);
    });
  };

  const [editErrors, setEditErrors] = useState<Readonly<Record<string, Error | string>>>({});

  const editTurn = (turn: WorkbotTurn, text: string) => {
    const trimmed = text.trim();
    if (!trimmed && turn.attachments.length === 0) return;
    const context = shares(turn.context) ? turn.context : undefined;
    const correctionReference = { messageId: `wb_${turn.id}`, quote: readWorkbotCorrectionPrompt(turn.text).text.slice(0, 1000), sentAt: turn.sentAt };
    const id = composerState.enqueue({ id: newMessageId(), text: trimmed, context, correctionOf: turn.id, correctionReference, attachments: turn.attachments });
    sendPending(id);
  };

  if (workspaceShell) {
    const name = data?.name ?? "Workbot";
    const docked = browserChat && wideScreen && tab === "computer";
    const busy = data?.status === "busy" || pending.some(entry => !entry.failed);
    const empty = !loading && !data?.turns.length && !pending.length;
    const starting = empty && (start.isPending || greetingAwaited);
    const conversation = data || loading ? <Conversation position={position} watcherIds={watcherIds}
      turns={data?.turns ?? []} loading={loading}
      canChange={!busy} onEdit={editTurn} editErrors={editErrors} pending={pending} live={stream.live}
      hasEarlier={data?.hasEarlier ?? false} earlierLimit={turnWindow >= MAX_TURNS && !thread.isPlaceholderData} loadingEarlier={thread.isFetching && thread.isPlaceholderData}
      onLoadEarlier={() => setTurnWindow(earlierWindow)}
      onRetry={entry => submit(entry.text, entry)}
      onRetryTurn={turn => {
        if (turn.greeting) { setGreetingAwaited(true); start.mutate(); return; }
        for (const receipt of turn.navigation) followed.current.add(receipt.id);
        if (turn.teaching) followed.current.add(turn.teaching.id);
        sentFrom.current.set(turn.id, viewRef.current);
        retry.mutate(turn.id, { onSuccess: () => setEditErrors(current => { const next = { ...current }; delete next[turn.id]; return next; }), onError: error => setEditErrors(current => ({ ...current, [turn.id]: error })) });
      }}
      onSuggestion={text => submit(text)} onSwitch={text => submit(text, undefined, false, true)} starting={starting} intro={null}
    /> : null;
    const pageTitle = tab === "documents" ? "Documents" : tab === "calendar" ? "Calendar" : tab === "devices" ? "Devices" : tab === "computer" ? computerTabLabel(host) : undefined;
    const askable = tab === "documents" && documentContext?.kind === "document" && shares(documentContext) ? documentContext : null;
    const askAbout = askable ? () => {
      setAskContext(askable);
      setIncludeContext(true);
      setTab("home");
      requestAnimationFrame(() => requestAnimationFrame(focusComposer));
    } : null;
    const attached = askContext && !browserPreview?.visible ? <AttachedContext context={askContext} onRemove={() => setAskContext(null)} /> : null;
    const composer = <>{approvalCards}<DraftComposer state={composerState} teaching={teaching} name={name} busy={busy} stopping={stop.isPending} filesEnabled={filesEnabled}
      onSend={text => submit(text)} onStop={() => stop.mutate()} autoFocus={false} disabled={!data && !loading} /></>;
    const firstName = user?.name?.trim().split(/\s+/)[0] ?? null;
    const home = !data && !loading ? <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 text-center text-[13px] text-[var(--wb-muted)]" role="status"><p>Couldn't load your conversation.</p><button type="button" className="rounded-lg px-3 py-2 underline focus-visible:shadow-[var(--wb-focus)]" onClick={() => void thread.refetch()}>Try again</button></div>
      : welcome === "showing" ? <Welcome name={name} firstName={firstName} onBegin={() => { if (start.isIdle) { setGreetingAwaited(true); start.mutate(); } }} onDone={() => setWelcome("done")} />
      : data && empty && side ? <SideChatStart name={name} organizationName={data.organizationName}>{attached}{composer}</SideChatStart>
      : data && empty && !starting ? <FirstOpen name={name} organizationName={data.organizationName} firstName={firstName} onSuggestion={text => submit(text)} error={start.isError ? start.error instanceof WorkbotSendError && start.error.accessReason ? <AccessRecovery reason={start.error.accessReason} onRetry={() => { setGreetingAwaited(true); start.mutate(); }} /> : <ErrorLine action={{ label: "Try again", onClick: () => { setGreetingAwaited(true); start.mutate(); } }}>{HELLO_FAILED}</ErrorLine> : null}>{attached}{composer}</FirstOpen>
      : <>{conversation}<div ref={chrome.bottom} className="workbot-chrome-bottom absolute inset-x-0 bottom-0 z-20 flex justify-center px-3" data-workbot-floating-composer><FloatingGlass edge="bottom" /><div className={column()}>{attached}{composer}</div></div></>;
    const floating = tab === "home" && Boolean(data || loading) && welcome !== "showing" && !(data && empty && (side || !starting));
    return <>
      <OpenDocumentContext.Provider value={tab === "documents" && documentContext?.kind === "document" ? documentContext.fileId : null}>
      <WorkspaceNavigationContext.Provider value={host.workspaceAssistant && host.documents ? navigateFromChat : null}>
      <ComputerNavigationContext.Provider value={navigateComputerFromChat}>
      <TeachingNavigationContext.Provider value={openTeaching}>
      <ComputerOnScreenContext.Provider value={tab === "computer" ? computerView : null}>
      <DocumentNavigationContext.Provider value={guided && host.documents ? { status: navigationStatus, open: followNavigation } : null}>
        {layout(<div ref={chrome.frame} className="relative flex min-h-0 flex-1 flex-col" data-workbot-workspace>
          <WorkbotHeader floating={floating ? chrome.top : undefined} name={name} organizationName={data?.organizationName ?? ""} userName={user?.name ?? null} answered={hasAnsweredTurn(data?.turns)} activity={activity} wide={wideScreen}

            chats={mobileNavigation} search={!showDesktopNavigation ? palette : null}
            page={pageTitle} action={askAbout ? <AskWorkbotButton name={name} onClick={askAbout} /> : null}
            remove={navigation?.chat && data && data.turns.length > 0 ? <RemoveChatButton disabled={documentsDirty} chatId={navigation.chat} title={navigation.title} onRemoved={() => { composerState.dispose(); navigation.openChat(null); }} /> : null}
            title={navigation?.chat ? <SideChatTitle title={navigation.title} disabled={documentsDirty} onBack={() => navigation.openChat(null)} /> : undefined}
          />
          <div className="flex min-h-0 min-w-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" style={{ display: tab === "home" ? undefined : "none" }} hidden={tab !== "home"}>{home}</div>
          <div className="flex min-h-0 min-w-0 flex-1 border-t border-[var(--wb-hairline)]" style={{ display: tab === "documents" ? undefined : "none" }} hidden={tab !== "documents"}>
            {(documentsVisited || tab === "documents") && <WorkbotDocuments onDirtyChange={reportDocumentDirty} onContextChange={setDocumentContext} openDocument={openDocument} onOpenSettled={settleNavigation} />}
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 border-t border-[var(--wb-hairline)]" style={{ display: tab === "calendar" ? undefined : "none" }} hidden={tab !== "calendar"}>
            {host.calendar && (calendarVisited || tab === "calendar") && <WorkbotCalendar connectionsHref={host.connectionsHref ?? null} assistantName={name} onContextChange={setCalendarContext} />}
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 border-t border-[var(--wb-hairline)]" style={{ display: tab === "devices" ? undefined : "none" }} hidden={tab !== "devices"}>
            {tab === "devices" && <WorkbotDevices computerFor={computerFor} />}
          </div>
          <div className="flex min-h-0 min-w-0 flex-1" style={{ display: tab === "computer" ? undefined : "none" }} hidden={tab !== "computer"}>
            {computerVisited && tab === "computer" && !browserPreview?.visible && computerViews(host).length > 0 && <WorkbotComputer key={`${host.identity?.organizationId}:${host.identity?.principalId}`} onTeachingChange={setTeaching} onRun={text => submit(text, undefined, true)} canTeach={!side} teachRequest={teachRequest} onTeachRequestSettled={settleTeachRequest} onViewChange={setComputerView} onContextChange={setBrowserContext} />}
            {docked && <DockedChat name={name} context={currentContext} includeContext={includeContext} onIncludeContext={setIncludeContext} composer={composer} conversation={conversation} unavailable={!data && !loading} />}
          </div>
          </div>
          </div>
          {filesEnabled && <FilesPanel open={filesOpen} onClose={() => setFilesOpen(false)} assistantName={name} onOpenFile={file => { setFilesOpen(false); openFile(file); }} />}
        </div>, floating)}
      </DocumentNavigationContext.Provider>
      </ComputerOnScreenContext.Provider>
      </TeachingNavigationContext.Provider>
      </ComputerNavigationContext.Provider>
      </WorkspaceNavigationContext.Provider>
      </OpenDocumentContext.Provider>
    </>;
  }
  if ((tab === "calendar" && host.calendar) || tab === "documents" || (tab === "devices") || (tab === "computer" && computerViews(host).length > 0)) {
    return layout(
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkbotHeader
          name={data?.name ?? "Workbot"}
          organizationName={data?.organizationName ?? ""}
          userName={user?.name ?? null}

          chats={mobileNavigation} search={!showDesktopNavigation ? palette : null}
          page={tab === "documents" ? "Documents" : tab === "calendar" ? "Calendar" : tab === "devices" ? "Devices" : computerTabLabel(host)}
          answered={hasAnsweredTurn(data?.turns)}
          activity={activity}
        />
        {leavingDocuments && <div className="border-t border-[var(--wb-hairline)] px-4 py-2 text-[13px]" role="status">You have unsaved document edits. <button type="button" className="ml-3 underline" onClick={() => setLeavingDocuments(null)}>Keep editing</button><button type="button" className="ml-3 underline" onClick={() => { const next = leavingDocuments; setLeavingDocuments(null); setDocumentsDirty(false); setTab(next, true); }}>Discard edits and leave Documents</button></div>}
        <div className="flex min-h-0 flex-1 border-t border-[#01162712]">
          {tab === "computer" ? <WorkbotComputer key={`${host.identity?.organizationId}:${host.identity?.principalId}`} onTeachingChange={setTeaching} onRun={text => submit(text, undefined, true)} canTeach={!side} teachRequest={teachRequest} onTeachRequestSettled={settleTeachRequest} /> : tab === "documents" ? <WorkbotDocuments onDirtyChange={setDocumentsDirty} /> : tab === "devices" ? <WorkbotDevices computerFor={computerFor} /> : <WorkbotCalendar connectionsHref={host.connectionsHref ?? null} assistantName={data?.name ?? "Workbot"} />}
        </div>
      </div>
    );
  }
  if (!loading && thread.isError && !thread.data) {
    return (
      <Centered>
        <p className="text-[14px] text-[var(--wb-text)]">Couldn&apos;t load your conversation.</p>
        <button type="button" onClick={() => void thread.refetch()} className="mt-3 rounded-full px-3 py-1.5 text-[13px] font-medium text-[var(--wb-text)] hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
          Try again
        </button>
      </Centered>
    );
  }
  if (!loading && !data) {
    const notEnabled = thread.data?.available === false && thread.data.reason === "workbot_not_enabled";
    return (
      <Centered>
        <Lock size={16} strokeWidth={1.5} className="text-[var(--wb-muted)]" aria-hidden />
        <p className="mt-3 text-[14px] text-[var(--wb-text)]">{notEnabled ? "Workbot isn't on for your organization yet." : "Workbot is unavailable right now."}</p>
        <p className="mt-1 text-[13px] text-[var(--wb-muted)]">{notEnabled ? "An admin can turn it on." : "Try again in a few minutes."}</p>
      </Centered>
    );
  }

  const shown = data ?? LOADING_THREAD;
  const busy = shown.status === "busy" || pending.some((entry) => !entry.failed);
  const empty = !loading && shown.turns.length === 0 && pending.length === 0;
  const firstName = user?.name?.trim().split(/\s+/)[0] ?? null;
  if (!loading && (welcome === "showing" || (welcome === "pending" && pending.length === 0 && needsWelcome(shown.turns)))) {
    return (
      <Welcome
        name={shown.name}
        firstName={firstName}
        onBegin={() => {
          if (start.isIdle) {
            setGreetingAwaited(true);
            start.mutate();
          }
        }}
        onDone={() => setWelcome("done")}
      />
    );
  }
  const starting = empty && (start.isPending || (greetingAwaited && start.data?.started === true));
  const composer = (<>
    {approvalCards}
    <DraftComposer
      state={composerState}
      name={shown.name}
      busy={busy}
      stopping={stop.isPending}
      filesEnabled={filesEnabled}
      onSend={(text) => submit(text)}
      onStop={() => stop.mutate()}
    />
  </>);

  const chatId = navigation?.chat ?? null;
  const floating = !(empty && (side || !starting));
  return (
    <>
    {layout(<div ref={chrome.frame} className="relative flex min-h-0 flex-1 flex-col">
      <WorkbotHeader
        floating={floating ? chrome.top : undefined}
        name={shown.name}
        organizationName={shown.organizationName}
        userName={user?.name ?? null}

        chats={mobileNavigation} search={!showDesktopNavigation ? palette : null}
        title={navigation && chatId ? <SideChatTitle title={navigation.title} onBack={() => navigation.openChat(null)} /> : null}
        remove={navigation && chatId && shown.turns.length > 0 ? <RemoveChatButton chatId={chatId} title={navigation.title} onRemoved={() => { composerState.dispose(); navigation.openChat(null); }} /> : null}
        answered={hasAnsweredTurn(shown.turns)}
        activity={activity}
        wide={wideScreen}
      />
      <div className="flex min-h-0 flex-1">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {empty && side ? (
        <SideChatStart name={shown.name} organizationName={shown.organizationName}>{composer}</SideChatStart>
      ) : empty && !starting ? (
        <FirstOpen
          name={shown.name}
          organizationName={shown.organizationName}
          firstName={firstName}
          onSuggestion={(text) => submit(text)}
          error={start.isError ? start.error instanceof WorkbotSendError && start.error.accessReason ? <AccessRecovery reason={start.error.accessReason} onRetry={() => { setGreetingAwaited(true); start.mutate(); }} /> : <ErrorLine action={{ label: "Try again", onClick: () => { setGreetingAwaited(true); start.mutate(); } }}>{HELLO_FAILED}</ErrorLine> : null}
        >
          {composer}
        </FirstOpen>
      ) : (
        <>
          <Conversation position={position} watcherIds={watcherIds}
            turns={shown.turns}
            loading={loading}
            canChange={!busy}
            onEdit={editTurn}
            editErrors={editErrors}
            pending={pending}
            live={stream.live}
            hasEarlier={shown.hasEarlier}
            earlierLimit={turnWindow >= MAX_TURNS && !thread.isPlaceholderData}
            loadingEarlier={thread.isFetching && thread.isPlaceholderData}
            onLoadEarlier={() => setTurnWindow(earlierWindow)}
            onRetry={(entry) => submit(entry.text, entry)}
            onRetryTurn={(turn) => {
              if (turn.greeting) {
                setGreetingAwaited(true);
                start.mutate();
                return;
              }
              retry.mutate(turn.id, { onSuccess: () => setEditErrors(current => { const next = { ...current }; delete next[turn.id]; return next; }), onError: (error) => setEditErrors((current) => ({ ...current, [turn.id]: error })) });
            }}
            onSuggestion={(text) => submit(text)}
            onSwitch={(text) => submit(text, undefined, false, true)}
            starting={starting}
            intro={
              loading || shown.hasEarlier
                ? null
                : (() => {
                    const hello = shown.turns[0];
                    const at = hello?.sentAt ?? pending[0]?.sentAt ?? Date.now();
                    const helloFailed = hello?.greeting === true && hello.status === "failed" && !hello.parts.some((part) => part.kind === "text");
                    const followed = starting || (hello?.greeting === true && !helloFailed);
                    const spoken = side;
                    return { at: spoken ? 0 : at, joined: helloFailed, node: <Intro name={shown.name} organizationName={shown.organizationName} firstName={firstName} at={at} spoken={spoken} followed={followed} /> };
                  })()
            }
          />
          <div ref={chrome.bottom} className="workbot-chrome-bottom absolute inset-x-0 bottom-0 z-20 flex justify-center px-3 sm:px-10" data-workbot-floating-composer>
            <FloatingGlass edge="bottom" />
            <div className={column()}>
              {composer}
            </div>
          </div>
        </>
      )}
      </div>
      </div>
      {filesEnabled ? (
        <FilesPanel
          open={filesOpen}
          onClose={() => setFilesOpen(false)}
          assistantName={shown.name}
          onOpenFile={(file) => {
            setFilesOpen(false);
            openFile(file);
          }}
        />
      ) : null}
      {dragging ? (
        <div className="pointer-events-none fixed inset-3 z-40 grid place-items-center rounded-[28px] border-2 border-dashed border-[var(--wb-disabled)] bg-[var(--wb-bg)]/85">
          <p className="flex items-center gap-2 text-[14px] font-medium text-[var(--wb-text)]"><FileText size={16} strokeWidth={1.75} aria-hidden />Drop to add to your message</p>
        </div>
      ) : null}
    </div>, floating)}
    </>
  );
}

const WELCOMED_KEY = "workbot.welcomed";

function rememberWelcomed(helloAt: number) {
  try {
    window.localStorage.setItem(WELCOMED_KEY, String(helloAt));
  } catch {
  }
}

function needsWelcome(turns: WorkbotTurn[]) {
  if (turns.some((turn) => !turn.greeting)) return false;
  const hello = turns[0];
  if (!hello?.sentAt) return true;
  try {
    return window.localStorage.getItem(WELCOMED_KEY) !== String(hello.sentAt);
  } catch {
    return true;
  }
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="workbot flex h-dvh flex-col items-center justify-center bg-[var(--wb-bg)] px-6 text-center">{children}</div>;
}

const LOADING_THREAD: Extract<WorkbotThread, { available: true }> = { available: true, name: "Workbot", organizationName: "", status: "idle", turns: [], hasEarlier: false, filesEnabled: false };

function ThreadPlaceholder() {
  if (calmChat()) return (
    <div className="flex flex-col gap-[3px] pb-8" role="progressbar" aria-busy="true" aria-label="Loading conversation">
      <span className="ml-auto h-[41px] w-48 rounded-2xl bg-[var(--wb-user-bubble)]" />
      <span className="mt-6 h-3.5 w-[70%] rounded bg-[var(--wb-chip)]" />
      <span className="mt-2 h-3.5 w-[58%] rounded bg-[var(--wb-chip)]" />
      <span className="mt-2 h-3.5 w-[40%] rounded bg-[var(--wb-chip)]" />
    </div>
  );
  return (
    <div className="flex flex-col gap-[3px] pb-8" role="progressbar" aria-busy="true" aria-label="Loading conversation">
      <span className="ml-auto h-[38px] w-48 rounded-[20px] rounded-br-md bg-[var(--wb-bubble)]" />
      <span className="mt-3.5 h-6 w-40 rounded bg-[var(--wb-chip)]" />
      <span className="mt-1.5 h-24 w-[70%] rounded-[20px] rounded-bl-md bg-[var(--wb-surface)] shadow-[var(--wb-assistant-shadow)]" />
    </div>
  );
}

function Mark({ size }: { name: string; size: "header" | "hero" }) {
  return (
    <OpenWorkMark width={size === "hero" ? 36 : 16} height={size === "hero" ? 45 : 20} className="shrink-0" />
  );
}

function useConnectedApps() {
  return workbotHost().useConnectedApps();
}

type WorkbotTab = WorkbotPaletteTab;

function paletteTabs(host: WorkbotHost): WorkbotTab[] {
  return ["home", ...(host.calendar ? ["calendar" as const] : []), ...(host.documents ? ["documents" as const] : []), "devices"];
}

function focusComposer() {
  for (const box of document.querySelectorAll<HTMLTextAreaElement>("[data-workbot-composer] textarea")) {
    if (box.offsetParent !== null && !box.disabled) { box.focus(); return; }
  }
}

function showTask(taskId: string) {
  const card = document.querySelector<HTMLElement>(`[data-workbot-task="${CSS.escape(taskId)}"]`);
  if (!card) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  card.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  card.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
}

function tabFromLocation(): WorkbotTab {
  const path = typeof window !== "undefined" ? window.location.pathname.replace(/\/+$/, "") : "";
  return path === "/computer" || path === "/browser" || path.startsWith("/browser/") ? "computer" : path === "/documents" ? "documents" : path === "/calendar" ? "calendar" : path === "/devices" ? "devices" : "home";
}

function pagePath(page: WorkbotTab) {
  return page === "home" ? "/" : page === "computer" ? `/${computerViews(workbotHost())[0] ?? "browser"}` : `/${page}`;
}

function useWorkbotTab(beforeLeave?: (next: WorkbotTab) => boolean, preserveSearch = false) {
  const beforeLeaveRef = useRef(beforeLeave);
  beforeLeaveRef.current = beforeLeave;
  const [tab, setTabState] = useState<WorkbotTab>(tabFromLocation);
  const computerEnabled = computerViews(workbotHost()).length > 0;
  useEffect(() => {
    if (!computerEnabled && tab === "computer") { window.history.replaceState(null, "", `/${preserveSearch ? window.location.search : ""}`); setTabState("home"); }
  }, [computerEnabled, tab, preserveSearch]);
  useEffect(() => {
    const sync = () => {
      const next = tabFromLocation();
      if (beforeLeaveRef.current?.(next) === false) { window.history.pushState(null, "", "/documents"); return; }
      setTabState(next);
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const setTab = (next: WorkbotTab, discard = false) => {
    if (next === tab) return;
    if (!discard && beforeLeaveRef.current?.(next) === false) return;
    window.history.pushState(null, "", `${pagePath(next)}${preserveSearch ? window.location.search : ""}`);
    setTabState(next);
  };
  return [tab, setTab] as const;
}

function WorkbotHeader(props: {
  name: string;
  organizationName: string;
  userName: string | null;
  chats?: ReactNode;
  title?: ReactNode;
  remove?: ReactNode;
  nav?: ReactNode;
  answered?: boolean;
  search?: ReactNode;
  activity: WorkbotActivity;
  page?: string;
  action?: ReactNode;
  wide?: boolean;
  floating?: (node: HTMLElement | null) => void;
}) {
  const { name } = props;
  if (props.page) return (
    <header className="flex h-14 shrink-0 items-center gap-1 px-3 sm:px-5" data-workbot-page-header>
      {props.chats}{props.search}
      <h1 className="min-w-0 flex-1 truncate px-1 text-[15px] font-semibold leading-5 text-[var(--wb-text)]">{props.page}</h1>
      {props.action}
    </header>
  );
  const phone = props.wide === false;
  const calm = calmChat();
  const short = phone || calm;
  return (
    <header ref={props.floating} className={`grid shrink-0 ${calm ? "grid-cols-[1fr_minmax(0,auto)_1fr]" : "grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"} gap-2 px-3 sm:px-5 ${short ? "min-h-14 items-center py-1.5" : "min-h-[84px] items-start pb-2 pt-2"} ${props.floating ? "workbot-chrome-top absolute inset-x-0 top-0 z-20" : ""}`} data-workbot-profile-header data-workbot-floating-header={props.floating ? "" : undefined}>
      {props.floating ? <FloatingGlass edge="top" /> : null}
      <div className={`flex min-w-0 items-center ${props.floating ? "gap-2" : "gap-1"} ${short ? "" : "pt-2"}`} data-workbot-header-side>
        {props.chats}{props.search}
        <div className="hidden min-w-0 lg:contents">{props.nav}</div>
      </div>
      <div className="flex min-w-0 flex-col items-center gap-1">
        <h1 className="min-w-0 max-w-full">{phone && !calm ? <WorkingName name={name} activity={props.activity} mark={null} phone /> : <ProfileBadge name={name} activity={props.activity} />}</h1>
        {props.title ? <div className="flex max-w-[150px] items-center gap-1 text-[12px]">{props.title}</div> : null}
      </div>
      <div className={`flex min-w-0 items-center justify-end gap-1 sm:gap-2.5 ${short ? "" : "pt-2"}`} data-workbot-header-side>
        {props.remove}
        <div className="hidden sm:contents"><WorkbotSetupChip answered={props.answered === true} /></div>
      </div>
    </header>
  );
}

function AskWorkbotButton({ name, onClick }: { name: string; onClick(): void }) {
  return <button type="button" onClick={onClick} data-workbot-ask
    className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-[var(--wb-ink)] px-3.5 text-[13px] font-medium text-[var(--wb-on-ink)] transition-opacity duration-150 hover:opacity-90 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
    <MessageCircle size={15} strokeWidth={1.75} aria-hidden />Ask {name}
  </button>;
}

function AttachedContext({ context, onRemove }: { context: WorkbotViewContext; onRemove(): void }) {
  const label = workbotContextLabel(context);
  return <div className="mb-2 flex min-w-0" data-workbot-attached-context>
    <span className="flex h-7 min-w-0 items-center gap-1.5 rounded-full bg-[var(--wb-chip)] pl-2.5 pr-1 text-[12px] text-[var(--wb-text)]" title={`${label}: Workbot reads it with your next message and can't change it from that message.`}>
      <FileText size={13} strokeWidth={1.75} aria-hidden className="shrink-0 text-[var(--wb-muted)]" />
      <span className="truncate" data-testid="workbot-attached-context">{label}<span className="text-[var(--wb-muted)]"> · Read-only{context.kind === "document" && context.unsaved ? " · Unsaved edits excluded" : ""}</span></span>
      <button type="button" onClick={onRemove} aria-label={`Remove ${label}`} className="grid size-5 shrink-0 place-items-center rounded-full text-[var(--wb-muted)] hover:bg-[var(--wb-surface)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"><X size={12} strokeWidth={1.75} aria-hidden /></button>
    </span>
  </div>;
}

function timestampLabel(at: number) {
  const date = new Date(at);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return `Today ${time}`;
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  if (today.getTime() - date.getTime() < 6 * 86_400_000) return `${date.toLocaleDateString("en-US", { weekday: "long" })} ${time}`;
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

function Timestamp({ at }: { at: number }) {
  return (
    <div className="flex justify-center pb-3">
      <span className="text-[12px] font-medium leading-4 text-[var(--wb-muted)]">{timestampLabel(at)}</span>
    </div>
  );
}

function Intro(props: { name: string; organizationName: string; firstName: string | null; at: number; spoken?: boolean; followed?: boolean }) {
  const apps = useConnectedApps().map((app) => app.name);
  const seeing = apps.length === 0 ? null : apps.length === 1 ? apps[0] : `${apps.slice(0, -1).join(", ")} and ${apps.at(-1)}`;
  const hour = new Date(props.at).getHours();
  const hello = hour < 12 ? "Morning" : hour < 18 ? "Hi" : "Evening";
  const wide = useWideScreen();
  const calm = calmChat();
  return (
    <>
      {wide ? <WhoYouAreTalkingTo name={props.name} organizationName={props.organizationName} /> : null}
      {props.spoken ? null : (
        <div className="flex flex-col gap-[3px]">
          <Timestamp at={props.at} />
          <div className="flex">
            <p className={`max-w-[520px] rounded-bl-md rounded-[20px] bg-[var(--wb-surface)] px-4 py-2.5 ${calm ? CALM_TEXT : "text-[15px] leading-[22px]"} text-[var(--wb-text)] shadow-[var(--wb-assistant-shadow)]`}>
              {hello}{props.firstName ? ` ${props.firstName}` : ""}.{seeing ? ` I can already see your ${seeing}.` : ""}
            </p>
          </div>
          {props.followed ? null : (
            <div className="flex">
              <p className={`max-w-[520px] rounded-tl-md rounded-[20px] bg-[var(--wb-surface)] px-4 py-2.5 ${calm ? CALM_TEXT : "text-[15px] leading-[22px]"} text-[var(--wb-text)] shadow-[var(--wb-assistant-shadow)]`}>
                What can I take off your plate today?
              </p>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function FirstOpen(props: { name: string; organizationName: string; firstName: string | null; onSuggestion: (text: string) => void; error?: ReactNode; children: ReactNode }) {
  const apps = useConnectedApps().map((app) => app.name);
  const has = (pattern: RegExp) => apps.find((app) => pattern.test(app)) ?? null;
  const slack = has(/slack/i);
  const mail = has(/gmail|mail|outlook/i);
  const calendar = has(/calendar/i);
  const suggestions = [
    { text: slack ? "Catch me up on Slack" : "Catch me up on what I missed", app: slack },
    { text: "Emails that need a reply", app: mail },
    { text: "Plan my day", app: calendar },
  ];
  const [now] = useState(() => Date.now());
  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto px-4 pb-18 sm:px-10">
      <div className={`${column()} flex flex-col gap-1`}>
        <Intro name={props.name} organizationName={props.organizationName} firstName={props.firstName} at={now} />
        {props.error}
        <ul className="flex flex-wrap gap-2 py-[18px]">
          {suggestions.map((suggestion) => (
            <li key={suggestion.text}>
              <button
                type="button"
                onClick={() => props.onSuggestion(suggestion.text)}
                className="flex h-[34px] items-center gap-2 rounded-full bg-[var(--wb-surface)] pl-3 pr-3.5 text-[13px] leading-4 text-[var(--wb-text)] shadow-[0_0_0_1px_var(--wb-ring)] transition-shadow duration-150 hover:shadow-[0_0_0_1px_var(--wb-disabled)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
              >
                {suggestion.app ? <AppMark name={suggestion.app} size={13} /> : null}
                {suggestion.text}
              </button>
            </li>
          ))}
        </ul>
        {props.children}
      </div>
    </div>
  );
}

function WhoYouAreTalkingTo(props: { name: string; organizationName: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 pb-7">
      <Mark name={props.name} size="hero" />
      <span className="pt-1 text-[15px] font-semibold leading-[18px] text-[var(--wb-text)]">{props.name}</span>
      <span className="text-[12px] leading-4 text-[var(--wb-muted)]">Set up by {props.organizationName}</span>
    </div>
  );
}

function SideChatStart(props: { name: string; organizationName: string; children: ReactNode }) {
  const wide = useWideScreen();
  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto px-4 pb-18 sm:px-10">
      <div className={`${column()} flex flex-col gap-1`}>
        {wide ? <WhoYouAreTalkingTo name={props.name} organizationName={props.organizationName} /> : null}
        {props.children}
      </div>
    </div>
  );
}

type Row = { key: string; at: number; turn: WorkbotTurn; pending: Pending | null };

function showsTimestamp(previous: { at: number } | undefined, row: { at: number }) {
  if (!row.at) return false;
  if (!previous?.at) return true;
  return new Date(previous.at).toDateString() !== new Date(row.at).toDateString() || row.at - previous.at > 60 * 60_000;
}

function Conversation(props: {
  position: ConversationScrollState;
  watcherIds: ReadonlySet<string>;
  turns: WorkbotTurn[];
  loading?: boolean;
  pending: Pending[];
  live: WorkbotLiveStore;
  hasEarlier: boolean;
  earlierLimit: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  onRetry: (entry: Pending) => void;
  onRetryTurn: (turn: WorkbotTurn) => void;
  intro: { at: number; joined: boolean; node: ReactNode } | null;
  onSuggestion: (text: string) => void;
  onSwitch: (text: string) => void;
  starting: boolean;
  canChange: boolean;
  onEdit: (turn: WorkbotTurn, text: string) => void;
  editErrors: Readonly<Record<string, Error | string>>;
}) {
  const { scroller, content, far, latest, readEarlier } = useConversationScroll(props.position, props.pending);
  const known = useMemo(() => new Set(props.turns.map((turn) => turn.id)), [props.turns]);
  const rows: Row[] = useMemo(() => [
    ...props.turns.map((turn) => ({ key: turn.id, at: turn.sentAt ?? 0, turn, pending: null })),
    ...props.pending.filter((entry) => !known.has(entry.id)).map((entry) => ({ key: entry.id, at: entry.sentAt, turn: pendingTurn(entry), pending: entry })),
  ], [props.turns, props.pending, known]);
  const handlers = useRef(props);
  handlers.current = props;
  const onEdit = useCallback((turn: WorkbotTurn, text: string) => handlers.current.onEdit(turn, text), []);
  const onRetry = useCallback((turn: WorkbotTurn, pending: Pending | null) => (pending ? handlers.current.onRetry(pending) : handlers.current.onRetryTurn(turn)), []);
  const onSuggestion = useCallback((text: string) => handlers.current.onSuggestion(text), []);
  const onSwitch = useCallback((text: string) => handlers.current.onSwitch(text), []);
  const lastTurnId = props.turns.at(-1)?.id;
  const typing = useSettled(props.starting, 350);
  const unsent = props.pending.filter((entry) => !known.has(entry.id) && !entry.failed);
  const lastPending = unsent.at(-1)?.id ?? null;
  const readNewestText = () => [...props.turns].reverse().find((turn) => turn.parts.some((part) => part.kind === "text") || Boolean(props.live.get()[turn.id]?.text))?.id ?? null;
  const newestText = useSyncExternalStore(props.live.subscribe, readNewestText, readNewestText);
  const localUrls = useMemo(() => {
    const urls: Record<string, string | null> = {};
    for (const entry of props.pending) for (const upload of entry.uploads) if (upload.saved) urls[upload.saved.id] = upload.previewUrl;
    return urls;
  }, [props.pending]);
  const previews = useRef<Record<string, string | null>>({});
  Object.assign(previews.current, localUrls);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-workbot-conversation>
    <div
      ref={scroller}
      className="workbot-scroll min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
    >
      <div ref={content} className="workbot-scroll-content flex min-h-full flex-col items-center justify-end px-4 sm:px-10">
        <div className={`${column()} flex flex-col`}>
          {props.loading ? <ThreadPlaceholder /> : props.hasEarlier && props.earlierLimit ? (
            <p className="mb-6 text-center text-[12px] text-[var(--wb-muted)]" role="status">History limit reached. Earlier messages aren&apos;t available here.</p>
          ) : props.hasEarlier ? (
            <button
              type="button"
              onClick={() => {
                readEarlier();
                props.onLoadEarlier();
              }}
              disabled={props.loadingEarlier}
              className="mx-auto mb-6 rounded-full px-3 py-1 text-[12px] font-medium text-[var(--wb-muted)] hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
            >
              {props.loadingEarlier ? "Loading earlier messages" : "Show earlier messages"}
            </button>
          ) : null}
          {props.intro ? <div className={`flex flex-col gap-1 ${props.intro.joined ? "" : "pb-8"}`}>{props.intro.node}</div> : null}
          <ol className="flex flex-col" aria-label="Conversation">
            {rows.map((row, index) => {
              const previous = rows[index - 1] ?? (props.intro?.at ? { at: props.intro.at } : undefined);
              const stamp = showsTimestamp(previous, row);
              return (
                <li key={row.key} data-workbot-row={row.key} className={`flex flex-col gap-1 ${index > 0 ? (stamp ? "pt-9" : "pt-8") : stamp && props.intro ? "pt-1" : ""}`}>
                  {stamp ? <Timestamp at={row.at} /> : null}
                  <TurnView host={workbotHost()} watcherIds={props.watcherIds}
                    canChange={props.canChange}
                    onEdit={onEdit}
                    editError={row.pending ? null : (props.editErrors[row.turn.id] ?? null)}
                    turn={row.turn}
                    pending={row.pending}
                    live={props.live}
                    latest={row.pending ? row.pending.id === lastPending : row.turn.id === lastTurnId && props.pending.every((entry) => known.has(entry.id))}
                    newestText={row.turn.id === newestText}
                    previews={previews.current}
                    onRetry={onRetry}
                    onSuggestion={onSuggestion}
                    onSwitch={onSwitch}
                  />
                </li>
              );
            })}
          </ol>
          {typing ? (
            <div className="flex flex-col gap-1">
              <Gap />
              <div className="flex flex-col">
                <WaitingSlot>
                  <TypingDots />
                </WaitingSlot>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
    <ScrollToBottom visible={far} onClick={latest} />
    </div>
  );
}

function ScrollToBottom({ visible, onClick }: { visible: boolean; onClick(): void }) {
  return <button type="button" aria-label="Scroll to latest message" title="Scroll to latest message"
    aria-hidden={!visible} tabIndex={visible ? 0 : -1} disabled={!visible} onClick={onClick}
    className={`workbot-scroll-latest absolute left-1/2 z-30 grid size-11 -translate-x-1/2 place-items-center rounded-full focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] ${visible ? "is-visible" : ""}`}>
    <span className="grid size-[34px] place-items-center rounded-full border border-[var(--wb-ring)] bg-[var(--wb-surface)] text-[var(--wb-text)]"><ChevronDown size={18} strokeWidth={1.5} aria-hidden /></span>
  </button>;
}

function Reaction({ emoji }: { emoji: string }) {
  return (
    <span
      role="img"
      aria-label={`Reacted ${emoji}`}
      className="workbot-reaction workbot-emoji grid h-7 min-w-7 place-items-center rounded-full bg-[var(--wb-surface)] px-1 text-[15px] leading-none shadow-[var(--wb-card-shadow)]"
    >
      {emoji}
    </span>
  );
}

function UserBubble({ text, muted = false, reaction = null, action }: { text: string; muted?: boolean; reaction?: string | null; action?: ReactNode }) {
  const visible = readWorkbotCorrectionPrompt(text);
  if (!visible.text && !visible.correction) {
    return reaction ? (
      <div className="flex justify-end">
        <Reaction emoji={reaction} />
      </div>
    ) : null;
  }
  return (
    <div className="flex w-full justify-end">
      <div className="group/own relative max-w-[85%] sm:max-w-[480px]">
        {visible.correction && <div className="mb-1 px-3 text-[12px] text-[var(--wb-muted)]" data-workbot-correction-reference>
          <p>Correction to your message{visible.correction.sentAt !== null ? ` from ${new Date(visible.correction.sentAt).toLocaleString()}` : ""}</p>
          {visible.correction.quote && <blockquote className="line-clamp-3 border-l-2 border-[var(--wb-hairline)] pl-2" title={visible.correction.quote}>{visible.correction.quote}{visible.correction.quote.length === 1000 ? "…" : ""}</blockquote>}
        </div>}
        <p className={`whitespace-pre-wrap break-words bg-[var(--wb-user-bubble)] text-[var(--wb-text)] ${calmChat() ? `rounded-[20px] px-4 py-2.5 ${CALM_TEXT}` : "rounded-[20px] px-4 py-2.5 text-[15px] leading-[22px]"} transition-opacity duration-150 ${muted ? "opacity-60" : ""}`}>
          {visible.text}
        </p>
        {action ? <span className={ownAction}>{action}</span> : null}
        {reaction ? (
          <span className="absolute -left-3 -top-3.5">
            <Reaction emoji={reaction} />
          </span>
        ) : null}
      </div>
    </div>
  );
}

const iconButton =
  "grid size-7 place-items-center rounded-full text-[var(--wb-muted)] transition-colors duration-150 hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] disabled:opacity-40";

const ownAction =
  "absolute -left-8 top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover/own:opacity-100 has-[:focus-visible]:opacity-100 [@media(hover:none)]:static [@media(hover:none)]:mt-1 [@media(hover:none)]:flex [@media(hover:none)]:h-7 [@media(hover:none)]:translate-y-0 [@media(hover:none)]:items-center [@media(hover:none)]:justify-end [@media(hover:none)]:opacity-100";

function EditButton({ disabled, onClick }: { disabled: boolean; onClick?: () => void }) {
  return (
    <button type="button" aria-label="Correct message" title="Send a correction" disabled={disabled} onClick={onClick} className={`${iconButton} disabled:hover:bg-transparent disabled:hover:text-[var(--wb-muted)] [@media(hover:none)]:-my-2 [@media(hover:none)]:-mr-2 [@media(hover:none)]:size-11`}>
      <Pencil size={14} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

function OwnMessage(props: {
  turn: WorkbotTurn;
  canChange: boolean;
  onEdit: (turn: WorkbotTurn, text: string) => void;
  error: string | null;
  failed?: boolean;
}) {
  const { turn, error } = props;
  const originalText = readWorkbotCorrectionPrompt(turn.text).text;
  const [mode, setMode] = useState<"idle" | "editing">("idle");
  const [draft, setDraft] = useState(originalText);
  const field = useRef<HTMLTextAreaElement>(null);
  const touch = useTouchKeyboard();

  useLayoutEffect(() => {
    const element = field.current;
    if (mode !== "editing" || !element) return;
    fitTextarea(element, 240);
  }, [draft, mode]);
  useEffect(() => {
    if (mode !== "editing") return;
    const element = field.current;
    element?.focus();
    element?.setSelectionRange(element.value.length, element.value.length);
  }, [mode]);

  const save = () => {
    const text = draft.trim();
    if (!text) return;
    setMode("idle");
    if (text === originalText.trim()) return;
    props.onEdit(turn, text);
  };

  if (mode === "editing") {
    return (
      <div className="flex justify-end">
        <div className="flex w-full max-w-[85%] flex-col gap-2 sm:max-w-[480px]">
          <blockquote className="line-clamp-3 border-l-2 border-[var(--wb-hairline)] pl-2 text-[12px] text-[var(--wb-muted)]" title={originalText}>Correcting: {originalText}</blockquote>
          <textarea
            ref={field}
            value={draft}
            rows={1}
            aria-label="Correct your message"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft(originalText);
                setMode("idle");
              } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !touch) {
                event.preventDefault();
                save();
              }
            }}
            enterKeyHint={touch ? "enter" : "send"}
            className="w-full resize-none rounded-[20px] bg-[var(--wb-surface)] px-4 py-2.5 text-[15px] leading-[22px] text-[var(--wb-text)] shadow-[var(--wb-composer-shadow)] outline-none"
          />
          <p className="text-right text-[12px] text-[var(--wb-muted)]">Earlier messages stay in the conversation.</p>
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => {
                setDraft(originalText);
                setMode("idle");
              }}
              className="h-8 rounded-full px-3 text-[13px] font-medium text-[var(--wb-muted)] transition-colors duration-150 hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!draft.trim()}
              className="h-8 rounded-full bg-[var(--wb-ink)] px-3.5 text-[13px] font-medium text-[var(--wb-on-ink)] transition-opacity duration-150 hover:opacity-90 disabled:opacity-40 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
            >
              Send correction
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <SentContext context={turn.context} />
      <UserBubble text={turn.text} reaction={turn.reaction} muted={props.failed} action={props.failed ? undefined : <EditButton disabled={!props.canChange} onClick={() => setMode("editing")} />} />
      {error ? <ErrorLine align="end">{error}</ErrorLine> : null}
    </div>
  );
}

function CopyAnswer({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <div className="flex h-7 items-center pl-0.5 opacity-0 transition-opacity duration-150 group-hover/answer:opacity-100 group-focus-within/answer:opacity-100 [@media(hover:none)]:opacity-100">
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy answer"}
        title={copied ? "Copied" : "Copy"}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => undefined);
        }}
        className={iconButton}
      >
        {copied ? <Check size={14} strokeWidth={2} aria-hidden /> : <Copy size={14} strokeWidth={1.75} aria-hidden />}
      </button>
    </div>
  );
}

function AssistantBubble({ children, trailing = null }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex items-end gap-1 py-[3px]">
      <div className={`flex w-fit min-w-0 max-w-full flex-col overflow-x-auto rounded-[20px] rounded-bl-md bg-[var(--wb-surface)] px-4 py-2.5 shadow-[var(--wb-assistant-shadow)] sm:max-w-[600px]`} data-workbot-assistant-text>
        {children}
      </div>
      {trailing}
    </div>
  );
}

function WaitingSlot({ children }: { children?: ReactNode }) {
  return <div className="flex h-12.5 shrink-0 flex-col">{children}</div>;
}

function TypingDots() {
  return (
    <div className="workbot-row-enter flex py-[3px]" role="status" aria-label="Workbot is processing">
      <div className={`flex h-9 items-center gap-[5px] rounded-[20px] rounded-bl-md bg-[var(--wb-surface)] px-4 shadow-[var(--wb-assistant-shadow)]`}>
        <span aria-hidden className="workbot-typing-dot" />
        <span aria-hidden className="workbot-typing-dot" />
        <span aria-hidden className="workbot-typing-dot" />
      </div>
    </div>
  );
}

const HELLO_FAILED = "I couldn't check your day just now.";

function ErrorLine({ children, action = null, align = "start" }: { children: ReactNode; action?: { label: string; onClick: () => void } | null; align?: "start" | "end" }) {
  return (
    <div role="status" className={`workbot-row-enter flex min-h-7 items-center gap-1.5 pt-1 text-[13px] leading-4 text-[var(--wb-muted)] ${align === "end" ? "justify-end pr-1" : "pl-1"}`}>
      <CircleAlert size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-[var(--wb-danger)]" />
      <span>{children}</span>
      {action ? (
        <button type="button" onClick={action.onClick} className="-my-1 ml-0.5 h-7 shrink-0 rounded-full px-2.5 font-medium text-[var(--wb-text)] transition-colors duration-150 hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

const Gap = () => <span aria-hidden className="h-3.5 w-px shrink-0" />;

function pendingAttachments(entry: Pending): { attachments: WorkbotAttachment[]; urls: Record<string, string | null> } {
  const urls: Record<string, string | null> = {};
  const attachments = entry.uploads.map((upload) => {
    const id = upload.saved?.id ?? `local-${upload.key}`;
    urls[id] = upload.previewUrl;
    return { id, name: upload.file.name, mediaType: upload.file.type || "application/octet-stream", size: upload.file.size };
  });
  return { attachments: [...entry.attachments, ...attachments], urls };
}

function pendingTurn(entry: Pending): WorkbotTurn {
  return {
    id: entry.id,
    text: entry.correctionReference ? workbotCorrectionPrompt(readBrowserSkillRunPrompt(entry.text), entry.correctionReference) : readBrowserSkillRunPrompt(entry.text),
    context: entry.context,
    navigation: [],
    sentAt: entry.sentAt,
    finishedAt: null,
    status: "queued",
    attachments: pendingAttachments(entry).attachments,
    outputs: [],
    reaction: null,
    parts: [],
    modelSteps: 0,
    error: null,
    retryable: true,
    tasks: [],
    greeting: false,
    suggestions: [],
  };
}

function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = () => setNow(Date.now());
    const run = () => {
      clearInterval(timer);
      timer = document.visibilityState === "visible" ? setInterval(tick, 1_000) : undefined;
    };
    const shown = () => { if (document.visibilityState === "visible") tick(); run(); };
    run();
    document.addEventListener("visibilitychange", shown);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", shown); };
  }, [on]);
  return now;
}

function useTaskClock(turns: WorkbotTurn[] | undefined) {
  const [now, setNow] = useState(() => Date.now());
  const next = useMemo(() => (turns ? nextTaskQuietAt(turns, now) : null), [turns, now]);
  useEffect(() => {
    if (next === null) return;
    const timer = window.setTimeout(() => setNow(Math.max(Date.now(), next)), Math.max(0, next - Date.now()));
    return () => window.clearTimeout(timer);
  }, [next]);
  useEffect(() => {
    const shown = () => { if (document.visibilityState === "visible") setNow(Date.now()); };
    document.addEventListener("visibilitychange", shown);
    return () => document.removeEventListener("visibilitychange", shown);
  }, []);
  return now;
}

function WorkerGlyph({ working }: { working: boolean }) {
  return (
    <svg viewBox="0 0 28 28" width={28} height={28} fill="none" className={`workbot-worker ${working ? "is-working" : ""}`}>
      <path d="M2.5 21h23" stroke="var(--wb-computer-frame)" strokeWidth={1.25} strokeLinecap="round" />
      <rect x="14.5" y="12.25" width="10.5" height="7.5" rx="1.5" fill="var(--wb-computer-screen)" stroke="var(--wb-ink)" strokeWidth={1.25} />
      <path d="M13 21h12.5" stroke="var(--wb-ink)" strokeWidth={1.5} strokeLinecap="round" />
      <path className="workbot-worker-line" d="M17 15h4" stroke="var(--wb-computer-line-live)" strokeWidth={1.25} strokeLinecap="round" />
      <path className="workbot-worker-line" d="M17 17.3h5.5" stroke="var(--wb-computer-line-live)" strokeWidth={1.25} strokeLinecap="round" />
      <path d="M4.5 21v-4.2a3.3 3.3 0 0 1 3.3-3.3h0.4a3.3 3.3 0 0 1 3.3 3.3v4.2" fill="var(--wb-ink)" />
      <g className="workbot-worker-head">
        <circle cx="8" cy="9.6" r="2.6" fill="var(--wb-ink)" />
      </g>
      <g className="workbot-worker-arm">
        <path d="M10.2 16.8l3.6 2.5" stroke="var(--wb-ink)" strokeWidth={1.6} strokeLinecap="round" />
      </g>
    </svg>
  );
}

function QuietLine({ label }: { label: string }) {
  return (
    <p className="flex h-6 shrink-0 items-center pl-1 text-[13px] leading-4 text-[var(--wb-faint)]" role="status" aria-live="polite">
      {label}
    </p>
  );
}

function useSmoothText(target: string, instant = false) {
  const [shown, setShown] = useState(() => (instant ? target.length : 0));
  const shownRef = useRef(instant ? target.length : 0);
  const previous = useRef(instant ? target : "");
  useEffect(() => {
    const goal = target.length;
    if (!target.startsWith(previous.current.slice(0, shownRef.current))) shownRef.current = 0;
    previous.current = target;
    if (instant || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      shownRef.current = goal;
      setShown(goal);
      return;
    }
    let frame = 0;
    const tick = () => {
      const current = shownRef.current;
      if (current >= goal) return;
      shownRef.current = Math.min(goal, current + Math.max(2, Math.ceil((goal - current) / 15)));
      setShown(shownRef.current);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, instant]);
  return instant ? target : target.slice(0, Math.min(shown, target.length));
}

function StreamingText({ text, instant = false }: { text: string; instant?: boolean }) {
  const shown = useSmoothText(text, instant);
  return (
    <div className="workbot-streaming min-h-6">
      <WorkbotMarkdown text={shown} />
    </div>
  );
}

type UsedApp = { key: string; name: string; computer: boolean };

function usedApps(steps: WorkbotStep[], starting: LiveText["working"] | null): UsedApp[] {
  const used: UsedApp[] = [];
  const add = (entry: UsedApp) => {
    if (!used.some((existing) => existing.key === entry.key)) used.push(entry);
  };
  for (const step of steps) {
    if (step.icon === "computer" && step.surface === "browser") add({ key: "browser", name: "the browser", computer: true });
    else if (step.icon === "computer") add({ key: "computer", name: "my computer", computer: true });
    else if (step.app) add({ key: step.app, name: step.app, computer: false });
  }
  if (starting?.on === "computer") add({ key: "computer", name: "my computer", computer: true });
  return used;
}

function joinNames(names: string[]) {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function useHeld<T>(value: T, key: string, minMs: number): T {
  const [shown, setShown] = useState({ key, value });
  const shownAt = useRef(Date.now());
  useEffect(() => {
    if (key === shown.key) return;
    const timer = window.setTimeout(() => {
      shownAt.current = Date.now();
      setShown({ key, value });
    }, Math.max(0, minMs - (Date.now() - shownAt.current)));
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, minMs, shown.key]);
  return shown.value;
}

const UPDATE_HOLD_MS = 1_600;

type SwitchTo = { label: string; text: string; send(text: string): void };

const ComputerOnScreenContext = createContext<Exclude<ComputerSurface, "background"> | null>(null);

function openSurface(surface: Exclude<ComputerSurface, "background">) {
  window.history.pushState(null, "", `/${surface}${window.location.search}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function openScreen(preview: ReturnType<typeof useBrowserPreview>, task: BrowserPreviewTask, surface: Exclude<ComputerSurface, "background">) {
  if (preview) preview.open(task, surface);
  else openSurface(surface);
}

function BrowserTaskCard({ turn, steps, working }: { turn: WorkbotTurn; steps: WorkbotStep[]; working: boolean }) {
  const preview = useBrowserPreview();
  const task = { id: turn.id, ...browserTask(steps, { working, title: turn.text.trim() || "Browser task", status: turn.status }) };
  const { status, title, reason } = task;
  const update = preview?.update;
  useEffect(() => { update?.(task); }, [update, task.id, task.title, task.status, task.reason]);
  const watchable = workbotHost().browser === true;
  const statusLine = <>{status === "working" ? "Working" : status === "failed" ? "Failed" : "Completed"} · {title}</>;
  if (calmChat()) return <section className="w-full max-w-[480px] rounded-xl bg-[var(--wb-surface)] p-2.5 shadow-[0_0_0_1px_var(--wb-ring)]" aria-label="Browser activity" data-workbot-browser-card={status}>
    <div className="flex min-w-0 items-center gap-3">
      <span aria-hidden={!watchable || working} className={`relative grid h-10 w-16 shrink-0 place-items-center overflow-hidden rounded-lg bg-[var(--wb-chip)] ${status === "completed" ? "text-[var(--wb-browser-success)]" : status === "failed" ? "text-[var(--wb-danger)]" : "text-[var(--wb-browser-working)]"}`}>
        <Globe size={18} strokeWidth={1.7} aria-hidden />
        {watchable && !working ? <span className="absolute inset-0 grid"><LastGlimpse view="browser" taskId={turn.id} /></span> : null}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-[13px] font-medium leading-[18px] text-[var(--wb-text)]">Browser</h3>
        <p className="truncate text-[12px] leading-4 text-[var(--wb-muted)]" role="status">{statusLine}</p>
      </div>
      <button type="button" onClick={() => preview?.open(task)} disabled={!watchable || !preview} className="flex h-8 shrink-0 items-center rounded-full bg-[var(--wb-surface)] px-3 text-[12px] font-medium text-[var(--wb-text)] shadow-[0_0_0_1px_var(--wb-ring)] transition-colors duration-150 hover:bg-[var(--wb-chip)] disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">Open preview</button>
    </div>
    {reason ? <p className="px-0.5 pt-2 text-[12px] leading-4 text-[var(--wb-danger)]">{reason}</p> : null}
    {watchable && working ? <LiveGlimpse view="browser" taskId={turn.id} previewOnly /> : null}
    {!watchable ? <p className="px-0.5 pt-2 text-[12px] leading-4 text-[var(--wb-muted)]">Browser access is off for your organization.</p> : null}
  </section>;
  return <section className="w-full max-w-[480px] rounded-[20px] bg-[var(--wb-bubble)] p-3" aria-label="Browser activity" data-workbot-browser-card={status}>
    <div className="flex min-w-0 items-center gap-2.5 px-1 pb-1">
      <span aria-hidden className={`relative grid size-10 shrink-0 place-items-center rounded-[10px] ${status === "completed" ? "bg-[var(--wb-browser-success-bg)] text-[var(--wb-browser-success)]" : status === "failed" ? "bg-[var(--wb-surface)] text-[var(--wb-danger)]" : "bg-[var(--wb-browser-working-bg)] text-[var(--wb-browser-working)]"}`}>
        <Globe size={22} strokeWidth={1.7} />
        {status === "completed" ? <Check size={12} strokeWidth={2.5} className="absolute bottom-1 right-1 rounded-full bg-[var(--wb-browser-success-bg)]" /> : null}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-[14px] font-semibold leading-5 text-[var(--wb-text)]">Browser</h3>
        <p className="truncate text-[13px] leading-5 text-[var(--wb-text)]" role="status">{status === "working" ? "Working" : status === "failed" ? "Failed" : "Completed"} · {title}</p>
      </div>
    </div>
    {reason ? <p className="px-1 pt-1 text-[13px] text-[var(--wb-danger)]">{reason}</p> : null}
    {watchable ? working ? <LiveGlimpse view="browser" taskId={turn.id} previewOnly /> : <LastGlimpse view="browser" taskId={turn.id} large /> : null}
    <button type="button" onClick={() => preview?.open(task)} disabled={!watchable || !preview} className="mt-3 flex h-10 w-full items-center justify-center rounded-full bg-[var(--wb-surface)] text-[13px] font-medium text-[var(--wb-text)] hover:bg-[var(--wb-chip)] disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">Open preview</button>
    {!watchable ? <p className="px-1 pt-2 text-[12px] text-[var(--wb-muted)]">Browser access is off for your organization.</p> : null}
  </section>;
}

function SurfaceCard({ surface, steps, live, showing, others, switchTo = null, starting: startingUpdate = null, task }: { task: BrowserPreviewTask; surface: Exclude<ComputerSurface, "browser">; steps: WorkbotStep[]; live: boolean; showing: boolean; others: UsedApp[]; switchTo?: SwitchTo | null; starting?: string | null }) {
  const [asked, setAsked] = useState<string | null>(null);
  const updates = steps.flatMap((step) => step.updates);
  const latest = (live ? startingUpdate : null) ?? updates.at(-1) ?? null;
  const onScreen = useContext(ComputerOnScreenContext) === surface;
  const preview = useBrowserPreview();
  const updatePreview = preview?.update;
  useEffect(() => { if (surface !== "background") updatePreview?.(task); }, [updatePreview, surface, task.id, task.title, task.status, task.reason]);
  const update = useHeld(latest, latest ?? "", UPDATE_HOLD_MS);
  const views = computerViews(workbotHost());
  const watchable = surface === "background" ? views.length > 0 : views.includes(surface);
  const title = surface === "background" ? `${live ? "Working" : "Worked"} on my computer` : `${live ? "Using" : "Used"} my computer`;
  const starting = surface === "background" ? "Running in the background" : "Starting up";
  if (!live && surface !== "background") return <FinishedSurfaceCard surface={surface} steps={steps} watchable={watchable} task={task} />;
  if (live && watchable && surface !== "background") return <section className="workbot-row-enter w-full max-w-[480px] rounded-[20px] bg-[var(--wb-chip)] p-3" aria-label="Computer activity" data-workbot-computer-card>
    <div className="flex min-w-0 items-center gap-2.5 px-1 pb-1">
      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-[var(--wb-surface)] text-[var(--wb-text)]"><Monitor size={20} strokeWidth={1.7} /></span>
      <div className="min-w-0">
        <h3 className="text-[14px] font-semibold leading-5 text-[var(--wb-text)]">Computer</h3>
        <p className="truncate text-[12px] leading-4 text-[var(--wb-muted)]" role="status">{update ?? starting}</p>
      </div>
    </div>
    {!onScreen ? <LiveGlimpse view={surface} previewOnly /> : null}
    <button type="button" onClick={() => openScreen(preview, task, surface)} className="mt-3 flex h-10 w-full items-center justify-center rounded-full bg-[var(--wb-surface)] text-[13px] font-medium text-[var(--wb-text)] hover:bg-[var(--wb-bubble)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">Open computer</button>
  </section>;
  return (
    <WorkCard
      title={title}
      detail={(live ? update : latest) ?? (live ? starting : "Done")}
      running={live}
      outcome={live ? null : "done"}
      startedAt={steps.find((step) => step.startedAt)?.startedAt ?? null}
      finishedAt={live ? null : ([...steps].reverse().find((step) => step.finishedAt)?.finishedAt ?? null)}
      updates={live ? [] : updates}
      action={<AppLogos apps={others} />}
      footer={
        <>
          {showing && watchable && surface !== "background" && !onScreen ? <div className="px-2.5"><LiveGlimpse view={surface} onOpen={() => openSurface(surface)} /></div> : null}
          {live && watchable && switchTo && asked !== switchTo.label ? (
            <div className="flex px-2.5 pb-2.5 pt-2" data-workbot-computer-switch>
              <button
                type="button"
                onClick={() => { setAsked(switchTo.label); switchTo.send(switchTo.text); }}
                className="inline-flex h-7 items-center gap-1.5 rounded-full bg-[var(--wb-surface)] px-2.5 text-[12px] text-[var(--wb-text)] shadow-[0_0_0_1px_var(--wb-ring)] transition-shadow duration-150 hover:shadow-[0_0_0_1px_var(--wb-disabled)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
              >
                {showing ? null : <Monitor size={12} aria-hidden className="shrink-0 text-[var(--wb-muted)]" />}
                {switchTo.label}
              </button>
            </div>
          ) : null}
        </>
      }
    />
  );
}

function FinishedSurfaceCard({ surface, steps, watchable, task }: { surface: "computer"; steps: WorkbotStep[]; watchable: boolean; task: BrowserPreviewTask }) {
  const preview = useBrowserPreview();
  const name = "Computer";
  const summary = finishedSummary(surface, steps);
  const body = <>
    <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-[var(--wb-surface)] text-[var(--wb-text)]"><Monitor size={20} strokeWidth={1.7} /></span>
    <span className="min-w-0 flex-1">
      <span className="block text-[14px] font-semibold leading-5 text-[var(--wb-text)]">{name}</span>
      <span className="block truncate text-[12px] leading-4 text-[var(--wb-muted)]">{summary}</span>
    </span>
    <LastGlimpse view={surface} />
  </>;
  const className = "flex w-full max-w-[480px] min-w-0 items-center gap-2.5 rounded-[20px] bg-[var(--wb-chip)] p-3 text-left";
  return watchable
    ? <button type="button" onClick={() => openScreen(preview, task, surface)} aria-label={`${name}: ${summary}. Open the computer`} className={`${className} hover:bg-[var(--wb-bubble)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]`} data-workbot-computer-card="done">{body}</button>
    : <section aria-label={`${name}: ${summary}`} className={className} data-workbot-computer-card="done">{body}</section>;
}

function AppLogos({ apps }: { apps: UsedApp[] }) {
  if (apps.length === 0) return null;
  return (
    <span aria-label={`Also using ${joinNames(apps.map((app) => app.name))}`} className="flex shrink-0 items-center gap-1.5 pr-1">
      {apps.map((app) => (
        <span key={app.key} className="workbot-app-enter grid size-4 place-items-center">
          <AppMark name={app.name} size={14} />
        </span>
      ))}
    </span>
  );
}

function withoutNextLine(text: string) {
  const lines = text.split("\n");
  const next = lines.findIndex((line) => /^\**next\**\s*:/i.test(line.trim()));
  if (next !== -1) return lines.slice(0, next).join("\n").trimEnd();
  const last = lines.at(-1)?.trim().replace(/\*/g, "").toLowerCase() ?? "";
  if (last && "next:".startsWith(last)) return lines.slice(0, -1).join("\n").trimEnd();
  return text;
}

function replyProgress(turn: WorkbotTurn, live: LiveText | null) {
  const working = turn.status === "working" || turn.status === "queued";
  const current = working && live && live.step >= turn.modelSteps ? live : null;
  const liveText = withoutNextLine((current?.text ?? "").trim());
  const last = turn.parts.at(-1);
  const starting = working && !turn.greeting && current?.working?.on === "computer" ? current.working : null;
  const lastIsLive = working && last?.kind === "steps" && !liveText;
  return { working, liveText, starting, lastIsLive };
}

function useSettled(flag: boolean, ms: number) {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!flag) {
      setSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), ms);
    return () => window.clearTimeout(timer);
  }, [flag, ms]);
  return flag && settled;
}

type TurnItem = { kind: "text"; key: string; text: string }
  | { kind: "card"; key: string; surface: ComputerSurface; steps: WorkbotStep[]; live: boolean; showing: boolean; others: UsedApp[]; switchTo: SwitchTo | null; update: string | null };

const TurnView = memo(function TurnView(props: {
  host: WorkbotHost;
  watcherIds: ReadonlySet<string>;
  canChange: boolean;
  onEdit: (turn: WorkbotTurn, text: string) => void;
  editError: Error | string | null;
  turn: WorkbotTurn;
  pending?: Pending | null;
  live: WorkbotLiveStore;
  latest: boolean;
  newestText: boolean;
  previews: Record<string, string | null>;
  onRetry: (turn: WorkbotTurn, pending: Pending | null) => void;
  onSuggestion: (text: string) => void;
  onSwitch: (text: string) => void;
}) {
  const { turn, pending = null } = props;
  const streamed = useWorkbotLiveText(props.live, pending ? null : turn.id);
  const onRetry = () => props.onRetry(turn, pending);
  const { working, liveText, starting, lastIsLive } = replyProgress(turn, streamed);
  const browserWork = starting?.surface === "browser" || turn.parts.some(part => part.kind === "steps" && part.steps.some(step => step.surface === "browser"));

  const visibleTasks = turn.tasks.filter((task) => !props.watcherIds.has(task.id) && (task.status === "failed" || task.status === "stopped"));
  const uploading = pending !== null && !pending.failed && pending.uploads.some((upload) => upload.status === "uploading");
  const watched = useRef(working);
  if (working) watched.current = true;
  const parts = turn.parts;
  const live = working && streamed && streamed.step >= turn.modelSteps ? streamed : null;
  const answering = props.latest && working;
  const switchMode = answering ? props.onSwitch : undefined;
  const work = computerWork(parts, { working, starting, lastIsLive });
  const card = (surface: ComputerSurface, others: UsedApp[] = []): Extract<TurnItem, { kind: "card" }> => {
    const isLive = work.live.has(surface);
    const showing = surface === work.shown;
    const switchTo = !isLive || !switchMode ? null
      : showing ? { label: "Carry on without me", text: "Carry on without me in the background; no need to show me.", send: switchMode }
      : { label: "Show me", text: "Show me what you're doing on screen.", send: switchMode };
    const update = isLive && surface === work.starts ? (starting?.update ?? null) : null;
    return { kind: "card", key: `card-${surface}`, surface, steps: work.cards.get(surface)?.steps ?? [], live: isLive, showing, others, switchTo, update };
  };
  const items: TurnItem[] = work.cards.has("browser") ? [card("browser")] : [];
  parts.forEach((part, index) => {
    if (part.kind === "text") {
      items.push({ kind: "text", key: `text-${part.step ?? `part-${index}`}`, text: part.text });
      return;
    }
    const here = (work.placed.get(index) ?? []).filter(surface => surface !== "browser");
    const apps = part.steps.filter((step) => step.icon === "app");
    here.forEach((surface, at) => {
      const item = card(surface, at === here.length - 1 ? usedApps(apps, null) : []);
      if (!browserWork && keepsCard(item)) items.push(item);
    });
  });
  if (working && streamed) {
    for (const entry of streamed.earlier ?? []) {
      const text = withoutNextLine(entry.text.trim());
      if (entry.step >= turn.modelSteps && text) items.push({ kind: "text", key: `text-${entry.step}`, text });
    }
  }
  if (live && liveText) items.push({ kind: "text", key: `text-${live.step}`, text: liveText });
  for (const surface of work.trailing) {
    const item = card(surface);
    if (!browserWork && keepsCard(item)) items.push(item);
  }
  const acknowledgement = !pending && !items.some((item) => item.kind === "text" && item.text.trim()) ? firstReply(turn) : null;
  if (acknowledgement) items.splice(browserWork ? 1 : 0, 0, { kind: "text", key: "accepted", text: acknowledgement });
  const connector = connectorSummary(turn, streamed);
  const connectorWaiting = connector !== null && answering && !liveText;
  const lastText = items.reduce((found, item, index) => (item.kind === "text" ? index : found), -1);
  const waiting = answering && !liveText && !lastIsLive && work.live.size === 0;
  const fresh = items.length === 0 && !connectorWaiting;
  const settled = useSettled(waiting && !fresh, 350);
  const atWork = parts.some((part) => part.kind === "steps") || Boolean(live?.working);
  const dots = !acknowledgement && (waiting && items.length === 0 && !atWork);
  const [held, setHeld] = useState(false);
  const writing = liveText !== "";
  useEffect(() => {
    if (dots || connectorWaiting) setHeld(true);
    else if (!answering || writing) setHeld(false);
  }, [dots, connectorWaiting, answering, writing]);
  const slot = uploading || (answering && !liveText && (dots || held || connectorWaiting));
  const copyText = parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n\n");
  const offers = useMemo(() => (turn.status === "done" ? documentLinks(copyText) : []), [turn.status, copyText]);
  const onScreen = (step: WorkbotStep) => step.icon === "computer" && !step.background;
  return (
    <>
      <SentAttachments attachments={turn.attachments} localUrls={pending ? { ...props.previews, ...pendingAttachments(pending).urls } : props.previews} />
      {pending || (turn.text && !turn.greeting) ? (
        <OwnMessage turn={turn} failed={Boolean(pending?.failed)} canChange={props.canChange && turn.status !== "queued"} onEdit={props.onEdit} error={props.editError instanceof WorkbotSendError && props.editError.accessReason ? null : props.editError instanceof Error ? props.editError.message : props.editError} />
      ) : (
        <UserBubble text={turn.text} reaction={turn.reaction} />
      )}
      {pending?.failed ? (
        pending.accessIssue ? <AccessRecovery reason={pending.accessIssue} onRetry={onRetry} /> : <ErrorLine align="end" action={{ label: "Send again", onClick: onRetry }}>{pending.failed}</ErrorLine>
      ) : null}
      {items.length > 0 || slot || connector ? <Gap /> : null}
      <div className="group/answer flex flex-col">
        {items.map((item, index) =>
          item.kind === "text" ? (
            <AssistantBubble key={item.key} trailing={turn.status === "done" && index === lastText ? <CopyAnswer text={copyText} /> : null}>
              <StreamingText text={item.text} instant={item.key === "accepted" || !(props.newestText && index === lastText && watched.current)} />
            </AssistantBubble>
          ) : (
            <div key={item.key} className={item.surface === "browser" && calmChat() ? "py-2" : "py-1 pl-1"}>
              {item.surface === "browser" ? <BrowserTaskCard turn={turn} steps={item.steps} working={working} /> : <SurfaceCard surface={item.surface} steps={item.steps} live={item.live} showing={item.showing} others={item.others} switchTo={item.switchTo} starting={item.update} task={{ id: `computer:${turn.id}`, ...browserTask(item.steps, { working: working && item.live, title: turn.text.trim() || "Computer task", status: turn.status, what: "computer task" }) }} />}
            </div>
          ),
        )}
        {slot ? <WaitingSlot>{uploading ? <QuietLine label="Uploading your files" /> : connectorWaiting && connector ? <ConnectorLine summary={connector} /> : dots ? <TypingDots /> : null}</WaitingSlot> : null}
        {connector && !(slot && connectorWaiting) ? <ConnectorLine summary={connector} /> : null}
      </div>
      <DocumentOffers links={offers} />
      <DocumentNavigationStatus receipts={turn.navigation} />
      <TeachingOffer receipt={turn.teaching} />
      {turn.outputs.length ? <ArtifactCards files={turn.outputs} /> : null}
      {visibleTasks.length ? <TaskCards tasks={visibleTasks} canRetry={props.canChange} onRetry={(task) => props.onSuggestion(`Try the "${task.title}" background task again.`)} /> : null}
      {turn.suggestions.length && props.latest ? (
        <ul className="flex flex-wrap gap-2 pl-1 pt-3">
          {turn.suggestions.map((text) => (
            <li key={text}>
              <button
                type="button"
                onClick={() => props.onSuggestion(text)}
                className="flex h-[34px] items-center rounded-full bg-[var(--wb-surface)] px-3.5 text-[13px] leading-4 text-[var(--wb-text)] shadow-[0_0_0_1px_var(--wb-ring)] transition-shadow duration-150 hover:shadow-[0_0_0_1px_var(--wb-disabled)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
              >
                {text}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {turn.status === "failed" && props.editError instanceof WorkbotSendError && props.editError.accessReason ? (
        <AccessRecovery reason={props.editError.accessReason} onRetry={props.latest ? onRetry : undefined} />
      ) : turn.status === "failed" && turn.modelIssue && workbotHost().usageRecovery ? (
        <ModelRecovery issue={turn.modelIssue} onRetry={props.latest ? onRetry : undefined} />
      ) : turn.status === "failed" ? (
        <ErrorLine action={props.latest && (turn.greeting || turn.retryable) ? { label: "Try again", onClick: onRetry } : null}>{turn.greeting ? HELLO_FAILED : turn.error}</ErrorLine>
      ) : null}
    </>
  );
});

function duration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const isOpen = (task: WorkbotTask) => task.status === "queued" || task.status === "working" || task.status === "paused";

function WorkCard(props: {
  title: string;
  detail: string;
  running: boolean;
  outcome: "done" | "failed" | "stopped" | null;
  startedAt: number | null;
  finishedAt: number | null;
  updates: string[];
  action?: ReactNode;
  footer?: ReactNode;
}) {
  const now = useNow(props.running && Boolean(props.startedAt) && props.finishedAt === null);
  const [open, setOpen] = useState(false);
  const elapsed = props.startedAt ? (props.finishedAt ?? (props.running ? now : null)) : null;
  const expandable = !props.running && props.updates.length > 1;
  const body = (
    <>
      <span aria-hidden className="relative grid size-9 shrink-0 place-items-center rounded-[10px] bg-[var(--wb-chip)]">
        <WorkerGlyph working={props.running} />
        {props.outcome === "done" ? (
          <span className="absolute -bottom-1 -right-1 grid size-4 place-items-center rounded-full bg-[var(--wb-ink)] text-[var(--wb-surface)] ring-2 ring-[var(--wb-surface)]">
            <Check size={9} strokeWidth={3} />
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="truncate text-[13.5px] font-medium leading-5 text-[var(--wb-text)]">{props.title}</span>
        <span className={`flex min-w-0 items-center gap-1.5 text-[12px] leading-4 ${props.outcome === "failed" ? "text-[var(--wb-danger)]" : "text-[var(--wb-muted)]"}`}>
          <span key={props.detail} className={`workbot-subtitle-enter truncate ${props.running ? "workbot-shimmer" : ""}`}>{props.detail}</span>
          {props.startedAt && elapsed && elapsed - props.startedAt >= 1_000 ? (
            <span className="shrink-0 tabular-nums">· {duration(elapsed - props.startedAt)}</span>
          ) : null}
        </span>
      </span>
      {expandable ? null : props.action}
    </>
  );
  return (
    <div className="workbot-row-enter max-w-[480px] rounded-[14px] bg-[var(--wb-surface)] shadow-[var(--wb-card-shadow)]">
      {expandable ? (
        <div className="flex items-center pr-2">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-[14px] py-2.5 pl-2.5 pr-3 outline-none focus-visible:shadow-[var(--wb-focus)]"
          >
            {body}
          </button>
          {props.action}
        </div>
      ) : (
        <div className="flex items-center gap-3 py-2.5 pl-2.5 pr-2" role="status" aria-live="polite">
          {body}
        </div>
      )}
      {open ? (
        <ol className="workbot-fade-in flex flex-col gap-1.5 pb-3 pl-[58px] pr-4">
          {props.updates.map((update, index) => (
            <li key={`${index}:${update}`} className="text-[12.5px] leading-[18px] text-[var(--wb-muted)]">
              {update}
            </li>
          ))}
        </ol>
      ) : null}
      {props.footer}
    </div>
  );
}

function TaskCard({ task, onRetry, canRetry = true }: { task: WorkbotTask; onRetry?: () => void; canRetry?: boolean }) {
  const stop = useStopWorkbotTask();
  const running = isOpen(task);
  const outcome = running ? null : task.status === "done" ? "done" : task.status === "failed" ? "failed" : "stopped";
  const detail = running
    ? task.status === "queued" ? "Waiting to start" : task.status === "paused" ? "Picking it back up" : (task.update ?? "Working on it")
    : outcome === "done" ? "Done" : outcome === "failed" ? "Couldn't finish" : "Stopped";
  const stopping = stop.isPending && stop.variables === task.id;
  return (
    <WorkCard
      title={task.title}
      detail={detail}
      running={running}
      outcome={outcome}
      startedAt={task.status === "queued" ? null : task.startedAt}
      finishedAt={task.finishedAt}
      updates={task.updates}
      action={
        running ? (
          <button
            type="button"
            disabled={stopping}
            onClick={() => stop.mutate(task.id)}
            className="h-7 shrink-0 rounded-full px-3 text-[12px] font-medium text-[var(--wb-muted)] transition-colors duration-150 hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
          >
            {stopping ? "Stopping" : "Stop"}
          </button>
        ) : (task.status === "failed" || outcome === "stopped") && onRetry ? (
          <button type="button" disabled={!canRetry} onClick={onRetry} className="h-7 shrink-0 rounded-full px-3 text-[12px] font-medium text-[var(--wb-text)] hover:bg-[var(--wb-chip)] disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">{outcome === "stopped" ? "Run again" : "Try again"}</button>
        ) : null
      }
    />
  );
}

function TaskCards({ tasks, onRetry, canRetry }: { tasks: WorkbotTask[]; onRetry: (task: WorkbotTask) => void; canRetry: boolean }) {
  return (
    <div className="flex flex-col gap-2 pl-1 pt-3">
      {tasks.map((task) => <div key={task.id} data-workbot-task={task.id}><TaskCard task={task} canRetry={canRetry} onRetry={() => onRetry(task)} /></div>)}
    </div>
  );
}

function DraftComposer({ state, ...props }: { state: ComposerState } & Omit<Parameters<typeof WorkbotComposer>[0], "text" | "onText" | "uploads" | "onFiles" | "onRemoveUpload" | "onRetryUpload">) {
  const draft = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
  return <WorkbotComposer {...props} text={draft.text} onText={state.setText} uploads={draft.uploads} onFiles={state.add} onRemoveUpload={state.removeUpload} onRetryUpload={state.retryUpload} />;
}

export function WorkbotComposer(props: {
  teaching?: BrowserTeachingContext;
  text: string;
  onText: (text: string) => void;
  name: string;
  autoFocus?: boolean;
  disabled?: boolean;
  busy: boolean;
  stopping: boolean;
  filesEnabled: boolean;
  uploads: Upload[];
  onFiles: (files: FileList | File[]) => void;
  onRemoveUpload: (key: string) => void;
  onRetryUpload: (key: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const { text } = props;
  const browserPreview = useBrowserPreview();
  const input = useRef<HTMLTextAreaElement>(null);
  const touch = useTouchKeyboard();
  const dictation = useNativeDictation({ enabled: !props.disabled, text, onText: props.onText,
    selection: () => ({ start: input.current?.selectionStart ?? text.length, end: input.current?.selectionEnd ?? text.length }),
    focusInput: () => input.current?.focus() });
  const hasFiles = props.uploads.length > 0;
  const canSend = text.trim().length > 0 || (hasFiles && props.uploads.every((upload) => upload.status !== "failed"));

  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    const fit = () => fitTextarea(node, 200);
    fit();
    let width = node.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const next = node.getBoundingClientRect().width;
      if (next === width) return;
      width = next;
      fit();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [text]);

  const sendNow = () => {
    if (!canSend || props.disabled) return;
    props.onSend(dictation.commit());
    input.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229 && !touch) {
      event.preventDefault();
      sendNow();
    } else if (event.key === "Escape" && props.busy) {
      props.onStop();
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!props.filesEnabled || event.clipboardData.files.length === 0) return;
    event.preventDefault();
    props.onFiles(event.clipboardData.files);
  };
  const showStop = props.busy && !canSend;
  const multiline = hasFiles || text.includes("\n") || text.length > 70;
  const stacked = hasFiles || props.teaching !== undefined;
  const teachingPhase = props.teaching?.phase === "recording" ? `Teaching ${props.name}` : props.teaching?.phase === "paused" ? "Recording paused · Still teaching" : "Reviewing the skill";

  return <>
    {browserPreview?.visible && browserPreview.context ? <button type="button" aria-pressed={browserPreview.includeContext} onClick={() => browserPreview.setIncludeContext(!browserPreview.includeContext)} title={browserPreview.includeContext ? "Exclude this tab from your next message" : "Tell Workbot which tab you're on"} className={`mb-2 max-w-full truncate rounded-full px-2.5 py-1 text-[12px] text-[var(--wb-muted)] hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] ${browserPreview.includeContext ? "" : "line-through"}`} data-workbot-preview-context>{workbotContextLabel(browserPreview.context)}{browserPreview.includeContext ? " · This tab" : " · Not shared"}</button> : null}
    <div
      data-workbot-composer
      className={`flex bg-[var(--wb-surface)] shadow-[var(--wb-composer-shadow)] transition-[border-radius] duration-150 ${
        stacked ? "flex-col gap-2 rounded-[24px] pb-2 pl-2.5 pr-2 pt-2.5" : `items-end gap-1 py-[7px] pl-[7px] pr-[7px] sm:py-2 sm:pr-2 ${multiline ? "rounded-[24px]" : "rounded-full"}`
      }`}
    >
      {props.teaching && <div role="status" title={`${teachingPhase} · ${props.teaching.label}`} className="flex min-w-0 items-center gap-1.5 px-1.5 text-[12px] text-[var(--wb-muted)]" data-workbot-teaching-context>
        {props.teaching.phase === "recording" ? <span aria-hidden className="mx-[3.5px] size-1.5 shrink-0 rounded-full bg-[var(--wb-danger)]" /> : <Presentation size={13} strokeWidth={1.5} aria-hidden className="shrink-0" />}
        <span className="shrink-0 font-medium text-[var(--wb-text)]">{teachingPhase}</span>
        <span aria-hidden className="shrink-0">·</span>
        <span className="min-w-0 truncate">{props.teaching.label}</span>
      </div>}
      {hasFiles ? <UploadTray uploads={props.uploads} onRemove={props.onRemoveUpload} onRetry={props.onRetryUpload} /> : null}
      <div className={stacked ? "flex w-full min-w-0 flex-1 items-end gap-1" : "contents"}>
        <AttachButton enabled={props.filesEnabled} onFiles={props.onFiles} />
        <textarea
          ref={input}
          value={text}
          rows={1}
          autoFocus={props.autoFocus ?? true}
          disabled={props.disabled}
          onChange={(event) => dictation.edit(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          enterKeyHint={touch ? "enter" : "send"}
          placeholder={props.teaching ? "Explain this step or ask a question" : `Message ${props.name}`}
          aria-label={`Message ${props.name}`}
          className={`max-h-[200px] min-h-9 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-[7px] text-[16px] leading-[22px] text-[var(--wb-text)] outline-none placeholder:text-[var(--wb-faint)] sm:py-[9px] sm:leading-[18px] ${calmChat() ? "sm:text-[13px]" : "sm:text-[14px]"}`}
        />
        <WorkbotDictation dictation={dictation} disabled={props.disabled} text={text} />
        <button
          type="button"
          onClick={showStop ? props.onStop : sendNow}
          disabled={props.disabled || (showStop ? props.stopping : !canSend)}
          aria-label={showStop ? "Stop" : "Send"}
          aria-keyshortcuts={showStop ? "Escape" : touch ? undefined : "Enter"}
          title={showStop ? "Stop (esc)" : touch ? "Send" : "Send (⏎)"}
          className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--wb-ink)] text-[var(--wb-bg)] transition-colors duration-150 disabled:bg-[var(--wb-disabled)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
        >
          {showStop ? <span aria-hidden className="h-2.75 w-2.75 rounded-[2.5px] bg-[var(--wb-bg)]" /> : <ArrowUp size={16} strokeWidth={2.25} aria-hidden />}
        </button>
      </div>
    </div>
  </>;
}
