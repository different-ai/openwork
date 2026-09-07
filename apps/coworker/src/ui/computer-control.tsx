import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { coworkerBridge, type ComputerSnapshot } from "@/lib/bridge";
import { AlertIcon, Button, ErrorNote, inputClass } from "@/ui/kit";
import { useActivityPopover } from "@/ui/work-popover";

const NATIVE_PHASE_LABELS: Record<string, string> = {
  person_interacting: "You have control",
  ready_to_continue: "Ready to continue",
  refreshing: "Refreshing approved window",
  working: "Working",
  "native-approval": "Waiting for app/window approval",
};

/** Mounted only for a real private discussion, keyed by slug and native thread id. */
export function ComputerControl({ slug, threadId }: { slug: string; threadId: string }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [snapshot, setSnapshot] = useState<ComputerSnapshot | null>(null);
  const [readError, setReadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<"allow" | "stop" | "setup" | "target" | null>(null);
  const [visible, setVisible] = useState(document.visibilityState === "visible");
  const request = useRef(0);
  const reading = useRef<number | null>(null);
  const changing = useRef(false);
  const id = useId();

  async function refresh() {
    if (changing.current || reading.current === request.current) return;
    const version = ++request.current;
    reading.current = version;
    setRefreshing(true);
    try {
      const next = await coworkerBridge.computer.snapshot(slug, threadId);
      if (version !== request.current) return;
      setSnapshot(next);
      setReadError("");
    } catch (cause) {
      if (version === request.current) setReadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (reading.current === version) reading.current = null;
      if (version === request.current) setRefreshing(false);
    }
  }

  const readLatest = useEffectEvent(refresh);
  useEffect(() => {
    void readLatest();
    const onVisibility = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      // Discard late observations, never revoke a native grant on navigation.
      request.current += 1;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const observing = (open && visible) || snapshot?.enabled === true || snapshot?.cleanupPending === true;
  useEffect(() => {
    if (!observing) return;
    void readLatest();
    const timer = window.setInterval(() => void readLatest(), 2_000);
    return () => window.clearInterval(timer);
  }, [observing, open, visible]);

  const target = snapshot?.targets.find((item) => item.id === snapshot.targetId);
  const canStop = Boolean(snapshot && (snapshot.enabled || snapshot.session || snapshot.cleanupPending));
  const canSelectTarget = snapshot !== null && !canStop && !readError;
  const canAllow = canSelectTarget && snapshot?.readiness === "ready" && target?.available === true;

  async function act(action: "allow" | "stop" | "setup" | "target", targetId = "") {
    if (changing.current || !snapshot) return;
    if (action === "allow" && !canAllow) return;
    if (action === "stop" && !canStop) return;
    if (action === "setup" && snapshot.readiness !== "setup-required") return;
    if (action === "target" && (!canSelectTarget || targetId === snapshot.targetId || !snapshot.targets.some((item) => item.id === targetId && item.available))) return;
    changing.current = true;
    // A read started before this explicit action must not overwrite its result.
    const version = ++request.current;
    setBusy(action);
    setRefreshing(false);
    setActionError("");
    let failed = false;
    try {
      let next: ComputerSnapshot;
      if (action === "setup") {
        await coworkerBridge.computer.setup(snapshot.targetId);
        if (version !== request.current) return;
        next = await coworkerBridge.computer.snapshot(slug, threadId);
      } else if (action === "allow" || action === "target") {
        next = await coworkerBridge.computer.configure({ slug, threadId, expectedRevision: snapshot.revision, enabled: action === "allow", targetId: action === "target" ? targetId : snapshot.targetId });
      } else {
        next = await coworkerBridge.computer.stop({ slug, threadId, expectedRevision: snapshot.revision });
      }
      if (version !== request.current) return;
      setSnapshot(next);
      setReadError("");
    } catch (cause) {
      if (version !== request.current) return;
      failed = true;
      const label = action === "allow" ? "Allowing access" : action === "stop" ? "Stop & revoke" : action === "target" ? "Changing target" : "Setup";
      setActionError(`${label} was not confirmed. ${cause instanceof Error ? cause.message : String(cause)} Check the latest state before trying again.`);
    } finally {
      if (version === request.current) {
        changing.current = false;
        setBusy(null);
      }
    }
    // Includes stale-revision errors: reread, but never silently repeat a write.
    if (failed && version === request.current) void refresh();
  }

  const status = snapshot
    ? snapshot.cleanupPending ? "Native cleanup pending" : snapshot.enabled ? "Allowed for this discussion" : "Off for this discussion"
    : readError ? "Unavailable" : "Checking...";
  const readiness = snapshot ? { ready: "Ready", "setup-required": "Setup required", unsupported: "Unsupported", unavailable: "Unavailable" }[snapshot.readiness] : "";
  const expires = snapshot?.session?.expiresAt ? new Date(snapshot.session.expiresAt) : null;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className="window-no-drag inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`Computer control: ${readError || actionError ? "check status" : snapshot ? status : "open settings"}`}
        data-testid="coworker-computer-control"
        onClick={(event) => { setAnchor(event.currentTarget); setOpen((current) => !current); }}
        onKeyDown={(event) => {
          if (open && event.key === "Escape") { event.preventDefault(); setOpen(false); }
        }}
      >
        Computer
        {readError || actionError ? <AlertIcon className="size-3 text-amber" /> : snapshot?.cleanupPending ? <span className="text-amber">Pending</span> : snapshot?.enabled ? <span className="text-ready">On</span> : null}
      </Button>
      {open && anchor ? (
        <ComputerControlPopover anchor={anchor} id={id} onClose={() => setOpen(false)}>
          {readError ? <div role="alert" data-testid="coworker-computer-read-error"><ErrorNote>{snapshot ? "Updates unavailable. Last known state is shown; a connection failure does not confirm a stop. " : "Computer control is unavailable. "}{readError}</ErrorNote></div> : null}
          {actionError ? <div role="alert" data-testid="coworker-computer-action-error"><ErrorNote>{actionError}</ErrorNote></div> : null}
          <div className="space-y-1.5">
            <label htmlFor={`${id}-target`}>Current target</label>
            <select
              id={`${id}-target`}
              className={`${inputClass} bg-panel text-xs disabled:cursor-not-allowed disabled:opacity-60`}
              value={snapshot?.targetId ?? ""}
              disabled={!canSelectTarget || busy !== null}
              aria-busy={busy === "target"}
              aria-describedby={`${id}-placement`}
              data-testid="coworker-computer-target"
              onChange={(event) => void act("target", event.target.value)}
            >
              {!snapshot ? <option value="">{readError ? "Unavailable" : "Checking targets..."}</option> : null}
              {snapshot?.targets.map((item) => <option key={item.id} value={item.id} disabled={!item.available}>{item.label} ({item.placement === "desktop" ? "Desktop" : "Cloud"}){item.available ? "" : " - unavailable"}</option>)}
            </select>
            <p id={`${id}-placement`}>Cloud control stays remote; it never falls back to This Mac.{canStop ? " Stop & revoke before switching targets." : ""}</p>
            {snapshot?.targets.filter((item) => !item.available && item.id !== snapshot.targetId).map((item) => <p key={item.id} data-testid="coworker-computer-target-unavailable">{item.label}: {item.reason ?? "Unavailable."}</p>)}
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
            {target ? <><dt>Placement</dt><dd className="text-snow" data-testid="coworker-computer-placement">{target.placement === "desktop" ? "Desktop" : "Cloud"}</dd></> : null}
            <dt>{readError && snapshot ? "Last known access" : "Access"}</dt>
            <dd className="text-snow" role="status" data-testid="coworker-computer-status">{status}</dd>
            {snapshot ? <><dt>Readiness</dt><dd>{readiness}</dd></> : null}
          </dl>
          {snapshot?.detail ? <p>{snapshot.detail}</p> : null}
          {snapshot?.cleanupPending ? <p className="text-amber" data-testid="coworker-computer-cleanup-pending">Native cleanup is still pending. A stop is not yet confirmed.</p> : null}
          <div className="flex flex-wrap gap-2">
            {!snapshot?.enabled ? <Button type="button" variant="primary" className="text-xs" disabled={!canAllow || busy !== null} aria-busy={busy === "allow"} data-testid="coworker-computer-allow" onClick={() => void act("allow")}>Allow for this discussion</Button> : null}
            {snapshot?.readiness === "setup-required" ? <Button type="button" className="text-xs" disabled={busy !== null} aria-busy={busy === "setup"} data-testid="coworker-computer-setup" onClick={() => void act("setup")}>Set up permissions</Button> : null}
            <Button type="button" variant="danger" className="text-xs" disabled={!canStop || busy !== null} aria-busy={busy === "stop"} data-testid="coworker-computer-stop" onClick={() => void act("stop")}>Stop &amp; revoke</Button>
            <Button type="button" variant="ghost" className="text-xs" disabled={refreshing || busy !== null} aria-busy={refreshing} data-testid="coworker-computer-refresh" onClick={() => void refresh()}>Check status</Button>
          </div>
          {snapshot?.session ? (
            <section className="space-y-2 rounded-xl border border-white/10 bg-white/5 p-3" aria-label="Native computer session" data-testid="coworker-computer-session">
              <h3 className="font-semibold text-snow">Native session</h3>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                <dt>State</dt><dd className="text-snow">{NATIVE_PHASE_LABELS[snapshot.session.state] ?? snapshot.session.state}</dd>
                <dt>Purpose</dt><dd>{snapshot.session.purpose}</dd>
                {snapshot.session.appName ? <><dt>App</dt><dd>{snapshot.session.appName}</dd></> : null}
                {snapshot.session.windowTitle ? <><dt>Window</dt><dd>{snapshot.session.windowTitle}</dd></> : null}
                {snapshot.session.phase ? <><dt>Phase</dt><dd data-testid="coworker-computer-phase">{NATIVE_PHASE_LABELS[snapshot.session.phase] ?? snapshot.session.phase.replaceAll("_", " ").replaceAll("-", " ")}</dd></> : null}
                {expires ? <><dt>Expires (local)</dt><dd data-testid="coworker-computer-expiry">{Number.isNaN(expires.getTime()) ? "Unavailable" : expires.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</dd></> : null}
              </dl>
              {snapshot.session.reason ? <p>{snapshot.session.reason}</p> : null}
              <p>Session state describes computer access, not task completion.</p>
            </section>
          ) : null}
          <p>Off by default for each discussion. Allowing access does not start work or bypass native app/window approval. Setup never grants access.</p>
          <p><span className="font-medium text-snow">Take over</span> / <span className="font-medium text-snow">Continue</span> are in the native task panel. Leaving this discussion does not stop work.</p>
        </ComputerControlPopover>
      ) : null}
    </>
  );
}

function ComputerControlPopover({ anchor, id, onClose, children }: { anchor: HTMLElement; id: string; onClose: () => void; children: ReactNode }) {
  const ref = useActivityPopover(anchor, onClose);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(360, window.innerWidth - 32);
      const top = Math.max(16, rect.bottom + 8);
      setPosition({ left: Math.max(16, Math.min(rect.right - width, window.innerWidth - width - 16)), top, maxHeight: Math.max(0, window.innerHeight - top - 16) });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(anchor.closest("header") ?? anchor);
    window.addEventListener("resize", place);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); };
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="dialog"
      tabIndex={-1}
      aria-modal="false"
      aria-labelledby={`${id}-title`}
      data-testid="coworker-computer-popover"
      className="thinking-popover window-no-drag fixed z-50 w-[min(360px,calc(100vw-32px))] overflow-y-auto overscroll-contain rounded-[14px] border border-line bg-panel text-left text-xs leading-relaxed text-mist shadow-[0_12px_32px_rgba(0,0,0,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ready/50 [overflow-wrap:anywhere]"
      style={position ?? { visibility: "hidden" }}
    >
      <div className="flex items-center justify-between gap-2 px-3.5 pt-2.5">
        <h2 id={`${id}-title`} className="text-sm font-semibold text-snow">Computer control</h2>
        <Button type="button" variant="ghost" className="px-2 text-xs" onClick={onClose}>Close</Button>
      </div>
      <div className="space-y-3 px-3.5 pb-3.5 pt-2">{children}</div>
    </div>,
    document.body,
  );
}
