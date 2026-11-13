import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import nativeContext from "../src/opencode-plugins/openwork-context-v2.js";

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

test("computer tools stay available without a rollout lookup", async () => {
  let offered = false;
  const bridge = await listen(path => path === "/computer" ? { status: 200, body: { offered } } : { status: 404, body: {} });
  const native = await register(bridge.url, true);
  try {
    assert.ok(native.computer().includes("computer_open"));
    assert.ok([...native.names].some(name => name.startsWith("browser_")), "browser tools are unaffected");

    offered = true;
    await native.prompt();
    assert.ok(native.computer().includes("computer_open"), "turning the flag on offers them from the next prompt");

    offered = false;
    await native.prompt();
    assert.ok(native.computer().includes("computer_open"));
  } finally { await native.stop(); await bridge.close(); }
});

test("an engine without registry reload keeps computer tools offered", async () => {
  const bridge = await listen(() => ({ status: 200, body: { offered: false } }));
  const native = await register(bridge.url, false);
  try {
    assert.ok(native.computer().includes("computer_open"));
  } finally { await native.stop(); await bridge.close(); }
});


test("a subagent's computer calls name the chat that started it and the subagent, from the engine's session tree", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  let parallel = true;
  const server: Server = createServer((request, response) => {
    let data = "";
    request.on("data", chunk => { data += chunk; });
    request.on("end", () => {
      if (request.method === "POST") bodies.push(JSON.parse(data));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(request.method === "POST" ? { content: [{ type: "text", text: "{}" }] } : { offered: true, parallel }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  type Bridged = { name: string; description: string; execute(input: unknown, call: { sessionID: string; signal: AbortSignal; agent?: string }): Promise<unknown> };
  const tools = new Map<string, Bridged>();
  const parents: Record<string, string | undefined> = { "maps-agent": "chat", nested: "maps-agent", untitled: "chat", "fresh-agent": "chat" };
  const titles: Record<string, string | undefined> = { "maps-agent": "Maps", nested: "Place the photo" };
  let prompt: (() => Promise<void>) | undefined;
  let apply = () => {};
  const stop = await nativeContext.setup({
    options: { url: "http://127.0.0.1:9/read", token: "read", browser: { url: `http://127.0.0.1:${address.port}/browser`, token: "browser" } },
    tool: {
      async transform(next) { apply = () => next({ add: tool => tools.set(tool.name, tool as unknown as Bridged) }); apply(); return { async dispose() {} }; },
      async reload() { apply(); },
    },
    session: { async hook(_name: string, next: () => Promise<void>) { prompt = next; return { async dispose() {} }; }, async get({ sessionID }: { sessionID: string }) { return { parentID: parents[sessionID], title: titles[sessionID] }; } },
    skill: { async transform() { return { async dispose() {} }; }, async reload() {} },
  } as unknown as Parameters<typeof nativeContext.setup>[0]);
  try {
    const status = tools.get("computer_status");
    assert.ok(status);
    assert.match(tools.get("computer_open")?.description ?? "", /give each app to its own subagent/, "the guidance on app agents comes with the feature");
    for (const sessionID of ["nested", "maps-agent", "untitled", "chat"]) await status.execute({}, { sessionID, agent: "general", signal: new AbortController().signal });
    assert.deepEqual(bodies.map(body => [body.sessionId, body.rootSessionId, body.agentName]),
      [["nested", "chat", "Place the photo"], ["maps-agent", "chat", "Maps"], ["untitled", "chat", "general"], ["chat", undefined, undefined]],
      "a subagent's cursor name is its description, else its agent's name; the chat's own calls name none");

  } finally { await stop(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
