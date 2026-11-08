import { useLayoutEffect, useRef, useState } from "react";

/** Page-lifetime only: a fresh app open follows the newest message, not yesterday's scroll offset. */
export type ConversationScrollState = {
  following: boolean;
  top: number;
  anchor: { key: string; offset: number } | null;
  turnWindow: number;
  sent: Set<string>;
};

/** How long after a touch, wheel or key a scroll still counts as the person's. */
const GESTURE_MS = 600;

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
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let touchY: number | undefined;
  // When the person last touched, wheeled, pressed or keyed in the conversation, and whether a press is held (a
  // scrollbar drag): scrolls outside those are the page's own layout, never the person leaving the newest message.
  let gestureAt = 0;
  let pressed = false;
  const gesture = () => { gestureAt = Date.now(); };
  const byPerson = () => pressed || Date.now() - gestureAt < GESTURE_MS;
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
  const settle = () => {
    clearTimeout(settleTimer);
    if (!smooth || !shown()) return;
    smooth = false;
    state.following = distance() < 80;
    remember();
    measure();
  };
  const settling = () => { clearTimeout(settleTimer); settleTimer = setTimeout(settle, 200); };
  const scroll = () => {
    if (!shown()) { visible = false; return; }
    if (!visible || layoutChanged()) { layout(); return; }
    if (smooth) {
      if (distance() <= 1) settle();
      else settling();
    } else if (Math.abs(node.scrollTop - expectedTop) > 1) {
      // A box beside the conversation that briefly grew it (the message box resizing as the person types) leaves the
      // browser's clamped scrollTop behind: still at the newest message, so stay exactly at the bottom.
      if (state.following && !byPerson() && distance() < 80) node.scrollTo({ top: node.scrollHeight, behavior: "instant" });
      else {
        state.following = distance() < 80;
        remember();
      }
    }
    measure();
  };
  const interrupt = (force = false) => {
    // An upward gesture at scrollTop=0 cannot leave the bottom of a short conversation.
    if (!force && !smooth && node.scrollTop <= 0) return;
    if (smooth) node.scrollTo({ top: node.scrollTop, behavior: "instant" });
    clearTimeout(settleTimer);
    smooth = false;
    state.following = false;
    remember();
  };
  const wheel = (event: WheelEvent) => { gesture(); if (event.deltaY < 0 || smooth) interrupt(); };
  const touchStart = (event: TouchEvent) => { gesture(); touchY = event.touches[0]?.clientY; };
  const touchMove = (event: TouchEvent) => {
    gesture();
    const y = event.touches[0]?.clientY;
    if (y !== undefined && touchY !== undefined && (y > touchY || smooth)) interrupt();
    touchY = y;
  };
  const key = (event: KeyboardEvent) => {
    gesture();
    const navigation = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key);
    if (smooth && navigation || ["ArrowUp", "PageUp", "Home"].includes(event.key) || event.key === " " && event.shiftKey) interrupt();
  };
  const pointer = () => { gesture(); pressed = true; if (smooth) interrupt(); };
  const released = () => { if (pressed) gesture(); pressed = false; };
  node.addEventListener("pointerdown", pointer, { passive: true });
  node.addEventListener("scrollend", settle);
  node.addEventListener("scroll", scroll, { passive: true });
  node.addEventListener("wheel", wheel, { passive: true });
  node.addEventListener("touchstart", touchStart, { passive: true });
  node.addEventListener("touchmove", touchMove, { passive: true });
  node.addEventListener("keydown", key);
  // The press can end outside the conversation (a scrollbar drag released over the composer).
  const view: Pick<Window, "addEventListener" | "removeEventListener"> | undefined = typeof window.addEventListener === "function" ? window : undefined;
  view?.addEventListener("pointerup", released, { passive: true });
  view?.addEventListener("pointercancel", released, { passive: true });
  const observer = new ResizeObserver(layout);
  observer.observe(content);
  // Content alone does not resize when the keyboard opens or the composer grows.
  observer.observe(node);
  layout();
  return {
    layout,
    readEarlier() { interrupt(true); },
    latest(animate = false) {
      state.following = true;
      state.anchor = null;
      smooth = animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      node.scrollTo({ top: node.scrollHeight, behavior: smooth ? "smooth" : "instant" });
      if (smooth) settling();
      measure();
    },
    dispose() {
      clearTimeout(settleTimer);
      observer.disconnect();
      node.removeEventListener("pointerdown", pointer);
      node.removeEventListener("scrollend", settle);
      node.removeEventListener("scroll", scroll);
      node.removeEventListener("wheel", wheel);
      node.removeEventListener("touchstart", touchStart);
      node.removeEventListener("touchmove", touchMove);
      node.removeEventListener("keydown", key);
      view?.removeEventListener("pointerup", released);
      view?.removeEventListener("pointercancel", released);
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
