import fuzzysort from "fuzzysort";

import type { SessionReferenceCandidate } from "@/components/chat/session-reference";

export const SESSION_REFERENCE_RESULT_LIMIT = 8;

/**
 * Tasks for the composer `#` picker. An empty query lists the newest tasks;
 * otherwise titles are fuzzy-matched (partial and non-contiguous queries such
 * as `lgnbug` for "Fix login bug"), with the folder name as a
 * weaker second key. The task being written in is never offered.
 */
export function filterSessionReferenceCandidates(
  candidates: readonly SessionReferenceCandidate[],
  query: string,
  options: { excludeSessionId?: string; limit?: number } = {},
): SessionReferenceCandidate[] {
  const limit = options.limit ?? SESSION_REFERENCE_RESULT_LIMIT;
  const pool = options.excludeSessionId
    ? candidates.filter((candidate) => candidate.sessionId !== options.excludeSessionId)
    : [...candidates];
  const trimmed = query.trim();
  if (!trimmed) return pool.slice(0, limit);
  return fuzzysort
    .go(trimmed, pool, {
      keys: ["title", "workspaceTitle"],
      // Folder matches alone rank below any title match.
      scoreFn: (result) => Math.max(result[0]?.score ?? 0, (result[1]?.score ?? 0) * 0.5),
      limit,
    })
    .map((entry) => entry.obj);
}
