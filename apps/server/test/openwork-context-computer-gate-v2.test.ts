import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import nativeContext from "../src/opencode-plugins/openwork-context-v2.js";
import { computerToolsOffered } from "../src/opencode-plugins/openwork-computer-use.js";

type Answer = (path: string) => { status: number; body: unknown };

async function listen(answer: Answer) {
  const server: Server = createServer((request, response) => {
    const { status, body } = answer(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

async function register(browserUrl: string, reloadable: boolean) {
  const names = new Set<string>();
  let callback: ((editor: { add(tool: { name: string }): void }) => void) | undefined;
  let prompt: (() => void | Promise<void>) | undefined;
  const apply = () => { names.clear(); callback?.({ add: tool => names.add(tool.name) }); };
  const stop = await nativeContext.setup({
    options: { url: "http://127.0.0.1:9/read", token: "read", browser: { url: `${browserUrl}/browser`, token: "browser" } },
    tool: {
      async transform(next) { callback = next; apply(); return { async dispose() { names.clear(); } }; },
      ...(reloadable ? { async reload() { apply(); } } : {}),
    },
    session: { async hook(_name, next) { prompt = next as () => void; return { async dispose() {} }; } },
    skill: { async transform() { return { async dispose() {} }; }, async reload() {} },
  } as Parameters<typeof nativeContext.setup>[0]);
  const computer = () => [...names].filter(name => name.startsWith("computer_"));
  return { names, computer, prompt: async () => { await prompt?.(); }, stop };
}

test("computer tools are offered only while the desktop has computer use on", async () => {
  let offered = false;
  const bridge = await listen(path => path === "/computer" ? { status: 200, body: { offered } } : { status: 404, body: {} });
  const native = await register(bridge.url, true);
  try {
    assert.deepEqual(native.computer(), [], "flag off: the model never sees computer tools");
    assert.ok([...native.names].some(name => name.startsWith("browser_")), "browser tools are unaffected");

    offered = true;
    await native.prompt();
    assert.ok(native.computer().includes("computer_open"), "turning the flag on offers them from the next prompt");

    offered = false;
    await native.prompt();
    assert.deepEqual(native.computer(), [], "turning it off withdraws them again");
  } finally { await native.stop(); await bridge.close(); }
});

test("an engine without registry reload keeps computer tools offered", async () => {
  const bridge = await listen(() => ({ status: 200, body: { offered: false } }));
  const native = await register(bridge.url, false);
  try {
    assert.ok(native.computer().includes("computer_open"));
  } finally { await native.stop(); await bridge.close(); }
});

test("only an explicit desktop answer of off hides computer tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwork-computer-gate-"));
  const previous = process.env.OPENWORK_UI_CONTROL_DISCOVERY;
  let answer: { status: number; body: unknown } = { status: 200, body: { enabled: false } };
  const desktop = await listen(path => path === "/computer/enabled" ? answer : { status: 404, body: { ok: false } });
  try {
    const discovery = join(directory, "openwork-ui-control.json");
    await writeFile(discovery, JSON.stringify({ baseUrl: desktop.url, token: "desktop" }));
    process.env.OPENWORK_UI_CONTROL_DISCOVERY = discovery;
    assert.equal(await computerToolsOffered(), false);
    answer = { status: 200, body: { enabled: true } };
    assert.equal(await computerToolsOffered(), true);
    // A cloud worker's bridge has no such route: its tools stay as they were.
    answer = { status: 404, body: { ok: false } };
    assert.equal(await computerToolsOffered(), true);
  } finally {
    if (previous === undefined) delete process.env.OPENWORK_UI_CONTROL_DISCOVERY;
    else process.env.OPENWORK_UI_CONTROL_DISCOVERY = previous;
    await desktop.close();
    await rm(directory, { recursive: true, force: true });
  }
});
