import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertOpencodeProxyAllowed, proxyOpencodeV2Request } from "../src/server.js";
import { serve } from "../src/serve-node.js";
import type { ServerConfig, WorkspaceInfo } from "../src/types.js";

async function fixture(run: (proxy: (method: string, path: string, body?: unknown) => Promise<Response>, reads: string[]) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "openwork-native-credentials-"));
  const previous = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const directory = join(root, "workspace");
  await mkdir(directory);
  const workspace: WorkspaceInfo = { id: "ws_test", name: "Workspace", path: directory, preset: "starter", workspaceType: "local" };
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [workspace], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  const reads: string[] = [];
  const engine = await serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const url = new URL(request.url);
    reads.push(`${request.method} ${url.pathname}`);
    assert.equal(url.searchParams.get("location[directory]"), directory);
    assert.equal(request.headers.get("authorization"), `Basic ${Buffer.from("opencode:engine-secret").toString("base64")}`);
    if (url.pathname === "/api/integration/claude-agent") return Response.json({ data: {
      id: "claude-agent", methods: [{ id: "claude-login", type: "external" }], connections: [
        { type: "credential", id: "cred_claude", method: "external", label: "Claude Code login" },
        { type: "credential", id: "cred_other_method", method: "key", label: "Other method" },
      ],
    } });
    if (url.pathname === "/api/credential") return Response.json({ secret: "must-not-reach-the-renderer" });
    if (url.pathname === "/api/integration/claude-agent/connect/external") {
      assert.deepEqual(await request.json(), { methodID: "claude-login" });
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 204 });
  } });
  const proxy = (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://openwork.test/workspace/ws_test/opencode2${path}?location[directory]=/untrusted`);
    return proxyOpencodeV2Request({
      actor: { type: "host" }, config, workspace, url, proxyPath: `/opencode2${path}`,
      request: new Request(url, { method, headers: { authorization: "Bearer renderer-token", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
      connection: { url: `http://127.0.0.1:${engine.port}`, username: "opencode", password: "engine-secret" },
    });
  };
  try { await run(proxy, reads); }
  finally {
    await engine.stop();
    if (previous === undefined) delete process.env.OPENWORK_RUNTIME_DB; else process.env.OPENWORK_RUNTIME_DB = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("viewer tokens cannot connect or remove a Claude Code connection", () => {
  for (const [method, path] of [
    ["POST", "/opencode2/api/integration/claude-agent/connect/external"],
    ["DELETE", "/opencode2/api/credential/cred_claude"],
  ]) {
    assert.throws(() => assertOpencodeProxyAllowed({ type: "remote", scope: "viewer" }, method, path), { code: "forbidden" });
    assertOpencodeProxyAllowed({ type: "remote", scope: "collaborator" }, method, path);
  }
});

test("native credential secrets are never exposed to the renderer", async () => {
  await fixture(async (proxy, reads) => {
    for (const [method, path] of [
      ["GET", "/api/credential"], ["GET", "/api/credential/cred_other"],
      ["POST", "/api/credential"], ["PATCH", "/api/credential/cred_other"],
      ["POST", "/api/credential/cred_other/activate"], ["GET", "/api/experimental/credential"],
    ]) await assert.rejects(proxy(method, path), { code: "engine_credentials_private" });
    assert.deepEqual(reads, []);
  });
});

test("only Claude external connection references can be removed", async () => {
  await fixture(async (proxy, reads) => {
    await assert.rejects(proxy("DELETE", "/api/credential/cred_other"), { code: "engine_credentials_private" });
    await assert.rejects(proxy("DELETE", "/api/credential/cred_other_method"), { code: "engine_credentials_private" });
    const result = await proxy("DELETE", "/api/credential/cred_claude");
    assert.equal(result.status, 204);
    assert.deepEqual(reads, [
      "GET /api/integration/claude-agent", "GET /api/integration/claude-agent", "GET /api/integration/claude-agent", "DELETE /api/credential/cred_claude",
    ]);
  });
});

test("Claude sign-in accepts only the official external method and never receives credentials", async () => {
  await fixture(async (proxy, reads) => {
    for (const body of [{ methodID: "other" }, { methodID: "claude-login", token: "not-accepted" }, {}]) {
      await assert.rejects(proxy("POST", "/api/integration/claude-agent/connect/external", body), { code: "invalid_provider_connection" });
    }
    await assert.rejects(proxy("POST", "/api/integration/claude-agent/connect/key", { methodID: "claude-login" }), { code: "invalid_provider_connection" });
    assert.deepEqual(reads, []);
    const result = await proxy("POST", "/api/integration/claude-agent/connect/external", { methodID: "claude-login" });
    assert.equal(result.status, 204);
    assert.deepEqual(reads, ["POST /api/integration/claude-agent/connect/external"]);
  });
});
