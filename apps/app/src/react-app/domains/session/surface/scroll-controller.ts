import { useCallback, useLayoutEffect, useRef, type RefObject, type UIEventHandler } from "react";

import { flushSessionScrollState, getSessionScrollState, sessionScrollKey, useSessionScrollStore, type SessionScrollAnchor } from "./scroll-store";

const EXACT_BOTTOM_GAP_PX = 1;
const SCROLL_GESTURE_WINDOW_MS = 600;
export const SESSION_SCROLL_NAVIGATION_EVENT = "session-scroll-navigation";

type SessionScrollControllerOptions = {
  selectedSessionId: string | null;
  geometryOwner?: string;
  submittedMessageId: string | null;
  historyReady: boolean;
  renderedMessages: unknown;
  containerRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
};

function isExactlyAtBottom(container: HTMLElement) {
  return container.scrollHeight - (container.scrollTop + container.clientHeight) <= EXACT_BOTTOM_GAP_PX;
}

function messageIdForElement(element: HTMLElement) {
  const id = element.getAttribute("data-message-id")?.trim();
  return id && id.length > 0 ? id : null;
}

function messageElementById(container: HTMLElement, messageId: string) {
  for (const element of container.querySelectorAll<HTMLElement>("[data-message-id]")) {
    if (messageIdForElement(element) === messageId) return element;
  }
  return null;
}

function readingAnchor(container: HTMLElement): SessionScrollAnchor | undefined {
  const viewport = container.getBoundingClientRect();
  for (const element of container.querySelectorAll<HTMLElement>("[data-message-id]")) {
    const rect = element.getBoundingClientRect();
    const messageId = messageIdForElement(element);
    if (messageId && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom) {
      return { messageId, offset: rect.top - viewport.top };
    }
  }
  return undefined;
}

function latestMessageTopClippedId(container: HTMLElement) {
  const messages = container.querySelectorAll<HTMLElement>("[data-message-id]");
  const latestMessage = messages.item(messages.length - 1);
  if (!latestMessage) return null;

  const containerRect = container.getBoundingClientRect();
  const latestRect = latestMessage.getBoundingClientRect();
  const lastMessageDoesNotFit = latestRect.height > containerRect.height + 1;
  const startVisible = latestRect.top >= containerRect.top - 1 && latestRect.top <= containerRect.bottom + 1;
  return lastMessageDoesNotFit && !startVisible ? messageIdForElement(latestMessage) : null;
}

type ScrollController = {
  sessionId: string | null;
  update: (historyReady: boolean, submittedMessageId: string | null) => void;
  handleScroll: UIEventHandler<HTMLDivElement>;
  markScrollGesture: (target?: EventTarget | null) => void;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  jumpToStartOfMessage: (behavior?: ScrollBehavior) => void;
};

export function useSessionScrollController(options: SessionScrollControllerOptions) {
  const { selectedSessionId, geometryOwner, containerRef, contentRef } = options;
  const scrollKey = selectedSessionId ? sessionScrollKey(selectedSessionId, geometryOwner) : null;
  const controllerRef = useRef<ScrollController | null>(null);
  // Consumed (including cancelled) submissions survive session effect recreation.
  const submittedMessagesRef = useRef(new Set<string>());

  // Every observer, frame and DOM reference belongs to this committed session.
  // Cleanup never saves from the DOM: React may already have replaced its history.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    const store = useSessionScrollStore.getState();
    if (selectedSessionId && geometryOwner) store.claimOwner(selectedSessionId, geometryOwner);
    const readState = () => getSessionScrollState(useSessionScrollStore.getState().sessions, scrollKey);
    let active = true;
    let historyReady = false;
    let pendingRestore = true;
    let pendingSubmittedMessageId: string | null = null;
    let cancelledWhileLoading = false;
    let smoothJump = false;
    let activePointerId: number | null = null;
    let pointerScrolled = false;
    let gestureBeforePointer = -Infinity;
    let lastGestureAt = -Infinity;
    let lastKnownScrollTop = container.scrollTop;
    const frames = new Set<number>();
    const hasScrollGesture = () => activePointerId !== null || Date.now() - lastGestureAt < SCROLL_GESTURE_WINDOW_MS;
    const scheduleFrame = (callback: () => void) => {
      const id = window.requestAnimationFrame(() => {
        if (!frames.delete(id) || !active) return;
        callback();
      });
      frames.add(id);
    };
    const cancelFrames = () => {
      for (const id of frames) window.cancelAnimationFrame(id);
      frames.clear();
    };
    const rememberGeometry = () => {
      if (!geometryOwner || !scrollKey || !historyReady || pendingRestore || cancelledWhileLoading
        || container.clientWidth <= 0 || container.clientHeight <= 0
        || !content.querySelector('[data-thread-history-complete="true"]')) return;
      const viewport = container.getBoundingClientRect();
      const messages = [...container.querySelectorAll<HTMLElement>("[data-message-id]")];
      const firstVisible = messages.findIndex((message) => {
        const rect = message.getBoundingClientRect();
        return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
      });
      if (firstVisible < 0) return;
      const nearby = messages.slice(Math.max(0, firstVisible - 4), firstVisible + 20);
      const first = nearby[0];
      const last = nearby.at(-1);
      if (!first || !last) return;
      store.setGeometry(scrollKey, {
        owner: geometryOwner,
        scrollHeight: container.scrollHeight,
        viewportWidth: container.clientWidth,
        before: Math.max(0, container.scrollTop + first.getBoundingClientRect().top - viewport.top),
        after: Math.max(0, container.scrollHeight - container.scrollTop - last.getBoundingClientRect().bottom + viewport.top),
        messageIds: nearby.flatMap((message) => { const id = messageIdForElement(message); return id ? [id] : []; }),
      });
    };
    const refreshTopClippedMessage = () => {
      if (active && historyReady) store.setTopClippedMessageId(scrollKey, latestMessageTopClippedId(container));
    };
    const scrollToBottom = (behavior: ScrollBehavior = "auto") => {
      if (!active) return;
      cancelFrames();
      pendingRestore = false;
      pendingSubmittedMessageId = null;
      cancelledWhileLoading = false;
      lastGestureAt = -Infinity;
      store.setStickyBottom(scrollKey, null);
      smoothJump = behavior === "smooth";
      container.scrollTo({ top: container.scrollHeight, behavior });
      lastKnownScrollTop = container.scrollTop;
      if (behavior === "auto") scheduleFrame(() => {
        container.scrollTop = container.scrollHeight;
        lastKnownScrollTop = container.scrollTop;
        refreshTopClippedMessage();
      });
    };
    const anchorTop = (anchor: SessionScrollAnchor) => {
      const message = messageElementById(container, anchor.messageId);
      return message ? container.scrollTop + message.getBoundingClientRect().top
        - container.getBoundingClientRect().top - anchor.offset : null;
    };
    const reconcile = () => {
      if (!active || container.clientHeight === 0) return;
      if (activePointerId !== null) {
        refreshTopClippedMessage();
        return;
      }
      if (pendingSubmittedMessageId) {
        const top = anchorTop({ messageId: pendingSubmittedMessageId, offset: 0 });
        if (top === null) return;
        // Sending is explicit navigation, even while history loads. Align an
        // oversized prompt's start; a short prompt clamps to the bottom.
        pendingSubmittedMessageId = null;
        pendingRestore = false;
        cancelledWhileLoading = false;
        cancelFrames();
        if (smoothJump) container.scrollTo({ top: container.scrollTop, behavior: "instant" });
        smoothJump = false;
        lastGestureAt = -Infinity;
        container.scrollTop = top;
        lastKnownScrollTop = container.scrollTop;
        const clipped = latestMessageTopClippedId(container);
        if (isExactlyAtBottom(container)) store.setStickyBottom(scrollKey, clipped);
        else store.setManualScroll(scrollKey, container.scrollTop, clipped, readingAnchor(container));
        return;
      }
      if (!historyReady) {
        // Reserve the last known extent while Suspense owns the transcript,
        // without overwriting the real reading position with a loading clamp.
        const saved = readState();
        if (pendingRestore && saved.geometry && saved.geometry.owner === geometryOwner && content.querySelector("[data-thread-loading]")) {
          container.scrollTop = saved.mode === "manual" ? saved.scrollTop : container.scrollHeight;
          lastKnownScrollTop = container.scrollTop;
        }
        return;
      }
      const saved = readState();
      if (pendingRestore) {
        if (saved.mode === "manual") {
          const top = saved.anchor ? anchorTop(saved.anchor) : null;
          // A live tail/partial preview is not proof the old anchor is gone.
          const partial = content.querySelector('[data-thread-history-complete="false"]');
          if (partial && (top === null || top < 0 || top > container.scrollHeight - container.clientHeight + EXACT_BOTTOM_GAP_PX)) return;
          pendingRestore = false;
          container.scrollTop = top ?? saved.scrollTop;
          lastKnownScrollTop = container.scrollTop;
        } else {
          scrollToBottom();
        }
      } else if (!cancelledWhileLoading) {
        if (saved.mode === "stickyBottom") {
          if (!hasScrollGesture() && !isExactlyAtBottom(container)) scrollToBottom();
        }
      }
      refreshTopClippedMessage();
      rememberGeometry();
    };
    const markScrollGesture = (target?: EventTarget | null) => {
      if (!active) return;
      const nested = target instanceof Element ? target.closest("[data-scrollable]") : null;
      if (nested && nested !== container) return;
      container.dispatchEvent(new Event(SESSION_SCROLL_NAVIGATION_EVENT));
      // Pointer presses may just be clicks. Defer cancelling restoration until
      // they actually scroll; release without scrolling resumes pending follow.
      if (activePointerId === null) {
        cancelledWhileLoading ||= pendingRestore;
        pendingRestore = false;
        pendingSubmittedMessageId = null;
      }
      cancelFrames();
      // Stop an in-flight smooth jump too, before the wheel/key moves the view.
      if (smoothJump) container.scrollTo({ top: container.scrollTop, behavior: "instant" });
      smoothJump = false;
      lastGestureAt = Date.now();
    };
    const handleScroll: UIEventHandler<HTMLDivElement> = () => {
      if (!active) return;
      // Layout clamping and our own anchoring also dispatch scroll events. Only
      // actual input may replace the saved reading position or change its mode.
      if (hasScrollGesture() && container.scrollTop !== lastKnownScrollTop) {
        // Trackpad momentum can outlast the original wheel/touch event.
        lastGestureAt = Date.now();
        if (activePointerId !== null) pointerScrolled = true;
        pendingRestore = false;
        pendingSubmittedMessageId = null;
        if (!historyReady) {
          cancelledWhileLoading = true;
          lastKnownScrollTop = container.scrollTop;
          return;
        }
        cancelledWhileLoading = false;
        const clipped = latestMessageTopClippedId(container);
        if (isExactlyAtBottom(container)) {
          store.setStickyBottom(scrollKey, clipped);
        } else {
          store.setManualScroll(scrollKey, container.scrollTop, clipped, readingAnchor(container));
        }
      } else {
        const saved = readState();
        if (!pendingRestore && historyReady && container.scrollTop !== lastKnownScrollTop) {
          // Native anchoring can move scrollTop when a diagram/image expands
          // inside the reading message. Remember that adjustment for the next
          // visit, but never persist the initial restore's clamp or missing anchor.
          if (saved.mode === "manual") {
            if (saved.anchor && messageElementById(container, saved.anchor.messageId)) {
              store.setManualScroll(scrollKey, container.scrollTop, latestMessageTopClippedId(container), readingAnchor(container));
            }
          } else if (!smoothJump && !isExactlyAtBottom(container)) {
            // Keyboard focus and other reveals scroll an older message into view
            // without wheel or key input. The person is reading it now: follow
            // must not pull the view back on the next click or streamed chunk.
            cancelFrames();
            store.setManualScroll(scrollKey, container.scrollTop, latestMessageTopClippedId(container), readingAnchor(container));
          }
        }
        refreshTopClippedMessage();
      }
      lastKnownScrollTop = container.scrollTop;
      rememberGeometry();
    };
    const jumpToStartOfMessage = (behavior: ScrollBehavior = "smooth") => {
      if (!active) return;
      const messageId = readState().topClippedMessageId;
      if (!messageId) return;
      const anchor = { messageId, offset: 0 };
      const top = anchorTop(anchor);
      if (top === null) return;
      cancelFrames();
      pendingRestore = false;
      pendingSubmittedMessageId = null;
      cancelledWhileLoading = false;
      lastGestureAt = -Infinity;
      store.setManualScroll(scrollKey, top, messageId, anchor);
      smoothJump = behavior === "smooth";
      container.scrollTo({ top, behavior });
      lastKnownScrollTop = container.scrollTop;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable=true]")) return;
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) markScrollGesture(event.target);
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0 || activePointerId !== null) return;
      const nested = event.target instanceof Element ? event.target.closest("[data-scrollable], input, textarea, select, [contenteditable=true]") : null;
      if (nested && nested !== container) return;
      activePointerId = event.pointerId;
      pointerScrolled = false;
      gestureBeforePointer = lastGestureAt;
      cancelFrames();
      if (smoothJump) container.scrollTo({ top: container.scrollTop, behavior: "instant" });
      smoothJump = false;
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (event.pointerId !== activePointerId) return;
      activePointerId = null;
      lastGestureAt = pointerScrolled ? Date.now() : gestureBeforePointer;
      if (!pointerScrolled) reconcile();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") flushSessionScrollState();
    };

    // The browser owns manual reflow, including changes inside a long message.
    // Message-root offsets are only used when restoring a session.
    const previousOverflowAnchor = container.style.overflowAnchor;
    const updateOverflowAnchor = () => {
      const next = readState().mode === "manual" ? "auto" : "none";
      if (container.style.overflowAnchor !== next) container.style.overflowAnchor = next;
    };
    updateOverflowAnchor();
    const unsubscribeScrollState = useSessionScrollStore.subscribe(updateOverflowAnchor);
    const observer = new ResizeObserver(reconcile);
    observer.observe(content);
    observer.observe(container);
    container.addEventListener("keydown", handleKeyDown);
    container.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    window.addEventListener("pagehide", flushSessionScrollState);
    document.addEventListener("visibilitychange", handleVisibility);
    controllerRef.current = {
      sessionId: scrollKey,
      update: (ready, messageId) => {
        historyReady = ready;
        if (!messageId) pendingSubmittedMessageId = null;
        else {
          const key = JSON.stringify([scrollKey, messageId]);
          if (!submittedMessagesRef.current.has(key)) {
            submittedMessagesRef.current.add(key);
            pendingSubmittedMessageId = messageId;
            cancelFrames();
          }
        }
        reconcile();
      },
      handleScroll,
      markScrollGesture,
      scrollToBottom,
      jumpToStartOfMessage,
    };

    return () => {
      active = false;
      cancelFrames();
      if (smoothJump) container.scrollTo({ top: container.scrollTop, behavior: "instant" });
      observer.disconnect();
      unsubscribeScrollState();
      container.removeEventListener("keydown", handleKeyDown);
      container.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      window.removeEventListener("pagehide", flushSessionScrollState);
      document.removeEventListener("visibilitychange", handleVisibility);
      container.style.overflowAnchor = previousOverflowAnchor;
      controllerRef.current = null;
      flushSessionScrollState();
    };
  }, [selectedSessionId, geometryOwner, scrollKey, containerRef, contentRef]);

  useLayoutEffect(() => {
    controllerRef.current?.update(options.historyReady, options.submittedMessageId);
  }, [scrollKey, containerRef, contentRef, options.historyReady, options.submittedMessageId, options.renderedMessages]);

  const handleScroll = useCallback<UIEventHandler<HTMLDivElement>>((event) => {
    if (controllerRef.current?.sessionId === scrollKey) controllerRef.current.handleScroll(event);
  }, [scrollKey]);
  const markScrollGesture = useCallback((target?: EventTarget | null) => {
    if (controllerRef.current?.sessionId === scrollKey) controllerRef.current.markScrollGesture(target);
  }, [scrollKey]);
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    if (controllerRef.current?.sessionId === scrollKey) {
      containerRef.current?.dispatchEvent(new Event(SESSION_SCROLL_NAVIGATION_EVENT));
      controllerRef.current.scrollToBottom(behavior);
    }
  }, [scrollKey, containerRef]);
  const jumpToLatest = useCallback((behavior: ScrollBehavior = "smooth") => scrollToBottom(behavior), [scrollToBottom]);
  const jumpToStartOfMessage = useCallback((behavior: ScrollBehavior = "smooth") => {
    if (controllerRef.current?.sessionId === scrollKey) {
      containerRef.current?.dispatchEvent(new Event(SESSION_SCROLL_NAVIGATION_EVENT));
      controllerRef.current.jumpToStartOfMessage(behavior);
    }
  }, [scrollKey, containerRef]);

  const refresh = useCallback(() => {
    if (controllerRef.current?.sessionId === scrollKey) {
      controllerRef.current.update(options.historyReady, options.submittedMessageId);
    }
  }, [scrollKey, options.historyReady, options.submittedMessageId]);

  return { handleScroll, markScrollGesture, scrollToBottom, jumpToLatest, jumpToStartOfMessage, refresh };
}
