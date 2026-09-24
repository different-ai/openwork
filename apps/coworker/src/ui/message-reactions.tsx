import { memo, useEffect, useMemo, useRef, useState } from "react";
import { coworkerBridge, type MessageReaction, type MessageReactionScope, type MessageReactionSnapshot } from "@/lib/bridge";
import { Tooltip } from "@/ui/kit";

type ReactionRead = { again?: () => void };
type ReactionObservation = { revision: number; wantedRevision: number; snapshot: MessageReactionSnapshot | null; pending: ReactionRead | null };

function reactionScopeKey(scope: MessageReactionScope | null): string {
  if (!scope) return "";
  return JSON.stringify(scope.kind === "private" ? [scope.kind, scope.slug, scope.threadId] : [scope.kind, scope.groupId]);
}

export function useMessageReactions(scope: MessageReactionScope | null, active: boolean, identity: string | number): ReadonlyMap<string, readonly MessageReaction[]> {
  const scopeKey = reactionScopeKey(scope);
  const key = JSON.stringify([scopeKey, identity]);
  const current = useRef({ scope, key, active });
  current.current = { scope, key, active };
  const observations = useRef(new Map<string, ReactionObservation>());
  const [observed, setObserved] = useState<{ key: string; snapshot: MessageReactionSnapshot } | null>(null);

  useEffect(() => {
    const target = current.current.scope;
    if (!active || !target) return;
    const observation: ReactionObservation = observations.current.get(key) ?? { revision: -1, wantedRevision: -1, snapshot: null, pending: null };
    observations.current.set(key, observation);
    if (observations.current.size > 8) {
      const oldest = observations.current.keys().next().value;
      if (oldest !== undefined && oldest !== key) observations.current.delete(oldest);
    }
    if (observation.snapshot) {
      const snapshot = observation.snapshot;
      setObserved((previous) => previous?.key === key && previous.snapshot === snapshot ? previous : { key, snapshot });
    }
    let disposed = false;
    let generation = 0;
    let unsubscribe: (() => void) | null = null;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const clearRetry = () => { if (retryTimer) clearTimeout(retryTimer); retryTimer = null; };
    const isCurrent = () => !disposed && current.current.active && current.current.key === key && !document.hidden;
    const refresh = () => {
      if (!isCurrent()) return;
      clearRetry();
      if (observation.pending) {
        observation.pending.again = refresh;
        return;
      }
      const request: ReactionRead = {};
      const startedGeneration = generation;
      observation.pending = request;
      void coworkerBridge.reactions.read(target).then((snapshot) => {
        if (!isCurrent() || generation !== startedGeneration || snapshot.revision < observation.wantedRevision || snapshot.revision < observation.revision) return;
        observation.revision = snapshot.revision;
        retries = 0;
        if (observation.snapshot && observation.snapshot.revision >= snapshot.revision) return;
        observation.snapshot = snapshot;
        setObserved({ key, snapshot });
      }).catch(() => {
        // A notification is not an observed snapshot. Keep the old chips and
        // retry this read twice; no timer survives hiding/leaving the chat.
        if (isCurrent() && generation === startedGeneration && ++retries <= 2) retryTimer = setTimeout(refresh, retries * 250);
      }).finally(() => {
        observation.pending = null;
        request.again?.();
      });
    };
    const observe = () => {
      if (document.hidden) {
        clearRetry();
        generation += 1;
        unsubscribe?.();
        unsubscribe = null;
        return;
      }
      if (!unsubscribe) {
        unsubscribe = coworkerBridge.reactions.onChanged((change) => {
          if (!isCurrent() || reactionScopeKey(change.scope) !== scopeKey || change.revision <= observation.revision) return;
          observation.wantedRevision = Math.max(observation.wantedRevision, change.revision);
          retries = 0;
          refresh();
        });
      }
      retries = 0;
      refresh();
    };
    window.addEventListener("focus", observe);
    document.addEventListener("visibilitychange", observe);
    observe();
    return () => {
      disposed = true;
      clearRetry();
      unsubscribe?.();
      window.removeEventListener("focus", observe);
      document.removeEventListener("visibilitychange", observe);
    };
  }, [active, key, scopeKey]);

  return useMemo(() => {
    const byMessage = new Map<string, MessageReaction[]>();
    if (observed?.key !== key) return byMessage;
    for (const reaction of observed.snapshot.reactions) {
      const reactions = byMessage.get(reaction.messageId);
      if (reactions) reactions.push(reaction);
      else byMessage.set(reaction.messageId, [reaction]);
    }
    return byMessage;
  }, [key, observed]);
}

export const MessageReactions = memo(function MessageReactions({ messageId, reactions, side, className = "" }: {
  messageId: string;
  reactions?: readonly MessageReaction[];
  /** The corner toward the middle of the conversation: left on the person's bubbles, right on replies. */
  side: "left" | "right";
  className?: string;
}) {
  if (!reactions?.length) return null;
  return (
    // A tapback: it sits on the bubble's top corner facing the conversation, ringed
    // in the page color so it reads as resting on top. The parent is the bubble's positioned wrapper.
    <div className={`absolute -top-4 z-10 flex -space-x-1.5 ${side === "left" ? "-left-2.5" : "-right-2.5"} ${className}`} role="group" aria-label="Message reactions" data-testid="message-reactions" data-message-id={messageId}>
      {reactions.map((reaction) => {
        const label = `${reaction.actor.name} reacted ${reaction.emoji}`;
        return (
          <Tooltip key={`${reaction.actor.slug}:${reaction.actor.createdAt}`} content={label}>
            <span
              role="img"
              tabIndex={0}
              aria-label={label}
              data-testid="message-reaction"
              data-actor-slug={reaction.actor.slug}
              data-actor-created-at={reaction.actor.createdAt}
              data-emoji={reaction.emoji}
              className="inline-flex size-7 cursor-default select-none items-center justify-center rounded-full bg-panel-2 text-[15px] leading-none text-snow shadow-[0_0_0_2.5px_var(--color-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/50"
            >
              {reaction.emoji}
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
});
