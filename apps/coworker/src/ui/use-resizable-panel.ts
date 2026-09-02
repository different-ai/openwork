import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  clampPanelWidth,
  readPanelLayout,
  renderedPanelWidth,
  resolvePanelDrag,
  resolvePanelKey,
  writePanelLayout,
  type PanelBounds,
  type PanelLayout,
  type PanelSide,
} from "@/lib/panel-layout";

export type ResizablePanel = {
  /** Width the panel occupies right now. */
  width: number;
  collapsed: boolean;
  resizing: boolean;
  bounds: PanelBounds;
  expand: () => void;
  collapse: () => void;
  toggle: () => void;
  /** Back to the default width, expanded. */
  reset: () => void;
  /** Spread onto the separator element. */
  separatorProps: {
    role: "separator";
    "aria-orientation": "vertical";
    "aria-valuemin": number;
    "aria-valuemax": number;
    "aria-valuenow": number;
    "aria-valuetext": string;
    tabIndex: 0;
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    /** A plain click on the edge folds or unfolds the panel; a drag never counts as one. */
    onClick: () => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  };
};

/** Pointer travel below this is a click on the edge, not a resize. */
const CLICK_TRAVEL_PX = 4;

/**
 * One panel edge the person can drag, click to fold or unfold, nudge with the
 * keyboard, or snap closed by dragging past the fold threshold. There is no
 * separate fold button: the edge is the control. `available` bounds the
 * expanded width by what the window can spare, so the middle column always
 * keeps its minimum.
 */
export function useResizablePanel({
  storageKey,
  side,
  bounds,
  defaultWidth,
  available,
}: {
  storageKey: string;
  side: PanelSide;
  bounds: PanelBounds;
  defaultWidth: number;
  available?: () => number;
}): ResizablePanel {
  const [layout, setLayout] = useState<PanelLayout>(() =>
    readPanelLayout(typeof window === "undefined" ? null : window.localStorage, storageKey, defaultWidth, bounds),
  );
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number; layout: PanelLayout } | null>(null);
  /** Set once a drag has really moved, so the click that follows it is ignored. */
  const dragMoved = useRef(false);
  const room = useCallback(() => available?.(), [available]);

  const commit = useCallback((next: PanelLayout | null) => {
    const resolved = next ?? { width: defaultWidth, collapsed: false };
    setLayout(resolved);
    writePanelLayout(window.localStorage, storageKey, next);
  }, [defaultWidth, storageKey]);

  useEffect(() => {
    if (!resizing) return;
    const move = (event: globalThis.PointerEvent) => {
      const current = drag.current;
      if (!current) return;
      if (Math.abs(event.clientX - current.startX) < CLICK_TRAVEL_PX && !dragMoved.current) return;
      dragMoved.current = true;
      const next = resolvePanelDrag(current.layout, { side, startX: current.startX, currentX: event.clientX, startWidth: current.startWidth }, bounds, room());
      current.layout = next;
      setLayout(next);
    };
    const finish = () => {
      const current = drag.current;
      drag.current = null;
      setResizing(false);
      if (current) writePanelLayout(window.localStorage, storageKey, current.layout);
    };
    document.body.classList.add("is-resizing-panel");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
    return () => {
      document.body.classList.remove("is-resizing-panel");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [bounds, resizing, room, side, storageKey]);

  // The window shrank: keep the expanded width within what it can spare.
  useEffect(() => {
    const keepWithinWindow = () => {
      setLayout((current) => {
        if (current.collapsed) return current;
        const next = clampPanelWidth(current.width, bounds, room());
        if (next === current.width) return current;
        const resolved = { width: next, collapsed: false };
        writePanelLayout(window.localStorage, storageKey, resolved);
        return resolved;
      });
    };
    window.addEventListener("resize", keepWithinWindow);
    return () => window.removeEventListener("resize", keepWithinWindow);
  }, [bounds, room, storageKey]);

  const width = renderedPanelWidth(layout, bounds, room());

  return {
    width,
    collapsed: layout.collapsed,
    resizing,
    bounds,
    expand: () => commit({ width: layout.width, collapsed: false }),
    collapse: () => commit({ width: layout.width, collapsed: true }),
    toggle: () => commit({ width: layout.width, collapsed: !layout.collapsed }),
    reset: () => commit(null),
    separatorProps: {
      role: "separator",
      "aria-orientation": "vertical",
      "aria-valuemin": bounds.min,
      "aria-valuemax": bounds.max,
      "aria-valuenow": width,
      "aria-valuetext": layout.collapsed ? "collapsed" : `${width} pixels wide`,
      tabIndex: 0,
      onPointerDown: (event) => {
        event.preventDefault();
        dragMoved.current = false;
        drag.current = { startX: event.clientX, startWidth: width, layout };
        setResizing(true);
      },
      onClick: () => {
        if (dragMoved.current) {
          dragMoved.current = false;
          return;
        }
        commit({ width: layout.width, collapsed: !layout.collapsed });
      },
      onKeyDown: (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit(null);
          return;
        }
        const next = resolvePanelKey(layout, { side, key: event.key, shift: event.shiftKey }, bounds, room());
        if (!next) return;
        event.preventDefault();
        commit(next);
      },
    },
  };
}
