import { useCallback, useSyncExternalStore, type SetStateAction } from "react";
import { createComposerDraftStore, parseComposerDraft, type ComposerDraft } from "../lib/skill-selection.ts";

const PREFIX = "coworker.composer-draft.v2:";
const LEGACY_PREFIX = "coworker.composer-draft.v1:";
export const composerDraftStore = createComposerDraftStore({
  read(key) {
    let value: string | null = null;
    let legacy = "";
    try { value = window.localStorage.getItem(PREFIX + key); legacy = window.localStorage.getItem(LEGACY_PREFIX + key) ?? ""; }
    catch { return { text: "", skills: [] }; }
    return parseComposerDraft(value, legacy);
  },
  write(key, draft) {
    if (draft.text || draft.skills.length) window.localStorage.setItem(PREFIX + key, JSON.stringify(draft));
    else window.localStorage.removeItem(PREFIX + key);
    window.localStorage.removeItem(LEGACY_PREFIX + key);
  },
});

/** Unsent words belong to one coworker and conversation, including across reloads. */
export function useSelectedComposerDraft(key: string): [ComposerDraft, (next: SetStateAction<ComposerDraft>) => void] {
  const subscribe = useCallback((listener: () => void) => composerDraftStore.subscribe(key, listener), [key]);
  const read = useCallback(() => composerDraftStore.read(key), [key]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  const setValue = useCallback((next: SetStateAction<ComposerDraft>) => {
    composerDraftStore.update(key, next);
  }, [key]);
  return [snapshot.value, setValue];
}

/** Text-only callers keep their existing API, sharing the same durable record. */
export function useComposerDraft(key: string): [string, (next: SetStateAction<string>) => void] {
  const [draft, setDraft] = useSelectedComposerDraft(key);
  const setText = useCallback((next: SetStateAction<string>) => setDraft((draft) => ({ ...draft, text: typeof next === "function" ? next(draft.text) : next })), [setDraft]);
  return [draft.text, setText];
}
