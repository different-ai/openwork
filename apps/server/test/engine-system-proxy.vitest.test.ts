import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../src/types.js";
import { createEngineSystemProxy } from "../src/engine-system-proxy.js";
import { inheritedEngineEnv } from "../src/managed-opencode-v2.js";
import { managedDesktopPolicy } from "../src/managed-desktop-policy.js";
import { serve } from "../src/serve-node.js";

const RELAY = "http://openwork:secret@127.0.0.1:5000";
const relayEnv = async () => ({ HTTP_PROXY: RELAY, HTTPS_PROXY: RELAY, http_proxy: RELAY, https_proxy: RELAY, NO_PROXY: "localhost,127.0.0.1,::1,[::1]", no_proxy: "localhost,127.0.0.1,::1,[::1]" });

async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), "engine-system-proxy-"));
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "fixture-client", hostToken: "fixture-host", configPath: join(temp, "state", "server.json"),
    trustedDenOrigin: "http://127.0.0.1:1", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [], authorizedRoots: [temp], readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  return { config, cleanup: () => rm(temp, { force: true, recursive: true }) };
}

test("an engine gets no relay until the rollout was checked on, and the answer is remembered for the next start", async () => {
  const f = await fixture();
  f.config.engineSystemProxyEnv = relayEnv;
  try {
    const first = createEngineSystemProxy(f.config);
    expect(first.wanted()).toBe(false);
    expect(await first.env()).toEqual({});
    // A check that could not be read is not an answer.
    await first.record(undefined);
    expect(first.wanted()).toBe(false);
    await first.record(true);
    expect(first.wanted()).toBe(true);
    expect((await first.env()).HTTPS_PROXY).toBe(RELAY);

    const nextLaunch = createEngineSystemProxy(f.config);
    expect(nextLaunch.wanted()).toBe(true);
    await nextLaunch.record(undefined);
    expect(nextLaunch.wanted()).toBe(true);
    await nextLaunch.record(false);
    expect(createEngineSystemProxy(f.config).wanted()).toBe(false);
  } finally { await f.cleanup(); }
});

test("a server that is not the desktop app never uses a relay, even with a remembered yes", async () => {
  const f = await fixture();
  try {
    await createEngineSystemProxy({ ...f.config, engineSystemProxyEnv: relayEnv }).record(true);
    const standalone = createEngineSystemProxy(f.config);
    expect(standalone.available).toBe(false);
    expect(standalone.wanted()).toBe(false);
    expect(await standalone.env()).toEqual({});
  } finally { await f.cleanup(); }
});

test("a relay that cannot start leaves the engine connecting directly", async () => {
  const f = await fixture();
  f.config.engineSystemProxyEnv = async () => { throw new Error("no port"); };
  try {
    const proxy = createEngineSystemProxy(f.config);
    await proxy.record(true);
    expect(await proxy.env()).toEqual({});
  } finally { await f.cleanup(); }
});

test("the relay address reaches the engine in both spellings and loopback stays off it", async () => {
  const env = inheritedEngineEnv({ ...(await relayEnv()), OPENCODE_MODELS_URL: "https://models.example.test" }, { PATH: "/bin", DATABASE_URL: "secret" }, "linux");
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) expect(env[name]).toBe(RELAY);
  expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1,[::1]");
  expect(env.no_proxy).toBe("localhost,127.0.0.1,::1,[::1]");
  expect(env.DATABASE_URL).toBeUndefined();
});

test("the rollout is read from the signed-in organization, or from the deployment when signed out", async () => {
  const f = await fixture();
  let org: unknown = true;
  let deployment: unknown = false;
  let unavailable = false;
  const calls: { path: string; authorization: string | null }[] = [];
  const den = await serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    const path = new URL(request.url).pathname;
    calls.push({ path, authorization: request.headers.get("authorization") });
    if (unavailable) return new Response(null, { status: 503 });
    if (path === "/v1/org") return Response.json({ features: { desktopSystemProxy: org } });
    if (path === "/v1/features") return Response.json({ version: 1, features: { desktopSystemProxy: deployment } });
    return Response.json({});
  } });
  f.config.trustedDenOrigin = `http://127.0.0.1:${den.port}`;
  try {
    const policy = managedDesktopPolicy(f.config);
    let delivered = 0;
    policy.onIdentityDelivered = () => { delivered += 1; };

    expect(await policy.systemProxyEnabled()).toBe(false);
    deployment = true;
    expect(await policy.systemProxyEnabled()).toBe(true);
    expect(calls.every(call => call.path === "/v1/features" && call.authorization === null)).toBe(true);

    await policy.setSession({ baseUrl: `http://127.0.0.1:${den.port}`, orgId: "org_fixture", token: "fixture-token" });
    expect(delivered).toBe(1);
    deployment = false;
    expect(await policy.systemProxyEnabled()).toBe(true);
    org = false;
    expect(await policy.systemProxyEnabled()).toBe(false);
    // Only an explicit true turns it on.
    org = "yes";
    expect(await policy.systemProxyEnabled()).toBe(false);

    unavailable = true;
    expect(await policy.systemProxyEnabled()).toBeUndefined();
    unavailable = false;

    await policy.clearSession();
    expect(delivered).toBe(2);
    expect(await policy.systemProxyEnabled()).toBe(false);

    f.config.trustedDenOrigin = `${f.config.trustedDenOrigin}/untrusted-path`;
    expect(await policy.systemProxyEnabled()).toBeUndefined();
  } finally { await den.stop(); await f.cleanup(); }
}, 60_000);
