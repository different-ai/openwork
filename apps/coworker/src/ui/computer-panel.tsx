import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { coworkerBridge } from "@/lib/bridge";
import { Button } from "@/ui/kit";

type Presentation = NonNullable<Awaited<ReturnType<typeof coworkerBridge.computer.presentation>>>;
type Observation = Omit<Presentation, "frame"> & { frame?: NonNullable<Presentation["frame"]> & { key: string } };
type Interaction = "approve" | "deny" | "takeover" | "resume";
const inputLabels: Record<string, string> = { move: "Moving", click: "Click", double_click: "Double click", drag: "Dragging", scroll: "Scrolling", key: "Key press", type: "Typing", press: "Press", set_value: "Editing" };
const pausedPhases = ["paused", "person_interacting", "ready_to_continue", "requery_required"];

/** This is a watch surface. Only the explicit controls below can hand back control. */
export function ComputerPanel({ slug, threadId, slot, enabled, canStop, controlsBusy, stopping, cleanupPending, stopError, onStop }: {
  slug: string;
  threadId: string;
  slot: HTMLElement;
  enabled: boolean;
  canStop: boolean;
  controlsBusy: boolean;
  stopping: boolean;
  cleanupPending: boolean;
  stopError: string;
  onStop: () => void;
}) {
  const [observed, setPresentation] = useState<Observation | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const presentation: Observation | null = observed ?? (readFailed ? { id: "", phase: "unavailable", inputs: [] } : null);
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState<Interaction | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [selectedWindow, setSelectedWindow] = useState("");
  const [now, setNow] = useState(Date.now);
  const [loadedFrame, setLoadedFrame] = useState<string | null>(null);
  const [failedFrame, setFailedFrame] = useState<string | null>(null);
  const [bounds, setBounds] = useState({ width: slot.clientWidth, height: slot.clientHeight });
  const [cardSize, setCardSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [screenSize, setScreenSize] = useState({ width: 0, height: 0 });
  const [position, setPosition] = useState({ x: 12, y: 12 });
  const [dragging, setDragging] = useState(false);
  const card = useRef<HTMLElement>(null);
  const moveButton = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; origin: { x: number; y: number } } | null>(null);
  const latest = useRef<Pick<Presentation, "id" | "phase"> | null>(null);
  const activeFrame = useRef<string | null>(null);
  const scope = useRef("");
  const mounted = useRef(false);
  const acting = useRef(false);
  const transport = useRef<Promise<Presentation | null> | null>(null);
  const monitor = useRef({ minimized: false, revision: 0, freshAfter: 0, capture: 0, working: false, wake: () => {} });
  const id = useId();

  function clearScreen() {
    monitor.current.freshAfter = Date.now();
    monitor.current.capture += 1;
    monitor.current.working = false;
    activeFrame.current = null;
    setLoadedFrame(null);
    setFailedFrame(null);
    setPresentation((current) => current ? { ...current, frame: undefined, inputs: [] } : null);
  }

  function minimize(value: boolean) {
    monitor.current.minimized = value;
    monitor.current.revision += 1;
    setMinimized(value);
    clearScreen();
    monitor.current.wake();
    moveButton.current?.focus();
  }

  const captureAllowed = useEffectEvent(() => enabled && !stopping && !cleanupPending);
  const stopUnconfirmed = useEffectEvent(() => stopping || cleanupPending || Boolean(stopError && canStop));
  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let reading = false;
    let again = false;
    let timer = 0;
    const visible = () => latest.current !== null && !monitor.current.minimized && document.visibilityState === "visible" && captureAllowed() && slot.getClientRects().length > 0 && slot.clientWidth > 24 && slot.clientHeight > 24;
    async function poll() {
      window.clearTimeout(timer);
      if (reading) { again = true; return; }
      reading = true;
      again = false;
      try {
        // Serialize visibility changes with the current read, including Strict Mode cleanup.
        await transport.current?.catch(() => null);
        if (disposed) return;
        const revision = monitor.current.revision;
        const watching = visible();
        const pending = coworkerBridge.computer.presentation({ slug, threadId, visible: watching });
        transport.current = pending;
        const next = await pending;
        if (disposed || revision !== monitor.current.revision) return;
        setReadFailed(false);
        if (!next || ["closed", "revoked"].includes(next.phase)) {
          latest.current = null;
          scope.current = "";
          const keepStopStatus = stopUnconfirmed();
          setPresentation((current) => keepStopStatus && current ? { ...current, phase: "stopping", frame: undefined, inputs: [] } : null);
          clearScreen();
          return;
        }
        const nextScope = JSON.stringify([next.id, next.appName, next.windowTitle]);
        const sameScope = scope.current === nextScope;
        const working = watching && next.phase === "working";
        const uninterrupted = sameScope && working && monitor.current.working && latest.current?.phase === "working";
        // Pauses, visibility gaps and target changes end the capture generation.
        // Even a quick resume must wait for an image captured after that boundary.
        if (!sameScope || latest.current?.phase !== next.phase || monitor.current.working !== working) clearScreen();
        if (!sameScope) {
          const newSession = latest.current?.id !== next.id;
          scope.current = nextScope;
          setSelectedWindow("");
          setActionError("");
          if (newSession) { monitor.current.minimized = false; setMinimized(false); }
        }
        latest.current = { id: next.id, phase: next.phase };
        monitor.current.working = working;
        const frame = next.frame;
        const usable = working && frame?.mimeType === "image/png" && frame.width > 0 && frame.height > 0
          && Number.isFinite(frame.width) && Number.isFinite(frame.height) && frame.capturedAt > monitor.current.freshAfter;
        const nextFrame = usable ? { ...frame, key: JSON.stringify([nextScope, monitor.current.capture, frame.sequence, frame.capturedAt]) } : undefined;
        if (nextFrame) activeFrame.current = nextFrame.key;
        else if (!uninterrupted) activeFrame.current = null;
        const inputs = working
          ? next.inputs.filter((input) => ["move", "down", "up", "dispatched", "uncertain"].includes(input.phase) && input.at >= monitor.current.freshAfter && input.at >= Date.now() - 1_500).slice(-24) : [];
        setPresentation((current) => ({ ...next, frame: nextFrame ?? (uninterrupted ? current?.frame : undefined), inputs }));
      } catch {
        if (!disposed) {
          setReadFailed(true);
          clearScreen();
        }
      } finally {
        reading = false;
        if (!disposed) timer = window.setTimeout(() => void poll(), again ? 0 : visible() ? 225 : 1_250);
      }
    }
    const wake = () => { void poll(); };
    const visibility = () => {
      monitor.current.revision += 1;
      clearScreen();
      wake();
    };
    monitor.current.wake = wake;
    document.addEventListener("visibilitychange", visibility);
    void poll();
    return () => {
      disposed = true;
      mounted.current = false;
      activeFrame.current = null;
      monitor.current.capture += 1;
      monitor.current.working = false;
      monitor.current.revision += 1;
      monitor.current.wake = () => {};
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
      // Never revoke on navigation. A final hidden heartbeat follows any outstanding read.
      transport.current = (transport.current ?? Promise.resolve(null)).catch(() => null)
        .then(() => coworkerBridge.computer.presentation({ slug, threadId, visible: false })).catch(() => null);
    };
  }, [slug, threadId, slot]);

  useEffect(() => {
    monitor.current.revision += 1;
    if (!enabled || stopping || cleanupPending) clearScreen();
    monitor.current.wake();
  }, [enabled, stopping, cleanupPending]);

  useEffect(() => {
    if (!presentation || minimized) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [Boolean(presentation), minimized]);

  useLayoutEffect(() => {
    const measure = () => {
      setBounds({ width: slot.clientWidth, height: slot.clientHeight });
      if (card.current) setCardSize({ width: card.current.offsetWidth, height: card.current.offsetHeight });
      if (viewport) setScreenSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(slot);
    if (card.current) resize.observe(card.current);
    if (viewport) resize.observe(viewport);
    return () => resize.disconnect();
  }, [slot, viewport, Boolean(presentation)]);

  async function interact(action: Interaction, windowId?: number) {
    const current = latest.current;
    if (!current || acting.current || controlsBusy || !enabled || readFailed || cleanupPending) return;
    acting.current = true;
    const actionScope = scope.current;
    monitor.current.revision += 1;
    setBusy(action);
    setActionError("");
    if (action === "takeover" || action === "resume") clearScreen();
    try {
      await coworkerBridge.computer.interact({ slug, threadId, id: current.id, action, ...(windowId !== undefined ? { windowId } : {}) });
    } catch {
      if (mounted.current && scope.current === actionScope) {
        setActionError(`${action === "takeover" ? "Take over" : action === "resume" ? "Continue" : "Window choice"} was not confirmed. Check the updated state before trying again.`);
        clearScreen();
      }
    } finally {
      acting.current = false;
      if (mounted.current) { setBusy(null); monitor.current.wake(); }
    }
  }

  if (!presentation) return null;
  const paused = pausedPhases.includes(presentation.phase);
  const choosing = presentation.phase === "approval";
  const stopPending = stopping || cleanupPending || presentation.phase === "stopping";
  const unavailable = readFailed || ["unavailable", "error"].includes(presentation.phase);
  const frame = !minimized && !unavailable && !stopPending && !paused && presentation.frame?.key !== failedFrame ? presentation.frame : undefined;
  const live = !minimized && document.visibilityState === "visible" && presentation.phase === "working" && frame && loadedFrame === frame.key && now - frame.capturedAt >= 0 && now - frame.capturedAt < 1_500;
  const status = unavailable || failedFrame !== null ? "View unavailable" : paused ? "Paused" : live ? "Live" : "Connecting";
  const disabled = controlsBusy || busy !== null || unavailable || cleanupPending || !enabled;
  const maxX = Math.max(12, bounds.width - cardSize.width - 12);
  const maxY = Math.max(12, bounds.height - cardSize.height - 12);
  const shown = { x: Math.min(maxX, Math.max(12, position.x)), y: Math.min(maxY, Math.max(12, position.y)) };
  const fit = frame ? Math.min(screenSize.width / frame.width, screenSize.height / frame.height) : 0;
  const imageWidth = frame ? frame.width * fit : 0;
  const imageHeight = frame ? frame.height * fit : 0;
  const recent = !minimized && !paused && !unavailable && !stopPending ? presentation.inputs.filter((input) => input.at <= now && now - input.at < 1_500) : [];
  const interrupted = recent.some((input) => input.phase === "uncertain");
  const points = interrupted ? [] : recent.filter((input): input is Presentation["inputs"][number] & { x: number; y: number } => input.x !== undefined && input.y !== undefined && Number.isFinite(input.x) && Number.isFinite(input.y) && input.x >= 0 && input.x <= 1 && input.y >= 0 && input.y <= 1);
  const pointer = points.at(-1);
  const lastInput = recent.at(-1);
  const badge = interrupted ? "Interrupted" : lastInput ? inputLabels[lastInput.action] : undefined;
  const trail: string[] = [];
  for (const point of points.slice(-12).reverse()) {
    if (point.action !== "drag") break;
    trail.unshift(`${point.x * imageWidth},${point.y * imageHeight}`);
    if (["down", "start", "begin"].includes(point.phase)) break;
  }
  const title = `Computer${presentation.appName ? ` · ${presentation.appName}` : ""}`;

  return createPortal(
    <aside ref={card} aria-label={title} data-testid="coworker-computer-floating" data-minimized={minimized}
      className={`coworker-computer-floating window-no-drag pointer-events-auto absolute z-20 flex min-w-0 flex-col overflow-x-hidden overflow-y-auto overscroll-contain rounded-2xl border bg-panel text-snow shadow-[0_12px_36px_rgba(0,0,0,0.4)] focus-within:z-30 ${dragging ? "border-spark/60" : "border-line"}`}
      style={{ left: shown.x, top: shown.y, width: Math.min(minimized ? 300 : 460, Math.max(0, bounds.width - 24)), maxHeight: Math.max(0, bounds.height - 24) }}
      onKeyDown={(event) => { if (event.key === "Escape" && !drag.current && !minimized) { event.preventDefault(); event.stopPropagation(); minimize(true); } }}>
      <header className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1">
        <button ref={moveButton} type="button" aria-label={`Move ${title} view`} aria-describedby={`${id}-move`} data-testid="coworker-computer-drag"
          className="flex min-w-0 flex-1 touch-none select-none items-center gap-2 rounded-lg px-1.5 py-2 text-left text-xs font-medium outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-spark/60"
          style={{ cursor: dragging ? "grabbing" : "grab" }}
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary) return;
            event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: shown }; setDragging(true);
          }}
          onPointerMove={(event) => {
            const current = drag.current;
            if (!current || current.id !== event.pointerId) return;
            setPosition({ x: Math.max(12, Math.min(maxX, current.origin.x + event.clientX - current.x)), y: Math.max(12, Math.min(maxY, current.origin.y + event.clientY - current.y)) });
          }}
          onPointerUp={(event) => { drag.current = null; setDragging(false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onPointerCancel={() => { if (drag.current) setPosition(drag.current.origin); drag.current = null; setDragging(false); }}
          onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && drag.current) { event.preventDefault(); event.stopPropagation(); setPosition(drag.current.origin); drag.current = null; setDragging(false); return; }
            const step = event.shiftKey ? 40 : 16;
            const next = event.key === "Home" ? { x: 12, y: 12 } : event.key === "End" ? { x: maxX, y: maxY }
              : event.key === "ArrowLeft" ? { ...shown, x: shown.x - step } : event.key === "ArrowRight" ? { ...shown, x: shown.x + step }
              : event.key === "ArrowUp" ? { ...shown, y: shown.y - step } : event.key === "ArrowDown" ? { ...shown, y: shown.y + step } : null;
            if (next) { event.preventDefault(); setPosition({ x: Math.max(12, Math.min(maxX, next.x)), y: Math.max(12, Math.min(maxY, next.y)) }); }
          }}>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" className="size-4 shrink-0 text-mist" aria-hidden="true"><rect x="2" y="3" width="16" height="11" rx="2" /><path d="M10 14v3M6 17h8" /></svg>
          <span className="truncate">{title}</span>
        </button>
        {!minimized ? <span role="status" className={`shrink-0 text-[10px] ${live ? "text-ready" : "text-mist"}`} data-testid="coworker-computer-live-status">{status}</span> : null}
        <Button variant="ghost" className="shrink-0 rounded-lg px-2 text-xs" aria-label={minimized ? "Restore computer view" : "Minimize computer view"} title={minimized ? "Show computer view" : "Hide the view without stopping work"} onClick={() => minimize(!minimized)}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="size-3.5" aria-hidden="true"><path d={minimized ? "M3 10V3h7M3 3l10 10" : "M3 11h10"} /></svg>
        </Button>
        {minimized ? <Button variant="ghost" className="shrink-0 px-2 text-xs text-rose" disabled={controlsBusy || !canStop} aria-busy={stopping} onClick={onStop}>{stopping ? "Stopping..." : "Stop"}</Button> : null}
      </header>
      <p id={`${id}-move`} className="sr-only">Drag anywhere within the conversation, or use the arrow keys. Shift moves faster. Home and End move to corners. Escape minimizes the view without stopping work.</p>
      {minimized && (stopPending || stopError) ? <p role="status" className="px-3 py-2 text-[11px] text-amber">Stop not yet confirmed. Restore the view for details.</p> : null}
      {!minimized ? <>
        {choosing ? <div className="min-h-0 space-y-3 overflow-y-auto px-4 py-4 text-xs text-mist" data-testid="coworker-computer-window-chooser">
          <div><h2 className="font-medium text-snow">{presentation.windows?.length === 1 ? "Opening the app window" : "Choose a window"}</h2>{presentation.task ? <p className="mt-1 line-clamp-2">{presentation.task}</p> : null}</div>
          {presentation.windows?.length === 1 ? <p className="truncate text-snow">{presentation.windows[0]?.title || "App window"}</p> : <><label className="block space-y-1.5"><span>Window to use</span><select className="w-full min-w-0 rounded-lg border border-line bg-ink px-2 py-2 text-snow outline-none focus-visible:ring-2 focus-visible:ring-spark/60" value={selectedWindow} disabled={disabled} onChange={(event) => setSelectedWindow(event.target.value)}>
            <option value="">Choose a window...</option>
            {presentation.windows?.map((item) => <option key={item.id} value={item.id}>{item.title || "Untitled window"}</option>)}
          </select></label>
          <div className="flex flex-wrap justify-end gap-2"><Button variant="ghost" className="text-xs" disabled={disabled} onClick={() => void interact("deny")}>Not now</Button><Button variant="primary" className="text-xs" disabled={disabled || !presentation.windows?.some((item) => String(item.id) === selectedWindow)} aria-busy={busy === "approve"} onClick={() => void interact("approve", Number(selectedWindow))}>Open window</Button></div></>}
        </div> : <div ref={setViewport} className="relative flex min-h-0 shrink items-center justify-center overflow-hidden bg-ink" style={{ aspectRatio: frame ? `${frame.width} / ${frame.height}` : "16 / 10" }} data-testid="coworker-computer-screen">
          {frame ? <div className="pointer-events-none relative shrink-0 overflow-hidden" style={{ width: imageWidth, height: imageHeight }}>
            <img key={frame.key} src={`data:image/png;base64,${frame.data}`} alt={`${presentation.windowTitle || presentation.appName || "Computer"}, watch only`} draggable={false} className="block h-full w-full select-none object-contain" data-testid="coworker-computer-frame"
              onLoad={() => {
                if (!mounted.current || activeFrame.current !== frame.key) return;
                setLoadedFrame(frame.key); setFailedFrame(null); setNow(Date.now());
              }}
              onError={() => {
                if (!mounted.current || activeFrame.current !== frame.key) return;
                setFailedFrame(frame.key); setLoadedFrame(null);
                setPresentation((current) => current?.frame?.key === frame.key ? { ...current, frame: undefined, inputs: [] } : current);
              }} />
            {loadedFrame !== null && pointer ? <div className="pointer-events-none absolute inset-0" role="img" aria-label="Latest computer input position" data-testid="coworker-computer-input">
              {trail.length > 1 ? <svg className="absolute inset-0 h-full w-full text-spark" viewBox={`0 0 ${imageWidth} ${imageHeight}`} aria-hidden="true"><polyline points={trail.join(" ")} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.7" /></svg> : null}
              <div className="coworker-computer-pointer absolute" data-action={pointer.action} style={{ left: `${pointer.x * 100}%`, top: `${pointer.y * 100}%` }}>
                {pointer.action === "click" || pointer.action === "double_click" ? <span key={pointer.sequence} className="coworker-computer-click" aria-hidden="true" /> : null}
                <svg viewBox="0 0 20 26" width="18" height="24" className="relative drop-shadow-md" aria-hidden="true"><path d="M1 1v19l5-5 4 9 4-2-4-8h8Z" fill="var(--color-snow)" stroke="var(--color-ink)" strokeWidth="1.5" strokeLinejoin="round" /></svg>
              </div>
            </div> : null}
          </div> : <p role="status" className="max-w-64 px-5 text-center text-xs leading-relaxed text-mist">{stopPending ? "Stopping computer use. Waiting for release confirmation." : unavailable || failedFrame !== null ? "The computer view is unavailable. This does not confirm a stop." : paused ? "You have control. Continue when you are ready." : "Connecting to the app window..."}</p>}
          {badge && (interrupted || (frame && loadedFrame !== null)) ? <span className={`pointer-events-none absolute bottom-2 left-2 rounded-md border border-white/10 bg-panel/95 px-2 py-1 text-[10px] ${interrupted ? "text-amber" : "text-snow"}`} aria-label={`Latest computer input: ${badge}`}>{badge}</span> : null}
        </div>}
        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-3 py-2">
          <div className="min-w-0 flex-1 basis-24 text-[10px] text-mist"><p className="truncate" title={presentation.windowTitle}>{presentation.windowTitle || presentation.appName || "This computer"}</p><p className="mt-0.5">{stopPending ? "Stop not yet confirmed" : paused ? presentation.canContinue ? "Ready when you are" : "Waiting for your input to finish" : "Watch only"}</p></div>
          {!choosing && !stopPending ? <Button variant={paused ? "primary" : "default"} className="text-xs" data-testid={paused ? "coworker-computer-resume" : "coworker-computer-takeover"} disabled={disabled || (paused && presentation.canContinue !== true) || (!paused && presentation.phase !== "working")} aria-busy={busy === "takeover" || busy === "resume"} onClick={() => void interact(paused ? "resume" : "takeover")}>{busy === "takeover" ? "Pausing..." : busy === "resume" ? "Continuing..." : paused ? "Continue" : "Take over"}</Button> : null}
          <Button variant="ghost" className="px-2 text-xs text-rose" data-testid="coworker-computer-panel-stop" disabled={controlsBusy || !canStop} aria-busy={stopping} title="Stop computer use and revoke this discussion's access" onClick={onStop}>{stopping ? "Stopping..." : "Stop"}</Button>
        </footer>
        {unavailable || actionError || stopError || cleanupPending ? <p role="alert" className="max-h-24 shrink-0 overflow-y-auto border-t border-line px-3 py-2 text-[11px] leading-relaxed text-amber">{stopError || actionError || (cleanupPending ? "Stopping is not yet confirmed. Access stays off while release is checked." : "View unavailable. Work may still be running; Stop is available.")}</p> : null}
      </> : null}
    </aside>, slot,
  );
}
