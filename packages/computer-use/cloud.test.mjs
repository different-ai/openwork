import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createCloudComputer } from "./cloud.mjs";

test("renewed authority restores browser work without releasing a human takeover", async t => {
  const original = globalThis.WebSocket;
  class Wire extends EventTarget {
    constructor() { super(); setImmediate(() => this.dispatchEvent(new Event("open"))); }
    send(raw) { const { id } = JSON.parse(raw); setImmediate(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result: {} }) }))); }
    close() { this.dispatchEvent(new Event("close")); }
  }
  globalThis.WebSocket = Wire;
  const directory = await mkdtemp(join(tmpdir(), "cloud-renewal-"));
  const server = createServer((_request, response) => response.end(JSON.stringify([
    { id: "owned", type: "page", url: "https://example.com/", title: "Fixture", webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/page` },
  ])));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  await writeFile(join(directory, "browser-tabs.json"), JSON.stringify([["owned", "chat"]]));
  let allowed = true;
  const computer = await createCloudComputer({ directory, enabled: async () => allowed, browserEndpoint: `http://127.0.0.1:${server.address().port}`,
    machine: { run: async command => ({ exitCode: command.includes("command -v nft") ? 1 : 0, stdout: "missing:\ndisplay:ok", stderr: "" }), read: async () => new Uint8Array() } });
  t.after(async () => { await computer.close(); await new Promise(resolve => server.close(resolve)); globalThis.WebSocket = original; await rm(directory, { recursive: true, force: true }); });
  const tabs = () => computer.task("/browser/task", { sessionId: "chat", operation: "tabs", args: {} });
  assert.equal((await tabs()).tabs[0].status, "idle");
  allowed = false; await assert.rejects(computer.snapshot(), { code: "feature_disabled" });
  allowed = true; assert.equal((await tabs()).tabs[0].status, "idle");
  await computer.interact({ action: "takeover" });
  allowed = false; await assert.rejects(computer.snapshot(), { code: "feature_disabled" });
  allowed = true;
  await assert.rejects(tabs(), { code: "paused" });
  assert.equal((await computer.snapshot()).paused, true);
  await computer.interact({ action: "resume" });
  assert.equal((await tabs()).tabs[0].status, "idle");
});

test("cloud browser uses the installed native guard and fails closed when it changes", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-native-egress-"));
  const server = createServer((_request, response) => response.end("[]"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const ranges = {
    ip: ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16"],
    ip6: ["::/96", "::ffff:0.0.0.0/96", "64:ff9b::/96", "64:ff9b:1::/48", "fc00::/7", "fe80::/10"],
  };
  const rules = { nftables: [
    { chain: { family: "inet", table: "openwork_desktop", name: "output", type: "filter", hook: "output" } },
    ...Object.entries(ranges).map(([protocol, prefixes]) => ({ rule: {
      family: "inet", table: "openwork_desktop", chain: "output", expr: [
        { match: { op: "==", left: { meta: { key: "skuid" } }, right: 1001 } },
        { match: { op: "==", left: { payload: { protocol, field: "daddr" } }, right: { set: prefixes.map(prefix => {
          const [addr, len] = prefix.split("/"); return { prefix: { addr, len: Number(len) } };
        }) } } },
        { reject: { type: "icmpx", expr: 1 } },
      ],
    } })),
  ] };
  const commands = [];
  const computer = await createCloudComputer({ directory, enabled: async () => true, browserEndpoint: `http://127.0.0.1:${server.address().port}`,
    machine: { run: async command => {
      commands.push(command);
      return { exitCode: 0, stderr: "", stdout: command.startsWith("'id'") ? "1001\n" : command.startsWith("'nft'") ? JSON.stringify(rules) : "/usr/sbin/nft\n" };
    }, read: async () => new Uint8Array() } });
  t.after(async () => { await computer.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true }); });
  const tabs = () => computer.task("/browser/task", { sessionId: "chat", operation: "tabs", args: {} });
  assert.deepEqual((await tabs()).tabs, []);
  assert.ok(commands.some(command => command.startsWith("'nft' '-n' '-j'")));
  assert.equal(commands.some(command => command.includes("iptables")), false);
  rules.nftables.pop();
  await assert.rejects(tabs(), { code: "egress_unavailable" });
});

test("an unused cloud host loads before SDK build artifacts exist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-source-import-"));
  let computer;
  try {
    for (const name of await readdir(new URL("./", import.meta.url))) {
      if (name === "package.json" || name.endsWith(".mjs") && !name.endsWith(".test.mjs")) await cp(new URL(name, import.meta.url), join(directory, name));
    }
    const { createCloudComputer } = await import(pathToFileURL(join(directory, "cloud.mjs")).href);
    computer = await createCloudComputer({ directory: join(directory, "profile"), enabled: async () => false });
    await assert.rejects(computer.task("/computer/program", { sessionId:"chat", surface:"computer", code:"return true;" }), { code:"feature_disabled" });
  } finally { await computer?.close(); await rm(directory, { recursive:true, force:true }); }
});

async function fixture(t, applications) {
  let allowed = true;
  const commands = [];
  const requests = [];
  let screenRead = async () => ({ exitCode: 0, stdout: "1280 800", stderr: "" });
  const directory = await mkdtemp(join(tmpdir(), "cloud-computer-test-"));
  const computer = await createCloudComputer({ directory, enabled: async () => allowed, applications, machine: {
    async run(command) {
      commands.push(command);
      if (command.includes('echo "missing:')) return { exitCode: 0, stdout: "missing:\ndisplay:ok", stderr: "" };
      if (command.endsWith("xdotool getdisplaygeometry")) return screenRead();
      const rpc = command.match(/request = ("(?:\\.|[^"\\])*")/);
      if (rpc) {
        const request = JSON.parse(JSON.parse(rpc[1]));
        requests.push(request);
        return { exitCode: 0, stderr: "", stdout: JSON.stringify(request.operation === "observe" ? {elements:[],capability:"unavailable"} : {completed:request.steps?.length ?? 0,attempted:true}) };
      }
      if (command.includes("identify -format")) return { exitCode: 0, stdout: "1280 800", stderr: "" };
      if (command.includes("python3 -c")) return { exitCode: 0, stdout: "[]", stderr: "" };
      return { exitCode: 0, stdout: "done:0", stderr: "" };
    }, read: async () => new Uint8Array([137,80,78,71]),
  } });
  t.after(async () => { await computer.close(); await rm(directory, { recursive: true, force: true }); });
  return { computer, commands, requests, allow: value => { allowed = value; }, screen: read => { screenRead = read; } };
}

test("a disabled rollout grants neither agent tools, images nor human input", async t => {
  const f = await fixture(t); f.allow(false);
  await assert.rejects(f.computer.task("/browser/task", { sessionId: "a", operation: "tabs" }), { code: "feature_disabled" });
  await assert.rejects(f.computer.task("/computer/program", {sessionId:"a",surface:"computer",code:"return true;"}), {code:"feature_disabled"});
  await assert.rejects(f.computer.frame(), { code: "feature_disabled" });
  await assert.rejects(f.computer.interact({ action: "takeover" }), { code: "feature_disabled" });
  assert.deepEqual(f.commands, []);
});
test("enabled computer discovery works immediately without a consent request", async t => {
  const f = await fixture(t);
  const result = await f.computer.task("/computer/task", { sessionId: "a", name: "computer_discover", args: {} });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok(f.commands.length > 0);
});
test("human input requires takeover and the exact current view generation", async t => {
  const f = await fixture(t);
  await assert.rejects(f.computer.interact({ type: "type", text: "hello", generation: 0 }), { code: "view_changed" });
  await f.computer.interact({ action: "takeover" });
  const frame = await f.computer.frame();
  await assert.rejects(f.computer.interact({ type: "click", x: 1280, y: 20, generation: frame.generation }), { code: "invalid_point" });
  await f.computer.interact({ type: "type", text: "hello", generation: frame.generation });
  assert.ok(f.requests.some(request => request.operation === "input" && request.steps.some(step => step.type === "type")));
  await f.computer.interact({ action: "resume" });
  await f.computer.interact({ action: "takeover" });
  await assert.rejects(f.computer.interact({ type: "type", text: "stale", generation: frame.generation }), { code: "view_changed" });
});
test("Continue during a delayed human input check cannot dispatch the old input", async t => {
  const f = await fixture(t);
  await f.computer.interact({ action: "takeover" });
  const frame = await f.computer.frame();
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let arrived;
  const checked = new Promise(resolve => { arrived = resolve; });
  f.screen(async () => { arrived(); await waiting; return { exitCode: 0, stdout: "1280 800", stderr: "" }; });
  const input = f.computer.interact({ type: "type", text: "stale", generation: frame.generation });
  await checked;
  await f.computer.interact({ action: "resume" });
  release();
  await assert.rejects(input, { code: "view_changed" });
  assert.ok(!f.requests.some(request => request.operation === "input" && request.steps.some(step => step.type === "type")));
});
test("the model cannot resume a human takeover through either tool family", async t => {
  const f = await fixture(t);
  await f.computer.interact({ action: "takeover" });
  for (const path of ["/computer/task", "/browser/task"]) await assert.rejects(f.computer.task(path, { sessionId: "a", name: "computer_discover", operation: "tabs" }), { code: "paused" });
});

test("application launches respect rollout revocation and human takeover", async t => {
  const launches = [];
  const f = await fixture(t, { list: async () => ({ apps: [] }), launch: async args => { launches.push(args.app); return { launched: true }; } });
  const launch = () => f.computer.task("/computer/task", { sessionId: "a", name: "computer_launch", args: { app: "blender" } });
  f.allow(false);
  await assert.rejects(launch(), { code: "feature_disabled" });
  f.allow(true);
  await f.computer.interact({ action: "takeover" });
  await assert.rejects(launch(), { code: "paused" });
  assert.deepEqual(launches, []);
  await f.computer.interact({ action: "resume" });
  await launch();
  assert.deepEqual(launches, ["blender"]);
});

test("application script errors retain the tool error flag", async t => {
  const f = await fixture(t, { script: async () => ({ ok: false, error: "No document is open" }) });
  const result = await f.computer.task("/computer/task", { sessionId: "a", name: "computer_app_script", args: { app: "writer" } });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).ok, false);
});

test("takeover waits for the application to acknowledge stopping", async t => {
  let arrived, aborted, finish;
  const started = new Promise(resolve => { arrived = resolve; });
  const cancelled = new Promise(resolve => { aborted = resolve; });
  const done = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, { script: async (_args, signal) => {
    arrived(); signal.addEventListener("abort", aborted, { once: true });
    await done; signal.throwIfAborted(); return { ok: true };
  } });
  const script = f.computer.task("/computer/task", { sessionId: "a", name: "computer_app_script", args: {} });
  const rejected = assert.rejects(script);
  await started;
  let taken = false;
  const takeover = f.computer.interact({ action: "takeover" }).then(() => { taken = true; });
  await cancelled; await new Promise(resolve => setImmediate(resolve));
  assert.equal(taken, false);
  assert.equal((await f.computer.snapshot()).busy, true);
  finish(); await takeover; await rejected;
  assert.equal((await f.computer.snapshot()).busy, false);
});

test("taking control cancels an app launch waiting on discovery", async t => {
  let arrived;
  const checked = new Promise(resolve => { arrived = resolve; });
  let aborted = false;
  const f = await fixture(t, { list: async () => ({}), launch: async (_args, signal) => {
    arrived();
    await new Promise(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    signal.throwIfAborted();
  } });
  const launched = f.computer.task("/computer/task", { sessionId: "a", name: "computer_launch", args: { app: "blender" } });
  const rejected = assert.rejects(launched);
  await checked;
  await f.computer.interact({ action: "takeover" });
  await rejected;
  assert.equal(aborted, true);
});


test("cloud programs use the shared input rail and validate their surface", async t => {
  const f = await fixture(t);
  await assert.rejects(f.computer.task("/computer/program", { sessionId:"a", surface:"shell", code:"return true;" }), {code:"invalid_arguments"});
  const result = await f.computer.task("/computer/program", {sessionId:"a",surface:"computer",code:"return input.value + 1;",input:{value:41}});
  assert.equal(result.ok, true);
  assert.equal(result.value, 42);
  await f.computer.interact({action:"takeover"});
  await assert.rejects(f.computer.task("/computer/program", {sessionId:"a",surface:"computer",code:"return true;"}), {code:"paused"});
});
