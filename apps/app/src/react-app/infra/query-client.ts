import { QueryClient } from "@tanstack/react-query";

type QueryClientGlobal = typeof globalThis & {
  __owReactQueryClient?: QueryClient;
};

export function getReactQueryClient(): QueryClient {
  const target = globalThis as QueryClientGlobal;
  if (target.__owReactQueryClient) return target.__owReactQueryClient;
  const queryClient = new QueryClient();

  // Every per-session cache below is written with setQueryData from the
  // module-singleton SSE sync (session-sync.ts) and may have zero observers
  // while the session route is unmounted. TanStack schedules GC when a query
  // is created and when its last observer leaves, and `Query.setData` never
  // reschedules it, so continued live writes do NOT keep such a query alive:
  // it is deleted gcTime after the last observer left, and the next write
  // recreates it from scratch. Cleanup of these caches is owned by the
  // tracked-session lifecycle (clearTrackedSession), never by GC.
  //
  // Transcript: the streamed UIMessage[] for a session that keeps running in
  // the background after the user switches away. With a bounded gcTime the
  // cache was wiped ~15s after leaving; the next delta flush rebuilt it from
  // [] without the in-flight text part, so every later delta was parked in
  // pendingDeltas (invisible). On return the pane rendered the server read
  // as of that instant and then froze, only "finishing" when the terminal
  // message.part.updated arrived with the full text.
  //
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
    ["react-session-transcript"],
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
