/// <reference path="./novnc.d.ts" />
"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { ArrowLeft, ArrowRight, Check, ExternalLink, Globe, Loader2, Lock, Maximize2, Minimize2, Monitor, Play, Plus, RotateCw, Share, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { z } from "zod";
import type { BrowserTeachingContext } from "@openwork/types/browser-demonstration";
import type { WorkbotViewContext } from "@openwork/types/workbot-context";
import { TEACHING_WINDOW_PLACEMENT, TeachButton, WorkbotTeaching } from "./teaching";
import { addressFor, ScreencastViewer, type ScreencastPage } from "./screencast";
import { allowViewFrames, captureFrame, forgetViewFrames, frameKey, lastFrame, subscribeFrame, viewFramesDenied } from "./frame-cache";
import { computerViews, errorMessage, workbotHost } from "./host";
import { inChat, useWorkbotChat } from "./data";
import { taskHeader } from "./computer-work";

const viewerSchema = z.union([z.object({ state: z.literal("paused") }), z.object({ state: z.literal("connected"), url: z.string().url(), expiresAt: z.number(), paused: z.boolean() })]);
const button = "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-[var(--wb-text)] hover:bg-[var(--wb-chip)] disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";

type ComputerView = "browser" | "computer";

/**
 * Each view has its own path (/browser, /computer), so a reload or a shared link opens the same view. A view this
 * person doesn't have (each is its own rollout) opens the one they do.
 */
function viewFromLocation(views: ComputerView[]): ComputerView {
  const asked: ComputerView = typeof window !== "undefined" && window.location.pathname.replace(/\/+$/, "") === "/computer" ? "computer" : "browser";
  return views.includes(asked) ? asked : views[0] ?? asked;
}

/** Opens a page Workbot opened, in its Browser view (/browser/<id>), without reloading Workbot. */
export function openBrowserPage(id: string) {
  window.history.pushState(null, "", `/browser/${id}${window.location.search}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * Both views belong to the main conversation's computer. noVNC carries the desktop's pixels and native input;
 * watching the browser streams the page itself instead.
 */
export function WorkbotComputer({ onTeachingChange, onRun, canTeach = true, onViewChange, onContextChange, task, surface = "browser", onClose, onStop, expanded = false, onExpand }: {
  onTeachingChange?(context: BrowserTeachingContext | undefined): void;
  onRun?(text: string): void | Promise<void>;
  canTeach?: boolean;
  onViewChange?(view: ComputerView): void;
  /** The tab in front of the Browser view, for the chat beside it; null when none is on screen. */
  onContextChange?(context: WorkbotViewContext | null): void;
  task?: { id: string; title: string; status: "working" | "completed" | "failed"; reason?: string };
  /** Which view a task's card opened beside the chat: its browser, or the rest of its computer. Only with `task`. */
  surface?: ComputerView;
  onClose?(): void;
  onStop?(): void | Promise<void>;
  expanded?: boolean;
  onExpand?(): void;
}) {
  const host = workbotHost();
  // Each side chat has its own computer: this view and its controls are for the chat it opens in.
  const chat = useWorkbotChat();
  const [teaching, setTeaching] = useState<BrowserTeachingContext>();
  const teachingChange = useCallback((context: BrowserTeachingContext | undefined) => { setTeaching(context); onTeachingChange?.(context); }, [onTeachingChange]);
  const recording = teaching !== undefined && teaching.phase !== "draft";
  const screen = useRef<HTMLDivElement>(null);
  const [shared, setShared] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopped, setStopped] = useState(false);
  const views = computerViews(host);
  const [view, setViewState] = useState<ComputerView>(() => task ? surface : viewFromLocation(views));
  useEffect(() => { if (task) setViewState(surface); }, [task?.id, surface]);
  const setView = (next: ComputerView) => {
    if (next === view) return;
    window.history.pushState(null, "", `/${next}${window.location.search}`);
    setViewState(next);
  };
  useEffect(() => {
    const sync = () => { if (/^\/(browser(\/[a-z0-9]{1,16})?|computer)\/?$/.test(window.location.pathname)) setViewState(task ? surface : viewFromLocation(computerViews(workbotHost()))); };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [task, surface]);
  useEffect(() => { onViewChange?.(view); }, [view, onViewChange]);
  const [control, setControl] = useState(false);
  const [teachOpen, setTeachOpen] = useState(false);
  const teachable = canTeach && host.browserDemonstrations === true && views.includes("browser");
  const [agentPaused, setAgentPaused] = useState(false);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [changing, setChanging] = useState(false);
  // The person rebuilt the computer from this task's view, which stopped the task.
  const [rebuilt, setRebuilt] = useState(false);
  useEffect(() => { setRebuilt(false); }, [task?.id, chat]);
  // Still waiting for the computer after a while: Rebuild is offered beside the wait, not only once it has failed.
  const [slow, setSlow] = useState(false);
  const [livePage, setLivePage] = useState<ScreencastPage | null>(null);
  const previewEnabled = Boolean(host.identity);
  // A browser task keeps its own pictures; the computer's are kept for the view, where its cards read them.
  const frameTask = view === "browser" ? task?.id : undefined;
  const [denied, setDenied] = useState(() => viewFramesDenied(glimpseKey(chat, view)));
  const deniedRef = useRef(denied);
  const [snapshot, setSnapshot] = useState(() => previewEnabled ? lastFrame(glimpseKey(chat, view, frameTask)) : null);
  // A past task keeps its own final picture even when today's browser is opened from that card.
  const captureKey = useRef(glimpseKey(chat, view));
  captureKey.current = glimpseKey(chat, view, task?.status === "working" ? frameTask : undefined);
  const [stream, setStream] = useState<ScreencastViewer | null>(null);
  const identity = host.identity ? `${host.identity.organizationId}:${host.identity.principalId}` : "";
  useLayoutEffect(() => {
    const key = glimpseKey(chat, view, frameTask);
    const read = () => {
      const blocked = viewFramesDenied(key);
      deniedRef.current = blocked; setDenied(blocked);
      setSnapshot(previewEnabled && !blocked ? lastFrame(key) : null);
      if (blocked) { setConnected(false); setLivePage(null); setStream(null); setError("Computer access is unavailable. Sign in again or ask your workspace admin."); }
    };
    read();
    return subscribeFrame(key, read);
  }, [identity, chat, view, frameTask, previewEnabled]);
  useEffect(() => { setLivePage(null); }, [chat, view, identity]);
  useEffect(() => { setStopped(false); }, [task?.id, task?.title, task?.status, chat]);
  useEffect(() => {
    setShared(false); setShareError(null);
  }, [livePage?.url]);
  useEffect(() => {
    if (!shared) return;
    const timer = setTimeout(() => setShared(false), 3_000);
    return () => clearTimeout(timer);
  }, [shared]);
  const away = useAway(30_000) && !recording;
  // Only the page stream says which tab is in front; noVNC shows pixels alone.
  const frontId = view === "browser" && !paused && !error && !denied ? livePage?.id ?? null : null;
  const frontUrl = denied ? "" : livePage?.url ?? "", frontTitle = denied ? "" : livePage?.title ?? "";
  useEffect(() => {
    onContextChange?.(frontId ? { kind: "browser", tabId: frontId, url: frontUrl.slice(0, 2048), title: frontTitle.slice(0, 512) } : null);
  }, [frontId, frontUrl, frontTitle, onContextChange]);
  useEffect(() => () => onContextChange?.(null), [onContextChange]);

  useEffect(() => {
    const target = screen.current;
    // Nobody watching a hidden tab, so stop streaming until it is shown again.
    if (!target || paused || away) return;
    setSnapshot(previewEnabled ? lastFrame(glimpseKey(chat, view, frameTask)) : null);
    setError(null); setConnected(false); setReconnecting(false); setUpdating(false); setStarting(false); setStream(null);
    const disconnect = connectDesktopViewer(target, host, { view, control, chat, wake: true }, {
      paused: () => setPaused(true),
      agentPaused: setAgentPaused,
      connected: () => { deniedRef.current = false; setDenied(false); setConnected(true); setReconnecting(false); setUpdating(false); setStarting(false); setError(null); },
      starting: () => setStarting(true),
      reconnecting: () => { if (previewEnabled && !deniedRef.current) { captureFrame(target, captureKey.current); setSnapshot(lastFrame(glimpseKey(chat, view, frameTask))); } setConnected(false); setReconnecting(true); },
      updating: () => { setConnected(false); setUpdating(true); },
      failed: (message, blocked = false) => {
        if (blocked) { deniedRef.current = true; setDenied(true); setSnapshot(null); setLivePage(null); setStream(null); }
        setConnected(false); setUpdating(false); setStarting(false); setError(message);
      },
      page: setLivePage,
      stream: setStream,
    });
    return () => {
      if (previewEnabled && !deniedRef.current) captureFrame(target, captureKey.current);
      disconnect();
    };
  }, [host, identity, chat, view, control, paused, away, revision, task?.id, previewEnabled]);
  useEffect(() => {
    setSlow(false);
    if (connected || paused || away || error || denied || updating || changing) return;
    const timer = setTimeout(() => setSlow(true), REBUILD_OFFER_AFTER_MS);
    return () => clearTimeout(timer);
  }, [connected, paused, away, error, denied, updating, changing, revision, chat, view, control]);
  useEffect(() => {
    if (!connected || !previewEnabled || denied) return;
    const capture = () => { if (screen.current && !deniedRef.current) captureFrame(screen.current, captureKey.current); };
    capture();
    const timer = setInterval(capture, 1_000);
    return () => clearInterval(timer);
  }, [connected, host, chat, view, task?.id, previewEnabled, denied]);

  const action = async (next: "pause" | "resume" | "continue" | "rebuild") => {
    if (changing) return false;
    setChanging(true); setError(null);
    try {
      const { response, payload } = await host.requestJson(inChat("/v1/workbot/computer/action", chat), { method: "POST", body: JSON.stringify({ action: next }) }, 195_000);
      if (!response.ok) throw new Error(errorMessage(payload, "Your computer didn't respond. Try again."));
      if (next === "continue" || next === "rebuild") { setControl(false); setAgentPaused(false); }
      if (next === "rebuild" && task) setRebuilt(true);
      setPaused(next === "pause");
      setRevision(current => current + 1);
      return true;
    } catch (error) { setError(error instanceof Error ? error.message : "Your computer didn't respond."); }
    finally { setChanging(false); }
  };

  const title = task?.title || (view === "browser" ? "Workbot's browser" : "Workbot's computer");
  const header = taskHeader(task, rebuilt);
  const status = header ? header.status : stopped ? "Stopped" : control && connected ? "You have control" : error ? "Disconnected" : paused ? "Paused" : updating ? "Updating" : starting ? "Starting" : reconnecting ? "Reconnecting" : agentPaused ? "Waiting for you" : "Working";
  const hostname = (() => { try { return new URL(frontUrl).hostname; } catch { return ""; } })();
  const stop = async () => {
    if (stopping) return;
    setStopping(true); setError(null);
    try {
      if (onStop) await onStop();
      else {
        const { response, payload } = await host.requestJson(inChat("/v1/workbot/stop", chat), { method: "POST" }, 15_000);
        if (!response.ok) throw new Error(errorMessage(payload, "Couldn't stop the task. Try again."));
      }
      setStopped(true);
    } catch (error) { setError(error instanceof Error ? error.message : "Couldn't stop the task. Try again."); }
    finally { setStopping(false); }
  };
  const share = async () => {
    const url = /^https?:\/\//.test(frontUrl) ? frontUrl : window.location.href;
    setShareError(null);
    try {
      if (navigator.share) await navigator.share({ title, url });
      else { await navigator.clipboard.writeText(url); setShared(true); }
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) setShareError("Couldn't share this page. Try again.");
    }
  };
  const close = () => {
    if (onClose) onClose();
    else { window.history.pushState(null, "", `/${window.location.search}`); window.dispatchEvent(new PopStateEvent("popstate")); }
  };
  const iconButton = "inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--wb-chip)] text-[var(--wb-text)] hover:bg-[var(--wb-bubble)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";
  const footerButton = "inline-flex h-12 min-w-0 flex-1 items-center justify-center rounded-full px-4 text-[14px] font-medium disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";

  return <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wb-surface)]" aria-label={view === "browser" ? "Browser" : "Computer"}>
    <header className="grid shrink-0 grid-cols-[1fr_minmax(0,6fr)_1fr] items-center gap-2 border-b border-[var(--wb-hairline)] px-3 py-3 sm:px-4">
      <button type="button" className={iconButton} aria-label={shared ? "Link copied" : "Share page"} title={shared ? "Link copied" : "Share page"} onClick={() => void share()}>{shared ? <Check size={16} strokeWidth={1.5} aria-hidden /> : <Share size={16} strokeWidth={1.5} aria-hidden />}</button>
      <div className="min-w-0 text-center">
        <h2 className="truncate text-[14px] font-medium text-[var(--wb-text)]" title={title}>{title}</h2>
        <div role="status" className="flex min-w-0 items-center justify-center gap-1.5 text-[12px] text-[var(--wb-muted)]">
          <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${header?.failed || error ? "bg-[var(--wb-danger)]" : task?.status === "working" && !stopped && !header ? "workbot-presence-dot" : "bg-current"}`} />
          <span className="shrink-0">{status}</span>{hostname ? <><span aria-hidden>·</span><span className="truncate">{hostname}</span></> : null}
        </div>
      </div>
      <div className="flex items-center justify-end gap-1">
        {onExpand ? <button type="button" className={`${iconButton} hidden sm:inline-flex`} aria-label={expanded ? "Collapse browser" : "Expand browser"} title={expanded ? "Collapse browser" : "Expand browser"} onClick={onExpand}>{expanded ? <Minimize2 size={16} strokeWidth={1.5} aria-hidden /> : <Maximize2 size={16} strokeWidth={1.5} aria-hidden />}</button> : null}
        <button type="button" className={iconButton} aria-label="Close browser view" title="Close browser view" onClick={close}><X size={16} strokeWidth={1.5} aria-hidden /></button>
      </div>
    </header>
    {shareError || shared ? <p role="status" className="px-4 py-1 text-[12px] text-[var(--wb-muted)]">{shareError ?? "Link copied"}</p> : null}
    {header?.reason ? <p role="status" className="px-4 py-2 text-[13px] text-[var(--wb-muted)]">{header.reason}</p> : null}
    {!task && views.length > 1 ? <div className="flex shrink-0 items-center gap-1 border-b border-[var(--wb-hairline)] px-3 py-1" role="group" aria-label="Computer view">
      {views.map(value => <button key={value} type="button" aria-pressed={view === value} disabled={recording} onClick={() => setView(value)} className={`${button} ${view === value ? "bg-[var(--wb-chip)]" : ""}`}>{value === "browser" ? "Browser" : "Computer"}</button>)}
    </div> : null}
    {!denied && view === "browser" && livePage ? <BrowserFrame page={livePage} stream={stream} teaching={teachable && control ? <TeachButton open={teachOpen} recording={teaching?.phase === "recording"} suspended={paused} onClick={() => setTeachOpen(current => !current)} /> : undefined} /> : null}
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[var(--wb-surface)]">
      {!denied && !connected && snapshot ? <img src={snapshot} alt="Last browser frame" className="pointer-events-none absolute inset-0 h-full w-full object-contain object-top" /> : null}
      {!connected && !snapshot ? <BrowserLoading toolbar={view === "browser" && !livePage} /> : null}
      <div ref={screen} className={`relative h-full w-full ${paused || error || denied ? "invisible" : ""}`} aria-label={`${view === "browser" ? "Browser" : "Computer"} live view`} aria-busy={!connected && !error} />
      {paused || error || slow ? <div className="absolute inset-x-3 bottom-3 flex flex-col items-center justify-center gap-3 rounded-xl bg-[var(--wb-surface)] p-4 text-center shadow-[var(--wb-card-shadow)]">
        {view === "browser" ? <Globe size={24} strokeWidth={1.5} className="text-[var(--wb-muted)]" aria-hidden /> : <Monitor size={24} strokeWidth={1.5} className="text-[var(--wb-muted)]" aria-hidden />}
        <p role={paused || error ? "alert" : "status"} className="text-[14px] text-[var(--wb-text)]">{error ?? (paused ? "The browser is paused. Resume to keep browsing." : "Your computer is taking longer than usual to start. Keep waiting, or rebuild it.")}</p>
        <div className="flex flex-wrap items-center justify-center gap-1">
          {!paused && !error ? null : <button type="button" className={button} disabled={changing} onClick={() => paused ? void action("resume") : setRevision(current => current + 1)}>{paused ? <Play size={14} aria-hidden /> : <RotateCw size={14} aria-hidden />}{paused ? "Resume" : "Reconnect"}</button>}
          {paused || denied ? null : <RebuildComputer disabled={changing} onRebuild={() => void action("rebuild")} />}
        </div>
      </div> : null}
      {!denied && teachable && <div hidden={view !== "browser"} style={{ display: view === "browser" ? undefined : "none" }} className={TEACHING_WINDOW_PLACEMENT}><WorkbotTeaching open={teachOpen} onOpenChange={setTeachOpen} suspended={paused} liveTabs={frontId && livePage?.tabs?.length ? { frontId, tabs: livePage.tabs.map(tab => ({ id: tab.id, label: tabTitle(tab) })) } : undefined} onShowTab={stream ? id => stream.tab("activate", id) : undefined} onTeachingChange={teachingChange} onTakeControl={() => setControl(true)} onRun={onRun ? async text => { if (!await action("continue")) throw new Error("Hand back browser control to Workbot before starting the run. Your inputs are still here."); await onRun(text); } : undefined} /></div>}
    </div>
    <footer className="flex shrink-0 items-center justify-center gap-2 border-t border-[var(--wb-hairline)] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
      {control || agentPaused ? <button type="button" className={`${footerButton} bg-[var(--wb-ink)] text-[var(--wb-on-ink)]`} disabled={changing || denied} onClick={() => void action("continue")}>Hand back</button> : <>
        <button type="button" className={`${footerButton} bg-[var(--wb-chip)] text-[var(--wb-text)]`} disabled={stopping || stopped || task?.status === "completed" || task?.status === "failed"} onClick={() => void stop()}>{stopping ? "Stopping…" : "Stop task"}</button>
        <button type="button" className={`${footerButton} bg-[var(--wb-ink)] text-[var(--wb-on-ink)]`} disabled={changing || !connected || recording} onClick={() => setControl(true)}>Take control</button>
      </>}
    </footer>
  </section>;
}

type ViewerEvents = {
  paused(): void;
  agentPaused(paused: boolean): void;
  connected(): void;
  reconnecting(): void;
  /** The computer is moving to a new version once its current work finishes; the view keeps asking until it has. */
  updating?(): void;
  /** The computer is taking a while to answer: it is starting up (it can take a minute), not stuck connecting. */
  starting?(): void;
  /** Authorization denial discards every retained frame for this identity/chat/view, unlike a network failure. */
  failed(message: string, denied?: boolean): void;
  /** The address and title of the tab the screencast shows. noVNC shows the browser's own toolbar instead. */
  page?(page: ScreencastPage): void;
  /** The live page stream, which can switch and close tabs; null while noVNC or nothing is on screen. */
  stream?(stream: ScreencastViewer | null): void;
};

/**
 * Streams one view of a chat's computer (`chat` null: the main chat's) into `target`, renewing the connection before
 * the computer closes it and reconnecting a few times when it drops. Returns the function that closes it. The browser view
 * uses the computer's page stream, for watching and for control; a computer whose image predates it refuses the stream,
 * and the view falls back to noVNC. With `wake`, a paused computer is resumed instead of reported as paused.
 */
export function connectDesktopViewer(target: HTMLElement, host: ReturnType<typeof workbotHost>, options: { view: ComputerView; control: boolean; chat?: string | null; wake?: boolean }, events: ViewerEvents) {
  const { view, control } = options;
  let disposed = false;
  let screencastRefused = false;
  // The live connection, and its replacement while it connects.
  let client: import("@novnc/novnc").default | ScreencastViewer | null = null;
  let next: import("@novnc/novnc").default | ScreencastViewer | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let renewal: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  let failures = 0;
  let updates = 0;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const scopeKey = frameKey(host.identity?.organizationId ?? "", host.identity?.principalId ?? "", options.chat ?? null, view);
  // Another mounted viewer can discover revocation first. Stop this stream too, including candidates
  // issued before the denial that have not drawn yet; they must not later authorize stale pixels.
  const unsubscribe = subscribeFrame(scopeKey, () => {
    if (disposed || !viewFramesDenied(scopeKey)) return;
    disposed = true;
    controller.abort(); clearTimeout(retry); clearTimeout(renewal); clearTimeout(watchdog);
    next?.disconnect(); client?.disconnect(); target.replaceChildren();
    unsubscribe();
    events.stream?.(null);
    events.failed("Computer access is unavailable. Sign in again or ask your workspace admin.", true);
  });
  /** `renewing` keeps the current picture on screen until the replacement connects. */
  const connect = async (renewing = false) => {
    if (disposed) return;
    const request = new AbortController();
    const abort = () => request.abort();
    controller.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 195_000);
    // A computer that takes this long to answer is waking up; say so instead of "Connecting" all along.
    const slow = renewing ? undefined : setTimeout(() => { if (!disposed) events.starting?.(); }, STARTING_AFTER_MS);
    try {
      const { response, payload } = await host.requestJson(inChat("/v1/workbot/computer/viewer", options.chat ?? null), {
        method: "POST", body: JSON.stringify({ view, control, ...(options.wake ? { wake: true } : {}) }), signal: request.signal,
      }, 195_000);
      if (disposed) return;
      if (!response.ok) {
        // Recheck authorization even during renewal: an old connection cannot keep showing revoked pixels.
        if (response.status === 401 || response.status === 403) {
          disposed = true;
          unsubscribe();
          controller.abort(); clearTimeout(retry); clearTimeout(renewal); clearTimeout(watchdog);
          next?.disconnect(); client?.disconnect(); target.replaceChildren();
          const deniedKey = frameKey(host.identity?.organizationId ?? "", host.identity?.principalId ?? "", options.chat ?? null, view);
          forgetViewFrames(deniedKey);
          events.stream?.(null);
          events.failed(errorMessage(payload, response.status === 401 ? "Sign in again to view your computer." : "Computer access is off for your organization. Ask your workspace admin."), true);
          return;
        }
        // A failed early renewal is retried when the live connection closes.
        if (renewing && client) return;
        // Waiting for an update is expected and short: keep asking, for up to three minutes, instead of failing.
        if (typeof payload === "object" && payload !== null && "error" in payload && payload.error === "desktop_updating" && updates++ < 36) {
          events.updating?.();
          retry = setTimeout(() => void connect(), 5_000);
          return;
        }
        events.failed(errorMessage(payload, response.status === 403 ? "Computer access is off for your organization." : "Your computer is unavailable. Try reconnecting."));
        return;
      }
      const session = viewerSchema.parse(payload);
      if (session.state === "paused") { events.paused(); return; }
      events.agentPaused(session.paused);
      // The computer issues one ticket for watching the browser; its page stream and VNC accept it at sibling paths.
      const streamUrl = view === "browser" && !screencastRefused && /\/vnc\/[A-Za-z0-9_-]{43}$/.test(session.url)
        ? session.url.replace(/\/vnc\/([A-Za-z0-9_-]{43})$/, "/screencast/$1") : null;
      const RFB = streamUrl ? null : (await import("@novnc/novnc")).default;
      if (disposed) return;
      // Each connection draws into its own layer, shown once it is live.
      const layer = document.createElement("div");
      layer.style.cssText = "position:absolute;inset:0;visibility:hidden";
      target.append(layer);
      let candidate: import("@novnc/novnc").default | ScreencastViewer;
      if (RFB) {
        const rfb = new RFB(layer, session.url, { shared: true });
        rfb.viewOnly = !control;
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.background = "#f5f6f7";
        // Stronger zlib for the non-photo parts of the screen (noVNC defaults to 2) to save bandwidth.
        rfb.compressionLevel = 6;
        candidate = rfb;
      } else {
        const stream = new ScreencastViewer(layer, streamUrl!, { control });
        stream.addEventListener("page", (event) => { if (!disposed && client === stream) events.page?.((event as CustomEvent<ScreencastPage>).detail); });
        candidate = stream;
      }
      const superseded = next;
      next = candidate;
      superseded?.disconnect();
      // An open connection that never draws a picture is stuck: give up on it and say so, with Reconnect, instead of
      // "Connecting" forever. A renewal keeps the picture already on screen, so only a first connection is watched.
      let stalled = false;
      if (!renewing) {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => { if (!disposed && next === candidate && client === null) { stalled = true; candidate.disconnect(); } }, FIRST_PICTURE_MS);
      }
      candidate.addEventListener("connect", () => {
        if (disposed || next !== candidate) { candidate.disconnect(); return; }
        // noVNC reports the connection before its first frame arrives, so keep the current
        // picture until the new one is drawn; otherwise every renewal flashes an empty screen.
        void firstFrame(layer).then(() => {
          if (disposed || next !== candidate) return;
          clearTimeout(watchdog);
          layer.style.visibility = "visible";
          const previous = client;
          // With control, the keyboard goes to the page: on taking control, and across each renewal.
          if (control && candidate instanceof ScreencastViewer && (!previous || target.contains(document.activeElement))) candidate.focus();
          client = candidate; next = null;
          previous?.disconnect();
          events.stream?.(candidate instanceof ScreencastViewer ? candidate : null);
          if (candidate instanceof ScreencastViewer && candidate.page) events.page?.(candidate.page);
          allowViewFrames(frameKey(host.identity?.organizationId ?? "", host.identity?.principalId ?? "", options.chat ?? null, view));
          failures = 0; events.connected();
          // The computer closes each connection after a minute and renewal goes through
          // membership and flags again, so renew early instead of going blank.
          clearTimeout(renewal);
          renewal = setTimeout(() => void connect(true), 45_000);
        });
      });
      candidate.addEventListener("securityfailure", () => {
        if (!disposed && client === null) events.failed("Couldn't connect to your computer. Try reconnecting.");
      });
      candidate.addEventListener("disconnect", () => {
        layer.remove();
        if (next === candidate) next = null;
        // A stream that ends before its first frame means this computer has no page stream yet; use VNC from now on.
        if (candidate instanceof ScreencastViewer && !candidate.connected) screencastRefused = true;
        if (stalled && !disposed) { events.failed("Couldn't connect to your computer. Try again."); return; }
        // Only the live connection closing (or a first attempt failing with nothing newer
        // in flight) changes the screen; replaced connections and failed renewals do not.
        const live = client === candidate || client === null && next === null && !renewing;
        if (disposed || !live) return;
        client = null;
        clearTimeout(renewal);
        events.stream?.(null);
        events.reconnecting();
        failures++;
        if (failures > 3) { events.failed("Connection lost. Reconnect to continue."); return; }
        retry = setTimeout(() => void connect(), Math.min(500 * failures, 3_000));
      });
    } catch {
      if (!disposed && !(renewing && client)) events.failed("Couldn't connect to your computer. Try reconnecting.");
    } finally {
      clearTimeout(timeout);
      clearTimeout(slow);
      controller.signal.removeEventListener("abort", abort);
    }
  };
  void connect();
  return () => { disposed = true; unsubscribe(); controller.abort(); clearTimeout(retry); clearTimeout(renewal); clearTimeout(watchdog); next?.disconnect(); client?.disconnect(); target.replaceChildren(); };
}

/** How long a computer may take to answer before the view says it is starting up. */
const STARTING_AFTER_MS = 8_000;
/** A computer that is ready connects in a second or two; past this, the person may rather rebuild it than keep waiting. */
const REBUILD_OFFER_AFTER_MS = 15_000;
/** How long an open connection has to draw its first picture before the view gives up on it. */
const FIRST_PICTURE_MS = 15_000;

/** A tab's or page's address without the scheme, the way Chrome shows it. */
function shortAddress(href: string) {
  try { const url = new URL(href); return url.protocol === "http:" || url.protocol === "https:" ? `${url.host}${url.pathname === "/" ? "" : url.pathname}${url.search}` : href; } catch { return href; }
}

/** Chrome calls a blank tab New Tab. */
function tabTitle(tab: { url: string; title: string }) {
  if (!tab.url || tab.url === "about:blank" || tab.url.startsWith("chrome://newtab")) return "New Tab";
  return tab.title && tab.title !== tab.url ? tab.title : shortAddress(tab.url);
}

const toolbarButton = "inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[var(--wb-muted)] enabled:hover:bg-[var(--wb-chip)] enabled:hover:text-[var(--wb-text)] disabled:opacity-40 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";

/**
 * The page stream shows the page alone, so Workbot draws the browser around it the way Chrome does: the open tabs,
 * with the one on screen in front, and a toolbar for that page. Clicking a tab brings it to the front on the computer;
 * its × or a middle click closes it (never the last one, which would quit the browser). With control, the toolbar
 * goes back, forward and reloads, + opens a tab, and the address bar takes an address or a search. A computer built
 * before tabs were streamed shows just the front tab, without those controls.
 */
function BrowserFrame({ page, stream, teaching }: { page: ScreencastPage; stream: ScreencastViewer | null; teaching?: ReactNode }) {
  const live = Boolean(page.tabs?.length && page.id);
  const tabs = live ? page.tabs! : [{ id: "front", url: page.url, title: page.title }];
  // The tab just clicked shows in front at once; the computer confirms it within a second.
  const [picked, setPicked] = useState<{ id: string; over: string | undefined } | null>(null);
  useEffect(() => {
    if (!picked) return;
    const timer = setTimeout(() => setPicked(null), 3_000);
    return () => clearTimeout(timer);
  }, [picked]);
  const frontId = picked && picked.over === page.id ? picked.id : page.id;
  const front = tabs.find((tab) => tab.id === frontId) ?? tabs[0];
  const shown = front.id === page.id || !live ? page : front;
  const tabsOn = live && stream !== null;
  const control = tabsOn && stream!.control;
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>("[aria-selected=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [front.id]);
  // With control, the keyboard goes to the page after a tab change, as in Chrome.
  const activate = (id: string) => {
    if (!stream) return;
    if (id !== front.id) { setPicked({ id, over: page.id }); stream.tab("activate", id); }
    if (stream.control) stream.focus();
  };
  const close = (id: string) => {
    if (!stream || tabs.length < 2) return;
    stream.tab("close", id);
    if (stream.control) stream.focus();
  };
  // Arrow keys move between tabs, as in any tab list; Enter or Space brings one to the front.
  const moveFocus = (event: ReactKeyboardEvent, index: number) => {
    const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    strip.current?.querySelectorAll<HTMLElement>("[role=tab]")[(next + tabs.length) % tabs.length]?.focus();
  };

  // The address bar shows the page's address until the person edits it.
  const address = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const openedTab = useRef(false);
  // A click that focuses the address bar selects all of it; the click's own mouse-up would otherwise place the caret.
  const selectOnMouseUp = useRef(false);
  useEffect(() => {
    setDraft(null);
    // A tab opened with + is ready to take an address, as in Chrome.
    if (openedTab.current) { openedTab.current = false; address.current?.focus(); }
  }, [page.id]);
  const blank = tabTitle(shown) === "New Tab";
  const secure = shown.url.startsWith("https://");

  return <div className="shrink-0 bg-[var(--wb-bubble)]">
    <div className="flex items-end gap-1 px-2 pt-1.5 sm:px-4">
      <div ref={strip} role="tablist" aria-label="Browser tabs" className="flex min-w-0 items-end gap-px overflow-x-auto [scrollbar-width:none]">
        {tabs.map((tab, index) => {
          const active = tab === front;
          const title = tabTitle(tab);
          // Like Chrome, a thin divider separates two background tabs, not a background tab from the front one.
          const divider = index > 0 && !active && tabs[index - 1] !== front;
          return <div key={tab.id} className={`group relative flex h-8 w-[15rem] min-w-[3.5rem] shrink items-center rounded-t-lg text-[12px] ${active ? "bg-[var(--wb-surface)] text-[var(--wb-text)]" : "text-[var(--wb-muted)] hover:bg-[var(--wb-chip)]/70"}`}
            onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
            onAuxClick={(event) => { if (event.button === 1 && tabsOn) { event.preventDefault(); close(tab.id); } }}>
            {divider ? <span className="absolute left-0 top-2 h-4 w-px -translate-x-px bg-[var(--wb-ring)] group-hover:opacity-0" aria-hidden /> : null}
            <button type="button" role="tab" aria-selected={active} tabIndex={active ? 0 : -1} disabled={!tabsOn} title={tab.url ? `${title}\n${tab.url}` : title}
              onClick={() => activate(tab.id)} onKeyDown={(event) => moveFocus(event, index)}
              className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-t-lg pl-3 pr-1 text-left disabled:cursor-default focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
              {active && page.loading ? <Loader2 size={14} aria-label="Loading" className="shrink-0 animate-spin" /> : <Globe size={14} aria-hidden className="shrink-0" />}
              <span className="truncate">{title}</span>
            </button>
            {tabsOn && tabs.length > 1 ? <button type="button" tabIndex={-1} aria-label={`Close ${title}`} onClick={() => close(tab.id)}
              className={`mr-1.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[var(--wb-muted)] hover:bg-[var(--wb-bubble)] hover:text-[var(--wb-text)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] ${active ? "" : "opacity-0 group-hover:opacity-100"}`}>
              <X size={12} aria-hidden />
            </button> : null}
          </div>;
        })}
      </div>
      {control ? <button type="button" aria-label="New tab" title="New tab" onClick={() => { openedTab.current = true; stream!.newTab(); }} className={`${toolbarButton} mb-0.5`}><Plus size={14} aria-hidden /></button> : null}
    </div>
    <div className="flex items-center gap-1 border-b border-[var(--wb-hairline)] bg-[var(--wb-surface)] px-2 py-1.5 sm:px-4">
      <button type="button" aria-label="Back" title={control ? "Back" : "Take control to browse"} disabled={!control || !page.back} onClick={() => stream!.history("back")} className={toolbarButton}><ArrowLeft size={15} aria-hidden /></button>
      <button type="button" aria-label="Forward" title={control ? "Forward" : "Take control to browse"} disabled={!control || !page.forward} onClick={() => stream!.history("forward")} className={toolbarButton}><ArrowRight size={15} aria-hidden /></button>
      <button type="button" aria-label="Reload" title={control ? "Reload" : "Take control to browse"} disabled={!control} onClick={() => stream!.history("reload")} className={toolbarButton}><RotateCw size={14} aria-hidden /></button>
      <form className="ml-1 flex h-7 min-w-0 flex-1 items-center gap-2 rounded-full bg-[var(--wb-chip)] px-3 text-[12px] text-[var(--wb-text)] focus-within:bg-[var(--wb-surface)] focus-within:shadow-[var(--wb-focus)]"
        onSubmit={(event) => {
          event.preventDefault();
          const url = addressFor(draft ?? "");
          if (!url || !stream) return;
          stream.navigate(url);
          setDraft(null);
          address.current?.blur();
          stream.focus();
        }}>
        {secure ? <Lock size={12} aria-hidden className="shrink-0 text-[var(--wb-muted)]" /> : <Globe size={12} aria-hidden className="shrink-0 text-[var(--wb-muted)]" />}
        {control
          ? <input ref={address} aria-label="Address" value={draft ?? (blank ? "" : shortAddress(shown.url))} placeholder="Search Google or type a URL" spellCheck={false} autoComplete="off" autoCapitalize="off"
              onChange={(event) => setDraft(event.target.value)}
              // Editing shows the whole address, selected, as Chrome does.
              onMouseDown={(event) => { selectOnMouseUp.current = document.activeElement !== event.currentTarget; }}
              onMouseUp={(event) => { if (selectOnMouseUp.current) { event.preventDefault(); selectOnMouseUp.current = false; } }}
              onFocus={(event) => { const field = event.target; setDraft(blank ? "" : shown.url); requestAnimationFrame(() => field.select()); }}
              onBlur={() => setDraft(null)} onKeyDown={(event) => { if (event.key === "Escape") { setDraft(null); event.currentTarget.blur(); stream!.focus(); } }}
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[var(--wb-muted)]" />
          : <span className="truncate" aria-label="Address" title={shown.url}>{blank ? "" : shortAddress(shown.url)}</span>}
      </form>
      {teaching}
      {/^https?:\/\//.test(shown.url) ? <a href={shown.url} target="_blank" rel="noopener noreferrer" aria-label="Open this page in a new tab" title="Open this page in a new tab" className={toolbarButton}><ExternalLink size={14} aria-hidden /></a> : null}
    </div>
  </div>;
}

type GlimpseState = "connecting" | "live" | "unavailable" | "denied";
/** One view's connection, shared by the live views in the chat: a card that replaces another picks it up as it is. */
type SharedGlimpse = { host: ReturnType<typeof workbotHost>; view: ComputerView; container: HTMLDivElement; state: GlimpseState; listeners: Set<(state: GlimpseState) => void>; users: number; close(): void; linger?: ReturnType<typeof setTimeout> };
/** Keyed by chat and view: each chat has its own computer, so one chat's connection never stands in for another's. */
const sharedGlimpses = new Map<string, SharedGlimpse>();
function glimpseKey(chat: string | null, view: ComputerView, taskId?: string) {
  const identity = workbotHost().identity;
  return frameKey(identity?.organizationId ?? "", identity?.principalId ?? "", chat, view, taskId);
}
/** How long a view's connection outlives its last live view, so the next card of the same reply doesn't reconnect. */
const GLIMPSE_LINGER_MS = 15_000;

function watchGlimpse(host: ReturnType<typeof workbotHost>, chat: string | null, view: ComputerView): SharedGlimpse {
  const key = glimpseKey(chat, view);
  const existing = sharedGlimpses.get(key);
  if (existing && existing.host === host) {
    clearTimeout(existing.linger);
    existing.users += 1;
    return existing;
  }
  if (existing) { sharedGlimpses.delete(key); existing.close(); }
  const container = document.createElement("div");
  container.style.cssText = "position:absolute;inset:0";
  const shared: SharedGlimpse = { host, view, container, state: "connecting", listeners: new Set(), users: 1, close: () => {} };
  const set = (state: GlimpseState) => {
    shared.state = state;
    for (const listener of shared.listeners) listener(state);
    // A view that can't connect is dropped, so the next live view tries again.
    if ((state === "unavailable" || state === "denied") && sharedGlimpses.get(key) === shared) { sharedGlimpses.delete(key); shared.close(); }
  };
  const unsubscribe = subscribeFrame(key, () => { if (viewFramesDenied(key)) set("denied"); });
  const disconnect = connectDesktopViewer(container, host, { view, control: false, chat }, {
    paused: () => set("unavailable"),
    agentPaused: () => {},
    connected: () => set("live"),
    reconnecting: () => { if (host.identity && shared.state !== "denied") captureFrame(container, key); set("connecting"); },
    failed: (_message, denied) => set(denied ? "denied" : "unavailable"),
  });
  shared.close = () => { unsubscribe(); disconnect(); };
  sharedGlimpses.set(key, shared);
  return shared;
}

function releaseGlimpse(key: string, shared: SharedGlimpse) {
  shared.users -= 1;
  if (shared.users > 0) return;
  if (shared.host.identity && shared.state === "live" && !viewFramesDenied(key)) captureFrame(shared.container, key);
  shared.linger = setTimeout(() => {
    if (sharedGlimpses.get(key) === shared) sharedGlimpses.delete(key);
    shared.close();
  }, GLIMPSE_LINGER_MS);
}

/**
 * A small live view of what Workbot is showing on its computer, in the chat while it works, like the floating window
 * in OpenWork Desktop: view only, with a ring and a label saying Workbot has it. Clicking opens the full view. It
 * appears once it has a picture, so connecting takes no room in the chat. Live views of the same view share one
 * connection, so a new card keeps the picture instead of connecting again.
 */
export function LiveGlimpse({ view, onOpen, previewOnly = false, taskId }: { view: ComputerView; onOpen?(): void; previewOnly?: boolean; taskId?: string }) {
  const host = workbotHost();
  const chat = useWorkbotChat();
  const key = glimpseKey(chat, view, taskId);
  const previewEnabled = Boolean(host.identity);
  const [snapshot, setSnapshot] = useState(() => previewEnabled ? lastFrame(key) : null);
  const screen = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<GlimpseState>("connecting");
  // Once it has had a picture it stays, so a reconnect doesn't collapse it.
  const [pictured, setPictured] = useState(false);
  useEffect(() => { if (state === "live") setPictured(true); }, [state]);
  const away = useAway(30_000);
  // Layout cleanup saves before the completed card's layout effect reads the same task-scoped key.
  useLayoutEffect(() => {
    const target = screen.current;
    let timer: ReturnType<typeof setInterval> | undefined;
    const read = () => {
      const blocked = viewFramesDenied(key);
      setSnapshot(previewEnabled && !blocked ? lastFrame(key) : null);
      if (blocked) { clearInterval(timer); setState("denied"); setPictured(false); }
    };
    read();
    const unsubscribe = subscribeFrame(key, read);
    if (target && previewEnabled && !viewFramesDenied(key)) timer = setInterval(() => {
      if (!viewFramesDenied(key)) captureFrame(target, key);
    }, 1_000);
    return () => {
      unsubscribe(); clearInterval(timer);
      if (target && previewEnabled && !viewFramesDenied(key)) captureFrame(target, key);
    };
  }, [host, key, previewEnabled, state === "denied"]);
  useEffect(() => {
    const target = screen.current;
    if (!target || away) return;
    const shared = watchGlimpse(host, chat, view);
    target.append(shared.container);
    setState(shared.state);
    shared.listeners.add(setState);
    return () => {
      shared.listeners.delete(setState);
      if (shared.container.parentElement === target) shared.container.remove();
      releaseGlimpse(glimpseKey(chat, view), shared);
    };
  }, [host, chat, view, away]);
  useEffect(() => {
    if (state !== "live" || !screen.current || !previewEnabled || viewFramesDenied(key)) return;
    captureFrame(screen.current, key);
    setSnapshot(lastFrame(key));
  }, [state, host, key, previewEnabled]);
  if (!previewEnabled || state === "denied" || (state === "unavailable" && !snapshot)) return null;
  const label = view === "browser" ? "Workbot is browsing" : "Workbot is using its computer";
  const className = `${pictured || state === "live" || snapshot ? "block" : "hidden"} workbot-fade-in workbot-glimpse relative mt-2 aspect-[16/10] w-full overflow-hidden rounded-[10px] bg-[#f5f6f7] text-left outline-none focus-visible:shadow-[var(--wb-focus)] enabled:cursor-pointer`;
  const picture = <>
    {snapshot && state !== "live" ? <img src={snapshot} alt="Last browser frame" className="absolute inset-0 h-full w-full object-contain object-top" /> : null}
    <div ref={screen} className="pointer-events-none absolute inset-0" aria-hidden />
    <span className="absolute left-2 top-2 inline-flex items-center gap-1.5 rounded-full bg-[var(--wb-surface)]/90 px-2 py-0.5 text-[11px] font-medium text-[var(--wb-text)] shadow-[var(--wb-card-shadow)]">
      <span className={`size-1.5 rounded-full ${state === "live" ? "workbot-presence-dot" : "bg-current"}`} aria-hidden />{state === "live" ? label : state === "unavailable" ? "Last view · connection lost" : "Last view · reconnecting"}
    </span>
  </>;
  return previewOnly ? <div className={className} aria-label={label} data-workbot-live-thumbnail>{picture}</div>
    : <button type="button" onClick={onOpen} disabled={!onOpen} aria-label={`${label}. Open the full view`} className={className}>{picture}</button>;
}

/**
 * The last real picture retained for this task (or the view on older callers), including across reloads.
 * Finished cards may show the full-width picture; older computer cards keep their compact thumbnail. Never connects.
 */
export function LastGlimpse({ view, taskId, large = false }: { view: ComputerView; taskId?: string; large?: boolean }) {
  const host = workbotHost();
  const chat = useWorkbotChat();
  const key = glimpseKey(chat, view, taskId);
  const previewEnabled = Boolean(host.identity);
  const [snapshot, setSnapshot] = useState(() => previewEnabled ? lastFrame(key) : null);
  useLayoutEffect(() => {
    const read = () => setSnapshot(previewEnabled ? lastFrame(key) : null);
    read();
    // A late final frame may arrive as the live view disconnects; subscribe without starting another stream.
    return subscribeFrame(key, read);
  }, [host, key, previewEnabled]);
  if (!snapshot) return null;
  return <img src={snapshot} alt={`Last ${view === "browser" ? "browser" : "computer"} view${taskId ? " from this task" : ""}`} className={`${large ? "aspect-[16/10] w-full rounded-[10px] object-contain" : "h-10 w-16 shrink-0 rounded-[8px] object-cover"} bg-[var(--wb-chip)] object-top`} data-workbot-last-frame />;
}

/** Resolves once noVNC has drawn into the layer's canvas (its pixels start transparent), or after `limit` ms. */
function firstFrame(layer: HTMLElement, limit = 5_000) {
  const started = performance.now();
  return new Promise<void>(resolve => {
    const check = () => {
      const canvas = layer.querySelector("canvas");
      const alpha = canvas && canvas.width > 0 && canvas.height > 0
        ? canvas.getContext("2d")?.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data[3] ?? 0
        : 0;
      if (alpha > 0 || !layer.isConnected || performance.now() - started > limit) resolve();
      else setTimeout(check, 50);
    };
    check();
  });
}

/** True once the page has been hidden for `delay` ms, so a quick tab switch keeps the stream. */
function useAway(delay: number) {
  const [away, setAway] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = () => {
      clearTimeout(timer);
      if (document.visibilityState === "hidden") timer = setTimeout(() => setAway(true), delay);
      else setAway(false);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", sync); };
  }, [delay]);
  return away;
}

/** Replaces a computer that won't connect with a fresh one from the current image. Its disk is erased, so ask first. */
function RebuildComputer({ disabled, onRebuild }: { disabled: boolean; onRebuild(): void }) {
  const [open, setOpen] = useState(false);
  return <AlertDialog.Root open={open} onOpenChange={setOpen}>
    <AlertDialog.Trigger className={button} disabled={disabled}><Wrench size={14} aria-hidden />Rebuild computer</AlertDialog.Trigger>
    <AlertDialog.Portal>
      <AlertDialog.Backdrop className="workbot fixed inset-0 z-50 bg-[var(--wb-ink)]/20" />
      <AlertDialog.Popup className="workbot fixed left-1/2 top-1/2 z-50 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-[var(--wb-surface)] p-5 text-[var(--wb-text)] shadow-[var(--wb-panel-shadow)] outline-none">
        <AlertDialog.Title className="text-[15px] font-semibold">Rebuild your computer?</AlertDialog.Title>
        <AlertDialog.Description className="mt-2 text-[13px] text-[var(--wb-muted)]">Workbot replaces this computer with a fresh one. Its open apps, browser tabs and files are erased. Your chat and the files in Files are kept.</AlertDialog.Description>
        <div className="mt-4 flex justify-end gap-2"><AlertDialog.Close className={button}>Cancel</AlertDialog.Close><button type="button" className={button} onClick={() => { setOpen(false); onRebuild(); }}>Rebuild</button></div>
      </AlertDialog.Popup>
    </AlertDialog.Portal>
  </AlertDialog.Root>;
}

/** Keep the browser's destination layout in place until its first real frame arrives (P11). */
function BrowserLoading({ toolbar }: { toolbar: boolean }) {
  return <div aria-hidden className="pointer-events-none absolute inset-0 flex flex-col bg-[var(--wb-surface)]">
    {toolbar ? <div className="shrink-0 bg-[var(--wb-bubble)] px-3 pt-2">
      <div className="h-7 w-40 rounded-t-lg bg-[var(--wb-surface)]" />
      <div className="-mx-3 flex h-10 items-center gap-3 border-b border-[var(--wb-hairline)] bg-[var(--wb-surface)] px-3">
        <div className="size-4 rounded-full bg-[var(--wb-chip)]" /><div className="size-4 rounded-full bg-[var(--wb-chip)]" /><div className="h-6 flex-1 rounded-full bg-[var(--wb-chip)]" />
      </div>
    </div> : null}
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-6 sm:p-10">
      <div className="h-5 w-1/3 rounded bg-[var(--wb-chip)]" />
      <div className="h-3 w-4/5 rounded bg-[var(--wb-chip)]" />
      <div className="h-3 w-2/3 rounded bg-[var(--wb-chip)]" />
      <div className="mt-3 aspect-video rounded-lg bg-[var(--wb-chip)]" />
      <div className="h-3 w-3/4 rounded bg-[var(--wb-chip)]" />
    </div>
  </div>;
}
