import { describe, expect, test } from "bun:test";

import { getReactQueryClient } from "../src/react-app/infra/query-client";

// These caches are written with setQueryData from the module-singleton SSE
// sync while their session route can be unmounted (zero observers), so
// TanStack GC would delete live state ~15s after the route unmounts:
// pending permissions/questions (#1916) and the run-status busy flag, which
// made a still-live run render as idle after a Settings visit, and the todo
// list behind the composer progress panel, which is read through the same
// raw cache subscription and vanished ~15s after the first todowrite. Their
// cleanup is owned by permission.replied / question.answered and
// clearTrackedSession.
describe("react-query gc defaults", () => {
  test("zero-observer live session state is exempt from gc", () => {
    const queryClient = getReactQueryClient();
    for (const queryKey of [
      ["react-session-status"],
      ["react-session-permissions"],
      ["react-session-questions"],
      ["react-session-todos"],
    ] as const) {
      expect(queryClient.getQueryDefaults(queryKey).gcTime).toBe(Infinity);
    }
  });

  test("bulky transcript cache (read via useQuery observer) stays gc-bounded", () => {
    const queryClient = getReactQueryClient();
    expect(queryClient.getQueryDefaults(["react-session-transcript"]).gcTime).toBe(15_000);
  });
});
