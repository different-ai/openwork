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

export type SessionMessageFetcher = (
  workspaceId: string,
  sessionId: string,
) => Promise<OpenworkSessionMessage[]>;

const SNIPPET_BEFORE = 36;
const SNIPPET_AFTER = 72;
const DEFAULT_CONCURRENCY = 6;
const FAILURE_RETRY_MS = 30_000;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

/** Build a compact snippet centered on the first occurrence of the query. */
export function buildSnippet(text: string, index: number, length: number): SessionSearchSnippet {
  const start = Math.max(0, index - SNIPPET_BEFORE);
  const end = Math.min(text.length, index + length + SNIPPET_AFTER);
  const before = `${start > 0 ? "…" : ""}${collapseWhitespace(text.slice(start, index)).trimStart()}`;
  const after = `${collapseWhitespace(text.slice(index + length, end)).trimEnd()}${end < text.length ? "…" : ""}`;
  return { before, match: text.slice(index, index + length), after };
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
  queryLower: string,
): SessionSearchMatch | null {
  // Prefer the user's own prompts: they are usually what people remember typing.
  let fallback: SessionSearchMatch | null = null;
  for (const item of entry.texts) {
    const index = item.lower.indexOf(queryLower);
    if (index < 0) continue;
    const match: SessionSearchMatch = {
      session,
      kind: "message",
      role: item.role,
      snippet: buildSnippet(item.text, index, queryLower.length),
    };
    if (item.role === "user") return match;
    if (!fallback) fallback = match;
  }
  return fallback;
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
      // Unreachable session (stale workspace, server hiccup): record an empty
      // entry with a cool-down so one bad session cannot stall every later
      // keystroke, but still gets retried once the cool-down expires.
      entry = { ...toCacheEntry(session.updatedAt, []), failedAt: Date.now() };
    }
    cache.set(session.sessionId, entry);
    return entry;
  };

  return {
    search({ query, sessions, onMatch, onProgress, concurrency = DEFAULT_CONCURRENCY }) {
      const queryLower = query.trim().toLowerCase();
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
          const match = matchEntry(session, entry, queryLower);
          if (match) onMatch(match);
          report();
        }
      };

      const done = (async () => {
        if (!queryLower) {
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
