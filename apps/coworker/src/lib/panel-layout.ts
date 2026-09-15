/**
 * Geometry for the two side panels: a width the person can drag or nudge
 * within bounds, and a collapsed mode the panel snaps into when dragged
 * narrower than it can usefully be. No DOM here so the rules can be tested.
 */
export type PanelSide = "left" | "right";

export type PanelBounds = {
  /** Narrowest useful expanded width. */
  min: number;
  /** Widest expanded width. */
  max: number;
  /** Width of the icon-only rail once collapsed. */
  collapsedWidth: number;
  /** Dragging the expanded width below this snaps the panel closed. */
  collapseBelow: number;
};

export type PanelLayout = {
  /** The remembered expanded width; kept while collapsed so expanding restores it. */
  width: number;
  collapsed: boolean;
};

export function clampPanelWidth(width: number, bounds: PanelBounds, available = Number.POSITIVE_INFINITY): number {
  const ceiling = Math.max(bounds.min, Math.min(bounds.max, available));
  return Math.round(Math.min(ceiling, Math.max(bounds.min, width)));
}

/** The width the panel actually occupies on screen. */
export function renderedPanelWidth(layout: PanelLayout, bounds: PanelBounds, available?: number): number {
  return layout.collapsed ? bounds.collapsedWidth : clampPanelWidth(layout.width, bounds, available);
}

/**
 * How far the pointer moved translates into width growth. A left panel grows
 * when the pointer moves right; a right panel grows when it moves left.
 */
export function dragDelta(side: PanelSide, startX: number, currentX: number): number {
  return side === "left" ? currentX - startX : startX - currentX;
}

/**
 * Resolve a drag in progress. `startWidth` is the on-screen width when the
 * drag began (the collapsed width when starting from a closed panel), so the
 * raw target follows the pointer exactly; the panel closes below the threshold
 * and reopens once dragged back past it.
 */
export function resolvePanelDrag(
  layout: PanelLayout,
  input: { side: PanelSide; startX: number; currentX: number; startWidth: number },
  bounds: PanelBounds,
  available?: number,
): PanelLayout {
  const raw = input.startWidth + dragDelta(input.side, input.startX, input.currentX);
  if (raw < bounds.collapseBelow) return { width: layout.width, collapsed: true };
  return { width: clampPanelWidth(raw, bounds, available), collapsed: false };
}

/** Keyboard nudges on the separator; Home closes the panel, End opens it fully. */
export function resolvePanelKey(
  layout: PanelLayout,
  input: { side: PanelSide; key: string; shift: boolean },
  bounds: PanelBounds,
  available?: number,
): PanelLayout | null {
  const step = input.shift ? 40 : 12;
  const growKey = input.side === "left" ? "ArrowRight" : "ArrowLeft";
  const shrinkKey = input.side === "left" ? "ArrowLeft" : "ArrowRight";
  if (input.key === growKey) {
    if (layout.collapsed) return { width: clampPanelWidth(layout.width, bounds, available), collapsed: false };
    return { width: clampPanelWidth(layout.width + step, bounds, available), collapsed: false };
  }
  if (input.key === shrinkKey) {
    if (layout.collapsed) return layout;
    if (layout.width - step < bounds.min) return { width: layout.width, collapsed: true };
    return { width: clampPanelWidth(layout.width - step, bounds, available), collapsed: false };
  }
  if (input.key === "Home") return { width: layout.width, collapsed: true };
  if (input.key === "End") return { width: clampPanelWidth(bounds.max, bounds, available), collapsed: false };
  return null;
}

export function readPanelLayout(storage: Pick<Storage, "getItem"> | null, key: string, defaultWidth: number, bounds: PanelBounds): PanelLayout {
  let width = defaultWidth;
  let collapsed = false;
  try {
    const storedWidth = Number(storage?.getItem(`${key}.width`) ?? storage?.getItem(key));
    if (Number.isFinite(storedWidth) && storedWidth > 0) width = clampPanelWidth(storedWidth, bounds);
    collapsed = storage?.getItem(`${key}.collapsed`) === "1";
  } catch {
    // Storage may be unavailable; the defaults apply for this session.
  }
  return { width, collapsed };
}

export function writePanelLayout(storage: Pick<Storage, "setItem" | "removeItem"> | null, key: string, layout: PanelLayout | null): void {
  try {
    if (!layout) {
      storage?.removeItem(`${key}.width`);
      storage?.removeItem(key);
      storage?.removeItem(`${key}.collapsed`);
      return;
    }
    storage?.setItem(`${key}.width`, String(layout.width));
    if (layout.collapsed) storage?.setItem(`${key}.collapsed`, "1");
    else storage?.removeItem(`${key}.collapsed`);
  } catch {
    // The layout still applies for this session when storage is blocked.
  }
}
