import fuzzysort from "fuzzysort";

import type { SessionReferenceCandidate } from "@/components/chat/session-reference";

export const SESSION_REFERENCE_RESULT_LIMIT = 8;

export function filterSessionReferenceCandidates(
  candidates: readonly SessionReferenceCandidate[],
  query: string,
  options: { excludeSessionId?: string; limit?: number; titleOnly?: boolean } = {},
): SessionReferenceCandidate[] {
  const limit = options.limit ?? SESSION_REFERENCE_RESULT_LIMIT;
  const pool = options.excludeSessionId
    ? candidates.filter((candidate) => candidate.sessionId !== options.excludeSessionId)
    : [...candidates];
  const trimmed = query.trim();
  if (!trimmed) return pool.slice(0, limit);
  return fuzzysort
    .go(trimmed, pool, {
      keys: options.titleOnly ? ["title"] : ["title", "workspaceTitle"],
      scoreFn: (result) => Math.max(result[0]?.score ?? 0, (result[1]?.score ?? 0) * 0.5),
      limit,
    })
    .map((entry) => entry.obj);
}
