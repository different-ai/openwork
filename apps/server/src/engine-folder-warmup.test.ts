import { afterEach, describe, expect, test } from "bun:test";

import { warmEngineFolder } from "./engine-folder-warmup.js";
import { warmActiveEngineFolder } from "./server.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

type Seen = { path: string; directory: string | null; authorization: string | null };

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** A v1 engine stand-in that records what it was asked for. */
function fakeEngine(reply: (request: Request) => Response | Promise<Response> = () => Response.json({ providers: [], default: {} })) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push({ path: url.pathname, directory: url.searchParams.get("directory"), authorization: request.headers.get("authorization") });
      return await reply(request);
    },
  });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.port}`, seen };
}

function workspace(id: string, path: string, extra: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return { id, name: id, path, preset: "default", workspaceType: "local", ...extra };
}

function config(input: { baseUrl: string; workspaces: WorkspaceInfo[] }): ServerConfig {
  return {
    host: "127.0.0.1", port: 0, token: "t", hostToken: "h", configPath: "/tmp/openwork-warmup-test.json",
    approval: { mode: "manual", timeoutMs: 1_000 }, corsOrigins: [], workspaces: input.workspaces, authorizedRoots: [],
    readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "json", logRequests: false,
    opencodeBaseUrl: input.baseUrl, opencodeUsername: "opencode", opencodePassword: "primary-secret",
  };
}

function captureLogs() {
  const entries: Array<{ level: string; message: string; attributes?: Record<string, unknown> }> = [];
  return { entries, logger: { log: (level: "info" | "warn" | "error", message: string, attributes?: Record<string, unknown>) => { entries.push({ level, message, attributes }); } } };
}

describe("warmEngineFolder", () => {
  test("reads the folder's connected providers, with the engine credentials", async () => {
    const engine = fakeEngine();
    const result = await warmEngineFolder({ target: { baseUrl: engine.baseUrl, authHeader: "Basic abc" }, directory: "/work/space" });
    expect(result.ok).toBe(true);
    expect(engine.seen).toEqual([{ path: "/config/providers", directory: "/work/space", authorization: "Basic abc" }]);
  });

  test("keeps a base path, as a proxied engine URL has one", async () => {
    const engine = fakeEngine();
    await warmEngineFolder({ target: { baseUrl: `${engine.baseUrl}/opencode/` }, directory: "/w" });
    expect(engine.seen[0]?.path).toBe("/opencode/config/providers");
  });

  test("an engine error, a hung engine and an unreachable engine are reported, never thrown", async () => {
    const failing = fakeEngine(() => new Response("no", { status: 500 }));
    expect(await warmEngineFolder({ target: { baseUrl: failing.baseUrl }, directory: "/w" })).toMatchObject({ ok: false, status: 500 });

    const hung = fakeEngine(() => new Promise<Response>(() => undefined));
    const timedOut = await warmEngineFolder({ target: { baseUrl: hung.baseUrl }, directory: "/w", timeoutMs: 50 });
    expect(timedOut.ok).toBe(false);

    const unreachable = await warmEngineFolder({ target: { baseUrl: "http://127.0.0.1:1" }, directory: "/w", timeoutMs: 1_000 });
    expect(unreachable.ok).toBe(false);
  });
});

describe("warmActiveEngineFolder", () => {
  test("warms only the active local workspace and logs how long it took", async () => {
    const engine = fakeEngine();
    const { entries, logger } = captureLogs();
    const result = await warmActiveEngineFolder(config({
      baseUrl: engine.baseUrl,
      workspaces: [
        workspace("ws_remote", "/remote", { workspaceType: "remote", baseUrl: "http://127.0.0.1:1" }),
        workspace("ws_active", "/folders/active"),
        workspace("ws_other", "/folders/other"),
      ],
    }), logger, "startup");
    expect(result?.ok).toBe(true);
    expect(engine.seen.map(({ directory }) => directory)).toEqual(["/folders/active"]);
    expect(engine.seen[0]?.authorization).toBe(`Basic ${Buffer.from("opencode:primary-secret").toString("base64")}`);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: "info", message: "Engine folder warmed.", attributes: { "engine.warmup.reason": "startup", "workspace.id": "ws_active" } });
    expect(typeof entries[0]?.attributes?.["engine.warmup.duration_ms"]).toBe("number");
  });

  test("before a rollover it warms the standby, not the engine still serving", async () => {
    const live = fakeEngine();
    const standby = fakeEngine();
    const { entries, logger } = captureLogs();
    await warmActiveEngineFolder(config({ baseUrl: live.baseUrl, workspaces: [workspace("ws_active", "/folders/active")] }), logger, "rollover", {
      baseUrl: standby.baseUrl, username: "opencode", password: "standby-secret", generationId: "gen_2",
    });
    expect(live.seen).toEqual([]);
    expect(standby.seen).toEqual([{
      path: "/config/providers",
      directory: "/folders/active",
      authorization: `Basic ${Buffer.from("opencode:standby-secret").toString("base64")}`,
    }]);
    expect(entries[0]?.attributes).toMatchObject({ "engine.warmup.reason": "rollover", "engine.rollover.generation": "gen_2" });
  });

  test("a failed warm-up is logged as a warning and does not throw", async () => {
    const engine = fakeEngine(() => new Response("no", { status: 503 }));
    const { entries, logger } = captureLogs();
    const result = await warmActiveEngineFolder(config({ baseUrl: engine.baseUrl, workspaces: [workspace("ws_active", "/folders/active")] }), logger, "reload");
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(entries[0]).toMatchObject({ level: "warn", message: "Engine folder warm-up failed.", attributes: { "http.status": 503 } });
  });

  test("with no local workspace there is nothing to warm", async () => {
    const engine = fakeEngine();
    const { entries, logger } = captureLogs();
    expect(await warmActiveEngineFolder(config({ baseUrl: engine.baseUrl, workspaces: [] }), logger, "startup")).toBeNull();
    expect(engine.seen).toEqual([]);
    expect(entries).toEqual([]);
  });
});
