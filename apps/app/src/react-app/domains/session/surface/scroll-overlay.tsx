import { memo, useCallback } from "react";
import { ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { isDesktopRuntime } from "@/app/lib/runtime-env";

import {
  selectSessionIsStickyBottom,
  selectSessionTopClippedMessageId,
  sessionScrollKey,
  useSessionScrollStore,
} from "./scroll-store";

function useSessionScrollOverlayState(sessionId: string) {
  const isAtBottom = useSessionScrollStore((state) => selectSessionIsStickyBottom(state.sessions, sessionId));
  const topClippedMessageId = useSessionScrollStore((state) => selectSessionTopClippedMessageId(state.sessions, sessionId));

  return { isAtBottom, topClippedMessageId };
}

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
  mobileTurnFullyVisible?: boolean;
  onJumpToLatest: (behavior?: ScrollBehavior) => void;
  onJumpToStartOfMessage: (behavior?: ScrollBehavior) => void;
};

export const SessionScrollOverlay = memo(function SessionScrollOverlay({
  sessionId,
  owner,
  isStreaming,
  mobileTurnFullyVisible = false,
  onJumpToLatest,
  onJumpToStartOfMessage,
}: SessionScrollOverlayProps) {
  const { isAtBottom, topClippedMessageId } = useSessionScrollOverlayState(sessionScrollKey(sessionId, owner));
  const isMobile = useIsMobile();
  if (isMobile && !isDesktopRuntime()) {
    if (isAtBottom || mobileTurnFullyVisible) return null;
    return (
      <div className="pointer-events-none absolute bottom-2 left-1/2 z-30 -translate-x-1/2">
        <Button
          variant="outline"
          size="icon"
          className="pointer-events-auto size-11 rounded-full shadow-(--dls-card-shadow) motion-reduce:transition-none"
          onClick={() => onJumpToLatest(window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth")}
        >
          <ArrowDown aria-hidden strokeWidth={1.5} />
          <span className="sr-only">Jump to latest</span>
        </Button>
      </div>
    );
  }
  const showJumpToStart = !isStreaming && Boolean(topClippedMessageId);
  const showJumpToLatest = !isAtBottom && !mobileTurnFullyVisible;

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
