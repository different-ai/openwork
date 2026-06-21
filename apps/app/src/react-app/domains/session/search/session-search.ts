import type { OpenworkSessionMessage } from "@/app/lib/openwork-server";

/** A session that can be deep-searched. */
export type SearchableSession = {
  workspaceId: string;
  sessionId: string;
  title: string;
  workspaceTitle: string;
  updatedAt: number;
};

export type SessionSearchSnippet = {
  before: string;
  match: string;
  after: string;
};

export type SessionSearchMatch = {
  session: SearchableSession;
  /** Whether the query matched the title or a message body. */
  kind: "title" | "message";
  role?: "user" | "assistant";
  snippet?: SessionSearchSnippet;
};

export type SessionSearchProgress = {
  scanned: number;
  total: number;
  done: boolean;
};

type CacheEntry = {
  updatedAt: number;
  /** One entry per message that contains searchable text. */
  texts: Array<{ role: "user" | "assistant"; text: string; lower: string }>;
  /** Set when the transcript fetch failed; retried after a short cool-down. */
  failedAt?: number;
};

type QueryToken = {
  value: string;
};

type WordRange = {
  value: string;
  start: number;
  end: number;
};

type TokenRange = {
  start: number;
  end: number;
  score: number;
};

type TokenizedMatch = {
  ranges: TokenRange[];
  score: number;
};

export type SessionMessageFetcher = (
  workspaceId: string,
  sessionId: string,
) => Promise<OpenworkSessionMessage[]>;

const SNIPPET_BEFORE = 36;
const SNIPPET_AFTER = 72;
const DEFAULT_CONCURRENCY = 6;
const FAILURE_RETRY_MS = 30_000;
const MIN_TOKEN_LENGTH = 2;
const WORD_PATTERN = /[\p{L}\p{N}_./-]+/gu;
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "in",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

/** Build a compact snippet centered on the first occurrence of the query. */
export function buildSnippet(text: string, index: number, length: number): SessionSearchSnippet {
  const start = Math.max(0, index - SNIPPET_BEFORE);
  const end = Math.min(text.length, index + length + SNIPPET_AFTER);
  const before = `${start > 0 ? "..." : ""}${collapseWhitespace(text.slice(start, index)).trimStart()}`;
  const after = `${collapseWhitespace(text.slice(index + length, end)).trimEnd()}${end < text.length ? "..." : ""}`;
  return { before, match: text.slice(index, index + length), after };
}

function tokenizeQuery(query: string): QueryToken[] {
  const seen = new Set<string>();
  const tokens: QueryToken[] = [];
  for (const match of query.toLowerCase().matchAll(WORD_PATTERN)) {
    const value = match[0];
    if (value.length < MIN_TOKEN_LENGTH || STOP_WORDS.has(value) || seen.has(value)) continue;
    seen.add(value);
    tokens.push({ value });
  }
  return tokens;
}

function wordRanges(lower: string): WordRange[] {
  const ranges: WordRange[] = [];
  for (const match of lower.matchAll(WORD_PATTERN)) {
    ranges.push({
      value: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return ranges;
}

function editDistanceWithin(left: string, right: string, maxDistance: number): boolean {
  if (Math.abs(left.length - right.length) > maxDistance) return false;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowBest = current[0];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const value = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + cost,
      );
      current[rightIndex] = value;
      rowBest = Math.min(rowBest, value);
    }
    if (rowBest > maxDistance) return false;
    previous = current;
  }

  return previous[right.length] <= maxDistance;
}

function scoreWordForToken(word: WordRange, token: QueryToken): TokenRange | null {
  if (word.value === token.value) {
    return { start: word.start, end: word.end, score: 120 };
  }
  if (word.value.startsWith(token.value)) {
    return { start: word.start, end: word.end, score: 95 };
  }

  const index = word.value.indexOf(token.value);
  if (index >= 0) {
    return {
      start: word.start + index,
      end: word.start + index + token.value.length,
      score: 75,
    };
  }

  const maxDistance = token.value.length >= 7 ? 2 : 1;
  if (editDistanceWithin(token.value, word.value, maxDistance)) {
    return { start: word.start, end: word.end, score: 55 };
  }

  return null;
}

function findBestTokenRange(words: WordRange[], token: QueryToken): TokenRange | null {
  let best: TokenRange | null = null;
  for (const word of words) {
    const range = scoreWordForToken(word, token);
    if (!range) continue;
    if (!best || range.score > best.score) {
      best = range;
    }
  }
  return best;
}

function matchTokenizedQuery(lower: string, tokens: QueryToken[]): TokenizedMatch | null {
  if (tokens.length === 0) return null;

  const words = wordRanges(lower);
  const ranges: TokenRange[] = [];
  for (const token of tokens) {
    const range = findBestTokenRange(words, token);
    if (!range) return null;
    ranges.push(range);
  }

  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const span = sorted[sorted.length - 1].end - sorted[0].start;
  const proximityBonus = Math.max(0, 120 - span);
  const score = ranges.reduce((sum, range) => sum + range.score, 0) + proximityBonus;

  return { ranges: sorted, score };
}

function buildTokenSnippet(text: string, ranges: TokenRange[]): SessionSearchSnippet {
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  const start = Math.max(0, first.start - SNIPPET_BEFORE);
  const end = Math.min(text.length, last.end + SNIPPET_AFTER);
  return {
    before: `${start > 0 ? "..." : ""}${collapseWhitespace(text.slice(start, first.start)).trimStart()}`,
    match: collapseWhitespace(text.slice(first.start, last.end)),
    after: `${collapseWhitespace(text.slice(last.end, end)).trimEnd()}${end < text.length ? "..." : ""}`,
  };
}

function toCacheEntry(updatedAt: number, messages: OpenworkSessionMessage[]): CacheEntry {
  const texts: CacheEntry["texts"] = [];
  for (const message of messages) {
    const role = message.info.role;
    if (role !== "user" && role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "text") continue;
      if (part.synthetic || part.ignored) continue;
      const text = part.text.trim();
      if (!text) continue;
      texts.push({ role, text, lower: text.toLowerCase() });
    }
  }
  return { updatedAt, texts };
}

function matchEntry(
  session: SearchableSession,
  entry: CacheEntry,
  queryTokens: QueryToken[],
): SessionSearchMatch | null {
  let best: { match: SessionSearchMatch; score: number } | null = null;
  for (const item of entry.texts) {
    const tokenMatch = matchTokenizedQuery(item.lower, queryTokens);
    if (!tokenMatch) continue;
    const score = tokenMatch.score + (item.role === "user" ? 50 : 0);
    const match: SessionSearchMatch = {
      session,
      kind: "message",
      role: item.role,
      snippet: buildTokenSnippet(item.text, tokenMatch.ranges),
    };
    if (!best || score > best.score) {
      best = { match, score };
    }
  }
  return best?.match ?? null;
}

export type SessionSearchRun = {
  /** Resolves when the scan completes or is cancelled. */
  done: Promise<void>;
  cancel: () => void;
};

export type SessionSearcher = {
  search: (options: {
    query: string;
    sessions: SearchableSession[];
    onMatch: (match: SessionSearchMatch) => void;
    onProgress: (progress: SessionSearchProgress) => void;
    concurrency?: number;
  }) => SessionSearchRun;
  /** Drop every cached transcript (e.g. when the server connection changes). */
  clear: () => void;
};

/**
 * Deep-search engine for session transcripts.
 *
 * Transcripts are fetched lazily with a small concurrency cap and cached by
 * `sessionId + updatedAt`, so repeated keystrokes only hit the network for
 * sessions that changed since the last scan.
 */
export function createSessionSearcher(fetchMessages: SessionMessageFetcher): SessionSearcher {
  const cache = new Map<string, CacheEntry>();

  const getEntry = async (session: SearchableSession): Promise<CacheEntry> => {
    const cached = cache.get(session.sessionId);
    if (cached && cached.updatedAt === session.updatedAt) {
      const failureFresh =
        cached.failedAt !== undefined && Date.now() - cached.failedAt < FAILURE_RETRY_MS;
      if (cached.failedAt === undefined || failureFresh) return cached;
    }
    let entry: CacheEntry;
    try {
      const messages = await fetchMessages(session.workspaceId, session.sessionId);
      entry = toCacheEntry(session.updatedAt, messages);
    } catch {
      // Keep one stale workspace or server hiccup from blocking every keystroke.
      entry = { ...toCacheEntry(session.updatedAt, []), failedAt: Date.now() };
    }
    cache.set(session.sessionId, entry);
    return entry;
  };

  return {
    search({ query, sessions, onMatch, onProgress, concurrency = DEFAULT_CONCURRENCY }) {
      const queryTokens = tokenizeQuery(query);
      let cancelled = false;

      // Scan newest sessions first so the most relevant hits stream in early.
      const queue = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
      const total = queue.length;
      let scanned = 0;

      const report = () => {
        if (cancelled) return;
        onProgress({ scanned, total, done: scanned >= total });
      };

      const worker = async () => {
        while (!cancelled) {
          const session = queue.shift();
          if (!session) return;
          const entry = await getEntry(session);
          if (cancelled) return;
          scanned += 1;
          const match = matchEntry(session, entry, queryTokens);
          if (match) onMatch(match);
          report();
        }
      };

      const done = (async () => {
        if (queryTokens.length === 0) {
          scanned = total;
          report();
          return;
        }
        report();
        await Promise.all(
          Array.from({ length: Math.max(1, concurrency) }, () => worker()),
        );
      })();

      return {
        done,
        cancel: () => {
          cancelled = true;
        },
      };
    },
    clear: () => cache.clear(),
  };
}
