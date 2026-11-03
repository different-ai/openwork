import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudProviderSync, type CloudProviderDenSession } from "../src/cloud-provider-sync.js";
import { EnvService } from "../src/env-file.js";
import { createEngineV2Preview, shouldSyncLiveProviderOwnerTransition, shouldWaitForMirroredProviders, waitForEngineV2Catalog } from "../src/engine-v2-preview.js";
import { managedDesktopPolicy } from "../src/managed-desktop-policy.js";
import { serve } from "../src/serve-node.js";
import { renderOpencodeV2Config, type OpencodeV2ProviderSpec } from "../src/managed-opencode-v2.js";
import { createV2ProviderSessionBridge, providerSessionIdentity } from "../src/opencode-v2-provider-session.js";
import type { ServerConfig } from "../src/types.js";
import { readGlobalRuntimeOpencodeConfig, writeGlobalRuntimeOpencodeConfig } from "../src/runtime-opencode-config-store.js";
import { writeOpenworkWorkspaceConfig } from "../src/openwork-workspace-config-store.js";

const gateway: OpencodeV2ProviderSpec = { id: "ipr_test", name: "Gateway", apiKey: "gateway-test-secret", models: [{ id: "model", name: "Model" }], whitelist: ["model"], blacklist: ["blocked"] };
const legacy: OpencodeV2ProviderSpec = { ...gateway, id: "lpr_test", name: "Legacy" };
const session: CloudProviderDenSession = { baseUrl: "https://example.invalid/api/den", token: "den-test-secret", orgId: "org_test" };
function config(dir: string): ServerConfig {
  return { host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(dir, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false };
}

test("unmanaged v2 keeps Gateway config without a private identity bridge", () => {
  const rendered = renderOpencodeV2Config({ providers: [gateway, legacy], skills: [], providerSyncPluginDirectory: "/plugins/live" });
  assert.ok(JSON.stringify(rendered).includes("gateway-test-secret"));
  assert.ok(!JSON.stringify(rendered).includes("/plugins/live"));
});


test("live owner strips the entire Gateway config row while retaining local/legacy rows and filters", () => {
  const rendered = renderOpencodeV2Config({ providers: [gateway, legacy], skills: [], providerSyncPluginDirectory: "/plugins/live",
    providerFiltersPluginDirectory: "/plugins/filters", desktopSession: "http://127.0.0.1:1234/session" });
  assert.deepEqual(Object.keys(Object(rendered.providers)), ["lpr_test"]);
  const serialized = JSON.stringify(rendered);
  assert.ok(!serialized.includes("liveProviderSync"), "the plugin needs no rollout option");
  assert.ok(serialized.includes('"ipr_test":{"whitelist":["model"],"blacklist":["blocked"]}'));
  assert.ok(!serialized.includes("den-test-secret"));
  assert.ok(!serialized.includes("OPENWORK_PROVIDER_SESSION_TOKEN"));
});

test("filters for live-only rows survive separately and disabled providers win", () => {
  const rendered = renderOpencodeV2Config({ providers: [], skills: [], desktopSession: "http://127.0.0.1:1234/session",
    providerFiltersPluginDirectory: "/plugins/filters", providerFilters: { ipr_test: { whitelist: ["model"] } }, disabledProviderIds: ["ipr_test"] });
  assert.deepEqual(rendered.providers, {});
  assert.ok(JSON.stringify(rendered).includes('"ipr_test":{"whitelist":[]}'));
});

test("credential handoff requires its dedicated capability and reads the current identity without caching", async () => {
  let current: CloudProviderDenSession | null = null;
  const bridge = await createV2ProviderSessionBridge(() => current);
  const headers = { authorization: `Bearer ${bridge.token}` };
  try {
    assert.equal((await fetch(bridge.url)).status, 401);
    assert.equal((await fetch(bridge.url, { headers: { authorization: "Bearer host-test" } })).status, 401);
    assert.equal((await fetch(bridge.url, { method: "POST", headers })).status, 404);
    assert.equal((await fetch(bridge.url, { headers: { ...headers, origin: "http://example.invalid" } })).status, 404);
    const signedOut = await fetch(bridge.url, { headers });
    assert.equal(signedOut.headers.get("cache-control"), "no-store");
    assert.equal(await signedOut.json(), null);
    current = session;
    const metadata = await (await fetch(bridge.url, { headers })).json();
    assert.equal(metadata.apiBaseUrl, session.baseUrl);
    assert.equal(metadata.identity, providerSessionIdentity(session));
    assert.equal(metadata.orgId, session.orgId);
    assert.equal(metadata.inferenceOrigin, new URL(bridge.url).origin);
    assert.match(metadata.inferenceKey, /^ow_local_[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(metadata).includes(session.token));
    current = { ...session, token: "new-test-secret", orgId: "org_other" };
    assert.equal((await (await fetch(bridge.url, { headers })).json()).orgId, "org_other");
    current = null;
    assert.equal(await (await fetch(bridge.url, { headers })).json(), null);
  } finally { await bridge.close(); }
});

for (const live of [false, true]) test(`cloud sync ${live ? "v2 suppresses Gateway polling and retains legacy" : "v1 keeps legacy Gateway polling"}`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-provider-sync-"));
  const previous = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(dir, "runtime.sqlite");
  const requests: string[] = [];
  const sync = new CloudProviderSync({ config: config(dir), env: new EnvService({ path: join(dir, "env.json") }),
    liveProviderSync: async () => live, reloadEngine: async () => ({ action: "updated_live" }),
    fetchImpl: Object.assign(async (input: string | URL | Request) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).pathname;
      requests.push(path);
      if (path.endsWith("/llm-providers")) return Response.json({ llmProviders: [{ id: "lpr_test", providerId: "test", name: "Legacy", providerConfig: {}, models: [] }] });
      if (path.endsWith("/lpr_test/connect")) return Response.json({ llmProvider: { id: "lpr_test", providerId: "test", name: "Legacy", providerConfig: {}, models: [] } });
      if (path.endsWith("/inference-providers")) return Response.json({ inferenceProviders: [] });
      throw new Error("unexpected request");
    }, { preconnect: fetch.preconnect }),
  });
  try {
    if (live) {
      await writeGlobalRuntimeOpencodeConfig(config(dir), () => ({ provider: { ipr_test: {
        npm: "@ai-sdk/openai-compatible", options: { apiKey: "retired-gateway-secret" }, models: { model: {} }, whitelist: ["model"], blacklist: ["blocked"],
      } } }));
      await writeOpenworkWorkspaceConfig(config(dir), "__cloud_provider_ownership__", () => ({ providerIds: ["ipr_test"], envHashes: {},
        materializationContextHash: createHash("sha256").update(`${session.baseUrl}\u0000${session.orgId}\u0000${session.token}`).digest("hex") }));
    }
    await sync.setSession(session);
    assert.notEqual((await sync.run("test")).status, "failed");
    assert.equal(requests.some(path => path.endsWith("/inference-providers")), !live);
    assert.ok(requests.some(path => path.endsWith("/lpr_test/connect")));
    assert.deepEqual(sync.status().providers.map(provider => provider.providerId), ["lpr_test"]);
    if (live) {
      const runtime = await readGlobalRuntimeOpencodeConfig(config(dir));
      assert.deepEqual(runtime.provider?.ipr_test, { whitelist: ["model"], blacklist: ["blocked"] }, "handoff persists catalog rules only, never credentials or static models");
      assert.ok(!JSON.stringify(runtime).includes("retired-gateway-secret"));
    }
    assert.deepEqual(sync.currentSession(), session);
    assert.deepEqual(sync.providerBridgeSession(), session);
    assert.ok(!JSON.stringify(sync.status()).includes(session.token));
    assert.ok(!JSON.stringify(sync.status()).includes(session.baseUrl));
    // ENG-994: delivering the same sign-in again must not revoke the bridge,
    // even while materialization is paused, or live Gateway replies are cut.
    await sync.suspendForSession({ ...session });
    assert.deepEqual(sync.providerBridgeSession(), session, "same sign-in keeps the bridge");
    await sync.suspend();
    assert.equal(sync.currentSession(), null);
    assert.deepEqual(sync.providerBridgeSession(), session, "a same-sign-in pause keeps the bridge");
    await sync.setSession({ ...session });
    assert.deepEqual(sync.currentSession(), session);
    const suspended = sync.suspendForSession({ ...session, orgId: "org_other" });
    assert.equal(sync.currentSession(), null, "account switch revokes bridge before awaited cleanup");
    assert.equal(sync.providerBridgeSession(), null, "account switch revokes bridge before awaited cleanup");
    await suspended;
    await sync.setSession({ ...session, orgId: "org_other" });
    assert.deepEqual(sync.providerBridgeSession(), { ...session, orgId: "org_other" });
    const cleared = sync.clearSession();
    assert.equal(sync.currentSession(), null, "sign-out revokes bridge synchronously");
    assert.equal(sync.providerBridgeSession(), null, "sign-out revokes bridge synchronously");
    await cleared;
  } finally {
    sync.stop();
    if (previous === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("managed v2 owns Gateway inventory before sign-in hydration; v1 retains its own writer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-live-owner-"));
  await writeFile(join(dir, "engine-v2-preview.json"), JSON.stringify({ enabled: true, chatRouting: true }));
  const engine = createEngineV2Preview({ config: config(dir), deferStart: true, providerSession: () => null });
  try {
    assert.equal(engine.status().liveProviderSync, true);
    await engine.setChatRouting(false);
    assert.equal(engine.status().liveProviderSync, false);
  } finally { await engine.stop(); await rm(dir, { recursive: true, force: true }); }
});

test("only provider ownership transitions trigger a cloud sync pass", () => {
  assert.equal(shouldSyncLiveProviderOwnerTransition(false, false), false);
  assert.equal(shouldSyncLiveProviderOwnerTransition(true, false), true);
  assert.equal(shouldSyncLiveProviderOwnerTransition(false, true), true);
  assert.equal(shouldSyncLiveProviderOwnerTransition(true, true), false);
});

test("Gateway-only live mode performs no old catalog reads or push/readiness waits", async () => {
  let reads = 0;
  const engine = { fetchJson: async () => { reads++; return { status: 200, json: { data: [] } }; } };
  for (const specs of [[], [gateway]]) {
    assert.equal(shouldWaitForMirroredProviders(true, specs), false);
    assert.deepEqual(await waitForEngineV2Catalog(engine, "/test", specs, 0, () => true), { modelIds: [] });
  }
  assert.equal(reads, 0);
  assert.equal(shouldWaitForMirroredProviders(true, [legacy]), true);
  assert.equal(shouldWaitForMirroredProviders(false, []), true);
  await waitForEngineV2Catalog(engine, "/test", [], 0, () => false);
  assert.equal(reads, 1);
});

test("unreachable Den keeps model access in cached policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-live-fresh-policy-"));
  const previous = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(dir, "runtime.sqlite");
  let unavailable = false;
  const server = await serve({ hostname: "127.0.0.1", port: 0, fetch: () => unavailable
    ? new Response(null, { status: 500 })
    : Response.json({ allowCustomProviders: false }) });
  const policy = managedDesktopPolicy(config(dir));
  try {
    await policy.setSession({ ...session, baseUrl: `http://127.0.0.1:${server.port}` });
    const current = await policy.current();
    unavailable = true;
    const fallback = await policy.current();
    assert.equal(fallback?.allowCustomProviders, false);
  } finally {
    await server.stop();
    await policy.clearSession();
    if (previous === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("ENG-994: a repeated identity delivery keeps live Gateway replies streaming; an account switch still ends them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-provider-bridge-"));
  const previous = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(dir, "runtime.sqlite");
  const den: CloudProviderDenSession = { baseUrl: "https://den.example.invalid", token: "den-bridge-secret", orgId: "org_bridge" };
  const providerId = "ipr_bridge";
  const gatewayBase = `https://gateway.example.invalid/api/v1/providers/${providerId}`;
  const chunks = 30;
  const sync = new CloudProviderSync({ config: config(dir), env: new EnvService({ path: join(dir, "env.json") }),
    liveProviderSync: async () => true, reloadEngine: async () => ({ action: "updated_live" }),
    fetchImpl: Object.assign(async (input: string | URL | Request) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).pathname;
      if (path.endsWith("/llm-providers")) return Response.json({ llmProviders: [] });
      if (path.endsWith("/inference-providers")) return Response.json({ inferenceProviders: [] });
      return Response.json({});
    }, { preconnect: fetch.preconnect }),
  });
  const bridge = await createV2ProviderSessionBridge(() => sync.providerBridgeSession(), { fetch: async (url) => {
    if (url.endsWith(`/v1/inference-providers/${providerId}/connect`)) {
      return Response.json({ inferenceProvider: { id: providerId, apiKey: "ow_gw_bridge_key", providerConfig: { options: { baseURL: gatewayBase } } } });
    }
    let sent = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    return new Response(new ReadableStream<Uint8Array>({
      start(output) {
        timer = setInterval(() => {
          sent++;
          output.enqueue(new TextEncoder().encode(`data: tick${sent}\n\n`));
          if (sent >= chunks) { clearInterval(timer); output.close(); }
        }, 15);
      },
      cancel() { clearInterval(timer); },
    }), { headers: { "content-type": "text/event-stream" } });
  } });
  const stream = async () => {
    const metadata = await (await fetch(bridge.url, { headers: { authorization: `Bearer ${bridge.token}` } })).json();
    const response = await fetch(`${metadata.inferenceOrigin}/api/v1/providers/${providerId}/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${metadata.inferenceKey}`, "content-type": "application/json" }, body: "{}",
    });
    assert.equal(response.status, 200);
    return response;
  };
  const readAll = async (response: Response) => {
    const reader = response.body?.getReader();
    let text = "";
    while (reader) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    return text;
  };
  try {
    await sync.setSession(den);
    const first = await stream();
    const reading = readAll(first);
    await new Promise(resolve => setTimeout(resolve, 60));
    // What PUT /den-session/identity and PUT /den-session do on every route mount.
    await sync.suspendForSession({ ...den });
    await sync.suspend();
    await new Promise(resolve => setTimeout(resolve, 60));
    await sync.setSession({ ...den });
    assert.ok((await reading).includes(`tick${chunks}`), "the reply finished through a same-sign-in delivery");

    const second = await stream();
    const cut = readAll(second);
    await new Promise(resolve => setTimeout(resolve, 60));
    await sync.suspendForSession({ ...den, orgId: "org_other" });
    assert.ok(!(await cut).includes(`tick${chunks}`), "a different sign-in ends the old identity's reply");
  } finally {
    sync.stop();
    await bridge.close();
    if (previous === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
