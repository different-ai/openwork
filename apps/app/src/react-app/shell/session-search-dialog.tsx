/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import fuzzysort from "fuzzysort";
import { ClockIcon, Loader2Icon, MessageSquareTextIcon, TypeIcon } from "lucide-react";

import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandDialogTitle,
  CommandEmpty,
  CommandFooter,
  CommandHeader,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandShortcut,
} from "@/components/ui/command";
import { formatRelativeTime } from "@/app/utils";
import {
  createSessionSearcher,
  type SearchableSession,
  type SessionMessageFetcher,
  type SessionSearchMatch,
  type SessionSearchProgress,
  type SessionSearchSnippet,
} from "@/react-app/domains/session/search/session-search";

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 200;
const RECENT_LIMIT = 15;
const TITLE_LIMIT = 10;
const RESULT_LIMIT = 50;

type ResultItem = {
  id: string;
  kind: "recent" | "title" | "message";
  session: SearchableSession;
  role?: "user" | "assistant";
  snippet?: SessionSearchSnippet;
};

export type SessionSearchDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Every session across workspaces, newest first preferred. */
  sessions: SearchableSession[];
  /** Loads a session transcript. Null while the server is unavailable. */
  fetchMessages: SessionMessageFetcher | null;
  onOpenSession: (workspaceId: string, sessionId: string) => void;
};

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (!value) {
      setDebounced("");
      return;
    }
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function resultIcon(kind: ResultItem["kind"]) {
  if (kind === "message") {
    return <MessageSquareTextIcon className="size-4 text-muted-foreground" />;
  }
  if (kind === "title") {
    return <TypeIcon className="size-4 text-muted-foreground" />;
  }
  return <ClockIcon className="size-4 text-muted-foreground" />;
}

function SnippetLine(props: { item: ResultItem }) {
  const { item } = props;
  if (item.snippet) {
    return (
      <div className="truncate text-muted-foreground text-xs">
        {item.role === "user" ? "You: " : item.role === "assistant" ? "Agent: " : null}
        {item.snippet.before}
        <span className="rounded-[3px] bg-primary/15 font-medium text-foreground">
          {item.snippet.match}
        </span>
        {item.snippet.after}
      </div>
    );
  }
  return (
    <div className="truncate text-muted-foreground text-xs">
      {item.session.workspaceTitle}
    </div>
  );
}

/**
 * Deep search across every session: titles match instantly, transcripts are
 * scanned in the background and stream in as they are found (Cmd/Ctrl+Shift+F).
 */
export function SessionSearchDialog(props: SessionSearchDialogProps) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<SessionSearchMatch[]>([]);
  const [progress, setProgress] = useState<SessionSearchProgress | null>(null);

  const debouncedQuery = useDebouncedValue(query.trim(), DEBOUNCE_MS);
  const deepQuery = debouncedQuery.length >= MIN_QUERY_LENGTH ? debouncedQuery : "";

  // The searcher caches transcripts by session id + updatedAt, so it must
  // outlive individual keystrokes and dialog open/close cycles.
  const searcher = useMemo(
    () => (props.fetchMessages ? createSessionSearcher(props.fetchMessages) : null),
    [props.fetchMessages],
  );

  useEffect(() => {
    if (!props.open) {
      setQuery("");
    }
  }, [props.open]);

  useEffect(() => {
    setMatches([]);
    if (!props.open || !searcher || !deepQuery) {
      setProgress(null);
      return;
    }
    const collected: SessionSearchMatch[] = [];
    const run = searcher.search({
      query: deepQuery,
      sessions: props.sessions,
      onMatch: (match) => {
        collected.push(match);
        setMatches([...collected]);
      },
      onProgress: setProgress,
    });
    return () => run.cancel();
  }, [props.open, props.sessions, searcher, deepQuery]);

  const items = useMemo<ResultItem[]>(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      return [...props.sessions]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, RECENT_LIMIT)
        .map((session) => ({
          id: `recent:${session.workspaceId}:${session.sessionId}`,
          kind: "recent" as const,
          session,
        }));
    }

    const out: ResultItem[] = [];
    const seen = new Set<string>();

    const titleHits = fuzzysort.go(trimmed, props.sessions, {
      keys: ["title", "workspaceTitle"],
      limit: TITLE_LIMIT,
    });
    for (const hit of titleHits) {
      const session = hit.obj;
      seen.add(session.sessionId);
      out.push({
        id: `title:${session.workspaceId}:${session.sessionId}`,
        kind: "title",
        session,
      });
    }

    const messageHits = [...matches].sort(
      (a, b) => b.session.updatedAt - a.session.updatedAt,
    );
    for (const match of messageHits) {
      if (seen.has(match.session.sessionId)) continue;
      seen.add(match.session.sessionId);
      out.push({
        id: `message:${match.session.workspaceId}:${match.session.sessionId}`,
        kind: "message",
        session: match.session,
        role: match.role,
        snippet: match.snippet,
      });
    }
    return out.slice(0, RESULT_LIMIT);
  }, [matches, props.sessions, query]);

  const trimmedQuery = query.trim();
  const searching = Boolean(deepQuery) && progress !== null && !progress.done;
  const emptyText = !trimmedQuery
    ? "No sessions yet."
    : trimmedQuery.length < MIN_QUERY_LENGTH
      ? "Keep typing to search message content…"
      : searching
        ? "Searching messages…"
        : "No sessions or messages match your search.";

  const statusText = !trimmedQuery
    ? "Recent sessions"
    : searching
      ? `Searching messages… ${progress.scanned}/${progress.total}`
      : `${items.length.toLocaleString()} ${items.length === 1 ? "result" : "results"}`;

  return (
    <CommandDialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <CommandDialogPopup>
        <CommandDialogTitle>Search sessions</CommandDialogTitle>
        <Command
          items={items}
          filter={null}
          value={query}
          onValueChange={setQuery}
        >
          <CommandHeader>
            <CommandInput
              className="w-full"
              placeholder="Search all sessions and messages…"
            />
          </CommandHeader>
          <CommandPanel>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandList>
              {(item: ResultItem) => (
                <CommandItem
                  key={item.id}
                  value={item.id}
                  onClick={() => {
                    props.onClose();
                    props.onOpenSession(item.session.workspaceId, item.session.sessionId);
                  }}
                >
                  <span className="mr-2 shrink-0">{resultIcon(item.kind)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate font-medium">{item.session.title}</span>
                      {item.kind === "message" ? (
                        <span className="shrink-0 truncate text-[11px] text-muted-foreground/72">
                          {item.session.workspaceTitle}
                        </span>
                      ) : null}
                    </div>
                    <SnippetLine item={item} />
                  </div>
                  <CommandShortcut className="ps-3">
                    {formatRelativeTime(item.session.updatedAt)}
                  </CommandShortcut>
                </CommandItem>
              )}
            </CommandList>
          </CommandPanel>
          <CommandFooter>
            <span className="inline-flex items-center gap-1.5">
              {searching ? <Loader2Icon className="size-3 animate-spin" /> : null}
              {statusText}
            </span>
            <span>↑↓ to navigate · ↵ to open</span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
