import assert from "node:assert/strict";
import test from "node:test";

import { createHeadlessThreadClient, HeadlessThreadError, type HeadlessFetch } from "../src/index.js";

const WORKSPACE = "ws_1";
const THREAD = "ses_thread1";
const WORKSPACE_DEFAULT = { providerID: "openai", modelID: "gpt-default" };

type Call = { method: string; path: string; body: unknown };

/** A fake OpenWork server for one thread, recording every request the client makes. */
function fakeServer(input: {
  engine: "v1" | "v2";
  userTurns: number;
  boundModel?: { providerID: string; id: string };
  workspaceDefault?: typeof WORKSPACE_DEFAULT | null;
}) {
  const calls: Call[] = [];
  const workspace = `/workspace/${WORKSPACE}`;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const fetch: HeadlessFetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
    if (method === "GET" && path === `${workspace}/default-model`) {
      const model = input.workspaceDefault === undefined ? WORKSPACE_DEFAULT : input.workspaceDefault;
      return model === null ? json({ message: "No default model" }, 404) : json({ model });
    }
    if (input.engine === "v2") {
      const session = `${workspace}/opencode2/api/session/${THREAD}`;
      if (method === "GET" && path === session) return json({ data: { id: THREAD, ...(input.boundModel ? { model: input.boundModel } : {}) } });
      if (method === "GET" && path === `${session}/message`) {
        return json({ data: Array.from({ length: input.userTurns }, (_, index) => ({ id: `msg_${index}`, role: "user", text: "earlier" })), cursor: { next: null } });
      }
      if (method === "POST" && (path === `${session}/model` || path === `${session}/prompt`)) return json({ data: {} });
    } else {
      const session = `${workspace}/opencode/session/${THREAD}`;
      if (method === "GET" && path === `${session}/message`) {
        return json(Array.from({ length: input.userTurns }, (_, index) => ({ info: { id: `msg_${index}`, role: "user" }, parts: [] })));
      }
      if (method === "POST" && path === `${session}/prompt_async`) return new Response(null, { status: 204 });
    }
    return json({ message: `Unexpected ${method} ${path}` }, 500);
  };
  const client = createHeadlessThreadClient({ baseUrl: "http://openwork.test", workspaceId: WORKSPACE, token: "test-token", engine: input.engine, fetch });
  const find = (method: string, suffix: string) => calls.filter((call) => call.method === method && call.path.endsWith(suffix));
  return { client, calls, find };
}

test("a v2 follow-up without a model keeps the session's bound model", async () => {
  const server = fakeServer({ engine: "v2", userTurns: 1, boundModel: { providerID: "anthropic", id: "claude-opus" } });
  await server.client.sendTurn(THREAD, { prompt: "and now?" });
  assert.deepEqual(server.find("POST", "/model"), [], "the session must not be re-bound");
  assert.deepEqual(server.find("GET", "/default-model"), []);
  assert.equal(server.find("POST", "/prompt").length, 1);
});

test("a v2 session with no model yet starts on the workspace default", async () => {
  const server = fakeServer({ engine: "v2", userTurns: 0 });
  await server.client.sendTurn(THREAD, { prompt: "hi" });
  assert.deepEqual(server.find("POST", "/model").map((call) => call.body), [{ model: { providerID: "openai", id: "gpt-default" } }]);
});

test("a v2 session with no model and no workspace default is refused before sending", async () => {
  const server = fakeServer({ engine: "v2", userTurns: 0, workspaceDefault: null });
  await assert.rejects(
    server.client.sendTurn(THREAD, { prompt: "hi" }),
    (error: unknown) => error instanceof HeadlessThreadError && error.code === "model_required",
  );
  assert.deepEqual(server.find("POST", "/prompt"), []);
});

test("a model named on the turn still switches a v2 session", async () => {
  const server = fakeServer({ engine: "v2", userTurns: 1, boundModel: { providerID: "anthropic", id: "claude-opus" } });
  await server.client.sendTurn(THREAD, { prompt: "switch", model: { providerId: "openai", modelId: "gpt-fast" } });
  assert.deepEqual(server.find("POST", "/model").map((call) => call.body), [{ model: { providerID: "openai", id: "gpt-fast" } }]);
});

test("a v1 follow-up without a model leaves the engine on the thread's last model", async () => {
  const server = fakeServer({ engine: "v1", userTurns: 1 });
  await server.client.sendTurn(THREAD, { prompt: "and now?" });
  const [prompt] = server.find("POST", "/prompt_async");
  assert.ok(prompt, "the turn was sent");
  assert.equal((prompt.body as Record<string, unknown>).model, undefined);
  assert.deepEqual(server.find("GET", "/default-model"), []);
});

test("a v1 thread's first turn without a model uses the workspace default", async () => {
  const server = fakeServer({ engine: "v1", userTurns: 0 });
  await server.client.sendTurn(THREAD, { prompt: "hi" });
  const [prompt] = server.find("POST", "/prompt_async");
  assert.deepEqual((prompt?.body as Record<string, unknown>).model, { providerID: "openai", modelID: "gpt-default" });
});
