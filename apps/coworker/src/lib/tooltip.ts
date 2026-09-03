/**
 * The words and the geometry behind the app's one tooltip. Pure, so the copy
 * for the panel strip is unit-tested against the plain-words rule and the
 * placement math is tested against the window's edges.
 */
export type TooltipSide = "top" | "bottom" | "left" | "right";

/** How long the pointer rests before a tooltip appears; long enough not to flicker on the way past. */
export const TOOLTIP_DELAY_MS = 350;
export const TOOLTIP_GAP_PX = 8;
export const TOOLTIP_VIEWPORT_MARGIN_PX = 8;

type Rect = { top: number; left: number; width: number; height: number };

/** Where a tooltip sits so it stays inside the window: beside its trigger, nudged in from the edges. */
export function tooltipPosition(
  trigger: Rect,
  tip: { width: number; height: number },
  side: TooltipSide,
  viewport: { width: number; height: number },
): { top: number; left: number } {
  const centreX = trigger.left + trigger.width / 2 - tip.width / 2;
  const centreY = trigger.top + trigger.height / 2 - tip.height / 2;
  const top = side === "top" ? trigger.top - tip.height - TOOLTIP_GAP_PX
    : side === "bottom" ? trigger.top + trigger.height + TOOLTIP_GAP_PX
      : centreY;
  const left = side === "left" ? trigger.left - tip.width - TOOLTIP_GAP_PX
    : side === "right" ? trigger.left + trigger.width + TOOLTIP_GAP_PX
      : centreX;
  const maxLeft = viewport.width - tip.width - TOOLTIP_VIEWPORT_MARGIN_PX;
  const maxTop = viewport.height - tip.height - TOOLTIP_VIEWPORT_MARGIN_PX;
  return {
    top: Math.max(TOOLTIP_VIEWPORT_MARGIN_PX, Math.min(top, maxTop)),
    left: Math.max(TOOLTIP_VIEWPORT_MARGIN_PX, Math.min(left, maxLeft)),
  };
}

/** The three views the folded strip offers. */
export type PanelView = "overview" | "memory" | "settings";

export const PANEL_VIEW_TITLES: Record<PanelView, string> = {
  overview: "Activity",
  memory: "Memory",
  settings: "Coworker settings",
};

/**
 * What each strip icon's tooltip says: the view's name, then what it shows, in
 * the coworker's name. One clause, no jargon.
 */
export function panelViewTooltip(view: PanelView, coworkerName: string): string {
  switch (view) {
    case "overview":
      return `Activity — what ${coworkerName} is doing now, recently, and the assignments, Workers, and documents it holds`;
    case "memory":
      return `Memory — what ${coworkerName} knows and remembers`;
    case "settings":
      return `Coworker settings — look, role, AI model, apps & tools, retire`;
  }
}

/** Words that never belong in copy a person reads. */
export const BANNED_TOOLTIP_WORDS: readonly string[] = ["engine", "session", "thread", "slot", "route"];
