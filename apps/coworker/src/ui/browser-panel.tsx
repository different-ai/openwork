import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, ErrorNote } from "@/ui/kit";
import { BrowserPreview } from "@/ui/browser-preview";
import { useBrowserViewport, useDiscussionBrowser } from "@/ui/use-discussion-browser";

function BrowserIcon({ kind = "browser", className = "size-4" }: { kind?: "browser" | "back" | "forward" | "reload" | "plus" | "close" | "expand" | "side" | "float" | "hand"; className?: string }) {
  const paths = {
    browser: "M3 6h14M6 4h.01M8 4h.01M4 2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z",
    back: "m12 4-6 6 6 6", forward: "m8 4 6 6-6 6", reload: "M16 8a6 6 0 1 0 0 5M16 3v5h-5",
    plus: "M10 4v12M4 10h12", close: "m5 5 10 10M15 5 5 15", expand: "M12 3h5v5M17 3l-6 6M8 17H3v-5M3 17l6-6",
    side: "M3 3h14v14H3ZM10 3v14", float: "M3 3h14v14H3ZM10 10h5v5h-5Z",
    hand: "M7 10V5a1.5 1.5 0 0 1 3 0v4-6a1.5 1.5 0 0 1 3 0v6-4a1.5 1.5 0 0 1 3 0v5-2a1.5 1.5 0 0 1 3 0v5c0 4-3 5-6 5s-4-1-6-4l-3-4a1.5 1.5 0 0 1 2-2Z",
  };
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><path d={paths[kind]} /></svg>;
}

function siteName(url: string) { try { return new URL(url).hostname; } catch { return "New tab"; } }

function BrowserModal({ children, onExit }: { children: ReactNode; onExit: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    element?.querySelector<HTMLButtonElement>('[aria-label="Exit full screen"]')?.focus();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected && previous.getClientRects().length) previous.focus();
    };
  }, []);
  return createPortal(<dialog ref={dialog} data-testid="coworker-browser-modal" aria-label="Browser full screen" className="fixed inset-0 m-0 h-dvh max-h-none w-dvw max-w-none border-0 bg-panel p-0 text-snow backdrop:bg-black/70" onCancel={(event) => { event.preventDefault(); onExit(); }}>{children}</dialog>, document.body);
}

export function DiscussionBrowser({ slug, threadId, actionsSlot, statusSlot, floatingSlot, active }: { slug: string; threadId: string; actionsSlot: HTMLElement | null; statusSlot: HTMLElement | null; floatingSlot: HTMLElement | null; active: boolean }) {
  const browser = useDiscussionBrowser(slug, threadId, active);
  const { snapshot, tab, handoff, mode, expanded, image, imageAge, viewId, busy, error, readError, command } = browser;
  const [address, setAddress] = useState("");
  const [newTab, setNewTab] = useState(false);
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const canInteract = handoff?.phase === "ready";
  const full = mode === "fullscreen";
  const stale = imageAge !== null && imageAge > 3_000;
  useEffect(() => { setAddress(tab?.url ?? ""); setNewTab(false); }, [tab?.id, tab?.url]);
  useBrowserViewport(viewId, viewport, expanded, active, tab?.id, handoff?.phase, mode);
  if (!active) return null;

  const status = readError ? "Updates unavailable" : handoff?.phase === "pausing" ? "Pausing browser tools…" : handoff ? handoff.reason === "sign-in" ? "Waiting for sign-in" : "You have control" : snapshot?.activity?.state === "running" ? snapshot.activity.label : tab?.status === "loading" ? "Loading page" : "Ready";
  const freshness = stale ? "Preview delayed" : image ? expanded ? "Live preview" : "Preview" : tab?.status === "loading" ? "Loading" : "Updating preview";
  const takeOver = <Button className="inline-flex items-center gap-1.5 text-xs" data-testid="coworker-browser-takeover" disabled={busy || Boolean(readError) || !tab} onClick={() => { if (tab) void command({ action: "takeover", tabId: tab.id }); }}><BrowserIcon kind="hand" />Take over</Button>;
  const resume = handoff ? <Button variant="primary" className="text-xs" data-testid="coworker-browser-resume" disabled={busy || Boolean(readError) || !canInteract} onClick={() => void command({ action: "resume", handoffId: handoff.handoffId })}>{handoff.reason === "sign-in" ? "I’m done" : "Let coworker continue"}</Button> : null;
  const handoffCard = handoff ? <section className="rounded-2xl border border-amber/25 bg-panel p-3 text-xs" aria-label="Browser handoff" data-testid="coworker-browser-handoff">
    <div className="flex items-start gap-2.5"><BrowserIcon kind="hand" className="mt-0.5 size-4 shrink-0 text-amber" /><div className="min-w-0 flex-1"><p className="font-medium text-snow" role="status">{status}</p><p className="mt-1 leading-relaxed text-mist">{!canInteract ? "Waiting for in-flight input to stop. Manual input stays locked until that is confirmed." : "Browser tools are paused. Enter sensitive details only on the page, never in chat. Continuing does not approve a purchase, send, or deletion."}</p></div></div>
    <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">{!expanded ? <Button className="text-xs" disabled={busy} onClick={() => void command({ action: "present", mode: "side" })}>Open browser</Button> : null}{resume}</div>
  </section> : null;
  const modes = <>
    {mode !== "side" ? <Button variant="ghost" className="p-1.5" aria-label="Open browser beside chat" data-testid="coworker-browser-side" disabled={busy} onClick={() => void command({ action: "present", mode: "side" })}><BrowserIcon kind="side" /></Button> : null}
    {!full ? <Button variant="ghost" className="p-1.5" aria-label="Expand browser full screen" data-testid="coworker-browser-fullscreen" disabled={busy} onClick={() => void command({ action: "present", mode: "fullscreen" })}><BrowserIcon kind="expand" /></Button> : null}
  </>;

  const viewer = <section id="coworker-browser-panel" aria-label="Discussion browser" data-testid="coworker-browser-panel" data-mode={mode} className={`flex min-h-0 min-w-0 flex-col bg-panel ${full ? "h-full" : "order-first h-[48%] min-h-56 shrink-0 border-b border-line @min-[760px]/discussion:order-none @min-[760px]/discussion:h-full @min-[760px]/discussion:w-[52%] @min-[760px]/discussion:border-b-0 @min-[760px]/discussion:border-l"}`}>
    <header className={`flex h-12 shrink-0 items-center gap-2 border-b border-line px-3 ${full ? "window-drag window-controls-inset" : ""}`}>
      <BrowserIcon /><h2 className="text-sm font-medium text-snow">Browser</h2><span className="min-w-0 flex-1 truncate text-xs text-mist" role="status">· {status}</span>{modes}
      <Button variant="ghost" className="p-1.5" aria-label={full ? "Exit full screen" : "Show floating browser"} data-testid="coworker-browser-collapse" disabled={busy} onClick={() => void command(full ? { action: "exit-fullscreen" } : { action: "present", mode: "floating" })}><BrowserIcon kind={full ? "close" : "float"} /></Button>
    </header>
    <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1">
      <div role="tablist" aria-label="Browser tabs" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {snapshot?.tabs.map((item) => <div key={item.id} className={`flex max-w-44 shrink-0 items-center rounded-lg ${item.id === tab?.id ? "bg-white/8" : ""}`}>
          <button type="button" role="tab" aria-selected={item.id === tab?.id} title={item.url} className="min-w-0 truncate px-2 py-2 text-[11px] text-snow focus-visible:outline-spark" disabled={busy} onClick={() => void command({ action: "select", tabId: item.id })}>{item.title || "New tab"}</button>
          <button type="button" aria-label={`Close ${item.title || "tab"}`} className="shrink-0 rounded p-1.5 text-mist hover:text-snow disabled:opacity-30" disabled={busy || !canInteract} onClick={() => void command({ action: "close", tabId: item.id })}><BrowserIcon kind="close" className="size-3" /></button>
        </div>)}
      </div>
      <Button variant="ghost" className="p-1.5" aria-label="New browser tab" disabled={busy || Boolean(tab && !canInteract)} onClick={() => { setNewTab(true); setAddress(""); addressInput.current?.focus(); }}><BrowserIcon kind="plus" /></Button>
    </div>
    <form className="flex shrink-0 items-center gap-0.5 p-2" onSubmit={(event) => { event.preventDefault(); if (!address.trim()) return; const url = /^https?:\/\//i.test(address.trim()) ? address.trim() : `https://${address.trim()}`; void command({ action: newTab || !tab ? "open" : "navigate", url }); }}>
      <Button type="button" variant="ghost" className="p-1.5" aria-label="Browser back" disabled={busy || !canInteract || !tab?.canGoBack} onClick={() => void command({ action: "back" })}><BrowserIcon kind="back" /></Button>
      <Button type="button" variant="ghost" className="p-1.5" aria-label="Browser forward" disabled={busy || !canInteract || !tab?.canGoForward} onClick={() => void command({ action: "forward" })}><BrowserIcon kind="forward" /></Button>
      <Button type="button" variant="ghost" className="p-1.5" aria-label="Reload browser" disabled={busy || !canInteract || !tab} onClick={() => void command({ action: "reload" })}><BrowserIcon kind="reload" /></Button>
      <input ref={addressInput} aria-label={newTab ? "New tab address" : "Browser address"} value={address} readOnly={Boolean(tab && !canInteract)} onChange={(event) => setAddress(event.target.value)} placeholder="Enter a website address" spellCheck={false} className="min-w-0 flex-1 rounded-lg border border-line bg-white/5 px-2.5 py-1.5 text-xs text-snow outline-none focus:border-spark/50" />
      <Button type="submit" variant="ghost" className="px-2 text-xs" disabled={busy || !address.trim() || Boolean(tab && !canInteract)}>Go</Button>
    </form>
    <div ref={setViewport} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-ink" data-testid="coworker-browser-viewport" data-control={handoff?.phase ?? "watch"}>
      {!tab ? <div className="flex flex-col items-center gap-3 px-6 text-center text-mist"><BrowserIcon className="size-8 opacity-50" /><p className="text-sm text-snow">A browser for this discussion</p><p className="max-w-64 text-xs leading-relaxed">Open a website above, or ask your coworker to browse. Pages stay on this computer.</p></div>
        : !handoff ? <button type="button" aria-label="Take control of the browser page" data-testid="coworker-browser-watch" className="group relative flex h-full w-full items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-spark/60" disabled={busy || Boolean(readError)} onClick={() => void command({ action: "takeover", tabId: tab.id })}>
          {image && image.tabId === tab.id ? <img data-testid="coworker-browser-watch-image" src={`data:${image.mimeType};base64,${image.imageBase64}`} alt="Current browser view, watch only" className="max-h-full max-w-full object-contain" /> : <span className="text-xs text-mist">{readError ? "Preview unavailable" : "Updating browser view…"}</span>}
          <span className="absolute bottom-4 rounded-full border border-white/10 bg-panel/95 px-3 py-1.5 text-[11px] text-snow shadow-lg">Click to take control · This click won’t reach the page</span>
        </button> : !canInteract ? <p className="max-w-sm px-6 text-center text-sm text-mist">Pausing browser tools before giving you control…</p> : <p className="sr-only" role="status">You control the local browser. Press Escape in full screen to return to the chat.</p>}
    </div>
    {full && handoffCard ? <div className="shrink-0 border-t border-line p-3">{handoffCard}</div> : null}
    {full && error ? <div className="shrink-0 px-3 py-2" role="alert"><ErrorNote>{error}</ErrorNote></div> : null}
    <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-3 py-2.5">
      <div className="min-w-0 flex-1"><p className="truncate text-xs text-snow">{tab ? siteName(tab.url) : "On this computer"}</p><p className="mt-0.5 text-[10px] text-mist">{handoff ? canInteract ? "You have control · Screenshots paused" : "Manual input locked while tools stop" : "Watch only · Local Coworker profile"}</p></div>
      {tab && !handoff ? <>{takeOver}<span className={`rounded-md border px-1.5 py-1 text-[9px] ${stale ? "border-amber/25 text-amber" : "border-ready/25 text-ready"}`}>{freshness}</span></> : null}
    </footer>
  </section>;

  return <>
    {actionsSlot ? createPortal(<Button variant="ghost" className="inline-flex items-center justify-start gap-2 rounded-lg px-2 text-xs" aria-label="Browser" title="Browser" aria-expanded={expanded || mode === "floating"} aria-controls="coworker-browser-panel" data-testid="coworker-browser-toggle" disabled={busy || (!viewId && !error)} onClick={() => { if (!viewId) browser.retry(); else void command({ action: "present", mode: mode === "hidden" ? tab ? "floating" : "side" : "hidden" }); }}><BrowserIcon className="size-4 shrink-0" /><span data-tool-label>Browser</span>{handoff ? <span className="size-1.5 shrink-0 rounded-full bg-amber" aria-label="Waiting for you" /> : null}</Button>, actionsSlot) : null}
    {statusSlot && !full ? createPortal(<>{handoffCard}{error ? <div role="alert"><ErrorNote>{error}</ErrorNote></div> : null}</>, statusSlot) : null}
    {mode === "side" ? viewer : full ? <BrowserModal onExit={() => void command({ action: "exit-fullscreen" })}>{viewer}</BrowserModal> : null}
    {mode === "floating" && tab && floatingSlot && snapshot ? createPortal(<BrowserPreview slot={floatingSlot} position={snapshot.presentation.snap} onSnap={(position) => command({ action: "snap", position })} actions={<>{modes}<Button variant="ghost" className="p-1.5" aria-label="Hide browser preview" disabled={busy} onClick={() => void command({ action: "present", mode: "hidden" })}><BrowserIcon kind="close" className="size-3.5" /></Button></>}>
      <button type="button" aria-label="Open browser live view" data-testid="coworker-browser-preview" disabled={busy} onClick={() => void command({ action: "present", mode: "side" })} className="block w-full overflow-hidden rounded-xl border border-line text-left outline-none focus-visible:ring-2 focus-visible:ring-spark/60">
        <div className="relative flex aspect-[8/5] items-center justify-center overflow-hidden bg-ink">
          {image && image.tabId === tab.id ? <img data-testid="coworker-browser-thumbnail" src={`data:${image.mimeType};base64,${image.imageBase64}`} alt="Latest browser preview" className="h-full w-full object-contain" /> : <BrowserIcon kind={handoff ? "hand" : "browser"} className="size-7 text-mist/50" />}
          <span className="absolute bottom-1.5 left-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[9px] text-white">{handoff ? "Private handoff" : freshness}</span>
        </div>
        <div className="border-t border-line bg-white/[0.02] px-2.5 py-2"><p className="truncate text-[11px] font-medium text-snow">{siteName(tab.url)}</p><p className={`mt-0.5 truncate text-[10px] ${handoff ? "text-amber" : "text-mist"}`}>{status} · On this computer</p></div>
      </button>
    </BrowserPreview>, floatingSlot) : null}
  </>;
}
