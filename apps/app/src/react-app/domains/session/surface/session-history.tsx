import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { queryOptions, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import type { OpenworkSessionSnapshot } from "@/app/lib/openwork-server";
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "@/app/types";
import { getSessionScrollState, useSessionScrollStore, type SessionScrollState } from "./scroll-store";

export type OpeningHistoryWindow = { limit?: number; messageIds?: readonly string[] };

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

export function useOpeningSessionHistory(input: {
  owner: string;
  sessionId: string;
  snapshotQueryKey: readonly unknown[];
  readSnapshot: (signal: AbortSignal, window?: OpeningHistoryWindow) => Promise<OpenworkSessionSnapshot>;
}) {
  const client = useQueryClient();
  const hasLegacyPosition = useSessionScrollStore((state) => Boolean(state.sessions[input.sessionId]));
  const saved = useMemo(() => {
    return getSessionScrollState(useSessionScrollStore.getState().sessions, input.sessionId, input.owner);
  }, [input.owner, input.sessionId, hasLegacyPosition]);
  const hasFullSnapshot = client.getQueryData<OpenworkSessionSnapshot>(input.snapshotQueryKey)?.session.id === input.sessionId;
  const options = queryOptions({
    queryKey: ["react-session-opening", input.owner],
    queryFn: async ({ signal }): Promise<{ snapshot: OpenworkSessionSnapshot | null }> => {
      try {
        return { snapshot: await input.readSnapshot(signal, openingHistoryWindow(saved)) };
      } catch {
        signal.throwIfAborted();
        // A preview is optional (e.g. a deleted anchor or an older server).
        // The uncapped authoritative query owns errors and the retry UI.
        return { snapshot: null };
      }
    },
    staleTime: Infinity,
    gcTime: 15_000,
    retry: false,
    networkMode: "always",
  });
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

type OpeningOptions = ReturnType<typeof useOpeningSessionHistory>["options"];

function AwaitOpeningHistory({ options, saved }: { options: OpeningOptions; saved: SessionScrollState }) {
  useSuspenseQuery(options);
  return <SessionHistoryLoading saved={saved} />;
}

export function SessionHistoryLoading({ saved }: { saved: SessionScrollState }) {
  const height = Math.max(200, (saved.geometry?.scrollHeight ?? 232) - 32);
  const top = saved.mode === "manual" ? Math.min(saved.scrollTop + 64, height - 120) : Math.max(64, height - 200);
  return <div data-thread-loading role="status" aria-live="polite" aria-label="Loading conversation" style={{ minHeight: height }}>
    <div className="flex items-center justify-center gap-2 text-sm text-dls-secondary" style={{ paddingTop: Math.max(32, top) }}>
      <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" />
      <span>{saved.mode === "manual" ? "Returning to your reading position…" : "Loading latest messages…"}</span>
    </div>
  </div>;
}

export function SessionHistoryBoundary({ owner, pending, options, saved, onRetry, children }: {
  owner: string;
  pending: boolean;
  options: OpeningOptions;
  saved: SessionScrollState;
  onRetry?: () => void;
  children: ReactNode;
}) {
  return <Suspense key={owner} fallback={<SessionHistoryLoading saved={saved} />}>
    {onRetry ? <div role="alert" className="flex items-center justify-center gap-3 py-3 text-xs text-dls-secondary">
      <span>The rest of this conversation could not be loaded.</span>
      <button type="button" className="underline" onClick={onRetry}>Retry</button>
    </div> : null}
    {pending ? (onRetry ? null : <AwaitOpeningHistory options={options} saved={saved} />) : children}
  </Suspense>;
}
