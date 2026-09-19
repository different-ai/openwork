import { memo, useCallback, useLayoutEffect, useState, type RefObject } from "react";

import {
  selectSessionTopClippedMessageId,
  sessionScrollKey,
  useSessionScrollStore,
} from "./scroll-store";

type JumpToStartButtonProps = {
  onJumpToStartOfMessage: (behavior?: ScrollBehavior) => void;
};

const JumpToStartButton = memo(function JumpToStartButton({
  onJumpToStartOfMessage,
}: JumpToStartButtonProps) {
  const handleClick = useCallback(() => {
    onJumpToStartOfMessage("smooth");
  }, [onJumpToStartOfMessage]);

  return (
    <button
      type="button"
      className="rounded-full px-3 py-1.5 text-xs text-dls-text transition-colors hover:bg-dls-hover"
      onClick={handleClick}
    >
      Jump to start
    </button>
  );
});

type JumpToLatestButtonProps = {
  onJumpToLatest: (behavior?: ScrollBehavior) => void;
};

const JumpToLatestButton = memo(function JumpToLatestButton({
  onJumpToLatest,
}: JumpToLatestButtonProps) {
  const handleClick = useCallback(() => {
    onJumpToLatest("smooth");
  }, [onJumpToLatest]);

  return (
    <button
      type="button"
      className="rounded-full px-3 py-1.5 text-xs text-dls-text transition-colors hover:bg-dls-hover"
      onClick={handleClick}
    >
      Jump to latest
    </button>
  );
});

type SessionScrollOverlayProps = {
  sessionId: string;
  owner?: string;
  isStreaming: boolean;
  historyReady: boolean;
  hasNewer: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  onJumpToLatest: (behavior?: ScrollBehavior) => void;
  onJumpToStartOfMessage: (behavior?: ScrollBehavior) => void;
};

export const SessionScrollOverlay = memo(function SessionScrollOverlay({
  sessionId,
  owner,
  isStreaming,
  historyReady,
  hasNewer,
  containerRef,
  contentRef,
  onJumpToLatest,
  onJumpToStartOfMessage,
}: SessionScrollOverlayProps) {
  const topClippedMessageId = useSessionScrollStore((state) =>
    selectSessionTopClippedMessageId(state.sessions, sessionScrollKey(sessionId, owner)));
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content || !historyReady) {
      setShowJumpToLatest(false);
      return;
    }
    // Follow mode is reading intent, not geometry: restoration or native reflow
    // can leave a manual reader at the bottom without enabling auto-follow.
    const measure = () => setShowJumpToLatest(container.clientHeight > 0 && container.clientWidth > 0
      && (hasNewer || container.scrollHeight - container.scrollTop - container.clientHeight > 1));
    measure();
    // Also measure after the parent's initial restoration layout effect.
    const frame = window.requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(content);
    container.addEventListener("scroll", measure);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      container.removeEventListener("scroll", measure);
    };
  }, [sessionId, owner, historyReady, hasNewer, containerRef, contentRef]);

  const showJumpToStart = !isStreaming && Boolean(topClippedMessageId);

  if (!showJumpToStart && !showJumpToLatest) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute bottom-2 left-1/2 z-30 flex -translate-x-1/2 justify-center">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-dls-border bg-dls-surface/95 p-1 shadow-(--dls-card-shadow) backdrop-blur-md">
        {showJumpToStart ? (
          <JumpToStartButton onJumpToStartOfMessage={onJumpToStartOfMessage} />
        ) : null}
        {showJumpToLatest ? (
          <JumpToLatestButton onJumpToLatest={onJumpToLatest} />
        ) : null}
      </div>
    </div>
  );
});
