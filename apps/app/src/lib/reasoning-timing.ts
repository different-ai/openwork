/** A reasoning part's native start and end, so "Thought for Ns" survives reload. */
export function reasoningProviderMetadata(part: { id: string; time?: { start: number; end?: number } }) {
  return { opencode: { partId: part.id,
    ...(part.time ? { startedAt: part.time.start, ...(part.time.end === undefined ? {} : { endedAt: part.time.end }) } : {}) } };
}
