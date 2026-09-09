import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { createLocalComputerAdapter } from "./computer-local.mjs";
import afterPack from "../scripts/electron-build.mjs";

const permissions = { ok: true, supported: true, accessibility: true, screenRecording: true, protocolVersion: "openwork.computer-use/1" };
const names = ["computer_discover", "computer_open_session", "computer_observe", "computer_act", "computer_session_status", "computer_close_session"];
const schemas = names.map((name) => ({ name, inputSchema: { type: "object", additionalProperties: false } }));

function fixture(options = {}) {
  const spawned = [];
  const connections = [];
  const calls = [];
  const children = [];
  let clientInfo;
  let clientOptions;
  const adapter = createLocalComputerAdapter({
    platform: "darwin", osRelease: "25.0.0", resourcesPath: "/fixture/Resources",
    fileExists: () => options.exists !== false,
    timeouts: { probe: 40, handshake: 80, call: 100, close: 100 },
    spawnChild(command, args, spawnOptions) {
      spawned.push({ command, args, options: spawnOptions });
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), exitCode: null, signalCode: null, signals: [], unreferenced: false });
      child.kill = (signal) => {
        child.signals.push(signal);
        if (signal !== "SIGUSR1" && !options.ignoreKill) queueMicrotask(() => child.emit("close", null));
        return true;
      };
      child.unref = () => { child.unreferenced = true; };
      children.push(child);
      queueMicrotask(() => {
        if (options.spawnError) {
          child.emit("error", new Error("fixture spawn error"));
          child.emit("close", -2);
          return;
        }
        child.emit("spawn");
        if ((args[0] === "--check" && !options.checkHang) || (args[0] === "permissions" && !options.setupHang)) {
          if (args[0] === "--check") child.stdout.write(options.output ?? JSON.stringify({ ...permissions, ...options.permissions }));
          child.exitCode = args[0] === "--check" ? options.checkCode ?? 0 : options.setupCode ?? 0;
          child.emit("exit", child.exitCode);
          child.emit("close", child.exitCode);
        }
      });
      return child;
    },
    mcp: async () => ({
      Client: class {
        constructor(info, config) { clientInfo = info; clientOptions = config; }
        async connect(transport, requestOptions) {
          this.transport = transport;
          transport.handshakeOptions = requestOptions;
          if (options.handshakeHang) await new Promise(() => {});
          if (options.handshakeError) {
            // SDK does this on an initialize failure without awaiting shutdown.
            void transport.close();
            throw new Error("Unsupported MCP protocol");
          }
        }
        getServerVersion() { return options.server ?? { name: "openwork-computer-use", version: "1.0.0" }; }
        getServerCapabilities() { return { tools: {} }; }
        async listTools() { return { tools: options.tools ?? schemas, ...options.toolList }; }
        async callTool(params, schema, requestOptions) {
          calls.push({ params, schema, options: requestOptions, transport: this.transport });
          if (options.call) return options.call(params, requestOptions);
          return { content: [{ type: "text", text: '{"ok":true}' }, { type: "image", data: "fixture-only", mimeType: "image/png" }] };
        }
      },
      StdioClientTransport: class {
        constructor(params) { this.params = params; this.closeCount = 0; connections.push(this); }
        async close() {
          this.closeCount++;
          if (!options.deferClose) queueMicrotask(() => this.onclose?.());
          if (options.closeError) throw new Error("Fixture transport close failed");
        }
      },
    }),
    ...options.dependencies,
  });
  return { adapter, spawned, children, connections, calls, info: () => ({ clientInfo, clientOptions }) };
}

test("readiness is a fresh read-only protocol/permission probe with no private metadata", async () => {
  const f = fixture();
  assert.deepEqual(Object.keys(f.adapter).sort(), ["connect", "id", "label", "placement", "protocol", "readiness", "setup"]);
  assert.equal(f.adapter.id, "this-mac");
  assert.equal(f.adapter.label, "This Mac");
  assert.equal(f.adapter.placement, "desktop");
  assert.equal(f.adapter.protocol, "openwork.computer-use/1");
  const state = await f.adapter.readiness();
  assert.equal(state.readiness, "ready");
  assert.deepEqual(Object.keys(state).sort(), ["detail", "permissions", "readiness"]);
  assert.deepEqual(state.permissions, { accessibility: true, screenRecording: true });
  await f.adapter.readiness();
  assert.equal(f.spawned.length, 2);
  assert.equal(f.connections.length, 0);
  for (const invocation of f.spawned) {
    assert.deepEqual(invocation.args, ["--check"]);
    assert.equal(invocation.command, "/fixture/Resources/helpers/OpenWork Computer Use.app/Contents/MacOS/ComputerUse");
    assert.deepEqual(invocation.options.stdio, ["ignore", "pipe", "ignore"]);
    assert.ok(Object.keys(invocation.options.env).every((key) => ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "TMPDIR"].includes(key)));
  }
});

test("unsupported OS and missing helper do not spawn, build, or request permissions", async () => {
  for (const dependencies of [{ platform: "linux" }, { platform: "win32" }, { osRelease: "22.6.0" }, { osRelease: "unknown" }]) {
    const f = fixture({ dependencies });
    assert.equal((await f.adapter.readiness()).readiness, "unsupported");
    await assert.rejects(f.adapter.setup("accessibility"), /macOS 14/);
    await assert.rejects(f.adapter.connect(), /macOS 14/);
    assert.equal(f.spawned.length, 0);
  }
  const f = fixture({ exists: false });
  assert.match((await f.adapter.readiness()).detail, /helper is missing/);
  await assert.rejects(f.adapter.connect(), /helper is missing/);
  assert.equal(f.spawned.length, 0);
});

test("permission denial is setup-required, not missing or unsupported", async () => {
  for (const denied of [{ accessibility: false }, { screenRecording: false }, { accessibility: false, screenRecording: false }]) {
    const f = fixture({ permissions: { ...denied, ok: false } });
    const state = await f.adapter.readiness();
    assert.equal(state.readiness, "setup-required");
    assert.deepEqual(state.permissions, { accessibility: true, screenRecording: true, ...denied });
    if (denied.accessibility === false) assert.match(state.detail, /Accessibility/);
    if (denied.screenRecording === false) assert.match(state.detail, /Screen Recording/);
    await assert.rejects(f.adapter.connect(), /permission/);
    assert.equal(f.connections.length, 0);
    assert.ok(f.spawned.every(({ args }) => args[0] === "--check"));
  }
});

test("invalid protocol, malformed output, spawn errors and failed checks are unavailable", async () => {
  for (const options of [
    { permissions: { protocolVersion: "old" } }, { output: "not-json" }, { permissions: { accessibility: "true" } },
    { checkCode: 1 }, { spawnError: true }, { output: "x".repeat(16_385) }, { permissions: { ok: false } },
  ]) {
    const f = fixture(options);
    const state = await f.adapter.readiness();
    assert.equal(state.readiness, "unavailable");
    assert.equal(state.permissions, undefined);
    await assert.rejects(f.adapter.connect());
    assert.equal(f.connections.length, 0);
  }
  assert.equal((await fixture({ permissions: { supported: false } }).adapter.readiness()).readiness, "unsupported");
});

test("stalled probes kill only their own child and report unconfirmed termination honestly", async () => {
  for (const ignoreKill of [false, true]) {
    const f = fixture({ checkHang: true, ignoreKill });
    const state = await f.adapter.readiness();
    assert.equal(state.readiness, "unavailable");
    assert.match(state.detail, ignoreKill ? /termination could not be confirmed/ : /timed out/);
    assert.deepEqual(f.children[0].signals, ["SIGKILL"]);
  }
});

test("explicit setup requests only the chosen permission in the same helper context, without a GUI or control session", async () => {
  const f = fixture({ permissions: { ok: false, accessibility: false } });
  for (const invalid of [undefined, "setup", "mcp", "Privacy_AllFiles"]) await assert.rejects(f.adapter.setup(invalid), /Choose Accessibility/);
  assert.equal(f.spawned.length, 0);
  await Promise.all([f.adapter.setup("accessibility"), f.adapter.setup("accessibility")]);
  assert.deepEqual(f.spawned.map(({ args }) => args), [["--check"], ["permissions", "accessibility"]]);
  assert.equal(f.spawned[0].command, f.spawned[1].command);
  assert.equal(f.spawned[1].options.stdio, "ignore");
  await f.adapter.setup("screenRecording");
  assert.deepEqual(f.spawned.at(-1).args, ["permissions", "screenRecording"]);
  assert.equal((await f.adapter.readiness()).permissions.accessibility, false, "opening settings does not grant permission");
  assert.equal(f.connections.length, 0);
  const failed = fixture({ setupCode: 1 });
  await assert.rejects(failed.adapter.setup("accessibility"), /Could not open macOS/);
  const hung = fixture({ setupHang: true });
  await assert.rejects(hung.adapter.setup("screenRecording"), /timed out/);
  assert.deepEqual(hung.children[1].signals, ["SIGKILL"]);
});

test("connections are dedicated, allowlist-bound and return raw MCP results only to their caller", async () => {
  const f = fixture();
  const first = await f.adapter.connect();
  const second = await f.adapter.connect();
  assert.equal(f.connections.length, 2);
  assert.deepEqual(f.info().clientOptions, { capabilities: {}, enforceStrictCapabilities: true });
  for (const transport of f.connections) {
    assert.deepEqual(transport.params.args, ["mcp-coworker"]);
    assert.equal(transport.params.command, f.spawned[0].command);
    assert.equal(transport.params.stderr, "ignore");
    assert.equal(transport.handshakeOptions.resetTimeoutOnProgress, false);
  }
  for (const name of ["shell", "computer", "computer_screenshot", "setup", "initialize", "__proto__"]) {
    await assert.rejects(first.callTool(name, {}), /not allowed/);
  }
  await assert.rejects(first.callTool("computer_discover", []), /object/);
  await assert.rejects(first.callTool("computer_discover", {}, { timeoutMs: Infinity }), /finite/);
  const result = await first.callTool("computer_observe", { session_id: "s1" }, { command: "forbidden", endpoint: "https://invalid.example", timeoutMs: 100_000 });
  assert.equal(result.content[1].type, "image");
  assert.equal(f.calls[0].transport, f.connections[0]);
  assert.deepEqual(f.calls[0].params, { name: "computer_observe", arguments: { session_id: "s1" } });
  assert.equal(f.calls[0].options.timeout, 100);
  assert.equal(f.calls[0].options.command, undefined);
  assert.equal(f.calls[0].options.endpoint, undefined);
  await second.callTool("computer_discover", {});
  assert.equal(f.calls[1].transport, f.connections[1]);
  await first.close();
  await second.close();
});

test("handshake rejects unknown implementations, changed tool surfaces and partial startup", async () => {
  for (const options of [
    { server: { name: "old-helper", version: "1.0.0" } }, { server: { name: "openwork-computer-use", version: "0.1.0" } },
    { tools: schemas.slice(1) }, { tools: [...schemas, { name: "shell" }] }, { tools: schemas.map(() => schemas[0]) },
    { tools: schemas.map((tool) => ({ ...tool, inputSchema: { type: "object" } })) },
    { toolList: { nextCursor: "more" } }, { handshakeError: true }, { handshakeHang: true },
  ]) {
    const f = fixture(options);
    await assert.rejects(f.adapter.connect());
    assert.equal(f.connections[0].closeCount, 1);
    assert.equal(f.calls.length, 0);
  }
});

test("close guarantees native session release by waiting for helper exit, including concurrent closes", async () => {
  const f = fixture({ deferClose: true });
  const connection = await f.adapter.connect();
  let finished = false;
  const closing = connection.close().then(() => { finished = true; });
  const again = connection.close();
  await delay(10);
  assert.equal(finished, false, "SDK close returning is not a termination receipt");
  assert.equal(f.connections[0].closeCount, 1);
  await assert.rejects(connection.callTool("computer_discover", {}), /closed/);
  f.connections[0].onclose();
  await Promise.all([closing, again]);
  await connection.close();
  assert.equal(finished, true);
});

test("a close timeout or error stays rejected until late helper exit confirms native session release without replay", async () => {
  for (const options of [{ deferClose: true }, { deferClose: true, closeError: true }]) {
    const f = fixture(options);
    const connection = await f.adapter.connect();
    await connection.callTool("computer_discover", {});
    const closing = connection.close();
    let failure;
    await assert.rejects(closing, (error) => {
      failure = error;
      assert.match(error.message, /native session release could not be confirmed/);
      return true;
    });
    await assert.rejects(connection.close(), (error) => error === failure);
    assert.equal(f.connections[0].closeCount, 1);
    assert.equal(f.calls.length, 1);
    f.connections[0].onclose();
    await connection.close();
    await connection.close();
    await assert.rejects(closing, (error) => error === failure, "the original failure is not rewritten by a later exit");
    await assert.rejects(connection.callTool("computer_discover", {}), /closed/);
    assert.equal(f.connections[0].closeCount, 1, "no replay of native shutdown");
    assert.equal(f.connections.length, 1);
    assert.equal(f.calls.length, 1, "no tool replay or synthetic session-close call");
    assert.equal(f.spawned.length, 1, "no extra helper process");
  }
});

test("an independently confirmed helper exit already guarantees native session release", async () => {
  const f = fixture();
  const connection = await f.adapter.connect();
  f.connections[0].onclose();
  await connection.close();
  assert.equal(f.connections[0].closeCount, 0);
  assert.equal(f.calls.length, 0);
  await assert.rejects(connection.callTool("computer_discover", {}), /closed/);
});

test("pre-aborted calls do not dispatch; active aborts and deadlines cancel and close without retry", async () => {
  const f = fixture({ call: () => new Promise(() => {}) });
  const connection = await f.adapter.connect();
  await assert.rejects(connection.callTool("computer_discover", {}, { signal: AbortSignal.abort() }), /abort/i);
  assert.equal(f.calls.length, 0);
  assert.equal(f.connections[0].closeCount, 0);
  const controller = new AbortController();
  const pending = connection.callTool("computer_act", { session_id: "s1" }, { signal: controller.signal });
  const rejected = assert.rejects(pending, /stop/);
  await delay(1);
  await assert.rejects(connection.callTool("computer_discover", {}), /sequential/);
  controller.abort(new Error("stop"));
  await rejected;
  assert.equal(f.calls[0].options.signal.aborted, true);
  assert.equal(f.connections[0].closeCount, 1);
  assert.equal(f.calls.length, 1);

  const timed = fixture({ call: () => new Promise(() => {}) });
  const other = await timed.adapter.connect();
  await assert.rejects(other.callTool("computer_discover", {}, { timeoutMs: 5 }), /timed out/);
  assert.equal(timed.calls[0].options.signal.aborted, true);
  assert.equal(timed.connections[0].closeCount, 1);
});

test("closing an active call cancels it and preserves cleanup failures", async () => {
  const f = fixture({ call: () => new Promise(() => {}), deferClose: true });
  const connection = await f.adapter.connect();
  const pending = connection.callTool("computer_discover", {});
  const rejected = assert.rejects(pending, /native session release could not be confirmed/);
  await delay(1);
  await assert.rejects(connection.close(), /native session release could not be confirmed/);
  await rejected;
  assert.equal(f.calls[0].options.signal.aborted, true);
});

test("packaging keeps the shared bundle identity and checks the actual builder CPU before signing", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "coworker-computer-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const helper = path.join(root, "Open Coworker.app", "Contents", "Resources", "helpers", "OpenWork Computer Use.app");
  const executable = path.join(helper, "Contents", "MacOS", "ComputerUse");
  const context = { electronPlatformName: "darwin", arch: 3, appOutDir: root, packager: { appInfo: { productFilename: "Open Coworker" } } };
  const invocations = [];
  const runNative = (command, args, options) => { invocations.push({ command, args, options }); return { status: 0 }; };
  assert.throws(() => afterPack(context, { runNative }), /Missing packaged/);
  mkdirSync(path.dirname(executable), { recursive: true });
  writeFileSync(executable, "inert fixture; never executed");
  const plist = path.join(helper, "Contents", "Info.plist");
  writeFileSync(plist, "<key>CFBundleIdentifier</key><string>com.differentai.openwork.computer-use</string>");
  for (const [arch, expected] of [[1, ["x86_64"]], [3, ["arm64"]], [4, ["x86_64", "arm64"]], ["x64", ["x86_64"]], ["arm64", ["arm64"]], ["universal", ["x86_64", "arm64"]]]) {
    afterPack({ ...context, arch }, { runNative });
    const [cpu, signature] = invocations.slice(-2);
    assert.equal(cpu.command, "/usr/bin/lipo");
    assert.deepEqual(cpu.args, [executable, "-verify_arch", ...expected]);
    assert.equal(cpu.options.timeout, 10_000);
    assert.equal(signature.command, "/usr/bin/codesign");
    assert.deepEqual(signature.args, ["--verify", "--deep", "--strict", helper]);
  }
  assert.throws(() => afterPack({ ...context, arch: 0 }, { runNative }), /does not support/);
  let signatureAttempted = false;
  assert.throws(() => afterPack(context, { runNative: (command) => {
    if (command === "/usr/bin/codesign") signatureAttempted = true;
    return { status: 1 };
  } }), /does not contain arm64/);
  assert.equal(signatureAttempted, false);
  assert.throws(() => afterPack(context, { runNative: (command) => ({ status: command === "/usr/bin/codesign" ? 1 : 0 }) }), /signature is invalid/);
  writeFileSync(plist, "<key>CFBundleIdentifier</key><string>com.differentai.opencoworker</string>");
  assert.throws(() => afterPack(context, { runNative }), /retain its shared native bundle identity/);
  assert.doesNotThrow(() => afterPack({ electronPlatformName: "linux" }, { runNative: () => assert.fail("not a Mac package") }));
});

test("shared afterSign retains Coworker's opt-in, credentials, notarization and retry semantics without weakening helper checks", async () => {
  const credentials = { MACOS_NOTARIZE: "true", APPLE_API_KEY_PATH: "/fixture/key.p8", APPLE_API_KEY: "fixture-key-id", APPLE_API_ISSUER: "fixture-issuer" };
  const context = { electronPlatformName: "darwin", appOutDir: "/fixture/package", packager: { appInfo: { productFilename: "Open Coworker" } } };
  const appPath = "/fixture/package/Open Coworker.app";
  const archive = "/fixture/notary/Open Coworker-notary.zip";
  function loadHook(relative, { env = credentials, adhoc = false, submitStatus = 0, stapleFailures = 0 } = {}) {
    const commands = [];
    const waits = [];
    const removed = [];
    let stapleAttempts = 0;
    const modules = {
      "node:path": path,
      "node:os": { tmpdir: () => "/fixture" },
      "node:fs": { existsSync: () => true, mkdtempSync: () => "/fixture/notary", rmSync: (target) => removed.push(target) },
      "node:child_process": { spawnSync(command, args) {
        commands.push({ command, args: [...args] });
        if (command === "codesign") return { status: 0, stderr: adhoc ? "Signature=adhoc" : "Authority=Developer ID Application: Fixture" };
        if (args[0] === "notarytool") return { status: submitStatus };
        if (args[0] === "stapler" && args[1] === "staple") return { status: stapleAttempts++ < stapleFailures ? 65 : 0 };
        return { status: 0 };
      } },
    };
    const module = { exports: {} };
    runInNewContext(readFileSync(new URL(relative, import.meta.url), "utf8"), {
      module, process: { env }, console: { warn() {} },
      require(name) { assert.ok(Object.hasOwn(modules, name), `Unexpected hook dependency: ${name}`); return modules[name]; },
      setTimeout(callback, ms) { waits.push(ms); queueMicrotask(callback); },
    });
    return { run: module.exports, commands, waits, removed };
  }
  for (const file of ["../scripts/electron-after-sign.cjs", "../../desktop/scripts/electron-after-sign.cjs"]) {
    for (const enabled of [undefined, "false", "TRUE"]) {
      const hook = loadHook(file, { env: { ...credentials, MACOS_NOTARIZE: enabled } });
      await hook.run(context);
      assert.deepEqual(hook.commands, []);
    }
    const nonMac = loadHook(file);
    await nonMac.run({ ...context, electronPlatformName: "linux" });
    assert.deepEqual(nonMac.commands, []);
    for (const key of ["APPLE_API_KEY_PATH", "APPLE_API_KEY", "APPLE_API_ISSUER"]) {
      const hook = loadHook(file, { env: { ...credentials, [key]: undefined } });
      await assert.rejects(hook.run(context), new RegExp(`${key} is required`));
      assert.ok(hook.commands.every(({ command }) => command === "codesign"), "missing credentials must never submit to Apple");
    }
    const success = loadHook(file, { stapleFailures: 1 });
    await success.run(context);
    assert.deepEqual(success.commands.filter(({ command }) => command !== "codesign"), [
      { command: "ditto", args: ["-c", "-k", "--keepParent", appPath, archive] },
      { command: "xcrun", args: ["notarytool", "submit", archive, "--key", credentials.APPLE_API_KEY_PATH, "--key-id", credentials.APPLE_API_KEY, "--issuer", credentials.APPLE_API_ISSUER, "--wait"] },
      { command: "xcrun", args: ["stapler", "staple", appPath] },
      { command: "xcrun", args: ["stapler", "staple", appPath] },
      { command: "xcrun", args: ["stapler", "validate", appPath] },
    ]);
    assert.deepEqual(success.waits, [30_000]);
    assert.deepEqual(success.removed, ["/fixture/notary"]);
    const failed = loadHook(file, { submitStatus: 1 });
    await assert.rejects(failed.run(context), /notarytool.*failed/);
    assert.deepEqual(failed.removed, ["/fixture/notary"]);
    const exhausted = loadHook(file, { stapleFailures: 5 });
    await assert.rejects(exhausted.run(context), /after 5 attempts/);
    assert.deepEqual(exhausted.waits, [30_000, 60_000, 90_000, 120_000]);
    assert.deepEqual(exhausted.removed, ["/fixture/notary"]);
  }
  const unsignedHelper = loadHook("../../desktop/scripts/electron-after-sign.cjs", { adhoc: true });
  await assert.rejects(unsignedHelper.run(context), /ad-hoc signed/);
  assert.ok(unsignedHelper.commands.every(({ command }) => command === "codesign"));
});
