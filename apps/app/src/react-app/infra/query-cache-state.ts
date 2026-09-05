import { useMemo, useSyncExternalStore } from "react";

import { getReactQueryClient } from "./query-client";

/**
 * Subscribe to a TanStack Query cache entry as plain external state.
 * Pass a null key to pin the fallback (used while route params are missing).
 */
export function useQueryCacheState<T>(queryKey: readonly unknown[] | null, fallback: T): T {
  const queryClient = getReactQueryClient();
  return useSyncExternalStore(
    (callback) => (queryKey ? queryClient.getQueryCache().subscribe(callback) : () => {}),
    () => (queryKey ? queryClient.getQueryData<T>(queryKey) ?? fallback : fallback),
    () => fallback,
  );
}

/**
 * Subscribe to several array-valued cache entries as one stable array. This is
 * useful for a selected session plus a dynamic set of child sessions, where
 * calling one hook per child would violate React's fixed hook ordering.
 */
export function useQueryCacheArrayState<T>(
  queryKeys: readonly (readonly unknown[])[],
  fallback: T[],
): T[] {
  const queryClient = getReactQueryClient();
  const getSnapshot = useMemo(() => {
    let previousEntries: T[][] = [];
    let previousValue = fallback;

    return () => {
      const entries = queryKeys.map((queryKey) => queryClient.getQueryData<T[]>(queryKey) ?? fallback);
      if (
        entries.length === previousEntries.length &&
        entries.every((entry, index) => entry === previousEntries[index])
      ) {
        return previousValue;
      }
      previousEntries = entries;
      previousValue = entries.flat();
      return previousValue;
    };
  }, [fallback, queryClient, queryKeys]);

  return useSyncExternalStore(
    (callback) => queryClient.getQueryCache().subscribe(callback),
    getSnapshot,
    () => fallback,
  );
}
