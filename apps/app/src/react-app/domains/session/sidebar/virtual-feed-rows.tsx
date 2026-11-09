import * as React from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
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

/** Bound the mounted row/menu/title-observer count, not the available history. */
export function VirtualFeedRows({ ids, children }: {
  ids: readonly string[];
  children: (index: number) => React.ReactNode;
}) {
  const root = React.useRef<HTMLDivElement>(null);
  const drag = useDraggedSession();
  const [focusedId, setFocusedId] = React.useState<string | null>(null);
  const [scrollMargin, setScrollMargin] = React.useState(0);
  const getScrollElement = React.useCallback(() => root.current?.closest<HTMLDivElement>('[data-sidebar="content"]') ?? null, []);
  const draggedIndex = drag.session ? ids.indexOf(drag.session.id) : -1;
  const focusedIndex = focusedId ? ids.indexOf(focusedId) : -1;
  const rangeExtractor = React.useCallback((range: Range) => feedRowRange(range, draggedIndex, focusedIndex), [draggedIndex, focusedIndex]);
  const getItemKey = React.useCallback((index: number) => ids[index] ?? index, [ids]);
  const virtualizer = useVirtualizer({
    count: ids.length,
    getScrollElement,
    estimateSize: () => ROW_HEIGHT,
    getItemKey,
    overscan: 6,
    scrollMargin,
    rangeExtractor,
  });

  // Sections share the sidebar's scroller with Pinned, the view switch and
  // earlier sections. Their offsets can change without a scroll event.
  React.useLayoutEffect(() => {
    const element = root.current;
    const scroller = getScrollElement();
    if (!element || !scroller) return;
    const margin = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    setScrollMargin((previous) => Math.abs(previous - margin) < 1 ? previous : margin);
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
        <div key={item.key} className="absolute inset-x-0 top-0" style={{ transform: `translateY(${item.start - scrollMargin}px)` }}>
          {children(item.index)}
        </div>
      ))}
    </div>
  );
}
