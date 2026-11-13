import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createV2ContextBridge } from "../src/opencode-v2-context-bridge.js";
import nativeContext from "../src/opencode-plugins/openwork-context-v2.js";

/** The engine's form, prompt and event routes. */
async function fakeEngine() {
  const forms: Array<{ query: string; body: Record<string, unknown> }> = [];
  const prompts: Array<{ query: string; body: Record<string, unknown> }> = [];
  const streams = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.headers.authorization !== `Basic ${Buffer.from("opencode:secret").toString("base64")}`) return void response.writeHead(401).end();
    if (request.method === "GET" && url.pathname === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`);
      streams.add(response);
      request.on("close", () => streams.delete(response));
      return;
    }
    let text = "";
    request.on("data", chunk => { text += chunk; });
    request.on("end", () => {
      const entry = { query: url.search, body: JSON.parse(text) };
      if (url.pathname === "/api/session/ses_one/form") forms.push(entry);
      else if (url.pathname === "/api/session/ses_one/prompt") prompts.push(entry);
      else return void response.writeHead(404).end();
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { id: "frm_one" } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    forms, prompts, connection: { url: `http://127.0.0.1:${port}`, username: "opencode", password: "secret" },
    emit: (event: unknown) => { for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`); },
    close: () => { for (const stream of streams) stream.end(); return new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 50));

async function ask(engine: Awaited<ReturnType<typeof fakeEngine>>, bridge: Awaited<ReturnType<typeof createV2ContextBridge>>) {
  const response = await fetch(bridge.url, {
    method: "POST", headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "ask_without_waiting", sessionId: "ses_one",
      caller: { directory: "/work/acme", messageId: "msg_one", callId: "call_one" },
      input: { questions: [{ header: "Save location", question: "Where should I save the export?", options: [{ label: "Documents" }, { label: "Desktop" }] }] },
    }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

test("a background question returns at once and its answer reaches the chat as a steer message", async () => {
  const engine = await fakeEngine();
  const bridge = await createV2ContextBridge(async () => ({}), () => engine.connection);
  try {
    const asked = await ask(engine, bridge);
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(asked.body.id, "frm_one");
    assert.deepEqual(engine.forms, [{
      query: `?location[directory]=${encodeURIComponent("/work/acme")}`,
      body: {
        title: "Save location", metadata: { kind: "question", background: true },
        fields: [{ key: "q0", type: "string", title: "Save location", description: "Where should I save the export?",
          options: [{ value: "Documents", label: "Documents" }, { value: "Desktop", label: "Desktop" }], custom: true }],
      },
    }], "a question form with no tool link, so the app keeps it open after the call returns");
    assert.deepEqual(engine.prompts, [], "nothing reaches the chat before the person answers");

    engine.emit({ type: "form.replied", data: { id: "frm_other", sessionID: "ses_one", answer: { q0: "Desktop" } } });
    engine.emit({ type: "form.replied", data: { id: "frm_one", sessionID: "ses_one", answer: { q0: "Documents" } } });
    await settle();
    assert.deepEqual(engine.prompts, [{
      query: `?location[directory]=${encodeURIComponent("/work/acme")}`,
      body: { text: "Answer to your question “Where should I save the export?”: Documents", delivery: "steer" },
    }]);
  } finally {
    await bridge.close();
    await engine.close();
  }
});

test("a dismissed background question sends nothing to the chat", async () => {
  const engine = await fakeEngine();
  const bridge = await createV2ContextBridge(async () => ({}), () => engine.connection);
  try {
    assert.equal((await ask(engine, bridge)).status, 200);
    engine.emit({ type: "form.cancelled", data: { id: "frm_one", sessionID: "ses_one" } });
    engine.emit({ type: "form.replied", data: { id: "frm_one", sessionID: "ses_one", answer: { q0: "Documents" } } });
    await settle();
    assert.deepEqual(engine.prompts, []);
  } finally {
    await bridge.close();
    await engine.close();
  }
});

test("ask_without_waiting is available without a rollout lookup", async () => {
  let offered = false;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    response.writeHead(path === "/agent-questions" ? 200 : 404, { "Content-Type": "application/json" });
    response.end(JSON.stringify(path === "/agent-questions" ? { offered } : {}));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const names = new Set<string>();
  let callback: ((editor: { add(tool: { name: string }): void }) => void) | undefined;
  let prompt: (() => void | Promise<void>) | undefined;
  const apply = () => { names.clear(); callback?.({ add: tool => names.add(tool.name) }); };
  const stop = await nativeContext.setup({
    options: { url: "http://127.0.0.1:9/read", token: "read", browser: { url: `http://127.0.0.1:${port}/browser`, token: "browser" } },
    tool: { async transform(next) { callback = next; apply(); return { async dispose() { names.clear(); } }; }, async reload() { apply(); } },
    session: { async hook(_name, next) { prompt = next as () => void; return { async dispose() {} }; } },
    skill: { async transform() { return { async dispose() {} }; }, async reload() {} },
  } as Parameters<typeof nativeContext.setup>[0]);
  try {
    assert.equal(names.has("ask_without_waiting"), true);
    offered = true;
    await prompt?.();
    assert.equal(names.has("ask_without_waiting"), true, "turning the flag on offers it from the next prompt");
    offered = false;
    await prompt?.();
    assert.equal(names.has("ask_without_waiting"), true);
  } finally {
    await stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
