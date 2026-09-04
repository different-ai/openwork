import { QueryClient } from "@tanstack/react-query";

type QueryClientGlobal = typeof globalThis & {
  __owReactQueryClient?: QueryClient;
};

export function getReactQueryClient(): QueryClient {
  const target = globalThis as QueryClientGlobal;
  if (target.__owReactQueryClient) return target.__owReactQueryClient;
  const queryClient = new QueryClient();

  queryClient.setQueryDefaults(["react-session-transcript"], { gcTime: 15_000 });

  // Pending permissions and questions are written with setQueryData only and
  // observed through a raw cache subscription, so the query has zero
  // observers and TanStack GC removes it ~15s after creation. That made the
  // permission dialog auto-dismiss with no resolution while the tool call
  // stayed "running" forever (#1916). They are cleared explicitly by
  // permission.replied / question.answered events and clearTrackedSession,
  // never by GC.
  //
  // Run status is in the same class: while the session route is unmounted
  // (e.g. a Settings visit) the SSE sync keeps writing the tiny busy/idle
  // entry with zero observers, so GC deleted the busy flag and a still-live
  // run rendered as idle on return. Status entries are cleared by
  // clearTrackedSession, never by GC.
  //
  // Todos too: written by todo.updated events, read through the same raw
  // cache subscription, so the todo progress panel above the composer
  // vanished ~15s after the first todowrite (setData never reschedules GC).
  // Cleared by clearTrackedSession.
  for (const queryKey of [
    ["react-session-status"],
    ["react-session-permissions"],
    ["react-session-questions"],
    ["react-session-todos"],
  ] as const) {
    queryClient.setQueryDefaults(queryKey, { gcTime: Infinity });
  }

  target.__owReactQueryClient = queryClient;
  return target.__owReactQueryClient;
}
