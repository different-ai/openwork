import * as React from "react";
import { defaultRangeExtractor, useVirtualizer, type Range, type Virtualizer } from "@tanstack/react-virtual";
import { useDraggedSession } from "./session-reorder";

const ROW_HEIGHT = 50; // 48px row + the existing 2px gap.

export function feedRowRange(range: Range, draggedIndex: number, focusedIndex: number): number[] {
  const indexes = new Set(defaultRangeExtractor(range));
  // Keep the drag source alive while scrolling, and preserve native Tab order
  // at the viewport edge (the focused row and its immediate neighbours).
  if (draggedIndex >= 0 && draggedIndex < range.count) indexes.add(draggedIndex);
  if (focusedIndex >= 0 && focusedIndex < range.count) {
    for (let i = Math.max(0, focusedIndex - 1); i <= Math.min(range.count - 1, focusedIndex + 1); i++) indexes.add(i);
  }
  return [...indexes].sort((a, b) => a - b);
}

/**
 * How far the list's top has scrolled past the top of the sidebar's viewport, in px.
 * Negative while the list starts below it. Read from live geometry rather than
 * scrollTop plus a remembered offset, so it stays right when Pinned, the view
 * switch or an earlier section changes height without a scroll event.
 */
export function feedListOffset(scrollerTop: number, listTop: number): number {
  return scrollerTop - listTop;
}

type FeedVirtualizer = Virtualizer<HTMLDivElement, Element>;

/** Bound the mounted row/menu/title-observer count, not the available history. */
export function VirtualFeedRows({ ids, children }: {
  ids: readonly string[];
  children: (index: number) => React.ReactNode;
}) {
  const root = React.useRef<HTMLDivElement>(null);
  const drag = useDraggedSession();
  const [focusedId, setFocusedId] = React.useState<string | null>(null);
  const syncOffset = React.useRef<() => void>(() => undefined);
  const getScrollElement = React.useCallback(() => root.current?.closest<HTMLDivElement>('[data-sidebar="content"]') ?? null, []);
  const draggedIndex = drag.session ? ids.indexOf(drag.session.id) : -1;
  const focusedIndex = focusedId ? ids.indexOf(focusedId) : -1;
  const rangeExtractor = React.useCallback((range: Range) => feedRowRange(range, draggedIndex, focusedIndex), [draggedIndex, focusedIndex]);
  const getItemKey = React.useCallback((index: number) => ids[index] ?? index, [ids]);

  // Sections share the sidebar's scroller with Pinned, the view switch and
  // earlier sections, so the virtualizer's offset is this list's own position
  // in that scroller, re-read on scroll, on any resize and on every render.
  const observeElementOffset = React.useCallback((instance: FeedVirtualizer, cb: (offset: number, isScrolling: boolean) => void) => {
    const scroller = instance.scrollElement;
    const list = root.current;
    if (!scroller || !list) return;
    let last = Number.NaN;
    const report = () => {
      const offset = feedListOffset(scroller.getBoundingClientRect().top, list.getBoundingClientRect().top);
      if (Math.abs(offset - last) < 0.5) return;
      last = offset;
      cb(offset, false);
    };
    const resize = new ResizeObserver(report);
    const observeChildren = () => {
      resize.disconnect();
      resize.observe(scroller);
      resize.observe(list);
      for (const child of Array.from(scroller.children)) resize.observe(child);
    };
    const mutations = new MutationObserver(() => {
      observeChildren();
      report();
    });
    observeChildren();
    mutations.observe(scroller, { childList: true });
    scroller.addEventListener("scroll", report, { passive: true });
    syncOffset.current = report;
    report();
    return () => {
      scroller.removeEventListener("scroll", report);
      resize.disconnect();
      mutations.disconnect();
      syncOffset.current = () => undefined;
    };
  }, []);

  // The virtualizer's offsets are relative to this list, so turn a requested
  // offset into the matching scroll of the shared scroller (a no-op when it
  // already matches, as on mount).
  const scrollToFn = React.useCallback((offset: number, { adjustments = 0, behavior }: { adjustments?: number; behavior?: ScrollBehavior }, instance: FeedVirtualizer) => {
    const scroller = instance.scrollElement;
    const list = root.current;
    if (!scroller || !list) return;
    const delta = offset + adjustments - feedListOffset(scroller.getBoundingClientRect().top, list.getBoundingClientRect().top);
    if (Math.abs(delta) < 0.5) return;
    scroller.scrollTo({ top: scroller.scrollTop + delta, behavior });
  }, []);

  const virtualizer = useVirtualizer({
    count: ids.length,
    getScrollElement,
    estimateSize: () => ROW_HEIGHT,
    getItemKey,
    overscan: 6,
    rangeExtractor,
    observeElementOffset,
    scrollToFn,
  });

  React.useLayoutEffect(() => {
    syncOffset.current();
  });

  return (
    <div
      ref={root}
      data-feed-virtual-rows
      className="relative shrink-0"
      style={{ height: Math.max(0, virtualizer.getTotalSize() - 2) }}
      onFocusCapture={(event) => setFocusedId(event.target.closest<HTMLElement>('[data-sidebar-session-id]')?.dataset.sidebarSessionId ?? null)}
      onBlurCapture={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocusedId(null);
      }}
    >
      {virtualizer.getVirtualItems().map((item) => (
        <div key={item.key} className="absolute inset-x-0 top-0" style={{ transform: `translateY(${item.start}px)` }}>
          {children(item.index)}
        </div>
      ))}
    </div>
  );
}
