import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { configuration, createCanaryModel, MODEL_ID } from "./model.mjs";

// Protocol unit tests only. Fabricated tool results below are NOT file-persistence evidence.
const config = configuration({ CANARY_MODEL_KEY: "synthetic-fixture-test-key", CANARY_MARKER: "canary_self_test", PORT: "0" });
const tools = [
  { type: "function", function: { name: "write", parameters: { type: "object", properties: { filePath: { type: "string" }, content: { type: "string" } }, required: ["filePath", "content"] } } },
  { type: "function", function: { name: "read", parameters: { type: "object", properties: { filePath: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["filePath"] } } },
];
const initial = () => [{ role: "user", content: `Create ${config.filename} containing ${config.marker}, then read it.` }];
const result = (call, content) => ({ role: "tool", tool_call_id: call.id, content });
const currentRead = (marker = config.marker) => `<path>${config.filePath}</path>\n<type>file</type>\n<content>1: ${marker}\n\n(End of file - total 1 lines)</content>`;

async function fixture(t) {
  const server = createCanaryModel(config, { streamDelayMs: 10 });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${config.key}`, "content-type": "application/json" };
  const request = (path, options = {}) => fetch(`${url}${path}`, { headers, ...options });
  const chat = (messages, extra = {}) => request("/v1/chat/completions", {
    method: "POST", body: JSON.stringify({ model: MODEL_ID, messages, tools, ...extra }),
  });
  const message = async (messages, extra = {}) => {
    const response = await chat(messages, extra);
    assert.equal(response.status, 200);
    return (await response.json()).choices[0].message;
  };
  return { request, chat, message, stats: async () => (await request("/stats")).json() };
}

test("configuration, authenticated model discovery and sanitized stats", async (t) => {
  assert.throws(() => configuration({}), /CANARY_MODEL_KEY/);
  assert.throws(() => configuration({ ...process.env, CANARY_MODEL_KEY: config.key, CANARY_MARKER: config.marker, CANARY_FILE_NAME: "../escape.txt" }), /CANARY_FILE_NAME/);
  const f = await fixture(t);
  assert.equal((await f.request("/health", { headers: {} })).status, 200);
  assert.equal((await f.request("/stats", { headers: {} })).status, 401);
  assert.equal((await f.request("/v1/models", { headers: { authorization: "Bearer incorrect" } })).status, 401);
  assert.equal((await (await f.request("/v1/models")).json()).data[0].id, MODEL_ID);
  const stats = await f.stats();
  assert.equal(stats.upstreamCalls, 0);
  assert.ok(!JSON.stringify(stats).includes(config.key));
  assert.ok(!JSON.stringify(stats).includes(config.marker));
});

test("advertised write/read calls, split SSE, and a fresh read for each new user turn", async (t) => {
  const f = await fixture(t);
  const messages = initial();
  const write = await f.message(messages);
  const writeCall = write.tool_calls[0];
  assert.equal(writeCall.function.name, "write");
  assert.deepEqual(JSON.parse(writeCall.function.arguments), { filePath: config.filePath, content: `${config.marker}\n` });
  writeCall.function.arguments = JSON.stringify(JSON.parse(writeCall.function.arguments), null, 2);
  messages.push(write, result(writeCall, "Wrote file successfully."));
  const read = await f.message(messages);
  const readCall = read.tool_calls[0];
  assert.equal(readCall.function.name, "read");
  assert.deepEqual(JSON.parse(readCall.function.arguments), { filePath: config.filePath });
  messages.push(read, result(readCall, currentRead()));
  const response = await f.chat(messages, { stream: true });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const events = (await response.text()).split("\n\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6));
  assert.equal(events.at(-1), "[DONE]");
  const deltas = events.slice(0, -1).map((event) => JSON.parse(event).choices[0]);
  assert.deepEqual(deltas.filter((entry) => entry.delta.content).map((entry) => entry.delta.content), ["Canary read 1:", ` ${config.marker}`]);
  assert.equal(deltas.at(-1).finish_reason, "stop");
  const answer = await f.message(messages); // Retry must not count a second receipt.
  assert.equal(answer.content, `Canary read 1: ${config.marker}`);
  messages.push(answer, { role: "user", content: `Read ${config.filename} again; do not modify it.` });
  const fresh = await f.message(messages);
  assert.equal(fresh.tool_calls[0].function.name, "read");
  assert.notEqual(fresh.tool_calls[0].id, readCall.id);
  messages.push(fresh, result(readCall, currentRead())); // Old result cannot satisfy the NEW call.
  assert.ok((await f.message(messages)).tool_calls);
  assert.equal((await f.stats()).verifiedReads, 1);
  messages.push(result(fresh.tool_calls[0], `<file>\n00001| ${config.marker}\n00002| \n</file>`));
  const followup = await f.message(messages);
  assert.equal(followup.content, `Canary read 2: ${config.marker}`);
  messages.push(followup, { role: "user", content: `Read ${config.filename} again; do not modify it.` });
  assert.notEqual((await f.message(messages)).tool_calls[0].id, fresh.tool_calls[0].id);
  const stats = await f.stats();
  assert.equal(stats.writeToolCalls, 1);
  assert.equal(stats.readToolCalls, 3);
  assert.equal(stats.verifiedReads, 2);
  assert.equal(stats.readReceipts[0].sha256, stats.readReceipts[1].sha256);
  assert.deepEqual(stats.readReceipts.map((receipt) => receipt.turn), [1, 2]);
  assert.equal(stats.upstreamCalls, 0);
});

test("wrong, missing and error read results cannot earn a receipt or success answer", async (t) => {
  for (const output of [currentRead("wrong_marker"), `Error: ${config.marker}`, config.marker, currentRead().replace(config.filePath, "/different.txt")]) {
    const f = await fixture(t);
    const messages = [{ role: "user", content: `Read ${config.filename} again.` }];
    const read = await f.message(messages);
    messages.push(read, result(read.tool_calls[0], output));
    const response = await f.chat(messages);
    assert.equal(response.status, 400);
    assert.ok(!(await response.text()).includes(config.marker));
    assert.equal((await f.stats()).verifiedReads, 0);
    assert.equal((await f.stats()).rejectedReadResults, 1);
  }
});

test("tool schemas are selected from the request, and unsupported requirements fail closed", async (t) => {
  const f = await fixture(t);
  const advertised = structuredClone(tools);
  advertised[0].function.name = "engine_write";
  advertised[1].function.name = "engine_read";
  advertised[0].function.parameters.properties.file_path = { type: "string" };
  delete advertised[0].function.parameters.properties.filePath;
  advertised[0].function.parameters.required = ["file_path", "content"];
  const response = await f.chat(initial(), { tools: advertised, stream: true });
  const events = (await response.text()).split("\n\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  const deltas = events.flatMap((event) => event.choices[0].delta.tool_calls ?? []);
  assert.equal(deltas[0].function.name, "engine_write");
  assert.equal(JSON.parse(deltas[1].function.arguments).file_path, config.filePath);
  const g = await fixture(t);
  advertised[0].function.parameters.required.push("unsupported");
  assert.equal((await g.chat(initial(), { tools: advertised })).status, 400);
  assert.equal((await g.stats()).writeToolCalls, 0);
});

test("title, compaction and probe requests never call file tools", async (t) => {
  const f = await fixture(t);
  for (const system of ["You are a title generator", "You are a helpful AI assistant tasked with summarizing conversations"]) {
    assert.equal((await f.message([{ role: "system", content: system }, ...initial()])).content, "Canary note");
  }
  assert.equal((await f.message(initial(), { tools: [] })).content, "Canary note");
  assert.equal((await f.message(initial(), { tool_choice: "none" })).content, "Canary note");
  assert.equal((await f.message([{ role: "user", content: "Say hello" }])).content, "Canary note");
  assert.equal((await f.stats()).writeToolCalls, 0);
  assert.equal((await f.stats()).readToolCalls, 0);
});
