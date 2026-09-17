import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CancelledError, queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import type { UIMessage } from "ai";
import { applyHistorySourceChanges, mergeHistoryWindow, projectHistoryRead, reconcileHistoryRead, type LatestSessionHistory } from "./session-render-state";
import { snapshotToUIMessages } from "../sync/usechat-adapter";
import type { OpenworkSessionHistory } from "@/app/lib/openwork-server";
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "@/app/types";
import { sessionHistoryCredential, snapshotKey } from "../sync/session-sync";
import { composerAutoSendScopeKey } from "./composer-auto-send";
import { getSessionScrollState, useSessionScrollStore, type SessionScrollState } from "./scroll-store";
import { readSessionHistoryPage, useSessionHistoryPages } from "./session-history-pages";

export type OpeningHistoryWindow = { limit?: number; before?: string; messageIds?: readonly string[] };

export function sessionHistoryIdentity(input: {
  draftScope: string | null;
  opencodeBaseUrl: string;
  runtimeWorkspaceId: string;
  sessionId: string;
}) {
  // Sidebar aliases (rem_*) are navigation identities, not runtime cache owners.
  return {
    owner: composerAutoSendScopeKey({ ...input, workspaceId: input.runtimeWorkspaceId }),
    snapshotQueryKey: snapshotKey(input.runtimeWorkspaceId, input.sessionId),
  };
}

export function openingHistoryWindow(saved: SessionScrollState): OpeningHistoryWindow {
  if (saved.mode !== "manual" || !saved.anchor) return { limit: 24 };
  const page = saved.geometry?.page;
  if (page) return { limit: page.limit, ...(page.before === null ? {} : { before: page.before }) };
  const nearby = saved.geometry?.messageIds ?? [];
  // Old saved positions may have an anchor but predate nearby-ID persistence.
  const ids = nearby.includes(saved.anchor.messageId) ? nearby : [saved.anchor.messageId];
  // Rendering splits a native assistant turn into a steps row and can append a
  // synthetic error row. Keep those DOM IDs for restoration, not native reads.
  const nativeIds = ids.map((id) => {
    const messageId = id.endsWith(":steps") ? id.slice(0, -":steps".length) : id;
    return messageId.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX)
      ? messageId.slice(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX.length) : messageId;
  }).filter(Boolean);
  return { messageIds: [...new Set(nativeIds)].slice(0, 24) };
}

type OpeningHistoryInput = {
  owner: string;
  sessionId: string;
  authToken?: string | null;
  ignoreCached?: boolean;
  metadataQueryKey?: readonly unknown[];
  snapshotQueryKey: readonly unknown[];
  readSnapshot: (signal: AbortSignal, window?: OpeningHistoryWindow, options?: { desktopTransport: "main" }) => Promise<OpenworkSessionHistory>;
};

const hydratingTranscripts = new WeakSet<object>();
const EMPTY_HISTORY: UIMessage[] = [];
/** The newest-window size a warm return reads; a shorter window is the whole conversation. */
export const LATEST_HISTORY_WINDOW = 24;

type HistoryRecord = OpenworkSessionHistory["messages"][number];

function recordSignature(record: HistoryRecord): string {
  // Compare everything except inline file bytes: an image data URL can be
  // megabytes, and a replaced image also changes its part ID, length, or time.
  return JSON.stringify([record.info, record.parts.map((part) =>
    "url" in part && typeof part.url === "string" ? { ...part, url: part.url.length } : part)]);
}

/**
 * A newest window that equals the tail of a complete cached history proves the
 * cache is still current. Returning to such a conversation keeps the cache
 * instead of re-reading every message (and every inline image) again. Any
 * doubt — a different session revision, revert, count, ID, or part lifecycle —
 * falls back to the uncapped read.
 */
export function latestConfirmsFullHistory(
  full: OpenworkSessionHistory,
  latest: Pick<OpenworkSessionHistory, "session" | "messages">,
): boolean {
  if (full.session.id !== latest.session.id || full.messages.length < latest.messages.length) return false;
  if (full.pagination && (full.pagination.before !== undefined || full.pagination.nextCursor !== null)) return false;
  if ((full.session.revert?.messageID ?? null) !== (latest.session.revert?.messageID ?? null)) return false;
  if (full.session.time.updated !== latest.session.time.updated
    || Boolean(full.session.time.archived) !== Boolean(latest.session.time.archived)) return false;
  if (latest.messages.length < LATEST_HISTORY_WINDOW && full.messages.length !== latest.messages.length) return false;
  const tail = full.messages.slice(full.messages.length - latest.messages.length);
  const latestById = new Map(latest.messages.map((record) => [record.info.id, record]));
  if (latestById.size !== tail.length) return false;
  return tail.every((record) => {
    const match = latestById.get(record.info.id);
    return match !== undefined && recordSignature(match) === recordSignature(record);
  });
}

async function readLatestHistory<T>(read: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) {
  signal.throwIfAborted();
  const deadline = new AbortController();
  const readSignal = AbortSignal.any([signal, deadline.signal]);
  let rejectAborted: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const onAbort = () => rejectAborted(readSignal.reason);
  readSignal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => deadline.abort(new Error("Latest history read timed out.")), 2_000);
  try {
    // Some transports cannot abort an already-dispatched request. The optional
    // newest read must still release full-history loading at its deadline.
    return await Promise.race([read(readSignal), aborted]);
  } finally {
    clearTimeout(timer);
    readSignal.removeEventListener("abort", onAbort);
  }
}

export function openingSessionHistoryOptions(input: OpeningHistoryInput, saved = getSessionScrollState(
  useSessionScrollStore.getState().sessions, input.sessionId, input.owner,
), cache?: QueryClient) {
  const credential = sessionHistoryCredential(input.authToken);
  const window = openingHistoryWindow(saved);
  const readKey = ["react-session-latest", ...input.snapshotQueryKey, input.owner, credential, "opening-read", window];
  return queryOptions({
    queryKey: ["react-session-opening", input.owner, credential, window],
    queryFn: async ({ signal, client }): Promise<{ snapshot: OpenworkSessionHistory | null }> => {
      try {
        const read = () => readSessionHistoryPage(client, {
          queryKey: readKey,
          signal, sessionId: input.sessionId, read: (signal) => input.readSnapshot(signal, window),
        });
        const snapshot = await read().catch((error: unknown) => {
          signal.throwIfAborted();
          if (error instanceof CancelledError) return read();
          throw error;
        });
        signal.throwIfAborted();
        if (snapshot.session.id !== input.sessionId || snapshot.messages.some(({ info, parts }) =>
          info.sessionID !== input.sessionId || parts.some((part) => part.sessionID !== input.sessionId || part.messageID !== info.id))) {
          throw new Error("Conversation history belongs to another session.");
        }
        if (snapshot.pagination && ((snapshot.pagination.before ?? null) !== (openingHistoryWindow(saved).before ?? null)
          || snapshot.pagination.nextCursor !== null && snapshot.pagination.nextCursor === snapshot.pagination.before)) {
          throw new Error("Conversation pagination did not advance.");
        }
        return { snapshot };
      } catch {
        signal.throwIfAborted();
        // A preview is optional (e.g. a deleted anchor or an older server).
        // The uncapped authoritative query owns errors and the retry UI.
        return { snapshot: null };
      }
    },
    staleTime: (query) => query.state.data?.snapshot && (!cache
      || cache.getQueryData<{ snapshot?: OpenworkSessionHistory }>(readKey)?.snapshot === query.state.data.snapshot) ? Infinity : 0,
    structuralSharing: false,
    gcTime: 15_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    networkMode: "always",
  });
}

export function prefetchOpeningSessionHistory(client: QueryClient, input: OpeningHistoryInput) {
  if (client.getQueryData<OpenworkSessionHistory>(input.snapshotQueryKey)?.session.id === input.sessionId) return;
  // No queue and no neighboring reads: only one speculative opening at a time.
  if (client.isFetching({ queryKey: ["react-session-opening"] })) return;
  const options = openingSessionHistoryOptions(input, undefined, client);
  void client.prefetchQuery(options);
  return () => {
    const query = client.getQueryCache().find({ queryKey: options.queryKey, exact: true });
    // Click may already have adopted this exact query. Never cancel its read.
    if (query?.getObserversCount() === 0) void client.cancelQueries({ queryKey: options.queryKey, exact: true });
  };
}

export function useSessionPrefetchIntent(intent: boolean, prefetch: () => void | (() => void)) {
  const committed = useRef(false);
  useEffect(() => {
    committed.current = false;
    if (!intent) return;
    let cancel: void | (() => void);
    const timer = setTimeout(() => { cancel = prefetch(); }, 250);
    return () => {
      clearTimeout(timer);
      if (!committed.current) cancel?.();
    };
  }, [intent, prefetch]);
  return () => { committed.current = true; };
}

export function useOpeningSessionHistory(input: OpeningHistoryInput & {
  transcriptQueryKey?: readonly unknown[];
  readLatest?: (signal: AbortSignal, options?: { desktopTransport: "main" }) => Promise<Pick<OpenworkSessionHistory, "session" | "messages">>;
}) {
  const client = useQueryClient();
  const hasLegacyPosition = useSessionScrollStore((state) => Boolean(state.sessions[input.sessionId]));
  const saved = useMemo(() => {
    return getSessionScrollState(useSessionScrollStore.getState().sessions, input.sessionId, input.owner);
  }, [input.owner, input.sessionId, hasLegacyPosition]);
  const hasFullSnapshot = !input.ignoreCached && client.getQueryData<OpenworkSessionHistory>(input.snapshotQueryKey)?.session.id === input.sessionId;
  const options = openingSessionHistoryOptions(input, saved, client);
  const query = useQuery({ ...options, enabled: !hasFullSnapshot });
  useEffect(() => () => {
    void client.invalidateQueries({ queryKey: options.queryKey, exact: true, refetchType: "none" });
  }, [client, input.owner, input.authToken, input.sessionId]);
  const credential = options.queryKey[2];
  const openingRead = client.getQueryData<{ snapshot?: OpenworkSessionHistory }>([
    "react-session-latest", ...input.snapshotQueryKey, input.owner, credential, "opening-read", openingHistoryWindow(saved),
  ]);
  const openingSnapshot = !query.isFetching && openingRead?.snapshot === query.data?.snapshot ? query.data?.snapshot ?? null : null;
  const latestKey = useMemo(() => ["react-session-latest", ...input.snapshotQueryKey, input.owner, credential], [input.owner, input.sessionId, credential]);
  const entry = useMemo<{
    warm: boolean;
    fullRead: { baseline: UIMessage[]; updateCount: number } | null;
    /**
     * The exact cached complete history whose tail the latest newest read
     * matched. Weak so a replaced snapshot is not kept alive by this record.
     */
    confirmedFull: WeakRef<OpenworkSessionHistory> | null;
    readers: Set<AbortController>;
  }>(() => ({
    warm: !input.ignoreCached && client.getQueryData<OpenworkSessionHistory>(input.snapshotQueryKey)?.session.id === input.sessionId,
    fullRead: null,
    confirmedFull: null,
    readers: new Set<AbortController>(),
  }), [client, input.owner, input.sessionId, credential]);
  const pages = useSessionHistoryPages({ ...input, credential, initial: openingSnapshot, saved, complete: hasFullSnapshot });
  const readSource = useCallback(() => input.transcriptQueryKey
    ? client.getQueryData<UIMessage[]>(input.transcriptQueryKey) ?? EMPTY_HISTORY : EMPTY_HISTORY,
  [client, input.transcriptQueryKey]);
  const latestQuery = useQuery({
    queryKey: latestKey,
    enabled: entry.warm && Boolean(input.readLatest),
    queryFn: async ({ signal }): Promise<LatestSessionHistory> => {
      const full = client.getQueryData<OpenworkSessionHistory>(input.snapshotQueryKey);
      if (!input.readLatest || !full) throw new Error("Latest conversation history is unavailable.");
      const initial = client.getQueryData<LatestSessionHistory>(latestKey) ?? {
        messages: mergeHistoryWindow(projectHistoryRead(full), readSource()), source: readSource(),
      };
      entry.confirmedFull = null;
      const history = await readLatestHistory(input.readLatest, signal);
      signal.throwIfAborted();
      if (history.session.id !== input.sessionId || history.messages.some(({ info, parts }) =>
        info.sessionID !== input.sessionId || parts.some((part) =>
          part.sessionID !== input.sessionId || part.messageID !== info.id))) {
        throw new Error("Conversation history belongs to another session.");
      }
      // Judge the cache as it stands now: live events may have changed it during the read.
      const cachedNow = client.getQueryData<OpenworkSessionHistory>(input.snapshotQueryKey);
      entry.confirmedFull = cachedNow !== undefined && latestConfirmsFullHistory(cachedNow, history) ? new WeakRef(cachedNow) : null;
      const current = applyHistorySourceChanges(client.getQueryData<LatestSessionHistory>(latestKey) ?? initial, readSource());
      if (history.session.revert?.messageID || client.getQueryData<OpenworkSessionHistory>(input.snapshotQueryKey)?.session.revert?.messageID) return current;
      return {
        messages: reconcileHistoryRead(current.messages, projectHistoryRead({ ...full, messages: history.messages }), initial.messages),
        source: current.source,
      };
    },
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnMount: "always",
    refetchOnReconnect: "always",
    refetchOnWindowFocus: false,
    structuralSharing: false,
    networkMode: "always",
  });
  useEffect(() => {
    if (!entry.warm || !input.readLatest) return;
    const sourceKey = input.transcriptQueryKey;
    const reconcile = () => client.setQueryData<LatestSessionHistory>(latestKey,
      (current) => current ? applyHistorySourceChanges(current, readSource()) : current);
    reconcile();
    return client.getQueryCache().subscribe((event) => {
      if (sourceKey && event.query.queryKey.length === sourceKey.length
        && sourceKey.every((part, index) => part === event.query.queryKey[index])
        && event.type === "updated" && event.action.type === "success"
        && !hydratingTranscripts.has(client)) reconcile();
    });
  }, [client, entry, input.readLatest, input.transcriptQueryKey, latestKey, latestQuery.isSuccess, readSource]);
  const readFullSnapshot = useCallback(async (signal: AbortSignal, options?: { desktopTransport: "main" }) => {
    const cached = client.getQueryData<OpenworkSessionHistory>(input.snapshotQueryKey);
    const baseline = client.getQueryData<LatestSessionHistory>(latestKey)?.messages
      ?? (cached ? snapshotToUIMessages(cached) : EMPTY_HISTORY);
    const metadataBefore = input.metadataQueryKey ? client.getQueryData(input.metadataQueryKey) : undefined;
    let snapshot = await input.readSnapshot(signal, undefined, options);
    signal.throwIfAborted();
    const metadataAfter = input.metadataQueryKey
      ? client.getQueryData<Pick<OpenworkSessionHistory["session"], "revert">>(input.metadataQueryKey) : undefined;
    if (metadataAfter && metadataAfter !== metadataBefore) snapshot = { ...snapshot, session: { ...snapshot.session, ...metadataAfter } };
    if (snapshot.session.id !== input.sessionId || snapshot.pagination && (snapshot.pagination.before !== undefined || snapshot.pagination.nextCursor !== null)) {
      throw new Error("Complete conversation history is unavailable.");
    }
    entry.fullRead = { baseline, updateCount: (client.getQueryState(input.snapshotQueryKey)?.dataUpdateCount ?? 0) + 1 };
    return snapshot;
  }, [client, entry, input.metadataQueryKey, input.readSnapshot, input.sessionId, input.snapshotQueryKey, latestKey]);
  const seedSnapshot = useCallback((snapshot: OpenworkSessionHistory, seed: () => void) => {
    if (snapshot.session.id !== input.sessionId) return;
    if (pages.ready && !hasFullSnapshot) { pages.seedSnapshot(seed); return; }
    if (!entry.warm || !input.readLatest || !input.transcriptQueryKey) { seed(); return; }
    if (latestQuery.isFetching) return;
    const current = client.getQueryData<LatestSessionHistory>(latestKey);
    hydratingTranscripts.add(client);
    try {
      seed();
      if (!current) return;
      const source = readSource();
      const fullRead = entry.fullRead;
      const baseline = fullRead && fullRead.updateCount === client.getQueryState(input.snapshotQueryKey)?.dataUpdateCount
        ? fullRead.baseline : EMPTY_HISTORY;
      client.setQueryData<LatestSessionHistory>(latestKey, {
        messages: reconcileHistoryRead(current.messages, source, baseline),
        source,
      });
    } finally {
      hydratingTranscripts.delete(client);
    }
  }, [client, entry, hasFullSnapshot, pages.ready, pages.seedSnapshot, input.readLatest, input.sessionId, input.snapshotQueryKey, input.transcriptQueryKey, latestKey, latestQuery.isFetching, readSource]);
  const latestHistory = entry.warm ? latestQuery.data ?? null : null;
  const fullReader = readFullSnapshot;
  const activeOwner = useRef<typeof entry | null>(entry);
  activeOwner.current = entry;
  useEffect(() => {
    activeOwner.current = entry;
    return () => {
      activeOwner.current = null;
      for (const reader of entry.readers) reader.abort();
      void client.cancelQueries({ queryKey: ["react-session-branch-history", input.owner, credential], exact: true });
    };
  }, [client, credential, entry, input.owner]);
  const refreshFullSnapshot = useCallback(async (options?: { desktopTransport: "main" }) => {
    if (activeOwner.current !== entry) throw new CancelledError();
    if (pages.ready && !hasFullSnapshot) return pages.refreshForStop(options);
    const filters = { queryKey: input.snapshotQueryKey, exact: true };
    const query = client.getQueryCache().find<OpenworkSessionHistory>(filters);
    if (!query) throw new CancelledError();
    const assertCurrent = () => {
      if (activeOwner.current !== entry || client.getQueryCache().find(filters) !== query) {
        throw new CancelledError();
      }
    };
    assertCurrent();
    await client.cancelQueries(filters);
    assertCurrent();
    let requestSignal: AbortSignal | undefined;
    const snapshot = await query.fetch({
      ...query.options,
      queryFn: async ({ signal }) => {
        requestSignal = signal;
        assertCurrent();
        const snapshot = await fullReader(signal, options);
        signal.throwIfAborted();
        assertCurrent();
        return snapshot;
      },
    });
    requestSignal?.throwIfAborted();
    assertCurrent();
    return snapshot;
  }, [client, entry, fullReader, hasFullSnapshot, input.snapshotQueryKey, pages.ready, pages.refreshForStop]);
  const ensureFullSnapshot = useCallback(async () => {
    if (activeOwner.current !== entry) throw new CancelledError();
    const options = {
      queryKey: input.snapshotQueryKey,
      queryFn: ({ signal }: { signal: AbortSignal }) => fullReader(signal),
      networkMode: "always" as const,
    };
    try {
      return await (input.ignoreCached ? client.fetchQuery(options) : client.ensureQueryData(options));
    } catch (error) {
      // The cache cancels this read when the surface's own observer drops
      // mid-flight. Development builds simulate an unmount for every mount
      // effect, so a send fired from one (the hero's one-step Run task) always
      // sees its reader drop and re-subscribe while the read is in flight. With
      // the reader still present that is not a failed read: read again. Once
      // nobody observes the thread anymore (navigated away), it stands.
      if (!(error instanceof CancelledError) || activeOwner.current !== entry) throw error;
      const query = client.getQueryCache().find({ queryKey: input.snapshotQueryKey, exact: true });
      if (!query || query.getObserversCount() === 0) throw error;
      return client.fetchQuery(options);
    }
  }, [client, entry, input.ignoreCached, input.snapshotQueryKey, fullReader]);
  // A follow-up decides whether to interrupt delegated work from the current
  // turn's newest messages. Cached complete history already holds them;
  // otherwise one bounded newest read does. A send never waits on the uncapped
  // read a saved reading position leaves in flight: on a cold engine that read
  // can outlast its request timeout, and a timed-out read must not bounce the
  // person's message back into the composer.
  const readSendHistory = useCallback(async (options: { revealLatest?: boolean } = {}): Promise<OpenworkSessionHistory["messages"]> => {
    if (activeOwner.current !== entry) throw new CancelledError();
    const cached = client.getQueryData<OpenworkSessionHistory>(input.snapshotQueryKey);
    if (!input.ignoreCached && cached?.session.id === input.sessionId) return cached.messages;
    if (options.revealLatest && pages.hasNewer) return pages.readLatestForSend({ desktopTransport: "main" });
    if (!input.readLatest) return (await ensureFullSnapshot()).messages;
    const controller = new AbortController();
    entry.readers.add(controller);
    try {
      const latest = await input.readLatest(controller.signal, { desktopTransport: "main" });
      controller.signal.throwIfAborted();
      if (activeOwner.current !== entry) throw new CancelledError();
      if (latest.session.id !== input.sessionId) throw new Error("Conversation history belongs to another session.");
      return latest.messages;
    } finally { entry.readers.delete(controller); }
  }, [client, ensureFullSnapshot, entry, input.ignoreCached, input.readLatest, input.sessionId, input.snapshotQueryKey, pages.hasNewer, pages.readLatestForSend]);
  const runWithFullSnapshot = useCallback(async (
    action: (snapshot: OpenworkSessionHistory) => void | Promise<unknown>,
    options: { fresh?: boolean } = {},
  ) => {
    if (activeOwner.current !== entry) return;
    const snapshot = await (options.fresh ? client.fetchQuery({
      // Branch must not join an older opening/send read or trust cached history.
      // Concurrent branches share this uncapped read and its response boundary.
      queryKey: ["react-session-branch-history", input.owner, credential],
      queryFn: ({ signal }) => fullReader(signal),
      staleTime: 0,
      gcTime: 15_000,
      networkMode: "always",
    }) : ensureFullSnapshot()).catch((error: unknown) => {
      if (activeOwner.current !== entry) return null;
      throw error;
    });
    if (!snapshot || activeOwner.current !== entry) return;
    if (snapshot.session.id !== input.sessionId) throw new Error("Conversation history belongs to another session.");
    await action(snapshot);
  }, [client, credential, entry, ensureFullSnapshot, fullReader, input.owner, input.sessionId]);
  const paginated = Boolean(query.data?.snapshot?.pagination);
  const needsRevertHistory = Boolean((pages.snapshot ?? query.data?.snapshot)?.session.revert) && !pages.complete;
  const [backgroundOwner, setBackgroundOwner] = useState<typeof entry | null>(null);
  useEffect(() => {
    if (!query.isSuccess || query.isFetching || hasFullSnapshot || paginated && !needsRevertHistory) return;
    // Let the relevant messages paint before full-history JSON/React work starts.
    let second: number | undefined;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => setBackgroundOwner(entry));
    });
    return () => {
      window.cancelAnimationFrame(first);
      if (second !== undefined) window.cancelAnimationFrame(second);
    };
  }, [entry, query.isSuccess, query.isFetching, hasFullSnapshot, paginated, needsRevertHistory]);
  const snapshot = hasFullSnapshot ? null : pages.snapshot ?? openingSnapshot;
  const limit = openingHistoryWindow(saved).limit;
  return {
    saved,
    options,
    snapshot,
    latestHistory,
    readFullSnapshot: fullReader,
    seedSnapshot,
    // A newest window that came back shorter than its limit already holds the
    // whole conversation. Only a full window, a saved-position window, or an
    // unavailable preview can still be missing earlier messages.
    partial: paginated ? !pages.complete : snapshot === null || limit === undefined || snapshot.messages.length >= limit,
    backgroundReady: paginated && !needsRevertHistory ? false : hasFullSnapshot
      ? !entry.warm || !input.readLatest || !latestQuery.isFetching
      : backgroundOwner === entry,
    // The cached complete history whose tail the newest read matched needs no
    // uncapped re-read. Only that exact object is current: a later refresh or
    // terminal-edge invalidation replaces it and returns to the default policy.
    fullCurrent: hasFullSnapshot && entry.warm && latestQuery.isSuccess && entry.confirmedFull !== null
      && client.getQueryData<OpenworkSessionHistory>(input.snapshotQueryKey) === entry.confirmedFull.deref(),
    pages,
    complete: hasFullSnapshot || pages.complete,
    paginated,
    pageMessages: !hasFullSnapshot && paginated ? needsRevertHistory ? EMPTY_HISTORY
      : pages.messages ?? (snapshot ? snapshotToUIMessages(snapshot) : EMPTY_HISTORY) : undefined,
    ensureFullSnapshot,
    refreshFullSnapshot,
    readSendHistory,
    runWithFullSnapshot,
  };
}

export function SessionHistoryLoading({ saved, failed = false }: { saved: SessionScrollState; failed?: boolean }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 150);
    return () => clearTimeout(timer);
  }, []);
  const height = Math.max(200, (saved.geometry?.scrollHeight ?? 232) - 32);
  const top = saved.mode === "manual" ? Math.min(saved.scrollTop + 64, height - 120) : Math.max(64, height - 200);
  if (failed) return <div data-thread-placeholder style={{ minHeight: height }} />;
  return <div data-thread-loading role="status" aria-live="polite" aria-label="Loading conversation" style={{ minHeight: height }}>
    <span className="sr-only">Loading conversation</span>
    {visible ? <div aria-hidden="true" data-thread-loading-visual className="flex items-center justify-center gap-2 text-sm text-dls-secondary" style={{ paddingTop: Math.max(32, top) }}>
      <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" />
      <span>{saved.mode === "manual" ? "Returning to your reading position…" : "Loading latest messages…"}</span>
    </div> : null}
  </div>;
}

export function SessionHistoryStatus({ complete, pending, loading, failed, onRetry }: {
  complete: boolean;
  pending: boolean;
  /** The uncapped read is in flight and may still add earlier messages. */
  loading: boolean;
  failed: boolean;
  onRetry: () => Promise<unknown>;
}) {
  const [retrying, setRetrying] = useState(false);
  const retryPending = useRef(false);
  if (complete || (pending && !failed && !retrying)) return null;
  // Only a read that is actually in flight may announce loading. A read that
  // is not enabled yet, paused, or reverted by a cancellation has nothing to
  // report, and an announcement derived from missing history alone would stay
  // visible with nothing left to clear it.
  if (!loading && !failed && !retrying) return null;
  return <div data-thread-history-status className="pointer-events-none flex shrink-0 justify-center px-3 pt-2 sm:px-5">
    <div role={failed && !retrying ? "alert" : "status"} aria-live="polite" className="pointer-events-auto flex items-center gap-2 rounded-md bg-dls-surface/95 px-3 py-1 text-xs text-dls-secondary shadow-sm">
      <span>{retrying ? pending ? "Loading conversation…" : "Loading earlier messages…" : failed
        ? pending ? "This conversation could not be loaded." : "The rest of this conversation could not be loaded."
        : "Loading earlier messages…"}</span>
      {failed || retrying ? <button type="button" disabled={retrying} className="underline disabled:no-underline" onClick={() => {
        if (retryPending.current) return;
        retryPending.current = true;
        setRetrying(true);
        void onRetry().catch(() => undefined).finally(() => {
          retryPending.current = false;
          setRetrying(false);
        });
      }}>{retrying ? "Retrying…" : "Retry"}</button> : null}
    </div>
  </div>;
}

export function SessionHistoryBoundary({ owner, pending, saved, failed, children }: {
  owner: string;
  pending: boolean;
  saved: SessionScrollState;
  failed?: boolean;
  children: ReactNode;
}) {
  // useQuery owns the opening read without suspending its reveal behind React's
  // fallback throttle. Keep descendant suspensions isolated from the composer.
  return <Suspense key={owner} fallback={<SessionHistoryLoading saved={saved} />}>
    {pending ? <SessionHistoryLoading saved={saved} failed={failed} /> : children}
  </Suspense>;
}
