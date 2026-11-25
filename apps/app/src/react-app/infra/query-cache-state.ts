import { useMemo, useSyncExternalStore } from "react";

import type { QueryClient } from "@tanstack/react-query";

import { getReactQueryClient } from "./query-client";

export function useQueryCacheState<T>(queryKey: readonly unknown[] | null, fallback: T): T {
  const queryClient = getReactQueryClient();
  return useSyncExternalStore(
    (callback) => (queryKey ? queryClient.getQueryCache().subscribe(callback) : () => {}),
    () => (queryKey ? queryClient.getQueryData<T>(queryKey) ?? fallback : fallback),
    () => fallback,
  );
}

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

export function useQueryCacheSelection<T extends string | number | boolean | null>(
  select: (queryClient: QueryClient) => T,
  serverValue: T,
): T {
  const queryClient = getReactQueryClient();
  return useSyncExternalStore(
    (callback) => queryClient.getQueryCache().subscribe(callback),
    () => select(queryClient),
    () => serverValue,
  );
}
