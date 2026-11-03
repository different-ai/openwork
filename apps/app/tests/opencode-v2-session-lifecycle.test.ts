import { afterEach, describe, expect, test } from "bun:test";
import {
  createClientV2,
  createV2EventTranslationState,
  engineCanArchive,
  translateV2Event,
  V2_SESSION_ARCHIVE_UNAVAILABLE,
} from "../src/app/lib/opencode-v2-adapter";

const origin = "http://127.0.0.1:9";
const base = `${origin}/workspace/ws_1/opencode2`;
const originalFetch = globalThis.fetch;

function serve(handler: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return handler(request);
    },
  });
  return requests;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenCode v2 session lifecycle", () => {
  test("a turn's idle marker never shows as a message", async () => {
    serve(() => Response.json({
      data: [
        { id: "msg_user", sessionID: "ses_1", type: "user", text: "Hi", time: { created: 1 } },
        { id: "msg_reply", sessionID: "ses_1", type: "assistant", content: [{ type: "text", text: "Hello" }], time: { created: 2, completed: 3 } },
        { id: "msg_idle", sessionID: "ses_1", type: "idle", outcome: "succeeded", time: { created: 4 } },
      ],
    }));
    const client = createClientV2(base, "/tmp/ws", { token: "t" });

    const result = await client.session.messages({ sessionID: "ses_1" });

    expect(result.data?.map((message) => message.info.id)).toEqual(["msg_user", "msg_reply"]);
  });

  test("archiving sends the engine's archived flag and reads the session back", async () => {
    let archived: number | null = null;
    const requests = serve(async (request) => {
      if (new URL(request.url).pathname.endsWith("/api/info")) return Response.json({ version: "2.2.0", pid: 1 });
      if (request.method === "PATCH") {
        const body: unknown = await request.json();
        archived = typeof body === "object" && body !== null && Reflect.get(body, "archived") === true ? 500 : null;
        return new Response(null, { status: 204 });
      }
      return Response.json({ data: { id: "ses_1", time: { created: 1, updated: archived ?? 2, ...(archived ? { archived } : {}) } } });
    });
    const client = createClientV2(`${origin}/workspace/ws_current/opencode2`, "/tmp/ws", { token: "t" });

    const archive = await client.session.update({ sessionID: "ses_1", time: { archived: 123 } });
    const restore = await client.session.update({ sessionID: "ses_1", time: { archived: 0 } });

    const patches = requests.filter((request) => request.method === "PATCH");
    expect(await Promise.all(patches.map((request) => request.json()))).toEqual([{ archived: true }, { archived: false }]);
    expect(new URL(patches[0].url).pathname).toBe("/workspace/ws_current/opencode2/api/session/ses_1");
    expect(archive.data?.time.archived).toBe(500);
    expect(restore.data?.time.archived).toBeUndefined();
  });

  test("an engine before 2.1 keeps copied archive times active and reports Archive as unavailable", async () => {
    serve((request) => {
      if (new URL(request.url).pathname.endsWith("/api/info")) return Response.json({ version: "2.0.26", pid: 1 });
      // 2.0 accepts `archived` and ignores it; a v1 archive time may still be on the row.
      return request.method === "PATCH"
        ? new Response(null, { status: 204 })
        : Response.json({ data: { id: "ses_1", time: { created: 1, updated: 2, archived: 3 } } });
    });
    const client = createClientV2(`${origin}/workspace/ws_older/opencode2`, "/tmp/ws", { token: "t" });

    const opened = await client.session.get({ sessionID: "ses_1" });
    const archive = await client.session.update({ sessionID: "ses_1", time: { archived: 123 } });

    expect(opened.data?.time).toEqual({ created: 1, updated: 2 });
    expect(archive.data).toBeUndefined();
    expect(archive.error).toMatchObject({ message: V2_SESSION_ARCHIVE_UNAVAILABLE });
  });

  test("archiving needs OpenCode 2.1 or newer", () => {
    expect(["2.0.26", "2.0.32", "2.1.0", "2.2.0", "3.0.0", "v2", ""].map(engineCanArchive))
      .toEqual([false, false, true, true, true, false, false]);
    expect(engineCanArchive(undefined)).toBe(false);
  });

  test("lists a session's sub-agent sessions across pages", async () => {
    const requests = serve((request) => {
      const url = new URL(request.url);
      return Response.json(url.searchParams.get("cursor")
        ? { data: [{ id: "ses_b", parentID: "ses_root", time: { created: 3 } }], cursor: { next: null } }
        : {
          data: [
            { id: "ses_a", parentID: "ses_root", time: { created: 2 } },
            { id: "ses_other", parentID: "ses_elsewhere", time: { created: 2 } },
          ],
          cursor: { next: "page2" },
        });
    });
    const client = createClientV2(base, "/tmp/ws", { token: "t" });

    const result = await client.session.children({ sessionID: "ses_root" });

    expect(result.data?.map((session) => session.id)).toEqual(["ses_a", "ses_b"]);
    expect(new URL(requests[0].url).searchParams.get("parentID")).toBe("ses_root");
  });

  test("archive and restore events update the session's times", () => {
    const state = createV2EventTranslationState();
    const durable = { aggregateID: "ses_1", seq: 7, version: 1 };

    expect(translateV2Event({ type: "session.archived", durable, created: 900, data: { sessionID: "ses_1" } }, state))
      .toEqual([{ type: "session.updated", properties: { info: { id: "ses_1", time: { updated: 900, archived: 900 } } } }]);
    expect(translateV2Event({ type: "session.unarchived", durable: { ...durable, seq: 8 }, created: 950, data: { sessionID: "ses_1" } }, state))
      .toEqual([{ type: "session.updated", properties: { info: { id: "ses_1", time: { updated: 950, archived: 0 } } } }]);
  });

  test("a session whose folder was deleted does not hide other sessions' approvals", async () => {
    serve((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/api/session")) return Response.json({ data: [{ id: "ses_gone" }, { id: "ses_here" }] });
      if (path.endsWith("/ses_gone/permission")) {
        return Response.json({ _tag: "LocationNotFoundError", message: "Location not found: /deleted/worktree" }, { status: 404 });
      }
      return Response.json({ data: [{ id: "per_1", sessionID: "ses_here", action: "bash", resources: ["ls"] }] });
    });
    const client = createClientV2(base, "/tmp/ws", { token: "t" });

    const result = await client.permission.list({ directory: "/tmp/ws" });

    expect(result.error).toBeUndefined();
    expect(result.data?.map((permission) => permission.id)).toEqual(["per_1"]);
  });
});
