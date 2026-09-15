import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import {
  accumulateSwipe,
  breadcrumbs,
  isBackShortcut,
  parentTitle,
  popCrumb,
  pushCrumb,
  recallRoute,
  rememberRoute,
  restingSwipe,
  rootRoute,
  routeDepth,
  routeKey,
  sameRoute,
  subscribePanelRoute,
  truncateRoute,
  withPath,
  type Breadcrumb,
  type PanelCrumb,
  type PanelRoute,
  type PanelRouteMemory,
  type SwipeState,
} from "@/lib/panel-route";
import { IconButton } from "@/ui/kit";

export type PanelDirection = "forward" | "back" | "none";

/** The row a level was opened from; `at` makes each return distinct so focus moves every time. */
export type ReturnFocus = { id: string; at: number };

export type PanelNavigation<View extends string> = {
  route: PanelRoute<View>;
  /** Which way the last move went, for the content slide. */
  direction: PanelDirection;
  /** The row the current level was opened from, once Back returns to it. */
  returnFocusRow: ReturnFocus | null;
  /** Show a view at the route it was last on this session. */
  showView: (view: View) => void;
  /** Show a view at its root. */
  toRoot: (view: View) => void;
  /** Go anywhere: a deep link or a search result, with its trail built. */
  navigate: (route: PanelRoute<View>) => void;
  push: (crumb: PanelCrumb, fromRow?: string) => void;
  /** Replace the path inside the current view, as if navigated; remembers the row it came from. */
  setPath: (path: PanelCrumb[], fromRow?: string) => void;
  back: () => void;
  toDepth: (depth: number) => void;
  /** Attach to the panel element so a two-finger swipe right goes back. */
  panelRef: RefObject<HTMLElement | null>;
};

/**
 * The right panel's place: a route per view remembered for the session, with
 * the back gestures and keys wired while the panel is open. Escape goes back
 * one level, or closes the panel at a root; ⌘[ / Alt+← and a two-finger swipe
 * right go back; a deep link from elsewhere opens the panel on its route.
 */
export function usePanelNavigation<View extends string>(options: {
  initialView: View;
  isView: (value: string) => value is View;
  open: boolean;
  /** Escape at a root. */
  onEscapeAtRoot: () => void;
  /** A deep link arrived: unfold the panel. */
  onRequestOpen: () => void;
}): PanelNavigation<View> {
  const { initialView, isView, open, onEscapeAtRoot, onRequestOpen } = options;
  const [route, setRoute] = useState<PanelRoute<View>>(() => rootRoute(initialView));
  const [direction, setDirection] = useState<PanelDirection>("none");
  const [returnFocusRow, setReturnFocusRow] = useState<ReturnFocus | null>(null);
  const memoryRef = useRef<PanelRouteMemory<View>>({});
  /** Which row each level was opened from, by the key of the level it sits in. */
  const originsRef = useRef(new Map<string, string>());
  const routeRef = useRef(route);
  routeRef.current = route;
  const panelRef = useRef<HTMLElement | null>(null);

  const move = useCallback((next: PanelRoute<View>, nextDirection: PanelDirection, focusRow: string | null = null) => {
    const current = routeRef.current;
    if (sameRoute(current, next)) return;
    memoryRef.current = rememberRoute(memoryRef.current, next);
    setDirection(nextDirection);
    setReturnFocusRow(focusRow ? { id: focusRow, at: Date.now() } : null);
    setRoute(next);
  }, []);

  const showView = useCallback((view: View) => {
    move(recallRoute(memoryRef.current, view), "none");
  }, [move]);
  const toRoot = useCallback((view: View) => {
    move(rootRoute(view), routeRef.current.view === view && routeDepth(routeRef.current) > 0 ? "back" : "none");
  }, [move]);
  const navigate = useCallback((next: PanelRoute<View>) => {
    const current = routeRef.current;
    const deeper = next.view === current.view && routeDepth(next) > routeDepth(current);
    move(next, next.view !== current.view ? "none" : deeper ? "forward" : "back");
  }, [move]);
  const push = useCallback((crumb: PanelCrumb, fromRow?: string) => {
    const current = routeRef.current;
    if (fromRow) originsRef.current.set(routeKey(current), fromRow);
    move(pushCrumb(current, crumb), "forward");
  }, [move]);
  const setPath = useCallback((path: PanelCrumb[], fromRow?: string) => {
    const current = routeRef.current;
    if (fromRow) originsRef.current.set(routeKey(current), fromRow);
    const next = withPath(current, path);
    move(next, routeDepth(next) >= routeDepth(current) ? "forward" : "back");
  }, [move]);
  const back = useCallback(() => {
    const current = routeRef.current;
    if (routeDepth(current) === 0) return;
    const parent = popCrumb(current);
    move(parent, "back", originsRef.current.get(routeKey(parent)) ?? null);
  }, [move]);
  const toDepth = useCallback((depth: number) => {
    const current = routeRef.current;
    const target = truncateRoute(current, depth);
    move(target, "back", originsRef.current.get(routeKey(target)) ?? null);
  }, [move]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (isBackShortcut(event)) {
        if (routeDepth(routeRef.current) === 0) return;
        event.preventDefault();
        back();
        return;
      }
      if (event.key !== "Escape") return;
      // An open menu or dialog owns Escape; the panel only moves when nothing else is in the way.
      if (document.querySelector('[role="menu"], [role="dialog"], dialog[open]')) return;
      if (routeDepth(routeRef.current) > 0) {
        event.preventDefault();
        back();
        return;
      }
      onEscapeAtRoot();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [back, onEscapeAtRoot, open]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    let swipe: SwipeState = restingSwipe;
    const onWheel = (event: WheelEvent) => {
      const result = accumulateSwipe(swipe, { deltaX: event.deltaX, deltaY: event.deltaY, at: event.timeStamp });
      swipe = result.state;
      if (result.back && routeDepth(routeRef.current) > 0) back();
    };
    panel.addEventListener("wheel", onWheel, { passive: true });
    return () => panel.removeEventListener("wheel", onWheel);
  }, [back, open]);

  useEffect(() => subscribePanelRoute((requested) => {
    if (!isView(requested.view)) return;
    const next: PanelRoute<View> = { view: requested.view, path: requested.path };
    onRequestOpen();
    const current = routeRef.current;
    move(next, next.view !== current.view ? "none" : routeDepth(next) > routeDepth(current) ? "forward" : "back");
  }), [isView, move, onRequestOpen]);

  return { route, direction, returnFocusRow, showView, toRoot, navigate, push, setPath, back, toDepth, panelRef };
}

/**
 * The panel's 78 px header band: one back control on the left when there is
 * a level to go back to, breadcrumbs in the middle (collapsing to … with a
 * menu of the skipped levels when long or narrow), the view's own action on
 * the right.
 */
export function PanelHeader({
  route,
  rootTitle,
  width,
  onBack,
  onToDepth,
  leading,
  actions,
}: {
  route: PanelRoute;
  rootTitle: string;
  width: number;
  onBack: () => void;
  onToDepth: (depth: number) => void;
  /** What sits left of the root title at depth 0 (the view's own way back). */
  leading?: ReactNode;
  actions?: ReactNode;
}) {
  const depth = routeDepth(route);
  const parent = parentTitle(route, rootTitle);
  const { visible, skipped } = breadcrumbs(route, rootTitle, { width });
  const root = visible[0];
  const tail = visible.slice(1);
  return (
    <header className="glass-header window-drag flex h-[78px] items-center gap-1.5 border-b border-line pl-3 pr-4 pt-2">
      {depth > 0 && parent !== null ? (
        <IconButton label={`Back to ${parent}`} className="window-no-drag" data-testid="panel-back" onClick={onBack}>
          <span aria-hidden="true">←</span>
        </IconButton>
      ) : leading}
      <nav aria-label="Where you are in this panel" className="window-no-drag flex min-w-0 flex-1 items-center gap-1 overflow-hidden" data-testid="panel-breadcrumbs" data-collapsed={skipped.length > 0 ? "true" : "false"}>
        {/* When the trail is tight the root gives way first, so the level on screen stays legible. */}
        {root ? <Crumb crumb={root} onSelect={onToDepth} yielding={tail.length > 0} /> : null}
        {skipped.length > 0 ? (
          <>
            <Separator />
            <SkippedCrumbs crumbs={skipped} onSelect={onToDepth} />
          </>
        ) : null}
        {tail.map((crumb) => (
          <span key={crumb.depth} className={`flex min-w-0 items-center gap-1 ${crumb.current ? "max-w-[70%] shrink-0" : ""}`}>
            <Separator />
            <Crumb crumb={crumb} onSelect={onToDepth} />
          </span>
        ))}
      </nav>
      {actions ? <div className="window-no-drag flex shrink-0 items-center gap-1">{actions}</div> : null}
    </header>
  );
}

function Separator() {
  return <span className="shrink-0 text-[11px] text-mist/60" aria-hidden="true">›</span>;
}

function Crumb({ crumb, onSelect, yielding = false }: { crumb: Breadcrumb; onSelect: (depth: number) => void; yielding?: boolean }) {
  return (
    <button
      type="button"
      className={`min-w-0 truncate rounded-md px-1 py-0.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60 ${
        crumb.current ? "font-semibold text-snow" : "font-medium text-mist hover:text-snow"
      } ${yielding ? "shrink-[3]" : ""}`}
      aria-current={crumb.current ? "page" : undefined}
      data-testid="panel-crumb"
      data-depth={crumb.depth}
      onClick={() => onSelect(crumb.depth)}
      title={crumb.title}
    >
      {crumb.title}
    </button>
  );
}

/** The folded middle of a long trail: "…" with a menu of the levels it hides. */
function SkippedCrumbs({ crumbs, onSelect }: { crumbs: Breadcrumb[]; onSelect: (depth: number) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target instanceof Node ? event.target : null)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        className="rounded-md px-1 py-0.5 text-sm font-medium text-mist transition-colors hover:text-snow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60"
        aria-label={`${crumbs.length} more ${crumbs.length === 1 ? "level" : "levels"}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-testid="panel-crumb-more"
        onClick={() => setOpen((current) => !current)}
      >
        …
      </button>
      {open ? (
        <div id={menuId} role="menu" aria-label="Levels above" className="absolute left-0 top-full z-40 mt-1 min-w-40 overflow-hidden rounded-xl border border-line bg-[#0d121b] py-1 text-left">
          {crumbs.map((crumb) => (
            <button
              key={crumb.depth}
              type="button"
              role="menuitem"
              className="block w-full truncate px-3 py-1.5 text-left text-xs text-snow transition-colors hover:bg-white/6"
              data-testid="panel-crumb"
              data-depth={crumb.depth}
              onClick={() => {
                setOpen(false);
                onSelect(crumb.depth);
              }}
            >
              {crumb.title}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The scrolling body of the panel: one container for every level, so each
 * level keeps its own scroll position (restored on Back) while the header
 * above never moves. A view that has levels wraps each in a `PanelLevel`.
 */
export function PanelContent({
  route,
  children,
  containerRef,
}: {
  route: PanelRoute;
  children: ReactNode;
  /** Receives the scroll container, so a level can hand focus back to its row. */
  containerRef?: (element: HTMLDivElement | null) => void;
}) {
  const key = routeKey(route);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const positions = useRef(new Map<string, number>());
  const previousKey = useRef(key);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (previousKey.current !== key) {
      previousKey.current = key;
      element.scrollTop = positions.current.get(key) ?? 0;
    }
  }, [key]);
  const setElement = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element;
    containerRef?.(element);
  }, [containerRef]);
  return (
    <div
      ref={setElement}
      className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4"
      onScroll={(event) => positions.current.set(key, event.currentTarget.scrollTop)}
      data-testid="panel-content"
      data-route={key}
      data-depth={routeDepth(route)}
    >
      {children}
    </div>
  );
}

/**
 * One level's content: keyed by the caller so it re-enters on every move,
 * sliding in from the side it came from (~160 ms; none under reduced motion).
 */
export function PanelLevel({ direction, children }: { direction: PanelDirection; children: ReactNode }) {
  return (
    <div className={direction === "forward" ? "panel-level panel-level-forward" : direction === "back" ? "panel-level panel-level-back" : "panel-level"}>
      {children}
    </div>
  );
}
