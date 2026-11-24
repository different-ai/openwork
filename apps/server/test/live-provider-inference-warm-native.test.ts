import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createManagedOpencodeV2Server } from "../src/managed-opencode-v2.js";
import { createV2ProviderSessionBridge } from "../src/opencode-v2-provider-session.js";
const binary = process.env.OPENWORK_TEST_OPENCODE2 ?? "/Applications/OpenWork.app/Contents/Resources/sidecars/opencode2";
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < 400; i++) { last = await read(); if (accept(last)) return last; await delay(50); }
  throw new Error(`Native warm inference did not converge: ${JSON.stringify(last)}`);
}

test("native warm offline catalog infers through a new bridge port/key without exposing reusable credentials", { timeout: 90_000 }, async t => {
  try { await access(binary); } catch { t.skip(`needs: pinned OpenCode 2.0.26 binary (${binary})`); return; }
  assert.match(spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout, /\bv2\.0\.26\b/);
  const root = await mkdtemp(join(tmpdir(), "openwork-warm-scoped-inference-"));
  const home = join(root, "home"); const directory = join(root, "project");
  await mkdir(home); await mkdir(directory);
  const denToken = "host_only_warm_native_den_token";
  const gatewayToken = "ow_gw_host_only_warm_native_gateway_key";
  let catalogOnline = true; let inference = 0; let connects = 0; let quota = false;
  const streams = new Set<ServerResponse>();
  const source = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST") {
      assert.equal(url.pathname, "/api/v1/providers/ipr_warmfixture/chat/completions");
      assert.equal(request.headers.authorization, `Bearer ${gatewayToken}`);
      inference++; request.resume();
      if (quota) {
        response.writeHead(429, { "content-type": "application/json", "x-openwork-error-code": "openwork_gateway_usage_limit_exceeded", "x-openwork-usage-state": "blocked", "retry-after": "60" });
        response.end(JSON.stringify({ error: { code: "openwork_gateway_usage_limit_exceeded", source: "openwork_gateway", type: "usage_limit_error", message: "You have reached your AI Gateway usage limit." } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "warm-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Warm scoped inference works" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "warm-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    assert.equal(request.headers.authorization, `Bearer ${denToken}`);
    response.setHeader("content-type", "application/json");
    if (url.pathname.endsWith("/inventory/events")) {
      if (!catalogOnline) { response.writeHead(503); response.end("{}"); return; }
      response.writeHead(200, { "content-type": "text/event-stream" }); response.write(": connected\n\n");
      streams.add(response); request.on("close", () => streams.delete(response)); return;
    }
    const provider = { id: "ipr_warmfixture", providerId: "openai-compatible", name: "Warm fixture", credentialStatus: "ready",
      providerConfig: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `${origin}/api/v1/providers/ipr_warmfixture` } },
      models: [{ id: "gwm_warmfixture", name: "Warm fixture", config: { id: "fixture", tool_call: true, limit: { context: 8192, output: 1024 } } }] };
    if (url.pathname.endsWith("/connect")) { connects++; response.end(JSON.stringify({ inferenceProvider: { ...provider, apiKey: gatewayToken } })); }
    else if (!catalogOnline) { response.writeHead(503); response.end("{}"); }
    else response.end(JSON.stringify({ inferenceProviders: [provider] }));
  });
  source.listen(0, "127.0.0.1"); await once(source, "listening");
  const address = source.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const session = () => ({ baseUrl: origin, token: denToken, orgId: "org_warmfixture" });
  let bridge = await createV2ProviderSessionBridge(session);
  let engine: Awaited<ReturnType<typeof createManagedOpencodeV2Server>> | undefined;
  const boot = async () => createManagedOpencodeV2Server({ bin: binary, rootDir: join(root, "engine"),
    env: { HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), OPENCODE_DISABLE_MODELS_FETCH: "true" },
    providerSession: { ...bridge } });
  const metadata = async () => (await (await fetch(bridge.url, { headers: { authorization: `Bearer ${bridge.token}` } })).json());
  try {
    engine = await boot();
    await until(() => engine!.fetchJson("/api/model", { directory }), value => JSON.stringify(value.json).includes('"id":"gwm_warmfixture"'));
    const old = await metadata();
    await delay(200);
    await engine.close(); engine = undefined;
    await bridge.close();
    catalogOnline = false;
    bridge = await createV2ProviderSessionBridge(session);
    const fresh = await metadata();
    assert.equal(fresh.identity, old.identity);
    assert.notEqual(fresh.inferenceOrigin, old.inferenceOrigin);
    assert.notEqual(fresh.inferenceKey, old.inferenceKey);
    engine = await boot();
    await until(() => engine!.fetchJson("/api/model", { directory }), value => JSON.stringify(value.json).includes('"id":"gwm_warmfixture"'));
    const native = JSON.stringify((await engine.fetchJson("/api/provider", { directory })).json);
    assert.ok(native.includes(fresh.inferenceOrigin)); assert.ok(native.includes(fresh.inferenceKey));
    for (const raw of [denToken, gatewayToken, old.inferenceKey, old.inferenceOrigin]) assert.ok(!native.includes(raw), raw);
    const before = connects;
    const created = await engine.fetchJson("/api/session", { method: "POST", body: { title: "Warm scoped inference", location: { directory }, model: { providerID: "ipr_warmfixture", id: "gwm_warmfixture" } } });
    assert.ok(record(created.json) && record(created.json.data) && typeof created.json.data.id === "string");
    const id = created.json.data.id;
    assert.equal((await engine.fetchJson(`/api/session/${id}/prompt`, { method: "POST", body: { text: "Return the synthetic warm fixture answer." } })).status, 200);
    await until(() => engine!.fetchJson(`/api/session/${id}/message`), value => JSON.stringify(value.json).includes("Warm scoped inference works"));
    assert.equal(inference, 1); assert.equal(connects, before + 1, "native inference authorizes a fresh per-request connect despite offline catalog");
    quota = true;
    const quotaChat = await engine.fetchJson("/api/session", { method: "POST", body: { title: "Scoped quota", location: { directory }, model: { providerID: "ipr_warmfixture", id: "gwm_warmfixture" } } });
    assert.ok(record(quotaChat.json) && record(quotaChat.json.data) && typeof quotaChat.json.data.id === "string");
    const quotaId = quotaChat.json.data.id;
    await engine.fetchJson(`/api/session/${quotaId}/prompt`, { method: "POST", body: { text: "Return the synthetic quota error." } });
    await until(() => engine!.fetchJson(`/api/session/${quotaId}/message`), value => JSON.stringify(value.json).includes("You have reached your AI Gateway usage limit."));
    await delay(2500);
    assert.equal(inference, 2, "actual native quota hook recognizes proxied loopback markers and does not retry 429");
    const generated = await readFile(join(root, "engine/config/opencode.json"), "utf8");
    for (const raw of [denToken, gatewayToken, fresh.inferenceKey]) assert.ok(!generated.includes(raw));
  } finally {
    await engine?.close(); await bridge.close(); for (const stream of streams) stream.end();
    source.closeAllConnections(); await new Promise<void>(resolve => source.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
