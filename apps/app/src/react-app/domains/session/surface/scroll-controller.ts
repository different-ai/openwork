import { useCallback, useEffect, useRef, useState, type RefObject, type UIEventHandler } from "react";

const FOLLOW_LATEST_BOTTOM_GAP_PX = 96;
// Widened from 250ms so a single wheel or trackpad flick isn't missed between
// two rapid programmatic scroll-to-bottom frames during streaming.
const SCROLL_GESTURE_WINDOW_MS = 600;
// Threshold (px) that counts as a meaningful "scroll upward" gesture. Anything
// smaller is treated as anchoring jitter and ignored so we don't trip out of
// follow-latest for pixel-level content growth.
const MANUAL_BROWSE_UPWARD_THRESHOLD_PX = 16;

type SessionScrollMode = "follow-latest" | "manual-browse";

type SessionScrollControllerOptions = {
  selectedSessionId: string | null;
  renderedMessages: unknown;
  containerRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
};

export function useSessionScrollController(
  options: SessionScrollControllerOptions,
) {
  const [mode, setMode] = useState<SessionScrollMode>("follow-latest");
  const [topClippedMessageId, setTopClippedMessageId] = useState<string | null>(null);

  const lastKnownScrollTopRef = useRef(0);
  const programmaticScrollRef = useRef(false);
  const programmaticScrollResetRafARef = useRef<number | undefined>(undefined);
  const programmaticScrollResetRafBRef = useRef<number | undefined>(undefined);
  const observedContentHeightRef = useRef(0);
  const lastGestureAtRef = useRef(0);
  const previousSessionIdRef = useRef<string | null>(null);

  const isAtBottom = mode === "follow-latest";

  const hasScrollGesture = useCallback(
    () => Date.now() - lastGestureAtRef.current < SCROLL_GESTURE_WINDOW_MS,
    [],
  );

  const updateOverflowAnchor = useCallback(() => {
    const container = options.containerRef.current;
    if (!container) return;
    container.style.overflowAnchor = isAtBottom ? "none" : "auto";
  }, [isAtBottom, options.containerRef]);

  const markScrollGesture = useCallback(
    (target?: EventTarget | null) => {
      const container = options.containerRef.current;
      if (!container) return;

      const el = target instanceof Element ? target : undefined;
      const nested = el?.closest("[data-scrollable]");
      if (nested && nested !== container) return;

      lastGestureAtRef.current = Date.now();
    },
    [options.containerRef],
  );

  const clearProgrammaticScrollReset = useCallback(() => {
    if (programmaticScrollResetRafARef.current !== undefined) {
      window.cancelAnimationFrame(programmaticScrollResetRafARef.current);
      programmaticScrollResetRafARef.current = undefined;
    }
    if (programmaticScrollResetRafBRef.current !== undefined) {
      window.cancelAnimationFrame(programmaticScrollResetRafBRef.current);
      programmaticScrollResetRafBRef.current = undefined;
    }
  }, []);

  const releaseProgrammaticScrollSoon = useCallback(() => {
    clearProgrammaticScrollReset();
    programmaticScrollResetRafARef.current = window.requestAnimationFrame(() => {
      programmaticScrollResetRafARef.current = undefined;
      programmaticScrollResetRafBRef.current = window.requestAnimationFrame(() => {
        programmaticScrollResetRafBRef.current = undefined;
        programmaticScrollRef.current = false;
      });
    });
  }, [clearProgrammaticScrollReset]);

  const refreshTopClippedMessage = useCallback(() => {
    const container = options.containerRef.current;
    if (!container) {
      setTopClippedMessageId(null);
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const messageEls = container.querySelectorAll("[data-message-id]");
    const latestMessageEl = messageEls[messageEls.length - 1] as HTMLElement | undefined;
    const latestMessageId = latestMessageEl?.getAttribute("data-message-id")?.trim() ?? "";
    let nextId: string | null = null;

    for (const node of messageEls) {
      const el = node as HTMLElement;
      const rect = el.getBoundingClientRect();
      if (rect.bottom <= containerRect.top + 1) continue;
      if (rect.top >= containerRect.bottom - 1) break;

      if (rect.top < containerRect.top - 1) {
        const id = el.getAttribute("data-message-id")?.trim() ?? "";
        if (id) {
          const isLatestMessage = id === latestMessageId;
          const fillsViewportTail = rect.bottom >= containerRect.bottom - 1;
          if (isLatestMessage || fillsViewportTail) {
            nextId = id;
          }
        }
      }
      break;
    }

    setTopClippedMessageId(nextId);
  }, [options.containerRef]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const container = options.containerRef.current;
      if (!container) return;

      setMode("follow-latest");
      setTopClippedMessageId(null);
      programmaticScrollRef.current = true;

      if (behavior === "smooth") {
        container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
        releaseProgrammaticScrollSoon();
        return;
      }

      container.scrollTop = container.scrollHeight;
      window.requestAnimationFrame(() => {
        const next = options.containerRef.current;
        if (!next) {
          programmaticScrollRef.current = false;
          return;
        }
        next.scrollTop = next.scrollHeight;
        releaseProgrammaticScrollSoon();
      });
    },
    [options.containerRef, releaseProgrammaticScrollSoon],
  );

  const handleScroll = useCallback<UIEventHandler<HTMLDivElement>>(
    (event) => {
      const container = event.currentTarget;
      const currentTop = container.scrollTop;
      const previousTop = lastKnownScrollTopRef.current;
      const delta = currentTop - previousTop;
      const scrolledUp = delta <= -MANUAL_BROWSE_UPWARD_THRESHOLD_PX;
      const userGestured = hasScrollGesture();

      // If the user scrolls up meaningfully while a programmatic scroll is
      // in flight, abandon the programmatic state and switch to manual browse
      // immediately. Without this the ResizeObserver's auto-scroll during
      // streaming keeps re-anchoring us to the bottom and the user can never
      // actually get away from the tail of the transcript.
      if (programmaticScrollRef.current && (userGestured || scrolledUp)) {
        programmaticScrollRef.current = false;
        clearProgrammaticScrollReset();
        setMode("manual-browse");
        lastKnownScrollTopRef.current = currentTop;
        refreshTopClippedMessage();
        return;
      }

      if (programmaticScrollRef.current) {
        lastKnownScrollTopRef.current = currentTop;
        refreshTopClippedMessage();
        return;
      }

      // Even without a fresh gesture, a strong upward delta means the user
      // dragged a scrollbar or triggered a keyboard paging shortcut. Treat it
      // as a manual browse request.
      if (!userGestured && !scrolledUp) {
        lastKnownScrollTopRef.current = currentTop;
        refreshTopClippedMessage();
        return;
      }

      const bottomGap = container.scrollHeight - (currentTop + container.clientHeight);
      if (bottomGap <= FOLLOW_LATEST_BOTTOM_GAP_PX) {
        setMode("follow-latest");
      } else if (scrolledUp) {
        setMode("manual-browse");
      }
      lastKnownScrollTopRef.current = currentTop;
      refreshTopClippedMessage();
    },
    [clearProgrammaticScrollReset, hasScrollGesture, refreshTopClippedMessage],
  );

  const jumpToLatest = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      scrollToBottom(behavior);
    },
    [scrollToBottom],
  );

  const jumpToStartOfMessage = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const messageId = topClippedMessageId;
      const container = options.containerRef.current;
      if (!messageId || !container) return;

      const escapedId = messageId.replace(/"/g, '\\"');
      const target = container.querySelector(
        `[data-message-id="${escapedId}"]`,
      ) as HTMLElement | null;
      if (!target) return;

      setMode("manual-browse");
      target.scrollIntoView({ behavior, block: "start" });
    },
    [options.containerRef, topClippedMessageId],
  );

  useEffect(() => {
    updateOverflowAnchor();
  }, [updateOverflowAnchor]);

  useEffect(() => {
    const content = options.contentRef.current;
    if (!content) return;

    observedContentHeightRef.current = content.offsetHeight;
    const observer = new ResizeObserver(() => {
      const nextContent = options.contentRef.current;
      if (!nextContent) return;

      const nextHeight = nextContent.offsetHeight;
      const grew = nextHeight > observedContentHeightRef.current + 1;
      observedContentHeightRef.current = nextHeight;

      // Only re-anchor to the bottom when we're already in follow-latest mode
      // AND the user isn't actively scrolling. If they've touched the wheel,
      // touchpad, or scrollbar in the last SCROLL_GESTURE_WINDOW_MS, treat
      // that as intent to break out of autoscroll and leave their position
      // alone until the next handleScroll tick reclassifies the mode.
      if (grew && isAtBottom && !hasScrollGesture()) {
        scrollToBottom("auto");
        return;
      }

      refreshTopClippedMessage();
    });

    observer.observe(content);
    return () => observer.disconnect();
  }, [hasScrollGesture, isAtBottom, options.contentRef, refreshTopClippedMessage, scrollToBottom]);

  useEffect(() => {
    if (options.selectedSessionId === previousSessionIdRef.current) return;
    previousSessionIdRef.current = options.selectedSessionId;
    if (!options.selectedSessionId) return;

    setMode("follow-latest");
    setTopClippedMessageId(null);
    observedContentHeightRef.current = 0;
    queueMicrotask(() => scrollToBottom("auto"));
  }, [options.selectedSessionId, scrollToBottom]);

  useEffect(() => {
    void options.renderedMessages;
    queueMicrotask(refreshTopClippedMessage);
  }, [options.renderedMessages, refreshTopClippedMessage]);

  useEffect(() => {
    return () => {
      clearProgrammaticScrollReset();
    };
  }, [clearProgrammaticScrollReset]);

  return {
    isAtBottom,
    topClippedMessageId,
    handleScroll,
    markScrollGesture,
    scrollToBottom,
    jumpToLatest,
    jumpToStartOfMessage,
  };
}
