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

test("Google generation and streaming retain exact native media and return configured text", async () => {
  const marker = "native-video-proof";
  const reply = "The video reached the model";
  const media = { mimeType: "video/mp4", data: Buffer.from([0, 255, 128, 1, 254]).toString("base64") };
  await using mock = await startMockMcp({
    port: await allocateFreePort(),
    agentWorkloads: [{ promptMarker: marker, finalReply: reply, finalReplyChunkSize: 5, steps: [] }],
    agentRequiredHeader: { name: "x-goog-api-key", value: "google-fixture-key" },
  });
  for (const method of ["generateContent", "streamGenerateContent"]) {
    const body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: marker }, { inlineData: media }] }] });
    const url = `${mock.url}/v1beta/models/video-fixture:${method}?alt=sse`;
    const denied = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal(denied.status, 401);
    await denied.text();
    const accepted = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": "google-fixture-key" },
      body,
    });
    assert.equal(accepted.status, 200);
    if (method === "generateContent") {
      const result = await accepted.json();
      assert.equal(result.candidates[0].content.parts[0].text, reply);
      assert.equal(result.candidates[0].finishReason, "STOP");
    } else {
      assert.match(accepted.headers.get("content-type") ?? "", /text\/event-stream/);
      const events = (await accepted.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
      assert.ok(events.length > 2);
      assert.equal(events.map(event => event.candidates[0].content.parts[0].text).join(""), reply);
      assert.equal(events.at(-1)?.candidates[0].finishReason, "STOP");
    }
  }
  const requests = await mock.agentRequests({ promptMarker: marker });
  assert.deepEqual(requests.map(request => request.kind), ["error", "final", "error", "final"]);
  for (const request of requests) {
    assert.equal(request.model, "video-fixture");
    assert.deepEqual(request.inlineMedia, [media]);
  }
});

test("Google generation rejects tool workloads rather than silently ignoring their steps", async () => {
  await using mock = await startMockMcp({
    port: await allocateFreePort(),
    agentWorkloads: [{ promptMarker: "tool-required", finalReply: "must not be returned", steps: [{ tool: "read", arguments: {} }] }],
  });
  for (const method of ["generateContent", "streamGenerateContent"]) {
    const response = await fetch(`${mock.url}/v1beta/models/video-fixture:${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "tool-required" }] }] }),
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /empty steps/);
  }
  assert.deepEqual((await mock.agentRequests()).map(request => request.kind), ["error", "error"]);
});
