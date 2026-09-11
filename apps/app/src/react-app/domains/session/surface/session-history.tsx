import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import type { OpenworkSessionSnapshot } from "@/app/lib/openwork-server";
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "@/app/types";
import { snapshotKey } from "../sync/session-sync";
import { composerAutoSendScopeKey } from "./composer-auto-send";
import { getSessionScrollState, useSessionScrollStore, type SessionScrollState } from "./scroll-store";

export type OpeningHistoryWindow = { limit?: number; messageIds?: readonly string[] };

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
  snapshotQueryKey: readonly unknown[];
  readSnapshot: (signal: AbortSignal, window?: OpeningHistoryWindow) => Promise<OpenworkSessionSnapshot>;
};

// Opaque, bounded credential identities keep secrets out of query keys and
// prevent an in-flight speculative read surviving a credential change as a hit.
const openingCredentials = new Map<string | null, number>();
let nextOpeningCredential = 0;

export function openingSessionHistoryOptions(input: OpeningHistoryInput, saved = getSessionScrollState(
  useSessionScrollStore.getState().sessions, input.sessionId, input.owner,
)) {
  const token = input.authToken ?? null;
  let credential = openingCredentials.get(token);
  if (credential === undefined) {
    credential = ++nextOpeningCredential;
    openingCredentials.set(token, credential);
    if (openingCredentials.size > 32) openingCredentials.delete(openingCredentials.keys().next().value ?? null);
  }
  return queryOptions({
    queryKey: ["react-session-opening", input.owner, credential],
    queryFn: async ({ signal }): Promise<{ snapshot: OpenworkSessionSnapshot | null }> => {
      try {
        const snapshot = await input.readSnapshot(signal, openingHistoryWindow(saved));
        signal.throwIfAborted();
        if (snapshot.session.id !== input.sessionId) throw new Error("Conversation history belongs to another session.");
        return { snapshot };
      } catch {
        signal.throwIfAborted();
        // A preview is optional (e.g. a deleted anchor or an older server).
        // The uncapped authoritative query owns errors and the retry UI.
        return { snapshot: null };
      }
    },
    staleTime: (query) => query.state.data?.snapshot ? Infinity : 0,
    gcTime: 15_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    networkMode: "always",
  });
}

export function prefetchOpeningSessionHistory(client: QueryClient, input: OpeningHistoryInput) {
  if (client.getQueryData<OpenworkSessionSnapshot>(input.snapshotQueryKey)?.session.id === input.sessionId) return;
  // No queue and no neighboring reads: only one speculative opening at a time.
  if (client.isFetching({ queryKey: ["react-session-opening"] })) return;
  const options = openingSessionHistoryOptions(input);
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

export function useOpeningSessionHistory(input: OpeningHistoryInput) {
  const client = useQueryClient();
  const hasLegacyPosition = useSessionScrollStore((state) => Boolean(state.sessions[input.sessionId]));
  const saved = useMemo(() => {
    return getSessionScrollState(useSessionScrollStore.getState().sessions, input.sessionId, input.owner);
  }, [input.owner, input.sessionId, hasLegacyPosition]);
  const hasFullSnapshot = client.getQueryData<OpenworkSessionSnapshot>(input.snapshotQueryKey)?.session.id === input.sessionId;
  const options = openingSessionHistoryOptions(input, saved);
  const query = useQuery({ ...options, enabled: !hasFullSnapshot });
  const activeOwner = useRef<string | null>(input.owner);
  activeOwner.current = input.owner;
  useEffect(() => {
    activeOwner.current = input.owner;
    return () => { activeOwner.current = null; };
  }, [input.owner]);
  const ensureFullSnapshot = useCallback(() => client.ensureQueryData({
    queryKey: input.snapshotQueryKey,
    queryFn: ({ signal }) => input.readSnapshot(signal),
    networkMode: "always",
  }), [client, input.snapshotQueryKey, input.readSnapshot]);
  const runWithFullSnapshot = useCallback(async (
    action: (snapshot: OpenworkSessionSnapshot) => void | Promise<unknown>,
    options: { fresh?: boolean } = {},
  ) => {
    if (activeOwner.current !== input.owner) return;
    const snapshot = await (options.fresh ? client.fetchQuery({
      // Branch must not join an older opening/send read or trust cached history.
      // Concurrent branches share this uncapped read and its response boundary.
      queryKey: ["react-session-branch-history", input.owner],
      queryFn: ({ signal }) => input.readSnapshot(signal),
      staleTime: 0,
      gcTime: 15_000,
      networkMode: "always",
    }) : ensureFullSnapshot());
    if (activeOwner.current !== input.owner) return;
    if (snapshot.session.id !== input.sessionId) throw new Error("Conversation history belongs to another session.");
    await action(snapshot);
  }, [client, ensureFullSnapshot, input.owner, input.sessionId, input.readSnapshot]);
  const [backgroundOwner, setBackgroundOwner] = useState<string | null>(null);
  useEffect(() => {
    if (!query.isSuccess || hasFullSnapshot) return;
    // Let the relevant messages paint before full-history JSON/React work starts.
    let second: number | undefined;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => setBackgroundOwner(input.owner));
    });
    return () => {
      window.cancelAnimationFrame(first);
      if (second !== undefined) window.cancelAnimationFrame(second);
    };
  }, [input.owner, query.isSuccess, hasFullSnapshot]);
  return {
    saved,
    options,
    snapshot: hasFullSnapshot ? null : query.data?.snapshot ?? null,
    backgroundReady: hasFullSnapshot || backgroundOwner === input.owner,
    ensureFullSnapshot,
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

export function SessionHistoryStatus({ complete, pending, failed, onRetry }: {
  complete: boolean;
  pending: boolean;
  failed: boolean;
  onRetry: () => Promise<unknown>;
}) {
  const [retrying, setRetrying] = useState(false);
  const retryPending = useRef(false);
  if (complete || (pending && !failed && !retrying)) return null;
  return <div data-thread-history-status className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
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
