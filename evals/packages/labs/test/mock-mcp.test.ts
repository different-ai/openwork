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

test("a declared quiet completion opens the stream, never ends it, and yields to the next request", async () => {
  const marker = "agent-workload-quiet-marker";
  await using mock = await startMockMcp({
    port: await allocateFreePort(),
    agentWorkloads: [{
      promptMarker: marker,
      finalReply: "quiet workload complete",
      steps: [{ tool: "read", arguments: { filePath: "/tmp/quiet.txt" } }],
      quietCompletions: 1,
    }],
  });
  const startedAt = new Date().toISOString();

  const controller = new AbortController();
  const quiet = await fetch(`${mock.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(completionBody(marker, 0)),
    signal: controller.signal,
  });
  assert.equal(quiet.status, 200);
  assert.equal(quiet.headers.get("content-type"), "text/event-stream");
  const reader = quiet.body?.getReader();
  assert.ok(reader);
  const opening = await reader.read();
  assert.match(new TextDecoder().decode(opening.value), /"role":"assistant"/);
  const next = await Promise.race([
    reader.read().then(() => "ended"),
    new Promise<string>((resolve) => setTimeout(() => resolve("still quiet"), 1_500)),
  ]);
  assert.equal(next, "still quiet");
  controller.abort();

  const second = await fetch(`${mock.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(completionBody(marker, 0)),
  });
  assert.match(await second.text(), /"name":"read"/);

  const requests = await mock.agentRequests({ promptMarker: marker, sinceIso: startedAt, atLeast: 2, timeoutMs: 5_000 });
  assert.deepEqual(requests.map((request) => request.kind), ["quiet", "tool"]);
});
