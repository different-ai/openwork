import {
  getComposerSessionDraftScope,
  persistableComposerDraftText,
  useComposerStateStore,
  type QueuedComposerItem,
} from "../surface/composer-state-store";
import { saveSessionQueuedDrafts } from "./draft-store";

/**
 * Follow-ups queued behind a running task live in the in-memory composer
 * store, which a renderer reload or app restart empties. Mirror their text
 * into the persisted draft entry of their conversation on every queue change,
 * including drains for conversations that are not in view, so the next launch
 * can hand them back as an unsent draft. Attachments hold live File objects
 * and are not persisted, exactly like composer drafts.
 */
export function queuedDraftTexts(items: readonly QueuedComposerItem[]): string[] {
  return items
    .map((item) => persistableComposerDraftText(item.draft.text).trim())
    .filter((text) => text.length > 0);
}

export function startQueuedDraftPersistence(save: typeof saveSessionQueuedDrafts = saveSessionQueuedDrafts): () => void {
  let previous = useComposerStateStore.getState().queuedDrafts;
  return useComposerStateStore.subscribe((state) => {
    const next = state.queuedDrafts;
    if (next === previous) return;
    const sessionIds = new Set([...Object.keys(previous), ...Object.keys(next)]);
    for (const sessionId of sessionIds) {
      if (next[sessionId] === previous[sessionId]) continue;
      const scopeKey = getComposerSessionDraftScope(sessionId);
      if (!scopeKey) continue;
      save(scopeKey, queuedDraftTexts(next[sessionId] ?? []));
    }
    previous = next;
  });
}
