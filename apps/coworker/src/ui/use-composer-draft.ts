import { useCallback, useState, type SetStateAction } from "react";

const PREFIX = "coworker.composer-draft.v1:";

function readDraft(key: string): string {
  try { return window.localStorage.getItem(PREFIX + key) ?? ""; }
  catch { return ""; }
}

/** Unsent words belong to one coworker and conversation, including across reloads. */
export function useComposerDraft(key: string): [string, (next: SetStateAction<string>) => void] {
  const [entry, setEntry] = useState(() => ({ key, value: readDraft(key) }));
  // A reused view must not show or save the previous conversation's draft.
  const value = entry.key === key ? entry.value : readDraft(key);
  const setValue = useCallback((next: SetStateAction<string>) => {
    const updated = typeof next === "function" ? next(value) : next;
    try {
      if (updated) window.localStorage.setItem(PREFIX + key, updated);
      else window.localStorage.removeItem(PREFIX + key);
    } catch {
      // A full or unavailable browser store must not prevent writing or sending.
    }
    setEntry({ key, value: updated });
  }, [key, value]);
  return [value, setValue];
}
