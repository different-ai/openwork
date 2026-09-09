import { useCallback, useLayoutEffect, useRef, useState, type SetStateAction } from "react";

const PREFIX = "coworker.composer-draft.v1:";
const drafts = new Map<string, string>();

function readDraft(key: string): string {
  const cached = drafts.get(key);
  if (cached !== undefined) return cached;
  try { return window.localStorage.getItem(PREFIX + key) ?? ""; }
  catch { return ""; }
}

/** Unsent words belong to one coworker and conversation, including across reloads. */
export function useComposerDraft(key: string, initialValue?: string): [string, (next: SetStateAction<string>) => void] {
  const [entry, setEntry] = useState(() => ({ key, value: initialValue ?? readDraft(key) }));
  // A reused view must not show or save the previous conversation's draft.
  const value = entry.key === key ? entry.value : readDraft(key);
  const current = useRef({ key, value });
  if (current.current.key !== key) current.current = { key, value };
  const setValue = useCallback((next: SetStateAction<string>) => {
    const previous = current.current.key === key ? current.current.value : readDraft(key);
    const updated = typeof next === "function" ? next(previous) : next;
    drafts.set(key, updated);
    if (current.current.key === key) current.current = { key, value: updated };
    try {
      if (updated) window.localStorage.setItem(PREFIX + key, updated);
      else window.localStorage.removeItem(PREFIX + key);
    } catch {
      // A full or unavailable browser store must not prevent writing or sending.
    }
    setEntry((entry) => entry.key === key && entry.value === updated ? entry : { key, value: updated });
  }, [key]);
  // A transferred voice draft is recoverable before the person types again.
  useLayoutEffect(() => { if (initialValue !== undefined) setValue((value) => value); }, [initialValue, setValue]);
  return [value, setValue];
}
