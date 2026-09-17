import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CancelledError, hashKey, skipToken, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import type { OpenworkSessionHistory } from "@/app/lib/openwork-server";
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "@/app/types";
import { snapshotToUIMessages } from "../sync/usechat-adapter";
import { applyRevertCursor } from "../sync/transcript-reconcile";
import { applyHistorySourceChanges, reconcileHistoryRead, type LatestSessionHistory } from "./session-render-state";
import type { OpeningHistoryWindow } from "./session-history";
import { getSessionScrollState, useSessionScrollStore, type SessionHistoryPagePosition, type SessionScrollState } from "./scroll-store";

type Page = OpenworkSessionHistory & { pagination: NonNullable<OpenworkSessionHistory["pagination"]> };
type Direction = "older" | "newer" | "refresh" | "latest";
type Pages = { pages: Page[]; bridge: Page[]; lineage: (string | null)[] };
type PageScope = {
  active: boolean;
  initialized: boolean;
  hydrating: boolean;
  removed: Set<string>;
  expiredPositions: WeakSet<Page>;
  request: AbortController | null;
  failed: Direction | null;
  state: Pages | null;
  baseline: Map<string, UIMessage>;
  snapshot: OpenworkSessionHistory | null;
  ids: Set<string>;
  positions: Map<string, SessionHistoryPagePosition>;
  restoreCancelled: boolean;
  metadataAt: number;
  refreshPending: boolean;
};
const EMPTY: UIMessage[] = [];

function nativeId(id: string) {
  const messageId = id.endsWith(":steps") ? id.slice(0, -6) : id;
  return messageId.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX)
    ? messageId.slice(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX.length) : messageId;
}

function isPage(snapshot: OpenworkSessionHistory | null): snapshot is Page {
  return Boolean(snapshot?.pagination);
}

export function mergeSessionHistoryPages(pages: readonly Page[], keep: (id: string) => boolean): OpenworkSessionHistory {
  const newest = pages[pages.length - 1];
  const nodes = new Map<string, { message: OpenworkSessionHistory["messages"][number]; before: string | null; after: string | null }>();
  let first: string | null = null;
  let last: string | null = null;
  for (const page of pages) {
    let after: string | null = null;
    for (let index = page.messages.length - 1; index >= 0; index--) {
      const message = page.messages[index];
      const id = message.info.id;
      if (!keep(id)) continue;
      const existing = nodes.get(id);
      if (existing) existing.message = message;
      else {
        const following = after === null ? undefined : nodes.get(after);
        const before = following?.before ?? (after === null ? last : null);
        nodes.set(id, { message, before, after });
        if (before === null) first = id;
        else { const previous = nodes.get(before); if (previous) previous.after = id; }
        if (following) following.before = id;
        else last = id;
      }
      after = id;
    }
  }
  const messages: OpenworkSessionHistory["messages"] = [];
  for (let id = first; id !== null;) {
    const node = nodes.get(id);
    if (!node) break;
    messages.push(node.message);
    id = node.after;
  }
  return { ...newest, messages };
}

export async function readSessionHistoryPage(client: QueryClient, input: {
  queryKey: readonly unknown[];
  signal: AbortSignal;
  sessionId: string;
  read: (signal: AbortSignal) => Promise<OpenworkSessionHistory>;
}) {
  input.signal.throwIfAborted();
  const cancel = () => { void client.cancelQueries({ queryKey: input.queryKey, exact: true }); };
  input.signal.addEventListener("abort", cancel, { once: true });
  try {
    const result = await client.fetchQuery({
      queryKey: input.queryKey,
      queryFn: async ({ signal }) => {
        const combined = AbortSignal.any([signal, input.signal]);
        const snapshot = await input.read(combined);
        combined.throwIfAborted();
        if (snapshot.session.id !== input.sessionId || snapshot.messages.some(({ info, parts }) =>
          info.sessionID !== input.sessionId || parts.some((part) => part.sessionID !== input.sessionId || part.messageID !== info.id))) {
          throw new Error("Conversation history belongs to another session.");
        }
        return { snapshot, messages: snapshotToUIMessages(snapshot), source: EMPTY };
      },
      staleTime: 0,
      gcTime: 15_000,
      retry: false,
      structuralSharing: false,
      networkMode: "always",
    });
    input.signal.throwIfAborted();
    if (client.getQueryData<{ snapshot?: OpenworkSessionHistory }>(input.queryKey)?.snapshot !== result.snapshot) throw new CancelledError();
    return result.snapshot;
  } finally { input.signal.removeEventListener("abort", cancel); }
}

export function useSessionHistoryPages(input: {
  owner: string;
  credential: unknown;
  sessionId: string;
  snapshotQueryKey: readonly unknown[];
  transcriptQueryKey?: readonly unknown[];
  metadataQueryKey?: readonly unknown[];
  initial: OpenworkSessionHistory | null;
  saved: SessionScrollState;
  readSnapshot: (signal: AbortSignal, window?: OpeningHistoryWindow, options?: { desktopTransport: "main" }) => Promise<OpenworkSessionHistory>;
  complete: boolean;
}) {
  const client = useQueryClient();
  const scope = useMemo<PageScope>(() => ({
    active: true,
    initialized: false,
    hydrating: false,
    removed: new Set<string>(),
    expiredPositions: new WeakSet<Page>(),
    request: null,
    failed: null,
    state: null,
    refreshPending: false,
    baseline: new Map((input.transcriptQueryKey ? client.getQueryData<UIMessage[]>(input.transcriptQueryKey) ?? EMPTY : EMPTY).map((message) => [message.id, message])),
    snapshot: null,
    ids: new Set<string>(),
    positions: new Map<string, SessionHistoryPagePosition>(),
    restoreCancelled: false,
    metadataAt: input.metadataQueryKey ? client.getQueryState(input.metadataQueryKey)?.dataUpdateCount ?? 0 : 0,
  }), [input.owner, input.credential, input.sessionId]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [revision, render] = useState(0);
  const [status, setStatus] = useState<{ scope: typeof scope; pending: boolean; failed: boolean } | null>(null);
  const historyKey = useMemo(() => ["react-session-latest", ...input.snapshotQueryKey, input.owner, input.credential, "pages"],
    [input.owner, input.credential, hashKey(input.snapshotQueryKey)]);
  const pageKey = useMemo(() => ["react-session-latest", ...input.snapshotQueryKey, input.owner, input.credential, "page-read"],
    [input.owner, input.credential, hashKey(input.snapshotQueryKey)]);
  const history = useQuery<LatestSessionHistory>({ queryKey: historyKey, queryFn: skipToken, gcTime: 0, structuralSharing: false });
  const metadata = useQuery<Pick<OpenworkSessionHistory["session"], "revert">>({
    queryKey: input.metadataQueryKey ?? ["react-session-metadata", input.owner, input.credential], queryFn: skipToken,
  });
  const sessionPatch = input.metadataQueryKey && (client.getQueryState(input.metadataQueryKey)?.dataUpdateCount ?? 0) > scope.metadataAt
    ? metadata.data : undefined;
  useEffect(() => {
    if (sessionPatch) {
      scope.request?.abort();
      void client.cancelQueries({ queryKey: pageKey });
    }
  }, [client, pageKey, scope, sessionPatch]);
  const readSource = useCallback(() => input.transcriptQueryKey
    ? client.getQueryData<UIMessage[]>(input.transcriptQueryKey) ?? EMPTY : EMPTY,
  [client, input.transcriptQueryKey]);
  const keep = useCallback((id: string) => !scope.removed.has(nativeId(id)), [scope]);
  const publish = useCallback((state: Pages, reset = false, baseline: UIMessage[] = EMPTY, updated: readonly Page[] = state.pages, sourceBefore = scope.baseline) => {
    if (!scope.active || currentScope.current !== scope) return;
    scope.state = state;
    const snapshot = mergeSessionHistoryPages(state.pages, keep);
    scope.snapshot = snapshot;
    scope.ids = new Set(snapshot.messages.map((message) => message.info.id));
    scope.positions = new Map();
    const entries = new Map(state.lineage.map((cursor, index) => [cursor, index]));
    for (const page of state.pages) {
      const before = page.pagination.before ?? null;
      const index = entries.get(before);
      if (index === undefined || state.lineage[0] !== null || scope.expiredPositions.has(page)) continue;
      const position = { before, limit: page.pagination.limit,
        lineage: index >= 64 ? [null, ...state.lineage.slice(index - 62, index + 1)] : state.lineage.slice(0, index + 1) };
      for (const message of page.messages) if (keep(message.info.id)) scope.positions.set(message.info.id, position);
    }
    const incoming = snapshotToUIMessages(snapshot);
    const ids = scope.ids;
    const newest = state.pages.at(-1)?.pagination.before === undefined && state.bridge.length === 0;
    scope.hydrating = true;
    try {
      client.setQueryData<LatestSessionHistory>(historyKey, (current) => {
        const changes = readSource().filter((message) => sourceBefore.get(message.id) !== message);
        const previous = (reset ? changes : current?.messages ?? changes)
          .filter((message) => keep(message.id) && (ids.has(nativeId(message.id)) || newest && !scope.baseline.has(message.id)));
        const existing = new Map(previous.map((message) => [message.id, message]));
        const changed = new Set(updated.flatMap((page) => page.messages.map((message) => message.info.id)));
        const refreshed = incoming.map((message) => changed.has(nativeId(message.id)) ? message : existing.get(message.id) ?? message);
        const reconciled = reconcileHistoryRead(previous, refreshed, baseline);
        const values = new Map(reconciled.map((message) => [message.id, message]));
        const orderedIds = new Set(refreshed.map((message) => message.id));
        const messages = reset || !current
          ? [...refreshed.map((message) => values.get(message.id) ?? message), ...reconciled.filter((message) => !orderedIds.has(message.id))]
          : reconciled;
        return { messages, source: readSource() };
      });
    } finally { scope.hydrating = false; }
    render((value) => value + 1);
  }, [client, historyKey, keep, readSource, scope]);
  useEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
      scope.request?.abort();
      void client.cancelQueries({ queryKey: pageKey });
    };
  }, [client, pageKey, scope]);
  useEffect(() => {
    if (scope.initialized || !isPage(input.initial) || input.complete) return;
    scope.initialized = true;
    const before = input.initial.pagination.before ?? null;
    const saved = input.saved.geometry?.page;
    const lineage = saved?.before === before ? saved.lineage : [before];
    publish({ pages: [input.initial], bridge: [], lineage });
  }, [input.initial, input.complete, input.saved, publish, scope]);
  const load = useCallback(async (direction: Direction, options?: { desktopTransport: "main" }, rejectCancelled = false): Promise<void> => {
    if (direction === "latest" && scope.request && scope.active && currentScope.current === scope) {
      scope.request.abort();
      await client.cancelQueries({ queryKey: pageKey });
      scope.request = null;
    }
    const state = scope.state;
    if (!state || !scope.active || currentScope.current !== scope || scope.request || input.complete) return;
    const oldest = state.pages[0];
    const newest = state.pages[state.pages.length - 1];
    const newestIndex = state.lineage.indexOf(newest.pagination.before ?? null);
    const before = direction === "latest" ? null : direction === "older" ? oldest.pagination.nextCursor
      : direction === "refresh" ? newest.pagination.before ?? null
        : state.bridge.length ? state.bridge[0].pagination.nextCursor
          : newestIndex > 0 ? state.lineage[newestIndex - 1] : undefined;
    if (before === undefined || direction === "older" && before === null
      || direction === "newer" && newest.pagination.before === undefined && !state.bridge.length) return;
    const limit = newest.pagination.limit;
    const baseline = client.getQueryData<LatestSessionHistory>(historyKey)?.messages ?? EMPTY;
    const sourceBefore = new Map(readSource().map((message) => [message.id, message]));
    const controller = new AbortController();
    scope.request = controller;
    scope.failed = null;
    setStatus({ scope, pending: true, failed: false });
    try {
      const queryKey = [...pageKey, before, limit];
      let readSignal: AbortSignal | undefined;
      const snapshot = await readSessionHistoryPage(client, {
        queryKey, signal: controller.signal, sessionId: input.sessionId,
        read: (signal) => {
          readSignal = signal;
          return input.readSnapshot(signal, { limit, ...(before === null ? {} : { before }) }, options);
        },
      });
      if (rejectCancelled && readSignal?.aborted) throw new CancelledError();
      if (currentScope.current !== scope || !scope.active) return;
      if (!isPage(snapshot) || (snapshot.pagination.before ?? null) !== before
        || snapshot.pagination.nextCursor !== null && (snapshot.pagination.nextCursor === before
          || (direction === "older" || direction === "newer")
            && [...state.pages, ...state.bridge].some((page) => page.pagination.before === snapshot.pagination.nextCursor)
            && (direction === "older" || snapshot.pagination.nextCursor !== newest.pagination.before))) {
        throw new Error("Conversation pagination did not advance. Retry loading history.");
      }
      if (direction === "latest") {
        scope.baseline = sourceBefore;
        publish({ pages: [snapshot], bridge: [], lineage: [null] }, true, baseline, [snapshot], sourceBefore);
      } else if (direction === "older") {
        if (state.pages.some((page) => (page.pagination.before ?? null) === before)) throw new Error("Conversation pagination repeated a page.");
        publish({ ...state, pages: [snapshot, ...state.pages], lineage: [...state.lineage, before] }, false, baseline, [snapshot]);
      } else if (direction === "refresh") {
        if (!snapshot.session.revert && snapshot.pagination.nextCursor !== newest.pagination.nextCursor && newest.messages.length > 0
          && snapshot.messages.length > 0 && !snapshot.messages.some((message) => newest.messages.some((prior) => prior.info.id === message.info.id))) {
          const sticky = getSessionScrollState(useSessionScrollStore.getState().sessions, input.sessionId, input.owner).mode === "stickyBottom";
          if (sticky && snapshot.pagination.before === undefined) {
            scope.baseline = sourceBefore;
            publish({ pages: [snapshot], bridge: [], lineage: [null] }, true, baseline, [snapshot], sourceBefore);
          } else {
            scope.expiredPositions.add(newest);
            publish({ ...state, bridge: [snapshot] }, false, baseline, []);
          }
        } else {
          publish({ ...state, pages: [...state.pages.slice(0, -1), snapshot] }, false, baseline, [snapshot]);
        }
      } else {
        const bridge = [snapshot, ...state.bridge];
        const overlap = snapshot.messages.some((message) => newest.messages.some((current) => current.info.id === message.info.id));
        if (snapshot.pagination.nextCursor === newest.pagination.before || overlap || snapshot.pagination.nextCursor === null) {
          const start = state.lineage.indexOf(bridge.at(-1)?.pagination.before ?? null);
          const lineage = [...state.lineage.slice(0, Math.max(0, start)), ...bridge.toReversed().map((page) => page.pagination.before ?? null),
            ...state.lineage.slice(newestIndex)];
          publish({ pages: [...state.pages, ...bridge], bridge: [], lineage: [...new Set(lineage)] }, false, baseline, bridge);
        } else {
          if (bridge.slice(1).some((page) => page.pagination.before === snapshot.pagination.nextCursor)) throw new Error("Conversation pagination repeated a page.");
          publish({ ...state, bridge }, false, baseline, []);
        }
      }
    } catch (error) {
      if (!(error instanceof CancelledError) && !controller.signal.aborted && scope.active && currentScope.current === scope) {
        scope.failed = direction;
        setStatus({ scope, pending: false, failed: true });
        throw error;
      }
      if (rejectCancelled) throw error;
    } finally {
      if (scope.request === controller) {
        scope.request = null;
        if (scope.active && currentScope.current === scope && scope.failed === null) setStatus({ scope, pending: false, failed: false });
      }
      if (scope.refreshPending && !scope.request && scope.active && currentScope.current === scope) {
        scope.refreshPending = false;
        queueMicrotask(() => {
          if (scope.active && currentScope.current === scope) void loadRef.current("refresh").catch(() => undefined);
        });
      }
    }
  }, [client, historyKey, pageKey, input.complete, input.owner, input.readSnapshot, input.sessionId, publish, readSource, scope]);
  const refreshForStop = useCallback(async (options?: { desktopTransport: "main" }) => {
    if (!scope.active || currentScope.current !== scope) throw new CancelledError();
    const pending = scope.request;
    pending?.abort();
    await client.cancelQueries({ queryKey: pageKey });
    if (!scope.active || currentScope.current !== scope) throw new CancelledError();
    if (scope.request === pending) scope.request = null;
    const before = scope.state;
    await load("refresh", options, true);
    if (!scope.active || currentScope.current !== scope || scope.state === before || !scope.snapshot) throw new CancelledError();
    return scope.snapshot;
  }, [client, load, pageKey, scope]);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let previous = client.getQueryData<LatestSessionHistory>(historyKey);
    const historyHash = hashKey(historyKey);
    const sourceHash = input.transcriptQueryKey ? hashKey(input.transcriptQueryKey) : null;
    const fullHash = hashKey(input.snapshotQueryKey);
    return client.getQueryCache().subscribe((event) => {
      if (!scope.active || currentScope.current !== scope || !scope.state || event.type !== "updated") return;
      if (event.query.queryHash === fullHash && event.action.type === "invalidate" && !input.complete) {
        event.query.setState({ isInvalidated: false });
        if (scope.request) scope.refreshPending = true;
        else void loadRef.current("refresh").catch(() => undefined);
      }
      if (event.action.type !== "success") return;
      if (event.query.queryHash === historyHash) {
        const next = client.getQueryData<LatestSessionHistory>(historyKey);
        const ids = new Set(next?.messages.map((message) => message.id));
        const removed = previous?.messages.filter((message) => !ids.has(message.id)) ?? [];
        previous = next;
        if (removed.length && !scope.hydrating) {
          for (const message of removed) scope.removed.add(nativeId(message.id));
          scope.request?.abort();
          void client.cancelQueries({ queryKey: pageKey });
          publish(scope.state, false, EMPTY, []);
        }
      } else if (event.query.queryHash === sourceHash && !scope.hydrating) {
        const state = scope.state;
        const newest = state.pages.at(-1)?.pagination.before === undefined && state.bridge.length === 0;
        const ids = scope.ids;
        client.setQueryData<LatestSessionHistory>(historyKey, (current) => {
          if (!current) return current;
          const next = applyHistorySourceChanges(current, readSource());
          return { ...next, messages: next.messages.filter((message) => keep(message.id) && (ids.has(nativeId(message.id))
            || newest && !scope.baseline.has(message.id))) };
        });
      }
    });
  }, [client, historyKey, pageKey, input.complete, input.snapshotQueryKey, input.transcriptQueryKey, keep, publish, readSource, scope]);
  const seedSnapshot = useCallback((seed: () => void) => {
    scope.hydrating = true;
    try {
      seed();
      client.setQueryData<LatestSessionHistory>(historyKey, (current) => current ? { ...current, source: readSource() } : current);
    } finally { scope.hydrating = false; }
  }, [client, historyKey, readSource, scope]);
  const state = scope.state;
  const snapshot = useMemo(() => scope.snapshot && sessionPatch ? { ...scope.snapshot, session: { ...scope.snapshot.session, ...sessionPatch } } : scope.snapshot,
    [scope.snapshot, sessionPatch]);
  const complete = Boolean(state && state.pages[0].pagination.nextCursor === null && state.pages.at(-1)?.pagination.before === undefined && state.bridge.length === 0);
  const messages = useMemo(() => snapshot?.session.revert && !complete ? EMPTY
    : snapshot?.session.revert ? applyRevertCursor(history.data?.messages ?? EMPTY, snapshot.session.revert.messageID) : history.data?.messages,
  [complete, history.data?.messages, snapshot?.session.revert]);
  const pageForAnchor = useCallback((id: string) => scope.positions.get(nativeId(id)), [scope]);
  const savedAnchor = input.saved.mode === "manual" && input.saved.geometry?.page ? input.saved.anchor?.messageId : undefined;
  const anchorPending = Boolean(savedAnchor && state && !input.complete && !scope.restoreCancelled
    && !scope.ids.has(nativeId(savedAnchor)) && !scope.removed.has(nativeId(savedAnchor)) && state.pages[0].pagination.nextCursor !== null);
  useEffect(() => {
    if (anchorPending && !scope.request && !scope.failed) void load("older").catch(() => undefined);
  }, [anchorPending, load, revision, scope, status]);
  const cancelRestore = useCallback(() => {
    if (scope.restoreCancelled) return;
    scope.restoreCancelled = true;
    render((value) => value + 1);
  }, [scope]);
  const readLatestForSend = useCallback(async (options?: { desktopTransport: "main" }) => {
    cancelRestore();
    await load("latest", options);
    if (!scope.active || currentScope.current !== scope) throw new CancelledError();
    const latest = scope.state?.pages.at(-1);
    if (!latest || latest.pagination.before !== undefined || scope.state?.bridge.length) throw new Error("Latest conversation history is unavailable.");
    return latest.messages;
  }, [cancelRestore, load, scope]);
  return {
    version: state,
    snapshot,
    messages,
    complete,
    ready: Boolean(snapshot),
    anchorPending,
    cancelRestore,
    readLatestForSend,
    refreshForStop,
    leadingHeight: state?.pages[0].pagination.before === input.initial?.pagination?.before
      && input.saved.mode === "manual" ? input.saved.geometry?.before ?? 0 : 0,
    trailingHeight: state && (state.pages.at(-1)?.pagination.before !== undefined || state.bridge.length > 0)
      ? Math.max(240, input.saved.geometry?.after ?? 0) : 0,
    hasOlder: Boolean(state && state.pages[0].pagination.nextCursor !== null),
    hasNewer: Boolean(state && (state.pages.at(-1)?.pagination.before !== undefined || state.bridge.length > 0)),
    loading: status?.scope === scope && status.pending,
    failed: status?.scope === scope && status.failed,
    load,
    retry: () => load(scope.failed ?? "refresh"),
    seedSnapshot,
    pageForAnchor,
  };
}
