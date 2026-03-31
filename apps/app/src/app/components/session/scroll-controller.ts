import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  type Accessor,
  type JSX,
} from "solid-js";

const FOLLOW_LATEST_BOTTOM_GAP_PX = 96;
const SCROLL_GESTURE_WINDOW_MS = 250;

type SessionScrollMode = "follow-latest" | "manual-browse";

type SessionScrollControllerOptions = {
  selectedSessionId: Accessor<string | null>;
  renderedMessages: Accessor<unknown>;
  containerRef: Accessor<HTMLDivElement | undefined>;
  contentRef: Accessor<HTMLDivElement | undefined>;
};

export function createSessionScrollController(
  options: SessionScrollControllerOptions,
) {
  const [mode, setMode] = createSignal<SessionScrollMode>("follow-latest");
  const [topClippedMessageId, setTopClippedMessageId] = createSignal<string | null>(null);
  const isAtBottom = createMemo(() => mode() === "follow-latest");

  let lastKnownScrollTop = 0;
  let programmaticScroll = false;
  let programmaticScrollResetRafA: number | undefined;
  let programmaticScrollResetRafB: number | undefined;
  let observedContentHeight = 0;
  let lastGestureAt = 0;

  const hasScrollGesture = () => Date.now() - lastGestureAt < SCROLL_GESTURE_WINDOW_MS;

  const updateOverflowAnchor = () => {
    const container = options.containerRef();
    if (!container) return;
    container.style.overflowAnchor = mode() === "follow-latest" ? "none" : "auto";
  };

  const markScrollGesture = (target?: EventTarget | null) => {
    const container = options.containerRef();
    if (!container) return;

    const el = target instanceof Element ? target : undefined;
    const nested = el?.closest("[data-scrollable]");
    if (nested && nested !== container) return;

    lastGestureAt = Date.now();
  };

  const clearProgrammaticScrollReset = () => {
    if (programmaticScrollResetRafA !== undefined) {
      window.cancelAnimationFrame(programmaticScrollResetRafA);
      programmaticScrollResetRafA = undefined;
    }
    if (programmaticScrollResetRafB !== undefined) {
      window.cancelAnimationFrame(programmaticScrollResetRafB);
      programmaticScrollResetRafB = undefined;
    }
  };

  const releaseProgrammaticScrollSoon = () => {
    clearProgrammaticScrollReset();
    programmaticScrollResetRafA = window.requestAnimationFrame(() => {
      programmaticScrollResetRafA = undefined;
      programmaticScrollResetRafB = window.requestAnimationFrame(() => {
        programmaticScrollResetRafB = undefined;
        programmaticScroll = false;
      });
    });
  };

  const scrollToBottom = (behavior: ScrollBehavior = "auto") => {
    const container = options.containerRef();
    if (!container) return;

    setMode("follow-latest");
    setTopClippedMessageId(null);
    programmaticScroll = true;

    if (behavior === "smooth") {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      releaseProgrammaticScrollSoon();
      return;
    }

    container.scrollTop = container.scrollHeight;
    window.requestAnimationFrame(() => {
      const next = options.containerRef();
      if (!next) {
        programmaticScroll = false;
        return;
      }
      next.scrollTop = next.scrollHeight;
      releaseProgrammaticScrollSoon();
    });
  };

  const refreshTopClippedMessage = () => {
    const container = options.containerRef();
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
  };

  const handleScroll: JSX.EventHandlerUnion<HTMLDivElement, Event> = (event) => {
    const container = event.currentTarget as HTMLDivElement;
    if (programmaticScroll) {
      lastKnownScrollTop = container.scrollTop;
      refreshTopClippedMessage();
      return;
    }

    if (!hasScrollGesture()) {
      lastKnownScrollTop = container.scrollTop;
      refreshTopClippedMessage();
      return;
    }

    const bottomGap =
      container.scrollHeight - (container.scrollTop + container.clientHeight);
    if (bottomGap <= FOLLOW_LATEST_BOTTOM_GAP_PX) {
      setMode("follow-latest");
    } else if (container.scrollTop < lastKnownScrollTop - 1) {
      setMode("manual-browse");
    }
    lastKnownScrollTop = container.scrollTop;
    refreshTopClippedMessage();
  };

  const jumpToLatest = (behavior: ScrollBehavior = "smooth") => {
    scrollToBottom(behavior);
  };

  const jumpToStartOfMessage = (behavior: ScrollBehavior = "smooth") => {
    const messageId = topClippedMessageId();
    const container = options.containerRef();
    if (!messageId || !container) return;

    const escapedId = messageId.replace(/"/g, '\\"');
    const target = container.querySelector(
      `[data-message-id="${escapedId}"]`,
    ) as HTMLElement | null;
    if (!target) return;

    setMode("manual-browse");
    target.scrollIntoView({ behavior, block: "start" });
  };

  createEffect(() => {
    mode();
    updateOverflowAnchor();
  });

  createEffect(() => {
    const content = options.contentRef();
    if (!content) return;

    observedContentHeight = content.offsetHeight;
    const observer = new ResizeObserver(() => {
      const nextContent = options.contentRef();
      if (!nextContent) return;

      const nextHeight = nextContent.offsetHeight;
      const grew = nextHeight > observedContentHeight + 1;
      observedContentHeight = nextHeight;

      if (grew && isAtBottom()) {
        scrollToBottom("auto");
        return;
      }

      refreshTopClippedMessage();
    });

    observer.observe(content);
    onCleanup(() => observer.disconnect());
  });

  createEffect(
    on(
      options.selectedSessionId,
      (sessionId, previousSessionId) => {
        if (sessionId === previousSessionId) return;
        if (!sessionId) return;

        setMode("follow-latest");
        setTopClippedMessageId(null);
        observedContentHeight = 0;
        queueMicrotask(() => scrollToBottom("auto"));
      },
    ),
  );

  createEffect(() => {
    options.renderedMessages();
    queueMicrotask(refreshTopClippedMessage);
  });

  onCleanup(() => {
    clearProgrammaticScrollReset();
  });

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
