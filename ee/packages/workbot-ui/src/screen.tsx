"use client";

import { ArrowUp, Check, CircleAlert, Copy, FileText, Globe, Lock, Monitor, Pencil } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { computerViews, setWorkbotHost, workbotHost, type WorkbotHost } from "./host";
import { OpenWorkMark } from "./mark";
import { ChatsButton, ChatsDrawer, chatTitle, RemoveChatButton, SideChatTitle, useChatLocation } from "./chats";
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
  useWorkbotThread,
  WorkbotChatProvider,
  WorkbotSendError,
  workbotFilesKey,
  uploadWorkbotFile,
  type LiveText,
  type WorkbotAttachment,
  type WorkbotPart,
  type WorkbotStep,
  type WorkbotPage,
  type WorkbotTask,
  type WorkbotThread,
  type WorkbotTurn,
} from "./data";
import { AppMark, AttachButton, FileBadge, FilesButton, FilesPanel, ImageThumb, isImage, kindLabel, SentAttachments, UploadTray, useFileDrop, type Upload } from "./files";
import { createComposerState, type ComposerState, type Pending } from "./composer-state";
import { computerWork, type ComputerSurface } from "./computer-work";
import { initials } from "./format";
import { documentLinks, WorkbotMarkdown } from "./markdown";
import { OpenFileContext } from "./open-file";
import { PreviewPanel } from "./preview";
import { Welcome } from "./welcome";
import { ModelRecovery, AccessRecovery } from "./model-recovery";
import { hasAnsweredTurn, WorkbotSetupChip } from "./activation";
import { WorkbotCalendar } from "./calendar";
import { WorkbotDocuments } from "./documents";
import { LiveGlimpse, openBrowserPage, WorkbotComputer } from "./computer";
import { readBrowserSkillRunPrompt, type BrowserTeachingContext } from "@openwork/types/browser-demonstration";
import { readWorkbotCorrectionPrompt, workbotCorrectionPrompt, workbotViewContextSchema, type WorkbotViewContext } from "@openwork/types/workbot-context";
import type { DocumentOpenOutcome, DocumentOpenRequest } from "@openwork/documents";
import { ComputerNavigationContext, ComputerOffer, DocumentNavigationContext, DocumentNavigationStatus, DocumentOffers, type DocumentNavigationState, OpenDocumentContext, SentContext, WorkspaceAssistant, WorkspaceMenu, WorkspaceNavigationContext } from "./workspace";
import { useQueryClient } from "@tanstack/react-query";
import { useNativeDictation } from "@openwork/ui/react";
import { WorkbotDictation } from "./native-dictation";
import { WorkbotCommandPalette, type WorkbotPaletteTab } from "./command-palette";

/**
 * Workbot: one thread, instant. Layout and values follow the Paper file "WorkBot — one chat, set up once",
 * page v4 (screens 1–4) for the thread and v5 (screens 5–8) for files.
 */

/**
 * The conversation is read newest first: a first page small enough to answer quickly, then the rest of a full page in
 * the background, then a page more each time the person asks for earlier messages, up to the limit.
 */
const FIRST_TURNS = 8;
const PAGE_TURNS = 30;
const MAX_TURNS = 200;
const earlierWindow = (current: number) => Math.min(MAX_TURNS, current < PAGE_TURNS ? PAGE_TURNS : current + PAGE_TURNS);
const COLUMN = "min-w-0 w-full max-w-[640px]";

function newMessageId() {
  return crypto.randomUUID().replaceAll("-", "");
}

/** Where side chats are on: the chat on screen, its name, and how to move between chats. */
type ChatNavigation = {
  /** Null for the main chat. */
  chat: string | null;
  title: string;
  openChats: () => void;
  openChat: (chat: string | null) => void;
};

/** The Workbot page. `host` is the app it lives in: signed-in requests, the person, their apps (see WorkbotHost). */
export function WorkbotScreen({ host }: { host: WorkbotHost }) {
  setWorkbotHost(host);
  const sideChats = host.sideChats === true;
  const composers = useMemo(() => new Map<string | null, ComposerState>(), [host.identity?.organizationId, host.identity?.principalId]);
  // Disposed a tick after unmount, so a remount of the same owners (React's StrictMode check) keeps what was typed.
  const disposeComposers = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    clearTimeout(disposeComposers.current);
    return () => { disposeComposers.current = setTimeout(() => { for (const owner of composers.values()) owner.dispose(); }, 0); };
  }, [composers]);
  const [workspaceDrafts, setWorkspaceDrafts] = useState(false);
  const [chat, openChat] = useChatLocation(sideChats, workspaceDrafts ? () => false : undefined);
  const [chatsOpen, setChatsOpen] = useState(false);
  const chats = useWorkbotChats(sideChats);
  const refetchChats = chats.refetch;
  // The list says when each chat was last used: it is read again each time it opens.
  useEffect(() => {
    if (chatsOpen) void refetchChats();
  }, [chatsOpen, refetchChats]);
  const navigation: ChatNavigation | null = sideChats
    ? { chat, title: chat ? chatTitle(chats.data?.side.find((entry) => entry.id === chat)?.title) : "Main chat", openChats: () => setChatsOpen(true), openChat }
    : null;
  let composer = composers.get(chat);
  if (!composer) {
    composer = createComposerState((file, progress, signal) => uploadWorkbotFile(file, progress, signal, chat));
    composers.set(chat, composer);
  }
  return (
    <WorkbotChatProvider value={chat}>
      {/* Screen lifecycles never own a person's unsent work. */}
      <ChatScreen key={`${host.identity?.organizationId ?? ""}:${host.identity?.principalId ?? ""}:${chat ?? "main"}`} host={host} composerState={composer} navigation={navigation} onDraftsChange={setWorkspaceDrafts} />
      {sideChats ? (
        <ChatsDrawer
          open={chatsOpen}
          onClose={() => setChatsOpen(false)}
          current={chat}
          chats={chats.data}
          loading={chats.isPending}
          failed={chats.isError}
          onRetry={() => void refetchChats()}
          onOpenChat={openChat}
        />
      ) : null}
    </WorkbotChatProvider>
  );
}

/** One chat: the main chat, or one of the person's side chats. */
function ChatScreen({ host, composerState, navigation, onDraftsChange }: { host: WorkbotHost; composerState: ComposerState; navigation: ChatNavigation | null; onDraftsChange(dirty: boolean): void }) {
  const { user } = host;
  const side = navigation?.chat != null;
  const queryClient = useQueryClient();
  const draft = useSyncExternalStore(composerState.subscribe, composerState.getSnapshot, composerState.getSnapshot);
  const { pending } = draft;
  const [turnWindow, setTurnWindow] = useState(FIRST_TURNS);
  const [filesOpen, setFilesOpen] = useState(false);
  // Once activated, keep this shell mounted even when the flag is revoked: draft editors must survive.
  const [teaching, setTeaching] = useState<BrowserTeachingContext>();
  const [workspaceShell, setWorkspaceShell] = useState(host.workspaceAssistant === true || host.browserDemonstrations === true);
  useEffect(() => { if (host.workspaceAssistant || host.browserDemonstrations) setWorkspaceShell(true); }, [host.workspaceAssistant, host.browserDemonstrations]);
  const [documentContext, setDocumentContext] = useState<WorkbotViewContext | null>(null);
  const [calendarContext, setCalendarContext] = useState<WorkbotViewContext | null>(null);
  const [browserContext, setBrowserContext] = useState<WorkbotViewContext | null>(null);
  const [includeContext, setIncludeContext] = useState(true);
  const [openDocument, setOpenDocument] = useState<DocumentOpenRequest>();
  const [documentsDirty, setDocumentsDirty] = useState(false);
  const reportDocumentDirty = useCallback((dirty: boolean) => { setDocumentsDirty(dirty); onDraftsChange(dirty); }, [onDraftsChange]);
  useEffect(() => () => onDraftsChange(false), [onDraftsChange]);
  const [leavingDocuments, setLeavingDocuments] = useState<WorkbotTab | null>(null);
  const [tab, setTab] = useWorkbotTab((next) => {
    if (!workspaceShell && documentsDirty && next !== "documents") { setLeavingDocuments(next); return false; }
    return true;
  }, workspaceShell);
  const [computerVisited, setComputerVisited] = useState(tab === "computer");
  // Which view the Computer page shows (Browser or Computer); the chat beside it leaves that live screen out.
  const [computerView, setComputerView] = useState<"browser" | "computer" | null>(null);
  useEffect(() => { if (tab === "computer") setComputerVisited(true); }, [tab]);
  const [documentsVisited, setDocumentsVisited] = useState(tab === "documents");
  const [calendarVisited, setCalendarVisited] = useState(tab === "calendar");
  useEffect(() => { if (tab === "documents") setDocumentsVisited(true); if (tab === "calendar") setCalendarVisited(true); }, [tab]);
  const currentContext = tab === "documents" ? documentContext : tab === "calendar" ? calendarContext : tab === "computer" ? browserContext : null;
  // The views a message may name, as Den allows them: the browser tab with browser use, documents and the calendar with
  // the workspace assistant.
  const shares = (context: WorkbotViewContext | undefined): context is WorkbotViewContext => context !== undefined
    && (context.kind === "browser" ? host.browser === true : host.workspaceAssistant === true && (context.kind === "calendar" || host.documents === true));
  // Excluding a view applies to that view only: whatever the person looks at next is shared again.
  const viewKey = !currentContext ? null : currentContext.kind === "browser" ? `browser:${currentContext.tabId}`
    : currentContext.kind === "document" ? `document:${currentContext.fileId}`
    : currentContext.kind === "documents" ? `documents:${currentContext.view}:${currentContext.folderId}`
    : `calendar:${currentContext.view}:${currentContext.start}:${currentContext.selected?.id ?? ""}`;
  useEffect(() => { if (viewKey) setIncludeContext(true); }, [viewKey]);
  // Den reports guidedNavigation only with the workspace assistant; each destination keeps its own switch.
  const guided = host.workspaceAssistant === true && host.guidedNavigation === true;
  const [revealChat, setRevealChat] = useState(0);
  // Which reply asked for each open request, and what became of it. Kept for this page only: history never replays.
  const [navigationStatus, setNavigationStatus] = useState<Readonly<Record<string, DocumentNavigationState>>>({});
  const navigationRequests = useRef(new Map<string, string>());
  const currentRequest = useRef<string | null>(null);
  const settleNavigation = useCallback((requestId: string, outcome: DocumentOpenOutcome) => {
    const receipt = navigationRequests.current.get(requestId);
    if (!receipt) return;
    // Only a request still opening can be set aside; one that opened or failed keeps saying so.
    setNavigationStatus(current => outcome === "superseded" && current[receipt] !== "opening" ? current : { ...current, [receipt]: outcome });
  }, []);
  const navigateDocument = (fileId: string) => {
    if (!host.workspaceAssistant || !host.documents) return null;
    const requestId = newMessageId();
    // A newer request replaces one still opening; that one never opens.
    if (currentRequest.current) settleNavigation(currentRequest.current, "superseded");
    currentRequest.current = requestId;
    setOpenDocument({ fileId, requestId });
    setTab("documents");
    return requestId;
  };
  // Guided navigation from a conversation: the same chat stays open beside the document, sharing that view.
  const navigateFromChat = (fileId: string) => {
    const requestId = navigateDocument(fileId);
    if (!guided) return requestId;
    setIncludeContext(true);
    setRevealChat(count => count + 1);
    return requestId;
  };
  const followNavigation = (receipt: { id: string; fileId: string }) => {
    const requestId = navigateFromChat(receipt.fileId);
    if (!requestId) return;
    navigationRequests.current.set(requestId, receipt.id);
    setNavigationStatus(current => ({ ...current, [receipt.id]: "opening" }));
  };
  // What the person is looking at, so a late answer only navigates if they are still where they asked from.
  const view = tab !== "documents" ? tab : documentContext?.kind === "document" ? `documents:${documentContext.fileId}` : documentContext?.kind === "documents" ? `documents:${documentContext.folderId}:${documentContext.query}` : "documents";
  const viewRef = useRef(view);
  viewRef.current = view;
  // Turns sent from this page, with the view they were sent from. Receipts on any other turn are never followed.
  const sentFrom = useRef(new Map<string, string>());
  const followed = useRef(new Set<string>());
  // The same move for Workbot's computer: open it and keep the conversation beside it. Null while it is on screen.
  const navigateComputerFromChat = guided && computerViews(host).length > 0 && tab !== "computer"
    ? () => { setTab("computer"); setRevealChat(count => count + 1); }
    : null;
  const [preview, setPreview] = useState<WorkbotAttachment | null>(null);
  // The welcome shows once, while there's no conversation yet; leaving it, Workbot starts the conversation itself.
  // "pending" until the conversation is first read: then it shows (no conversation yet) or never does. Side chats
  // start with the person's first message.
  const [welcome, setWelcome] = useState<"pending" | "showing" | "done">(side ? "done" : "pending");
  const [greetingAwaited, setGreetingAwaited] = useState(false);
  const start = useStartWorkbot();
  const stream = useWorkbotLive(true);
  const thread = useWorkbotThread({ turns: turnWindow, awaiting: greetingAwaited || pending.some((entry) => !entry.failed), live: stream.connected });
  // The welcome lists the person's connections: read them alongside the conversation, not once it has loaded.
  useWorkbotConnections({ enabled: welcome === "pending" && !side, waiting: false });
  const send = useSendWorkbotMessage();
  const retry = useRetryWorkbotMessage();
  const stop = useStopWorkbot();
  const editMessage = useEditWorkbotMessage();
  const uploads = { uploads: draft.uploads, add: composerState.add, remove: composerState.removeUpload, retry: composerState.retryUpload };
  const data = thread.data?.available ? thread.data : null;
  // Once the newest messages are on screen, the rest of the first page is read behind them.
  const earlierToRead = data?.hasEarlier === true && !thread.isPlaceholderData;
  useEffect(() => {
    if (earlierToRead && turnWindow < PAGE_TURNS) setTurnWindow(PAGE_TURNS);
  }, [earlierToRead, turnWindow]);
  // The page, header and message box show before the conversation is read; only the thread waits for it.
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
  // The open file at its newest version: when Workbot revises it, the preview follows (same id, newer updatedAt).
  const previewFile = useMemo(() => {
    if (!preview || !data) return preview;
    let newest = preview;
    for (const turn of data.turns) {
      for (const file of [...turn.outputs, ...turn.attachments]) {
        if (file.id === preview.id && (file.updatedAt ?? 0) > (newest.updatedAt ?? 0)) newest = file;
      }
    }
    return newest;
  }, [preview, data]);
  const filesEnabled = data?.filesEnabled ?? false;
  const addFiles = uploads.add;
  const paletteChats = useWorkbotChats(navigation !== null);
  const paletteTasks = useMemo(() => (data?.turns ?? []).flatMap((turn) => turn.tasks), [data?.turns]);
  const palette = (
    <WorkbotCommandPalette
      name={data?.name ?? "Workbot"}
      tab={tab}
      tabs={paletteTabs(host)}
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
      onOpenFiles={filesEnabled ? () => { if (!workspaceShell && tab !== "home") setTab("home"); setFilesOpen(true); } : null}
      tasks={paletteTasks}
      onFocusComposer={data ? focusComposer : null}
      onShowTask={showTask}
      homeHref={host.homeHref}
      connectionsHref={host.connectionsHref ?? null}
    />
  );
  const dragging = useFileDrop(filesEnabled, addFiles);

  useEffect(() => {
    if (greetingAwaited && (start.isError || start.data?.started === false || (data?.turns.length ?? 0) > 0)) setGreetingAwaited(false);
  }, [data, greetingAwaited, start.isError, start.data]);
  useEffect(() => {
    if (welcome === "pending" && data) setWelcome(needsWelcome(data.turns) && pending.length === 0 ? "showing" : "done");
  }, [data, welcome, pending.length]);
  // Once they're past the welcome, remember it for this conversation's hello, so a reload doesn't show it again.
  useEffect(() => {
    const hello = data?.turns[0];
    if (welcome === "done" && hello?.greeting && hello.sentAt) rememberWelcomed(hello.sentAt);
  }, [data, welcome]);

  // Acceptance is witnessed by the server conversation, not by hiding/recreating local messages.
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
  // `plain`: a request about how Workbot works (Show me, Carry on without me), never tied to the open view or a teaching
  // step (a message with view context runs read-only, without the computer it is asking about), and leaving the draft
  // being typed alone.
  const submit = (text: string, retry?: Pending, runSkill = false, plain = false) => {
    if (retry) { sendPending(retry.id, true); return; }
    const trimmed = text.trim();
    if (!trimmed && (plain || draft.uploads.length === 0)) return;
    // A teaching note or skill run carries its own browser snapshot.
    const parsed = workbotViewContextSchema.safeParse(includeContext && !plain && !runSkill && !teaching ? currentContext : undefined);
    const context = parsed.success && shares(parsed.data) ? parsed.data : undefined;
    const id = composerState.enqueue({ id: newMessageId(), text: trimmed, context, keepDraft: plain, ...(!runSkill && !plain && teaching ? { teachingId: teaching.id, teachingStepId: teaching.stepId } : {}) });
    const delivery = sendPending(id);
    if (runSkill) return delivery.then(() => {
      const failure = composerState.getSnapshot().pending.find(entry => entry.id === id)?.failed;
      if (failure) throw new Error(failure);
    });
  };

  /** Failed answer retries are reported on their original message. Unaccepted sends stay with their pending owner. */
  const [editErrors, setEditErrors] = useState<Readonly<Record<string, Error | string>>>({});

  /** A correction is an ordinary new message. Earlier messages and answers stay truthful and recoverable. */
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
    const busy = data?.status === "busy" || pending.some(entry => !entry.failed);
    const empty = !loading && !data?.turns.length && !pending.length;
    const starting = empty && (start.isPending || greetingAwaited);
    const conversation = data || loading ? <Conversation
      turns={data?.turns ?? []} loading={loading}
      canChange={!busy} onEdit={editTurn} editErrors={editErrors} pending={pending} live={stream.live}
      hasEarlier={data?.hasEarlier ?? false} earlierLimit={turnWindow >= MAX_TURNS && !thread.isPlaceholderData} loadingEarlier={thread.isFetching && thread.isPlaceholderData}
      onLoadEarlier={() => setTurnWindow(earlierWindow)}
      onRetry={entry => submit(entry.text, entry)}
      onRetryTurn={turn => {
        if (turn.greeting) { setGreetingAwaited(true); start.mutate(); return; }
        // A retry may ask again; what it asked before is never replayed.
        for (const receipt of turn.navigation) followed.current.add(receipt.id);
        sentFrom.current.set(turn.id, viewRef.current);
        retry.mutate(turn.id, { onSuccess: () => setEditErrors(current => { const next = { ...current }; delete next[turn.id]; return next; }), onError: error => setEditErrors(current => ({ ...current, [turn.id]: error })) });
      }}
      onSuggestion={text => submit(text)} onSwitch={text => submit(text, undefined, false, true)} starting={starting} intro={null}
    /> : null;
    const composer = <WorkbotComposer teaching={teaching} text={draft.text} onText={composerState.setText} name={name} busy={busy} stopping={stop.isPending} filesEnabled={filesEnabled} nativeDictation={host.nativeDictation}
      uploads={uploads.uploads} onFiles={addFiles} onRemoveUpload={uploads.remove} onRetryUpload={uploads.retry}
      onSend={text => submit(text)} onStop={() => stop.mutate()} autoFocus={false} disabled={!data && !loading} />;
    const firstName = user?.name?.trim().split(/\s+/)[0] ?? null;
    const home = !data && !loading ? <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 text-center text-[13px] text-[var(--wb-muted)]" role="status"><p>Couldn't load your conversation.</p><button type="button" className="rounded-lg px-3 py-2 underline focus-visible:shadow-[var(--wb-focus)]" onClick={() => void thread.refetch()}>Try again</button></div>
      : welcome === "showing" ? <Welcome name={name} firstName={firstName} onBegin={() => { if (start.isIdle) { setGreetingAwaited(true); start.mutate(); } }} onDone={() => setWelcome("done")} />
      : data && empty && side ? <SideChatStart name={name} organizationName={data.organizationName}>{composer}</SideChatStart>
      : data && empty && !starting ? <FirstOpen name={name} organizationName={data.organizationName} firstName={firstName} onSuggestion={text => submit(text)} error={start.isError ? start.error instanceof WorkbotSendError && start.error.accessReason ? <AccessRecovery reason={start.error.accessReason} onRetry={() => { setGreetingAwaited(true); start.mutate(); }} /> : <ErrorLine action={{ label: "Try again", onClick: () => { setGreetingAwaited(true); start.mutate(); } }}>{HELLO_FAILED}</ErrorLine> : null}>{composer}</FirstOpen>
      : <>{conversation}<div className="flex shrink-0 justify-center px-3 pb-4 pt-3"><div className={COLUMN}>{composer}</div></div></>;
    return <OpenFileContext.Provider value={setPreview}>
      <OpenDocumentContext.Provider value={tab === "documents" && documentContext?.kind === "document" ? documentContext.fileId : null}>
      <WorkspaceNavigationContext.Provider value={host.workspaceAssistant && host.documents ? navigateFromChat : null}>
      <ComputerNavigationContext.Provider value={navigateComputerFromChat}>
      <ComputerOnScreenContext.Provider value={tab === "computer" ? computerView : null}>
      <DocumentNavigationContext.Provider value={guided && host.documents ? { status: navigationStatus, open: followNavigation } : null}>
        <div className="workbot flex h-dvh flex-col bg-[var(--wb-bg)] antialiased" data-workbot-workspace>
          <WorkbotHeader name={name} organizationName={data?.organizationName ?? ""} userName={user?.name ?? null} answered={hasAnsweredTurn(data?.turns)} search={palette}
            files={filesEnabled ? <FilesButton open={filesOpen} onOpen={() => setFilesOpen(true)} /> : null}
            chats={host.workspaceAssistant ? <WorkspaceMenu page={tab} onPage={setTab} onDocument={navigateDocument} drafts={documentsDirty} onChats={navigation?.openChats} /> : navigation ? <ChatsButton onOpen={navigation.openChats} /> : null}
            nav={host.workspaceAssistant ? null : <WorkbotNav tab={tab} onTab={setTab} />}
            remove={navigation?.chat && data && data.turns.length > 0 ? <RemoveChatButton disabled={documentsDirty} chatId={navigation.chat} title={navigation.title} onRemoved={() => { composerState.dispose(); navigation.openChat(null); }} /> : null}
            title={navigation?.chat ? <SideChatTitle title={navigation.title} disabled={documentsDirty} onBack={() => navigation.openChat(null)} /> : undefined}
          />
          <div className="flex min-h-0 min-w-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col" style={{ display: tab === "home" ? undefined : "none" }} hidden={tab !== "home"}>{home}</div>
          <div className="flex min-h-0 min-w-0 flex-1 border-t border-[var(--wb-hairline)]" style={{ display: tab === "documents" ? undefined : "none" }} hidden={tab !== "documents"}>
            {(documentsVisited || tab === "documents") && <WorkbotDocuments onDirtyChange={reportDocumentDirty} onContextChange={setDocumentContext} openDocument={openDocument} onOpenSettled={settleNavigation} />}
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 border-t border-[var(--wb-hairline)]" style={{ display: tab === "calendar" ? undefined : "none" }} hidden={tab !== "calendar"}>
            {host.calendar && (calendarVisited || tab === "calendar") && <WorkbotCalendar connectionsHref={host.connectionsHref ?? null} assistantName={name} onContextChange={setCalendarContext} />}
          </div>
          <div className="flex min-h-0 min-w-0 flex-1" style={{ display: tab === "computer" ? undefined : "none" }} hidden={tab !== "computer"}>
            {computerVisited && computerViews(host).length > 0 && <WorkbotComputer key={`${host.identity?.organizationId}:${host.identity?.principalId}`} onTeachingChange={setTeaching} onRun={text => submit(text, undefined, true)} canTeach={!side} onViewChange={setComputerView} onContextChange={setBrowserContext} />}
          </div>
          </div>
          {previewFile && <PreviewPanel file={previewFile} onClose={() => setPreview(null)} />}
          </div>
          <div hidden={!(host.workspaceAssistant || host.browserDemonstrations && tab === "computer") || tab === "home"}><WorkspaceAssistant name={name} context={currentContext} includeContext={includeContext} onIncludeContext={setIncludeContext}
            composer={composer} conversation={conversation} onDocument={navigateFromChat} onComputer={navigateComputerFromChat} unavailable={!data && !loading} active={(host.workspaceAssistant === true || host.browserDemonstrations === true && tab === "computer") && tab !== "home"}
            reveal={revealChat} stayOpen={guided} /></div>
          {filesEnabled && <FilesPanel open={filesOpen} onClose={() => setFilesOpen(false)} assistantName={name} onOpenFile={file => { setFilesOpen(false); setPreview(file); }} />}
        </div>
      </DocumentNavigationContext.Provider>
      </ComputerOnScreenContext.Provider>
      </ComputerNavigationContext.Provider>
      </WorkspaceNavigationContext.Provider>
      </OpenDocumentContext.Provider>
    </OpenFileContext.Provider>;
  }
  if ((tab === "calendar" && host.calendar) || tab === "documents" || (tab === "computer" && computerViews(host).length > 0)) {
    return (
      <div className="workbot flex h-dvh flex-col bg-[var(--wb-bg)] antialiased">
        <WorkbotHeader
          name={data?.name ?? "Workbot"}
          organizationName={data?.organizationName ?? ""}
          userName={user?.name ?? null}
          files={null}
          nav={<WorkbotNav tab={tab} onTab={setTab} />}
          answered={hasAnsweredTurn(data?.turns)}
          search={palette}
        />
        {leavingDocuments && <div className="border-t border-[var(--wb-hairline)] px-4 py-2 text-[13px]" role="status">You have unsaved document edits. <button type="button" className="ml-3 underline" onClick={() => setLeavingDocuments(null)}>Keep editing</button><button type="button" className="ml-3 underline" onClick={() => { const next = leavingDocuments; setLeavingDocuments(null); setDocumentsDirty(false); setTab(next, true); }}>Discard edits and leave Documents</button></div>}
        <div className="flex min-h-0 flex-1 border-t border-[#01162712]">
          {tab === "computer" ? <WorkbotComputer key={`${host.identity?.organizationId}:${host.identity?.principalId}`} onTeachingChange={setTeaching} onRun={text => submit(text, undefined, true)} canTeach={!side} /> : tab === "documents" ? <WorkbotDocuments onDirtyChange={setDocumentsDirty} /> : <WorkbotCalendar connectionsHref={host.connectionsHref ?? null} assistantName={data?.name ?? "Workbot"} />}
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

  // Until the conversation is first read, the page is drawn around an empty one: the message box works, a message
  // sent shows straight away, and the thread fills in when it arrives.
  const shown = data ?? LOADING_THREAD;
  const busy = shown.status === "busy" || pending.some((entry) => !entry.failed);
  const empty = !loading && shown.turns.length === 0 && pending.length === 0;
  const firstName = user?.name?.trim().split(/\s+/)[0] ?? null;
  if (!loading && (welcome === "showing" || (welcome === "pending" && pending.length === 0 && needsWelcome(shown.turns)))) {
    return (
      <Welcome
        name={shown.name}
        firstName={firstName}
        // Start only after the person finishes or skips connecting their apps.
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
  // Right after the welcome: the conversation, with Workbot typing its hello. If that can't start, the drawn greeting.
  const starting = empty && (start.isPending || (greetingAwaited && start.data?.started === true));
  const composer = (
    <WorkbotComposer
      nativeDictation={host.nativeDictation}
      text={draft.text}
      onText={composerState.setText}
      name={shown.name}
      busy={busy}
      stopping={stop.isPending}
      filesEnabled={filesEnabled}
      uploads={uploads.uploads}
      onFiles={addFiles}
      onRemoveUpload={uploads.remove}
      onRetryUpload={uploads.retry}
      onSend={(text) => submit(text)}
      onStop={() => stop.mutate()}
    />
  );

  const chatId = navigation?.chat ?? null;
  return (
    <OpenFileContext.Provider value={setPreview}>
    <div className="workbot flex h-dvh flex-col bg-[var(--wb-bg)] antialiased">
      <WorkbotHeader
        name={shown.name}
        organizationName={shown.organizationName}
        userName={user?.name ?? null}
        files={filesEnabled ? <FilesButton open={filesOpen} onOpen={() => setFilesOpen(true)} /> : null}
        chats={navigation && !chatId ? <ChatsButton onOpen={navigation.openChats} /> : null}
        title={navigation && chatId ? <SideChatTitle title={navigation.title} onBack={() => navigation.openChat(null)} /> : null}
        remove={navigation && chatId && shown.turns.length > 0 ? <RemoveChatButton chatId={chatId} title={navigation.title} onRemoved={() => { composerState.dispose(); navigation.openChat(null); }} /> : null}
        nav={!chatId ? <WorkbotNav tab={tab} onTab={setTab} /> : null}
        answered={hasAnsweredTurn(shown.turns)}
        search={palette}
      />
      <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
          <Conversation
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
              // The same message is answered again in place, so the conversation keeps one copy of it.
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
                    // A hello that failed before writing anything leaves the drawn greeting in its place, the same
                    // as one that couldn't start; its turn then adds only the line saying it didn't work.
                    const helloFailed = hello?.greeting === true && hello.status === "failed" && !hello.parts.some((part) => part.kind === "text");
                    const followed = starting || (hello?.greeting === true && !helloFailed);
                    // A side chat has no greeting: the person spoke first. In the main chat the drawn hello stays while
                    // Workbot fills in their day.
                    const spoken = side;
                    // Workbot's own hello carries the time; the drawn greeting brings its own.
                    return { at: spoken ? 0 : at, joined: helloFailed, node: <Intro name={shown.name} organizationName={shown.organizationName} firstName={firstName} at={at} spoken={spoken} followed={followed} /> };
                  })()
            }
          />
          <div className="flex shrink-0 justify-center px-3 pb-3 pt-3 sm:px-10 sm:pb-7">
            <div className={COLUMN}>
              {composer}
            </div>
          </div>
        </>
      )}
      </div>
      {previewFile ? <PreviewPanel file={previewFile} onClose={() => setPreview(null)} /> : null}
      </div>
      {filesEnabled ? (
        <FilesPanel
          open={filesOpen}
          onClose={() => setFilesOpen(false)}
          assistantName={shown.name}
          onOpenFile={(file) => {
            setFilesOpen(false);
            setPreview(file);
          }}
        />
      ) : null}
      {dragging ? (
        <div className="pointer-events-none fixed inset-3 z-40 grid place-items-center rounded-[28px] border-2 border-dashed border-[var(--wb-disabled)] bg-[var(--wb-bg)]/85">
          <p className="flex items-center gap-2 text-[14px] font-medium text-[var(--wb-text)]"><FileText size={16} strokeWidth={1.75} aria-hidden />Drop to add to your message</p>
        </div>
      ) : null}
    </div>
    </OpenFileContext.Provider>
  );
}

const WELCOMED_KEY = "workbot.welcomed";

function rememberWelcomed(helloAt: number) {
  try {
    window.localStorage.setItem(WELCOMED_KEY, String(helloAt));
  } catch {
    // Storage off: the welcome may show again after a reload, which is harmless.
  }
}

/**
 * The welcome shows until the person is past it: nothing from them in the conversation yet, and either no hello yet
 * or a hello they haven't been welcomed for (it started in the background while they were on the welcome, and a
 * reload must not skip it). Clearing the conversation brings it back, since the next hello is a new one.
 */
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

/** The conversation as it's drawn before its first read: Workbot's default name, nothing in it yet. */
const LOADING_THREAD: Extract<WorkbotThread, { available: true }> = { available: true, name: "Workbot", organizationName: "", status: "idle", turns: [], hasEarlier: false, filesEnabled: false };

/** Where the thread will be while it is first read: a few lines in the shape of a conversation. */
function ThreadPlaceholder() {
  return (
    <div className="flex flex-col gap-[3px] pb-8" role="progressbar" aria-busy="true" aria-label="Loading conversation">
      <span className="ml-auto h-[38px] w-48 rounded-[20px] rounded-br-md bg-[var(--wb-bubble)]" />
      <span className="mt-3.5 h-6 w-40 rounded bg-[var(--wb-chip)]" />
      <span className="mt-1.5 h-24 w-[70%] rounded-[20px] rounded-bl-md bg-[var(--wb-surface)] shadow-[var(--wb-card-shadow)]" />
    </div>
  );
}

/** The OpenWork mark: Workbot is OpenWork's assistant, so it wears OpenWork's mark rather than a monogram tile. */
function Mark({ size }: { name: string; size: "header" | "hero" }) {
  return (
    <OpenWorkMark width={size === "hero" ? 36 : 16} height={size === "hero" ? 45 : 20} className="shrink-0" />
  );
}

function useConnectedApps() {
  return workbotHost().useConnectedApps();
}

type WorkbotTab = WorkbotPaletteTab;

/** The pages this person has, in the header's order. */
function paletteTabs(host: WorkbotHost): WorkbotTab[] {
  return ["home", ...(host.calendar ? ["calendar" as const] : []), ...(host.documents ? ["documents" as const] : []), ...(computerViews(host).length ? ["computer" as const] : [])];
}

/** Puts the caret in the message box on screen (the Home composer, or the workspace chat's). */
function focusComposer() {
  for (const box of document.querySelectorAll<HTMLTextAreaElement>("[data-workbot-composer] textarea")) {
    if (box.offsetParent !== null && !box.disabled) { box.focus(); return; }
  }
}

/** Brings a background task's card into view and onto its own action (Stop, Try again). */
function showTask(taskId: string) {
  const card = document.querySelector<HTMLElement>(`[data-workbot-task="${CSS.escape(taskId)}"]`);
  if (!card) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  card.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  card.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
}

function tabFromLocation(): WorkbotTab {
  const path = typeof window !== "undefined" ? window.location.pathname.replace(/\/+$/, "") : "";
  return path === "/computer" || path === "/browser" || path.startsWith("/browser/") ? "computer" : path === "/documents" ? "documents" : path === "/calendar" ? "calendar" : "home";
}

/** Home (the conversation) and Calendar, as paths so a reload or a shared link opens the same tab. */
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
    // The Computer tab opens on its Browser view, which has its own path (see WorkbotComputer).
    window.history.pushState(null, "", `${next === "home" ? "/" : next === "computer" ? "/browser" : `/${next}`}${preserveSearch ? window.location.search : ""}`);
    setTabState(next);
  };
  return [tab, setTab] as const;
}

/** Paper v3: Home / Calendar beside the name; the open tab sits on a soft chip. */
function WorkbotNav({ tab, onTab }: { tab: WorkbotTab; onTab: (tab: WorkbotTab) => void }) {
  return (
    <nav className="ml-4 flex items-center gap-0.5" aria-label="Workbot">
      {(["home", ...(workbotHost().calendar ? ["calendar" as const] : []), ...(workbotHost().documents ? ["documents" as const] : []), ...(computerViews(workbotHost()).length ? ["computer" as const] : [])] as const).map((entry) => (
        <button
          key={entry}
          type="button"
          aria-current={tab === entry ? "page" : undefined}
          onClick={() => onTab(entry)}
          className={`flex h-8 items-center rounded-lg px-3 text-[13px] leading-4 transition-colors duration-150 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] ${tab === entry ? "bg-[#EDF0F2] font-semibold text-[#11181C]" : "font-medium text-[#687076] hover:text-[#11181C]"}`}
        >
          {entry === "home" ? "Home" : entry === "calendar" ? "Calendar" : entry === "documents" ? "Documents" : "Computer"}
        </button>
      ))}
    </nav>
  );
}

function WorkbotHeader(props: {
  name: string;
  organizationName: string;
  userName: string | null;
  files: ReactNode;
  /** Opens the list of chats, before the name (main chat, where side chats are on). */
  chats?: ReactNode;
  /** Replaces the mark and name: a side chat's back button and name. */
  title?: ReactNode;
  /** Removes the side chat on screen. */
  remove?: ReactNode;
  /** Home / Calendar, after the name (where the Calendar is on). */
  nav?: ReactNode;
  /** Whether an answer to the person has finished, for the Get set up chip (shown only after the first answer). */
  answered?: boolean;
  /** The command palette's button (and the palette), where it is on. */
  search?: ReactNode;
}) {
  const { name, organizationName, userName, files } = props;
  const apps = useConnectedApps();
  const names = apps.map((app) => app.name);
  return (
    <header className="flex h-13 shrink-0 items-center justify-between gap-3 px-4 sm:px-5">
      {props.title ? <div className="flex min-w-0 items-center gap-2">{props.chats}{props.title}{props.nav}</div> : (
        <div className="flex min-w-0 items-center gap-2" title={organizationName}>
          {props.chats}
          <Mark name={name} size="header" />
          <h1 className="truncate text-[15px] font-semibold leading-5 tracking-[-0.015em] text-[var(--wb-text)]">{name}</h1>
          {props.nav}
        </div>
      )}
      <div className="flex shrink-0 items-center gap-2.5 sm:gap-3.5">
        {props.search}
        {props.remove}
        <WorkbotSetupChip answered={props.answered === true} />
        {files}
        {apps.length > 0 ? (
          <span className="flex h-7 items-center gap-[7px] rounded-full bg-[var(--wb-chip)] pl-2 pr-2.5" title={names.join(", ")} aria-label={`Connected: ${names.join(", ")}`}>
            {apps.slice(0, 4).map((app) => <AppMark key={app.id} name={app.name} />)}
            <span className="hidden max-w-[220px] truncate pl-0.5 text-[12px] leading-4 text-[var(--wb-muted)] sm:inline">{names.join(", ")}</span>
          </span>
        ) : null}
        <a
          href={workbotHost().homeHref}
          aria-label="Your dashboard"
          className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--wb-ink)] text-[11px] font-semibold tracking-[0.02em] text-[var(--wb-on-ink)] transition-opacity duration-150 hover:opacity-85 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
        >
          {initials(userName)}
        </a>
      </div>
    </header>
  );
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

/**
 * Who Workbot is and its greeting: on the first open, and afterwards at the top of the conversation, so the hello
 * the person read doesn't vanish when they reply (DESIGN P11).
 */
/** `followed`: Workbot's own hello comes after the drawn one, so that hello asks the question instead. */
function Intro(props: { name: string; organizationName: string; firstName: string | null; at: number; spoken?: boolean; followed?: boolean }) {
  const apps = useConnectedApps().map((app) => app.name);
  const seeing = apps.length === 0 ? null : apps.length === 1 ? apps[0] : `${apps.slice(0, -1).join(", ")} and ${apps.at(-1)}`;
  const hour = new Date(props.at).getHours();
  const hello = hour < 12 ? "Morning" : hour < 18 ? "Hi" : "Evening";
  return (
    <>
      <div className="flex flex-col items-center gap-1.5 pb-7">
        <Mark name={props.name} size="hero" />
        <span className="pt-1 text-[15px] font-semibold leading-[18px] text-[var(--wb-text)]">{props.name}</span>
        <span className="text-[12px] leading-4 text-[var(--wb-muted)]">Set up by {props.organizationName}</span>
      </div>
      {/* When Workbot wrote its own hello, that message follows; only the drawn greeting needs the lines here. */}
      {props.spoken ? null : (
        <div className="flex flex-col gap-[3px]">
          <Timestamp at={props.at} />
          <div className="flex">
            <p className="max-w-[520px] rounded-[20px] rounded-bl-md bg-[var(--wb-surface)] px-4 py-2.5 text-[15px] leading-[22px] text-[var(--wb-text)] shadow-[var(--wb-card-shadow)]">
              {hello}{props.firstName ? ` ${props.firstName}` : ""}.{seeing ? ` I can already see your ${seeing}.` : ""}
            </p>
          </div>
          {props.followed ? null : (
            <div className="flex">
              <p className="max-w-[520px] rounded-[20px] rounded-tl-md bg-[var(--wb-surface)] px-4 py-2.5 text-[15px] leading-[22px] text-[var(--wb-text)] shadow-[var(--wb-card-shadow)]">
                What can I take off your plate today?
              </p>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Screen 1: the assistant, who set it up, its greeting as its own bubbles, starters, the composer — one centered group. */
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
      <div className={`${COLUMN} flex flex-col gap-1`}>
        <Intro name={props.name} organizationName={props.organizationName} firstName={props.firstName} at={now} />
        {/* A hello that couldn't start says so right under the greeting, where the hello would have been. */}
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

/** A new side chat, before its first message: who the person is talking to, then the composer. */
function SideChatStart(props: { name: string; organizationName: string; children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto px-4 pb-18 sm:px-10">
      <div className={`${COLUMN} flex flex-col gap-1`}>
        <div className="flex flex-col items-center gap-1.5 pb-7">
          <Mark name={props.name} size="hero" />
          <span className="pt-1 text-[15px] font-semibold leading-[18px] text-[var(--wb-text)]">{props.name}</span>
          <span className="text-[12px] leading-4 text-[var(--wb-muted)]">Set up by {props.organizationName}</span>
        </div>
        {props.children}
      </div>
    </div>
  );
}

/** `pending`: a message the conversation doesn't have yet; `turn` is then that message as the turn it becomes. */
type Row = { key: string; at: number; turn: WorkbotTurn; pending: Pending | null };

/** A new timestamp shows when the day changes or after a quiet hour, like a messaging app. */
function showsTimestamp(previous: { at: number } | undefined, row: { at: number }) {
  if (!row.at) return false;
  if (!previous?.at) return true;
  return new Date(previous.at).toDateString() !== new Date(row.at).toDateString() || row.at - previous.at > 60 * 60_000;
}

function Conversation(props: {
  turns: WorkbotTurn[];
  /** The conversation hasn't been read yet: a placeholder stands where it will be, above anything just sent. */
  loading?: boolean;
  pending: Pending[];
  live: Record<string, LiveText>;
  hasEarlier: boolean;
  earlierLimit: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  onRetry: (entry: Pending) => void;
  onRetryTurn: (turn: WorkbotTurn) => void;
  /** The greeting, kept above the first message once the start of the conversation is loaded. */
  /** `joined`: the next row is the failed hello's line, which sits right under the greeting as on the first open. */
  intro: { at: number; joined: boolean; node: ReactNode } | null;
  onSuggestion: (text: string) => void;
  /** Asks Workbot to show its work on screen or carry on without the person, without the open view's context. */
  onSwitch: (text: string) => void;
  /** Workbot is about to say hello (right after the welcome). */
  starting: boolean;
  /** Whether the person's messages can be edited now (not while Workbot is answering). */
  canChange: boolean;
  onEdit: (turn: WorkbotTurn, text: string) => void;
  /** Why an edit of a message didn't go through, by message id. */
  editErrors: Readonly<Record<string, Error | string>>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const known = new Set(props.turns.map((turn) => turn.id));
  // A pending message and its turn share a key and both show as a TurnView, so neither the bubble nor the dots under it
  // re-mount when the turn arrives.
  const rows: Row[] = [
    ...props.turns.map((turn) => ({ key: turn.id, at: turn.sentAt ?? 0, turn, pending: null })),
    ...props.pending.filter((entry) => !known.has(entry.id)).map((entry) => ({ key: entry.id, at: entry.sentAt, turn: pendingTurn(entry), pending: entry })),
  ];
  const lastTurnId = props.turns.at(-1)?.id;
  // One indicator, at the end of the thread, says a reply is on its way and none of it shows yet. Background tasks
  // show their progress on their own cards, and streamed text or a running step already shows Workbot at work, so
  // neither keeps the dots. Uploading files say so instead.
  // Each message keeps its own waiting place where its answer will appear (TurnView, PendingView); only a hello that
  // hasn't reached the conversation yet shows its dots here.
  const typing = useSettled(props.starting, 350);
  // A follow-up interrupts the answer before it: the newest message is answered next.
  const unsent = props.pending.filter((entry) => !known.has(entry.id) && !entry.failed);
  const lastPending = unsent.at(-1)?.id ?? null;
  // Only the newest of Workbot's words may still be revealing, so two messages are never being written at once.
  const newestText = [...props.turns].reverse().find((turn) => turn.parts.some((part) => part.kind === "text") || Boolean(props.live[turn.id]?.text))?.id ?? null;
  // Local previews keep a just-sent image on screen while its kept copy loads.
  const localUrls = useMemo(() => {
    const urls: Record<string, string | null> = {};
    for (const entry of props.pending) for (const upload of entry.uploads) if (upload.saved) urls[upload.saved.id] = upload.previewUrl;
    return urls;
  }, [props.pending]);
  const previews = useRef<Record<string, string | null>>({});
  Object.assign(previews.current, localUrls);

  // Follow new content (including streamed text) only while the person is at the bottom.
  useLayoutEffect(() => {
    const node = scroller.current;
    const inner = content.current;
    if (!node || !inner) return;
    const follow = () => {
      if (pinned.current) node.scrollTop = node.scrollHeight;
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  // Earlier messages arrive above what the person is reading: unless they're following the newest message, the row
  // that was first stays where it was on screen, and what arrived is above it to scroll up to. Its bottom is kept,
  // since a timestamp above its message goes once an earlier message from the same hour is above it.
  const anchor = useRef<{ key: string; offset: number } | null>(null);
  const firstKey = rows[0]?.key;
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const offset = (key: string) => {
      const row = node.querySelector(`[data-workbot-row="${CSS.escape(key)}"]`);
      return row ? row.getBoundingClientRect().bottom - node.getBoundingClientRect().top + node.scrollTop : null;
    };
    const previous = anchor.current;
    const moved = previous && !pinned.current ? offset(previous.key) : null;
    if (previous && moved !== null && moved !== previous.offset) node.scrollTop += moved - previous.offset;
    const top = firstKey === undefined ? null : offset(firstKey);
    anchor.current = firstKey === undefined || top === null ? null : { key: firstKey, offset: top };
  });

  // Sending always brings the conversation back to the newest message.
  const pendingCount = props.pending.length;
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node || pendingCount === 0) return;
    pinned.current = true;
    node.scrollTop = node.scrollHeight;
  }, [pendingCount]);

  return (
    <div
      ref={scroller}
      className="workbot-scroll flex-1 overflow-y-auto [overflow-anchor:none]"
      onScroll={(event) => {
        const node = event.currentTarget;
        pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
      }}
    >
      <div ref={content} className="flex min-h-full flex-col items-center justify-end px-4 pb-2 pt-6 sm:px-10">
        <div className={`${COLUMN} flex flex-col`}>
          {props.loading ? <ThreadPlaceholder /> : props.hasEarlier && props.earlierLimit ? (
            <p className="mb-6 text-center text-[12px] text-[var(--wb-muted)]" role="status">History limit reached. Earlier messages aren&apos;t available here.</p>
          ) : props.hasEarlier ? (
            <button
              type="button"
              onClick={() => {
                pinned.current = false;
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
              // The greeting has its own time; the first message only gets one after a quiet hour or a new day.
              const previous = rows[index - 1] ?? (props.intro?.at ? { at: props.intro.at } : undefined);
              const stamp = showsTimestamp(previous, row);
              return (
                <li key={row.key} data-workbot-row={row.key} className={`flex flex-col gap-1 ${index > 0 ? (stamp ? "pt-9" : "pt-8") : stamp && props.intro ? "pt-1" : ""}`}>
                  {stamp ? <Timestamp at={row.at} /> : null}
                  <TurnView
                    canChange={props.canChange}
                    onEdit={props.onEdit}
                    editError={row.pending ? null : (props.editErrors[row.turn.id] ?? null)}
                    turn={row.turn}
                    pending={row.pending}
                    live={row.pending ? null : (props.live[row.turn.id] ?? null)}
                    // A message still sending is answered next when it is the newest one waiting.
                    latest={row.pending ? row.pending.id === lastPending : row.turn.id === lastTurnId && props.pending.every((entry) => known.has(entry.id))}
                    newestText={row.turn.id === newestText}
                    previews={previews.current}
                    onRetry={() => (row.pending ? props.onRetry(row.pending) : props.onRetryTurn(row.turn))}
                    onSuggestion={props.onSuggestion}
                    onSwitch={props.onSwitch}
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
  );
}

/**
 * Workbot's reaction to a message: one emoji in the system's own emoji font, pinned to the message's corner like a
 * messaging app's tapback. It pops in once when it arrives (no bounce; none for reduced motion, DESIGN V6).
 */
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
    <div className="flex justify-end">
      <div className="group/own relative max-w-[85%] sm:max-w-[480px]">
        {visible.correction && <div className="mb-1 px-3 text-[12px] text-[var(--wb-muted)]" data-workbot-correction-reference>
          <p>Correction to your message{visible.correction.sentAt !== null ? ` from ${new Date(visible.correction.sentAt).toLocaleString()}` : ""}</p>
          {visible.correction.quote && <blockquote className="line-clamp-3 border-l-2 border-[var(--wb-hairline)] pl-2" title={visible.correction.quote}>{visible.correction.quote}{visible.correction.quote.length === 1000 ? "…" : ""}</blockquote>}
        </div>}
        <p className={`whitespace-pre-wrap break-words rounded-[20px] bg-[var(--wb-user-bubble)] px-4 py-2.5 text-[15px] leading-[22px] text-[var(--wb-text)] transition-opacity duration-150 ${muted ? "opacity-60" : ""}`}>
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

/**
 * With a mouse, a message's action waits in the gutter beside the bubble until hover or keyboard focus. Touch can't
 * hover, so there it rests under the bubble's trailing edge, clear of the reaction on the top-left corner.
 */
const ownAction =
  "absolute -left-8 top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover/own:opacity-100 has-[:focus-visible]:opacity-100 [@media(hover:none)]:static [@media(hover:none)]:mt-1 [@media(hover:none)]:flex [@media(hover:none)]:h-7 [@media(hover:none)]:translate-y-0 [@media(hover:none)]:items-center [@media(hover:none)]:justify-end [@media(hover:none)]:opacity-100";

/**
 * Edit for the person's own message. It stays in place, dimmed, while it can't be used (a reply is running or the
 * message is still sending), so the conversation never shifts when it becomes available. On touch the 28px icon
 * gets a 44px tap target without taking more room.
 */
function EditButton({ disabled, onClick }: { disabled: boolean; onClick?: () => void }) {
  return (
    <button type="button" aria-label="Correct message" title="Send a correction" disabled={disabled} onClick={onClick} className={`${iconButton} disabled:hover:bg-transparent disabled:hover:text-[var(--wb-muted)] [@media(hover:none)]:-my-2 [@media(hover:none)]:-mr-2 [@media(hover:none)]:size-11`}>
      <Pencil size={14} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

/** Edit appears beside its own message on hover or keyboard focus (at rest under it on touch), without a delete action. */
function OwnMessage(props: {
  turn: WorkbotTurn;
  canChange: boolean;
  onEdit: (turn: WorkbotTurn, text: string) => void;
  /** Why the last edit of this message didn't go through. */
  error: string | null;
  /** A message that didn't send: dimmed, without Edit (Send again sits under it). */
  failed?: boolean;
}) {
  const { turn, error } = props;
  const originalText = readWorkbotCorrectionPrompt(turn.text).text;
  const [mode, setMode] = useState<"idle" | "editing">("idle");
  const [draft, setDraft] = useState(originalText);
  const field = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const element = field.current;
    if (mode !== "editing" || !element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
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
              } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                save();
              }
            }}
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

/** Copies one of Workbot's answers, with a moment of "Copied" to say it worked. */
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

/**
 * Workbot's words in a chat bubble on the left: white on the page with a hairline, so its answers and the person's
 * grey bubbles on the right read as two sides of one conversation. It hugs short replies and stops at a readable
 * width; wide tables and code scroll inside it.
 */
function AssistantBubble({ children, trailing = null }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex items-end gap-1 py-[3px]">
      <div className="flex w-fit min-w-0 max-w-full flex-col overflow-x-auto rounded-[20px] rounded-bl-md bg-[var(--wb-surface)] px-4 py-2.5 shadow-[var(--wb-card-shadow)] sm:max-w-[600px]">
        {children}
      </div>
      {trailing}
    </div>
  );
}

/**
 * The place Workbot's next words will take, one message line tall (a one-line bubble: its line of text, padding and
 * spacing). It shows the typing dots, the app step running right now, or nothing for a moment; its height never
 * changes, so whatever comes next replaces what was there without moving the conversation (DESIGN P11).
 */
function WaitingSlot({ children }: { children?: ReactNode }) {
  return <div className="flex h-12.5 shrink-0 flex-col">{children}</div>;
}

/**
 * Workbot writing a reply that doesn't show yet: one small reply bubble with three dots that darken in turn, like a
 * messaging app's typing indicator. Nothing else moves (DESIGN V6, P11).
 */
function TypingDots() {
  return (
    <div className="workbot-row-enter flex py-[3px]" role="status" aria-label="Workbot is processing">
      <div className="flex h-9 items-center gap-[5px] rounded-[20px] rounded-bl-md bg-[var(--wb-surface)] px-4 shadow-[var(--wb-card-shadow)]">
        <span aria-hidden className="workbot-typing-dot" />
        <span aria-hidden className="workbot-typing-dot" />
        <span aria-hidden className="workbot-typing-dot" />
      </div>
    </div>
  );
}

/** Both ways Workbot's hello can fail read the same: the drawn greeting stays, and this one line says what didn't. */
const HELLO_FAILED = "I couldn't check your day just now.";

/**
 * A failure, inline where it happened (DESIGN T2, C6): what didn't work in one short line and, when there is one, the
 * next step as a quiet button. The red mark says it's a failure without turning the sentence into an alarm (C5); it
 * eases in like any other new row and is announced politely.
 */
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

/**
 * A message not in the conversation yet, as the turn it becomes: queued, with nothing answered. TurnView shows both,
 * so the bubble, Edit's place and the waiting dots stay the same elements when the turn arrives.
 */
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

/** Ticks once a second while mounted. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * Workbot's computer: a slim laptop with a soft blue screen whose two lines write themselves while it works.
 * Sized for the 16px slot (DESIGN V5); the motion stops for reduced motion (V6).
 */
/** Workbot's computer; its screen "writes" only while it is working (V6). */
function ComputerGlyph({ working = true }: { working?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} fill="none" className={`workbot-computer ${working ? "is-working" : ""}`}>
      <rect x="2.25" y="3" width="11.5" height="8" rx="1.75" className="workbot-computer-screen" strokeWidth={1.25} />
      <path d="M1.5 13h13" className="workbot-computer-stand" strokeWidth={1.25} strokeLinecap="round" />
      <path className="workbot-computer-line" d="M4.75 6h3.5" strokeWidth={1.25} strokeLinecap="round" />
      <path className="workbot-computer-line" d="M4.75 8.25h5.5" strokeWidth={1.25} strokeLinecap="round" />
    </svg>
  );
}

/**
 * A little person at Workbot's computer: while it works they type (hands tapping, head nodding along, lines
 * appearing on the screen); when it's done they sit back. Only motion that means "working" (DESIGN V6).
 */
function WorkerGlyph({ working }: { working: boolean }) {
  return (
    <svg viewBox="0 0 28 28" width={28} height={28} fill="none" className={`workbot-worker ${working ? "is-working" : ""}`}>
      {/* desk */}
      <path d="M2.5 21h23" stroke="var(--wb-computer-frame)" strokeWidth={1.25} strokeLinecap="round" />
      {/* laptop: screen and base, facing the person */}
      <rect x="14.5" y="12.25" width="10.5" height="7.5" rx="1.5" fill="var(--wb-computer-screen)" stroke="var(--wb-ink)" strokeWidth={1.25} />
      <path d="M13 21h12.5" stroke="var(--wb-ink)" strokeWidth={1.5} strokeLinecap="round" />
      <path className="workbot-worker-line" d="M17 15h4" stroke="var(--wb-computer-line-live)" strokeWidth={1.25} strokeLinecap="round" />
      <path className="workbot-worker-line" d="M17 17.3h5.5" stroke="var(--wb-computer-line-live)" strokeWidth={1.25} strokeLinecap="round" />
      {/* person: body, head, arm reaching to the keyboard */}
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

/** A quiet line for the page's own waiting states ("Uploading your files", "Up next"): words only. */
function QuietLine({ label }: { label: string }) {
  return (
    <p className="flex h-6 shrink-0 items-center pl-1 text-[13px] leading-4 text-[var(--wb-faint)]" role="status" aria-live="polite">
      {label}
    </p>
  );
}

/**
 * Streamed text arrives in bursts; this reveals it at a steady pace that speeds up when it falls behind,
 * so the reply reads as written rather than jumping a sentence at a time.
 */
function useSmoothText(target: string, instant = false) {
  const [shown, setShown] = useState(() => (instant ? target.length : 0));
  const shownRef = useRef(instant ? target.length : 0);
  const previous = useRef(instant ? target : "");
  useEffect(() => {
    const goal = target.length;
    // A new piece of text (the next step's) starts from its beginning; more of the same text continues.
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
      // A steady pace, as if written: about 15 frames (¼ s) to catch up with whatever has arrived, never slower than 2
      // characters a frame, so a reply stops typing soon after Workbot does.
      shownRef.current = Math.min(goal, current + Math.max(2, Math.ceil((goal - current) / 15)));
      setShown(shownRef.current);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, instant]);
  return instant ? target : target.slice(0, Math.min(shown, target.length));
}

/** `instant` shows the text in full (older words, and answers already done). A bubble keeps one line's height from its first frame. */
function StreamingText({ text, instant = false }: { text: string; instant?: boolean }) {
  const shown = useSmoothText(text, instant);
  return (
    <div className="workbot-streaming min-h-6">
      <WorkbotMarkdown text={shown} />
    </div>
  );
}



/** An app the turn used, for the "Using …" line: Workbot's computer or a connected app. */
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

/**
 * The value, but each one stays at least `minMs` before the next replaces it, so quick changes read as one calm
 * change instead of a flicker.
 */
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
    // `value` travels with `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, minMs, shown.key]);
  return shown.value;
}


/** A computer update stays at least this long, so quick commands read as one calm change. */
const UPDATE_HOLD_MS = 1_600;

/**
 * Work in connected apps between two things Workbot said, as one quiet line ("Using Gmail", then "Used Gmail"), `live`
 * while nothing has been said after it yet (DESIGN C3, T1). Work on its computer is a card of its own (computerWork).
 */
function StepsSegment({ steps, live }: { steps: WorkbotStep[]; live: boolean }) {
  const others = usedApps(steps, null).filter((app) => !app.computer);
  if (others.length === 0) return null;
  const label = `${live ? "Using" : "Used"} ${joinNames(others.map((app) => app.name))}`;
  return (
    <p
      className={`flex h-7 items-center gap-2 pl-1 text-[12.5px] leading-4 ${live ? "workbot-row-enter" : "text-[var(--wb-faint)]"}`}
      role={live ? "status" : undefined}
      aria-live={live ? "polite" : undefined}
    >
      <span aria-hidden className="flex shrink-0 items-center gap-1">
        {others.map((app) => (
          <span key={app.key} className="workbot-app-enter grid size-4 place-items-center">
            <AppMark name={app.name} size={14} />
          </span>
        ))}
      </span>
      <span key={label} className={`truncate ${live ? "workbot-shimmer text-[13px]" : ""}`}>{label}</span>
    </p>
  );
}

/** The other way of working, offered on a live card: one tap sends it as a follow-up. */
type SwitchTo = { label: string; text: string; send(text: string): void };

/** The view of Workbot's computer open on the page beside the chat, whose live screen the chat then leaves out. */
const ComputerOnScreenContext = createContext<Exclude<ComputerSurface, "background"> | null>(null);

/** Opens the full view of Workbot's browser or computer, without reloading Workbot. */
function openSurface(surface: Exclude<ComputerSurface, "background">) {
  window.history.pushState(null, "", `/${surface}${window.location.search}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * Work in Workbot's browser or on the rest of its computer, as one card: what it is doing now in its own words, and a
 * live view of its screen only while Workbot is showing it to the person (when the computer is on for them) and that
 * view isn't already open beside the chat. Other work, on the screen or in the background, is its progress notes
 * alone. The browser card links the pages it opened. `starting` is what a step not yet stored says it is doing.
 */
function SurfaceCard({ surface, steps, live, showing, others, switchTo = null, starting: startingUpdate = null }: { surface: ComputerSurface; steps: WorkbotStep[]; live: boolean; showing: boolean; others: UsedApp[]; switchTo?: SwitchTo | null; starting?: string | null }) {
  // The switch just tapped, until Workbot takes it up and the card offers the other one.
  const [asked, setAsked] = useState<string | null>(null);
  const updates = steps.flatMap((step) => step.updates);
  const latest = (live ? startingUpdate : null) ?? updates.at(-1) ?? null;
  const onScreen = useContext(ComputerOnScreenContext) === surface;
  const update = useHeld(latest, latest ?? "", UPDATE_HOLD_MS);
  const pages = steps.flatMap((step) => step.pages ?? []).filter((page, index, all) => all.findIndex((entry) => entry.id === page.id) === index);
  const views = computerViews(workbotHost());
  // Each view is its own rollout: a card shows a screen only for a view this person has. Work in the background has
  // no screen of its own, so asking to see it needs at least one.
  const watchable = surface === "background" ? views.length > 0 : views.includes(surface);
  const title = surface === "browser" ? `${live ? "Using" : "Used"} the browser`
    : surface === "background" ? `${live ? "Working" : "Worked"} on my computer`
    : `${live ? "Using" : "Used"} my computer`;
  const starting = surface === "browser" ? "Opening the browser" : surface === "background" ? "Running in the background" : "Starting up";
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
          {views.includes("browser") && pages.length > 0 ? <BrowserPageLinks pages={pages} /> : null}
        </>
      }
    />
  );
}

/** The pages Workbot opened, each opening in its Browser view (/browser/<id>). */
function BrowserPageLinks({ pages }: { pages: WorkbotPage[] }) {
  return (
    <ul aria-label="Pages Workbot opened" className="flex flex-wrap gap-1 px-2.5 pb-2.5 pt-2">
      {pages.map((page) => (
        <li key={page.id} className="min-w-0">
          <a
            href={`/browser/${page.id}${window.location.search}`}
            title={page.url}
            onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); openBrowserPage(page.id); }}
            className="inline-flex h-7 max-w-[15rem] items-center gap-1.5 rounded-full bg-[var(--wb-chip)] px-2.5 text-[12px] text-[var(--wb-text)] hover:bg-[var(--wb-bubble)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
          >
            <Globe size={12} aria-hidden className="shrink-0 text-[var(--wb-muted)]" />
            <span className="truncate">{page.title}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** The other apps a computer card's work used, as logos in its trailing slot. */
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



/** An answer as it is written, without a closing "Next:" line, which becomes buttons once the answer is done. */
function withoutNextLine(text: string) {
  const lines = text.split("\n");
  const next = lines.findIndex((line) => /^\**next\**\s*:/i.test(line.trim()));
  if (next !== -1) return lines.slice(0, next).join("\n").trimEnd();
  // A last line that may still become "Next:" waits until it can't.
  const last = lines.at(-1)?.trim().replace(/\*/g, "").toLowerCase() ?? "";
  if (last && "next:".startsWith(last)) return lines.slice(0, -1).join("\n").trimEnd();
  return text;
}

/** What of a turn's reply shows right now: its streamed text, its computer starting, or a step still running. */
function replyProgress(turn: WorkbotTurn, live: LiveText | null) {
  const working = turn.status === "working" || turn.status === "queued";
  // The model call in progress (not stored yet): its text so far, and whether it has started a step.
  const current = working && live && live.step >= turn.modelSteps ? live : null;
  // Live text is trimmed like the stored text (both ends), so a finished bubble carries on instead of starting over:
  // a shown "Done.\n" that the stored "Done." doesn't start with would type the bubble out again.
  const liveText = withoutNextLine((current?.text ?? "").trim());
  const last = turn.parts.at(-1);
  // Its computer starting before the step is stored: its card shows right away, after what it just said.
  const starting = working && !turn.greeting && current?.working?.on === "computer" ? current.working : null;
  const lastIsLive = working && last?.kind === "steps" && !liveText;
  return { working, liveText, starting, lastIsLive };
}


/** True only once `flag` has held for `ms`: the typing bubble doesn't flash for a beat between two steps. */
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

/** One thing a turn shows: a model call's words (one bubble each), work in apps between them, or a computer card. */
type TurnItem = { kind: "text"; key: string; text: string } | { kind: "steps"; key: string; steps: WorkbotStep[]; live: boolean }
  | { kind: "card"; key: string; surface: ComputerSurface; steps: WorkbotStep[]; live: boolean; showing: boolean; others: UsedApp[]; switchTo: SwitchTo | null; update: string | null };

function TurnView(props: {
  canChange: boolean;
  onEdit: (turn: WorkbotTurn, text: string) => void;
  editError: Error | string | null;
  turn: WorkbotTurn;
  /** The message as sent from this page, until the conversation has it (`turn` is then pendingTurn's). */
  pending?: Pending | null;
  live: LiveText | null;
  latest: boolean;
  /** This turn holds the newest of Workbot's words in the conversation: the only ones still revealing. */
  newestText: boolean;
  previews: Record<string, string | null>;
  onRetry: () => void;
  onSuggestion: (text: string) => void;
  onSwitch: (text: string) => void;
}) {
  const { turn, pending = null } = props;
  const { working, liveText, starting, lastIsLive } = replyProgress(turn, props.live);
  // A message still sending waits on its files first, in the place the dots take next.
  const uploading = pending !== null && !pending.failed && pending.uploads.some((upload) => upload.status === "uploading");
  // An answer watched while it was written keeps revealing at its pace once it's stored; answers already done when the
  // page opened show at once.
  const watched = useRef(working);
  if (working) watched.current = true;
  const parts = turn.parts;
  const live = working && props.live && props.live.step >= turn.modelSteps ? props.live : null;
  // One bubble per model call, keyed by that call from its first streamed word to its stored copy, so a bubble never
  // swaps, jumps to its full length or starts over when the conversation is read again (DESIGN P11). Words streamed for
  // an earlier call stay until the stored copy arrives.
  // The newest message is answered next; a follow-up interrupts the older answer, which only finishes its step.
  const answering = props.latest && working;
  // While it answers, the person can ask it to show its work on screen or carry on without them. (Not `canChange`:
  // that is false while Workbot answers, which is exactly when these are offered.)
  const switchMode = answering ? props.onSwitch : undefined;
  // A computer card keeps its key wherever it sits, so moving below Workbot's newest words never restarts its live view.
  const work = computerWork(parts, { working, starting, lastIsLive });
  const card = (surface: ComputerSurface, others: UsedApp[] = []): TurnItem => {
    const isLive = work.live.has(surface);
    const showing = surface === work.shown;
    // The live card offers the other way: Carry on without me while Workbot shows its screen, Show me otherwise.
    const switchTo = !isLive || !switchMode ? null
      : showing ? { label: "Carry on without me", text: "Carry on without me in the background; no need to show me.", send: switchMode }
      : { label: "Show me", text: "Show me what you're doing on screen.", send: switchMode };
    const update = isLive && surface === work.starts ? (starting?.update ?? null) : null;
    return { kind: "card", key: `card-${surface}`, surface, steps: work.cards.get(surface)?.steps ?? [], live: isLive, showing, others, switchTo, update };
  };
  const items: TurnItem[] = [];
  parts.forEach((part, index) => {
    if (part.kind === "text") {
      items.push({ kind: "text", key: `text-${part.step ?? `part-${index}`}`, text: part.text });
      return;
    }
    const here = work.placed.get(index) ?? [];
    const apps = part.steps.filter((step) => step.icon === "app");
    // Apps used beside computer work show as logos on its card; on their own, as a quiet line.
    here.forEach((surface, at) => items.push(card(surface, at === here.length - 1 ? usedApps(apps, null) : [])));
    if (apps.length > 0 && here.length === 0) items.push({ kind: "steps", key: `steps-${index}`, steps: apps, live: working && index === parts.length - 1 && lastIsLive });
  });
  if (working && props.live) {
    for (const entry of props.live.earlier ?? []) {
      const text = withoutNextLine(entry.text.trim());
      if (entry.step >= turn.modelSteps && text) items.push({ kind: "text", key: `text-${entry.step}`, text });
    }
  }
  if (live && liveText) items.push({ kind: "text", key: `text-${live.step}`, text: liveText });
  for (const surface of work.trailing) items.push(card(surface));
  // The place Workbot's next words will take, one message line tall: the typing dots, or the app step running right now
  // ("Using Gmail"), then the words themselves, each replacing the last without moving the conversation. Once it has
  // shown, it keeps its place until the words arrive.
  const tail = items.at(-1);
  const runningApps = answering && tail?.kind === "steps" && tail.live && tail.steps.every((step) => step.icon === "app") ? tail : null;
  if (runningApps) items.pop();
  const lastText = items.reduce((found, item, index) => (item.kind === "text" ? index : found), -1);
  const waiting = answering && !liveText && !lastIsLive && work.live.size === 0;
  const fresh = items.length === 0 && !runningApps;
  const settled = useSettled(waiting && !fresh, 350);
  const dots = waiting && (fresh || settled);
  const running = runningApps !== null;
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (dots || running) setHeld(true);
    else if (!answering || liveText) setHeld(false);
  }, [dots, running, answering, liveText]);
  const slot = uploading || (answering && !liveText && (dots || held || running));
  const copyText = parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n\n");
  const offers = useMemo(() => (turn.status === "done" ? documentLinks(copyText) : []), [turn.status, copyText]);
  // One computer, so only the newest reply that used its screen offers to open it, already while it works. Commands run
  // in the background leave nothing on the screen to open.
  const onScreen = (step: WorkbotStep) => step.icon === "computer" && !step.background;
  const usedComputer = props.latest && ((starting !== null && !starting.background) || parts.some((part) => part.kind === "steps" && part.steps.some(onScreen)));
  return (
    <>
      <SentAttachments attachments={turn.attachments} localUrls={pending ? { ...props.previews, ...pendingAttachments(pending).urls } : props.previews} />
      {pending || (turn.text && !turn.greeting) ? (
        <OwnMessage turn={turn} failed={Boolean(pending?.failed)} canChange={props.canChange && turn.status !== "queued"} onEdit={props.onEdit} error={props.editError instanceof WorkbotSendError && props.editError.accessReason ? null : props.editError instanceof Error ? props.editError.message : props.editError} />
      ) : (
        <UserBubble text={turn.text} reaction={turn.reaction} />
      )}
      {pending?.failed ? (
        pending.accessIssue ? <AccessRecovery reason={pending.accessIssue} onRetry={props.onRetry} /> : <ErrorLine align="end" action={{ label: "Send again", onClick: props.onRetry }}>{pending.failed}</ErrorLine>
      ) : null}
      {items.length > 0 || slot ? <Gap /> : null}
      {/* What it said and what it did, in the order it happened: "On it." · the computer card · the answer. */}
      <div className="group/answer flex flex-col">
        {items.map((item, index) =>
          item.kind === "text" ? (
            // Natural replies: Copy sits beside the last bubble, so a finished answer doesn't add a row under itself.
            <AssistantBubble key={item.key} trailing={turn.status === "done" && index === lastText ? <CopyAnswer text={copyText} /> : null}>
              <StreamingText text={item.text} instant={!(props.newestText && index === lastText && watched.current)} />
            </AssistantBubble>
          ) : item.kind === "card" ? (
            <div key={item.key} className="py-1 pl-1">
              <SurfaceCard surface={item.surface} steps={item.steps} live={item.live} showing={item.showing} others={item.others} switchTo={item.switchTo} starting={item.update} />
            </div>
          ) : (
            <StepsSegment key={item.key} steps={item.steps} live={item.live} />
          ),
        )}
        {slot ? <WaitingSlot>{uploading ? <QuietLine label="Uploading your files" /> : runningApps ? <StepsSegment steps={runningApps.steps} live /> : dots ? <TypingDots /> : null}</WaitingSlot> : null}
      </div>
      <DocumentOffers links={offers} />
      <DocumentNavigationStatus receipts={turn.navigation} />
      {usedComputer ? <ComputerOffer /> : null}
      {turn.outputs.length ? <OutputFiles files={turn.outputs} /> : null}
      {turn.tasks.length ? <TaskCards tasks={turn.tasks} canRetry={props.canChange} onRetry={(task) => props.onSuggestion(`Try the "${task.title}" background task again.`)} /> : null}
      {/* Workbot's hello offers what to ask next, only while it is still the latest message. */}
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
        <AccessRecovery reason={props.editError.accessReason} onRetry={props.latest ? props.onRetry : undefined} />
      ) : turn.status === "failed" && turn.modelIssue && workbotHost().usageRecovery ? (
        <ModelRecovery issue={turn.modelIssue} onRetry={props.latest ? props.onRetry : undefined} />
      ) : turn.status === "failed" ? (
        <ErrorLine action={props.latest && (turn.greeting || turn.retryable) ? { label: "Try again", onClick: props.onRetry } : null}>{turn.greeting ? HELLO_FAILED : turn.error}</ErrorLine>
      ) : null}
      {/* Natural replies: an answer cut short by a follow-up or by Stop just ends where it was. */}
    </>
  );
}


function duration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const isOpen = (task: WorkbotTask) => task.status === "queued" || task.status === "working" || task.status === "paused";

/**
 * Work Workbot did on its computer, as one card: the laptop, what the work is, and what it is doing now (or what it
 * last did, once it is over) with how long it has taken. Running: the laptop animates and the line shimmers (V6).
 * Finished: the card stays, quiet, with a check. Clicking a finished card shows everything it did, in its own words.
 */
function WorkCard(props: {
  title: string;
  /** What it is doing now, or what it last did. */
  detail: string;
  running: boolean;
  outcome: "done" | "failed" | "stopped" | null;
  startedAt: number | null;
  finishedAt: number | null;
  updates: string[];
  action?: ReactNode;
  /** Shown under the card's row: a live view, links. */
  footer?: ReactNode;
}) {
  const now = useNow();
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

/** One background task as a card: the little person at work, what it's doing, how long, and Stop. */
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

/** A task keeps the same keyed card in the turn that started it, through every status. */
function TaskCards({ tasks, onRetry, canRetry }: { tasks: WorkbotTask[]; onRetry: (task: WorkbotTask) => void; canRetry: boolean }) {
  return (
    <div className="flex flex-col gap-2 pl-1 pt-3">
      {tasks.map((task) => <div key={task.id} data-workbot-task={task.id}><TaskCard task={task} canRetry={canRetry} onRetry={() => onRetry(task)} /></div>)}
    </div>
  );
}

/** Files Workbot made while answering, as cards under the answer that open in the preview panel. */
function OutputFiles({ files }: { files: WorkbotAttachment[] }) {
  const open = useContext(OpenFileContext);
  return (
    <div className="workbot-row-enter flex flex-wrap gap-2 pl-1 pt-3">
      {files.map((file) => (
        <button
          key={file.id}
          type="button"
          onClick={() => open(file)}
          className="flex min-w-0 max-w-full items-center gap-3 rounded-[14px] bg-[var(--wb-surface)] py-2 pl-2 pr-4 text-left shadow-[var(--wb-card-shadow)] transition-shadow duration-150 ease-out hover:shadow-[var(--wb-card-shadow-hover)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] sm:max-w-[320px]"
        >
          {isImage(file.mediaType) ? <ImageThumb id={file.id} className="size-9 shrink-0 rounded-[8px] outline outline-1 -outline-offset-1 outline-black/10" /> : <FileBadge name={file.name} mediaType={file.mediaType} />}
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[13.5px] font-medium leading-5 text-[var(--wb-text)]">{file.name}</span>
            <span className="text-[12px] leading-4 text-[var(--wb-muted)]">{kindLabel(file.name, file.mediaType)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function WorkbotComposer(props: {
  teaching?: BrowserTeachingContext;
  nativeDictation?: boolean;
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
  const input = useRef<HTMLTextAreaElement>(null);
  const dictation = useNativeDictation({ enabled: props.nativeDictation === true, text, onText: props.onText,
    selection: () => ({ start: input.current?.selectionStart ?? text.length, end: input.current?.selectionEnd ?? text.length }),
    focusInput: () => input.current?.focus() });
  const hasFiles = props.uploads.length > 0;
  const canSend = text.trim().length > 0 || (hasFiles && props.uploads.every((upload) => upload.status !== "failed"));

  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    const fit = () => {
      node.style.height = "auto";
      node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
    };
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
    props.onSend(props.nativeDictation === true ? dictation.commit() : text);
    input.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
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
  // While an answer is in progress, a typed message is still sent (it is answered next); an empty box offers Stop.
  const showStop = props.busy && !canSend;
  const multiline = hasFiles || text.includes("\n") || text.length > 70;

  return <>
    {props.teaching && <div role="status" className="mb-2 flex flex-col gap-0.5 px-3 text-[12px] text-[var(--wb-muted)]" data-workbot-teaching-context>
      <span>{props.teaching.phase === "recording" ? `Teaching ${props.name}` : props.teaching.phase === "paused" ? "Recording paused · Still teaching" : "Reviewing the skill"}</span>
      <span className="truncate">{props.teaching.label}</span>
    </div>}
    <div
      data-workbot-composer
      className={`flex bg-[var(--wb-surface)] shadow-[var(--wb-composer-shadow)] transition-[border-radius] duration-150 ${
        hasFiles ? "flex-col gap-2 rounded-[24px] pb-2 pl-2.5 pr-2 pt-2.5" : `items-end gap-1 pl-[7px] pr-[7px] sm:pr-2 ${multiline ? "rounded-[24px] py-2" : "rounded-full py-[7px] sm:py-2"}`
      }`}
    >
      {hasFiles ? <UploadTray uploads={props.uploads} onRemove={props.onRemoveUpload} onRetry={props.onRetryUpload} /> : null}
      <div className={hasFiles ? "flex w-full min-w-0 flex-1 items-end gap-1" : "contents"}>
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
          placeholder={props.teaching ? "Explain this step or ask a question" : `Message ${props.name}`}
          aria-label={`Message ${props.name}`}
          className="max-h-[200px] min-h-9 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-[7px] text-[16px] leading-[22px] text-[var(--wb-text)] outline-none placeholder:text-[var(--wb-faint)] sm:py-[9px] sm:text-[14px] sm:leading-[18px]"
        />
        {props.nativeDictation === true ? <WorkbotDictation dictation={dictation} disabled={props.disabled} text={text} /> : null}
        <button
          type="button"
          onClick={showStop ? props.onStop : sendNow}
          disabled={props.disabled || (showStop ? props.stopping : !canSend)}
          aria-label={showStop ? "Stop" : "Send"}
          aria-keyshortcuts={showStop ? "Escape" : "Enter"}
          title={showStop ? "Stop (esc)" : "Send (⏎)"}
          className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--wb-ink)] text-[var(--wb-bg)] transition-colors duration-150 disabled:bg-[var(--wb-disabled)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
        >
          {showStop ? <span aria-hidden className="h-2.75 w-2.75 rounded-[2.5px] bg-[var(--wb-bg)]" /> : <ArrowUp size={16} strokeWidth={2.25} aria-hidden />}
        </button>
      </div>
    </div>
  </>;
}
