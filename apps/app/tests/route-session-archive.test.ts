import { describe, expect, test } from "bun:test";
import { createRouteArchiveReconciler } from "../src/react-app/shell/route-session-archive";
import type { RouteSession } from "../src/react-app/shell/route-workspaces";

function session(archived: number, updated: number): RouteSession {
  return {
    id: "ses_example", slug: "example", directory: "/example", projectID: "project", title: "Example title", version: "1",
    time: { created: 1, updated, archived },
  };
}

describe("route archive reconciliation", () => {
  test("an in-flight inventory cannot overwrite a confirmed archive or Undo", () => {
    const changes = createRouteArchiveReconciler();
    const originalRead = changes.revision();
    changes.confirm("ws", "ses_example", 10, 2);
    const staleList = { ...session(0, 2), title: "Changed title" };
    expect(changes.reconcile("ws", staleList, { listRevision: originalRead })).toEqual({ ...staleList, time: { ...staleList.time, archived: 10 } });
    expect(changes.reconcile("other", staleList, { listRevision: originalRead })).toBe(staleList);
    const readBeforeUndo = changes.revision();
    changes.confirm("ws", "ses_example", 0, 3);
    expect(changes.reconcile("ws", session(10, 2), { listRevision: readBeforeUndo }).time.archived).toBe(0);
    expect(changes.reconcile("ws", session(10, 2), { listRevision: changes.revision() }).time.archived).toBe(0);
  });

  test("replayed metadata retains archive state without dropping unrelated fields", () => {
    const changes = createRouteArchiveReconciler();
    changes.confirm("ws", "ses_example", 10, 3);
    const staleEvent = { ...session(0, 2), title: "Renamed session" };
    expect(changes.reconcile("ws", staleEvent, { eventUpdated: 2 })).toMatchObject({ title: "Renamed session", time: { archived: 10 } });
    expect(changes.reconcile("ws", staleEvent, {}).time.archived).toBe(10);
    const newerEvent = session(0, 4);
    expect(changes.reconcile("ws", newerEvent, { eventUpdated: 4 })).toBe(newerEvent);
    expect(changes.reconcile("ws", session(10, 3), { eventUpdated: 3 }).time.archived).toBe(0);
    expect(changes.reconcile("ws", session(10, 3), { listRevision: changes.revision() }).time.archived).toBe(0);
  });

  test("a fresh inventory accepts an external change using the same update timestamp", () => {
    const changes = createRouteArchiveReconciler();
    changes.confirm("ws", "ses_example", 10, 3);
    const currentServerSession = session(0, 3);
    expect(changes.reconcile("ws", currentServerSession, { listRevision: changes.revision() })).toBe(currentServerSession);
    expect(changes.reconcile("ws", session(10, 3), { eventUpdated: 3 }).time.archived).toBe(0);
  });
});
