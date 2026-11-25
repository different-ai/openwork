import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudProviderSync } from "../src/cloud-provider-sync.js";
import { EnvService } from "../src/env-file.js";
import type { ServerConfig } from "../src/types.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function config(directory: string): ServerConfig {
  return { host: "127.0.0.1", port: 0, token: "fixture", hostToken: "fixture-host", configPath: join(directory, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false };
}

test("routing to v1 during a live-owned sync guarantees a trailing legacy restoration pass", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwork-live-transition-"));
  const previous = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(directory, "runtime.sqlite");
  const started = deferred();
  const released = deferred();
  const requests: string[] = [];
  let live = true;
  let held = false;
  const sync = new CloudProviderSync({ config: config(directory), env: new EnvService({ path: join(directory, "env.json") }),
    liveProviderSync: async () => live,
    reloadEngine: async () => ({ action: "updated_live" }),
    fetchImpl: Object.assign(async (input: string | URL | Request) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).pathname;
      requests.push(path);
      if (path === "/v1/llm-providers") {
        if (!held) { held = true; started.resolve(); await released.promise; }
        return Response.json({ llmProviders: [] });
      }
      if (path === "/v1/inference-providers") return Response.json({ inferenceProviders: [] });
      throw new Error(`Unexpected fixture request: ${path}`);
    }, { preconnect: fetch.preconnect }),
  });
  try {
    await sync.setSession({ baseUrl: "https://example.invalid", token: "synthetic-session", orgId: "fixture-org" });
    await started.promise;
    const original = sync.run("manual");
    live = false;
    const restored = sync.run("engine_routing_changed");
    released.resolve();
    assert.notEqual((await restored).status, "failed");
    await original;
    assert.equal(requests.filter(path => path === "/v1/llm-providers").length, 2, "the old live pass cannot swallow the ownership transition");
    assert.equal(requests.filter(path => path === "/v1/inference-providers").length, 1, "v1 fetches its gateway inventory without a manual gesture or timer");
  } finally {
    released.resolve();
    sync.stop();
    if (previous === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
