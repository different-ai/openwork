import fuzzysort from "fuzzysort";
import type { SessionReferenceCandidate } from "@/components/chat/session-reference";
import type { ComposerMentionKind } from "./mention-encoding";
import { filterSessionReferenceCandidates } from "./session-reference-search";

export type MentionItem = {
  id: string;
  kind: Exclude<ComposerMentionKind, "computer">;
  value: string;
  label: string;
  description?: string;
};

export type MentionSuggestion = MentionItem | { id: string; kind: "task"; candidate: SessionReferenceCandidate };
export type MentionTrigger = { query: string; offset: number };

export function isSingleWordMentionQuery(query: string) {
  return !/\s/.test(query);
}

export function inlineMentionAtCaret(text: string, caret: number) {
  const offset = text.lastIndexOf("@", caret - 1);
  if (caret <= 0 || offset < 0 || (offset > 0 && !/\s/.test(text[offset - 1]))) return null;
  const query = text.slice(offset + 1, caret);
  if (/^[\s]|[\r\n]/.test(query)) return null;
  const suffix = text.slice(caret).match(/^[^\s@]*/)?.[0] ?? "";
  return { query, offset, end: caret + suffix.length };
}

export function filterMentionItems(items: MentionItem[], query: string, limit = 8) {
  return query
    ? fuzzysort.go(query, items, { keys: ["label"], limit }).map((entry) => entry.obj)
    : items.slice(0, limit);
}

export function inlineMentionSuggestions(
  items: MentionItem[],
  candidates: readonly SessionReferenceCandidate[],
  query: string,
  currentSessionId?: string,
): MentionSuggestion[] {
  const nonTasks = isSingleWordMentionQuery(query) ? filterMentionItems(items, query, 4) : [];
  return [
    ...nonTasks,
    ...filterSessionReferenceCandidates(candidates, query, { excludeSessionId: currentSessionId, limit: 4, titleOnly: true })
      .map((candidate): MentionSuggestion => ({ id: `task:${candidate.workspaceId}:${candidate.sessionId}`, kind: "task", candidate })),
  ];
}
