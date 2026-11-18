import { expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createFakeProvider } from "../../../packages/sandbox/src/testing/fake-provider.js";
import { createLocalSandboxRuntime, localSandboxRuntime } from "../src/local-sandbox-runtime.js";
import { createSandboxToolsBridge } from "../src/sandbox-tools-bridge.js";
import { sandboxInstallationStatus, sandboxPlatformStatus, sandboxRuntimeFailure } from "../src/sandbox-runtime-status.js";
import type { ServerConfig } from "../src/types.js";
import { serve } from "../src/serve-node.js";

async function fixture(readOnly = false) {
  const temp = await mkdtemp(join(tmpdir(), "sandbox-status-"));
  const directory = join(temp, "project");
  await mkdir(directory);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "fixture-client", hostToken: "fixture-host", configPath: join(temp, "runtime", "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], trustedDenOrigin: "http://127.0.0.1:1",
    workspaces: [{ id: "fixture", path: directory, name: "Fixture", preset: "starter", workspaceType: "local" }],
    authorizedRoots: [directory], readOnly, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  return { config, directory, cleanup: () => rm(temp, { recursive: true, force: true }) };
}
const access = async () => ({ enabled: true, scope: "fixture" });

test("platform and SDK failures give actionable copy, never native diagnostics", () => {
  expect(sandboxPlatformStatus("darwin", "x64")).toMatchObject({ state: "unsupported", canRetry: false, message: expect.stringContaining("Apple silicon") });
  expect(sandboxPlatformStatus("win32", "arm64")).toMatchObject({ state: "unsupported", message: expect.stringContaining("Choose On this computer") });
  expect(sandboxPlatformStatus("linux", "x64", false)).toMatchObject({ state: "unsupported", canRetry: true, message: expect.stringContaining("enable virtualization") });
  expect(sandboxPlatformStatus("linux", "x64", true)).toBeUndefined();
  const internal = Object.assign(new Error("private native module path /sensitive/details"), { code: "ERR_MODULE_NOT_FOUND" });
  expect(sandboxRuntimeFailure(new Error("wrapper", { cause: internal }))).toEqual({ state: "unsupported", reason: "app_update_required", canRetry: false, message: "Sandbox files are unavailable. Update OpenWork, then try again." });
  const denied = Object.assign(new Error("private installation path"), { code: "EACCES" });
  expect(sandboxRuntimeFailure(denied)).toMatchObject({ state: "unsupported", reason: "runtime_permission_denied", canRetry: true });
  expect(sandboxRuntimeFailure(denied).message).not.toContain("not supported on this computer");
  expect(sandboxRuntimeFailure(denied, false)).toMatchObject({ state: "failed", reason: "runtime_failed" });
  expect(sandboxRuntimeFailure(Object.assign(new Error("private native file error"), { code: "io" }))).toMatchObject({ state: "unsupported", reason: "runtime_unavailable", canRetry: true });
});

test("a real unavailable installation folder becomes usable after repairing that same owned path", async () => {
  const f = await fixture();
  const home = join(f.directory, "owned-sandbox-home");
  try {
    await writeFile(home, "not a directory");
    expect(await sandboxInstallationStatus(home, "")).toMatchObject({ state: "unsupported", reason: "runtime_unavailable", canRetry: true });
    await rm(home); await mkdir(home);
    expect(await sandboxInstallationStatus(home, "")).toBeUndefined();
    const binary = join(home, "owned-runtime");
    await writeFile(binary, "not executable", { mode: 0o600 });
    expect(await sandboxInstallationStatus(home, binary)).toMatchObject({ state: "unsupported", reason: "runtime_permission_denied", canRetry: true });
  } finally { await f.cleanup(); }
});

test("prepare exposes real setup stages, is idempotent, and runs no agent command", async () => {
  const f = await fixture();
  let importing: () => void = () => {};
  let releaseImport: () => void = () => {};
  let starting: () => void = () => {};
  let releaseStart: () => void = () => {};
  const imported = new Promise<void>(resolve => { importing = resolve; });
  const importWait = new Promise<void>(resolve => { releaseImport = resolve; });
  const started = new Promise<void>(resolve => { starting = resolve; });
  const startWait = new Promise<void>(resolve => { releaseStart = resolve; });
  const provider = createFakeProvider({ onOperation: async operation => { if (operation.name === "create") { starting(); await startWait; } } });
  let factories = 0;
  const runtime = createLocalSandboxRuntime(f.config, { access, externalDirectories: async () => ({}), provider: async () => { factories++; importing(); await importWait; return provider; } });
  try {
    expect(await runtime.runtimeStatus(f.directory)).toEqual({ state: "idle", canRetry: false });
    const first = runtime.prepare(f.directory);
    const duplicate = runtime.prepare(`${f.directory}/`);
    expect(duplicate).toBe(first);
    await imported;
    expect(await runtime.runtimeStatus(f.directory)).toEqual({ state: "starting", stage: "preparing_files", progress: { completed: 0, total: 2 }, canRetry: false });
    releaseImport(); await started;
    expect(await runtime.runtimeStatus(f.directory)).toEqual({ state: "starting", stage: "starting", progress: { completed: 1, total: 2 }, canRetry: false });
    releaseStart(); await first;
    expect(await runtime.runtimeStatus(f.directory)).toEqual({ state: "ready", canRetry: false });
    await runtime.prepare(f.directory);
    expect(factories).toBe(1);
    expect(provider.fake.count("create")).toBe(1);
    expect(provider.fake.count("run")).toBe(0);
    const inspections = provider.fake.count("inspect");
    await Promise.all(Array.from({ length: 10 }, () => runtime.runtimeStatus(f.directory)));
    expect(provider.fake.count("inspect")).toBe(inspections);
  } finally { releaseImport(); releaseStart(); await runtime.close(); await f.cleanup(); }
});

test("revoked authority during bundled-file preparation prevents guest creation", async () => {
  const f = await fixture();
  let enabled = true;
  let importing: () => void = () => {};
  let release: () => void = () => {};
  const started = new Promise<void>(resolve => { importing = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const provider = createFakeProvider();
  const runtime = createLocalSandboxRuntime(f.config, { access: async () => ({ enabled, scope: "fixture" }), externalDirectories: async () => ({}), provider: async () => { importing(); await hold; return provider; } });
  try {
    const pending = runtime.prepare(f.directory);
    const rejected = expect(pending).rejects.toThrow("access changed");
    await started;
    enabled = false; release();
    await rejected;
    expect(provider.fake.count("create")).toBe(0);
    expect(await runtime.runtimeStatus(f.directory)).toBeNull();
  } finally { release(); await runtime.close(); await f.cleanup(); }
});

test("SDK unavailable and startup failure persist, and retry rechecks the repaired runtime", async () => {
  const f = await fixture();
  let failure: Error | undefined = Object.assign(new Error("hidden SDK filename"), { code: "MODULE_NOT_FOUND" });
  const provider = createFakeProvider();
  const runtime = createLocalSandboxRuntime(f.config, { access, externalDirectories: async () => ({}), provider: async () => { if (failure) throw failure; return provider; } });
  try {
    await expect(runtime.prepare(f.directory)).rejects.toThrow("hidden SDK");
    expect(await runtime.runtimeStatus(f.directory)).toMatchObject({ state: "unsupported", canRetry: false });
    failure = new Error("hidden startup stack");
    await expect(runtime.prepare(f.directory)).rejects.toThrow("hidden startup");
    expect(await runtime.runtimeStatus(f.directory)).toMatchObject({ state: "failed", canRetry: true });
    expect(JSON.stringify(await runtime.runtimeStatus(f.directory))).not.toContain("hidden");
    failure = undefined;
    await runtime.prepare(f.directory);
    expect(await runtime.runtimeStatus(f.directory)).toEqual({ state: "ready", canRetry: false });
  } finally { await runtime.close(); await f.cleanup(); }
});

test("tool failure after guest death is retained and unexpected idle VM death is discovered by a status read", async () => {
  const f = await fixture();
  let fail = true;
  const provider = createFakeProvider({ onRun: () => {
    if (fail) {
      const guest = provider.fake.sandboxes()[0];
      if (guest) provider.fake.setState(guest.id, "error");
      throw new Error("native transport private stack");
    }
    return { exitCode: 0, stdout: "guest", stderr: "" };
  } });
  const runtime = createLocalSandboxRuntime(f.config, { access, externalDirectories: async () => ({}), provider: async () => provider });
  try {
    await expect(runtime.execute(f.directory, "shell", { command: "true" })).rejects.toThrow("native transport");
    expect(await runtime.runtimeStatus(f.directory)).toMatchObject({ state: "failed", canRetry: true });
    fail = false;
    await runtime.prepare(f.directory);
    const handle = (await provider.list({}))[0];
    expect(handle).toBeDefined();
    await provider.destroy(handle, { timeoutMs: 1000 });
    await delay(510);
    expect(await runtime.runtimeStatus(f.directory)).toMatchObject({ state: "failed", canRetry: true });
    const creates = provider.fake.count("create");
    await runtime.runtimeStatus(f.directory);
    expect(provider.fake.count("create")).toBe(creates);
    await runtime.prepare(f.directory);
    expect(await runtime.runtimeStatus(f.directory)).toMatchObject({ state: "ready" });
    expect(provider.fake.count("create")).toBe(creates + 1);
  } finally { await runtime.close(); await f.cleanup(); }
});

test("missing guest files, edit validation, readonly writes, and live-guest transport errors leave the runtime ready", async () => {
  const f = await fixture(true);
  let denyWrite = false;
  const readonlyError = Object.assign(new Error("guest filesystem is readonly"), { code: "EROFS" });
  const transportError = new Error("guest operation transport error");
  const provider = createFakeProvider({
    onOperation: operation => { if (denyWrite && operation.name === "files.write") throw readonlyError; },
    onRun: () => { throw transportError; },
  });
  const runtime = createLocalSandboxRuntime(f.config, { access, externalDirectories: async () => ({}), provider: async () => provider });
  try {
    await expect(runtime.execute(f.directory, "read", { path: "/tmp/absent-file" })).rejects.toThrow("Guest path is not a file");
    expect(await runtime.runtimeStatus(f.directory)).toEqual({ state: "ready", canRetry: false });
    await runtime.execute(f.directory, "write", { path: "/tmp/data.txt", content: "Existing guest data" });
    await expect(runtime.execute(f.directory, "edit", { path: "/tmp/data.txt", oldString: "absent text", newString: "replacement" })).rejects.toThrow("oldString was not found");
    expect(await runtime.runtimeStatus(f.directory)).toEqual({ state: "ready", canRetry: false });
    await expect(runtime.execute(f.directory, "edit", { path: "/tmp/data.txt", oldString: "unchanged", newString: "unchanged" })).rejects.toThrow("must differ");
    expect(await runtime.runtimeStatus(f.directory)).toEqual({ state: "ready", canRetry: false });
    denyWrite = true;
    await expect(runtime.execute(f.directory, "write", { path: `${f.directory}/readonly.txt`, content: "blocked write" })).rejects.toBe(readonlyError);
    expect(await runtime.runtimeStatus(f.directory)).toEqual({ state: "ready", canRetry: false });
    await expect(runtime.execute(f.directory, "shell", { command: "true" })).rejects.toBe(transportError);
    expect(await runtime.runtimeStatus(f.directory)).toEqual({ state: "ready", canRetry: false });
    expect(provider.fake.count("create")).toBe(1);
  } finally { await runtime.close(); await f.cleanup(); }
});

test("a failed health inspection after a tool error records failure without replacing the original tool error", async () => {
  const f = await fixture();
  let failHealth = false;
  const toolError = new Error("original guest operation error");
  const provider = createFakeProvider({
    onOperation: operation => { if (failHealth && operation.name === "inspect") throw new Error("health probe unavailable"); },
    onRun: () => { failHealth = true; throw toolError; },
  });
  const runtime = createLocalSandboxRuntime(f.config, { access, externalDirectories: async () => ({}), provider: async () => provider });
  try {
    await expect(runtime.execute(f.directory, "shell", { command: "true" })).rejects.toBe(toolError);
    expect(await runtime.runtimeStatus(f.directory)).toMatchObject({ state: "failed", canRetry: true });
    failHealth = false;
    await runtime.prepare(f.directory);
    expect(await runtime.runtimeStatus(f.directory)).toEqual({ state: "ready", canRetry: false });
  } finally { failHealth = false; await runtime.close(); await f.cleanup(); }
});

test("actual readonly server configuration reaches every workspace and authorized-folder mount", async () => {
  const f = await fixture(true);
  const external = join(f.directory, "shared");
  await mkdir(external);
  const original = join(f.directory, "data.txt");
  await writeFile(original, "Original user data");
  const mounts: { guestPath: string; access: string }[] = [];
  const runtime = createLocalSandboxRuntime(f.config, { access, externalDirectories: async () => ({ [`${external}/*`]: "allow" }), provider: async received => { mounts.push(...received); return createFakeProvider(); } });
  try {
    await runtime.prepare(f.directory);
    expect(mounts).toEqual([{ hostPath: expect.any(String), guestPath: f.directory, access: "ro" }, { hostPath: expect.any(String), guestPath: external, access: "ro" }]);
    expect(await readFile(original, "utf8")).toBe("Original user data");
  } finally { await runtime.close(); await f.cleanup(); }
});

test("authenticated prepare route reports readonly access, real failures, recovery, and flag-off without booting on GET", async () => {
  const f = await fixture(true);
  let enabled = true;
  const den = await serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ features: { sandboxTools: enabled } }) });
  f.config.trustedDenOrigin = `http://127.0.0.1:${den.port}`;
  f.config.engineAutoUpgrade = false;
  const previous = process.env.OPENWORK_ENGINE_V2_PREVIEW;
  process.env.OPENWORK_ENGINE_V2_PREVIEW = "0";
  let broken = true;
  let releasePreparation: () => void = () => {};
  const preparation = new Promise<void>(resolve => { releasePreparation = resolve; });
  const provider = createFakeProvider();
  const mounts: string[] = [];
  localSandboxRuntime(f.config, { externalDirectories: async () => ({}), provider: async received => {
    if (broken) throw Object.assign(new Error("private SDK path"), { code: "MODULE_NOT_FOUND" });
    await preparation;
    mounts.push(...received.map(mount => mount.access));
    return provider;
  } });
  const { startServer } = await import("../src/server.js");
  const server = await startServer(f.config, { deferManagedEngineStartup: true });
  const root = `http://127.0.0.1:${server.port}/workspace/fixture`;
  const headers = { authorization: `Bearer ${f.config.token}` };
  async function awaitRuntime(state: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await (await fetch(`${root}/sandbox-settings`, { headers })).json();
      if (result.runtime?.state === state) return result;
      await delay(20);
    }
    throw new Error(`Sandbox did not report ${state}`);
  }
  try {
    expect((await fetch(`${root}/sandbox-prepare`, { method: "POST" })).status).toBe(401);
    expect(await (await fetch(`${root}/sandbox-settings`, { headers })).json()).toMatchObject({ folderAccess: "read", runtime: { state: "idle" } });
    expect(provider.fake.count("create")).toBe(0);
    const failed = await fetch(`${root}/sandbox-prepare`, { method: "POST", headers });
    expect(failed.status).toBe(202);
    expect(await awaitRuntime("unsupported")).toMatchObject({ runtime: { state: "unsupported", reason: "app_update_required", canRetry: false, message: expect.stringContaining("Update OpenWork") } });
    broken = false;
    const prepared = await fetch(`${root}/sandbox-prepare`, { method: "POST", headers });
    expect(prepared.status).toBe(202);
    expect(await awaitRuntime("starting")).toMatchObject({ runtime: { stage: "preparing_files", progress: { completed: 0, total: 2 } } });
    releasePreparation();
    expect(await awaitRuntime("ready")).toMatchObject({ folderAccess: "read", runtime: { state: "ready" } });
    expect(mounts).toEqual(["ro"]);
    await fetch(`${root}/sandbox-prepare`, { method: "POST", headers });
    expect(provider.fake.count("create")).toBe(1);
    expect(provider.fake.count("run")).toBe(0);
    enabled = false;
    expect(await (await fetch(`${root}/sandbox-settings`, { headers })).json()).toMatchObject({ runtime: null });
    expect((await fetch(`${root}/sandbox-prepare`, { method: "POST", headers })).status).toBe(403);
    expect(provider.fake.count("create")).toBe(1);
  } finally {
    releasePreparation(); await server.stop(); await den.stop(); await f.cleanup();
    if (previous === undefined) delete process.env.OPENWORK_ENGINE_V2_PREVIEW;
    else process.env.OPENWORK_ENGINE_V2_PREVIEW = previous;
  }
});

test("settings prepare and authenticated engine bridge reuse the same guest and status", async () => {
  const f = await fixture();
  let enabled = true;
  const provider = createFakeProvider();
  const runtime = localSandboxRuntime(f.config, { access: async () => ({ enabled, scope: "fixture" }), externalDirectories: async () => ({}), provider: async () => provider });
  await runtime.prepare(f.directory);
  const bridge = await createSandboxToolsBridge(f.config);
  try {
    const response = await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify({ operation: "execute", directory: f.directory, name: "shell", input: { command: "true" }, sessionId: "fixture" }) });
    expect(response.status).toBe(200);
    expect(provider.fake.count("create")).toBe(1);
    expect(await localSandboxRuntime(f.config).runtimeStatus(f.directory)).toMatchObject({ state: "ready" });
    enabled = false;
    expect(await runtime.runtimeStatus(f.directory)).toBeNull();
    await expect(runtime.prepare(f.directory)).rejects.toThrow("disabled");
    expect(provider.fake.count("create")).toBe(1);
  } finally { await bridge.close(); await f.cleanup(); }
});
