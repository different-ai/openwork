import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { coworkerBridge, type CoworkerSummary, type LocalResponsibility, type ProviderSyncRun, type RuntimeInfo } from "@/lib/bridge";
import { describeNow, describeOutcome, mergeRecentWork, relativeTime } from "@/lib/activity-summary";
import type { ConnectState } from "@/lib/connect";
import type { DenSession } from "@/lib/den";
import { clearAutoPicked, markAutoPicked } from "@/lib/model-choice";
import { createCoworkerThreads, recommendModel, type CoworkerActivity, type ThreadListItem } from "@/lib/threads";
import { AvatarControls, CoworkerAvatar } from "@/ui/coworker-avatar";
import { PersonalityPicker } from "@/ui/personality-picker";
import { useWorkingSaying } from "@/ui/use-working-saying";
import { CapabilitiesPanel } from "@/ui/capabilities";
import { ActivityIcon, AppsIcon, Button, ErrorNote, IconButton, MemoryIcon, SlidersIcon, StatusDot, WorkersIcon } from "@/ui/kit";
import { useResizablePanel } from "@/ui/use-resizable-panel";
import { PanelContent, PanelHeader, usePanelNavigation } from "@/ui/panel-nav";
import { pushCrumb, routeDepth, type PanelCrumb } from "@/lib/panel-route";
import type { PanelBounds } from "@/lib/panel-layout";
import { MemoryPanel } from "@/ui/memory";
import { DocumentBesidePane, DocumentsIcon, DocumentsPanel, lastDocumentsOpened, useDocuments } from "@/ui/documents";
import { describeActiveDocuments, documentsChangedSince } from "@/lib/documents";
import { ThreadsPanel, type DocumentHooks } from "@/ui/threads";
import { WorkersPanel } from "@/ui/workers";
import { describeWorkerCount, type WorkerSummary } from "@/lib/workers";
import { ModelPicker, type ModelSelection } from "@/ui/model-picker";
import type { SettingsSection } from "@/ui/openwork-settings";

type ContextView = "overview" | "documents" | "workers" | "capabilities" | "memory" | "settings";

const CONTEXT_TITLES: Record<ContextView, string> = {
  overview: "Activity",
  documents: "Documents",
  workers: "Workers",
  capabilities: "Apps & tools",
  memory: "Memory",
  settings: "Coworker settings",
};

const CONTEXT_PANEL_WIDTH_KEY = "open-coworker.context-panel-width";
const CONTEXT_PANEL_DEFAULT_WIDTH = 360;
const MAIN_WORKSPACE_MIN_WIDTH = 520;
/** The context panel: drag it narrower than it can usefully be and it folds to an icon strip. */
const CONTEXT_PANEL_BOUNDS: PanelBounds = { min: 320, max: 440, collapsedWidth: 56, collapseBelow: 240 };
/** The reading pane beside the conversation, when the window has room for it. */
const BESIDE_PANE_WIDTH = 440;

const CONTEXT_ICONS: Record<ContextView, (props: { className?: string }) => ReactNode> = {
  overview: ActivityIcon,
  documents: DocumentsIcon,
  workers: WorkersIcon,
  capabilities: AppsIcon,
  memory: MemoryIcon,
  settings: SlidersIcon,
};
const CONTEXT_ORDER: ContextView[] = ["overview", "documents", "workers", "capabilities", "memory", "settings"];

function isContextView(value: string): value is ContextView {
  return CONTEXT_ORDER.some((view) => view === value);
}
/** From this window width on, an App or skill detail may open in a column beside the conversation… */
const BESIDE_APPS_MIN_WINDOW = 1_280;
/** …a column at least this wide, and only while the conversation keeps its own minimum next to it. */
const BESIDE_APPS_MIN_WIDTH = 480;
/** Below this window width the open panel lies over the conversation instead of beside it. */
const NARROW_WINDOW = 900;

function activityTone(activity: CoworkerActivity | undefined): "spark" | "mint" | "amber" | "rose" | "mist" {
  if (activity?.state === "working") return "spark";
  if (activity?.state === "retrying" || activity?.state === "attention") return "amber";
  if (activity?.state === "offline") return "rose";
  if (activity?.state === "recent") return "mint";
  return "mist";
}

function activityTextTone(activity: CoworkerActivity | undefined): string {
  if (activity?.state === "working") return "text-spark";
  if (activity?.state === "retrying" || activity?.state === "attention") return "text-amber";
  if (activity?.state === "offline") return "text-rose";
  if (activity?.state === "recent") return "text-mint";
  return "text-mist";
}

/** A request another view makes of this one: open a settings section, or open one thread. */
export type CoworkerHomeRequest =
  | { id: number; kind: "settings"; section: "model" }
  | { id: number; kind: "thread"; threadId: string };

export function CoworkerHome({
  runtime,
  session,
  coworkers,
  coworker,
  activity,
  onActivityChange,
  onCoworkerChanged,
  onCoworkerRemoved,
  onRefreshRuntime,
  onRestartRuntime,
  onSyncProviders,
  onOpenOpenWork,
  connect,
  onRepairConnect,
  onConnectAccount,
  railWidth,
  request = null,
}: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  coworkers: CoworkerSummary[];
  coworker: CoworkerSummary;
  activity?: CoworkerActivity;
  onActivityChange: (activity: CoworkerActivity | null) => void;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  onCoworkerRemoved: (slug: string) => void;
  onRefreshRuntime: () => Promise<void>;
  /** Stop and start the local AI service; the one honest recovery when it is unavailable. */
  onRestartRuntime: () => Promise<void>;
  onSyncProviders: () => Promise<ProviderSyncRun>;
  /** Open the global OpenWork settings, optionally on one section (account, models…). */
  onOpenOpenWork: (section?: SettingsSection) => void;
  /** OpenWork Connect state for this coworker while signed in; null before the first sync. */
  connect: ConnectState | null;
  onRepairConnect: () => void;
  /** Start the OpenWork sign-in flow. */
  onConnectAccount: () => void;
  /** Current width of the team rail, so the thread column keeps its minimum before this panel grows. */
  railWidth: number;
  /** Something another view asked this one to show on arrival: a settings section, or one thread. */
  request?: CoworkerHomeRequest | null;
}) {
  const [settingsFocus, setSettingsFocus] = useState<{ id: number; section: "model" } | null>(null);
  const [assignmentDraft, setAssignmentDraft] = useState<{ id: number; text: string } | null>(null);
  const [discussionDraft, setDiscussionDraft] = useState<{ id: number; text: string } | null>(null);
  const [openThreadRequest, setOpenThreadRequest] = useState<{ id: number; threadId: string } | null>(null);
  /** The coworker's one-off assignment threads, as the conversation column lists them; the Workers view shows them beside the scheduled ones. */
  const [assignmentThreads, setAssignmentThreads] = useState<ThreadListItem[]>([]);
  /** From a card's Open: show this document in the Documents view; the id makes repeats distinct. */
  const [openDocumentRequest, setOpenDocumentRequest] = useState<{ id: number; documentId: string } | null>(null);
  /** The document open in the reading pane beside the conversation, when the window has room. */
  const [besideDocumentId, setBesideDocumentId] = useState("");
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const { documents, refresh: refreshDocuments, error: documentsError } = useDocuments(coworker.slug);
  const documentsInPlay = describeActiveDocuments(documents ?? []);
  /** The conversation views place their own title line and actions into the one header. */
  const [headerTitleSlot, setHeaderTitleSlot] = useState<HTMLElement | null>(null);
  const [headerActionsSlot, setHeaderActionsSlot] = useState<HTMLElement | null>(null);
  const contextPanelRoom = useCallback(() => Math.max(CONTEXT_PANEL_BOUNDS.min, window.innerWidth - railWidth - MAIN_WORKSPACE_MIN_WIDTH), [railWidth]);
  const contextPanel = useResizablePanel({
    storageKey: CONTEXT_PANEL_WIDTH_KEY,
    side: "right",
    bounds: CONTEXT_PANEL_BOUNDS,
    defaultWidth: CONTEXT_PANEL_DEFAULT_WIDTH,
    available: contextPanelRoom,
    startCollapsed: true,
  });
  /**
   * Where the panel is: one view and a short path inside it, remembered per view for the
   * session. Escape goes back a level, or closes the panel at a root; a deep link from
   * elsewhere in the app (a receipt, the Connect status) opens the panel on its route.
   */
  const nav = usePanelNavigation<ContextView>({
    initialView: "overview",
    isView: isContextView,
    open: !contextPanel.collapsed,
    onEscapeAtRoot: contextPanel.collapse,
    onRequestOpen: contextPanel.expand,
  });
  const contextView = nav.route.view;
  const setContextView = nav.showView;
  const [panelContentElement, setPanelContentElement] = useState<HTMLDivElement | null>(null);
  /**
   * Open one view, unfolding the panel if it was closed. Choosing the open view again closes
   * it; the strip icon of the view already showing goes to that view's root, another view
   * opens where it was last.
   */
  function showContext(view: ContextView): void {
    if (!contextPanel.collapsed && view === contextView) {
      contextPanel.collapse();
      return;
    }
    if (view === contextView) nav.toRoot(view);
    else nav.showView(view);
    if (contextPanel.collapsed) contextPanel.expand();
  }
  const handledRequestRef = useRef(0);
  useEffect(() => {
    if (!request || handledRequestRef.current === request.id) return;
    handledRequestRef.current = request.id;
    if (request.kind === "thread") {
      setOpenThreadRequest({ id: request.id, threadId: request.threadId });
      return;
    }
    setContextView("settings");
    if (contextPanel.collapsed) contextPanel.expand();
    setSettingsFocus({ id: request.id, section: request.section });
  }, [contextPanel, request]);
  const collapseContextPanel = contextPanel.collapse;
  /** Moving to another coworker returns to the conversation; the panel does not follow. */
  useEffect(() => {
    collapseContextPanel();
    setContextView("overview");
    setBesideDocumentId("");
    setBesidePath(null);
  }, [collapseContextPanel, coworker.slug, setContextView]);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const panelWidth = contextPanel.collapsed ? CONTEXT_PANEL_BOUNDS.collapsedWidth : contextPanel.width;
  const canOpenBeside = windowWidth - railWidth - panelWidth - BESIDE_PANE_WIDTH >= MAIN_WORKSPACE_MIN_WIDTH;
  useEffect(() => {
    if (!canOpenBeside) setBesideDocumentId("");
  }, [canOpenBeside]);
  /** An App or skill detail open in a column beside the conversation, while the window is wide enough. */
  const [besidePath, setBesidePath] = useState<PanelCrumb[] | null>(null);
  const besideAppsAvailable = windowWidth >= BESIDE_APPS_MIN_WINDOW
    && windowWidth - railWidth - panelWidth - BESIDE_APPS_MIN_WIDTH >= MAIN_WORKSPACE_MIN_WIDTH;
  const navigateTo = nav.navigate;
  const expandContextPanel = contextPanel.expand;
  useEffect(() => {
    if (besideAppsAvailable || !besidePath) return;
    // The window shrank: the detail folds back into the panel at the same route.
    navigateTo({ view: "capabilities", path: besidePath });
    expandContextPanel();
    setBesidePath(null);
  }, [besideAppsAvailable, besidePath, expandContextPanel, navigateTo]);
  /** Closing the column hands focus back to the row the detail was opened from. */
  function closeBeside(): void {
    const rowId = besidePath?.[besidePath.length - 1]?.id ?? "";
    setBesidePath(null);
    window.requestAnimationFrame(() => {
      const row = rowId ? panelContentElement?.querySelector<HTMLElement>(`button[data-row-id="${rowId.replaceAll('"', '\\"')}"]`) : null;
      row?.focus();
    });
  }
  const overlayPanel = windowWidth < NARROW_WINDOW && !contextPanel.collapsed;
  const documentHooks: DocumentHooks = {
    onOpenDocument: (documentId) => {
      setContextView("documents");
      if (contextPanel.collapsed) contextPanel.expand();
      setOpenDocumentRequest({ id: Date.now(), documentId });
    },
    onOpenDocumentBeside: (documentId) => {
      if (canOpenBeside) {
        setBesidePath(null);
        setBesideDocumentId(documentId);
      }
      else documentHooks.onOpenDocument(documentId);
    },
    canOpenBeside,
  };
  const documentsChanged = documents ? documentsChangedSince(documents, lastDocumentsOpened(coworker.slug)) : 0;
  const askToUpdate = (text: string) => setDiscussionDraft({ id: Date.now(), text });

  useEffect(() => () => onActivityChange(null), [onActivityChange]);

  // A coworker created without a model starts on a connected model that can use
  // tools, chosen as soon as the AI service answers; the choice is kept so it
  // shows in Coworker settings and can be changed there.
  useEffect(() => {
    if (coworker.model || !coworker.workspaceId || !runtime.engineManaged) return;
    let cancelled = false;
    let attempts = 0;
    let timer = 0;
    const threads = createCoworkerThreads({ serverUrl: runtime.serverUrl, workspaceId: coworker.workspaceId, token: runtime.ownerToken });
    const attempt = async () => {
      attempts += 1;
      try {
        const pick = recommendModel(await threads.listModelCatalog());
        if (cancelled) return;
        if (pick) {
          markAutoPicked(coworker.slug, pick.id);
          onCoworkerChanged(await coworkerBridge.coworkers.update(coworker.slug, { model: pick.id, modelVariant: "" }));
          return;
        }
      } catch {
        // The AI service may still be warming up; try again shortly.
      }
      if (!cancelled && attempts < 30) timer = window.setTimeout(() => void attempt(), 3_000);
    };
    timer = window.setTimeout(() => void attempt(), 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [coworker.model, coworker.slug, coworker.workspaceId, onCoworkerChanged, runtime.engineManaged, runtime.ownerToken, runtime.serverUrl]);

  return (
    <div className="glass-main relative flex h-full min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="glass-header window-drag flex h-[78px] items-center gap-3 border-b border-line px-6 pt-2" data-testid="conversation-header">
          <CoworkerAvatar
            animated
            color={coworker.avatarColor}
            glasses={coworker.avatarGlasses}
            name={coworker.name}
            size={40}
          />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold text-snow">{coworker.name}</h1>
            <div ref={setHeaderTitleSlot} className="window-no-drag flex min-h-[18px] min-w-0 items-center gap-2 text-xs text-mist" data-testid="conversation-header-title" />
          </div>
          <div ref={setHeaderActionsSlot} className="window-no-drag flex shrink-0 items-center gap-1" data-testid="conversation-header-actions" />
          {documentsInPlay ? (
            <button
              type="button"
              className="window-no-drag hidden shrink-0 items-center gap-1.5 text-[11px] text-mist transition-colors hover:text-snow md:flex"
              title="Open Documents"
              data-testid="coworker-documents-in-play"
              onClick={() => showContext("documents")}
            >
              <DocumentsIcon className="size-3.5" />
              {documentsInPlay}
            </button>
          ) : null}
          <span data-testid="coworker-top-status" className={`flex shrink-0 items-center gap-2 text-xs ${runtime.engineManaged ? activityTextTone(activity) : "text-rose"}`} title={activity?.detail}>
            <StatusDot tone={runtime.engineManaged ? activityTone(activity) : "rose"} />
            {runtime.engineManaged ? (activity?.label ?? "Checking status") : "AI unavailable"}
          </span>
        </header>
        {!runtime.engineManaged ? (
          <AiUnavailableNote coworkerName={coworker.name} technical={runtime.engineError} onRestart={onRestartRuntime} />
        ) : null}
        <main className="min-h-0 flex-1 overflow-hidden">
          <ThreadsPanel
            runtime={runtime}
            session={session}
            coworker={coworker}
            onCoworkerChanged={onCoworkerChanged}
            onRefreshRuntime={onRefreshRuntime}
            onSyncProviders={onSyncProviders}
            assignmentDraft={assignmentDraft}
            discussionDraft={discussionDraft}
            openThreadRequest={openThreadRequest}
            onAssignmentsChange={setAssignmentThreads}
            headerSlots={{ title: headerTitleSlot, actions: headerActionsSlot }}
            onOpenModelSettings={() => {
              showContext("settings");
              setSettingsFocus({ id: Date.now(), section: "model" });
            }}
            onOpenAccount={() => onOpenOpenWork("account")}
            onActivityChange={onActivityChange}
            documents={documentHooks}
          />
        </main>
      </div>

      {besideDocumentId && canOpenBeside ? (
        <DocumentBesidePane
          coworker={coworker}
          documentId={besideDocumentId}
          onClose={() => setBesideDocumentId("")}
          onChanged={refreshDocuments}
          onAskToUpdate={askToUpdate}
          onOpenDocument={setBesideDocumentId}
        />
      ) : null}

      {besidePath && besideAppsAvailable ? (
        <section
          className="flex h-full flex-1 flex-col border-l border-line"
          style={{ minWidth: BESIDE_APPS_MIN_WIDTH }}
          aria-label="Beside the conversation"
          data-testid="beside-column"
          data-route={["capabilities", ...besidePath.map((crumb) => crumb.id)].join("/")}
        >
          <header className="glass-header window-drag flex h-[78px] items-center gap-2 border-b border-line px-4 pt-2">
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-snow">{besidePath[besidePath.length - 1]?.title}</h2>
            <IconButton label="Close" className="window-no-drag" data-testid="beside-close" onClick={closeBeside}>
              <span aria-hidden="true">×</span>
            </IconButton>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <CapabilitiesPanel
              mode="beside"
              runtime={runtime}
              session={session}
              coworker={coworker}
              connect={connect}
              onRepairConnect={onRepairConnect}
              onConnectAccount={onConnectAccount}
              onAssign={(text) => {
                setAssignmentDraft({ id: Date.now(), text });
                setBesidePath(null);
              }}
              onDiscuss={(text) => {
                setDiscussionDraft({ id: Date.now(), text });
                setBesidePath(null);
              }}
              path={besidePath}
              width={BESIDE_APPS_MIN_WIDTH}
              onPush={(crumb) => setBesidePath(pushCrumb({ view: "capabilities", path: besidePath }, crumb).path)}
              onSetPath={(path) => setBesidePath(path)}
            />
          </div>
        </section>
      ) : null}
      {overlayPanel ? (
        <div className="absolute inset-0 z-30 bg-black/40" data-testid="context-panel-scrim" onClick={contextPanel.collapse} aria-hidden="true" />
      ) : null}
      <aside
        className={`glass-context flex h-full shrink-0 flex-col border-l border-line ${overlayPanel ? "absolute inset-y-0 right-0 z-40 shadow-[-24px_0_48px_rgba(0,0,0,0.45)]" : "relative"} ${contextPanel.resizing ? "" : "transition-[width] duration-[180ms] ease-out motion-reduce:transition-none"}`}
        style={{ width: contextPanel.width }}
        data-testid="context-panel"
        data-collapsed={contextPanel.collapsed ? "true" : "false"}
        data-view={contextView}
        data-depth={routeDepth(nav.route)}
        data-overlay={overlayPanel ? "true" : "false"}
        ref={(element) => {
          nav.panelRef.current = element;
        }}
      >
        <div
          {...contextPanel.separatorProps}
          aria-label="Resize context panel"
          className="window-no-drag group absolute inset-y-0 -left-[5px] z-30 w-[10px] cursor-col-resize outline-none"
          title={contextPanel.collapsed ? "Click to show the panel · Drag to resize" : "Drag to resize · Click or drag closed to fold"}
          data-testid="context-panel-resizer"
        >
          <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-spark/45 group-focus-visible:bg-spark/70" />
        </div>
        {contextPanel.collapsed ? (
          <>
            {/* The strip starts level with the header's controls, so the corner above it is not an empty band. */}
            <nav aria-label="Coworker panels" className="window-drag flex flex-col items-center gap-1 px-2 pb-3 pt-[23px]">
              {CONTEXT_ORDER.map((view) => {
                const Icon = CONTEXT_ICONS[view];
                const active = view === contextView;
                return (
                  <IconButton
                    key={view}
                    label={CONTEXT_TITLES[view]}
                    data-testid={`context-rail-${view}`}
                    data-active={active ? "true" : "false"}
                    aria-current={active ? "true" : undefined}
                    className={active ? "bg-white/8 text-snow ring-1 ring-white/10" : ""}
                    onClick={() => showContext(view)}
                  >
                    <span className="relative flex">
                      <Icon />
                      {view === "documents" && documentsChanged > 0 ? (
                        <span className="absolute -right-1.5 -top-1 size-1.5 rounded-full bg-spark" aria-hidden="true" data-testid="documents-changed-dot" />
                      ) : null}
                    </span>
                  </IconButton>
                );
              })}
            </nav>
          </>
        ) : (
          <>
        <PanelHeader
          route={nav.route}
          rootTitle={CONTEXT_TITLES[contextView]}
          width={contextPanel.width}
          onBack={nav.back}
          onToDepth={nav.toDepth}
          leading={contextView !== "overview" ? (
            <IconButton label="Back to activity" className="window-no-drag" onClick={() => nav.toRoot("overview")}>
              <span aria-hidden="true">←</span>
            </IconButton>
          ) : undefined}
          actions={contextView === "overview" ? (
            <IconButton
              label="Coworker settings"
              className="window-no-drag"
              data-testid="coworker-settings-button"
              onClick={() => setContextView("settings")}
            >
              <SlidersIcon />
            </IconButton>
          ) : undefined}
        />
        <PanelContent route={nav.route} containerRef={setPanelContentElement}>
          {contextView === "overview" ? (
            <CoworkerOverview
              session={session}
              coworkers={coworkers}
              coworker={coworker}
              activity={activity}
              engineManaged={runtime.engineManaged}
              onCoworkerChanged={onCoworkerChanged}
              onOpenThread={(threadId) => setOpenThreadRequest({ id: Date.now(), threadId })}
              onExplain={(text) => setDiscussionDraft({ id: Date.now(), text })}
              onOpenMemory={() => setContextView("memory")}
              onOpenCapabilities={() => setContextView("capabilities")}
              onOpenWorkers={() => setContextView("workers")}
              onOpenOpenWork={() => onOpenOpenWork()}
            />
          ) : null}
          {contextView === "workers" ? (
            <WorkersPanel
              session={session}
              coworkers={coworkers}
              coworker={coworker}
              assignments={assignmentThreads}
              onCoworkerChanged={onCoworkerChanged}
              onConnect={() => onOpenOpenWork()}
              onOpenThread={(threadId) => setOpenThreadRequest({ id: Date.now(), threadId })}
              onExplain={(text) => setDiscussionDraft({ id: Date.now(), text })}
            />
          ) : null}
          {contextView === "documents" ? (
            <DocumentsPanel
              coworker={coworker}
              documents={documents}
              error={documentsError}
              onRefresh={refreshDocuments}
              openRequest={openDocumentRequest}
              onAskToUpdate={askToUpdate}
              canOpenBeside={canOpenBeside}
              onOpenBeside={(documentId) => {
                setBesidePath(null);
                setBesideDocumentId(documentId);
              }}
            />
          ) : null}
          {contextView === "memory" ? <MemoryPanel coworker={coworker} /> : null}
          {contextView === "capabilities" ? (
            <CapabilitiesPanel
              runtime={runtime}
              session={session}
              coworker={coworker}
              connect={connect}
              onRepairConnect={onRepairConnect}
              onConnectAccount={onConnectAccount}
              onAssign={(text) => {
                setAssignmentDraft({ id: Date.now(), text });
                setContextView("overview");
              }}
              onDiscuss={(text) => {
                setDiscussionDraft({ id: Date.now(), text });
                setContextView("overview");
              }}
              path={nav.route.path}
              width={contextPanel.width}
              direction={nav.direction}
              onPush={nav.push}
              onSetPath={nav.setPath}
              returnFocusRow={nav.returnFocusRow}
              contentElement={panelContentElement}
              beside={{
                available: besideAppsAvailable,
                open: (path) => {
                  setBesideDocumentId("");
                  setBesidePath(path);
                  nav.back();
                },
              }}
            />
          ) : null}
          {contextView === "settings" ? (
            <CoworkerSettings
              runtime={runtime}
              session={session}
              coworker={coworker}
              onCoworkerChanged={onCoworkerChanged}
              onCoworkerRemoved={onCoworkerRemoved}
              onSyncProviders={onSyncProviders}
              onOpenAccount={() => onOpenOpenWork("account")}
              onOpenMemory={() => setContextView("memory")}
              focus={settingsFocus}
            />
          ) : null}
        </PanelContent>
          </>
        )}
      </aside>
    </div>
  );
}

function CoworkerOverview({
  session,
  coworkers,
  coworker,
  activity,
  engineManaged,
  onCoworkerChanged,
  onOpenThread,
  onExplain,
  onOpenMemory,
  onOpenCapabilities,
  onOpenWorkers,
  onOpenOpenWork,
}: {
  session: DenSession | null;
  coworkers: CoworkerSummary[];
  coworker: CoworkerSummary;
  activity?: CoworkerActivity;
  engineManaged: boolean;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  onOpenThread: (threadId: string) => void;
  /** Prefill the discussion composer with a message about a run; the person still sends it. */
  onExplain: (message: string) => void;
  onOpenMemory: () => void;
  onOpenCapabilities: () => void;
  onOpenWorkers: () => void;
  onOpenOpenWork: () => void;
}) {
  const now = describeNow(activity);
  const saying = useWorkingSaying(
    coworker.personality,
    `${coworker.slug}:${activity?.threadId ?? "work"}`,
    activity?.state === "working",
  );
  const nowNote = saying ? `${saying}…` : now.note;
  const [localResponsibilities, setLocalResponsibilities] = useState<LocalResponsibility[]>([]);
  const [workers, setWorkers] = useState<WorkerSummary[]>([]);
  const workersLine = describeWorkerCount(workers);
  // While a run is going or waiting in line, the list follows it closely; otherwise it idles.
  const localRunsBusy = localResponsibilities.some(
    (item) => item.latestRun?.status === "running" || item.latestRun?.status === "queued",
  );

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      Promise.all([
        coworkerBridge.localResponsibilities.list(coworker.slug),
        coworkerBridge.workers.list(coworker.slug).catch((): WorkerSummary[] => []),
      ])
        .then(([items, liveWorkers]) => {
          if (cancelled) return;
          setLocalResponsibilities(items);
          setWorkers(liveWorkers);
        })
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(() => void load(), localRunsBusy ? 1_500 : 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [coworker.slug, localRunsBusy]);

  const recent = mergeRecentWork(activity, localResponsibilities);
  const nowTime = relativeTime(activity?.updatedAt ?? 0);
  const canOpenSubject = Boolean(activity?.threadId);
  const statusLabel = engineManaged ? (activity?.label ?? "Checking status") : "AI unavailable";

  return (
    <div className="flex min-h-full flex-col gap-5">
      <section aria-label="Current activity" className="rounded-2xl border border-line bg-ink p-4" data-testid="coworker-activity-summary">
        <div className="flex items-center justify-between gap-3">
          <span
            data-testid="coworker-current-status"
            className={`flex min-w-0 items-center gap-2 text-sm font-semibold ${engineManaged ? activityTextTone(activity) : "text-rose"}`}
          >
            <StatusDot tone={engineManaged ? activityTone(activity) : "rose"} />
            <span className="truncate">{statusLabel}</span>
          </span>
          {nowTime && now.subject ? (
            <span className="shrink-0 text-[11px] text-mist" title={activity?.updatedAt ? new Date(activity.updatedAt).toLocaleString() : undefined}>
              {nowTime}
            </span>
          ) : null}
        </div>

        {now.subject ? (
          <button
            type="button"
            className={`mt-2.5 block w-full text-left ${canOpenSubject ? "group" : "cursor-default"}`}
            disabled={!canOpenSubject}
            onClick={() => {
              if (activity?.threadId) onOpenThread(activity.threadId);
            }}
            title={canOpenSubject ? "Open this thread" : undefined}
            data-testid="coworker-current-subject"
          >
            <span className={`line-clamp-2 block text-sm leading-snug text-snow ${canOpenSubject ? "group-hover:underline" : ""}`}>
              {now.subject}
            </span>
            {nowNote || canOpenSubject ? (
              <span className={`mt-1 block text-[11px] ${now.needsYou ? "font-medium text-amber" : "text-mist"}`}>
                {now.needsYou ? (canOpenSubject ? "Needs your reply — open to respond" : "Needs your reply") : nowNote || "Open thread"}
                {canOpenSubject ? <span aria-hidden="true"> ›</span> : null}
              </span>
            ) : null}
          </button>
        ) : engineManaged && nowNote ? (
          <p className="mt-1.5 text-xs leading-relaxed text-mist" data-testid="coworker-current-note">{nowNote}</p>
        ) : null}
        {workersLine ? (
          <button
            type="button"
            className="group mt-2.5 flex w-full items-center justify-between gap-2 border-t border-line/70 pt-2.5 text-left text-[11px] text-mist transition-colors hover:text-snow"
            onClick={onOpenWorkers}
            title="Open Workers"
            data-testid="coworker-workers-line"
          >
            <span className="flex items-center gap-1.5"><WorkersIcon className="size-3.5" />{workersLine}</span>
            <span aria-hidden="true">›</span>
          </button>
        ) : null}
      </section>

      {recent.length > 0 ? (
        <section aria-label="Recent activity" data-testid="coworker-recent-activity">
          <h3 className="mb-2 px-1 text-[11px] font-semibold text-mist">Recent</h3>
          <ul className="divide-y divide-line rounded-2xl border border-line bg-ink">
            {recent.map((entry) => {
              const outcome = describeOutcome(entry);
              const failed = entry.outcome === "failed";
              const body = (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-snow" title={entry.title}>{entry.title}</span>
                    <span className={`mt-0.5 block truncate text-[11px] ${failed ? "text-rose" : "text-mist"}`} title={entry.error || undefined}>
                      {outcome}
                      {entry.kind === "responsibility" ? " · On a schedule" : ""}
                      {failed && entry.error ? ` · ${entry.error}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] text-mist" title={new Date(entry.finishedAt).toLocaleString()}>
                    {relativeTime(entry.finishedAt)}
                  </span>
                  {entry.threadId ? <span className="shrink-0 text-mist transition-colors group-hover:text-snow" aria-hidden="true">›</span> : null}
                </>
              );
              return (
                <li key={entry.id}>
                  {entry.threadId ? (
                    <button
                      type="button"
                      className="group flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors first:rounded-t-2xl last:rounded-b-2xl hover:bg-white/[0.04]"
                      onClick={() => onOpenThread(entry.threadId ?? "")}
                      title="Open this thread"
                    >
                      {body}
                    </button>
                  ) : (
                    <div className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* Coworker settings already has its control in the panel header; the foot keeps the two destinations that do not. */}
      <nav aria-label="More for this coworker" className="mt-auto flex items-center gap-1 border-t border-line pt-3 text-[11px]">
        <QuietLink icon={<WorkersIcon className="size-3.5" />} onClick={onOpenWorkers}>Workers</QuietLink>
        <QuietLink icon={<AppsIcon className="size-3.5" />} onClick={onOpenCapabilities}>Apps & tools</QuietLink>
        <QuietLink icon={<MemoryIcon className="size-3.5" />} onClick={onOpenMemory}>Memory</QuietLink>
      </nav>
    </div>
  );
}

function QuietLink({ icon, children, onClick }: { icon: ReactNode; children: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 font-medium text-mist transition-colors hover:bg-white/5 hover:text-snow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60"
      onClick={onClick}
    >
      <span className="text-mist/80" aria-hidden="true">{icon}</span>
      <span>{children}</span>
    </button>
  );
}

/** The one place the unavailable AI service is explained; raw detail stays behind a disclosure. */
function AiUnavailableNote({
  coworkerName,
  technical,
  onRestart,
}: {
  coworkerName: string;
  technical: string;
  onRestart: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="border-b border-line px-5 py-3" data-testid="coworker-ai-unavailable">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-rose/25 bg-rose/5 px-3 py-2.5">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-snow">
          <span className="font-semibold">AI is unavailable</span>
          <span className="text-mist">, so {coworkerName} cannot work right now.</span>
        </p>
        <Button
          variant="ghost"
          className="text-xs"
          aria-busy={busy}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onRestart().finally(() => setBusy(false));
          }}
        >
          {busy ? "Restarting…" : "Restart AI"}
        </Button>
        {technical ? (
          <details className="w-full text-[11px] text-mist">
            <summary className="cursor-pointer select-none">Technical details</summary>
            <p className="mt-1 break-words font-mono">{technical}</p>
          </details>
        ) : null}
      </div>
    </div>
  );
}

function CoworkerSettings({
  runtime,
  session,
  coworker,
  onCoworkerChanged,
  onCoworkerRemoved,
  onSyncProviders,
  onOpenAccount,
  onOpenMemory,
  focus,
}: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  coworker: CoworkerSummary;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  onCoworkerRemoved: (slug: string) => void;
  onSyncProviders: () => Promise<ProviderSyncRun>;
  onOpenAccount: () => void;
  onOpenMemory: () => void;
  /** Section to bring into view on open; the id makes repeat requests distinct. */
  focus: { id: number; section: "model" } | null;
}) {
  const modelSectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focus?.section === "model") modelSectionRef.current?.scrollIntoView({ block: "start" });
  }, [focus]);
  const [role, setRole] = useState(coworker.role);
  const [mission, setMission] = useState(coworker.mission);
  const [avatarColor, setAvatarColor] = useState(coworker.avatarColor);
  const [avatarGlasses, setAvatarGlasses] = useState(coworker.avatarGlasses);
  const [personality, setPersonality] = useState(coworker.personality);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmingRetire, setConfirmingRetire] = useState(false);
  const [confirmArmed, setConfirmArmed] = useState(false);

  useEffect(() => {
    if (!confirmingRetire) {
      setConfirmArmed(false);
      return;
    }
    const timer = window.setTimeout(() => setConfirmArmed(true), 500);
    return () => window.clearTimeout(timer);
  }, [confirmingRetire]);

  async function saveProfile() {
    setBusy(true);
    setError("");
    try {
      onCoworkerChanged(
        await coworkerBridge.coworkers.update(coworker.slug, {
          role: role.trim(),
          mission: mission.trim(),
          avatarColor,
          avatarGlasses,
          personality,
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function updateModel(selection: ModelSelection) {
    setError("");
    try {
      clearAutoPicked(coworker.slug);
      onCoworkerChanged(await coworkerBridge.coworkers.update(coworker.slug, selection));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function retire() {
    setBusy(true);
    setError("");
    try {
      await coworkerBridge.coworkers.remove(coworker.slug);
      onCoworkerRemoved(coworker.slug);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  const dirty = role.trim() !== coworker.role
    || mission.trim() !== coworker.mission
    || avatarColor !== coworker.avatarColor
    || avatarGlasses !== coworker.avatarGlasses
    || personality !== coworker.personality;
  const flatInput = "w-full rounded-lg border border-transparent bg-white/[0.04] px-2.5 py-1.5 text-sm text-snow outline-none placeholder:text-mist/60 focus:border-spark/40";

  return (
    <div className="space-y-7">
      {/* Who the coworker is, laid out as rows on the panel itself rather than as a card inside a card. */}
      <section data-testid="coworker-profile-settings">
        <div className="flex items-center gap-3.5 pb-3">
          <CoworkerAvatar animated color={avatarColor} glasses={avatarGlasses} name={coworker.name} size={56} />
          <div className="min-w-0">
            <p className="truncate text-base font-semibold tracking-[-0.02em] text-snow">{coworker.name}</p>
            <p className="truncate text-xs text-mist">{role.trim() || "Coworker"}</p>
          </div>
        </div>
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">Profile</h3>
        <div className="mt-1 divide-y divide-line/60">
          <AvatarControls
            layout="rows"
            color={avatarColor}
            glasses={avatarGlasses}
            onColorChange={setAvatarColor}
            onGlassesChange={setAvatarGlasses}
          />
          <label className="flex items-center gap-3 py-2.5">
            <span className="w-20 shrink-0 text-xs text-mist">Role</span>
            <input className={flatInput} value={role} placeholder="Research partner" onChange={(event) => setRole(event.target.value)} />
          </label>
          <label className="flex items-start gap-3 py-2.5">
            <span className="w-20 shrink-0 pt-1.5 text-xs text-mist">Mission</span>
            <textarea className={`${flatInput} min-h-16 resize-y`} value={mission} placeholder="What this coworker is here to move forward" onChange={(event) => setMission(event.target.value)} />
          </label>
          <PersonalityPicker layout="row" value={personality} seed={coworker.slug} onChange={setPersonality} />
        </div>
        {dirty ? (
          <div className="flex justify-end pt-3">
            <Button variant="primary" disabled={busy} onClick={() => void saveProfile()}>
              {busy ? "Saving…" : "Save changes"}
            </Button>
          </div>
        ) : null}
      </section>

      <section ref={modelSectionRef} data-testid="coworker-model-settings">
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">AI model</h3>
        <ModelPicker
          runtime={runtime}
          session={session}
          coworker={coworker}
          value={coworker.model}
          modelVariant={coworker.modelVariant}
          onChange={(selection) => void updateModel(selection)}
          onSyncProviders={onSyncProviders}
          onConnect={onOpenAccount}
          compact
        />
        <p className="mt-2 text-xs leading-relaxed text-mist">{coworker.name} uses this AI model and thinking effort for every discussion, assignment, and responsibility.</p>
      </section>

      <section className="flex items-center justify-between gap-3 border-t border-line/60 pt-4">
        <div className="min-w-0">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">Memory</h3>
          <p className="mt-1 text-xs leading-relaxed text-mist">Plain Markdown files {coworker.name} maintains; read or edit them any time.</p>
        </div>
        <Button variant="ghost" className="shrink-0 text-xs" onClick={onOpenMemory}>Open</Button>
      </section>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <section className="border-t border-line/60 pt-4">
        {confirmingRetire ? (
          <div className="space-y-2">
            <p className="text-sm font-semibold text-rose">Retire {coworker.name}?</p>
            <p className="text-xs leading-relaxed text-mist">
              Identity, memory, workspace files, Workers, and scheduled assignments move to a Retired folder inside your coworkers
              home. Nothing is deleted; you can restore or permanently remove it later from the Add coworker screen.
            </p>
            <div className="flex gap-2 pt-1">
              <Button variant="ghost" className="flex-1" disabled={busy} onClick={() => setConfirmingRetire(false)}>Keep coworker</Button>
              <Button variant="danger" className="flex-1" disabled={busy || !confirmArmed} onClick={() => void retire()}>
                {busy ? "Retiring…" : "Retire"}
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 rounded-lg py-1.5 text-left text-sm text-rose transition-colors hover:bg-rose/8"
            onClick={() => setConfirmingRetire(true)}
          >
            <span className="font-medium">Retire coworker…</span>
            <span className="text-xs text-mist">Nothing is deleted</span>
          </button>
        )}
      </section>
    </div>
  );
}
