import {
  getComposerSessionDraftScope,
  persistableComposerDraftText,
  useComposerStateStore,
  type QueuedComposerItem,
} from "../surface/composer-state-store";
import { saveSessionQueuedDrafts } from "./draft-store";

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
