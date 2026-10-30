import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createManagedOpencodeV2Server } from "../src/managed-opencode-v2.js";
import { createV2ProviderSessionBridge } from "../src/opencode-v2-provider-session.js";

// The real managed V2 engine, the real provider-sync plugin and credential
// broker, and the real local session bridge. Only the loopback hop between the
// engine and the bridge is wrapped, so the local session check can be made to
// stall past the plugin's 1.5 s timeout the way it does on a busy desktop.
const binary = process.env.OPENWORK_TEST_OPENCODE2 ?? "/Applications/OpenWork.app/Contents/Resources/sidecars/opencode2";
const PROVIDER = "ipr_stallfixture";
const MODEL = "gwm_stallfixture";
const ANSWER = "Answered while the session check stalled";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) { last = await read(); if (accept(last)) return last; await delay(50); }
  throw new Error(`Timed out: ${label}; last=${JSON.stringify(last)}`);
}
async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("native: a stalled local session check does not withdraw providers or fail a turn's model lookup", { timeout: 120_000 }, async t => {
  try { await access(binary); } catch { t.skip(`needs: pinned OpenCode 2.0.26 binary (${binary}); set OPENWORK_TEST_OPENCODE2`); return; }
  assert.match(spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout, /\bv2\.0\.26\b/);
  const root = await mkdtemp(join(tmpdir(), "openwork-session-stall-"));
  const home = join(root, "home"); const directory = join(root, "project");
  await mkdir(home); await mkdir(directory);
  const denToken = "host_only_stall_native_den_token";
  const gatewayToken = "ow_gw_host_only_stall_native_gateway_key";
  let signedIn = true;
  let inference = 0;
  const streams = new Set<ServerResponse>();

  // Fake Den + Gateway on loopback.
  const source = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST") {
      inference++; request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "stall", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: ANSWER }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "stall", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    assert.equal(request.headers.authorization, `Bearer ${denToken}`);
    if (url.pathname.endsWith("/inventory/events")) {
      response.writeHead(200, { "content-type": "text/event-stream" }); response.write(": connected\n\n");
      streams.add(response); request.on("close", () => streams.delete(response)); return;
    }
    response.setHeader("content-type", "application/json");
    const provider = { id: PROVIDER, providerId: "openai-compatible", name: "Stall fixture", credentialStatus: "ready",
      providerConfig: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `${origin}/api/v1/providers/${PROVIDER}` } },
      models: [{ id: MODEL, name: "Stall fixture", config: { id: "fixture", tool_call: true, limit: { context: 8192, output: 1024 } } }] };
    if (url.pathname.endsWith("/connect")) response.end(JSON.stringify({ inferenceProvider: { ...provider, apiKey: gatewayToken } }));
    else response.end(JSON.stringify({ inferenceProviders: [provider] }));
  });
  const origin = await listen(source);
  const bridge = await createV2ProviderSessionBridge(() => signedIn ? { baseUrl: origin, token: denToken, orgId: "org_stallfixture" } : null);
  const bridgeOrigin = new URL(bridge.url).origin;

  // Loopback hop: forwards everything to the bridge; while `stall` is on, holds
  // /session for 2.5 s (longer than the plugin's 1.5 s timeout).
  let stall = false;
  let stalledChecks = 0;
  let sessionChecks = 0;
  const forward = (req: IncomingMessage, res: ServerResponse, rewrite: boolean) => {
    const upstream = httpRequest(`${bridgeOrigin}${req.url ?? "/"}`, { method: req.method, headers: req.headers }, up => {
      if (!rewrite) { res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res); return; }
      // The bridge names its own origin for inference; point it at this hop.
      let body = "";
      up.setEncoding("utf8");
      up.on("data", chunk => { body += chunk; });
      up.on("end", () => { if (!res.destroyed) { res.writeHead(up.statusCode ?? 502, { "content-type": "application/json" }); res.end(body.split(bridgeOrigin).join(hopOrigin)); } });
    });
    upstream.on("error", () => res.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  };
  const hop = createServer((req, res) => {
    const isSession = new URL(req.url ?? "/", "http://127.0.0.1").pathname === "/session";
    if (isSession) sessionChecks++;
    if (isSession && stall) {
      const timer = setTimeout(() => { if (!res.destroyed) forward(req, res, true); }, 2500);
      req.on("close", () => { if (!res.writableEnded) { clearTimeout(timer); stalledChecks++; } });
      return;
    }
    forward(req, res, isSession);
  });
  const hopOrigin = await listen(hop);

  let engine: Awaited<ReturnType<typeof createManagedOpencodeV2Server>> | undefined;
  try {
    engine = await createManagedOpencodeV2Server({ bin: binary, rootDir: join(root, "engine"),
      env: { HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), OPENCODE_DISABLE_MODELS_FETCH: "true" },
      providerSession: { url: `${hopOrigin}/session`, token: bridge.token } });
    const running = engine;
    const hasModel = async () => JSON.stringify((await running.fetchJson("/api/model", { directory })).json).includes(`"id":"${MODEL}"`);
    await until(hasModel, Boolean, "signed-in desktop publishes the gateway model");

    // Stall every local session check for ~5 s while sampling what a turn would see.
    stall = true;
    const stalledAt = stalledChecks;
    const samples: boolean[] = [];
    const deadline = Date.now() + 5_000;
    let turn: string | undefined;
    while (Date.now() < deadline) {
      samples.push(await hasModel());
      // Start a turn once at least one check has timed out: its model lookup
      // lands inside the window where dev had already withdrawn the provider.
      if (!turn && stalledChecks > stalledAt) {
        const created = await running.fetchJson("/api/session", { method: "POST", body: { title: "Stalled check", location: { directory }, model: { providerID: PROVIDER, id: MODEL } } });
        assert.ok(record(created.json) && record(created.json.data) && typeof created.json.data.id === "string", JSON.stringify(created.json));
        turn = created.json.data.id;
        await running.fetchJson(`/api/session/${turn}/prompt`, { method: "POST", body: { text: "Answer the fixture." } });
      }
      await delay(100);
    }
    const timedOut = stalledChecks - stalledAt;
    const missing = samples.filter(present => !present).length;
    t.diagnostic(`stalled session checks timed out: ${timedOut}; model-list samples: ${samples.length}; samples missing the model: ${missing}`);
    assert.ok(timedOut >= 2, "the plugin's local session checks really timed out");
    assert.ok(turn, "a turn started during the stall");
    // Assert on the real engine's native model catalog before waiting for the
    // failed turn to settle. On the old code this fails deterministically with
    // missing > 0, and the engine marks the turn failed while resolving model.
    assert.equal(missing, 0, "providers stayed published through every stalled session check");
    const messages = await until(async () => JSON.stringify((await running.fetchJson(`/api/session/${turn}/message`)).json),
      text => text.includes(ANSWER), "the turn answers with its selected model");
    t.diagnostic(`turn answered (${inference} inference request)`);
    assert.ok(messages.includes(ANSWER));

    // Recovery is a no-op, and a real sign-out (bridge answers 200 null) still withdraws.
    stall = false;
    await delay(1500);
    assert.ok(await hasModel());
    signedIn = false;
    await until(async () => !(await hasModel()), Boolean, "explicit sign-out withdraws providers");
    t.diagnostic(`total local session checks: ${sessionChecks}`);
  } finally {
    await engine?.close(); await bridge.close();
    for (const stream of streams) stream.end();
    hop.closeAllConnections(); await new Promise<void>(resolve => hop.close(() => resolve()));
    source.closeAllConnections(); await new Promise<void>(resolve => source.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
