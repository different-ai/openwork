import { createServer } from "node:http";
import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { currentTestEvidence } from "@openwork/test-evidence";

import { resolveWorkspaceEndpoint } from "../../apps/app/src/app/lib/workspace-endpoint.ts";
import {
  listRouteSessions,
  readRouteSessionsWithRetry,
  v2RouteSessionList,
  type RouteSession,
  toSessionGroups,
  type RouteWorkspace,
} from "../../apps/app/src/react-app/shell/route-workspaces.ts";
import {
  flattenSessionRows,
  MAX_SESSIONS_PREVIEW,
  partitionArchivedSessions,
  workspaceConversationCount,
} from "../../apps/app/src/react-app/domains/session/sidebar/utils.ts";

const LOCAL = "/synthetic/local";
const REMOTE = "/synthetic/remote";
type Engine = "v1" | "v2";
type Observation = { url: URL; auth: string | undefined; method: string | undefined };
type Reply = { body: unknown; status?: number } | null;

// Ownership inventory fixes a longstanding UX inconsistency, not a removed badge.
// Preview/group/pin state must not change the total; an absent load is not zero.
test("workspace counts require a complete healthy inventory and count unarchived roots independently of presentation", () => {
  const workspace: RouteWorkspace = { id: "inventory", name: "Inventory", path: LOCAL, workspaceType: "local", displayNameResolved: "Inventory" };
  const inventory: RouteSession[] = Array.from({ length: 9 }, (_, index) => ({
    id: `ses_${index}`, title: `Conversation ${index}`, slug: `conversation-${index}`,
    projectID: "synthetic", directory: workspace.path, version: "synthetic",
    time: { created: 1, updated: 1, archived: index === 8 ? 1 : 0 },
    ...(index === 7 ? { parentID: "missing-parent" } : {}),
  }));
  inventory.push({ ...inventory[8], id: "archived-child", parentID: "ses_0" });
  const groups = (loaded: boolean, loading = false, error: string | null = null) => toSessionGroups(
    [workspace, { ...workspace, id: "empty" }], { inventory, empty: [] },
    { inventory: error }, loading ? new Set([workspace.id]) : new Set(),
    loaded ? new Set([workspace.id, "empty"]) : new Set(),
  );
  expect(groups(false).map(workspaceConversationCount)).toEqual([undefined, undefined]);
  expect(workspaceConversationCount(groups(true, true)[0])).toBeUndefined();
  expect(workspaceConversationCount(groups(true, false, "Unavailable")[0])).toBeUndefined();
  expect(groups(true).map(workspaceConversationCount)).toEqual([7, 0]);
  const group = groups(true)[0];
  const pins = new Set(["ses_0", "ses_1"]);
  expect(flattenSessionRows(group.sessions, 3, new Set(), [], { exclude: pins })).toHaveLength(3);
  expect(flattenSessionRows(group.sessions, 100, new Set(), [], { exclude: pins })).toHaveLength(5);
  expect(workspaceConversationCount(group)).toBe(7);
  expect(partitionArchivedSessions(group.sessions).archived.map(session => session.id)).toEqual(["ses_8", "archived-child"]);
  expect(workspaceConversationCount({ ...group, sessions: group.sessions.map(session => session.id === "ses_0" ? { ...session, time: { archived: 1 } } : session) })).toBe(6);
  expect(workspaceConversationCount({ ...group, sessions: [{ id: "blank-parent", title: "Root", parentID: "  " }] })).toBe(1);
  currentTestEvidence()?.recordAssertionEvidence(
    "Workspace totals represent healthy loaded ownership inventory, never preview size or unknown zero",
    "Two workspace groups produced 7 and confirmed 0; unloaded, loading and failed inventory withheld the number. Pins changed previews from 3 to 5 without changing 7. Children were excluded, whitespace parent IDs remained roots, archive reduced only the owning total, and Archived retained both its root and child records.", true,
  );
});

function sessions(count: number, kind = "active", directory = LOCAL): RouteSession[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `ses_${kind}_${String(count - index).padStart(5, "0")}`,
    slug: `${kind}-${index}`,
    title: `Synthetic ${kind} ${index}`,
    projectID: "synthetic-project",
    version: "synthetic",
    directory,
    time: { created: 1, updated: 1_000_000 - index, ...(kind === "archived" ? { archived: 1 } : {}) },
    ...(kind === "child" ? { parentID: "ses_missing_parent" } : {}),
  }));
}

function directoryFor(request: Observation) {
  return request.url.pathname.startsWith("/remote/") ? REMOTE : LOCAL;
}

// Contracts checked against v1.18.18 and beta-19086, release run 33857761662:
// b09a74591cbd4d2ea1488e56177898a13f21278d, protocol/groups/session.ts and
// server/handlers/session.ts. v2 emits cursor.next for EVERY nonempty native
// page; OpenWork's proxy filters by real directory AFTER paging, retaining it.
function pageReply(engine: Engine, source: RouteSession[]) {
  const cursors = new Map<string, number>();
  return (request: Observation): Reply => {
    const limit = Number(request.url.searchParams.get("limit") ?? (engine === "v1" ? 100 : 50));
    if (engine === "v1") {
      return { body: source.filter((session) => session.directory === directoryFor(request)).slice(0, limit) };
    }
    const cursor = request.url.searchParams.get("cursor");
    const start = cursor === null ? 0 : cursors.get(cursor);
    if (start === undefined) return { status: 400, body: { code: "invalid_cursor" } };
    const page = source.slice(start, start + limit);
    const last = page.at(-1);
    const next = last ? Buffer.from(JSON.stringify({
      anchor: { id: last.id, time: last.time.updated, direction: "next" },
    })).toString("base64url") : undefined;
    if (next) cursors.set(next, start + page.length);
    return {
      body: {
        data: page.filter((session) => session.directory === directoryFor(request)).map(({ directory, ...session }) => ({
          ...session, location: { directory },
        })),
        cursor: next ? { next } : { previous: null, next: null },
      },
    };
  };
}

async function withWitness(
  engine: Engine,
  reply: (request: Observation, index: number) => Reply,
  run: (witness: {
    local: NonNullable<ReturnType<typeof resolveWorkspaceEndpoint>>;
    remote: NonNullable<ReturnType<typeof resolveWorkspaceEndpoint>>;
    requests: Observation[];
  }) => Promise<void>,
) {
  const requests: Observation[] = [];
  const server = createServer((incoming, outgoing) => {
    const request = {
      url: new URL(incoming.url ?? "/", "http://witness.invalid"),
      auth: incoming.headers.authorization,
      method: incoming.method,
    };
    requests.push(request);
    const remote = directoryFor(request) === REMOTE;
    const mount = remote ? "/remote/workspace/remote%2Fid" : "/local/workspace/local%20workspace";
    const path = `${mount}/${engine === "v1" ? "opencode/session" : "opencode2/api/session"}`;
    const result = request.auth !== `Bearer synthetic-${remote ? "remote" : "local"}`
      ? { status: 401, body: { code: "unauthorized" } }
      : request.method !== "GET" || request.url.pathname !== path
        ? { status: 404, body: { code: "wrong_endpoint" } }
        : reply(request, requests.length - 1);
    if (result === null) { incoming.socket.destroy(); return; }
    outgoing.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
    outgoing.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing witness address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const handle = { baseUrl: `${baseUrl}/local`, token: "synthetic-local" };
    const local = resolveWorkspaceEndpoint({ id: "local workspace", workspaceType: "local" }, handle);
    const remote = resolveWorkspaceEndpoint({
      id: "rem_synthetic", workspaceType: "remote", baseUrl: `${baseUrl}/remote`,
      openworkWorkspaceId: "remote/id", openworkToken: "synthetic-remote",
    }, handle);
    if (!local || !remote) throw new Error("Missing witness endpoints");
    await run({ local, remote, requests });
    for (const request of requests) {
      expect(request.method).toBe("GET");
      expect(request.auth).toBe(`Bearer synthetic-${directoryFor(request) === REMOTE ? "remote" : "local"}`);
      expect([...request.url.searchParams.keys()].sort()).toEqual(
        request.url.searchParams.has("cursor") ? ["cursor", "limit"] : ["limit"],
      );
      expect(request.url.searchParams.has("limit")).toBe(true);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("v1 exhausts explicit expanding limits at empty, below, exact, and above boundaries", async () => {
  for (const count of [0, 199, 200, 201, 400, 401, 1201]) {
    const source = sessions(count);
    await withWitness("v1", pageReply("v1", source), async ({ local, requests }) => {
      expect(await listRouteSessions(local)).toEqual(source);
      const limits = [200];
      while (limits[limits.length - 1] <= count) limits.push(limits[limits.length - 1] * 2);
      expect(requests.map(({ url }) => Number(url.searchParams.get("limit")))).toEqual(limits);
      expect(requests.some(({ url }) => url.searchParams.has("cursor"))).toBe(false);
    });
  }
  currentTestEvidence()?.recordAssertionEvidence(
    "v1 exhausts session history with explicit expanding limits",
    "HTTP witness returned exactly 0, 199, 200, 201, 400, 401, and 1201 synthetic sessions. Every load matched the full source; requests doubled from limit=200 until a short prefix, used the owning credential, and sent no cursor or implicit default limit.",
    true,
  );
});

for (const engine of ["v1", "v2"] satisfies Engine[]) {
  test(`${engine} loads old active roots behind over 200 archives and children without crossing workspaces`, async () => {
    const active = sessions(251);
    active[250].time.archived = 0;
    const archived = sessions(230, "archived");
    const children = sessions(230, "child");
    // Two whole v2 native pages belong to the other workspace. The visible
    // local first pages are empty, but their cursors must still be followed.
    const other = sessions(401, "other", REMOTE);
    const source = [...other, ...archived, ...children, ...active];
    await withWitness(engine, pageReply(engine, source), async ({ local, remote, requests }) => {
      const transport = engine === "v2" ? v2RouteSessionList : undefined;
      const [localItems, remoteItems] = await Promise.all([
        listRouteSessions(local, transport), listRouteSessions(remote, transport),
      ]);
      expect(localItems.map((item) => item.id)).toEqual([...archived, ...children, ...active].map((item) => item.id));
      expect(remoteItems.map((item) => item.id)).toEqual(other.map((item) => item.id));
      expect(localItems.every((item) => item.directory === LOCAL)).toBe(true);
      expect(remoteItems.every((item) => item.directory === REMOTE)).toBe(true);
      expect(partitionArchivedSessions(localItems).archived.map((item) => item.id)).toEqual(archived.map((item) => item.id));
      const preview = flattenSessionRows(localItems, MAX_SESSIONS_PREVIEW);
      expect(preview.map(({ session }) => session.id)).toEqual(active.slice(0, 6).map((item) => item.id));
      const expanded = flattenSessionRows(localItems, Number.MAX_SAFE_INTEGER);
      expect(expanded.map(({ session }) => session.id)).toEqual(active.map((item) => item.id));
      expect(expanded.some(({ session }) => session.parentID || session.time?.archived)).toBe(false);
      expect(new Set(localItems.map((item) => item.id)).size).toBe(localItems.length);
      const pinned = new Set([active[250].id]);
      expect(flattenSessionRows(localItems, 6, pinned)[0].session.id).toBe(active[250].id);
      expect(flattenSessionRows(localItems, Number.MAX_SAFE_INTEGER, new Set(), [], { exclude: pinned })).toHaveLength(250);
      // Show more derives rows from the complete loaded list, not another read.
      const requestCount = requests.length;
      expect(flattenSessionRows(localItems, 252)).toHaveLength(251);
      expect(requests).toHaveLength(requestCount);
      for (const directory of [LOCAL, REMOTE]) {
        const own = requests.filter((request) => directoryFor(request) === directory);
        if (engine === "v2") {
          expect(own).toHaveLength(7);
          expect(own.every(({ url }) => url.searchParams.get("limit") === "200")).toBe(true);
          expect(own.slice(1).every(({ url }) => url.searchParams.has("cursor"))).toBe(true);
        } else {
          expect(own.map(({ url }) => url.searchParams.get("limit"))).toEqual(["200", "400", "800"]);
        }
      }
    });
    currentTestEvidence()?.recordAssertionEvidence(
      `${engine} exposes old unarchived roots without leaking archives, children, or other workspaces`,
      `HTTP witness loaded 251 active roots behind 230 archives and 230 children, including an old root with archived=0. Sidebar preview returned six roots; expansion returned all 251 without another read, and pinning retained the old root. Concurrent remote loading returned only its 401 sessions; directories and credentials stayed isolated. ${engine === "v2" ? "Each workspace traversed seven limit=200 requests, continuing through filtered-empty pages." : "Each workspace used limits 200, 400, 800."}`,
      true,
    );
  });

  test(`${engine} rejects later-page errors atomically and retries only transient failures with the same identity`, async () => {
    const source = sessions(201, "remote", REMOTE);
    for (const status of [401, 403, 404, 503]) {
      const reply = pageReply(engine, source);
      const code = status === 503 ? "opencode_engine_unreachable" : "synthetic_rejection";
      await withWitness(engine, (request, index) => index === 1
        ? { status, body: { code, message: "Synthetic failure" } }
        : reply(request), async ({ remote, requests }) => {
        const load = () => listRouteSessions(remote, engine === "v2" ? v2RouteSessionList : undefined);
        // No partial list may be committed when a later page fails.
        await expect(load()).rejects.toMatchObject({ status, code });
        expect(requests).toHaveLength(2);
        expect(requests.every((request) => directoryFor(request) === REMOTE)).toBe(true);
      });
      const retryReply = pageReply(engine, source);
      await withWitness(engine, (request, index) => index === 1
        ? { status, body: { code, message: "Synthetic failure" } }
        : retryReply(request), async ({ remote, requests }) => {
        const waits: number[] = [];
        const load = readRouteSessionsWithRetry({
          load: () => listRouteSessions(remote, engine === "v2" ? v2RouteSessionList : undefined),
          retryDelaysMs: [1], wait: async (delay) => { waits.push(delay); },
        });
        if (status === 503) {
          expect((await load).map((item) => item.id)).toEqual(source.map((item) => item.id));
          expect(waits).toEqual([1]);
          expect(requests[2].url.searchParams.get("limit")).toBe("200");
          expect(requests[2].url.searchParams.has("cursor")).toBe(false);
          expect(requests).toHaveLength(engine === "v2" ? 5 : 4);
        } else {
          await expect(load).rejects.toMatchObject({ status, code });
          expect(waits).toEqual([]);
          expect(requests).toHaveLength(2);
        }
        expect(requests.every((request) => directoryFor(request) === REMOTE)).toBe(true);
      });
    }
    const reply = pageReply(engine, source);
    await withWitness(engine, (request, index) => index === 1 ? null : reply(request), async ({ remote, requests }) => {
      await expect(listRouteSessions(remote, engine === "v2" ? v2RouteSessionList : undefined)).rejects.toThrow();
      expect(requests).toHaveLength(2);
    });
    currentTestEvidence()?.recordAssertionEvidence(
      `${engine} rejects incomplete history and preserves identity during bounded recovery`,
      `For 201 synthetic remote sessions, second-page 401, 403, 404, and 503 responses rejected the whole load with status and code intact. Authorization and not-found errors stopped after two requests without retry; 503 restarted at limit=200 without a cursor and recovered all sessions after one wait (${engine === "v2" ? 5 : 4} total requests). A second-page socket failure also rejected, never returning a partial list. Every request retained the remote mount and credential.`,
      true,
    );
  });
}

test("v1 replaces expanded prefixes instead of retaining removed or stale session records", async () => {
  const initial = sessions(200);
  const final = sessions(201).filter((item) => item.id !== initial[0].id);
  final[0].title = "Synthetic updated title";
  await withWitness("v1", (request, index) => pageReply("v1", index === 0 ? initial : final)(request), async ({ local, requests }) => {
    expect(await listRouteSessions(local)).toEqual(final);
    expect(requests).toHaveLength(2);
  });
  currentTestEvidence()?.recordAssertionEvidence(
    "v1 replaces stale prefixes rather than merging removed records",
    "After an initial 200-session prefix, the HTTP witness removed one synthetic session and changed another title. The expanded read returned exactly the replacement snapshot in two authenticated requests, without retaining the removed record or stale title.",
    true,
  );
});

test("v2 follows terminal cursors at boundaries and preserves sessions with tied timestamps", async () => {
  for (const count of [0, 199, 200, 201, 400, 401]) {
    const source = sessions(count).map((session) => ({ ...session, time: { created: 1, updated: 1 } }));
    await withWitness("v2", pageReply("v2", source), async ({ local, requests }) => {
      expect((await listRouteSessions(local, v2RouteSessionList)).map((item) => item.id)).toEqual(source.map((item) => item.id));
      expect(requests).toHaveLength(Math.ceil(count / 200) + 1);
      expect(requests.every(({ url }) => url.searchParams.get("limit") === "200")).toBe(true);
    });
  }
  currentTestEvidence()?.recordAssertionEvidence(
    "v2 exhausts native cursors without losing tied-timestamp sessions",
    "For 0, 199, 200, 201, 400, and 401 synthetic sessions sharing one updated timestamp, the HTTP loader returned every ID in order. Each load used exactly ceil(count/200)+1 authenticated requests at limit=200, including the terminal empty page rather than treating a short page as exhaustion.",
    true,
  );
});

test("v2 deduplicates overlapping pages and rejects cyclic cursors or malformed successful responses", async () => {
  const source = sessions(2);
  await withWitness("v2", (_request, index) => ({ body: index === 0
    ? { data: [source[0]], cursor: { next: "opaque+/=" } }
    : { data: source, cursor: {} } }), async ({ local, requests }) => {
    expect((await listRouteSessions(local, v2RouteSessionList)).map((item) => item.id)).toEqual(source.map((item) => item.id));
    expect(requests[1].url.searchParams.get("cursor")).toBe("opaque+/=");
  });
  await withWitness("v2", (_request, index) => ({ body: { data: [], cursor: { next: index % 2 ? "second" : "first" } } }), async ({ local, requests }) => {
    await expect(listRouteSessions(local, v2RouteSessionList)).rejects.toThrow("Session list cursor did not advance");
    expect(requests).toHaveLength(3);
  });
  for (const body of [{ data: {}, cursor: {} }, { data: [], cursor: { next: 12 } }]) {
    await withWitness("v2", () => ({ body }), async ({ local, requests }) => {
      await expect(listRouteSessions(local, v2RouteSessionList)).rejects.toThrow("InvalidV2SessionListResponse");
      expect(requests).toHaveLength(1);
    });
  }
  currentTestEvidence()?.recordAssertionEvidence(
    "v2 handles overlap and rejects invalid pagination instead of reporting incomplete success",
    "Overlapping HTTP pages returned two distinct synthetic IDs once each and preserved an opaque cursor containing URL-sensitive characters. A two-cursor cycle rejected after three requests. A non-array data payload and a numeric next cursor each rejected after one request with InvalidV2SessionListResponse.",
    true,
  );
});
