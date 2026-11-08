import { useLayoutEffect, useRef, useState } from "react";

/** Page-lifetime only: a fresh app open follows the newest message, not yesterday's scroll offset. */
export type ConversationScrollState = {
  following: boolean;
  top: number;
  anchor: { key: string; offset: number } | null;
  turnWindow: number;
  sent: Set<string>;
};

export function createConversationScrollState(turnWindow: number): ConversationScrollState {
  return { following: true, top: 0, anchor: null, turnWindow, sent: new Set() };
}

/**
 * Scroll events are not evidence of a person scrolling. Replacing a cached page, adding earlier rows, hiding a
 * tab or resizing the keyboard can all dispatch them, before ResizeObserver gets to follow the new bottom.
 * Remember intent separately; reconcile layout before interpreting a scroll against the *new* dimensions.
 */
export function observeConversationScroll(node: HTMLDivElement, content: HTMLDivElement, state: ConversationScrollState, changed: (far: boolean) => void) {
  let visible = false;
  let height = 0;
  let viewport = 0;
  let width = 0;
  let expectedTop = node.scrollTop;
  let smooth = false;
  let touchY: number | undefined;
  const distance = () => Math.max(0, node.scrollHeight - node.clientHeight - node.scrollTop);
  const shown = () => node.clientHeight > 0 && node.getClientRects().length > 0;
  const rows = () => content.querySelectorAll<HTMLElement>("[data-workbot-row]");
  const remember = () => {
    state.top = node.scrollTop;
    if (state.following) { state.anchor = null; return; }
    const top = node.getBoundingClientRect().top;
    const row = [...rows()].find(row => row.getBoundingClientRect().bottom > top + 28);
    if (row?.dataset.workbotRow) state.anchor = { key: row.dataset.workbotRow, offset: row.getBoundingClientRect().top - top };
  };
  const measure = () => {
    height = node.scrollHeight;
    viewport = node.clientHeight;
    width = node.clientWidth;
    expectedTop = node.scrollTop;
    changed(distance() > node.clientHeight);
  };
  const layoutChanged = () => height !== node.scrollHeight || viewport !== node.clientHeight || width !== node.clientWidth;
  const layout = () => {
    // Hidden copies of the conversation (Home / dock / popover) must never overwrite the visible copy's place.
    if (!shown()) { visible = false; return; }
    const revealing = !visible;
    visible = true;
    if (state.following) {
      if (!smooth || layoutChanged()) node.scrollTo({ top: node.scrollHeight, behavior: smooth ? "smooth" : "instant" });
    } else if (state.anchor) {
      const row = [...rows()].find(row => row.dataset.workbotRow === state.anchor?.key);
      if (row) node.scrollTop += row.getBoundingClientRect().top - node.getBoundingClientRect().top - state.anchor.offset;
      // Keep the anchor while an older page is still being fetched; do not replace it with a cached newest row.
      else if (revealing) node.scrollTop = state.top;
    } else if (revealing) node.scrollTop = state.top;
    measure();
  };
  const scroll = () => {
    if (!shown()) { visible = false; return; }
    if (!visible || layoutChanged()) { layout(); return; }
    if (smooth) {
      if (distance() <= 1) { smooth = false; remember(); }
    } else if (Math.abs(node.scrollTop - expectedTop) > 1) {
      state.following = distance() < 80;
      remember();
    }
    measure();
  };
  const interrupt = () => {
    // Cancel an in-flight smooth jump if the person takes over.
    if (smooth) node.scrollTo({ top: node.scrollTop, behavior: "instant" });
    smooth = false;
    state.following = false;
    remember();
  };
  const wheel = (event: WheelEvent) => { if (event.deltaY < 0 || smooth) interrupt(); };
  const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY; };
  const touchMove = (event: TouchEvent) => {
    const y = event.touches[0]?.clientY;
    if (y !== undefined && touchY !== undefined && (y > touchY || smooth)) interrupt();
    touchY = y;
  };
  const key = (event: KeyboardEvent) => {
    if (["ArrowUp", "PageUp", "Home"].includes(event.key) || event.key === " " && event.shiftKey) interrupt();
  };
  node.addEventListener("scroll", scroll, { passive: true });
  node.addEventListener("wheel", wheel, { passive: true });
  node.addEventListener("touchstart", touchStart, { passive: true });
  node.addEventListener("touchmove", touchMove, { passive: true });
  node.addEventListener("keydown", key);
  const observer = new ResizeObserver(layout);
  observer.observe(content);
  // Content alone does not resize when the keyboard opens or the composer grows.
  observer.observe(node);
  layout();
  return {
    layout,
    readEarlier() { interrupt(); },
    latest(animate = false) {
      state.following = true;
      state.anchor = null;
      smooth = animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      node.scrollTo({ top: node.scrollHeight, behavior: smooth ? "smooth" : "instant" });
      measure();
    },
    dispose() {
      observer.disconnect();
      node.removeEventListener("scroll", scroll);
      node.removeEventListener("wheel", wheel);
      node.removeEventListener("touchstart", touchStart);
      node.removeEventListener("touchmove", touchMove);
      node.removeEventListener("keydown", key);
    },
  };
}

export function useConversationScroll(state: ConversationScrollState, pending: ReadonlyArray<{ id: string }>) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const controller = useRef<ReturnType<typeof observeConversationScroll>>(undefined);
  const [far, setFar] = useState(false);
  useLayoutEffect(() => {
    if (!scroller.current || !content.current) return;
    const owner = observeConversationScroll(scroller.current, content.current, state, setFar);
    controller.current = owner;
    return () => { owner.dispose(); controller.current = undefined; };
  }, [state]);
  useLayoutEffect(() => {
    const sending = pending.some(entry => !state.sent.has(entry.id));
    for (const entry of pending) state.sent.add(entry.id);
    if (sending) controller.current?.latest();
    controller.current?.layout();
  });
  return { scroller, content, far, latest: () => controller.current?.latest(true), readEarlier: () => controller.current?.readEarlier() };
}
