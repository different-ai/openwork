import { useCallback, useLayoutEffect, useRef, useState } from "react";

type ReadingPosition = { top: number; pinned: boolean; anchor: string | null; offset: number };
const positions = new Map<string, ReadingPosition>();
const SLACK_PX = 48;

/** Reading belongs to the conversation, not its mount. Only a gesture repins it. */
export function useConversationScroll(scope: string, active: boolean, ready: boolean) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const position = useRef<ReadingPosition>(positions.get(scope) ?? { top: 0, pinned: true, anchor: null, offset: 0 });
  const [away, setAway] = useState(!position.current.pinned);
  const follow = useRef<() => void>(() => {});

  const jumpToLatest = useCallback(() => {
    position.current = { top: 0, pinned: true, anchor: null, offset: 0 };
    positions.set(scope, position.current);
    setAway(false);
    follow.current();
  }, [scope]);

  useLayoutEffect(() => {
    const box = scrollRef.current;
    const content = contentRef.current;
    if (!box || !content || !active || !ready) return;
    position.current = positions.get(scope) ?? { top: 0, pinned: true, anchor: null, offset: 0 };
    let frame = 0;
    let writtenTop: number | null = null;
    let height = box.scrollHeight;
    let viewport = box.clientHeight;
    let gestureUntil = 0;
    const anchors = () => Array.from(content.querySelectorAll<HTMLElement>("[data-scroll-anchor]"));
    const remember = () => {
      const top = box.getBoundingClientRect().top;
      const anchor = position.current.pinned ? null : anchors().find((node) => node.getBoundingClientRect().bottom > top);
      position.current = { top: box.scrollTop, pinned: position.current.pinned, anchor: anchor?.dataset.scrollAnchor ?? null, offset: anchor ? anchor.getBoundingClientRect().top - top : 0 };
      positions.set(scope, position.current);
    };
    const restore = () => {
      const saved = position.current;
      const anchor = saved.anchor ? anchors().find((node) => node.dataset.scrollAnchor === saved.anchor) : null;
      box.scrollTop = saved.pinned ? box.scrollHeight : anchor ? box.scrollTop + anchor.getBoundingClientRect().top - box.getBoundingClientRect().top - saved.offset : saved.top;
      writtenTop = box.scrollTop;
      height = box.scrollHeight;
      viewport = box.clientHeight;
      setAway(!saved.pinned);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(restore);
    };
    const scrolled = () => {
      if (writtenTop === box.scrollTop) return;
      // Layout can clamp scrollTop without a reading gesture. It cannot repin us.
      if (performance.now() > gestureUntil && (height !== box.scrollHeight || viewport !== box.clientHeight)) { schedule(); return; }
      writtenTop = null;
      cancelAnimationFrame(frame);
      position.current.pinned = box.scrollHeight - box.scrollTop - box.clientHeight <= SLACK_PX;
      remember();
      setAway(!position.current.pinned);
    };
    const reading = () => { gestureUntil = performance.now() + 200; cancelAnimationFrame(frame); };
    const pointer = (event: PointerEvent) => { if (event.target === box) reading(); };
    const wheel = (event: WheelEvent) => {
      reading();
      if (event.deltaY < 0) { position.current.pinned = false; remember(); setAway(true); }
    };
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable='true']")) return;
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) reading();
    };
    follow.current = schedule;
    restore();
    box.addEventListener("scroll", scrolled, { passive: true });
    box.addEventListener("wheel", wheel, { passive: true });
    box.addEventListener("touchmove", reading, { passive: true });
    box.addEventListener("pointerdown", pointer, { passive: true });
    box.addEventListener("keydown", key);
    const observer = new ResizeObserver(schedule);
    observer.observe(content);
    observer.observe(box);
    return () => {
      // Hidden views may already measure zero here; keep the last visible anchor.
      if (box.clientHeight > 0) remember();
      cancelAnimationFrame(frame);
      observer.disconnect();
      box.removeEventListener("scroll", scrolled);
      box.removeEventListener("wheel", wheel);
      box.removeEventListener("touchmove", reading);
      box.removeEventListener("pointerdown", pointer);
      box.removeEventListener("keydown", key);
      follow.current = () => {};
    };
  }, [active, ready, scope]);

  return { scrollRef, contentRef, away, jumpToLatest };
}

export function JumpToLatest({ onClick }: { onClick: () => void }) {
  return <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
    <button type="button" className="pointer-events-auto rounded-full border border-line bg-ink/95 px-3 py-1.5 text-[11px] text-mist shadow-sm hover:text-snow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/50" data-testid="conversation-jump-latest" onClick={onClick}>Jump to latest</button>
  </div>;
}
