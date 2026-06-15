import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";

import {
  applyTextHighlights,
  clearTextHighlights,
  scrollActiveMatchIntoView,
} from "@/react-app/domains/session/surface/text-highlights";
import { countChatSearchMatches } from "./session-chat-search";

const DEBOUNCE_MS = 200;

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (!value) {
      setDebounced("");
      return;
    }
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export type UseSessionChatSearchInput = {
  messages: UIMessage[];
  contentRef: React.RefObject<HTMLDivElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enableShortcuts?: boolean;
};

export function useSessionChatSearch(input: UseSessionChatSearchInput) {
  const { messages, contentRef, open, onOpenChange, enableShortcuts = true } = input;
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debouncedQuery = useDebouncedValue(query.trim(), DEBOUNCE_MS);

  const matchCount = useMemo(
    () => countChatSearchMatches(messages, debouncedQuery),
    [messages, debouncedQuery],
  );

  const safeActiveIndex = matchCount > 0 ? activeIndex % matchCount : 0;

  useEffect(() => {
    setActiveIndex(0);
  }, [debouncedQuery]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(0);
      const root = contentRef.current;
      if (root) {
        clearTextHighlights(root);
      }
      return;
    }
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open, contentRef]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const root = contentRef.current;
    if (!root) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      applyTextHighlights(root, debouncedQuery, safeActiveIndex);
      scrollActiveMatchIntoView(root);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, debouncedQuery, safeActiveIndex, messages, contentRef]);

  const goNext = useCallback(() => {
    if (matchCount === 0) {
      return;
    }
    setActiveIndex((current) => (current + 1) % matchCount);
  }, [matchCount]);

  const goPrev = useCallback(() => {
    if (matchCount === 0) {
      return;
    }
    setActiveIndex((current) => (current - 1 + matchCount) % matchCount);
  }, [matchCount]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onOpenChange(false);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (event.shiftKey) {
          goPrev();
        } else {
          goNext();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onOpenChange, goNext, goPrev]);

  useEffect(() => {
    if (!enableShortcuts) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      const isMac = /Mac/i.test(navigator.platform);
      const mod = isMac ? event.metaKey : event.ctrlKey;
      if (!mod || event.shiftKey || event.altKey || event.key?.toLowerCase() !== "f") {
        return;
      }
      event.preventDefault();
      onOpenChange(true);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enableShortcuts, onOpenChange]);

  const statusLabel = !query.trim()
    ? ""
    : matchCount > 0
      ? `${safeActiveIndex + 1} of ${matchCount}`
      : "No matches";

  return {
    query,
    setQuery,
    inputRef,
    matchCount,
    statusLabel,
    goNext,
    goPrev,
    close: () => onOpenChange(false),
  };
}
