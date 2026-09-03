/**
 * Where the right panel is: one view (Activity, Apps & tools, Memory…) and a
 * short path inside it, like browsing settings on a phone — tap in, read, tap
 * back. Pure so the stack rules, the breadcrumb collapse, and the remembered
 * route per view are unit-tested; the panel only renders what these return.
 */
export type PanelCrumb = {
  /** Stable id of the level, e.g. "apps" or "app:chapter-notes:open_team_pulse". */
  id: string;
  /** What the breadcrumb and the back control call it. */
  title: string;
};

export type PanelRoute<View extends string = string> = {
  view: View;
  /** Levels below the view's root, shallowest first. Empty at the root. */
  path: PanelCrumb[];
};

/** Root → group → item; a deeper push replaces the last level instead of nesting further. */
export const MAX_PANEL_DEPTH = 3;

export function rootRoute<View extends string>(view: View): PanelRoute<View> {
  return { view, path: [] };
}

export function routeDepth(route: PanelRoute): number {
  return route.path.length;
}

/** Open one level below the current one. Re-opening the current level is a no-op. */
export function pushCrumb<View extends string>(route: PanelRoute<View>, crumb: PanelCrumb): PanelRoute<View> {
  const last = route.path[route.path.length - 1];
  if (last && last.id === crumb.id) return last.title === crumb.title ? route : { view: route.view, path: [...route.path.slice(0, -1), crumb] };
  const kept = route.path.length >= MAX_PANEL_DEPTH ? route.path.slice(0, MAX_PANEL_DEPTH - 1) : route.path;
  return { view: route.view, path: [...kept, crumb] };
}

/** Back one level; the root stays the root. */
export function popCrumb<View extends string>(route: PanelRoute<View>): PanelRoute<View> {
  if (route.path.length === 0) return route;
  return { view: route.view, path: route.path.slice(0, -1) };
}

/** Swap the current level for another at the same depth (a sibling), or open one from the root. */
export function replaceCrumb<View extends string>(route: PanelRoute<View>, crumb: PanelCrumb): PanelRoute<View> {
  if (route.path.length === 0) return { view: route.view, path: [crumb] };
  return { view: route.view, path: [...route.path.slice(0, -1), crumb] };
}

/** Jump to one of the levels above, by depth (0 is the root). */
export function truncateRoute<View extends string>(route: PanelRoute<View>, depth: number): PanelRoute<View> {
  const clamped = Math.max(0, Math.min(route.path.length, Math.floor(depth)));
  if (clamped === route.path.length) return route;
  return { view: route.view, path: route.path.slice(0, clamped) };
}

/** Replace the whole path at once, bounded to the depth the panel supports. */
export function withPath<View extends string>(route: PanelRoute<View>, path: PanelCrumb[]): PanelRoute<View> {
  return { view: route.view, path: path.slice(0, MAX_PANEL_DEPTH) };
}

/** One string per level, so content can be keyed and scroll positions kept apart. */
export function routeKey(route: PanelRoute): string {
  return [route.view, ...route.path.map((crumb) => crumb.id)].join("/");
}

export function sameRoute(a: PanelRoute, b: PanelRoute): boolean {
  return routeKey(a) === routeKey(b);
}

export type Breadcrumb = {
  id: string;
  title: string;
  /** 0 for the root. */
  depth: number;
  current: boolean;
};

/** Every level from the root to the current one. */
export function breadcrumbTrail(route: PanelRoute, rootTitle: string): Breadcrumb[] {
  const trail: Breadcrumb[] = [{ id: "", title: rootTitle, depth: 0, current: route.path.length === 0 }];
  route.path.forEach((crumb, index) => {
    trail.push({ id: crumb.id, title: crumb.title, depth: index + 1, current: index === route.path.length - 1 });
  });
  return trail;
}

/** Below this width the header shows two crumbs at most: the root and the current one. */
export const BREADCRUMB_COLLAPSE_WIDTH = 380;
const WIDE_VISIBLE_CRUMBS = 4;
const NARROW_VISIBLE_CRUMBS = 2;

/**
 * The trail as the header can show it: when it is long or the panel is
 * narrow, the middle folds into "…" and those levels move to a menu.
 */
export function breadcrumbs(
  route: PanelRoute,
  rootTitle: string,
  options: { width?: number; collapseUnder?: number } = {},
): { visible: Breadcrumb[]; skipped: Breadcrumb[] } {
  const trail = breadcrumbTrail(route, rootTitle);
  const collapseUnder = options.collapseUnder ?? BREADCRUMB_COLLAPSE_WIDTH;
  const narrow = options.width !== undefined && options.width < collapseUnder;
  const maxVisible = narrow ? NARROW_VISIBLE_CRUMBS : WIDE_VISIBLE_CRUMBS;
  if (trail.length <= maxVisible) return { visible: trail, skipped: [] };
  const tailCount = maxVisible - 1;
  const first = trail[0];
  if (!first) return { visible: trail, skipped: [] };
  return {
    visible: [first, ...trail.slice(trail.length - tailCount)],
    skipped: trail.slice(1, trail.length - tailCount),
  };
}

/** The level the back control returns to; null at the root. */
export function parentTitle(route: PanelRoute, rootTitle: string): string | null {
  if (route.path.length === 0) return null;
  if (route.path.length === 1) return rootTitle;
  return route.path[route.path.length - 2]?.title ?? rootTitle;
}

export function serializePanelRoute(route: PanelRoute): string {
  return JSON.stringify({ view: route.view, path: route.path.map((crumb) => ({ id: crumb.id, title: crumb.title })) });
}

function isCrumb(value: unknown): value is PanelCrumb {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && typeof Object.fromEntries(Object.entries(value)).id === "string"
    && typeof Object.fromEntries(Object.entries(value)).title === "string";
}

/** The inverse of `serializePanelRoute`; unknown views or malformed paths read as nothing. */
export function restorePanelRoute<View extends string>(
  raw: string | null | undefined,
  isView: (value: string) => value is View,
): PanelRoute<View> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = Object.fromEntries(Object.entries(parsed));
    if (typeof record.view !== "string" || !isView(record.view) || !Array.isArray(record.path)) return null;
    if (!record.path.every(isCrumb)) return null;
    return { view: record.view, path: record.path.slice(0, MAX_PANEL_DEPTH).map((crumb) => ({ id: crumb.id, title: crumb.title })) };
  } catch {
    return null;
  }
}

/** The last route seen in each view, for the session. */
export type PanelRouteMemory<View extends string> = Partial<Record<View, PanelRoute<View>>>;

export function rememberRoute<View extends string>(memory: PanelRouteMemory<View>, route: PanelRoute<View>): PanelRouteMemory<View> {
  const previous = memory[route.view];
  if (previous && sameRoute(previous, route)) return memory;
  return { ...memory, [route.view]: route };
}

export function recallRoute<View extends string>(memory: PanelRouteMemory<View>, view: View): PanelRoute<View> {
  return memory[view] ?? rootRoute(view);
}

/**
 * A two-finger swipe to the right, read from wheel events: on a trackpad the
 * horizontal travel arrives as negative deltaX. The gesture fires once when
 * the travel passes the threshold and stays quiet until the fingers settle.
 */
export type SwipeState = { travel: number; lastAt: number; fired: boolean };

export const SWIPE_BACK_THRESHOLD_PX = 80;
export const SWIPE_SETTLE_MS = 250;

export const restingSwipe: SwipeState = { travel: 0, lastAt: 0, fired: false };

export function accumulateSwipe(
  state: SwipeState,
  wheel: { deltaX: number; deltaY: number; at: number },
  options: { threshold?: number; settleMs?: number } = {},
): { state: SwipeState; back: boolean } {
  const threshold = options.threshold ?? SWIPE_BACK_THRESHOLD_PX;
  const settleMs = options.settleMs ?? SWIPE_SETTLE_MS;
  const settled = wheel.at - state.lastAt > settleMs;
  const base = settled ? restingSwipe : state;
  // Mostly vertical movement is scrolling, not a swipe.
  if (Math.abs(wheel.deltaY) > Math.abs(wheel.deltaX)) return { state: { ...base, lastAt: wheel.at }, back: false };
  const travel = base.travel + wheel.deltaX;
  if (base.fired) return { state: { travel, lastAt: wheel.at, fired: true }, back: false };
  if (travel <= -threshold) return { state: { travel, lastAt: wheel.at, fired: true }, back: true };
  return { state: { travel, lastAt: wheel.at, fired: false }, back: false };
}

/** ⌘[ on macOS, Alt+← everywhere: back one level. */
export function isBackShortcut(event: { key: string; metaKey: boolean; altKey: boolean; ctrlKey: boolean; shiftKey: boolean }): boolean {
  if (event.shiftKey || event.ctrlKey) return false;
  if (event.metaKey && !event.altKey && event.key === "[") return true;
  return event.altKey && !event.metaKey && event.key === "ArrowLeft";
}

/**
 * Deep links: any part of the app can ask the open coworker's panel to show a
 * route (an action line's receipt, the Connect card's status, a Workers count).
 * The panel subscribes while it is mounted; without a subscriber the request
 * is simply not handled.
 */
type PanelRouteListener = (route: PanelRoute) => void;
const listeners = new Set<PanelRouteListener>();

export function subscribePanelRoute(listener: PanelRouteListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function openPanelRoute(route: PanelRoute): boolean {
  if (listeners.size === 0) return false;
  for (const listener of listeners) listener(route);
  return true;
}
