import assert from "node:assert/strict";
import test from "node:test";

import { allocateFreePort } from "@openwork/cdp";
import { startMockMcp } from "../src/mock-mcp.ts";

test("records an unauthenticated initialize attempt as a handshake", async () => {
  await using mock = await startMockMcp({ port: await allocateFreePort() });
  const startedAt = new Date().toISOString();

  const response = await fetch(mock.mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mock-handshake-test", version: "1.0.0" },
      },
    }),
  });

  assert.equal(response.status, 401);
  const handshakes = await mock.handshakes({ sinceIso: startedAt });
  assert.equal(handshakes.length, 1);
  assert.equal(handshakes[0]?.method, "POST");
  assert.equal(handshakes[0]?.path, "/mcp");
});

function completionBody(marker: string, completedTools: number): Record<string, unknown> {
  return {
    model: "mock-agent-workload-model",
    stream: true,
    tools: [
      { type: "function", function: { name: "write", parameters: { type: "object" } } },
      { type: "function", function: { name: "read", parameters: { type: "object" } } },
    ],
    messages: [
      { role: "user", content: `run ${marker}` },
      ...Array.from({ length: completedTools }, (_, index) => ({
        role: "tool",
        tool_call_id: `call-${index}`,
        content: `tool result ${index}`,
      })),
    ],
  };
}

async function pollUntil<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    value = await read();
  }
  assert.equal(accept(value), true);
  return value;
}

test("scripts and records deterministic OpenAI-compatible agent tool rounds", async () => {
  const marker = "agent-workload-unit-marker";
  await using mock = await startMockMcp({
    port: await allocateFreePort(),
    agentWorkloads: [{
      promptMarker: marker,
      finalReply: "unit workload complete",
      steps: [
        { tool: "write", arguments: { filePath: "/tmp/unit.txt", content: marker } },
        { tool: "read", arguments: { filePath: "/tmp/unit.txt" } },
      ],
    }],
  });
  const startedAt = new Date().toISOString();

  const first = await fetch(`${mock.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(completionBody(marker, 0)),
  });
  const firstText = await first.text();
  assert.equal(first.status, 200);
  assert.match(firstText, /"name":"write"/);
  assert.match(firstText, /unit\.txt/);

  const second = await fetch(`${mock.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(completionBody(marker, 1)),
  });
  assert.match(await second.text(), /"name":"read"/);

  const final = await fetch(`${mock.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(completionBody(marker, 2)),
  });
  assert.match(await final.text(), /unit workload complete/);

  const requests = await mock.agentRequests({ promptMarker: marker, sinceIso: startedAt, atLeast: 3, timeoutMs: 5_000 });
  assert.deepEqual(requests.map((request) => request.kind), ["tool", "tool", "final"]);
  assert.deepEqual(requests.map((request) => request.completedTools), [0, 1, 2]);
  assert.deepEqual(requests.map((request) => request.matchedMarkers), [[marker], [marker], [marker]]);
});

test("gated agent replies bind hermetically and clear waiters when the client disconnects", async () => {
  const marker = "agent-gate-unit-marker";
  const chunks = ["chunk-one", "chunk-two", "chunk-three"];
  await using mock = await startMockMcp({
    port: await allocateFreePort(),
    isolatedProcessEnv: true,
    agentWorkloads: [{
      promptMarker: marker,
      finalReply: chunks.join(""),
      finalReplyChunks: chunks,
      finalReplyInitiallyReleasedChunks: 1,
      steps: [],
    }],
  });
  const health = JSON.parse(await (await fetch(`${mock.url}/health`)).text());
  assert.equal(health.host, "127.0.0.1");

  const controller = new AbortController();
  const response = await fetch(`${mock.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(completionBody(marker, 0)),
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Gated completion returned no response body");
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(chunks[0])) {
    const item = await reader.read();
    if (item.done) throw new Error("Gated completion ended before its initial chunk");
    text += decoder.decode(item.value, { stream: true });
  }
  const firstHold = await pollUntil(
    () => mock.agentReplyState(marker),
    (state) => state.deliveredChunks === 1 && state.waiting === 1,
  );
  assert.equal(firstHold.complete, false);
  await mock.releaseAgentReply(marker);
  const secondHold = await pollUntil(
    () => mock.agentReplyState(marker),
    (state) => state.deliveredChunks === 2 && state.waiting === 1,
  );
  assert.equal(secondHold.prefix, chunks.slice(0, 2).join(""));

  controller.abort();
  await reader.read().catch(() => undefined);
  const aborted = await pollUntil(
    () => mock.agentReplyState(marker),
    (state) => state.aborted && state.waiting === 0,
  );
  assert.equal(aborted.complete, false);
  assert.equal(aborted.timedOut, false);
});

test("unadvertised calls require an explicit adversarial workload", async () => {
  await using mock = await startMockMcp({
    port: await allocateFreePort(),
    agentWorkloads: [false, true].map((allowUnadvertisedTool) => ({
      promptMarker: `unadvertised-${allowUnadvertisedTool}`,
      finalReply: "attempt complete",
      steps: [{ tool: "unadvertised-shell", allowUnadvertisedTool, arguments: { command: "true" } }],
    })),
  });
  for (const enabled of [false, true]) {
    const marker = `unadvertised-${enabled}`;
    const response = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(completionBody(marker, 0)),
    });
    assert.equal(response.status, enabled ? 200 : 400);
    const body = await response.text();
    assert.match(body, enabled ? /"name":"unadvertised-shell"/ : /was not offered/);
    const requests = await mock.agentRequests({ promptMarker: marker, atLeast: 1 });
    assert.deepEqual(requests.map((request) => request.kind), [enabled ? "tool" : "error"]);
  }
});

test("turn-scoped workloads isolate revisions from earlier markers and tool rounds", async () => {
  await using mock = await startMockMcp({
    port: await allocateFreePort(),
    agentWorkloads: ["first sketch", "revise sketch"].map((promptMarker) => ({
      latestUserTurn: true,
      promptMarker,
      finalReply: `${promptMarker} complete`,
      steps: [{ tool: "write", arguments: { content: promptMarker } }],
    })),
  });
  const history = [
    { role: "user", content: "first sketch" },
    { role: "tool", tool_call_id: "old", content: "old result" },
    { role: "assistant", content: "first sketch complete" },
    { role: "user", content: "revise sketch" },
  ];
  for (const completed of [false, true]) {
    const response = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...completionBody("unused", 0),
        messages: [...history, ...(completed ? [{ role: "tool", tool_call_id: "new", content: "new result" }] : [])],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, completed ? /revise sketch complete/ : /"name":"write"/);
    assert.doesNotMatch(text, /first sketch complete/);
  }
  const requests = await mock.agentRequests({ promptMarker: "revise sketch" });
  assert.deepEqual(requests.map((request) => request.kind), ["tool", "final"]);
  assert.deepEqual(requests.map((request) => request.completedTools), [0, 1]);
  assert.deepEqual(requests.map((request) => request.matchedMarkers), [["revise sketch"], ["revise sketch"]]);
});


test("native Responses preserve the configured provider header", async () => {
  await using mock = await startMockMcp({
    port: await allocateFreePort(),
    agentWorkloads: [{ promptMarker: "native-header-proof", finalReply: "The header reached the provider", steps: [] }],
    agentRequiredHeader: { name: "x-private-model-setting", value: "fixture-only-value" },
  });
  const request = (header?: string) => fetch(`${mock.url}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json", ...(header ? { "x-private-model-setting": header } : {}) },
    body: JSON.stringify({ model: "native-fixture", input: "native-header-proof", stream: true }),
  });
  for (const header of [undefined, "wrong-value"]) {
    const denied = await request(header);
    assert.equal(denied.status, 401);
    await denied.text();
  }
  const accepted = await request("fixture-only-value");
  assert.equal(accepted.status, 200);
  const events = (await accepted.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  assert.ok(events.some(event => event.type === "response.completed"));
  assert.equal(events.filter(event => event.type === "response.output_text.delta").map(event => event.delta).join(""), "The header reached the provider");
});
