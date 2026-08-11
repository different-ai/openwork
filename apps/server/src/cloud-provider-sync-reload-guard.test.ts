import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

/**
 * Regression tests for the "aborted messages / provider header-timeout storm"
 * class of bugs (support reports 2026-08-07):
 *  1. A managed engine reload must never dispose an engine with non-idle
 *     sessions — subagent children abort mid-turn ("The message was
 *     interrupted") when it does. Reloads defer and stay pending instead.
 *  2. A dispose wedged on live-session teardown must not freeze the provider
 *     sync queue: the engine answers /instance/dispose only after teardown,
 *     and an unbounded await froze lastRun at "applied" and jammed every
 *     later pass.
 */

const CLIENT_TOKEN = "owt_reload_guard_client";
const HOST_TOKEN = "owt_reload_guard_host";
const roots: string[] = [];
const stops: Array<() => void | Promise<void>> = [];
let previousRuntimeDb: string | undefined;
let previousDisposeTimeout: string | undefined;
let previousReloadRetry: string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hostHeaders() {
  return { "x-openwork-host-token": HOST_TOKEN, "content-type": "application/json" };
}

function clientHeaders() {
  return { authorization: `Bearer ${CLIENT_TOKEN}`, "content-type": "application/json" };
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new Error("Expected JSON object");
  return payload;
}

async function createTempRoot() {
  const root = await mkdtemp(join(tmpdir(), "openwork-reload-guard-"));
  roots.push(root);
  previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  return root;
}

function serverConfig(root: string, baseUrl?: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    configPath: join(root, "server.json"),
    token: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local", baseUrl }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  } satisfies ServerConfig;
}

interface FakeEngine {
  port: number;
  requests: string[];
  disposeCount: () => number;
  setBusy: (busy: boolean) => void;
  setDisposeHangs: (hangs: boolean) => void;
}

function startFakeEngine(): FakeEngine {
  const requests: string[] = [];
  let busy = false;
  let disposeHangs = false;
  const hangReleases: Array<() => void> = [];
  const engine = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (request.method === "GET" && url.pathname === "/session/status") {
        const statuses = busy ? { ses_live: { type: "busy" } } : {};
        return new Response(JSON.stringify(statuses), { headers: { "content-type": "application/json" } });
      }
      if (request.method === "POST" && url.pathname === "/instance/dispose") {
        if (disposeHangs) {
          // Mirrors the real engine wedged on live-session teardown: the
          // response arrives only when the test tears down.
          await new Promise<void>((resolve) => hangReleases.push(resolve));
        }
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      }
      if (request.method === "GET" && url.pathname === "/config") {
        return new Response(JSON.stringify({}), { headers: { "content-type": "application/json" } });
      }
      if (url.pathname.startsWith("/auth/")) {
        return new Response(JSON.stringify(true), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
    },
  });
  stops.push(() => {
    while (hangReleases.length) hangReleases.pop()?.();
    return engine.stop(true);
  });
  return {
    port: Number(engine.port),
    requests,
    disposeCount: () => requests.filter((entry) => entry === "POST /instance/dispose").length,
    setBusy: (value) => { busy = value; },
    setDisposeHangs: (value) => { disposeHangs = value; },
  };
}

/** A Den provider snapshot with the full config surface the engine reads. */
function stableDenProvider(): Record<string, unknown> {
  return {
    id: "lpr_steady",
    providerId: "openai-compatible",
    name: "Steady provider",
    source: "custom",
    updatedAt: "2026-08-04T10:00:00.000Z",
    providerConfig: {
      env: ["STEADY_PROVIDER_API_KEY"],
      npm: "@ai-sdk/openai-compatible",
      api: "https://models.example.test/api/v1",
      options: { baseURL: "https://models.example.test/api/v1" },
    },
    apiKey: "sk-steady-provider",
    apiKeys: null,
    models: [
      { id: "model-b", name: "Model B", config: {} },
      { id: "model-a", name: "Model A", config: {} },
    ],
  };
}

function startFakeDen(options?: { providers?: Record<string, unknown>[] }): { url: string; requests: string[] } {
  const providers = options?.providers ?? [];
  const requests: string[] = [];
  const den = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (request.method === "GET" && url.pathname === "/v1/llm-providers") {
        return new Response(JSON.stringify({ llmProviders: providers }), { headers: { "content-type": "application/json" } });
      }
      const connect = url.pathname.match(/^\/v1\/llm-providers\/([^/]+)\/connect$/);
      if (request.method === "GET" && connect) {
        const provider = providers.find((entry) => entry.id === decodeURIComponent(connect[1] ?? ""));
        if (provider) {
          return new Response(JSON.stringify({ llmProvider: provider }), { headers: { "content-type": "application/json" } });
        }
      }
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
    },
  });
  stops.push(() => den.stop(true));
  return { url: `http://127.0.0.1:${den.port}`, requests };
}

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
  if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
  else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
  if (previousDisposeTimeout === undefined) delete process.env.OPENWORK_ENGINE_DISPOSE_TIMEOUT_MS;
  else process.env.OPENWORK_ENGINE_DISPOSE_TIMEOUT_MS = previousDisposeTimeout;
  if (previousReloadRetry === undefined) delete process.env.OPENWORK_ENGINE_RELOAD_RETRY_MS;
  else process.env.OPENWORK_ENGINE_RELOAD_RETRY_MS = previousReloadRetry;
});

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

describe("engine reload guard", () => {
  test("global provider patch defers the reload while sessions are busy and applies it once idle", async () => {
    const root = await createTempRoot();
    const engine = startFakeEngine();
    const config = serverConfig(root, `http://127.0.0.1:${engine.port}`);
    const server = await startServer(config);
    stops.push(() => server.stop());
    const base = `http://127.0.0.1:${server.port}`;
    const den = startFakeDen();

    engine.setBusy(true);
    const deferred = await readJsonObject(await fetch(`${base}/runtime-config/providers`, {
      method: "PATCH",
      headers: hostHeaders(),
      body: JSON.stringify({ provider: { lpr_test: { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"] } } }),
    }));
    expect(deferred.ok).toBe(true);
    expect(deferred.changed).toBe(true);
    expect(deferred.reload).toBe("deferred");
    expect(engine.disposeCount()).toBe(0);

    // The parked reload applies through the provider sync once the engine idles.
    engine.setBusy(false);
    const put = await fetch(`${base}/den-session`, {
      method: "PUT",
      headers: hostHeaders(),
      body: JSON.stringify({ baseUrl: den.url, token: "den_token", orgId: "org_test" }),
    });
    expect(put.status).toBe(204);
    const run = await readJsonObject(await fetch(`${base}/cloud-provider-sync/run`, {
      method: "POST",
      headers: hostHeaders(),
      body: JSON.stringify({ reason: "test" }),
    }));
    expect(run.status === "applied" || run.status === "noop").toBe(true);
    expect(engine.disposeCount()).toBeGreaterThanOrEqual(1);
  });

  test("provider sync passes defer reloads while busy, then reload and converge to noop when idle", async () => {
    const root = await createTempRoot();
    const engine = startFakeEngine();
    const config = serverConfig(root, `http://127.0.0.1:${engine.port}`);
    const server = await startServer(config);
    stops.push(() => server.stop());
    const base = `http://127.0.0.1:${server.port}`;
    const den = startFakeDen();

    engine.setBusy(true);
    const put = await fetch(`${base}/den-session`, {
      method: "PUT",
      headers: hostHeaders(),
      body: JSON.stringify({ baseUrl: den.url, token: "den_token", orgId: "org_test" }),
    });
    expect(put.status).toBe(204);

    // The first pass (PUT /den-session enqueues one automatically) writes the
    // engine-visible runtime file -> a reload becomes pending, but the busy
    // engine must not be disposed.
    const busyRun = await readJsonObject(await fetch(`${base}/cloud-provider-sync/run`, {
      method: "POST",
      headers: hostHeaders(),
      body: JSON.stringify({ reason: "busy_pass" }),
    }));
    expect(busyRun.status === "applied" || busyRun.status === "noop").toBe(true);
    expect(engine.disposeCount()).toBe(0);
    const busyStatus = await readJsonObject(await fetch(`${base}/cloud-provider-sync/status`, { headers: clientHeaders() }));
    const busyLastRun = isRecord(busyStatus.lastRun) ? busyStatus.lastRun : {};
    const busyDetail = isRecord(busyLastRun.detail) ? busyLastRun.detail : {};
    expect(busyDetail.reloadDeferred).toBe(true);

    // Idle: the pending reload fires exactly once, and the sync settles.
    engine.setBusy(false);
    await readJsonObject(await fetch(`${base}/cloud-provider-sync/run`, {
      method: "POST",
      headers: hostHeaders(),
      body: JSON.stringify({ reason: "idle_pass" }),
    }));
    expect(engine.disposeCount()).toBe(1);
    const settled = await readJsonObject(await fetch(`${base}/cloud-provider-sync/run`, {
      method: "POST",
      headers: hostHeaders(),
      body: JSON.stringify({ reason: "converged_pass" }),
    }));
    expect(settled.status).toBe("noop");
    expect(engine.disposeCount()).toBe(1);
  });

  test("repeated passes over an unchanged Den snapshot never dispose the engine again", async () => {
    const root = await createTempRoot();
    const engine = startFakeEngine();
    const config = serverConfig(root, `http://127.0.0.1:${engine.port}`);
    const server = await startServer(config);
    stops.push(() => server.stop());
    const base = `http://127.0.0.1:${server.port}`;
    const den = startFakeDen({ providers: [stableDenProvider()] });

    const put = await fetch(`${base}/den-session`, {
      method: "PUT",
      headers: hostHeaders(),
      body: JSON.stringify({ baseUrl: den.url, token: "den_token", orgId: "org_test" }),
    });
    expect(put.status).toBe(204);

    // Materialize the provider. The engine cannot apply provider config on a
    // live instance (PUT /auth carries credentials only), so this legitimately
    // disposes -- but it must settle, not repeat.
    await readJsonObject(await fetch(`${base}/cloud-provider-sync/run`, {
      method: "POST",
      headers: hostHeaders(),
      body: JSON.stringify({ reason: "materialize" }),
    }));
    const settledDisposes = engine.disposeCount();
    expect(settledDisposes).toBeGreaterThan(0);

    // Every later pass sees byte-identical Den state. A pass that still reports
    // "applied" here is the runaway-dispose bug: on the 5-minute interval it
    // would tear down the engine forever, aborting whatever is running.
    for (let pass = 0; pass < 5; pass += 1) {
      const result = await readJsonObject(await fetch(`${base}/cloud-provider-sync/run`, {
        method: "POST",
        headers: hostHeaders(),
        body: JSON.stringify({ reason: `steady_${pass}` }),
      }));
      expect(result.status).toBe("noop");
      expect(engine.disposeCount()).toBe(settledDisposes);
    }

    // The credential push is fingerprint-guarded, so it must not re-deliver
    // on every pass either.
    expect(engine.requests.filter((entry) => entry === "PUT /auth/lpr_steady")).toHaveLength(1);
  });

  test("a deferred reload lands by itself once the engine idles, even with no Den session", async () => {
    previousReloadRetry = process.env.OPENWORK_ENGINE_RELOAD_RETRY_MS;
    process.env.OPENWORK_ENGINE_RELOAD_RETRY_MS = "200";
    const root = await createTempRoot();
    const engine = startFakeEngine();
    const config = serverConfig(root, `http://127.0.0.1:${engine.port}`);
    const server = await startServer(config);
    stops.push(() => server.stop());
    const base = `http://127.0.0.1:${server.port}`;

    // No PUT /den-session on purpose: a signed-out desktop that patches
    // global providers must still see them reach the engine eventually.
    engine.setBusy(true);
    const deferred = await readJsonObject(await fetch(`${base}/runtime-config/providers`, {
      method: "PATCH",
      headers: hostHeaders(),
      body: JSON.stringify({ provider: { lpr_retry: { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"] } } }),
    }));
    expect(deferred.reload).toBe("deferred");
    expect(engine.disposeCount()).toBe(0);

    // Still busy: the retry poll must keep waiting, not dispose.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(engine.disposeCount()).toBe(0);

    // Idle: the parked reload lands from the retry poll alone.
    engine.setBusy(false);
    const landed = await waitUntil(() => engine.disposeCount() >= 1, 3_000);
    expect(landed).toBe(true);
  });

  test("a wedged dispose times out instead of freezing the sync queue", async () => {
    previousDisposeTimeout = process.env.OPENWORK_ENGINE_DISPOSE_TIMEOUT_MS;
    process.env.OPENWORK_ENGINE_DISPOSE_TIMEOUT_MS = "500";
    const root = await createTempRoot();
    const engine = startFakeEngine();
    const config = serverConfig(root, `http://127.0.0.1:${engine.port}`);
    const server = await startServer(config);
    stops.push(() => server.stop());
    const base = `http://127.0.0.1:${server.port}`;
    const den = startFakeDen();

    engine.setDisposeHangs(true);
    const put = await fetch(`${base}/den-session`, {
      method: "PUT",
      headers: hostHeaders(),
      body: JSON.stringify({ baseUrl: den.url, token: "den_token", orgId: "org_test" }),
    });
    expect(put.status).toBe(204);

    // The pass carries a pending reload (first runtime-file write); the hung
    // dispose must fail the pass in bounded time instead of hanging it.
    const first = await readJsonObject(await fetch(`${base}/cloud-provider-sync/run`, {
      method: "POST",
      headers: hostHeaders(),
      body: JSON.stringify({ reason: "wedged_pass" }),
    }));
    expect(first.status).toBe("failed");
    expect(String(first.message ?? "")).toContain("did not complete in time");

    // The queue is not jammed: the next pass runs (and retries the reload).
    const disposesBefore = engine.disposeCount();
    const second = await readJsonObject(await fetch(`${base}/cloud-provider-sync/run`, {
      method: "POST",
      headers: hostHeaders(),
      body: JSON.stringify({ reason: "post_wedge_pass" }),
    }));
    expect(second.status).toBe("failed");
    expect(engine.disposeCount()).toBe(disposesBefore + 1);

    // Recovery: once the engine answers disposes again, the reload lands.
    engine.setDisposeHangs(false);
    const recovered = await readJsonObject(await fetch(`${base}/cloud-provider-sync/run`, {
      method: "POST",
      headers: hostHeaders(),
      body: JSON.stringify({ reason: "recovered_pass" }),
    }));
    expect(recovered.status === "applied" || recovered.status === "noop").toBe(true);
  });
});
