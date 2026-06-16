import { useSyncExternalStore } from "react";

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
