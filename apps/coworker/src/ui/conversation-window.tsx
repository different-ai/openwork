import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { type ReactNode, type RefObject } from "react";

const WINDOW_THRESHOLD = 80;

/** Keep short chats simple; long chats only mount the rows near the viewport. */
export function useConversationWindow<T>(
  scrollRef: RefObject<HTMLDivElement | null>,
  items: readonly T[],
  keyFor: (item: T, index: number) => string,
) {
  const enabled = items.length > WINDOW_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: enabled ? items.length : 0,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => keyFor(items[index]!, index),
    estimateSize: () => 144,
    overscan: 6,
  });
  return { enabled, virtualizer };
}

export function ConversationWindow<T>({
  items, enabled, virtualizer, render,
}: {
  items: readonly T[];
  enabled: boolean;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  render: (item: T, index: number) => ReactNode;
}) {
  if (!enabled) return <>{items.map(render)}</>;
  return <div style={{ height: virtualizer.getTotalSize(), position: "relative" }} data-testid="conversation-window">
    {virtualizer.getVirtualItems().map((row) => <div
      key={row.key}
      data-index={row.index}
      ref={virtualizer.measureElement}
      className={row.index === items.length - 1 ? undefined : "pb-3"}
      style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${row.start}px)` }}
    >{render(items[row.index]!, row.index)}</div>)}
  </div>;
}
