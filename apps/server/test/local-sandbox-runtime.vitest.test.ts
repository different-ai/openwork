import { expect, test } from "vitest";
import { registerSandboxStatusRoutes } from "../src/routes/sandbox-status.js";
import { matchRoute, type Route } from "../src/routes/registry.js";
import { ApiError } from "../src/errors.js";
import { ApprovalService } from "../src/approvals.js";
import { UiControlMailbox } from "../src/ui-control.js";
import { ReloadEventStore } from "../src/events.js";
import { TokenService } from "../src/tokens.js";
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

function gate() {
  let open = () => {};
  const wait = new Promise<void>(resolve => { open = resolve; });
  return { open, wait };
}

const useSandbox = async () => ({ useSandbox: true, forceSandbox: false });

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
  const policy = managedDesktopPolicy(f.config, { sandboxFreshnessMs: 0 });
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
    settings: useSandbox,
    access: async () => ({ enabled: false, scope: "test" }), externalDirectories: async () => ({}),
    provider: async () => { factories += 1; return createFakeProvider(); },
  });
  try {
    expect(await runtime.status(f.workspace)).toEqual({ mode: "off" });
    await expect(runtime.execute(f.workspace, "shell", { command: "touch /host-sentinel" })).rejects.toThrow("disabled");
    await expect(runtime.execute(f.external, "shell", { command: "true" })).rejects.toThrow("project folder opened in OpenWork");
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
    settings: useSandbox,
    access: async () => ({ enabled, scope: "identity" }), externalDirectories: async () => dirs,
    provider: async mounts => { mounted.push(mounts.map(mount => mount.guestPath)); return provider; },
  });
  try {
    expect(await runtime.status(f.workspace)).toEqual({ mode: "tools" });
    await runtime.execute(f.workspace, "shell", { command: "pwd" });
    // The workspace's .opencode folder is created and mounted read-only inside it.
    expect(mounted).toEqual([[f.workspace, join(f.workspace, ".opencode")]]);
    dirs = { [`${f.external}/*`]: "allow" };
    const restarted = await runtime.execute(f.workspace, "shell", { command: "pwd" });
    expect(restarted.metadata).toMatchObject({ sandboxRestarted: true });
    expect(mounted[1]).toEqual([f.external, f.workspace, join(f.workspace, ".opencode")].sort());
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
  const runtime = createLocalSandboxRuntime(f.config, { settings: useSandbox, access: async () => ({ enabled: true, scope: "fixture" }), provider: async () => provider });
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
    // It must recreate/reset instead of resuming A's revoked guest.
    expect(provider.fake.count("create")).toBe(2);
  } finally { release(); await runtime.close(); await f.cleanup(); }
});

test("a message mentioning not_found never substitutes for the provider error code during revocation", async () => {
  const f = await fixture();
  let failDestroy = true;
  let executions = 0;
  const provider = createFakeProvider({ onRun: () => { executions++; return { exitCode: 0, stdout: "guest", stderr: "" }; }, onOperation: operation => { if (operation.name === "destroy" && failDestroy) throw new Error("not_found"); } });
  const runtime = createLocalSandboxRuntime(f.config, { settings: useSandbox, access: async () => ({ enabled: true, scope: "fixture" }), provider: async () => provider });
  try {
    await runtime.execute(f.workspace, "shell", { command: "true" });
    await writeGlobalRuntimeOpencodeConfig(f.config, () => ({ permission: { external_directory: { [`${f.external}/*`]: "allow" } } }));
    await expect(runtime.execute(f.workspace, "shell", { command: "must not run" })).rejects.toThrow("The sandbox couldn't start.");
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
    settings: useSandbox,
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
  const runtime = createLocalSandboxRuntime(f.config, {
    settings: useSandbox,
    access: async () => ({ enabled, scope: "test" }), externalDirectories: async () => ({}), provider: async () => provider,
  });
  const bridge = await createSandboxToolsBridge(f.config, runtime);
  const request = (body: unknown, token = bridge.token) => fetch(bridge.url, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    expect((await request({ operation: "status", directory: f.workspace }, "wrong")).status).toBe(401);
    expect(await (await request({ operation: "status", directory: f.workspace })).json()).toEqual({ mode: "tools" });
    expect(runtime.snapshot(f.workspace).state).toBe("off");
    expect(provider.fake.count("create")).toBe(0);
    expect((await request({ operation: "prompt", directory: f.workspace })).status).toBe(200);
    await expect.poll(() => runtime.snapshot(f.workspace).state).toBe("ready");
    const called = await request({ operation: "execute", directory: f.workspace, name: "shell", input: { command: "pwd" }, sessionId: "s" });
    expect(await called.json()).toMatchObject({ content: [{ type: "text", text: "guest bridge result" }] });
    enabled = false;
    expect((await request({ operation: "execute", directory: f.workspace, name: "shell", input: { command: "pwd" }, sessionId: "s" })).status).toBe(503);
    expect(runs).toBe(1);
  } finally { await bridge.close(); await runtime.close(); await f.cleanup(); }
});

test("snapshot is read-only; progress is ordered and tool execution joins preparation", async () => {
  const f = await fixture();
  const pull = gate(), startup = gate(), folders = gate();
  const startSeen = gate(), folderSeen = gate(), pullSeen = gate();
  let commands = 0;
  const provider = createFakeProvider({
    onExec: async () => { folderSeen.open(); await folders.wait; return { exitCode: 0 }; },
    onRun: () => { commands++; return { exitCode: 0, stdout: "ready", stderr: "" }; },
  });
  const create = provider.create;
  provider.create = async (spec, options) => {
    options.onProgress?.({ kind: "resolved", totalDownloadBytes: 100 });
    options.onProgress?.({ kind: "layerDownloadProgress", layerIndex: 0, downloadedBytes: 42 });
    pullSeen.open(); await pull.wait;
    options.onProgress?.({ kind: "startup", phase: "activating", completedBytes: 2 });
    startSeen.open(); await startup.wait;
    return create(spec, options);
  };
  let factories = 0;
  const runtime = createLocalSandboxRuntime(f.config, { settings: useSandbox, access: async () => ({ enabled: true, scope: "test" }), provider: async () => { factories++; return provider; } });
  try {
    expect(runtime.snapshot(f.workspace).state).toBe("off");
    await runtime.prepare(f.external);
    expect(runtime.snapshot(f.external).state).toBe("off");
    expect(factories).toBe(0);
    const warm = runtime.prepare(f.workspace);
    await pullSeen.wait;
    const command = runtime.execute(f.workspace, "shell", { command: "true" });
    const secondWarm = runtime.prepare(f.workspace);
    const steps = () => runtime.snapshot(f.workspace).steps.map(step => step.state);
    expect(steps()).toEqual(["active", "waiting", "waiting"]);
    expect(runtime.snapshot(f.workspace).steps[0]).toMatchObject({ completedBytes: 42, totalBytes: 100 });
    pull.open(); await startSeen.wait;
    expect(steps()).toEqual(["done", "active", "waiting"]);
    startup.open(); await folderSeen.wait;
    expect(steps()).toEqual(["done", "done", "active"]);
    expect(commands).toBe(0);
    folders.open(); await Promise.all([warm, secondWarm, command]);
    expect(steps()).toEqual(["done", "done", "done"]);
    expect(runtime.snapshot(f.workspace)).toMatchObject({ state: "ready", mode: "use", imageBytes: 100,
      folders: [{ path: f.workspace, kind: "workspace", access: "rw" }] });
    expect(commands).toBe(1);
    expect(factories).toBe(1);
  } finally { pull.open(); startup.open(); folders.open(); await runtime.close(); await f.cleanup(); }
});

test("failed folder probe identifies the folder, destroys the instance and can be retried", async () => {
  const f = await fixture();
  let visible = false;
  const provider = createFakeProvider({ onExec: () => ({ exitCode: visible ? 0 : 1, stdout: "0\n" }) });
  const runtime = createLocalSandboxRuntime(f.config, { settings: useSandbox, access: async () => ({ enabled: true, scope: "test" }), provider: async () => provider });
  try {
    await runtime.prepare(f.workspace);
    expect(runtime.snapshot(f.workspace)).toMatchObject({ state: "failed", error: { code: "folders_failed", message: expect.stringContaining("“workspace”"), retryable: true } });
    expect(provider.fake.count("destroy")).toBe(1);
    visible = true;
    await runtime.prepare(f.workspace);
    expect(runtime.snapshot(f.workspace)).toMatchObject({ state: "ready", error: null });
    expect(provider.fake.count("create")).toBe(2);
  } finally { await runtime.close(); await f.cleanup(); }
});

test("a crash or disappearance is recreated exactly once before the command", async () => {
  const f = await fixture();
  const provider = createFakeProvider();
  const runtime = createLocalSandboxRuntime(f.config, { settings: useSandbox, access: async () => ({ enabled: true, scope: "test" }), provider: async () => provider });
  try {
    await runtime.prepare(f.workspace);
    const first = (await provider.list({}))[0];
    provider.fake.setState(first.ref.ref.sandboxId ?? "", "error");
    await runtime.execute(f.workspace, "shell", { command: "true" });
    expect(provider.fake.count("create")).toBe(2);
    const second = (await provider.list({}))[0];
    await provider.destroy(second, { timeoutMs: 100 });
    await runtime.execute(f.workspace, "shell", { command: "true" });
    expect(provider.fake.count("create")).toBe(3);
  } finally { await runtime.close(); await f.cleanup(); }
});

test("an expired waiter never dispatches, even after the provider returns", async () => {
  const f = await fixture();
  const boot = gate();
  const provider = createFakeProvider({ onOperation: operation => operation.name === "create" ? boot.wait : undefined });
  const runtime = createLocalSandboxRuntime(f.config, { settings: useSandbox, access: async () => ({ enabled: true, scope: "test" }), provider: async () => provider, prepareTimeoutMs: 50 });
  try {
    const warm = runtime.prepare(f.workspace);
    await expect(runtime.execute(f.workspace, "shell", { command: "true" })).rejects.toThrow("took too long");
    await expect.poll(() => runtime.snapshot(f.workspace).error?.code).toBe("timed_out");
    boot.open(); await warm;
    expect(provider.fake.count("run")).toBe(0);
    await expect.poll(() => provider.fake.count("destroy")).toBe(1);
  } finally { boot.open(); await runtime.close(); await f.cleanup(); }
});

test("folder writes auto-prepare but an unchanged fingerprint does not recreate; bridge close preserves readiness", async () => {
  const f = await fixture();
  const provider = createFakeProvider();
  const runtime = createLocalSandboxRuntime(f.config, { settings: useSandbox, access: async () => ({ enabled: true, scope: "test" }), provider: async () => provider });
  const bridge = await createSandboxToolsBridge(f.config, runtime);
  try {
    await runtime.prepare(f.workspace);
    await bridge.close();
    expect(provider.fake.count("stop")).toBe(0);
    expect(runtime.snapshot(f.workspace).state).toBe("ready");
    const grants = { [`${f.external}/*`]: "allow" };
    await writeGlobalRuntimeOpencodeConfig(f.config, () => ({ permission: { external_directory: grants } }));
    await expect.poll(() => runtime.snapshot(f.workspace).folders.length).toBe(2);
    await expect.poll(() => runtime.snapshot(f.workspace).state).toBe("ready");
    expect(provider.fake.count("create")).toBe(2);
    await writeGlobalRuntimeOpencodeConfig(f.config, current => ({ ...current, permission: { external_directory: grants } }));
    const result = await runtime.execute(f.workspace, "shell", { command: "true" });
    expect(result.metadata).toMatchObject({ sandboxRestarted: true, notice: "The sandbox restarted to pick up your folder changes. Files in your folders were kept; temporary files inside the sandbox were cleared." });
    expect(provider.fake.count("create")).toBe(2);
  } finally { await bridge.close(); await runtime.close(); await f.cleanup(); }
});

test("status routes are client-readable without work, with collaborator-only and enabled-only preparation", async () => {
  const f = await fixture();
  const routes: Route[] = [];
  const provider = createFakeProvider();
  let enabled = false, collaborator = false;
  const runtime = createLocalSandboxRuntime(f.config, { settings: useSandbox, access: async () => ({ enabled, scope: "test" }), provider: async () => provider });
  registerSandboxStatusRoutes({ routes, config: f.config, runtime,
    resolveWorkspaceWithoutBootstrap: async () => f.config.workspaces[0],
    requireClientScope: (_, scope) => { if (!(scope === "collaborator" && collaborator)) throw new ApiError(403, "forbidden", "Not allowed."); },
  });
  const hit = (method: string, subpath: string) => {
    const url = new URL(`http://localhost/workspace/test-workspace/sandbox-status${subpath}`);
    const route = matchRoute(routes, method, url.pathname);
    expect(route?.auth).toBe("client");
    if (!route) throw new Error("Missing route");
    return route.handler({ url, params: route.params, request: new Request(url, { method }), config: f.config,
      approvals: new ApprovalService(f.config.approval), reloadEvents: new ReloadEventStore(), uiControl: new UiControlMailbox(), tokens: new TokenService(f.config) });
  };
  try {
    const initial = await hit("GET", "");
    expect(initial.headers.get("server-timing")).toContain("snapshot;dur=");
    expect(await initial.json()).toMatchObject({ state: "off" });
    expect(provider.fake.count("create")).toBe(0);
    await expect(hit("POST", "/prepare")).rejects.toMatchObject({ status: 403 });
    collaborator = true;
    await expect(hit("POST", "/prepare")).rejects.toMatchObject({ status: 409 });
    enabled = true;
    expect((await hit("POST", "/prepare")).status).toBe(200);
    await expect.poll(() => runtime.snapshot(f.workspace).state).toBe("ready");
    expect(provider.fake.count("create")).toBe(1);
  } finally { await runtime.close(); await f.cleanup(); }
});

test.each(["revoke", "revoke and regrant", "unchanged"])("a config write during blocked create: %s", async change => {
  const f = await fixture();
  const entered = gate(), release = gate();
  const grants = { [`${f.external}/*`]: "allow" };
  const prepared: string[][] = [];
  const dispatched: Array<string | undefined> = [];
  const provider = createFakeProvider({ onOperation: async op => {
    if (op.name === "create" && prepared.length === 1) { entered.open(); await release.wait; }
    if (op.name === "run") dispatched.push(op.sandboxId);
  } });
  const runtime = createLocalSandboxRuntime(f.config, {
    settings: useSandbox, access: async () => ({ enabled: true, scope: "fixture" }),
    provider: async mounts => { prepared.push(mounts.map(m => m.guestPath)); return provider; },
  });
  const write = (folders: Record<string, string>) => writeGlobalRuntimeOpencodeConfig(f.config, () => ({ permission: { external_directory: folders } }));
  try {
    await write(grants);
    const command = runtime.execute(f.workspace, "shell", { command: "true" });
    await entered.wait;
    await write(change === "unchanged" ? grants : {});
    if (change === "revoke and regrant") await write(grants);
    expect(dispatched).toEqual([]);
    release.open();
    await command;
    const [first, second] = provider.fake.sandboxes();
    if (change === "unchanged") {
      expect(dispatched).toEqual([first.id]);
      expect(provider.fake.count("create")).toBe(1);
      expect(provider.fake.count("destroy")).toBe(0);
    } else {
      expect(first.state).toBe("missing");
      expect(dispatched).toEqual([second.id]);
      expect(prepared[1].includes(f.external)).toBe(change === "revoke and regrant");
    }
  } finally { release.open(); await runtime.close(); await f.cleanup(); }
});

test.each(["create", "find", "inspect"])("a hung %s releases the preparation queue for Retry and close", async operation => {
  const f = await fixture();
  let hang = false, runs = 0;
  const never = new Promise<void>(() => {});
  const provider = createFakeProvider({
    onOperation: op => hang && op.name === operation ? never : undefined,
    onRun: () => { runs++; return { exitCode: 0, stdout: "ran in sandbox", stderr: "" }; },
  });
  const runtime = createLocalSandboxRuntime(f.config, { settings: useSandbox, access: async () => ({ enabled: true, scope: "fixture" }), provider: async () => provider, prepareTimeoutMs: 85 });
  try {
    if (operation === "inspect") await runtime.prepare(f.workspace);
    hang = true;
    await expect(runtime.execute(f.workspace, "shell", { command: "true" })).rejects.toThrow("took too long");
    await expect.poll(() => runtime.snapshot(f.workspace).error?.code).toBe("timed_out");
    expect(runs).toBe(0);
    hang = false;
    await runtime.prepare(f.workspace, "retry");
    expect(runtime.snapshot(f.workspace).state).toBe("ready");
    if (operation === "inspect") expect(provider.fake.count("destroy")).toBe(1);
    await runtime.execute(f.workspace, "shell", { command: "true" });
    expect(runs).toBe(1);
    await expect(runtime.close()).resolves.toBeUndefined();
  } finally { await runtime.close(); await f.cleanup(); }
});

test("an admission error settles preparing; a warm command inspects and reads each authority input once", async () => {
  const f = await fixture();
  let changed = true;
  let accessReads = 0, settingsReads = 0, foldersReads = 0;
  const provider = createFakeProvider();
  const runtime = createLocalSandboxRuntime(f.config, {
    settings: async () => { settingsReads++; return useSandbox(); },
    access: async () => { accessReads++; if (changed) throw new ApiError(409, "policy_identity_changed", "The signed-in account changed."); return { enabled: true, scope: "fixture" }; },
    externalDirectories: async () => { foldersReads++; return {}; }, provider: async () => provider,
  });
  try {
    runtime.setMode(f.workspace, "use");
    const rejected = runtime.prepare(f.workspace);
    expect(runtime.snapshot(f.workspace).state).toBe("preparing");
    await rejected;
    expect(runtime.snapshot(f.workspace)).toMatchObject({ mode: "use", state: "failed", error: { retryable: true } });
    changed = false;
    await runtime.prepare(f.workspace, "retry");
    const inspections = provider.fake.count("inspect"), finds = provider.fake.count("find");
    accessReads = settingsReads = foldersReads = 0;
    const start = performance.now();
    await runtime.execute(f.workspace, "shell", { command: "true" });
    console.info("Fake warm command ms", performance.now() - start);
    expect([accessReads, settingsReads, foldersReads]).toEqual([1, 1, 1]);
    expect(provider.fake.count("inspect") - inspections).toBe(1);
    expect(provider.fake.count("find") - finds).toBe(0);
  } finally { await runtime.close(); await f.cleanup(); }
});
