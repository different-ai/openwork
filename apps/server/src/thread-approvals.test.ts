import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EnginePoolConnection } from "./engine-pool.js";
import {
  grantCovers,
  listThreadApprovals,
  matchesPermissionPattern,
  rememberThreadApproval,
  startThreadApprovalReplayer,
} from "./thread-approvals.js";
import type { ServerConfig } from "./types.js";

const WORKSPACE_ID = "ws_thread";
const DIRECTORY = "/tmp/thread-approvals-workspace";

interface ReplyRecord {
  requestId: string;
  directory: string | null;
  reply: unknown;
}

/** A stand-in engine: one scripted /global/event stream plus a reply recorder. */
function fakeEngine() {
  const replies: ReplyRecord[] = [];
  let push: ((frame: unknown) => void) | null = null;
  let streams = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/global/event") {
        streams += 1;
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            push = (frame) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
          },
          cancel() {
            push = null;
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      const reply = url.pathname.match(/^\/permission\/([^/]+)\/reply$/);
      if (request.method === "POST" && reply) {
        replies.push({
          requestId: decodeURIComponent(reply[1] ?? ""),
          directory: url.searchParams.get("directory"),
          reply: await request.json(),
        });
        return new Response("true", { headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const connection: EnginePoolConnection = {
    generationId: "gen_1",
    role: "primary",
    baseUrl: `http://127.0.0.1:${server.port}`,
    username: "probe",
    password: "probe",
  };
  return {
    connection,
    replies,
    streams: () => streams,
    emit: async (event: Record<string, unknown>) => {
      const deadline = Date.now() + 5_000;
      while (!push && Date.now() < deadline) await Bun.sleep(10);
      if (!push) throw new Error("no event stream attached");
      push({ directory: DIRECTORY, payload: event });
    },
    stop: () => server.stop(true),
  };
}

function asked(id: string, sessionID: string, patterns: string[], always: string[], permission = "bash") {
  return { type: "permission.asked", properties: { id, sessionID, permission, patterns, always } };
}

function replied(requestID: string, sessionID: string, reply: string) {
  return { type: "permission.replied", properties: { requestID, sessionID, reply } };
}

async function settleAsync(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await Bun.sleep(20);
  }
  return await predicate();
}

function settle(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  return settleAsync(async () => predicate(), timeoutMs);
}

const cleanups: Array<() => void | Promise<void>> = [];
const previousDb = process.env.OPENWORK_RUNTIME_DB;

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
  else process.env.OPENWORK_RUNTIME_DB = previousDb;
});

async function serverConfig(): Promise<ServerConfig> {
  const root = await mkdtemp(join(tmpdir(), "openwork-thread-approvals-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  return {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [],
    workspaces: [{ id: WORKSPACE_ID, name: "Thread", path: DIRECTORY, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [DIRECTORY],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  };
}

describe("thread approval matching", () => {
  test("mirrors the engine's wildcard semantics", () => {
    expect(matchesPermissionPattern("git status --porcelain", "git status *")).toBe(true);
    expect(matchesPermissionPattern("git status", "git status *")).toBe(true);
    expect(matchesPermissionPattern("git push", "git status *")).toBe(false);
    expect(matchesPermissionPattern("/shared/report.md", "/shared/*")).toBe(true);
    expect(matchesPermissionPattern("/shared2/report.md", "/shared/*")).toBe(false);
    expect(grantCovers({ permission: "bash", patterns: ["printf *"] }, "bash", ["printf 'a'"])).toBe(true);
    expect(grantCovers({ permission: "bash", patterns: ["printf *"] }, "bash", ["printf 'a'", "rm -rf x"])).toBe(false);
    expect(grantCovers({ permission: "bash", patterns: ["printf *"] }, "edit", ["printf 'a'"])).toBe(false);
    expect(grantCovers({ permission: "bash", patterns: ["printf *"] }, "bash", [])).toBe(false);
  });

  test("stores grants per thread without duplicates", async () => {
    const config = await serverConfig();
    await rememberThreadApproval(config, WORKSPACE_ID, "ses_a", { permission: "bash", patterns: ["git status *"] });
    await rememberThreadApproval(config, WORKSPACE_ID, "ses_a", { permission: "bash", patterns: ["git status *"] });
    await rememberThreadApproval(config, WORKSPACE_ID, "ses_a", { permission: "external_directory", patterns: ["/shared/*"] });
    expect(await listThreadApprovals(config, WORKSPACE_ID, "ses_a")).toEqual([
      { permission: "bash", patterns: ["git status *"] },
      { permission: "external_directory", patterns: ["/shared/*"] },
    ]);
    expect(await listThreadApprovals(config, WORKSPACE_ID, "ses_b")).toEqual([]);
  });
});

describe("thread approval replayer", () => {
  test("remembers an always reply and answers the same thread's repeat ask, and only that thread", async () => {
    const config = await serverConfig();
    const engine = fakeEngine();
    cleanups.push(engine.stop);
    const replayer = startThreadApprovalReplayer({
      config,
      primary: () => engine.connection,
      workspaceIdForDirectory: async (directory) => (directory === DIRECTORY ? WORKSPACE_ID : null),
      reconnectMs: 50,
    });
    cleanups.push(replayer.stop);

    // The user approves once on thread A with the engine's suggested pattern.
    await engine.emit(asked("perm_1", "ses_a", ["printf 'first'"], ["printf *"]));
    await Bun.sleep(50);
    expect(engine.replies).toHaveLength(0);
    await engine.emit(replied("perm_1", "ses_a", "always"));
    expect(await settleAsync(async () => (await listThreadApprovals(config, WORKSPACE_ID, "ses_a")).length === 1)).toBe(true);
    expect(await listThreadApprovals(config, WORKSPACE_ID, "ses_a")).toEqual([{ permission: "bash", patterns: ["printf *"] }]);

    // A later ask on the same thread that the grant covers is answered for the user.
    await engine.emit(asked("perm_2", "ses_a", ["printf 'second'"], ["printf *"]));
    expect(await settle(() => engine.replies.length === 1)).toBe(true);
    expect(engine.replies[0]).toEqual({ requestId: "perm_2", directory: DIRECTORY, reply: { reply: "always" } });

    // Negative halves: a different thread, a different permission, and a
    // command outside the granted pattern all still reach the user.
    await engine.emit(asked("perm_3", "ses_b", ["printf 'other thread'"], ["printf *"]));
    await engine.emit(asked("perm_4", "ses_a", ["src/index.ts"], ["*"], "edit"));
    await engine.emit(asked("perm_5", "ses_a", ["rm -rf build"], ["rm *"]));
    await Bun.sleep(200);
    expect(engine.replies).toHaveLength(1);

    // "once" and "reject" replies are never remembered.
    await engine.emit(replied("perm_5", "ses_a", "once"));
    await engine.emit(replied("perm_3", "ses_b", "reject"));
    await Bun.sleep(100);
    expect(await listThreadApprovals(config, WORKSPACE_ID, "ses_a")).toEqual([{ permission: "bash", patterns: ["printf *"] }]);
    expect(await listThreadApprovals(config, WORKSPACE_ID, "ses_b")).toEqual([]);
  });

  test("ignores directories OpenWork does not own and reconnects after the stream drops", async () => {
    const config = await serverConfig();
    const engine = fakeEngine();
    cleanups.push(engine.stop);
    const replayer = startThreadApprovalReplayer({
      config,
      primary: () => engine.connection,
      workspaceIdForDirectory: async () => null,
      reconnectMs: 50,
    });
    cleanups.push(replayer.stop);

    await engine.emit(asked("perm_1", "ses_a", ["printf 'x'"], ["printf *"]));
    await engine.emit(replied("perm_1", "ses_a", "always"));
    await Bun.sleep(100);
    expect(await listThreadApprovals(config, WORKSPACE_ID, "ses_a")).toEqual([]);

    // Drop the stream: the replayer reattaches instead of giving up.
    expect(engine.streams()).toBe(1);
    engine.stop();
    const restarted = fakeEngine();
    cleanups.push(restarted.stop);
    engine.connection.baseUrl = restarted.connection.baseUrl;
    expect(await settle(() => restarted.streams() >= 1, 5_000)).toBe(true);
  });
});
