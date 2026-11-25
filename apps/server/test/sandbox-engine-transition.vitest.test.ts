import { expect, test } from "vitest";
import { assertSandboxEngineIdle } from "../src/sandbox-engine-transition.js";
import { serve } from "../src/serve-node.js";
import { withEngineSwitchFence } from "../src/engine-switch-fence.js";
import type { ServerConfig } from "../src/types.js";

test("sidecar idle probe uses only global APIs and includes background jobs", async () => {
  const paths: string[] = [];
  let foreground = false;
  let background = false;
  let malformed = false;
  const engine = { fetchJson: async (path: string, input?: { directory?: string }) => {
    paths.push(path);
    expect(input?.directory).toBeUndefined();
    return { status: 200, json: malformed ? {} : { data: path === "/api/session/active" ? foreground ? { session: { type: "running" } } : {} : background ? [{ kind: "shell", status: "running" }] : [] } };
  } };
  await expect(assertSandboxEngineIdle(engine)).resolves.toBeUndefined();
  foreground = true;
  await expect(assertSandboxEngineIdle(engine)).rejects.toMatchObject({ status: 409, code: "sandbox_engine_busy" });
  foreground = false; background = true;
  await expect(assertSandboxEngineIdle(engine)).rejects.toMatchObject({ status: 409, code: "sandbox_engine_busy" });
  malformed = true;
  await expect(assertSandboxEngineIdle(engine)).rejects.toMatchObject({ status: 409, code: "sandbox_engine_activity_unavailable" });
  expect(new Set(paths)).toEqual(new Set(["/api/session/active", "/api/experimental/job?status=running"]));
});

test("a queued native mutation resolves fresh credentials after a same-engine restart fence", async () => {
  const { proxyOpencodeV2Request } = await import("../src/server.js");
  let oldCalls = 0; let authorization: string | null = null;
  const old = await serve({ hostname: "127.0.0.1", port: 0, fetch: () => { oldCalls++; return Response.json({ ok: false }); } });
  const fresh = await serve({ hostname: "127.0.0.1", port: 0, fetch: request => { authorization = request.headers.get("authorization"); return Response.json({ ok: true }); } });
  const workspace: ServerConfig["workspaces"][number] = { id: "fixture", name: "Fixture", path: "/fixture", preset: "starter", workspaceType: "local" };
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "fixture", hostToken: "fixture", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [workspace], authorizedRoots: ["/fixture"], readOnly: false, startedAt: 0, tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false };
  const stale = { url: `http://127.0.0.1:${old.port}`, username: "opencode", password: "old-password" };
  let connection = stale;
  let finish: () => void = () => {};
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const switching = withEngineSwitchFence(config, { from: "v2", to: "v2", operation: async () => { await gate; connection = { url: `http://127.0.0.1:${fresh.port}`, username: "opencode", password: "fresh-password" }; } });
  const url = new URL("http://localhost/workspace/fixture/opencode2/api/experimental/noop");
  const request = new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  try {
    const queued = proxyOpencodeV2Request({ config, request, url, workspace, actor: { type: "host", scope: "owner" }, proxyPath: "/opencode2/api/experimental/noop", connection: stale, resolveConnection: () => connection });
    finish(); await switching;
    const response = await queued;
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
    expect(oldCalls).toBe(0);
    expect(authorization).toBe(`Basic ${Buffer.from("opencode:fresh-password").toString("base64")}`);
  } finally { finish(); await switching; await old.stop(); await fresh.stop(); }
});
