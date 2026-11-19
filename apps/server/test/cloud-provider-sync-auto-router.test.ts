import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AUTO_ROUTER_API_KEY_ENV, CloudProviderSync, type CloudProviderDenSession } from "../src/cloud-provider-sync.js";
import { mapRuntimeProvidersToV2Specs } from "../src/engine-v2-preview.js";
import { EnvService } from "../src/env-file.js";
import { readGlobalRuntimeOpencodeConfig, runtimeProviderMap } from "../src/runtime-opencode-config-store.js";
import type { ServerConfig } from "../src/types.js";

const session: CloudProviderDenSession = { baseUrl: "https://example.invalid/api/den", token: "den-test-secret", orgId: "org_test" };

function config(dir: string): ServerConfig {
  return { host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(dir, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false };
}

type AutoReply = { status: number; body?: unknown } | "network_error";

const connected = {
  models: [{ id: "openwork-smart-ar_engineering", name: "Smart: Engineering" }],
  baseURL: "https://gateway.example.invalid/api/v1",
  apiKey: "ow_gw_member_key",
};

function denWithAutoRouter(reply: { current: AutoReply }) {
  return Object.assign(async (input: string | URL | Request) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).pathname;
    if (path.endsWith("/llm-providers")) return Response.json({ llmProviders: [] });
    if (path.endsWith("/inference-providers")) return Response.json({ inferenceProviders: [] });
    if (path.endsWith("/me/prompts")) return Response.json({ prompts: [] });
    if (path.endsWith("/v1/org/auto-router/connect")) {
      if (reply.current === "network_error") throw new Error("connection refused");
      return Response.json(reply.current.body ?? { error: "not_found" }, { status: reply.current.status });
    }
    throw new Error(`unexpected request ${path}`);
  }, { preconnect: fetch.preconnect });
}

async function withSync(run: (input: { sync: CloudProviderSync; dir: string; env: EnvService; reply: { current: AutoReply } }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "openwork-auto-router-"));
  const reply: { current: AutoReply } = { current: { status: 404 } };
  const env = new EnvService({ path: join(dir, "env.json") });
  const sync = new CloudProviderSync({
    config: config(dir), env,
    reloadEngine: async () => ({ action: "updated_live" }), fetchImpl: denWithAutoRouter(reply),
  });
  try {
    await run({ sync, dir, env, reply });
  } finally {
    sync.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

async function autoProvider(dir: string) {
  return runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config(dir)))["openwork-auto"];
}

const smartModel = (id: string, name: string) => ({
  id, name, attachment: true, reasoning: false, tool_call: true,
  limit: { context: 200_000, output: 32_000 },
  modalities: { input: ["text", "image"], output: ["text"] },
});

test("a Smart Router materializes one openai-compatible Smart model with its key in the env store", async () => {
  await withSync(async ({ sync, dir, env, reply }) => {
    reply.current = { status: 200, body: connected };
    await sync.setSession(session);
    assert.deepEqual(await sync.run("test"), { status: "applied" });

    const provider = await autoProvider(dir);
    assert.deepEqual(provider, {
      id: "openwork-auto",
      name: "Smart Model Router",
      env: [AUTO_ROUTER_API_KEY_ENV],
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "https://gateway.example.invalid/api/v1" },
      models: { "openwork-smart-ar_engineering": smartModel("openwork-smart-ar_engineering", "Smart: Engineering") },
    });
    const stored = new Map((await env.list()).map((entry) => [entry.key, entry.value]));
    assert.equal(stored.get(AUTO_ROUTER_API_KEY_ENV), "ow_gw_member_key");
    assert.equal(sync.status().providers.length, 0, "Smart is not listed as an imported provider");

    // OpenCode v2 receives it through the ordinary provider mirror.
    const mapped = mapRuntimeProvidersToV2Specs({ "openwork-auto": provider }, stored, new Map(), new Set(["openwork-auto"]));
    assert.equal(mapped.specs[0]?.package, "@opencode/ai/providers/openai-compatible");
    assert.equal(mapped.specs[0]?.apiKey, "ow_gw_member_key");

    assert.equal((await sync.run("test")).status, "noop");
  });
});

test("two Smart Routers become two models of the one provider; a router going away re-syncs", async () => {
  await withSync(async ({ sync, dir, reply }) => {
    const design = { id: "openwork-smart-ar_design", name: "Smart: Design" };
    reply.current = { status: 200, body: { ...connected, models: [...connected.models, design, { ...design, name: "Duplicate" }, { id: " ", name: "Blank" }] } };
    await sync.setSession(session);
    assert.deepEqual(await sync.run("test"), { status: "applied" });
    assert.deepEqual(Object(await autoProvider(dir)).models, {
      "openwork-smart-ar_engineering": smartModel("openwork-smart-ar_engineering", "Smart: Engineering"),
      "openwork-smart-ar_design": smartModel("openwork-smart-ar_design", "Smart: Design"),
    });

    reply.current = { status: 200, body: { ...connected, models: [design] } };
    assert.equal((await sync.run("test")).status, "applied");
    assert.deepEqual(Object.keys(Object(Object(await autoProvider(dir)).models)), ["openwork-smart-ar_design"]);
  });
});

test("a rotated key or base URL re-syncs Smart", async () => {
  await withSync(async ({ sync, dir, env, reply }) => {
    reply.current = { status: 200, body: connected };
    await sync.setSession(session);
    await sync.run("test");
    reply.current = { status: 200, body: { ...connected, apiKey: "ow_gw_rotated", baseURL: "https://other.example.invalid/api/v1" } };
    assert.equal((await sync.run("test")).status, "applied");
    assert.equal(Object(Object(await autoProvider(dir)).options).baseURL, "https://other.example.invalid/api/v1");
    assert.equal((await env.list()).find((entry) => entry.key === AUTO_ROUTER_API_KEY_ENV)?.value, "ow_gw_rotated");
  });
});

test("an unreachable Den keeps Smart; a 404 removes it and its key without failing sync", async () => {
  await withSync(async ({ sync, dir, env, reply }) => {
    reply.current = { status: 200, body: connected };
    await sync.setSession(session);
    await sync.run("test");

    reply.current = "network_error";
    assert.notEqual((await sync.run("test")).status, "failed");
    assert.ok(await autoProvider(dir));

    reply.current = { status: 500 };
    assert.notEqual((await sync.run("test")).status, "failed");
    assert.ok(await autoProvider(dir));

    reply.current = { status: 404 };
    assert.equal((await sync.run("test")).status, "applied");
    assert.equal(await autoProvider(dir), undefined);
    assert.equal((await env.list()).some((entry) => entry.key === AUTO_ROUTER_API_KEY_ENV), false);
  });
});

test("an invalid connect answer offers no Smart", async () => {
  await withSync(async ({ sync, dir, reply }) => {
    reply.current = { status: 200, body: { ...connected, baseURL: "file:///etc/passwd" } };
    await sync.setSession(session);
    assert.notEqual((await sync.run("test")).status, "failed");
    assert.equal(await autoProvider(dir), undefined);
    reply.current = { status: 200, body: { ...connected, models: [{ id: "  ", name: "Blank" }] } };
    assert.notEqual((await sync.run("test")).status, "failed");
    assert.equal(await autoProvider(dir), undefined);
    reply.current = { status: 200, body: { baseURL: connected.baseURL, apiKey: connected.apiKey, model: { id: "openwork-auto", name: "Auto" } } };
    assert.notEqual((await sync.run("test")).status, "failed");
    assert.equal(await autoProvider(dir), undefined, "the old single-model answer is not offered");
  });
});

test("signing out removes Smart", async () => {
  await withSync(async ({ sync, dir, env, reply }) => {
    reply.current = { status: 200, body: connected };
    await sync.setSession(session);
    await sync.run("test");
    await sync.clearSession();
    assert.equal(await autoProvider(dir), undefined);
    assert.equal((await env.list()).some((entry) => entry.key === AUTO_ROUTER_API_KEY_ENV), false);
  });
});
