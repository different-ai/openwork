import { expect, test } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeProvider } from "../../../packages/sandbox/src/testing/fake-provider.js";
import { createLocalSandboxRuntime } from "../src/local-sandbox-runtime.js";
import { createSandboxToolsBridge } from "../src/sandbox-tools-bridge.js";
import type { ServerConfig } from "../src/types.js";
import { managedDesktopPolicy } from "../src/managed-desktop-policy.js";
import { serve } from "../src/serve-node.js";
import { renderOpencodeV2Config } from "../src/managed-opencode-v2.js";
import { writeGlobalRuntimeOpencodeConfig } from "../src/runtime-opencode-config-store.js";

async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), "sandbox-runtime-"));
  const workspace = join(temp, "workspace");
  const external = join(temp, "external");
  await mkdir(workspace); await mkdir(external);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "client-test", hostToken: "host-test", configPath: join(temp, "runtime", "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], trustedDenOrigin: "http://127.0.0.1:1",
    workspaces: [{ id: "test-workspace", path: workspace, name: "Test", preset: "starter", workspaceType: "local" }],
    authorizedRoots: ["/this-is-not-the-authorized-folders-list"], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  return { temp, workspace, external, config, cleanup: () => rm(temp, { recursive: true, force: true }) };
}

test("the managed v2 config registers the sandbox plugin only with the host bridge", () => {
  const base = { providers: [], skills: [], sandboxPluginDirectory: "/plugins/sandbox" };
  expect(renderOpencodeV2Config(base).plugins).toBeUndefined();
  const rendered = renderOpencodeV2Config({ ...base, contextTools: { url: "http://127.0.0.1:1/read", token: "read", sandbox: { url: "http://127.0.0.1:2/sandbox", token: "sandbox" } } });
  expect(rendered.plugins).toEqual([{ package: "file:///plugins/sandbox", options: { url: "http://127.0.0.1:2/sandbox", token: "sandbox" } }]);
});

test("fresh rollout verification refuses unknown/disabled states and never bypasses existing edit restrictions", async () => {
  const f = await fixture();
  let enabled = false;
  let restricted = false;
  const den = await serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    if (new URL(request.url).pathname === "/v1/org") return Response.json({ features: { sandboxTools: enabled } });
    return Response.json({ agentPermissions: { rules: restricted ? [{ action: "edit", resource: "*", effect: "deny", source: "Test policy" }] : [] } });
  } });
  const policy = managedDesktopPolicy(f.config);
  try {
    expect((await policy.localSandboxAccess()).enabled).toBe(false);
    await policy.setSession({ baseUrl: `http://127.0.0.1:${den.port}`, orgId: "org_test", token: "fixture-token" });
    await policy.current();
    expect((await policy.localSandboxAccess()).enabled).toBe(false);
    enabled = true;
    expect((await policy.localSandboxAccess()).enabled).toBe(true);
    restricted = true;
    expect((await policy.localSandboxAccess()).enabled).toBe(false);
    await den.stop();
    expect((await policy.localSandboxAccess()).enabled).toBe(false);
  } finally { await policy.clearSession(); await den.stop(); await f.cleanup(); }
});

test("flag off never constructs a provider; malformed and unauthorized directories never allocate", async () => {
  const f = await fixture();
  let factories = 0;
  const runtime = createLocalSandboxRuntime(f.config, {
    access: async () => ({ enabled: false, scope: "test" }), externalDirectories: async () => ({}),
    provider: async () => { factories += 1; return createFakeProvider(); },
  });
  try {
    expect(await runtime.status(f.workspace)).toEqual({ mode: "off" });
    await expect(runtime.execute(f.workspace, "shell", { command: "touch /host-sentinel" })).rejects.toThrow("disabled");
    await expect(runtime.execute(f.external, "shell", { command: "true" })).rejects.toThrow("registered");
    expect(factories).toBe(0);
  } finally { await runtime.close(); await f.cleanup(); }
});

test("mount changes replace the guest before dispatch; provider failure never substitutes host execution", async () => {
  const f = await fixture();
  const mounted: string[][] = [];
  let dirs: Record<string, unknown> = {};
  let enabled = true;
  let runs = 0;
  const provider = createFakeProvider({ id: "microsandbox", onRun: () => { runs += 1; return { exitCode: 0, stdout: "guest", stderr: "" }; } });
  const runtime = createLocalSandboxRuntime(f.config, {
    access: async () => ({ enabled, scope: "identity" }), externalDirectories: async () => dirs,
    provider: async mounts => { mounted.push(mounts.map(mount => mount.guestPath)); return provider; },
  });
  try {
    expect(await runtime.status(f.workspace)).toEqual({ mode: "tools" });
    await runtime.execute(f.workspace, "shell", { command: "pwd" });
    expect(mounted).toEqual([[f.workspace]]);
    dirs = { [`${f.external}/*`]: "allow" };
    const restarted = await runtime.execute(f.workspace, "shell", { command: "pwd" });
    expect(restarted.metadata).toMatchObject({ sandboxRestarted: true });
    expect(mounted[1]).toEqual([f.external, f.workspace].sort());
    expect(provider.fake.count("destroy")).toBe(1);
    expect(runs).toBe(2);
    enabled = false;
    await expect(runtime.execute(f.workspace, "shell", { command: "touch /host-sentinel" })).rejects.toThrow("disabled");
    expect(runs).toBe(2);
    expect(provider.fake.count("stop")).toBe(1);
  } finally { await runtime.close(); await f.cleanup(); }
});

test("mount revocation force-destroys an uncooperative guest after queued work, including A -> B -> A grants", async () => {
  const f = await fixture();
  const grants = { [`${f.external}/*`]: "allow" };
  let release: () => void = () => {};
  let started: () => void = () => {};
  const running = new Promise<void>(resolve => { started = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  let runs = 0;
  const provider = createFakeProvider({ id: "microsandbox", onOperation: operation => {
    if (operation.name === "stop" && operation.sandboxId === oldId) throw new Error("guest refuses graceful shutdown");
  }, onRun: async () => { if (++runs === 2) { started(); await hold; } return { exitCode: 0, stdout: "guest", stderr: "" }; } });
  let oldId: string | undefined;
  const runtime = createLocalSandboxRuntime(f.config, { access: async () => ({ enabled: true, scope: "fixture" }), provider: async () => provider });
  try {
    await writeGlobalRuntimeOpencodeConfig(f.config, () => ({ permission: { external_directory: grants } }));
    await runtime.execute(f.workspace, "shell", { command: "true" });
    oldId = (await provider.list({}))[0]!.ref.ref.sandboxId;
    const inFlight = runtime.execute(f.workspace, "shell", { command: "queued guest work" });
    await running;
    await writeGlobalRuntimeOpencodeConfig(f.config, () => ({ permission: { external_directory: {} } }));
    await writeGlobalRuntimeOpencodeConfig(f.config, () => ({ permission: { external_directory: grants } }));
    expect(provider.fake.count("destroy")).toBe(0);
    release(); await inFlight;
    const replaced = await runtime.execute(f.workspace, "shell", { command: "true" });
    expect(replaced.metadata).toMatchObject({ sandboxRestarted: true });
    expect(provider.fake.sandboxes().find(sandbox => sandbox.id === oldId)?.state).toBe("missing");
    expect(provider.fake.count("destroy", oldId)).toBeGreaterThanOrEqual(1);
    expect(provider.fake.count("stop", oldId)).toBe(0);
    // The destroyed tombstone is retried with the typed not_found response;
    // it must still recreate/reset instead of resuming A's revoked guest.
    expect(provider.fake.count("create")).toBe(2);
  } finally { release(); await runtime.close(); await f.cleanup(); }
});

test("a message mentioning not_found never substitutes for the provider error code during revocation", async () => {
  const f = await fixture();
  let failDestroy = true;
  let executions = 0;
  const provider = createFakeProvider({ onRun: () => { executions++; return { exitCode: 0, stdout: "guest", stderr: "" }; }, onOperation: operation => { if (operation.name === "destroy" && failDestroy) throw new Error("not_found"); } });
  const runtime = createLocalSandboxRuntime(f.config, { access: async () => ({ enabled: true, scope: "fixture" }), provider: async () => provider });
  try {
    await runtime.execute(f.workspace, "shell", { command: "true" });
    await writeGlobalRuntimeOpencodeConfig(f.config, () => ({ permission: { external_directory: { [`${f.external}/*`]: "allow" } } }));
    await expect(runtime.execute(f.workspace, "shell", { command: "must not run" })).rejects.toThrow("not_found");
    expect(provider.fake.count("create")).toBe(1);
    expect(executions).toBe(1);
    failDestroy = false;
    expect((await runtime.execute(f.workspace, "shell", { command: "true" })).metadata).toMatchObject({ sandboxRestarted: true });
    expect(provider.fake.count("create")).toBe(2);
  } finally { failDestroy = false; await runtime.close(); await f.cleanup(); }
});

test("a retained stopped entry resumes the same local guest before reuse", async () => {
  const f = await fixture();
  const provider = createFakeProvider({ id: "microsandbox" });
  const runtime = createLocalSandboxRuntime(f.config, {
    access: async () => ({ enabled: true, scope: "test" }), externalDirectories: async () => ({}), provider: async () => provider,
  });
  try {
    await runtime.execute(f.workspace, "shell", { command: "pwd" });
    const handle = (await provider.list({}))[0];
    expect(handle).toBeDefined();
    await provider.stop(handle, { timeoutMs: 1000 });
    await runtime.execute(f.workspace, "shell", { command: "pwd" });
    expect(provider.fake.count("start")).toBe(1);
    expect(provider.fake.count("create")).toBe(1);
  } finally { await runtime.close(); await f.cleanup(); }
});

test("loopback bridge requires its own credential and rechecks the rollout for execution", async () => {
  const f = await fixture();
  let enabled = true;
  let runs = 0;
  const provider = createFakeProvider({ id: "microsandbox", onRun: () => { runs += 1; return { exitCode: 0, stdout: "guest bridge result", stderr: "" }; } });
  const bridge = await createSandboxToolsBridge(f.config, {
    access: async () => ({ enabled, scope: "test" }), externalDirectories: async () => ({}), provider: async () => provider,
  });
  const request = (body: unknown, token = bridge.token) => fetch(bridge.url, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    expect((await request({ operation: "status", directory: f.workspace }, "wrong")).status).toBe(401);
    expect(await (await request({ operation: "status", directory: f.workspace })).json()).toEqual({ mode: "tools" });
    const called = await request({ operation: "execute", directory: f.workspace, name: "shell", input: { command: "pwd" }, sessionId: "s" });
    expect(await called.json()).toMatchObject({ content: [{ type: "text", text: "guest bridge result" }] });
    enabled = false;
    expect((await request({ operation: "execute", directory: f.workspace, name: "shell", input: { command: "pwd" }, sessionId: "s" })).status).toBe(503);
    expect(runs).toBe(1);
  } finally { await bridge.close(); await f.cleanup(); }
});
