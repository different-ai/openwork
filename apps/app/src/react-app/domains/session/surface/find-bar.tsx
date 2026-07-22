import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useSessionFindStore } from "./find-store";
import { SEARCH_HIGHLIGHT_SELECTOR } from "./text-highlights";

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 150;
const MUTATION_DEBOUNCE_MS = 100;
const COLLECT_AFTER_RENDER_MS = 50;
const TARGET_RESOLVE_TIMEOUT_MS = 2_500;
const SEARCH_HIGHLIGHT_ACTIVE_ATTR = "data-search-highlight-active";
const SEARCH_HIGHLIGHT_BASE_BG_CLASS = "bg-amber-4/70";
const SEARCH_HIGHLIGHT_ACTIVE_CLASSES = ["bg-amber-7", "ring-1", "ring-amber-9"];

type SessionFindBarProps = {
  sessionId: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  onBeforeJump?: () => void;
};

type CollectReason = "query" | "mutation";

function collectHighlightMarks(container: HTMLDivElement): HTMLElement[] {
  const marks: HTMLElement[] = [];
  container.querySelectorAll(SEARCH_HIGHLIGHT_SELECTOR).forEach((element) => {
    if (element instanceof HTMLElement) {
      marks.push(element);
    }
  });
  return marks;
}

function setHighlightActive(element: HTMLElement, active: boolean) {
  if (active) {
    element.setAttribute(SEARCH_HIGHLIGHT_ACTIVE_ATTR, "true");
    element.classList.remove(SEARCH_HIGHLIGHT_BASE_BG_CLASS);
    element.classList.add(...SEARCH_HIGHLIGHT_ACTIVE_CLASSES);
    return;
  }

  element.removeAttribute(SEARCH_HIGHLIGHT_ACTIVE_ATTR);
  element.classList.remove(...SEARCH_HIGHLIGHT_ACTIVE_CLASSES);
  element.classList.add(SEARCH_HIGHLIGHT_BASE_BG_CLASS);
}

function setActiveHighlight(ref: { current: HTMLElement | null }, next: HTMLElement | null) {
  const previous = ref.current;
  if (previous && previous !== next) {
    setHighlightActive(previous, false);
  }
  if (next) {
    setHighlightActive(next, true);
  }
  ref.current = next;
}

function retainedMatchIndex(matches: HTMLElement[], previousActive: HTMLElement | null, fallbackIndex: number) {
  if (matches.length === 0) return 0;
  const previousIndex = previousActive ? matches.indexOf(previousActive) : -1;
  if (previousIndex >= 0) return previousIndex;
  return Math.min(Math.max(0, fallbackIndex), matches.length - 1);
}

function wrappedIndex(index: number, total: number) {
  const remainder = index % total;
  return remainder < 0 ? remainder + total : remainder;
}

function firstMatchInMessage(matches: HTMLElement[], messageId: string) {
  for (const match of matches) {
    const messageRoot = match.closest("[data-message-id]");
    if (messageRoot instanceof HTMLElement && messageRoot.dataset.messageId === messageId) {
      return match;
    }
  }
  return null;
}

export function SessionFindBar({
  sessionId,
  scrollRef,
  onBeforeJump,
}: SessionFindBarProps) {
  const open = useSessionFindStore((state) => state.open);
  const ownerSessionId = useSessionFindStore((state) => state.sessionId);
  const query = useSessionFindStore((state) => state.query);
  const appliedQuery = useSessionFindStore((state) => state.appliedQuery);
  const target = useSessionFindStore((state) => state.target);
  const focusNonce = useSessionFindStore((state) => state.focusNonce);
  const setQuery = useSessionFindStore((state) => state.setQuery);
  const setAppliedQuery = useSessionFindStore((state) => state.setAppliedQuery);
  const closeFind = useSessionFindStore((state) => state.closeFind);

  const inputRef = useRef<HTMLInputElement>(null);
  const matchesRef = useRef<HTMLElement[]>([]);
  const activeIndexRef = useRef(0);
  const activeElementRef = useRef<HTMLElement | null>(null);
  const targetStartedAtRef = useRef<number | null>(null);
  const [matches, setMatchesState] = useState<HTMLElement[]>([]);
  const [activeIndex, setActiveIndexState] = useState(0);
  const activeQuery = appliedQuery.trim();
  const owned = open && ownerSessionId === sessionId;
  const searchActive = owned && activeQuery.length >= MIN_QUERY_LENGTH;

  const setMatches = useCallback((nextMatches: HTMLElement[]) => {
    matchesRef.current = nextMatches;
    setMatchesState(nextMatches);
  }, []);

  const setActiveIndex = useCallback((nextIndex: number) => {
    activeIndexRef.current = nextIndex;
    setActiveIndexState(nextIndex);
  }, []);

  const jumpToElement = useCallback((element: HTMLElement) => {
    onBeforeJump?.();
    element.scrollIntoView({ block: "center" });
  }, [onBeforeJump]);

  const activateMatchAtIndex = useCallback((index: number, scroll: boolean) => {
    const currentMatches = matchesRef.current;
    if (currentMatches.length === 0) return;

    const nextIndex = wrappedIndex(index, currentMatches.length);
    const element = currentMatches[nextIndex];
    if (!element) return;

    setActiveIndex(nextIndex);
    setActiveHighlight(activeElementRef, element);
    if (scroll) {
      jumpToElement(element);
    }
  }, [jumpToElement, setActiveIndex]);

  const jumpToNext = useCallback(() => {
    const currentIndex = activeElementRef.current ? activeIndexRef.current : -1;
    activateMatchAtIndex(currentIndex + 1, true);
  }, [activateMatchAtIndex]);

  const jumpToPrevious = useCallback(() => {
    const currentIndex = activeElementRef.current ? activeIndexRef.current : 0;
    activateMatchAtIndex(currentIndex - 1, true);
  }, [activateMatchAtIndex]);

  const collectMatches = useCallback((reason: CollectReason) => {
    const container = scrollRef.current;
    if (!owned || activeQuery.length < MIN_QUERY_LENGTH || !container) {
      setMatches([]);
      setActiveIndex(0);
      setActiveHighlight(activeElementRef, null);
      return;
    }

    const nextMatches = collectHighlightMarks(container);
    const previousActive = activeElementRef.current;
    const pendingTarget = useSessionFindStore.getState().target;
    const targetForSession = pendingTarget?.sessionId === sessionId ? pendingTarget : null;
    let nextIndex = retainedMatchIndex(nextMatches, previousActive, activeIndexRef.current);
    let shouldScroll = false;

    if (targetForSession) {
      if (targetStartedAtRef.current === null) {
        targetStartedAtRef.current = performance.now();
      }

      const targetMatch = targetForSession.messageId
        ? firstMatchInMessage(nextMatches, targetForSession.messageId)
        : nextMatches[0] ?? null;

      if (targetMatch) {
        const targetIndex = nextMatches.indexOf(targetMatch);
        if (targetIndex >= 0) {
          nextIndex = targetIndex;
          shouldScroll = true;
          targetStartedAtRef.current = null;
          useSessionFindStore.setState({ target: null });
        }
      } else {
        const startedAt = targetStartedAtRef.current;
        const timedOut = startedAt !== null && performance.now() - startedAt >= TARGET_RESOLVE_TIMEOUT_MS;
        if (timedOut) {
          targetStartedAtRef.current = null;
          useSessionFindStore.setState({ target: null });
          if (nextMatches.length > 0) {
            nextIndex = 0;
            shouldScroll = true;
          }
        }
      }
    } else {
      targetStartedAtRef.current = null;
      if (reason === "query" && nextMatches.length > 0) {
        nextIndex = 0;
        shouldScroll = true;
      }
    }

    const nextActive = nextMatches[nextIndex] ?? null;
    setMatches(nextMatches);
    setActiveIndex(nextActive ? nextIndex : 0);
    setActiveHighlight(activeElementRef, nextActive);
    if (shouldScroll && nextActive) {
      jumpToElement(nextActive);
    }
  }, [activeQuery.length, jumpToElement, owned, scrollRef, sessionId, setActiveIndex, setMatches]);

  useEffect(() => {
    if (!owned) return;
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusNonce, owned]);

  useEffect(() => {
    if (!owned) return;
    const timer = window.setTimeout(() => setAppliedQuery(query), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [owned, query, setAppliedQuery]);

  useEffect(() => {
    if (!owned) {
      setMatches([]);
      setActiveIndex(0);
      setActiveHighlight(activeElementRef, null);
      return;
    }

    if (activeQuery.length < MIN_QUERY_LENGTH) {
      collectMatches("query");
      return;
    }

    const timer = window.setTimeout(() => collectMatches("query"), COLLECT_AFTER_RENDER_MS);
    return () => window.clearTimeout(timer);
  }, [activeQuery, collectMatches, owned, setActiveIndex, setMatches]);

  useEffect(() => {
    if (!searchActive) return;
    const container = scrollRef.current;
    if (!container) return;

    let timer: number | undefined;
    const observer = new MutationObserver(() => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(() => {
        timer = undefined;
        collectMatches("mutation");
      }, MUTATION_DEBOUNCE_MS);
    });

    observer.observe(container, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [collectMatches, scrollRef, searchActive]);

  useEffect(() => {
    if (!searchActive || target?.sessionId !== sessionId) {
      targetStartedAtRef.current = null;
      return;
    }

    targetStartedAtRef.current = performance.now();
    const timer = window.setTimeout(() => collectMatches("mutation"), TARGET_RESOLVE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [collectMatches, searchActive, sessionId, target]);

  useEffect(() => () => {
    setActiveHighlight(activeElementRef, null);
  }, []);

  if (!owned) {
    return null;
  }

  const totalMatches = matches.length;
  const counterText = activeQuery.length < MIN_QUERY_LENGTH
    ? ""
    : totalMatches === 0
      ? "No matches"
      : `${activeIndex + 1}/${totalMatches}`;

  return (
    <div className="absolute top-2 right-3 z-30 sm:right-5">
      <div className="flex items-center gap-1 rounded-xl border border-dls-border bg-dls-surface/95 px-1.5 py-1 shadow-(--dls-card-shadow) backdrop-blur-md">
        <Search className="ml-1 size-3.5 shrink-0 text-dls-secondary" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (event.shiftKey) {
                jumpToPrevious();
              } else {
                jumpToNext();
              }
              return;
            }

            if (event.key === "Escape") {
              event.preventDefault();
              closeFind();
            }
          }}
          className="h-7 w-48 bg-transparent px-1 text-sm text-dls-text outline-none placeholder:text-dls-secondary sm:h-8 sm:w-56"
          placeholder="Find in conversation"
          aria-label="Find in conversation"
        />
        <span className={cn(
          "min-w-14 text-right text-xs tabular-nums text-muted-foreground",
          counterText === "No matches" && "min-w-20",
        )} aria-live="polite">
          {counterText}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Previous match"
                disabled={totalMatches === 0}
                onMouseDown={(event) => event.preventDefault()}
                onClick={jumpToPrevious}
              >
                <ChevronUp />
              </Button>
            }
          />
          <TooltipContent>Previous match (⇧↵)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Next match"
                disabled={totalMatches === 0}
                onMouseDown={(event) => event.preventDefault()}
                onClick={jumpToNext}
              >
                <ChevronDown />
              </Button>
            }
          />
          <TooltipContent>Next match (↵)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Close find"
                onMouseDown={(event) => event.preventDefault()}
                onClick={closeFind}
              >
                <X />
              </Button>
            }
          />
          <TooltipContent>Close (Esc)</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
