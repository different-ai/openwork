/** @jsxImportSource react */
import * as React from "react";
import { createPortal } from "react-dom";
import { EyeOff, Globe, GripVertical, Maximize2, MoreHorizontal, PanelRight } from "lucide-react";

import type { BrowserThumbnail } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type { BrowserFloatingSnap } from "./browser-presentation-store";
import { browserNeedsPerson, browserSiteHost, browserStatusLabel } from "./browser-status";
import type { BrowserPanelTab } from "./panel-tab-store";
import { getElectronBrowser } from "./utils";

const SNAPS: BrowserFloatingSnap[] = ["top", "middle", "bottom"];
const SNAP_LABELS: Record<BrowserFloatingSnap, string> = { top: "Top right", middle: "Middle right", bottom: "Bottom right" };
const EDGE = 12;
const THUMBNAIL_INTERVAL_MS = 3_000;

function isSnap(value: unknown): value is BrowserFloatingSnap {
  return value === "top" || value === "middle" || value === "bottom";
}

/**
 * Polls a small preview of the on-screen tab about every 3 s while the card is
 * shown and the window is visible. Completion-driven, so a slow capture never
 * stacks requests.
 */
function useBrowserThumbnail(tab: BrowserPanelTab): BrowserThumbnail | null {
  const [thumbnail, setThumbnail] = React.useState<{ token: object; image: BrowserThumbnail } | null>(null);
  const [visible, setVisible] = React.useState(() => document.visibilityState === "visible");
  const capturable = tab.status === "ready" && tab.browserTask?.status !== "paused";
  // A navigation, reload, takeover or hidden window retires the previous image
  // synchronously, including when the same tab later becomes capturable again.
  const token = React.useMemo(() => ({}), [tab.id, tab.url, capturable, visible]);

  React.useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  React.useEffect(() => {
    const capture = getElectronBrowser()?.thumbnail;
    if (!capture || !visible || !capturable) return;
    let disposed = false;
    let timer: number | null = null;
    const run = async () => {
      try {
        const next = await capture(tab.id);
        if (!disposed) setThumbnail(next && next.url === tab.url ? { token, image: next } : null);
      } catch {
        // Withhold a preview whose freshness could not be confirmed.
        if (!disposed) setThumbnail(null);
      } finally {
        if (!disposed) timer = window.setTimeout(() => void run(), THUMBNAIL_INTERVAL_MS);
      }
    };
    void run();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [capturable, tab.id, tab.url, token, visible]);

  // Never show another page's preview, or a page the person now controls.
  return visible && capturable && thumbnail?.token === token && thumbnail.image.tabId === tab.id && thumbnail.image.url === tab.url ? thumbnail.image : null;
}

type BrowserFloatingCardProps = {
  slot: HTMLElement;
  tab: BrowserPanelTab;
  snap: BrowserFloatingSnap;
  onSnap: (snap: BrowserFloatingSnap) => void;
  onOpenSide: () => void;
  onFullscreen: () => void;
  onHide: () => void;
};

/**
 * The browser as a small card on the right of the conversation. It only snaps
 * to three positions, by drag, keyboard or menu; pointer coordinates never
 * become layout. Clicking the preview opens the browser beside the chat.
 */
export function BrowserFloatingCard({ slot, tab, snap, onSnap, onOpenSide, onFullscreen, onHide }: BrowserFloatingCardProps) {
  const cardRef = React.useRef<HTMLElement>(null);
  const drag = React.useRef<{ pointerId: number; startY: number; moved: boolean; candidate: BrowserFloatingSnap } | null>(null);
  const [candidate, setCandidate] = React.useState<BrowserFloatingSnap | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const [slotHeight, setSlotHeight] = React.useState(0);
  const [cardHeight, setCardHeight] = React.useState(0);
  const hintId = React.useId();
  const thumbnail = useBrowserThumbnail(tab);
  const needsYou = browserNeedsPerson(tab);
  const status = browserStatusLabel(tab);
  const host = browserSiteHost(tab.url);
  const shown = candidate ?? snap;

  React.useLayoutEffect(() => {
    const measure = () => {
      setSlotHeight(slot.clientHeight);
      setCardHeight(cardRef.current?.offsetHeight ?? 0);
    };
    const resize = new ResizeObserver(measure);
    resize.observe(slot);
    if (cardRef.current) resize.observe(cardRef.current);
    measure();
    return () => resize.disconnect();
  }, [slot]);

  const free = Math.max(EDGE, slotHeight - cardHeight - EDGE);
  const top = Math.min(free, shown === "top" ? EDGE : shown === "middle" ? Math.max(EDGE, (slotHeight - cardHeight) / 2) : free);

  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  return (
    <>
      {dragging ? (
        <div className="pointer-events-none absolute inset-y-3 right-3 z-10 flex w-[min(264px,calc(100%-24px))] flex-col justify-between" aria-hidden="true">
          {SNAPS.map((item) => (
            <div
              key={item}
              className={cn(
                "flex h-12 items-center justify-center rounded-xl border border-dashed text-[11px]",
                shown === item ? "border-primary/60 bg-primary/10 text-primary" : "border-border bg-dls-surface/80 text-muted-foreground",
              )}
            >
              {SNAP_LABELS[item]}
            </div>
          ))}
        </div>
      ) : null}
      <aside
        ref={cardRef}
        aria-label="Floating browser"
        data-testid="browser-floating-card"
        data-snap={shown}
        style={{ top, maxHeight: Math.max(72, slotHeight - EDGE * 2) }}
        className={cn(
          "pointer-events-auto absolute right-3 z-20 flex w-[min(264px,calc(100%-24px))] flex-col overflow-hidden rounded-2xl bg-dls-surface text-foreground shadow-[var(--dls-card-shadow)] ring-1 ring-foreground/10",
          dragging ? "ring-primary/50" : "transition-[top] duration-200 ease-out motion-reduce:transition-none",
        )}
      >
        <header className="flex shrink-0 items-center gap-0.5 p-1.5">
          <button
            type="button"
            aria-label="Move browser preview"
            aria-describedby={hintId}
            data-testid="browser-floating-drag"
            className="flex min-w-0 flex-1 touch-none select-none items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            style={{ cursor: dragging ? "grabbing" : "grab" }}
            onPointerDown={(event) => {
              if (event.button !== 0 || !event.isPrimary) return;
              event.preventDefault();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { pointerId: event.pointerId, startY: event.clientY, moved: false, candidate: snap };
            }}
            onPointerMove={(event) => {
              const current = drag.current;
              if (!current || current.pointerId !== event.pointerId) return;
              if (!current.moved && Math.abs(event.clientY - current.startY) < 5) return;
              current.moved = true;
              setDragging(true);
              const fraction = (event.clientY - slot.getBoundingClientRect().top) / Math.max(1, slot.clientHeight);
              current.candidate = fraction < 1 / 3 ? "top" : fraction < 2 / 3 ? "middle" : "bottom";
              setCandidate(current.candidate);
            }}
            onPointerUp={(event) => {
              const current = drag.current;
              if (!current || current.pointerId !== event.pointerId) return;
              endDrag();
              event.currentTarget.releasePointerCapture(event.pointerId);
              if (current.moved) onSnap(current.candidate);
              setCandidate(null);
            }}
            onLostPointerCapture={() => {
              if (!drag.current) return;
              endDrag();
              setCandidate(null);
            }}
            onPointerCancel={() => {
              endDrag();
              setCandidate(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && drag.current) {
                event.preventDefault();
                event.stopPropagation();
                endDrag();
                setCandidate(null);
                return;
              }
              const index = SNAPS.indexOf(snap);
              const next = event.key === "Home" ? "top"
                : event.key === "End" ? "bottom"
                  : event.key === "ArrowUp" ? SNAPS[Math.max(0, index - 1)]
                    : event.key === "ArrowDown" ? SNAPS[Math.min(SNAPS.length - 1, index + 1)]
                      : null;
              if (!next) return;
              event.preventDefault();
              onSnap(next);
            }}
          >
            <GripVertical className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate">Browser</span>
          </button>
          <Tooltip>
            <TooltipTrigger
              render={(
                <Button variant="ghost" size="icon-xs" aria-label="Open beside chat" data-testid="browser-mode-side" onClick={onOpenSide}>
                  <PanelRight />
                </Button>
              )}
            />
            <TooltipContent>Open beside chat</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={(
                <Button variant="ghost" size="icon-xs" aria-label="Full screen" data-testid="browser-mode-fullscreen" onClick={onFullscreen}>
                  <Maximize2 />
                </Button>
              )}
            />
            <TooltipContent>Full screen</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={(
                <Button variant="ghost" size="icon-xs" aria-label="Browser position" data-testid="browser-floating-position">
                  <MoreHorizontal />
                </Button>
              )}
            />
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuRadioGroup value={snap} onValueChange={(value) => { if (isSnap(value)) onSnap(value); }}>
                {SNAPS.map((item) => (
                  <DropdownMenuRadioItem key={item} value={item} data-testid={`browser-snap-${item}`}>
                    {SNAP_LABELS[item]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={(
                <Button variant="ghost" size="icon-xs" aria-label="Hide browser" data-testid="browser-mode-hide" onClick={onHide}>
                  <EyeOff />
                </Button>
              )}
            />
            <TooltipContent>Hide browser</TooltipContent>
          </Tooltip>
        </header>
        <p id={hintId} className="sr-only">Drag to snap to the top, middle or bottom right, or use Up, Down, Home and End.</p>
        <button
          type="button"
          aria-label={`Open browser beside chat: ${host}, ${status}`}
          data-testid="browser-floating-preview"
          className="mx-1.5 mb-1.5 block min-h-0 overflow-hidden rounded-xl text-left outline-none ring-1 ring-foreground/10 focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onOpenSide}
        >
          <div className="flex aspect-[8/5] items-center justify-center overflow-hidden bg-muted">
            {thumbnail ? (
              <img data-testid="browser-floating-thumbnail" src={thumbnail.dataUrl} alt="" className="h-full w-full object-cover object-top" />
            ) : tab.favicon ? (
              <img src={tab.favicon} alt="" className="size-6 rounded-[3px] opacity-70" />
            ) : (
              <Globe className="size-6 text-muted-foreground/60" aria-hidden="true" />
            )}
          </div>
          <div className="flex items-center gap-2 px-2.5 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{host}</p>
              <p className={cn("mt-0.5 truncate text-[11px]", needsYou ? "text-amber-11" : "text-muted-foreground")}>
                {status}
              </p>
            </div>
            {needsYou ? <span className="size-1.5 shrink-0 rounded-full bg-amber-9" aria-hidden="true" /> : null}
          </div>
        </button>
      </aside>
      <span className="sr-only" role="status" aria-live="polite">Browser preview: {SNAP_LABELS[shown]}</span>
    </>
  );
}

/** Portals the floating card into the chat pane's floating layer. */
export function BrowserFloatingCardPortal(props: BrowserFloatingCardProps) {
  return createPortal(<BrowserFloatingCard {...props} />, props.slot);
}
