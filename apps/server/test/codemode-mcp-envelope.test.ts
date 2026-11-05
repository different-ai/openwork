import assert from "node:assert/strict";
import { test } from "node:test";
import { createMcpResultsCollector, preservedEntry } from "../src/opencode-plugins/openwork-mcp-results-v2.js";

const identity = { messageID: "msg_fixture", id: "call_fixture" };
const launch = { connectionId: "emc_fixture", toolName: "review_recipient", resourceUri: "ui://fixture/review.html", arguments: {} };
const envelope = {
  content: [{ type: "text", text: "Recipient required." }],
  structuredContent: { state: "ask_email" },
  _meta: { "openwork/mcpApp": launch, "provider/private": "host-only" },
  isError: false,
};
const input = { name: "mcp:emc_fixture:review_recipient", body: {} };
const event = { ...identity, tool: "openwork-cloud.execute_capability", input, status: "completed",
  result: { output: envelope.structuredContent, content: [{ type: "text", text: "Recipient required." }], metadata: { mcp: envelope } } } satisfies Parameters<typeof preservedEntry>[0];

for (const tool of ["openwork-cloud.execute_capability", "openwork-direct-review_review_recipient"]) {
  test(`${tool}: host-only MCP envelope is preserved without changing the script's value`, () => {
    const entry = preservedEntry({ ...event, tool });
    assert.equal(entry?.status, "completed");
    if (entry?.status !== "completed") throw new Error("Missing preserved MCP result");
    assert.deepEqual(entry.output, { state: "ask_email" });
    assert.deepEqual(entry.mcpResult, envelope);
    assert.ok(!JSON.stringify(entry.output).includes("host-only"));
    // It owns a snapshot; later mutation of the native result cannot corrupt it.
    assert.notEqual(entry.mcpResult, envelope);
  });
}

test("Code Mode preserves every parallel invocation once and retains the full result after JSON persistence", () => {
  const collector = createMcpResultsCollector();
  collector.before({ ...identity, tool: "execute", input: { code: "await Promise.all(calls); return 'done';" } });
  const inputs = [{ ...input, body: { recipient: "one" } }, { ...input, body: { recipient: "two" } }];
  for (const input of inputs) collector.before({ ...event, input });
  // Complete in reverse order: results must stay paired with their own inputs.
  for (const input of [...inputs].reverse()) collector.after({ ...event, input });
  const result: { output: string; metadata: Record<string, unknown> } = { output: "done", metadata: { existing: true } };
  collector.after({ ...identity, tool: "execute", input: {}, status: "completed", result });
  const metadata = JSON.parse(JSON.stringify(result.metadata));
  assert.equal(metadata.existing, true);
  assert.equal(metadata.openworkMcpResults.length, 2);
  assert.deepEqual(metadata.openworkMcpResults.map((entry: { input: unknown }) => entry.input), [...inputs].reverse());
  assert.deepEqual(metadata.openworkMcpResults.map((entry: { mcpResult: unknown }) => entry.mcpResult), [envelope, envelope]);
  assert.deepEqual(metadata.openworkToolDetails.map((detail: { output: unknown }) => detail.output), [{ state: "ask_email" }, { state: "ask_email" }]);
  assert.equal(result.output, "done");
});

test("a direct MCP call receives the same host metadata without changing model-visible output or content", () => {
  const collector = createMcpResultsCollector();
  const result = { ...event.result, metadata: { mcp: envelope, existing: true } };
  collector.after({ ...event, result });
  assert.deepEqual(result.metadata, { mcp: envelope, existing: true, openworkMcpResult: envelope });
  assert.deepEqual(result.output, { state: "ask_email" });
  assert.deepEqual(result.content, [{ type: "text", text: "Recipient required." }]);
});

test("ordinary values and unrelated metadata do not become App results", () => {
  for (const metadata of [undefined, {}, { mcp: { _meta: envelope._meta } }, { mcp: "not an envelope" }]) {
    assert.equal(preservedEntry({ ...event, result: { output: { state: "ask_email" }, metadata } }), null);
  }
  assert.equal(preservedEntry({ ...event, tool: "shell", result: { output: "done" } }), null);
});

test("oversized MCP metadata is bounded rather than bloating the transcript", () => {
  assert.equal(preservedEntry({ ...event, result: { ...event.result, metadata: {
    mcp: { ...envelope, _meta: { oversized: "x".repeat(64 * 1024) } },
  } } }), null);
});

test("connection and authored-App results retain their existing shape", () => {
  for (const output of [{ connectionId: "emc_fixture", state: "connected" }, { launch }, { preparationId: "fixture" }]) {
    const tool = "preparationId" in output ? "openwork-cloud.prepare_app" : event.tool;
    const entry = preservedEntry({ ...event, tool, result: { output } });
    assert.deepEqual(entry, { tool: tool.replace("openwork-cloud.", "openwork-cloud_"), input, status: "completed", output });
  }
});
