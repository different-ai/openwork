import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useSessionActivityStore } from "../status/session-activity-store";

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
    onJumpToStartOfMessage(window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth");
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
  newOutput: boolean;
};

const JumpToLatestButton = memo(function JumpToLatestButton({
  onJumpToLatest,
  newOutput,
}: JumpToLatestButtonProps) {
  const handleClick = useCallback(() => {
    onJumpToLatest(window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth");
  }, [onJumpToLatest]);

  return (
    <button
      type="button"
      className="rounded-full px-3 py-1.5 text-xs text-dls-text transition-colors hover:bg-dls-hover"
      onClick={handleClick}
    >
      Jump to latest
      {newOutput ? <span className="ml-1.5 rounded-full bg-dls-hover px-1.5 py-0.5" role="status">New output</span> : null}
    </button>
  );
});

type SessionScrollOverlayProps = {
  workspaceId: string;
  sessionId: string;
  owner?: string;
  isStreaming: boolean;
  onJumpToLatest: (behavior?: ScrollBehavior) => void;
  onJumpToStartOfMessage: (behavior?: ScrollBehavior) => void;
};

export const SessionScrollOverlay = memo(function SessionScrollOverlay({
  workspaceId,
  sessionId,
  owner,
  isStreaming,
  onJumpToLatest,
  onJumpToStartOfMessage,
}: SessionScrollOverlayProps) {
  const { isAtBottom, topClippedMessageId } = useSessionScrollOverlayState(sessionScrollKey(sessionId, owner));
  const progressAt = useSessionActivityStore((state) => state.recordsByWorkspaceId[workspaceId]?.[sessionId]?.lastProgressAt ?? 0);
  const key = JSON.stringify([workspaceId, owner, sessionId]);
  const previous = useRef({ key, progressAt, isAtBottom, isStreaming });
  const [unseenOwner, setUnseenOwner] = useState<string | null>(null);
  useEffect(() => {
    const last = previous.current;
    if (last.key !== key || isAtBottom) {
      setUnseenOwner(null);
    } else if (!last.isAtBottom && (isStreaming || last.isStreaming) && progressAt > last.progressAt) {
      // Observe validated transcript progress, not render/mutation counts or
      // animation ticks. This affordance never changes the reader's position.
      setUnseenOwner(key);
    }
    previous.current = { key, progressAt, isAtBottom, isStreaming };
  }, [key, progressAt, isAtBottom, isStreaming]);
  const showJumpToStart = !isStreaming && Boolean(topClippedMessageId);
  const showJumpToLatest = !isAtBottom;

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
          <JumpToLatestButton onJumpToLatest={onJumpToLatest} newOutput={unseenOwner === key} />
        ) : null}
      </div>
    </div>
  );
});
