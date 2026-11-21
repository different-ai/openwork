"use client";

import { useRef, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import { FloatingGlass } from "./floating-glass";

const PHONE_SHEET = "(max-width: 639.98px)";
const SLOP_PX = 6;

type Drag = { id: number; startY: number; dy: number; at: number; velocity: number; moved: boolean };

/** Whether a pull of `dy` px, moving at `velocity` px/ms when let go, closes a sheet `height` px tall. */
export function sheetDragCloses(dy: number, velocity: number, height: number) {
  return dy > Math.min(140, height * 0.25) || (dy > 24 && velocity > 0.5);
}

export function useSheetDrag(onClose: () => void) {
  const popup = useRef<HTMLDivElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const swallowClick = useRef(false);
  const place = (dy: number, follow: boolean) => {
    const node = popup.current;
    if (!node) return;
    node.style.transition = follow ? "none" : "";
    node.style.transform = dy > 0 ? `translateY(${dy}px)` : "";
  };
  const end = (event: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    drag.current = null;
    if (!current.moved) return;
    swallowClick.current = true;
    const node = popup.current;
    if (!cancelled && node && sheetDragCloses(current.dy, current.velocity, node.offsetHeight)) {
      node.style.transition = "";
      node.style.transform = "translateY(100%)";
      onClose();
      return;
    }
    place(0, false);
  };
  return {
    popupRef: popup,
    handle: {
      "data-workbot-sheet-drag": "",
      onPointerDown(event: ReactPointerEvent<HTMLElement>) {
        if (event.button !== 0 || !window.matchMedia(PHONE_SHEET).matches) return;
        swallowClick.current = false;
        drag.current = { id: event.pointerId, startY: event.clientY, dy: 0, at: event.timeStamp, velocity: 0, moved: false };
      },
      onPointerMove(event: ReactPointerEvent<HTMLElement>) {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        const dy = Math.max(0, event.clientY - current.startY);
        if (!current.moved) {
          if (dy < SLOP_PX) return;
          current.moved = true;
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        const elapsed = Math.max(1, event.timeStamp - current.at);
        current.velocity = (dy - current.dy) / elapsed;
        current.dy = dy;
        current.at = event.timeStamp;
        place(dy, true);
      },
      onPointerUp(event: ReactPointerEvent<HTMLElement>) { end(event, false); },
      onPointerCancel(event: ReactPointerEvent<HTMLElement>) { end(event, true); },
      onClickCapture(event: ReactMouseEvent<HTMLElement>) {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
}

/**
 * The bottom of a phone sheet, edge to edge: rows scroll under the home indicator and Safari's toolbar and soften
 * there through the same progressive glass as the floating message box (floating-glass.tsx). Hidden on wider screens.
 */
export function PhoneSheetEdge() {
  return <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 isolate h-[calc(env(safe-area-inset-bottom)+2rem)] sm:hidden" data-workbot-sheet-edge><FloatingGlass edge="bottom" /></span>;
}

/** The small bar at the top of a phone sheet that says it can be pulled down. Hidden on wider screens. */
export function SheetGrabber() {
  return <span aria-hidden className="pointer-events-none absolute left-1/2 top-2 h-[5px] w-9 -translate-x-1/2 rounded-full bg-[var(--wb-disabled)] sm:hidden" data-workbot-sheet-grabber />;
}
