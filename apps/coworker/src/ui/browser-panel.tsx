import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { coworkerBridge, type BrowserCommand, type BrowserSnapshot } from "@/lib/bridge";
import { Button, ErrorNote } from "@/ui/kit";

/** Mounted only for the actual selected, saved private discussion. Native view
 * identities prevent a late unmount/read from changing the next discussion. */
export function DiscussionBrowser({ slug, threadId, actionsSlot }: { slug: string; threadId: string; actionsSlot: HTMLElement | null }) {
  const [snapshot, setSnapshot] = useState<BrowserSnapshot | null>(null);
  const [viewId, setViewId] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState("");
  const [newTab, setNewTab] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const active = snapshot?.tabs.find((tab) => tab.id === snapshot.activeTabId);
  const open = snapshot?.requested === true;

  useEffect(() => {
    const id = crypto.randomUUID();
    let disposed = false;
    let reading = false;
    let timer = 0;
    setSnapshot(null); setViewId(""); setError("");
    const accept = (next: BrowserSnapshot) => {
      if (!disposed) setSnapshot((prior) => prior && JSON.stringify(prior) === JSON.stringify(next) ? prior : next);
    };
    void coworkerBridge.browser.bind(slug, threadId, id).then((next) => {
      if (disposed) return;
      setViewId(id); accept(next);
      timer = window.setInterval(() => {
        if (reading) return;
        reading = true;
        void coworkerBridge.browser.read(id).then(accept).catch((cause: unknown) => {
          if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
        }).finally(() => { reading = false; });
      }, 750);
    }).catch((cause: unknown) => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => {
      disposed = true; window.clearInterval(timer);
      void coworkerBridge.browser.detach(id).catch(() => undefined);
    };
  }, [slug, threadId, attempt]);

  useEffect(() => { setAddress(active?.url ?? ""); setNewTab(false); }, [active?.id, active?.url]);

  useEffect(() => {
    const element = viewport.current;
    if (!element || !viewId || !open) return;
    let frame = 0;
    let last = "";
    let disposed = false;
    const update = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      // WebContentsViews sit above DOM overlays. Park the page for menus,
      // dialogs, tooltips and the narrow context panel, then restore its bounds.
      const overlay = [...document.querySelectorAll('[role="dialog"], [role="menu"], [role="tooltip"], [data-testid="context-panel"][data-overlay="true"]')]
        .some((node) => node.getClientRects().length > 0 && node.getAttribute("aria-hidden") !== "true");
      const hidden = document.hidden || overlay || rect.width < 1 || rect.height < 1;
      const command: BrowserCommand = hidden ? { action: "hide" } : { action: "bounds", bounds: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(0, rect.x)), height: Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(0, rect.y)) } };
      const key = JSON.stringify(command);
      if (key === last) return;
      last = key;
      void coworkerBridge.browser.command(viewId, command).catch((cause: unknown) => {
        if (!disposed) { last = ""; setError(cause instanceof Error ? cause.message : String(cause)); }
      });
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", schedule);
    schedule();
    return () => {
      disposed = true; window.cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect();
      window.removeEventListener("resize", schedule); document.removeEventListener("scroll", schedule, true); document.removeEventListener("visibilitychange", schedule);
      void coworkerBridge.browser.command(viewId, { action: "hide" }).catch(() => undefined);
    };
  }, [open, viewId, snapshot?.activeTabId, snapshot?.tabs.length]);

  async function command(input: BrowserCommand) {
    if (!viewId || busy) return;
    setBusy(true); setError("");
    try { setSnapshot(await coworkerBridge.browser.command(viewId, input)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <>
    {actionsSlot ? createPortal(<Button variant="ghost" aria-expanded={open} aria-controls="coworker-browser-panel" data-testid="coworker-browser-toggle" disabled={busy || (!viewId && !error)} onClick={() => {
      if (!viewId) setAttempt((value) => value + 1);
      else void command({ action: "request", open: !open });
    }}>Browser{snapshot?.tabs.length ? ` (${snapshot.tabs.length})` : ""}</Button>, actionsSlot) : null}
    {error ? <div className="shrink-0 px-5 py-2" role="alert"><ErrorNote>{error}</ErrorNote></div> : null}
    {open ? <section id="coworker-browser-panel" aria-label="Discussion browser" data-testid="coworker-browser-panel" className="flex h-[46%] min-h-64 shrink-0 flex-col border-b border-line bg-ink">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1">
        <div role="tablist" aria-label="Browser tabs" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {snapshot.tabs.map((tab) => <div key={tab.id} className={`flex max-w-52 shrink-0 items-center rounded-md ${tab.id === snapshot.activeTabId ? "bg-white/8" : ""}`}>
            <button type="button" role="tab" aria-selected={tab.id === snapshot.activeTabId} title={tab.url} className="truncate px-2 py-1 text-xs text-snow" disabled={busy} onClick={() => void command({ action: "select", tabId: tab.id })}>{tab.title || "New tab"}</button>
            <button type="button" aria-label={`Close ${tab.title || "tab"}`} className="px-2 text-xs text-mist hover:text-snow" disabled={busy} onClick={() => void command({ action: "close", tabId: tab.id })}>x</button>
          </div>)}
        </div>
        <Button variant="ghost" aria-label="New browser tab" disabled={busy} onClick={() => { setNewTab(true); setAddress(""); addressInput.current?.focus(); }}>+</Button>
        <Button variant="ghost" aria-label="Hide browser" disabled={busy} onClick={() => void command({ action: "request", open: false })}>Hide</Button>
      </div>
      <form className="flex shrink-0 items-center gap-1 px-3 py-1.5" onSubmit={(event) => {
        event.preventDefault();
        const url = /^https?:\/\//i.test(address.trim()) ? address.trim() : `https://${address.trim()}`;
        void command({ action: newTab || !active ? "open" : "navigate", url });
      }}>
        <Button type="button" variant="ghost" aria-label="Browser back" disabled={busy || !active?.canGoBack} onClick={() => void command({ action: "back" })}>Back</Button>
        <Button type="button" variant="ghost" aria-label="Browser forward" disabled={busy || !active?.canGoForward} onClick={() => void command({ action: "forward" })}>Forward</Button>
        <Button type="button" variant="ghost" aria-label="Reload browser" disabled={busy || !active} onClick={() => void command({ action: "reload" })}>Reload</Button>
        <input ref={addressInput} aria-label={newTab ? "New tab address" : "Browser address"} value={address} onChange={(event) => setAddress(event.target.value)} placeholder="https://example.com" spellCheck={false} className="min-w-0 flex-1 rounded-md border border-line bg-white/5 px-2 py-1 text-xs text-snow outline-none focus:border-spark/50" />
        <Button type="submit" variant="ghost" disabled={busy || !address.trim()}>Go</Button>
      </form>
      <p className="shrink-0 px-4 pb-2 text-[10px] text-mist">Local Coworker browser. Logins are shared across discussions in this profile, not with OpenWork or your system browser.</p>
      <div ref={viewport} className="relative min-h-0 flex-1 bg-white/[0.03]" data-testid="coworker-browser-viewport">
        {!active ? <p className="p-5 text-xs text-mist">Enter an address to open a page in this discussion.</p> : <p className="sr-only" role="status">{active.status === "loading" ? "Loading page" : active.title}</p>}
      </div>
    </section> : null}
  </>;
}
