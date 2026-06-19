import { QueryClient } from "@tanstack/react-query";

type QueryClientGlobal = typeof globalThis & {
  __owReactQueryClient?: QueryClient;
};

export function getReactQueryClient(): QueryClient {
  const target = globalThis as QueryClientGlobal;
  if (target.__owReactQueryClient) return target.__owReactQueryClient;
  const queryClient = new QueryClient();

  for (const queryKey of [
    ["react-session-transcript"],
    ["react-session-status"],
    ["react-session-todos"],
  ] as const) {
    queryClient.setQueryDefaults(queryKey, { gcTime: 15_000 });
  }

  // Pending permissions and questions are written with setQueryData only and
  // observed through a raw cache subscription, so the query has zero
  // observers and TanStack GC removes it ~15s after creation. That made the
  // permission dialog auto-dismiss with no resolution while the tool call
  // stayed "running" forever (#1916). They are cleared explicitly by
  // permission.replied / question.answered events and clearTrackedSession,
  // never by GC.
  for (const queryKey of [
    ["react-session-permissions"],
    ["react-session-questions"],
  ] as const) {
    queryClient.setQueryDefaults(queryKey, { gcTime: Infinity });
  }

  target.__owReactQueryClient = queryClient;
  return target.__owReactQueryClient;
}
