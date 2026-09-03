import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { coworkerBridge, type CoworkerSummary, type LocalResponsibility, type ProviderSyncRun, type RuntimeInfo } from "@/lib/bridge";
import { describeHeaderStatus, describeNow, describeOutcome, describeStatusDetail, mergeRecentWork, relativeTime, type StatusTone } from "@/lib/activity-summary";
import type { ConnectState } from "@/lib/connect";
import { describeCoworkerSummary, showSummaryLine, summaryRowTitle, type CoworkerSummaryLine, type SummaryKind } from "@/lib/coworker-summary";
import type { DenSession } from "@/lib/den";
import { clearAutoPicked, markAutoPicked, peekStartingModel, takeStartingModel } from "@/lib/model-choice";
import { createCoworkerThreads, recommendModel, type CoworkerActivity, type ThreadListItem } from "@/lib/threads";
import { AvatarControls, CoworkerAvatar } from "@/ui/coworker-avatar";
import { PersonalityPicker } from "@/ui/personality-picker";
import { useWorkingSaying } from "@/ui/use-working-saying";
import { CapabilitiesPanel } from "@/ui/capabilities";
import { ActivityIcon, AppsIcon, Button, ErrorNote, IconButton, MemoryIcon, SlidersIcon, Tooltip } from "@/ui/kit";
import { useResizablePanel } from "@/ui/use-resizable-panel";
import { PanelContent, PanelHeader, PanelLevel, usePanelNavigation } from "@/ui/panel-nav";
import { pushCrumb, routeDepth, type PanelCrumb } from "@/lib/panel-route";
import {
  ACTIVITY_CRUMBS,
  APPS_TOOLS_CRUMB,
  PANEL_VIEWS,
  PANEL_VIEW_TITLES,
  activityRoute,
  activityScreen,
  appsToolsRoute,
  appsToolsRouteKey,
  isPanelView,
  settingsScreen,
  type ActivityLevel,
  type PanelView,
} from "@/lib/panel-views";
import { panelViewTooltip } from "@/lib/tooltip";
import type { PanelBounds } from "@/lib/panel-layout";
import { MemoryPanel } from "@/ui/memory";
import { DocumentBesidePane, DocumentsPanel, lastDocumentsOpened, useDocuments } from "@/ui/documents";
import { ThreadsPanel, type DocumentHooks } from "@/ui/threads";
import { WorkersPanel } from "@/ui/workers";
import { AssignmentsPanel } from "@/ui/assignments";
import type { WorkerSummary } from "@/lib/workers";
import { Row, RowList, useReturnFocus } from "@/ui/rows";
import { ModelPicker, type ModelSelection } from "@/ui/model-picker";
import type { SettingsSection } from "@/ui/openwork-settings";

const CONTEXT_PANEL_WIDTH_KEY = "open-coworker.context-panel-width";
const CONTEXT_PANEL_DEFAULT_WIDTH = 360;
const MAIN_WORKSPACE_MIN_WIDTH = 520;
/** The context panel: drag it narrower than it can usefully be and it folds to an icon strip. */
const CONTEXT_PANEL_BOUNDS: PanelBounds = { min: 320, max: 440, collapsedWidth: 56, collapseBelow: 240 };
/** The reading pane beside the conversation, when the window has room for it. */
const BESIDE_PANE_WIDTH = 440;

const CONTEXT_ICONS: Record<PanelView, (props: { className?: string }) => ReactNode> = {
  overview: ActivityIcon,
  memory: MemoryIcon,
  settings: SlidersIcon,
};
/** From this window width on, an App or skill detail may open in a column beside the conversation… */
const BESIDE_APPS_MIN_WINDOW = 1_280;
/** …a column at least this wide, and only while the conversation keeps its own minimum next to it. */
const BESIDE_APPS_MIN_WIDTH = 480;
/** Below this window width the open panel lies over the conversation instead of beside it. */
const NARROW_WINDOW = 900;

const STATUS_TEXT_TONE: Record<StatusTone, string> = { mist: "text-mist", amber: "text-amber", rose: "text-rose" };

/** Which Activity level each part of the summary line opens. */
const SUMMARY_LEVELS: Record<SummaryKind, ActivityLevel> = { assignments: "assignments", workers: "workers", documents: "documents" };

/**
 * The header's one plain word about the coworker — no dot, colour only when it
 * asks for the person or reports a failure. The tooltip adds the reason and the
 * time; the live row in the transcript owns the moment-to-moment phrase.
 */
export function HeaderStatusWord({ activity, engineManaged }: { activity: CoworkerActivity | undefined; engineManaged: boolean }) {
  const status = describeHeaderStatus(activity, engineManaged);
  const detail = describeStatusDetail(activity, engineManaged);
  return (
    <Tooltip content={detail} side="bottom">
      <span
        data-testid="coworker-top-status"
        data-tone={status.tone}
        tabIndex={detail ? 0 : undefined}
        className={`window-no-drag shrink-0 rounded-md text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60 ${STATUS_TEXT_TONE[status.tone]}`}
      >
        {status.word}
      </span>
    </Tooltip>
  );
}

/** A request another view makes of this one: open a settings section, or open one thread. */
export type CoworkerHomeRequest =
  | { id: number; kind: "settings"; section: "model" }
  | { id: number; kind: "thread"; threadId: string };

/**
 * What the coworker holds besides its documents — the scheduled assignments and
 * the Workers — read here once so the composer's summary line, the Activity
 * rows, and the Assignments level share one picture. Follows a run closely
 * while one is going or waiting, and idles otherwise.
 */
function useCoworkerHoldings(slug: string): {
  scheduled: LocalResponsibility[];
  setScheduled: (items: LocalResponsibility[]) => void;
  workers: WorkerSummary[];
} {
  const [scheduled, setScheduled] = useState<LocalResponsibility[]>([]);
  const [workers, setWorkers] = useState<WorkerSummary[]>([]);
  const busy = scheduled.some((item) => item.latestRun?.status === "running" || item.latestRun?.status === "queued")
    || workers.some((worker) => worker.status === "running" || worker.status === "starting");
  useEffect(() => {
    setScheduled([]);
    setWorkers([]);
  }, [slug]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      Promise.all([
        coworkerBridge.localResponsibilities.list(slug).catch((): LocalResponsibility[] => []),
        coworkerBridge.workers.list(slug).catch((): WorkerSummary[] => []),
      ])
        .then(([items, liveWorkers]) => {
          if (cancelled) return;
          setScheduled((current) => (JSON.stringify(current) === JSON.stringify(items) ? current : items));
          setWorkers((current) => (JSON.stringify(current) === JSON.stringify(liveWorkers) ? current : liveWorkers));
        })
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(() => void load(), busy ? 1_500 : 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [busy, slug]);
  return { scheduled, setScheduled, workers };
}

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
  /** The coworker's one-off assignment threads, as the conversation column lists them, and what each waits on the person for. */
  const [assignmentThreads, setAssignmentThreads] = useState<ThreadListItem[]>([]);
  const [assignmentAttention, setAssignmentAttention] = useState<Record<string, string>>({});
  const onAssignmentsChange = useCallback((items: ThreadListItem[], attention: Record<string, string>) => {
    // The column re-reads every few seconds; only a real change reaches the summary line and the rows.
    setAssignmentThreads((current) => (JSON.stringify(current) === JSON.stringify(items) ? current : items));
    setAssignmentAttention((current) => (JSON.stringify(current) === JSON.stringify(attention) ? current : attention));
  }, []);
  /** From a card's Open: show this document in the Documents level; the id makes repeats distinct. */
  const [openDocumentRequest, setOpenDocumentRequest] = useState<{ id: number; documentId: string } | null>(null);
  /** The document open in the reading pane beside the conversation, when the window has room. */
  const [besideDocumentId, setBesideDocumentId] = useState("");
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const { documents, refresh: refreshDocuments, error: documentsError } = useDocuments(coworker.slug);
  const holdings = useCoworkerHoldings(coworker.slug);
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
   * Where the panel is: one of three views and a short path inside it, remembered per view
   * for the session. Escape goes back a level, or closes the panel at a root; a deep link
   * from elsewhere in the app (a receipt, the summary line) opens the panel on its route.
   */
  const nav = usePanelNavigation<PanelView>({
    initialView: "overview",
    isView: isPanelView,
    open: !contextPanel.collapsed,
    onEscapeAtRoot: contextPanel.collapse,
    onRequestOpen: contextPanel.expand,
  });
  const contextView = nav.route.view;
  const [panelContentElement, setPanelContentElement] = useState<HTMLDivElement | null>(null);
  // Back hands focus to the row a level was opened from — an Activity count row or the Apps & tools row.
  useReturnFocus(nav.returnFocusRow, panelContentElement);
  /**
   * Open one view, unfolding the panel if it was closed. Choosing the open view again closes
   * it; the strip icon of the view already showing goes to that view's root, another view
   * opens where it was last.
   */
  function showContext(view: PanelView): void {
    if (!contextPanel.collapsed && view === contextView) {
      contextPanel.collapse();
      return;
    }
    if (view === contextView) nav.toRoot(view);
    else nav.showView(view);
    if (contextPanel.collapsed) contextPanel.expand();
  }
  const navigateTo = nav.navigate;
  const expandContextPanel = contextPanel.expand;
  /** Open one level of Activity — Documents, Workers, or Assignments — unfolding the panel. */
  const openActivityLevel = useCallback((level: ActivityLevel) => {
    navigateTo(activityRoute(level));
    expandContextPanel();
  }, [expandContextPanel, navigateTo]);
  /** Coworker settings at its own rows, brought to one section; never deeper in Apps & tools. */
  const openSettingsSection = useCallback((section: "model", id: number) => {
    navigateTo({ view: "settings", path: [] });
    expandContextPanel();
    setSettingsFocus({ id, section });
  }, [expandContextPanel, navigateTo]);
  const handledRequestRef = useRef(0);
  useEffect(() => {
    if (!request || handledRequestRef.current === request.id) return;
    handledRequestRef.current = request.id;
    if (request.kind === "thread") {
      setOpenThreadRequest({ id: request.id, threadId: request.threadId });
      return;
    }
    openSettingsSection(request.section, request.id);
  }, [openSettingsSection, request]);
  const collapseContextPanel = contextPanel.collapse;
  const toRoot = nav.toRoot;
  /** Moving to another coworker returns to the conversation; the panel does not follow. */
  useEffect(() => {
    collapseContextPanel();
    toRoot("overview");
    setBesideDocumentId("");
    setBesidePath(null);
  }, [collapseContextPanel, coworker.slug, toRoot]);
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
  /** An App or skill detail open in a column beside the conversation, while the window is wide enough; its path is the levels below Apps & tools. */
  const [besidePath, setBesidePath] = useState<PanelCrumb[] | null>(null);
  const besideAppsAvailable = windowWidth >= BESIDE_APPS_MIN_WINDOW
    && windowWidth - railWidth - panelWidth - BESIDE_APPS_MIN_WIDTH >= MAIN_WORKSPACE_MIN_WIDTH;
  useEffect(() => {
    if (besideAppsAvailable || !besidePath) return;
    // The window shrank: the detail folds back into the panel at the same route.
    navigateTo(appsToolsRoute(besidePath));
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
      openActivityLevel("documents");
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
  const summary = describeCoworkerSummary({
    assignments: assignmentThreads,
    scheduled: holdings.scheduled,
    workers: holdings.workers,
    documents: documents ?? [],
    documentsSeenAt: lastDocumentsOpened(coworker.slug),
  });
  const documentsChanged = summary.rows.find((row) => row.kind === "documents")?.changed ?? 0;
  // "Nothing in progress" is worth a line once the coworker has finished something; a new coworker's first message gets none.
  const hasWorked = Boolean(activity?.last) || (activity?.recent?.length ?? 0) > 0;
  const summaryLine: CoworkerSummaryLine | null = showSummaryLine(summary, hasWorked) ? summary : null;
  const askToUpdate = (text: string) => setDiscussionDraft({ id: Date.now(), text });
  const openThread = (threadId: string) => setOpenThreadRequest({ id: Date.now(), threadId });
  const explain = (text: string) => setDiscussionDraft({ id: Date.now(), text });
  /** The panel's Assignments level hands the composer an empty assignment; the conversation column shows it. */
  const newAssignment = () => setAssignmentDraft({ id: Date.now(), text: "" });

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
        const catalog = await threads.listModelCatalog();
        // A model chosen on the local mode screen before this coworker existed goes first, once;
        // a provider added a moment ago can still be loading, so wait a little for it.
        const wanted = peekStartingModel();
        const chosen = wanted ? catalog.models.find((model) => model.id === wanted) : undefined;
        if (cancelled) return;
        if (wanted && !chosen) {
          if (attempts < 8) {
            timer = window.setTimeout(() => void attempt(), 3_000);
            return;
          }
          takeStartingModel();
        }
        const pick = chosen ?? recommendModel(catalog);
        if (pick) {
          if (chosen) takeStartingModel();
          else markAutoPicked(coworker.slug, pick.id);
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

  const activityLevel = activityScreen(nav.route.path);
  const settingsLevel = settingsScreen(nav.route.path);

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
          <HeaderStatusWord activity={activity} engineManaged={runtime.engineManaged} />
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
            onAssignmentsChange={onAssignmentsChange}
            headerSlots={{ title: headerTitleSlot, actions: headerActionsSlot }}
            onOpenModelSettings={() => openSettingsSection("model", Date.now())}
            onOpenAccount={() => onOpenOpenWork("account")}
            onActivityChange={onActivityChange}
            documents={documentHooks}
            summary={summaryLine}
            onOpenSummary={(kind) => openActivityLevel(SUMMARY_LEVELS[kind])}
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
          data-route={appsToolsRouteKey(besidePath)}
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
              onPush={(crumb) => setBesidePath(pushCrumb({ view: "settings", path: besidePath }, crumb).path)}
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
              {PANEL_VIEWS.map((view) => {
                const Icon = CONTEXT_ICONS[view];
                const active = view === contextView;
                return (
                  <IconButton
                    key={view}
                    label={PANEL_VIEW_TITLES[view]}
                    tooltip={panelViewTooltip(view, coworker.name)}
                    tooltipSide="left"
                    data-testid={`context-rail-${view}`}
                    data-active={active ? "true" : "false"}
                    aria-current={active ? "true" : undefined}
                    className={`window-no-drag ${active ? "bg-white/8 text-snow ring-1 ring-white/10" : ""}`}
                    onClick={() => showContext(view)}
                  >
                    <span className="relative flex">
                      <Icon />
                      {view === "overview" && documentsChanged > 0 ? (
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
          rootTitle={PANEL_VIEW_TITLES[contextView]}
          width={contextPanel.width}
          onBack={nav.back}
          onToDepth={nav.toDepth}
          leading={contextView !== "overview" ? (
            <IconButton label="Back to activity" className="window-no-drag" onClick={() => nav.toRoot("overview")}>
              <span aria-hidden="true">←</span>
            </IconButton>
          ) : undefined}
        />
        <PanelContent route={nav.route} containerRef={setPanelContentElement}>
          {contextView === "overview" && activityLevel.kind === "root" ? (
            <PanelLevel key="activity" direction={nav.direction}>
              <CoworkerOverview
                coworker={coworker}
                activity={activity}
                engineManaged={runtime.engineManaged}
                scheduled={holdings.scheduled}
                summary={summary}
                onOpenThread={openThread}
                onOpenLevel={(kind) => nav.push(ACTIVITY_CRUMBS[SUMMARY_LEVELS[kind]], `activity:${kind}`)}
              />
            </PanelLevel>
          ) : null}
          {contextView === "overview" && activityLevel.kind === "documents" ? (
            <PanelLevel key="documents" direction={nav.direction}>
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
            </PanelLevel>
          ) : null}
          {contextView === "overview" && activityLevel.kind === "workers" ? (
            <PanelLevel key="workers" direction={nav.direction}>
              <WorkersPanel coworker={coworker} onOpenThread={openThread} />
            </PanelLevel>
          ) : null}
          {contextView === "overview" && activityLevel.kind === "assignments" ? (
            <PanelLevel key="assignments" direction={nav.direction}>
              <AssignmentsPanel
                session={session}
                coworkers={coworkers}
                coworker={coworker}
                assignments={assignmentThreads}
                attentionBySession={assignmentAttention}
                scheduled={holdings.scheduled}
                onScheduledChanged={holdings.setScheduled}
                onCoworkerChanged={onCoworkerChanged}
                onConnect={() => onOpenOpenWork()}
                onOpenThread={openThread}
                onExplain={explain}
                onNewAssignment={newAssignment}
              />
            </PanelLevel>
          ) : null}
          {contextView === "memory" ? <MemoryPanel coworker={coworker} /> : null}
          {contextView === "settings" && settingsLevel.kind === "root" ? (
            <PanelLevel key="settings" direction={nav.direction}>
              <CoworkerSettings
                runtime={runtime}
                session={session}
                coworker={coworker}
                onCoworkerChanged={onCoworkerChanged}
                onCoworkerRemoved={onCoworkerRemoved}
                onSyncProviders={onSyncProviders}
                onOpenAccount={() => onOpenOpenWork("account")}
                onOpenMemory={() => nav.showView("memory")}
                onOpenAppsTools={() => nav.push(APPS_TOOLS_CRUMB, APPS_TOOLS_CRUMB.id)}
                focus={settingsFocus}
              />
            </PanelLevel>
          ) : null}
          {contextView === "settings" && settingsLevel.kind === "apps-tools" ? (
            <CapabilitiesPanel
              runtime={runtime}
              session={session}
              coworker={coworker}
              connect={connect}
              onRepairConnect={onRepairConnect}
              onConnectAccount={onConnectAccount}
              onAssign={(text) => {
                setAssignmentDraft({ id: Date.now(), text });
                nav.toRoot("overview");
              }}
              onDiscuss={(text) => {
                setDiscussionDraft({ id: Date.now(), text });
                nav.toRoot("overview");
              }}
              path={settingsLevel.path}
              width={contextPanel.width}
              direction={nav.direction}
              onPush={nav.push}
              onSetPath={(path, fromRow) => nav.setPath([APPS_TOOLS_CRUMB, ...path], fromRow)}
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
        </PanelContent>
          </>
        )}
      </aside>
    </div>
  );
}

/**
 * The Activity root, as flat rows with hairlines: what is happening now (the
 * subject, its note, the time), then what the coworker holds — Documents,
 * Workers, Assignments — each opening its level, then Recent. The header owns
 * the state word, so nothing here repeats it.
 */
function CoworkerOverview({
  coworker,
  activity,
  engineManaged,
  scheduled,
  summary,
  onOpenThread,
  onOpenLevel,
}: {
  coworker: CoworkerSummary;
  activity?: CoworkerActivity;
  engineManaged: boolean;
  /** Scheduled assignments on this Mac, for the Recent list's finished runs. */
  scheduled: LocalResponsibility[];
  summary: CoworkerSummaryLine;
  onOpenThread: (threadId: string) => void;
  onOpenLevel: (kind: SummaryKind) => void;
}) {
  const now = describeNow(activity);
  const saying = useWorkingSaying(
    coworker.personality,
    `${coworker.slug}:${activity?.threadId ?? "work"}`,
    activity?.state === "working",
  );
  const nowNote = saying ? `${saying}…` : now.note;
  const recent = mergeRecentWork(activity, scheduled);
  const nowTime = relativeTime(activity?.updatedAt ?? 0);
  const canOpenSubject = Boolean(activity?.threadId);
  const showNow = Boolean(now.subject) || Boolean(engineManaged && nowNote);

  return (
    <div className="flex min-h-full flex-col gap-4">
      <section aria-label="Current activity" className={showNow ? "border-b border-line pb-3" : ""} data-testid="coworker-activity-summary">
        {now.subject ? (
          <button
            type="button"
            className={`flex w-full items-start gap-3 rounded-lg px-1 py-1.5 text-left ${canOpenSubject ? "group transition-colors hover:bg-white/[0.04]" : "cursor-default"}`}
            disabled={!canOpenSubject}
            onClick={() => {
              if (activity?.threadId) onOpenThread(activity.threadId);
            }}
            data-testid="coworker-current-subject"
          >
            <span className="min-w-0 flex-1">
              <span className={`line-clamp-2 block text-sm leading-snug text-snow ${canOpenSubject ? "group-hover:underline" : ""}`}>
                {now.subject}
              </span>
              {nowNote || now.needsYou ? (
                <span className={`mt-0.5 block text-[11px] ${now.needsYou ? "font-medium text-amber" : "text-mist"}`}>
                  {now.needsYou ? (canOpenSubject ? "Needs your reply — open to respond" : "Needs your reply") : nowNote}
                </span>
              ) : null}
            </span>
            {nowTime ? (
              <span className="shrink-0 pt-0.5 text-[11px] text-mist" title={activity?.updatedAt ? new Date(activity.updatedAt).toLocaleString() : undefined}>
                {nowTime}
              </span>
            ) : null}
            {canOpenSubject ? <span className="shrink-0 pt-0.5 text-mist transition-colors group-hover:text-snow" aria-hidden="true">›</span> : null}
          </button>
        ) : engineManaged && nowNote ? (
          <p className="px-1 py-1.5 text-xs leading-relaxed text-mist" data-testid="coworker-current-note">{nowNote}</p>
        ) : null}
      </section>

      <RowList label={`What ${coworker.name} holds`} testId="coworker-holdings" divided>
        {summary.rows.map((row) => (
          <Row
            key={row.kind}
            id={`activity:${row.kind}`}
            title={summaryRowTitle(row)}
            status={row.note || undefined}
            mark={row.changed > 0}
            onOpen={() => onOpenLevel(row.kind)}
            testId={`activity-row-${row.kind}`}
          />
        ))}
      </RowList>

      {recent.length > 0 ? (
        <section aria-label="Recent activity" className="border-t border-line pt-3" data-testid="coworker-recent-activity">
          <h3 className="mb-1 px-1 text-[11px] font-semibold text-mist">Recent</h3>
          <ul className="divide-y divide-line">
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
                      className="group flex w-full items-center gap-3 px-1 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
                      onClick={() => onOpenThread(entry.threadId ?? "")}
                    >
                      {body}
                    </button>
                  ) : (
                    <div className="flex w-full items-center gap-3 px-1 py-2.5 text-left">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
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
  onOpenAppsTools,
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
  /** Apps & tools is the first level under these settings. */
  onOpenAppsTools: () => void;
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
      {/* What the coworker can reach comes first: Apps & tools is a level of these settings. */}
      <RowList label="Coworker settings" testId="coworker-settings-rows">
        <Row
          id={APPS_TOOLS_CRUMB.id}
          icon={<AppsIcon />}
          title={APPS_TOOLS_CRUMB.title}
          status={`Apps, skills, and the tools ${coworker.name} can use`}
          onOpen={onOpenAppsTools}
          testId="settings-row-apps-tools"
        />
      </RowList>

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
