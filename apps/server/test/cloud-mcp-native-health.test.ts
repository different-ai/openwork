import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  readOpenworkCloudMcpHealth,
  reconcileOpenworkCloudMcp,
  refreshOpenworkCloudMcpEngine,
  type CloudMcpRuntimeRegistrar,
} from "../src/cloud-mcp-health.js";
import type { ServerConfig, WorkspaceInfo } from "../src/types.js";

/** No production endpoint, credential, model, or legacy engine participates. */
async function nativeFixture() {
  const root = await mkdtemp(join(tmpdir(), "openwork-native-cloud-health-"));
  const previous = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const workspace: WorkspaceInfo = {
    id: "native-cloud-health", name: "Native workspace", path: join(root, "workspace"),
    preset: "default", workspaceType: "local",
  };
  await mkdir(workspace.path);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [workspace], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  const wire: string[] = [];
  const nativeCalls: string[] = [];
  const state = { registered: false, nativeStatus: "connected", nativeDown: false, tools: true, rejectToken: false, registrationFails: false };
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const payload: unknown = await request.json();
    assert.ok(payload && typeof payload === "object" && "method" in payload);
    assert.equal(request.headers.get("authorization"), "Bearer fixture-member-token");
    wire.push(String(payload.method));
    if (state.rejectToken) return new Response(null, { status: 401 });
    if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
    assert.ok("id" in payload);
    const result = payload.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "owned-cloud-witness", version: "1" } }
      : { tools: ["search_capabilities", "execute_capability"].map(name => ({ name, inputSchema: { type: "object" } })) };
    return Response.json({ jsonrpc: "2.0", id: payload.id, result });
  } });
  const desired = { type: "remote", url: `http://127.0.0.1:${endpoint.port}/mcp/agent`, enabled: true, oauth: false,
    headers: { Authorization: "Bearer fixture-member-token" } };
  const input = {
    config, workspace, directory: workspace.path, providerModel: { provider: "fixture", model: "tools" },
    createWorkspaceOpencodeClient: () => { throw new Error("Native health must never construct a legacy client"); },
    nativeEngineForWorkspace: () => ({ version: "2.2.0", request: async (path: string, directory: string | null) => {
      assert.equal(directory, workspace.path);
      nativeCalls.push(path);
      if (state.nativeDown) throw new Error("Native engine is unavailable");
      if (path.endsWith("/disconnect")) { state.registered = false; return; }
      if (path === "/api/mcp") return { data: state.registered ? [{ name: "openwork-cloud", status: { status: state.nativeStatus } }] : [] };
      if (path === "/api/model") return { data: [{ providerID: "fixture", id: "tools", capabilities: { tools: state.tools } }] };
      throw new Error(`Unexpected native request: ${path}`);
    } }),
    registerRuntimeMcp: async (): ReturnType<CloudMcpRuntimeRegistrar> => {
      if (state.registrationFails) return { status: "failed", syncedNames: [], failures: [{ name: "openwork-cloud", message: "Native registration failed" }] };
      state.registered = true;
      return { status: "ok", syncedNames: ["openwork-cloud"], failures: [] };
    },
  };
  return {
    input, state, wire, nativeCalls,
    reconcile: () => reconcileOpenworkCloudMcp({ ...input, body: { config: desired } }),
    async [Symbol.asyncDispose]() {
      await endpoint.stop(true);
      if (previous === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previous;
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("native-only Cloud reconciliation, health and refresh need no legacy base URL", async () => {
  await using fixture = await nativeFixture();
  assert.equal(fixture.input.config.opencodeBaseUrl, undefined);
  assert.equal(fixture.input.workspace.baseUrl, undefined);
  const health = await fixture.reconcile();
  assert.equal(health.phase, "ready");
  assert.equal(health.usable, true);
  assert.equal(health.usableByCurrentModel, true);
  assert.equal(health.engineInspection.cloudPresent, true);
  assert.equal(health.delivery.state, "ready");
  assert.equal(health.tools.direct.checked, true);
  assert.deepEqual(health.tools.direct.missing, []);
  assert.deepEqual(fixture.wire, ["initialize", "notifications/initialized", "tools/list"]);
  assert.ok(fixture.nativeCalls.includes("/api/mcp"));
  assert.ok(fixture.nativeCalls.includes("/api/model"));
  const refreshed = await refreshOpenworkCloudMcpEngine(fixture.input);
  assert.equal(refreshed.health.usable, true);
  assert.deepEqual(refreshed.refresh.steps.map(step => [step.step, step.ok]), [["engine_disconnect", true], ["reapply", true]]);
  assert.ok(fixture.nativeCalls.includes("/api/experimental/mcp/openwork-cloud/disconnect"));
});

test("native selection never substitutes for verified Cloud readiness", async () => {
  await using fixture = await nativeFixture();
  await fixture.reconcile();
  fixture.state.nativeDown = true;
  const unavailable = await readOpenworkCloudMcpHealth(fixture.input);
  assert.equal(unavailable.usable, false);
  assert.equal(unavailable.phase, "engine_unreachable");
  fixture.state.nativeDown = false;
  fixture.state.nativeStatus = "needs_auth";
  const unauthenticated = await fixture.reconcile();
  assert.equal(unauthenticated.usable, false);
  assert.equal(unauthenticated.phase, "engine_needs_auth");
  fixture.state.nativeStatus = "connected";
  fixture.state.tools = false;
  const unsupportedModel = await fixture.reconcile();
  assert.equal(unsupportedModel.usable, false);
  assert.equal(unsupportedModel.usableByCurrentModel, false);
  fixture.state.tools = true;
  fixture.state.rejectToken = true;
  const rejected = await fixture.reconcile();
  assert.equal(rejected.usable, false);
  assert.equal(rejected.firstFailure?.code, "invalid_mcp_token");
  fixture.state.rejectToken = false;
  fixture.state.registrationFails = true;
  assert.equal((await fixture.reconcile()).usable, false);
});

test("without a selected native engine or legacy URL Cloud remains unconfigured", async () => {
  await using fixture = await nativeFixture();
  await fixture.reconcile();
  const health = await readOpenworkCloudMcpHealth({ ...fixture.input, nativeEngineForWorkspace: undefined });
  assert.equal(health.usable, false);
  assert.equal(health.firstFailure?.code, "opencode_unconfigured");
});
