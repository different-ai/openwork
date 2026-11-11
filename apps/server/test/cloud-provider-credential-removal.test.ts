import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudProviderSync } from "../src/cloud-provider-sync.js";
import { EnvService } from "../src/env-file.js";
import { readGlobalRuntimeOpencodeConfig } from "../src/runtime-opencode-config-store.js";
import type { ServerConfig } from "../src/types.js";

for (const personalReplacement of [false, true]) {
  test(`removing an organization credential ${personalReplacement ? "preserves a different personal value" : "drops the hash-owned synced value"} on the next sync`, async () => {
    const root = await mkdtemp(join(tmpdir(), "task415-provider-sync-"));
    const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
    // OpenWork's private fixture configuration store, never an engine database.
    process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
    const config: ServerConfig = {
      host: "127.0.0.1", port: 0, token: "fixture", hostToken: "fixture-host", configPath: join(root, "server.json"),
      approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
      startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
    };
    const env = new EnvService({ path: join(root, "env.json") });
    const envName = "FIXTURE_TEAM_API_KEY";
    let credentialPresent = true;
    const provider = {
      id: "lpr_fixture", source: "custom", credentialMode: "shared", providerId: "fixture-provider", name: "Fixture provider",
      providerConfig: { id: "fixture-provider", npm: "@ai-sdk/openai-compatible", env: [envName], api: "https://inference.example.invalid/v1" },
      models: [{ id: "fixture-model", name: "Fixture model", config: { id: "fixture-model", name: "Fixture model" } }],
    };
    const sync = new CloudProviderSync({
      config, env, liveProviderSync: async () => true, reloadEngine: async () => ({ action: "updated_live" }),
      fetchImpl: Object.assign(async (input: string | URL | Request) => {
        const path = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).pathname;
        if (path.endsWith("/llm-providers")) return Response.json({ llmProviders: [{ ...provider, hasApiKey: credentialPresent }] });
        if (path.endsWith("/lpr_fixture/connect")) return Response.json({ llmProvider: { ...provider, apiKey: credentialPresent ? "synthetic-org-key" : null } });
        if (path.endsWith("/inference-providers")) return Response.json({ inferenceProviders: [] });
        throw new Error(`Unexpected fixture request: ${path}`);
      }, { preconnect: fetch.preconnect }),
    });
    try {
      await sync.setSession({ baseUrl: "https://den.example.invalid", token: "synthetic-session", orgId: "org_fixture" });
      assert.notEqual((await sync.run("before-removal")).status, "failed");
      assert.equal((await env.list()).find((entry) => entry.key === envName)?.value === "synthetic-org-key", true, "the risky condition really exists: sync owns a delivered organization key");
      const before = await readGlobalRuntimeOpencodeConfig(config);
      assert.ok(before.provider?.lpr_fixture, "runtime identity is the saved provider row id");
      if (personalReplacement) await env.upsertMany([{ key: envName, value: "synthetic-personal-key" }]);
      credentialPresent = false;
      assert.notEqual((await sync.run("after-removal")).status, "failed");
      const after = await readGlobalRuntimeOpencodeConfig(config);
      const remaining = (await env.list()).find((entry) => entry.key === envName);
      if (personalReplacement) {
        assert.ok(remaining, "the different personal value must survive");
        assert.equal(remaining.value === "synthetic-personal-key", true);
        assert.deepEqual(after.provider?.lpr_fixture, before.provider?.lpr_fixture, "the local key keeps the same runtime provider and models eligible");
        assert.deepEqual(sync.status().providers.map((entry) => entry.providerId), [provider.id]);
      } else {
        assert.equal(remaining, undefined, "the matching synced organization key must disappear");
        assert.equal(after.provider?.lpr_fixture, undefined, "without any credential the runtime skips this provider, not Den's saved definition");
        assert.deepEqual(sync.status().providers, []);
        // Once the user supplies their own key, the unchanged Den row gives
        // back the same runtime identity, not a delete/recreate identity.
        await env.upsertMany([{ key: envName, value: "synthetic-personal-key" }]);
        assert.notEqual((await sync.run("personal-key-added")).status, "failed");
        const restored = await readGlobalRuntimeOpencodeConfig(config);
        assert.deepEqual(restored.provider?.lpr_fixture, before.provider?.lpr_fixture);
        assert.deepEqual(sync.status().providers.map((entry) => entry.providerId), [provider.id]);
      }
      assert.equal((await env.list()).some((entry) => entry.value === "synthetic-org-key"), false);
    } finally {
      sync.stop();
      if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
      await rm(root, { recursive: true, force: true });
    }
  });
}
