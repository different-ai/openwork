import assert from "node:assert/strict";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, rm, readFile, cp, copyFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startDesktop, desktopProfileEnvironment } from "../src/desktop.mjs";
import { bootDesktopOnly } from "../src/desktop-runtime.mjs";
import { inspectDesktop } from "../src/desktop-state.mjs";
import { refreshDesktop } from "../src/desktop-refresh.mjs";
import { prepareBlankSlateProfile } from "../../../apps/desktop/electron/blank-slate-profile.mjs";
import { isInteractive } from "../../../evals/packages/cdp/src/app-state.ts";
import { desktopBootstrapPath, openworkServerConfigPath, openworkServerDataDir, globalOpencodeConfigDir } from "../../paths/index.mjs";

test("desktop-only boot starts only Electron and publishes only desktop state", async () => {
  const files = new Map();
  const stack = new AsyncDisposableStack();
  let disposed = false;
  stack.defer(() => { disposed = true; });
  await bootDesktopOnly(stack, {
    start: async (owner, world) => {
      assert.equal(owner, stack);
      assert.equal(world, undefined);
      return { url: "http://127.0.0.1:6080", ready: Promise.resolve(true) };
    },
    inspect: async () => {},
    write: async (path, data) => { files.set(path.split("/").pop(), data); },
  });
  assert.deepEqual(JSON.parse(files.get("services.json")), { desktop: "http://127.0.0.1:6080" });
  assert.deepEqual(Object.keys(JSON.parse(files.get("outputs.json"))), ["desktopStatus"]);
  assert.equal(JSON.parse(files.get("ready-world")).world, "desktop");
  assert.equal(disposed, false);
  await stack.disposeAsync();
  assert.equal(disposed, true);
});

for (const phase of ["start", "ready", "inspect", "write"]) {
  test(`desktop-only ${phase} failure disposes processes and never publishes ready`, async () => {
    let disposed = false;
    const files = new Map();
    const stack = new AsyncDisposableStack();
    const fail = () => { throw new Error("synthetic failure"); };
    await assert.rejects(bootDesktopOnly(stack, {
      start: async () => {
        stack.defer(() => { disposed = true; });
        if (phase === "start") fail();
        return { url: "http://127.0.0.1:6080", ready: phase === "ready" ? Promise.reject(new Error("synthetic failure")) : Promise.resolve(true) };
      },
      inspect: async () => { if (phase === "inspect") fail(); },
      write: async (path, data) => {
        if (phase === "write" && path.endsWith("services.json")) fail();
        files.set(path.split("/").pop(), data);
      },
    }), /synthetic failure/);
    assert.equal(disposed, true);
    assert.equal(files.get("failed-world"), "failed");
    assert.equal(files.has("ready-world"), false);
  });
}

test("fresh profiles isolate every state path and do not inherit credentials or bootstrap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freestyle-desktop-"));
  try {
    const first = prepareBlankSlateProfile({ argv: ["--blank-slate"], env: {}, platform: "linux", temporaryDirectory: directory });
    const second = prepareBlankSlateProfile({ argv: ["--blank-slate"], env: {}, platform: "linux", temporaryDirectory: directory });
    assert.notEqual(first.rootPath, second.rootPath);
    for (const [key, value] of Object.entries(first.environment)) {
      assert.ok(value.startsWith(`${first.rootPath}/`), key);
      assert.notEqual(value, second.environment[key]);
    }
    const env = desktopProfileEnvironment(first, { PATH: "/usr/bin", DEN_TOKEN: "synthetic", OPENAI_API_KEY: "synthetic", OPENWORK_ELECTRON_START_URL: "https://unwanted.invalid", DAYTONA_SECRETS_ENV: "/secrets" });
    assert.equal(env.DEN_TOKEN, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.OPENWORK_ELECTRON_START_URL, undefined);
    assert.equal(env.DAYTONA_SECRETS_ENV, "/dev/null");
    assert.equal(env.COREPACK_HOME, "/opt/openwork-preview/corepack");
    assert.equal(env.COREPACK_ENABLE_NETWORK, "0");
    assert.equal(env.pnpm_config_verify_deps_before_run, "false");
    const options = { env: { ...env, OPENWORK_DEV_MODE: "1" }, platform: "linux", userDataDir: first.userDataPath };
    assert.equal(first.userDataPath, join(first.rootPath, "electron", "user-data"));
    assert.equal(env.HOME, join(first.rootPath, "home"));
    assert.equal(desktopBootstrapPath(options), join(first.rootPath, "openwork", "config", "desktop-bootstrap.json"));
    assert.equal(openworkServerConfigPath(options), env.OPENWORK_SERVER_CONFIG);
    assert.equal(openworkServerDataDir(options), env.OPENWORK_DATA_DIR);
    assert.equal(globalOpencodeConfigDir(options), env.OPENCODE_CONFIG_DIR);
    await assert.rejects(readFile(env.OPENWORK_DESKTOP_BOOTSTRAP_PATH), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("shared launcher has no Den front, sign-in or workspace side effects without a world", async (t) => {
  const commands = [];
  const writes = [];
  const killed = [];
  t.mock.method(fs, "mkdirSync", () => {});
  t.mock.method(fs, "existsSync", () => true);
  t.mock.method(fs, "openSync", () => 100);
  t.mock.method(fs, "closeSync", () => {});
  t.mock.method(fs, "writeFileSync", (path, data) => { writes.push({ path, data }); });
  t.mock.method(childProcess, "spawn", (command, args, options) => {
    commands.push({ command, args, options });
    return { pid: commands.length, unref() {} };
  });
  t.mock.method(process, "kill", (pid) => { killed.push(pid); return true; });
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/vnc.html")) return new Response("noVNC");
    assert.equal(url, "http://127.0.0.1:9825/json/list");
    return Response.json([{ type: "page" }]);
  });
  syncBuiltinESMExports();
  const stack = new AsyncDisposableStack();
  try {
    const desktop = await startDesktop(stack, undefined, { prepareProfile: async () => ({ environment: { HOME: "/isolated", OPENWORK_ELECTRON_USERDATA: "/isolated/profile", OPENWORK_DESKTOP_BOOTSTRAP_PATH: "/isolated/missing-bootstrap.json" } }) });
    await desktop.ready;
    assert.equal(desktop.denUrl, undefined);
    assert.deepEqual(commands.map((item) => item.command), ["Xvfb", "startxfce4", "x11vnc", "websockify", "bash"]);
    assert.ok(commands[4].args[1].includes("start-daytona-electron.sh"));
    assert.equal(commands[4].options.env.HOME, "/isolated");
    assert.equal(writes.some((item) => item.path.endsWith("bootstrap.json")), false);
    assert.equal(writes.at(-1).data, "ready-signed-out");
  } finally {
    await stack.disposeAsync();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(killed.length, 5);
});

test("desktop refresh reloads only the exact checkout and writes source-sha after readiness", async () => {
  const sha = "a".repeat(40);
  const events = [];
  const files = new Map();
  const deps = {
    head: () => sha,
    inspect: async (options) => { assert.deepEqual(options, { reload: true }); events.push("ready"); },
    read: async (path) => { assert.ok(path.endsWith("/ready-world")); return JSON.stringify({ pid: 123, world: "desktop" }); },
    write: async (path, value) => { events.push(path.split("/").pop()); files.set(path.split("/").pop(), value); },
  };
  await refreshDesktop(sha, deps);
  assert.deepEqual(events, ["ready", "ready-world", "source-sha"]);
  assert.equal(files.get("source-sha"), sha);
  assert.equal(JSON.parse(files.get("ready-world")).pid, 123);
  events.length = 0;
  await assert.rejects(refreshDesktop("not-a-sha", deps), /exact checked-out/);
  await assert.rejects(refreshDesktop("b".repeat(40), deps), /exact checked-out/);
  await assert.rejects(refreshDesktop(sha, { ...deps, inspect: async () => { throw new Error("reload failed"); } }), /reload failed/);
  assert.deepEqual(events, []);
});

const pristineObserved = Object.fromEntries([
  "reloaded", "rendererRead", "productContractRead", "firstRun", "noAppCloudIdentity", "signInOffered", "ordinaryDefaultModel",
  "routeReady", "routeWorkspaceValid", "noRouteConversations", "nativeRead", "nativeLocalOnly", "nativeWorkspaceMatches",
  "noNativeCloudSession", "noProvisionedModel", "noCloudConfiguration", "noNativeConversations",
].map((key) => [key, true]));
const pristineProfile = async () => ({ expectedWorkspacePath: "/isolated/OpenWork Chat", isolatedProfile: true, noBootstrap: true, noNativeProviderCredentials: true, nativeWorkspaceValid: true });

test("desktop reload proves a new document, never signs in, and releases CDP initialization", async () => {
  const events = [];
  const result = await inspectDesktop({ reload: true, readProfile: pristineProfile, loadCdp: async () => ({
    attachSurface: async () => ({ client: { send: async (method) => { events.push(method); } }, stop: async () => { events.push("stop"); } }),
    browserScript: (_fn, args) => { assert.equal(typeof (typeof args[0] === "object" ? args[0].nonce : args[0]), "string"); return "synthetic"; },
    addInitScript: async () => ({ dispose: async () => { events.push("dispose"); } }),
    evaluate: async () => pristineObserved,
    probeAppState: async () => ({ surface: "workspace", workspaceId: "ws_initial" }),
    isInteractive: () => true,
  }) });
  assert.equal(result.firstRun, true);
  assert.deepEqual(events, ["Page.reload", "dispose", "stop"]);
});

for (const scenario of [
  { name: "stock automatic workspace", expected: true },
  { name: "unbootstrapped welcome", state: { surface: "welcome", workspaceId: null }, expected: false },
  { name: "loading task UI", state: { transitional: "Preparing workspace" }, expected: false },
  { name: "missing control", state: { controlReady: false }, expected: false },
  { name: "demo workspace", empty: { routeWorkspaceValid: false }, expected: false },
  { name: "signed-in state", empty: { noAppCloudIdentity: false }, expected: false },
  { name: "gateway model", empty: { ordinaryDefaultModel: false }, expected: false },
  { name: "native cloud token", empty: { noNativeCloudSession: false }, expected: false },
  { name: "native conversations", empty: { noNativeConversations: false }, expected: false },
  { name: "completed onboarding", empty: { firstRun: false }, expected: false },
  { name: "stale reload", empty: { reloaded: false }, expected: false },
]) {
  test(`desktop readiness checks ${scenario.name} and closes CDP`, async () => {
    let stopped = false;
    let reported;
    const task = inspectDesktop({ timeoutMs: 10, readProfile: pristineProfile, report: (flags) => { reported = flags; }, loadCdp: async () => ({
      attachSurface: async () => ({ client: {}, stop: async () => { stopped = true; } }),
      browserScript: () => "synthetic",
      evaluate: async () => ({ ...pristineObserved, ...scenario.empty }),
      probeAppState: async () => ({ surface: "workspace", workspaceId: "ws_initial", controlReady: true, transitional: null, ...scenario.state }),
      isInteractive,
    }) });
    if (scenario.expected) {
      const proof = await task;
      assert.equal(proof.emptyLocalWorkspace, true);
      assert.equal(proof.ordinaryDefaultModel, true);
      assert.equal(proof.noProvisionedModel, true);
      assert.equal(proof.noWorkspace, undefined);
      assert.equal(proof.noDefaultModel, undefined);
      assert.equal(reported, undefined);
    } else {
      await assert.rejects(task, /pristine signed-out state/);
      assert.ok(Object.values(reported).every((value) => typeof value === "boolean"));
      assert.ok(Object.values(reported).some((value) => value === false));
    }
    assert.equal(stopped, true);
  });
}

test("CDP entrypoint loads under Node without either workspace's node_modules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freestyle-cdp-"));
  try {
    await cp(new URL("../../../evals/packages/cdp/src/", import.meta.url), join(directory, "src"), { recursive: true });
    await copyFile(new URL("../../../evals/packages/cdp/package.json", import.meta.url), join(directory, "package.json"));
    const result = childProcess.execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      const cdp = await import(process.argv[1]);
      for (const name of ["attachSurface", "addInitScript", "browserScript", "evaluate", "probeAppState", "isInteractive"]) assert.equal(typeof cdp[name], "function");
      assert.equal(typeof WebSocket, "function");
      assert.equal(typeof AsyncDisposableStack, "function");
      console.log("standalone-cdp-ready");
    `, pathToFileURL(join(directory, "src", "index.ts")).href], { cwd: directory, encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH } });
    assert.equal(result.trim(), "standalone-cdp-ready");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const name of ["runtime", "health", "refresh"]) {
  test(`controller-owned desktop-${name} executes when copied as ${name}.mjs`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "freestyle-entrypoint-"));
    const sha = "a".repeat(40);
    try {
      await copyFile(new URL(`../src/desktop-${name}.mjs`, import.meta.url), join(directory, `${name}.mjs`));
      await writeFile(join(directory, "desktop-state.mjs"), `
        export async function inspectDesktop(options = {}) { console.log(JSON.stringify({ inspect: options })); }
      `);
      await writeFile(join(directory, "desktop.mjs"), `
        export async function startDesktop(stack) {
          console.log(JSON.stringify({ start: true }));
          stack.defer(() => { console.log(JSON.stringify({ disposed: true })); });
          return { url: "http://127.0.0.1:6080", ready: Promise.resolve(true) };
        }
      `);
      await writeFile(join(directory, "mock-io.mjs"), `
        import assert from "node:assert/strict";
        import fs from "node:fs/promises";
        import childProcess from "node:child_process";
        import { syncBuiltinESMExports } from "node:module";
        fs.readFile = async (path) => {
          if (path.endsWith("/services.json")) return JSON.stringify({ desktop: "http://127.0.0.1:6080" });
          assert.ok(path.endsWith("/ready-world"));
          return JSON.stringify({ world: "desktop", pid: 123 });
        };
        fs.writeFile = async (path, value) => {
          console.log(JSON.stringify({ write: path.split("/").pop(), value }));
          if (${JSON.stringify(name)} === "runtime" && path.endsWith("/ready-world")) setImmediate(() => process.emit("SIGTERM"));
        };
        childProcess.execFileSync = (command, args) => {
          assert.equal(command, "git");
          assert.deepEqual(args, ["-C", "/workspace", "rev-parse", "HEAD"]);
          return ${JSON.stringify(sha)};
        };
        globalThis.fetch = async (url) => {
          assert.equal(url, "http://127.0.0.1:6080/vnc.html");
          return new Response("noVNC");
        };
        syncBuiltinESMExports();
      `);
      const result = childProcess.execFileSync(process.execPath, ["--import", pathToFileURL(join(directory, "mock-io.mjs")).href, join(directory, `${name}.mjs`), sha], {
        cwd: directory, encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH },
      });
      const events = result.trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(events.find((entry) => entry.inspect), { inspect: name === "refresh" ? { reload: true } : {} });
      if (name === "runtime") {
        assert.ok(events.some((entry) => entry.start));
        assert.ok(events.some((entry) => entry.write === "ready-world"));
        assert.ok(events.some((entry) => entry.disposed));
      } else if (name === "refresh") {
        assert.deepEqual(events.at(-1), { write: "source-sha", value: sha });
      } else assert.equal(events.length, 1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
