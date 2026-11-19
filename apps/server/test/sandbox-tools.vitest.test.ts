import assert from "node:assert/strict";
import { test } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { createFakeProvider } from "../../../packages/sandbox/src/testing/fake-provider.js";
import type { RunSpec, SandboxHandle } from "@openwork/sandbox";
import { createSandboxToolHost, SANDBOX_OUTPUT_BYTES, SANDBOX_TOOL_NAMES, sandboxGuestPath } from "../src/sandbox-tool-host.js";
import sandboxPlugin, { setupSandboxTools, type HostNativeTool, type SandboxPluginContext, type SandboxToolMode } from "../src/opencode-plugins/openwork-sandbox-v2.js";
import { providerSchemaProblems } from "../src/opencode-plugins/provider-safe-tool-schema.js";

const call = () => ({ sessionID: "session-test", id: "call-test", signal: new AbortController().signal });
async function hostFixture() {
  const commands: RunSpec[] = [];
  const operations: string[] = [];
  const provider = createFakeProvider({ onOperation(operation) { operations.push(operation.name); }, onRun(spec) { commands.push(spec); return { stdout: "guest result", stderr: "", exitCode: 0 }; } });
  const handle = await provider.create({ idempotencyKey: "sandbox-tools-test", image: null, labels: {}, env: {}, storage: [], exposePorts: [] }, { timeoutMs: 1000 });
  let acquisitions = 0;
  const host = createSandboxToolHost({ provider, cwd: "/workspace", acquire: async () => { acquisitions += 1; return handle; } });
  return { provider, handle, host, commands, operations, acquisitions: () => acquisitions };
}
const output = (result: Awaited<ReturnType<ReturnType<typeof createSandboxToolHost>["execute"]>>) => result.content.map(item => item.text).join("");

test("guest path validation rejects host-style and non-canonical paths", () => {
  for (const path of ["relative", "../secret", "/work/../secret", "/work/./a", "/a//b", "//host/a", "/a/", "C:\\secret", "/a\\b", "/a\nnext", "/a\0b"]) assert.throws(() => sandboxGuestPath(path));
  for (const path of ["/", "/workspace", "/workspace/a 'quoted' $file"]) assert.equal(sandboxGuestPath(path), path);
});

test("invalid inputs and missing provider blocks never acquire compute or fall back", async () => {
  const fixture = await hostFixture();
  await assert.rejects(fixture.host.execute("read", { path: "/work/../secret" }), /absolute guest path/);
  await assert.rejects(fixture.host.execute("write", { path: "/a", filePath: "/b", content: "x" }), /must agree/);
  await assert.rejects(fixture.host.execute("shell", { command: "x".repeat(32_001) }));
  await assert.rejects(fixture.host.execute("not-a-tool", {}));
  assert.equal(fixture.acquisitions(), 0);
  const provider = { ...fixture.provider, blocks: {} };
  const host = createSandboxToolHost({ provider, cwd: "/", acquire: async () => { throw new Error("must not acquire"); } });
  await assert.rejects(host.execute("read", { path: "/a" }), /The sandbox can't open files right now\. Nothing ran on this computer\./);
  await assert.rejects(host.execute("shell", { command: "pwd" }), /The sandbox can't run commands right now\. Nothing ran on this computer\./);
  assert.equal(fixture.provider.fake.count("exec"), 0);
});

test("guest files support UTF-8 read/write and exact non-overlapping edit", async () => {
  const { host, provider, operations } = await hostFixture();
  await host.execute("write", { filePath: "/workspace/a", content: "hello 🌍\nhello 🌍\n" });
  assert.match(output(await host.execute("read", { path: "/workspace/a", offset: 2, limit: 1 })), /^2: hello 🌍/u);
  await assert.rejects(host.execute("edit", { path: "/workspace/a", oldString: "hello", newString: "hi" }), /ambiguous/);
  await assert.rejects(host.execute("edit", { path: "/workspace/a", oldString: "absent", newString: "hi" }), /not found/);
  await assert.rejects(host.execute("edit", { path: "/workspace/a", oldString: "hello", newString: "hello" }), /must differ/);
  assert.match(output(await host.execute("edit", { path: "/workspace/a", oldString: "hello", newString: "$&hi", replaceAll: true })), /Replaced 2/);
  assert.match(output(await host.execute("read", { path: "/workspace/a" })), /\$&hi 🌍/u);
  assert.equal(provider.fake.count("run"), 0);
  assert.equal(provider.fake.count("exec"), 0);
  assert.equal(operations.filter(name => name === "files.write").length, 2);
  assert.equal(operations.filter(name => name === "run" || name === "exec").length, 0);
});

test("oversized, binary and invalid UTF-8 guest files are refused before editing", async () => {
  const { host, provider, handle } = await hostFixture();
  assert.ok(provider.blocks?.files);
  for (const [path, bytes] of new Map([["/large", new Uint8Array(128_001)], ["/binary", new Uint8Array([65, 0, 66])], ["/invalid", new Uint8Array([255])]])) {
    await provider.blocks.files.write(handle, path, bytes, { timeoutMs: 1000 });
    await assert.rejects(host.execute("read", { path }));
  }
});

test("shell calls only run block with explicit guest cwd and bounded results", async () => {
  const { host, commands, provider, handle } = await hostFixture();
  await host.execute("shell", { command: "printf guest", timeoutMs: 123 });
  assert.deepEqual(commands[0], { command: "printf guest", shell: "sh", cwd: "/workspace", timeoutMs: 123 });
  const largeProvider = { ...provider, blocks: { run: async () => ({ stdout: "x".repeat(100_000), stderr: "problem", exitCode: 7 }) } };
  const largeHost = createSandboxToolHost({ provider: largeProvider, cwd: "/", acquire: async () => handle });
  const result = await largeHost.execute("shell", { command: "print large" });
  assert.equal(result.metadata.truncated, true);
  assert.equal(result.metadata.exitCode, 7);
  assert.ok(new TextEncoder().encode(output(result)).length <= SANDBOX_OUTPUT_BYTES);
  assert.match(output(result), /truncated/);
  assert.equal(provider.fake.count("exec"), 0);
});

test("glob and grep quote every model-controlled argument for guest sh", async () => {
  const { host, commands } = await hostFixture();
  await host.execute("glob", { path: "/workspace/it's $guest", pattern: "**/*.ts" });
  await host.execute("grep", { path: "/workspace", pattern: "'; touch /pwned; #", literal: true, include: "*.ts" });
  assert.match(commands[0]?.command ?? "", /find '\/workspace\/it'"'"'s \$guest'/);
  assert.match(commands[1]?.command ?? "", /-e ''"'"'; touch \/pwned; #'/);
  assert.match(commands[1]?.command ?? "", /-name '\*\.ts'/);
  for (const spec of commands) { assert.equal(spec.shell, "sh"); assert.match(spec.command, /head -c 32001/); }
  await assert.rejects(host.execute("glob", { pattern: "../secret" }), /relative guest glob/);
  await assert.rejects(host.execute("grep", { pattern: "a\nb" }), /single-line/);
});

test("wrong-provider, stopped and aborted handles never execute guest effects", async () => {
  const { provider, handle } = await hostFixture();
  const wrong: SandboxHandle = { ...handle, ref: { ...handle.ref, providerId: "different" } };
  const stopped: SandboxHandle = { ...handle, state: "stopped" };
  for (const invalid of [wrong, stopped]) {
    const host = createSandboxToolHost({ provider, cwd: "/", acquire: async () => invalid });
    await assert.rejects(host.execute("shell", { command: "pwd" }), /configured provider/);
  }
  const abort = new AbortController(); abort.abort();
  const host = createSandboxToolHost({ provider, cwd: "/", acquire: async () => { throw new Error("must not acquire"); } });
  await assert.rejects(host.execute("shell", { command: "pwd" }, { sessionID: "s", signal: abort.signal }), /abort/i);
  assert.equal(provider.fake.count("run"), 0);
});

async function pluginFixture(initial: SandboxToolMode, projectConfigDisabled?: boolean) {
  let mode = initial;
  let prompt: (() => Promise<void>) | undefined;
  const inference = new Map<string, (event: { tools: Record<string, unknown>; system: { text: string }[] }) => Promise<void>>();
  let transform: Parameters<SandboxPluginContext["tool"]["transform"]>[0] | undefined;
  let reloads = 0;
  let executions = 0;
  let disposed = 0;
  let statusFailed = false;
  const tools = new Map<string, HostNativeTool>();
  const builtins = new Set<string>();
  const render = () => {
    tools.clear(); builtins.clear();
    for (const name of [...SANDBOX_TOOL_NAMES, "browser", "mcp_host_tool"]) builtins.add(name);
    transform?.({ list: () => [...builtins].map(id => ({ id, name: id, description: "host fixture", input: {}, options: { codemode: true }, execute: async () => ({ content: [{ type: "text", text: "host fixture" }] }) })), remove: id => { builtins.delete(id); }, add: tool => {
      if (mode !== "only" && !tool.name.startsWith("sandbox_")) builtins.add(tool.name);
      else tools.set(tool.name, tool);
    } });
  };
  const context: SandboxPluginContext = {
    options: {},
    tool: { async transform(callback) { transform = callback; render(); return { async dispose() { disposed += 1; tools.clear(); } }; }, async reload() { reloads += 1; render(); }, async hook() { return { async dispose() {} }; } },
    mcp: { async transform() { return { async dispose() {} }; }, async reload() {} },
    session: { async hook(name, callback) { if (name === "prompt") prompt = callback; else inference.set(name, callback); return { async dispose() { disposed += 1; if (name === "prompt") prompt = undefined; else inference.delete(name); } }; } },
  };
  const stop = await setupSandboxTools(context, {
    projectConfigDisabled,
    async status() { if (statusFailed) throw new Error("status unavailable"); return mode; },
    async execute() { executions += 1; return { content: [{ type: "text", text: "sandbox only" }] }; },
  });
  return { tools, builtins, stop, context, inference, failStatus() { statusFailed = true; }, setMode(value: SandboxToolMode) { mode = value; }, async prompt() { await prompt?.(); }, reloads: () => reloads, executions: () => executions, disposed: () => disposed };
}

test("normal mode adds six provider-safe sandbox IDs without replacing host tools", async () => {
  const fixture = await pluginFixture("tools");
  try {
    assert.deepEqual([...fixture.tools.keys()], SANDBOX_TOOL_NAMES.map(name => `sandbox_${name}`));
    for (const name of SANDBOX_TOOL_NAMES) assert.ok(fixture.builtins.has(name));
    for (const tool of fixture.tools.values()) {
      assert.deepEqual(providerSchemaProblems(tool.input), []);
      assert.equal(tool.options?.codemode, false, "guest tools are directly callable without Code Mode");
    }
    const tool = fixture.tools.get("sandbox_shell"); assert.ok(tool);
    await tool.execute({ command: "pwd" }, call());
    assert.equal(fixture.executions(), 1);
    fixture.setMode("off");
    await tool.execute({ command: "pwd" }, call());
    assert.equal(fixture.executions(), 2);
    await fixture.prompt();
    assert.equal(fixture.reloads(), 1);
    assert.equal(fixture.tools.size, 0);
  } finally { await fixture.stop(); }
  assert.equal(fixture.disposed(), 5);
});

test("only mode replaces six primitive IDs and default-denies all other host tools", async () => {
  const fixture = await pluginFixture("only");
  try {
    assert.deepEqual([...fixture.tools.keys()], [...SANDBOX_TOOL_NAMES]);
    for (const name of SANDBOX_TOOL_NAMES) assert.equal(fixture.builtins.has(name), false);
    assert.equal(fixture.builtins.has("browser"), false);
    assert.equal(fixture.builtins.has("mcp_host_tool"), false);
    for (const tool of fixture.tools.values()) assert.equal(tool.options?.codemode, false);
    const tool = fixture.tools.get("shell"); assert.ok(tool);
    await tool.execute({ command: "pwd" }, call());
    fixture.setMode("tools");
    await tool.execute({ command: "pwd" }, call());
    assert.equal(fixture.executions(), 2);
    await fixture.prompt();
    assert.ok(fixture.tools.has("sandbox_shell"));
    assert.ok(fixture.builtins.has("shell"));
  } finally { await fixture.stop(); }
});

test("required mode refuses an engine started with writable project-plugin discovery, including live transitions", async () => {
  for (const initial of ["tools", "only"] satisfies SandboxToolMode[]) {
    const fixture = await pluginFixture(initial, false);
    try {
      fixture.setMode("only");
      await assert.rejects(fixture.prompt(), /Restart OpenWork to apply your sandbox setting/);
      const shell = fixture.tools.get(initial === "only" ? "shell" : "sandbox_shell"); assert.ok(shell);
      await assert.rejects(shell.execute({ command: "touch /host-plugin-sentinel" }, call()), /Restart OpenWork to apply your sandbox setting/);
      assert.equal(fixture.executions(), 0);
    } finally { await fixture.stop(); }
  }
});

test("off mode can be enabled on a prompt and disposed tools fail closed", async () => {
  const fixture = await pluginFixture("off");
  assert.equal(fixture.tools.size, 0);
  fixture.setMode("tools"); await fixture.prompt();
  const tool = fixture.tools.get("sandbox_read"); assert.ok(tool);
  await fixture.stop();
  await assert.rejects(tool.execute({ path: "/guest" }, call()), /closed/);
});

test("status outages withhold additive tools without breaking prompts, and never restore host primitives in only mode", async () => {
  for (const mode of ["tools", "only"] satisfies SandboxToolMode[]) {
    const fixture = await pluginFixture(mode);
    try {
      fixture.failStatus();
      await fixture.prompt();
      if (mode === "tools") assert.equal(fixture.tools.size, 0);
      else {
        assert.equal(fixture.builtins.has("shell"), false);
        const shell = fixture.tools.get("shell"); assert.ok(shell);
        await assert.rejects(shell.execute({ command: "pwd" }, call()), /status unavailable/);
      }
    } finally { await fixture.stop(); }
  }
});

test("a status error mid-turn keeps the last known inference catalog", async () => {
  for (const mode of ["off", "tools", "only"] satisfies SandboxToolMode[]) {
    const fixture = await pluginFixture(mode);
    try {
      fixture.failStatus();
      assert.equal(fixture.inference.size, 3);
      for (const hook of fixture.inference.values()) {
        const event = { tools: { execute: {} }, system: [] };
        await hook(event);
        assert.deepEqual(Object.keys(event.tools), mode === "only" ? [...SANDBOX_TOOL_NAMES] : ["execute"]);
      }
    } finally { await fixture.stop(); }
  }
});

test("default bridge uses trusted envelopes, checks status per call and never falls back after failure", async () => {
  const bodies: unknown[] = [];
  const authorizations: (string | undefined)[] = [];
  let mode: SandboxToolMode = "tools";
  let failing = false;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body: unknown = JSON.parse(raw);
    bodies.push(body); authorizations.push(request.headers.authorization);
    response.setHeader("Content-Type", "application/json");
    if (failing) { response.writeHead(503); response.end("{}"); return; }
    response.end(JSON.stringify(typeof body === "object" && body !== null && "operation" in body && body.operation === "status"
      ? { mode } : { content: [{ type: "text", text: "guest bridge result" }] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const fixture = await pluginFixture("off");
  let stop: (() => Promise<void>) | undefined;
  try {
    stop = await sandboxPlugin.setup({ ...fixture.context, options: { url: `http://127.0.0.1:${address.port}/sandbox`, token: "test-token" }, location: { directory: "/trusted/engine-directory" } });
    const tool = fixture.tools.get("sandbox_shell"); assert.ok(tool);
    await tool.execute({ command: "pwd" }, call());
    assert.deepEqual(bodies, [
      { operation: "status", directory: "/trusted/engine-directory" },
      { operation: "status", directory: "/trusted/engine-directory" },
      { operation: "execute", directory: "/trusted/engine-directory", name: "shell", input: { command: "pwd" }, sessionId: "session-test", callId: "call-test" },
    ]);
    assert.ok(authorizations.every(value => value === "Bearer test-token"));
    failing = true;
    await assert.rejects(tool.execute({ command: "pwd" }, call()), /The sandbox request failed/);
    assert.equal(bodies.length, 4, "failed status must not send an execute request");
    failing = false; mode = "off";
    await tool.execute({ command: "pwd" }, call());
  } finally {
    await stop?.(); await fixture.stop();
    server.close(); await once(server, "close");
  }
});

test("default bridge plugin rejects non-loopback endpoints before network access", async () => {
  const fixture = await pluginFixture("off");
  try {
    await assert.rejects(sandboxPlugin.setup({ ...fixture.context, options: { url: "https://example.com/bridge", token: "secret" }, location: { directory: "/trusted" } }), /couldn’t connect to the sandbox on this computer/);
  } finally { await fixture.stop(); }
});
