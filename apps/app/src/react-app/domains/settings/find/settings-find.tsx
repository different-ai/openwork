/** @jsxImportSource react */
import { useCallback, useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import { TextSearch } from "lucide-react";

import { FindField } from "@/components/find-field";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isMacPlatform } from "@/app/utils";

import { clearFindHighlights, paintFindHighlights } from "./find-highlights";
import { FIND_MIN_QUERY_LENGTH, collectFindRanges, wrappedMatchIndex } from "./find-matches";
import { useSettingsFindStore } from "./settings-find-store";

export const SETTINGS_FIND_LABEL = "Find on this page";
const DEBOUNCE_MS = 150;
const MUTATION_DEBOUNCE_MS = 100;

/**
 * Open state for find on a settings page, and the Cmd/Ctrl+F that opens it.
 * Settings shown beside a chat share that shortcut with "Find in
 * conversation", so there it is taken only while focus is inside `scopeRef`.
 */
export function useSettingsFind(input: {
  enabled: boolean;
  scopeRef: RefObject<HTMLElement | null>;
  besideChat: boolean;
}) {
  const open = useSettingsFindStore((state) => state.open);
  const focusNonce = useSettingsFindStore((state) => state.focusNonce);
  const openFind = useSettingsFindStore((state) => state.openFind);
  const closeFind = useSettingsFindStore((state) => state.closeFind);

  const handleShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!input.enabled) return;
    const mod = isMacPlatform() ? event.metaKey : event.ctrlKey;
    if (!mod || event.shiftKey || event.altKey || event.key?.toLowerCase() !== "f") return;
    if (input.besideChat && !input.scopeRef.current?.contains(document.activeElement)) return;
    event.preventDefault();
    event.stopPropagation();
    openFind();
  });

  useEffect(() => {
    const handler = (event: KeyboardEvent) => handleShortcut(event);
    // Capture, so the page's find wins over the conversation's when both are mounted.
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  // Leaving settings closes find, so it is not waiting open on the next visit.
  useEffect(() => closeFind, [closeFind]);

  return { enabled: input.enabled, open: input.enabled && open, focusNonce, openFind, closeFind };
}

export function SettingsFindButton(props: { onOpen: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-xl text-gray-10 transition-colors hover:bg-muted hover:text-foreground"
            aria-label={SETTINGS_FIND_LABEL}
            data-testid="settings-find-button"
            onClick={props.onOpen}
          >
            <TextSearch size={16} />
          </Button>
        }
      />
      <TooltipContent>{SETTINGS_FIND_LABEL} ({isMacPlatform() ? "⌘F" : "Ctrl+F"})</TooltipContent>
    </Tooltip>
  );
}

type SettingsFindBarProps = {
  /** The settings page being searched; the bar itself sits outside it. */
  contentRef: RefObject<HTMLElement | null>;
  /** Changes each time find is asked for, to put the cursor back in the field. */
  focusNonce: number;
  onClose: () => void;
};

/**
 * Finds text on the open settings page, including what is scrolled out of
 * view: highlights every match, counts them and steps through them.
 */
export function SettingsFindBar(props: SettingsFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [ranges, setRanges] = useState<Range[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const rangesRef = useRef<Range[]>([]);
  const activeIndexRef = useRef(0);

  const show = useCallback((nextRanges: Range[], nextIndex: number, scroll: boolean) => {
    const current = nextRanges[nextIndex] ?? null;
    rangesRef.current = nextRanges;
    activeIndexRef.current = current ? nextIndex : 0;
    setRanges(nextRanges);
    setActiveIndex(current ? nextIndex : 0);
    paintFindHighlights(nextRanges, current);
    if (scroll) current?.startContainer.parentElement?.scrollIntoView({ block: "center" });
  }, []);

  const collect = useEffectEvent((fromStart: boolean) => {
    const root = props.contentRef.current;
    const nextRanges = root ? collectFindRanges(root, appliedQuery) : [];
    // A new query starts at its first match; a page that changed under the
    // same query keeps the reader's place.
    const nextIndex = fromStart ? 0 : Math.min(activeIndexRef.current, Math.max(0, nextRanges.length - 1));
    show(nextRanges, nextIndex, fromStart);
  });

  const move = useCallback((step: number) => {
    const total = rangesRef.current.length;
    if (total === 0) return;
    show(rangesRef.current, wrappedMatchIndex(activeIndexRef.current, step, total), true);
  }, [show]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [props.focusNonce]);

  useEffect(() => {
    const timer = window.setTimeout(() => setAppliedQuery(query.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    collect(true);
  }, [appliedQuery]);

  // Another settings page, or content that loads late, is searched again.
  useEffect(() => {
    const root = props.contentRef.current;
    if (!root || appliedQuery.length < FIND_MIN_QUERY_LENGTH) return;
    let timer: number | undefined;
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => collect(false), MUTATION_DEBOUNCE_MS);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [appliedQuery, props.contentRef]);

  useEffect(() => clearFindHighlights, []);

  const counterText = appliedQuery.length < FIND_MIN_QUERY_LENGTH
    ? ""
    : ranges.length === 0
      ? "No matches"
      : `${activeIndex + 1}/${ranges.length}`;

  return (
    <div data-testid="settings-find" className="absolute top-2 right-3 z-30 sm:right-5">
      <FindField
        inputRef={inputRef}
        label={SETTINGS_FIND_LABEL}
        query={query}
        onQueryChange={setQuery}
        counterText={counterText}
        hasMatches={ranges.length > 0}
        onNext={() => move(1)}
        onPrevious={() => move(-1)}
        onClose={props.onClose}
      />
    </div>
  );
}
