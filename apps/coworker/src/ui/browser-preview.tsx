import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { BrowserSnapshot } from "@/lib/bridge";
import { ActionMenu } from "@/ui/kit";

type Snap = BrowserSnapshot["presentation"]["snap"];
const positions: Snap[] = ["top", "middle", "bottom"];
const labels = { top: "Top right", middle: "Middle right", bottom: "Bottom right" };

/** Only three legal positions. The card follows snap targets even during a drag;
 * arbitrary pointer coordinates never become persisted layout. */
export function BrowserPreview({ slot, position, onSnap, children, actions }: { slot: HTMLElement; position: Snap; onSnap: (position: Snap) => Promise<void>; children: ReactNode; actions: ReactNode }) {
  const card = useRef<HTMLElement>(null);
  const drag = useRef<{ id: number; startY: number; moved: boolean; candidate: Snap } | null>(null);
  const [candidate, setCandidate] = useState<Snap | null>(null);
  const [dragging, setDragging] = useState(false);
  const [height, setHeight] = useState(0);
  const [cardHeight, setCardHeight] = useState(0);
  const hint = useId();
  const shown = candidate ?? position;
  useLayoutEffect(() => {
    const resize = new ResizeObserver(() => { setHeight(slot.clientHeight); setCardHeight(card.current?.offsetHeight ?? 0); });
    resize.observe(slot);
    if (card.current) resize.observe(card.current);
    return () => resize.disconnect();
  }, [slot]);
  const top = Math.max(12, Math.min(Math.max(12, height - cardHeight - 12), shown === "top" ? 12 : shown === "middle" ? (height - cardHeight) / 2 : height - cardHeight - 12));
  async function snap(next: Snap) {
    setCandidate(next);
    try { await onSnap(next); } finally { setCandidate(null); }
  }
  return <>
    {dragging ? <div className="pointer-events-none absolute inset-y-3 right-3 z-10 flex w-[min(264px,calc(100%-24px))] flex-col justify-between" aria-hidden="true">
      {positions.map((item) => <div key={item} className={`flex h-12 items-center justify-center rounded-xl border border-dashed text-[10px] ${shown === item ? "border-spark/60 bg-spark/15 text-snow" : "border-white/15 bg-ink/60 text-mist"}`}>{labels[item]}</div>)}
    </div> : null}
    <aside ref={card} style={{ top, maxHeight: Math.max(72, height - 24) }} aria-label="Floating browser" data-testid="coworker-browser-floating" data-snap={shown} className={`pointer-events-auto absolute right-3 z-20 flex w-[min(264px,calc(100%-24px))] flex-col overflow-hidden rounded-2xl border bg-panel shadow-[0_12px_36px_rgba(0,0,0,0.4)] ${dragging ? "border-spark/60" : "border-line transition-[top,border-color] duration-180 motion-reduce:transition-none"}`}>
      <header className="flex shrink-0 items-center gap-1 p-2">
        <button type="button" aria-label="Move browser preview" aria-describedby={hint} data-testid="coworker-browser-drag" className="flex min-w-0 flex-1 touch-none select-none items-center gap-2 rounded-lg px-1.5 py-1.5 text-xs font-medium text-snow outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-spark/60 active:cursor-grabbing" style={{ cursor: dragging ? "grabbing" : "grab" }}
          onPointerDown={(event) => { if (event.button !== 0 || !event.isPrimary) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { id: event.pointerId, startY: event.clientY, moved: false, candidate: position }; }}
          onPointerMove={(event) => {
            const current = drag.current;
            if (!current || current.id !== event.pointerId) return;
            if (!current.moved && Math.abs(event.clientY - current.startY) < 5) return;
            current.moved = true; setDragging(true);
            const fraction = (event.clientY - slot.getBoundingClientRect().top) / Math.max(1, slot.clientHeight);
            current.candidate = fraction < 1 / 3 ? "top" : fraction < 2 / 3 ? "middle" : "bottom";
            setCandidate(current.candidate);
          }}
          onPointerUp={(event) => { const current = drag.current; if (!current || current.id !== event.pointerId) return; drag.current = null; setDragging(false); event.currentTarget.releasePointerCapture(event.pointerId); if (current.moved) void snap(current.candidate); else setCandidate(null); }}
          onLostPointerCapture={() => { if (!drag.current) return; drag.current = null; setDragging(false); setCandidate(null); }}
          onPointerCancel={() => { drag.current = null; setDragging(false); setCandidate(null); }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && drag.current) { drag.current = null; setDragging(false); setCandidate(null); event.preventDefault(); return; }
            const index = positions.indexOf(position);
            const next = event.key === "Home" ? "top" : event.key === "End" ? "bottom" : event.key === "ArrowUp" ? positions[Math.max(0, index - 1)] : event.key === "ArrowDown" ? positions[Math.min(2, index + 1)] : null;
            if (next) { event.preventDefault(); void snap(next); }
          }}>
          <svg viewBox="0 0 16 16" fill="currentColor" className="size-3 shrink-0 text-mist" aria-hidden="true"><path d="M5 2h2v2H5zm4 0h2v2H9zM5 7h2v2H5zm4 0h2v2H9zM5 12h2v2H5zm4 0h2v2H9z" /></svg>Browser
        </button>
        {actions}
        <ActionMenu label="Browser position" items={positions.map((item) => ({ label: labels[item], testId: `browser-snap-${item}`, onSelect: () => void snap(item) }))} />
      </header>
      <p id={hint} className="sr-only">Drag to snap to top, middle or bottom right. Or use Up, Down, Home and End.</p>
      <div className="min-h-0 overflow-y-auto px-2 pb-2">{children}</div>
    </aside>
    <span className="sr-only" role="status" aria-live="polite">Browser preview: {labels[shown]}</span>
  </>;
}
