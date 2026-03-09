import { describe, expect, test } from "bun:test";
import { FileSessionStore } from "./file-sessions.js";

describe("FileSessionStore", () => {
  test("creates, renews, and closes sessions", () => {
    const store = new FileSessionStore({ maxSessions: 10 });
    const created = store.create({
      workspaceId: "ws_1",
      workspaceRoot: "/tmp/ws",
      actorTokenHash: "tok_1",
      actorScope: "collaborator",
      canWrite: true,
      ttlMs: 60_000,
    });

    const fetched = store.get(created.id);
    expect(fetched?.workspaceId).toBe("ws_1");
    expect(fetched?.canWrite).toBe(true);

    const createdExpiry = created.expiresAt;
    const renewed = store.renew(created.id, 120_000);
    expect(renewed).not.toBeNull();
    expect((renewed?.expiresAt ?? 0) > createdExpiry).toBe(true);

    const closed = store.close(created.id);
    expect(closed).toBe(true);
    expect(store.get(created.id)).toBeNull();
  });

  test("records and paginates workspace events", () => {
    const store = new FileSessionStore({ maxEventsPerWorkspace: 5 });

    store.recordWorkspaceEvent({ workspaceId: "ws_1", type: "write", path: "notes/a.md", revision: "1" });
    store.recordWorkspaceEvent({ workspaceId: "ws_1", type: "mkdir", path: "notes" });
    store.recordWorkspaceEvent({ workspaceId: "ws_1", type: "rename", path: "notes/a.md", toPath: "notes/b.md" });

    const fromStart = store.listWorkspaceEvents("ws_1", 0);
    expect(fromStart.items.length).toBe(3);
    expect(fromStart.cursor).toBe(3);

    const fromSecond = store.listWorkspaceEvents("ws_1", 2);
    expect(fromSecond.items.length).toBe(1);
    expect(fromSecond.items[0]?.type).toBe("rename");
  });
});
