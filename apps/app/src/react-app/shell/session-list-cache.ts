import { useEffect } from "react";
import { getReactQueryClient } from "../infra/query-client";

const SESSION_LIST_KEY = ["workspace-session-list"] as const;

export function sessionListQueryKey(workspaceId: string) {
  return [...SESSION_LIST_KEY, workspaceId] as const;
}

export function sessionListQueryKeyPattern() {
  return { queryKey: SESSION_LIST_KEY, exact: false };
}

export function cacheSessionList(workspaceId: string, sessions: unknown[]) {
  getReactQueryClient().setQueryData(sessionListQueryKey(workspaceId), sessions);
}

export function invalidateSessionLists() {
  getReactQueryClient().invalidateQueries(sessionListQueryKeyPattern());
}

export function isTabVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/**
 * Sets up a visibility-aware polling loop that invalidates workspace session
 * lists at a fixed interval so that sessions created externally (by automations,
 * messaging bots like Slack/Telegram, or other clients) appear in the sidebar
 * without requiring manual refresh.  Only fires when the browser tab is visible
 * to avoid unnecessary network requests while the user is working elsewhere.
 *
 * The `refetch` callback is responsible for performing the actual fetch and
 * writing results into both the TanStack Query cache and the imperative state
 * used by the sidebar.  The existing `refreshInFlightRef` guard in the caller
 * prevents overlapping fetches.
 *
 * Fixes [#1262]{@link https://github.com/different-ai/openwork/issues/1262}
 */
export function useSessionListPolling(
  refetch: () => void | Promise<void>,
  intervalMs: number = 30_000,
) {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const tick = () => {
      if (!isTabVisible()) return;
      void refetch();
    };

    const id = window.setInterval(tick, intervalMs);

    // Listen for visibility changes so we can fire an immediate fetch when
    // the tab comes back into view, instead of waiting for the next interval.
    const onVisibility = () => {
      if (isTabVisible()) {
        void refetch();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refetch, intervalMs]);
}
