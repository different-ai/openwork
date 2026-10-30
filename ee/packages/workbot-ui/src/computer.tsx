/// <reference path="./novnc.d.ts" />
"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, Loader2, Lock, Maximize2, Monitor, Pause, Play, Plus, RotateCw, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { z } from "zod";
import type { BrowserTeachingContext } from "@openwork/types/browser-demonstration";
import type { WorkbotViewContext } from "@openwork/types/workbot-context";
import { WorkbotTeaching } from "./teaching";
import { addressFor, ScreencastViewer, type ScreencastPage } from "./screencast";
import { computerViews, errorMessage, workbotHost } from "./host";
import { inChat, useWorkbotChat } from "./data";

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
 * Both views belong to the main conversation's computer. noVNC carries pixels and native input; with the browser live
 * view on, watching the browser streams the page itself instead.
 */
export function WorkbotComputer({ onTeachingChange, onRun, canTeach = true, onViewChange, onContextChange }: { onTeachingChange?(context: BrowserTeachingContext | undefined): void; onRun?(text: string): void | Promise<void>; canTeach?: boolean; onViewChange?(view: ComputerView): void; /** The tab in front of the Browser view, for the chat beside it; null when none is on screen. */ onContextChange?(context: WorkbotViewContext | null): void }) {
  const host = workbotHost();
  // Each side chat has its own computer: this view and its controls are for the chat it opens in.
  const chat = useWorkbotChat();
  const [teaching, setTeaching] = useState<BrowserTeachingContext>();
  const teachingChange = useCallback((context: BrowserTeachingContext | undefined) => { setTeaching(context); onTeachingChange?.(context); }, [onTeachingChange]);
  const recording = teaching !== undefined && teaching.phase !== "draft";
  const screen = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const views = computerViews(host);
  const [view, setViewState] = useState<ComputerView>(() => viewFromLocation(views));
  const setView = (next: ComputerView) => {
    if (next === view) return;
    window.history.pushState(null, "", `/${next}${window.location.search}`);
    setViewState(next);
  };
  useEffect(() => {
    const sync = () => { if (/^\/(browser(\/[a-z0-9]{1,16})?|computer)\/?$/.test(window.location.pathname)) setViewState(viewFromLocation(computerViews(workbotHost()))); };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  useEffect(() => { onViewChange?.(view); }, [view, onViewChange]);
  const [control, setControl] = useState(false);
  const [agentPaused, setAgentPaused] = useState(false);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [changing, setChanging] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [livePage, setLivePage] = useState<ScreencastPage | null>(null);
  const [stream, setStream] = useState<ScreencastViewer | null>(null);
  const identity = host.identity ? `${host.identity.organizationId}:${host.identity.principalId}` : "";
  const away = useAway(30_000) && !recording;
  // Only the page stream says which tab is in front; noVNC shows pixels alone.
  const frontId = view === "browser" && !paused && !error ? livePage?.id ?? null : null;
  const frontUrl = livePage?.url ?? "", frontTitle = livePage?.title ?? "";
  useEffect(() => {
    onContextChange?.(frontId ? { kind: "browser", tabId: frontId, url: frontUrl.slice(0, 2048), title: frontTitle.slice(0, 512) } : null);
  }, [frontId, frontUrl, frontTitle, onContextChange]);
  useEffect(() => () => onContextChange?.(null), [onContextChange]);

  useEffect(() => {
    const target = screen.current;
    // Nobody watching a hidden tab, so stop streaming until it is shown again.
    if (!target || paused || away) return;
    setError(null); setConnected(false); setReconnecting(false); setUpdating(false); setLivePage(null); setStream(null);
    return connectDesktopViewer(target, host, { view, control, chat, wake: true, screencast: host.browserLiveView === true }, {
      paused: () => setPaused(true),
      agentPaused: setAgentPaused,
      connected: () => { setConnected(true); setReconnecting(false); setUpdating(false); setError(null); },
      reconnecting: () => { setConnected(false); setReconnecting(true); },
      updating: () => { setConnected(false); setUpdating(true); },
      failed: (message) => { setConnected(false); setUpdating(false); setError(message); },
      page: setLivePage,
      stream: setStream,
    });
  }, [host, identity, chat, view, control, paused, away, revision]);

  const action = async (next: "pause" | "resume" | "continue" | "rebuild") => {
    if (changing) return false;
    setChanging(true); setError(null); setRebuilding(next === "rebuild");
    try {
      const { response, payload } = await host.requestJson(inChat("/v1/workbot/computer/action", chat), { method: "POST", body: JSON.stringify({ action: next }) }, 195_000);
      if (!response.ok) throw new Error(errorMessage(payload, "Your computer didn't respond. Try again."));
      if (next === "continue" || next === "rebuild") { setControl(false); setAgentPaused(false); }
      setPaused(next === "pause");
      setRevision(current => current + 1);
      return true;
    } catch (error) { setError(error instanceof Error ? error.message : "Your computer didn't respond."); }
    finally { setChanging(false); setRebuilding(false); }
  };

  return <section ref={container} className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Computer">
    <div className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--wb-hairline)] px-3 py-2 sm:px-6">
      <div className="flex items-center gap-1" role="group" aria-label="Computer view">
        {views.length > 1 && views.map(value => <button key={value} type="button" aria-pressed={view === value} disabled={recording} onClick={() => setView(value)} className={`${button} ${view === value ? "bg-[var(--wb-chip)]" : ""}`}>{value === "browser" ? "Browser" : "Computer"}</button>)}
      </div>
      <div className="flex items-center gap-1">
        <span className="mr-2 hidden text-[12px] text-[var(--wb-muted)] sm:inline" role="status">{paused ? "Paused" : error ? "Disconnected" : connected ? control ? "You have control" : "Live" : "Connecting…"}</span>
        {paused ? <button type="button" className={button} disabled={changing} onClick={() => void action("resume")}><Play size={14} aria-hidden />Resume</button> : <>
          <button type="button" className={button} disabled={changing || !connected || recording} onClick={() => control ? void action("continue") : setControl(true)}>{control ? "Return to Workbot" : "Take control"}</button>
          {agentPaused && !control ? <button type="button" className={button} disabled={changing} onClick={() => void action("continue")}>Continue Workbot</button> : null}
          <button type="button" className={button} disabled={changing} onClick={() => void action("pause")}><Pause size={14} aria-hidden />Pause</button>
        </>}
        <button type="button" className={button} aria-label="Full screen" onClick={() => void container.current?.requestFullscreen().catch(() => setError("Full screen isn't available in this browser."))}><Maximize2 size={14} aria-hidden /></button>
      </div>
    </div>
    {view === "browser" && livePage && !paused && !error ? <BrowserFrame page={livePage} stream={stream} /> : null}
    {canTeach && host.browserDemonstrations === true && views.includes("browser") && <div hidden={view !== "browser"} style={{ display: view === "browser" ? undefined : "none" }}><WorkbotTeaching suspended={paused} liveTabs={frontId && livePage?.tabs?.length ? { frontId, tabs: livePage.tabs.map(tab => ({ id: tab.id, label: tabTitle(tab) })) } : undefined} onShowTab={stream ? id => stream.tab("activate", id) : undefined} onTeachingChange={teachingChange} onTakeControl={() => setControl(true)} onRun={onRun ? async text => { if (!await action("continue")) throw new Error("Return browser control to Workbot before starting the run. Your inputs are still here."); await onRun(text); } : undefined} /></div>}
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#f5f6f7]">
      <div ref={screen} className={`relative h-full w-full ${paused || error ? "hidden" : ""}`} aria-label={`${view === "browser" ? "Browser" : "Computer"} live view`} />
      {!paused && !error && !connected ? <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
        <ComputerLoading />
        <span className="workbot-shimmer text-[13px]">{rebuilding ? "Rebuilding your computer" : updating ? "Updating your computer" : reconnecting ? "Reconnecting" : view === "browser" ? "Connecting to the browser" : "Connecting to your computer"}</span>
      </div> : null}
      {paused || error ? <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
        <Monitor size={24} strokeWidth={1.5} className="text-[var(--wb-muted)]" aria-hidden />
        <p className="text-[14px] text-[var(--wb-text)]">{error ?? "Your computer is paused."}</p>
        <div className="flex flex-wrap items-center justify-center gap-1">
          <button type="button" className={button} disabled={changing} onClick={() => paused ? void action("resume") : setRevision(current => current + 1)}>{paused ? <Play size={14} aria-hidden /> : <RotateCw size={14} aria-hidden />}{paused ? "Resume" : "Reconnect"}</button>
          {paused ? null : <RebuildComputer disabled={changing} onRebuild={() => void action("rebuild")} />}
        </div>
      </div> : null}
    </div>
  </section>;
}

type ViewerEvents = {
  paused(): void;
  agentPaused(paused: boolean): void;
  connected(): void;
  reconnecting(): void;
  /** The computer is moving to a new version once its current work finishes; the view keeps asking until it has. */
  updating?(): void;
  failed(message: string): void;
  /** The address and title of the tab the screencast shows. noVNC shows the browser's own toolbar instead. */
  page?(page: ScreencastPage): void;
  /** The live page stream, which can switch and close tabs; null while noVNC or nothing is on screen. */
  stream?(stream: ScreencastViewer | null): void;
};

/**
 * Streams one view of a chat's computer (`chat` null: the main chat's) into `target`, renewing the connection before
 * the computer closes it and reconnecting a few times when it drops. Returns the function that closes it. With `screencast`, the browser view
 * uses the computer's page stream, for watching and for control; a computer whose image predates it refuses the stream,
 * and the view falls back to noVNC. With `wake`, a paused computer is resumed instead of reported as paused.
 */
export function connectDesktopViewer(target: HTMLElement, host: ReturnType<typeof workbotHost>, options: { view: ComputerView; control: boolean; chat?: string | null; wake?: boolean; screencast?: boolean }, events: ViewerEvents) {
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
  /** `renewing` keeps the current picture on screen until the replacement connects. */
  const connect = async (renewing = false) => {
    if (disposed) return;
    const request = new AbortController();
    const abort = () => request.abort();
    controller.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 195_000);
    try {
      const { response, payload } = await host.requestJson(inChat("/v1/workbot/computer/viewer", options.chat ?? null), {
        method: "POST", body: JSON.stringify({ view, control, ...(options.wake ? { wake: true } : {}) }), signal: request.signal,
      }, 195_000);
      if (disposed) return;
      if (!response.ok) {
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
      const streamUrl = options.screencast && view === "browser" && !screencastRefused && /\/vnc\/[A-Za-z0-9_-]{43}$/.test(session.url)
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
      candidate.addEventListener("connect", () => {
        if (disposed || next !== candidate) { candidate.disconnect(); return; }
        // noVNC reports the connection before its first frame arrives, so keep the current
        // picture until the new one is drawn; otherwise every renewal flashes an empty screen.
        void firstFrame(layer).then(() => {
          if (disposed || next !== candidate) return;
          layer.style.visibility = "visible";
          const previous = client;
          // With control, the keyboard goes to the page: on taking control, and across each renewal.
          if (control && candidate instanceof ScreencastViewer && (!previous || target.contains(document.activeElement))) candidate.focus();
          client = candidate; next = null;
          previous?.disconnect();
          events.stream?.(candidate instanceof ScreencastViewer ? candidate : null);
          if (candidate instanceof ScreencastViewer && candidate.page) events.page?.(candidate.page);
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
      controller.signal.removeEventListener("abort", abort);
    }
  };
  void connect();
  return () => { disposed = true; controller.abort(); clearTimeout(retry); clearTimeout(renewal); next?.disconnect(); client?.disconnect(); target.replaceChildren(); };
}

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
function BrowserFrame({ page, stream }: { page: ScreencastPage; stream: ScreencastViewer | null }) {
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
      {/^https?:\/\//.test(shown.url) ? <a href={shown.url} target="_blank" rel="noopener noreferrer" aria-label="Open this page in a new tab" title="Open this page in a new tab" className={toolbarButton}><ExternalLink size={14} aria-hidden /></a> : null}
    </div>
  </div>;
}

type GlimpseState = "connecting" | "live" | "unavailable";
/** One view's connection, shared by the live views in the chat: a card that replaces another picks it up as it is. */
type SharedGlimpse = { host: ReturnType<typeof workbotHost>; container: HTMLDivElement; state: GlimpseState; listeners: Set<(state: GlimpseState) => void>; users: number; close(): void; linger?: ReturnType<typeof setTimeout> };
/** Keyed by chat and view: each chat has its own computer, so one chat's connection never stands in for another's. */
const sharedGlimpses = new Map<string, SharedGlimpse>();
function glimpseKey(chat: string | null, view: ComputerView) {
  return `${chat ?? ""}:${view}`;
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
  const shared: SharedGlimpse = { host, container, state: "connecting", listeners: new Set(), users: 1, close: () => {} };
  const set = (state: GlimpseState) => {
    shared.state = state;
    for (const listener of shared.listeners) listener(state);
    // A view that can't connect is dropped, so the next live view tries again.
    if (state === "unavailable" && sharedGlimpses.get(key) === shared) { sharedGlimpses.delete(key); shared.close(); }
  };
  shared.close = connectDesktopViewer(container, host, { view, control: false, chat }, {
    paused: () => set("unavailable"),
    agentPaused: () => {},
    connected: () => set("live"),
    reconnecting: () => set("connecting"),
    failed: () => set("unavailable"),
  });
  sharedGlimpses.set(key, shared);
  return shared;
}

function releaseGlimpse(key: string, shared: SharedGlimpse) {
  shared.users -= 1;
  if (shared.users > 0) return;
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
export function LiveGlimpse({ view, onOpen }: { view: ComputerView; onOpen?(): void }) {
  const host = workbotHost();
  const chat = useWorkbotChat();
  const screen = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<GlimpseState>("connecting");
  // Once it has had a picture it stays, so a reconnect doesn't collapse it.
  const [pictured, setPictured] = useState(false);
  useEffect(() => { if (state === "live") setPictured(true); }, [state]);
  const away = useAway(30_000);
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
  if (state === "unavailable") return null;
  const label = view === "browser" ? "Workbot is browsing" : "Workbot is using its computer";
  return <button type="button" onClick={onOpen} disabled={!onOpen} aria-label={`${label}. Open the full view`}
    className={`${pictured || state === "live" ? "block" : "hidden"} workbot-fade-in workbot-glimpse relative mt-2 aspect-[16/10] w-full overflow-hidden rounded-[10px] bg-[#f5f6f7] text-left outline-none focus-visible:shadow-[var(--wb-focus)] enabled:cursor-pointer`}>
    <div ref={screen} className="pointer-events-none absolute inset-0" aria-hidden />
    {state === "connecting" ? <span className="absolute inset-0 grid place-items-center text-[12px] text-[var(--wb-muted)]"><span className="workbot-shimmer">{view === "browser" ? "Connecting to the browser" : "Connecting to the computer"}</span></span> : null}
    <span className="absolute left-2 top-2 inline-flex items-center gap-1.5 rounded-full bg-[var(--wb-surface)]/90 px-2 py-0.5 text-[11px] font-medium text-[var(--wb-text)] shadow-[var(--wb-card-shadow)]">
      <span className="workbot-presence-dot size-1.5 rounded-full" aria-hidden />{label}
    </span>
  </button>;
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

/** Workbot's computer glyph at the size of the empty screen; its lines write while the view connects (V6). */
function ComputerLoading() {
  return <svg viewBox="0 0 16 16" width={40} height={40} fill="none" className="workbot-computer is-working" aria-hidden>
    <rect x="2.25" y="3" width="11.5" height="8" rx="1.75" className="workbot-computer-screen" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    <path d="M1.5 13h13" className="workbot-computer-stand" strokeWidth={1.5} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    <path className="workbot-computer-line" d="M4.75 6h3.5" strokeWidth={1.5} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    <path className="workbot-computer-line" d="M4.75 8.25h5.5" strokeWidth={1.5} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
  </svg>;
}
