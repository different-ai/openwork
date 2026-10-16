import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudProviderSync } from "../src/cloud-provider-sync.js";
import { EnvService } from "../src/env-file.js";
import type { OpencodeV2ProviderSpec } from "../src/managed-opencode-v2.js";
import { createLiveProvidersChannel, engineDefaultVariants, isLiveGatewaySpec, liveProviderRecord } from "../src/opencode-v2-live-providers.js";
import { parseLiveProviders, registerLiveProviders, type LiveProvidersContext } from "../src/opencode-plugins/openwork-live-providers-v2.js";
import { serve } from "../src/serve-node.js";
import type { ServerConfig } from "../src/types.js";
import { z } from "zod";

const readRequest = z.object({ input: z.object({ revision: z.number().optional(), waitMs: z.number().optional() }) });

const gateway = (id: string): OpencodeV2ProviderSpec => ({
  id, name: `Gateway ${id}`, apiKey: "ow_gw_witness",
  baseUrl: `https://gateway.example/api/v1/providers/${id}`,
  package: "@opencode/ai/providers/openai",
  models: [
    { id: "gwm_reason", name: "Reasoner", config: { id: "gwm_reason", reasoning: true, limit: { context: 200000, output: 32000 } } },
    { id: "gwm_plain", name: "Plain", config: { reasoning: false } },
  ],
});

// ---- Records ----

test("only providers routed through the gateway are delivered live", () => {
  assert.equal(isLiveGatewaySpec(gateway("ipr_abc")), true);
  assert.equal(isLiveGatewaySpec({ ...gateway("lpr_abc"), baseUrl: "https://gateway.example/api/v1/providers/lpr_abc" }), false);
  assert.equal(isLiveGatewaySpec({ ...gateway("ipr_abc"), baseUrl: "https://api.openai.com/v1" }), false);
});

test("a live record carries the key in settings and never under the provider's own credential", () => {
  const record = liveProviderRecord(gateway("ipr_abc"));
  assert.deepEqual(record.info, {
    id: "ipr_abc", name: "Gateway ipr_abc", activation: "enabled", integrationID: "openwork-gateway",
    package: "@opencode/ai/providers/openai",
    settings: { apiKey: "ow_gw_witness", baseURL: "https://gateway.example/api/v1/providers/ipr_abc", name: "ipr_abc" },
  });
  const [reason, plain] = record.models;
  assert.deepEqual(reason.capabilities, { tools: true, input: ["text"], output: ["text", "reasoning"] });
  assert.deepEqual(reason.variants.map((variant) => variant.id), ["none", "minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(plain.variants, [], "a model that cannot reason gets no inferred efforts");
  assert.deepEqual(plain.limit, { context: 128_000, output: 8_192 });
});

test("engine default variants follow the package, as the engine does for config models", () => {
  assert.deepEqual(engineDefaultVariants("@opencode/ai/providers/openai-compatible", "gwm_x", 8_192).map((v) => v.id), ["low", "medium", "high"]);
  assert.deepEqual(engineDefaultVariants("@opencode/ai/providers/anthropic", "gwm_x", 64_000).map((v) => v.id), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(engineDefaultVariants("@opencode/ai/providers/anthropic", "claude-sonnet-4-5", 64_000),
    [{ id: "high", settings: { thinking: { type: "enabled", budgetTokens: 16_000 } } }, { id: "max", settings: { thinking: { type: "enabled", budgetTokens: 31_999 } } }]);
});

test("a malformed model never reaches the engine, whose whole model list would fail", () => {
  const parsed = parseLiveProviders({ revision: 1, enabled: true, providers: [
    { info: { id: "ipr_abc" }, models: [{ id: "ok", variants: [], limit: {}, capabilities: {} }, { id: "missing-variants", limit: {}, capabilities: {} }] },
    { info: {}, models: [] },
  ] });
  assert.deepEqual(parsed?.providers.map((provider) => [provider.info.id, provider.models.map((model) => model.id)]), [["ipr_abc", ["ok"]]]);
});

// ---- Channel ----

test("a held read returns as soon as the providers change", async () => {
  const channel = createLiveProvidersChannel();
  assert.equal(channel.publish(true, [liveProviderRecord(gateway("ipr_abc"))]), true);
  assert.equal(channel.publish(true, [liveProviderRecord(gateway("ipr_abc"))]), false, "an identical list is not a change");
  const { revision } = channel.current();
  const started = Date.now();
  const held = channel.read({ revision, waitMs: 5_000 });
  setTimeout(() => channel.publish(false, []), 30);
  const next = await held;
  assert.equal(next.revision, revision + 1);
  assert.equal(next.enabled, false);
  assert.ok(Date.now() - started < 1_000);
  assert.equal((await channel.read({ revision: 0, waitMs: 5_000 })).revision, revision + 1, "a stale revision answers at once");
});

// ---- Plugin ----

function fakeEngine() {
  let transform: ((editor: { get(id: string): unknown; add(record: { info: { id: string } }): void; remove(id: string): void }) => void) | undefined;
  const registered = new Map<string, unknown>();
  const hooks = new Set<string>();
  let reloads = 0;
  const rebuild = () => {
    registered.clear();
    transform?.({ get: (id) => registered.get(id), add: (record) => registered.set(record.info.id, record), remove: (id) => registered.delete(id) });
  };
  const context = (url: string, token: string): LiveProvidersContext => ({
    options: { url, token },
    provider: {
      async transform(callback) {
        transform = callback;
        rebuild();
        return { dispose: async () => { transform = undefined; rebuild(); } };
      },
      async reload() { reloads++; rebuild(); },
    },
    session: {
      async hook(_name, _callback, options) {
        hooks.add(options.providerID);
        return { dispose: async () => { hooks.delete(options.providerID); } };
      },
    },
  });
  return { context, providers: () => [...registered.keys()].sort(), hooks: () => [...hooks].sort(), reloads: () => reloads };
}

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("the plugin registers live providers at once and follows every change in memory", async () => {
  const channel = createLiveProvidersChannel();
  channel.publish(true, [liveProviderRecord(gateway("ipr_one"))]);
  const token = "bridge-token";
  const bridge = await serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
    const { input } = readRequest.parse(await request.json());
    return Response.json(await channel.read(input, request.signal));
  } });
  const engine = fakeEngine();
  const stop = await registerLiveProviders(engine.context(`http://127.0.0.1:${bridge.port}/read`, token));
  try {
    assert.deepEqual(engine.providers(), ["ipr_one"], "registered before setup returns, ready for the first prompt");
    assert.deepEqual(engine.hooks(), ["ipr_one"], "usage-limit answers are not retried");

    channel.publish(true, [liveProviderRecord(gateway("ipr_one")), liveProviderRecord(gateway("ipr_two"))]);
    await until(() => engine.providers().length === 2, "second provider");
    assert.deepEqual(engine.hooks(), ["ipr_one", "ipr_two"]);

    // Turned off: the plugin stops adding them and the config file takes over.
    channel.publish(false, []);
    await until(() => engine.providers().length === 0, "turned off");
    assert.deepEqual(engine.hooks(), []);
  } finally {
    await stop();
    await bridge.stop();
  }
});

// ---- Server sync ----

async function syncHarness(input: { live: boolean; revisions: string[] }) {
  const root = await mkdtemp(join(tmpdir(), "openwork-live-models-"));
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "t", hostToken: "h", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1_000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
  };
  const calls: string[] = [];
  let revisionReads = 0;
  let live = input.live;
  const fetchImpl: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path === "/v1/llm-providers") return Response.json({ llmProviders: [] });
    if (path === "/v1/inference-providers") return new Response(null, { status: 404 });
    if (path === "/v1/org") return Response.json({ features: { gatewayLiveModels: live } });
    if (path === "/v1/org/inventory-revision") {
      const revision = input.revisions[Math.min(revisionReads, input.revisions.length - 1)];
      revisionReads++;
      return Response.json({ revision });
    }
    return new Response(null, { status: 404 });
  };
  const flips: boolean[] = [];
  const sync: CloudProviderSync = new CloudProviderSync({
    config, env: new EnvService({ path: join(root, "env.json") }), fetchImpl,
    reloadEngine: async () => ({ action: "reloaded_in_place" }),
    revisionCheckMs: 20,
    onLiveGatewayModelsChanged: () => flips.push(sync.liveGatewayModelsEnabled()),
  });
  const passes = () => calls.filter((path) => path === "/v1/llm-providers").length;
  return {
    sync, flips, passes, calls,
    setLive: (value: boolean) => { live = value; },
    async close() { sync.stop(); await rm(root, { recursive: true, force: true }); },
  };
}

const session = { baseUrl: "https://den.example", token: "den-token", orgId: "org_witness" };

test("with live gateway models on, a Den change starts a pass within one revision check", async () => {
  const harness = await syncHarness({ live: true, revisions: ["r1", "r1", "r1", "r2"] });
  try {
    await harness.sync.setSession(session);
    await until(() => harness.flips.length === 1, "switch read");
    assert.deepEqual(harness.flips, [true]);
    // The first pass read no revision (the switch was unknown): one catch-up pass records r1.
    await until(() => harness.passes() >= 2, "catch-up pass");
    const settled = harness.passes();
    await until(() => harness.passes() > settled, "pass after r2");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterChange = harness.passes();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(harness.passes(), afterChange, "an unchanged revision starts no further pass");
  } finally {
    await harness.close();
  }
});

test("with live gateway models off, Den's revision is never polled", async () => {
  const harness = await syncHarness({ live: false, revisions: ["r1"] });
  try {
    await harness.sync.setSession(session);
    await until(() => harness.passes() === 1 && harness.calls.includes("/v1/org"), "first pass");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(harness.calls.filter((path) => path === "/v1/org/inventory-revision").length, 0);
    assert.equal(harness.sync.liveGatewayModelsEnabled(), false);
    assert.deepEqual(harness.flips, []);
  } finally {
    await harness.close();
  }
});

test("turning the switch off is noticed on the next pass and re-mirrors the engine", async () => {
  const harness = await syncHarness({ live: true, revisions: ["r1"] });
  try {
    await harness.sync.setSession(session);
    await until(() => harness.flips.length === 1, "on");
    harness.setLive(false);
    await harness.sync.run("manual");
    assert.deepEqual(harness.flips, [true, false]);
    assert.equal(harness.sync.liveGatewayModelsEnabled(), false);
  } finally {
    await harness.close();
  }
});
