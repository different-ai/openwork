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
 * used by the sidebar.  The caller is responsible for providing its own
 * in-flight guard so two ticks (or a tick that races with another refresh
 * path) cannot overlap.
 *
 * Visibility restore is intentionally NOT handled here: callers in this
 * codebase already wire up a `visibilitychange` listener that runs a heavier
 * route-level refresh, and firing `refetch` from here as well caused two
 * concurrent session-list refreshes on every tab focus.
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

    return () => {
      window.clearInterval(id);
    };
  }, [refetch, intervalMs]);
}
