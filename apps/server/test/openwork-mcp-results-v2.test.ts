import assert from "node:assert/strict";
import { test } from "node:test";
import { createMcpResultsCollector, preservedEntry } from "../src/opencode-plugins/openwork-mcp-results-v2.js";

const event = { id: "execute", messageID: "message" };
const output = { launch: { connectionId: "app", toolName: "open_app", resourceUri: "ui://project-board", arguments: {} } };

test("delivery receipts are durable progress before the outer execution succeeds or fails", () => {
  const collector = createMcpResultsCollector();
  collector.before({ ...event, tool: "execute" });
  const inner = { ...event, tool: "openwork-cloud.create_app", input: { title: "Project board", reactSource: "x".repeat(40_000) } };
  collector.before(inner);
  const id = collector.claim(inner);
  assert.ok(id);
  collector.settle(event, id, { status: "completed", output });
  const persisted = JSON.parse(JSON.stringify(collector.metadata(event)));
  collector.after({ ...event, tool: "execute", input: {}, status: "error", error: new Error("Later script failure") });
  assert.deepEqual(persisted.openworkMcpResults[0].output.launch, output.launch);
  assert.equal(persisted.openworkToolDetails[0].status, "completed");
  assert.deepEqual(collector.metadata(event), {}, "terminal execution releases collector memory");
});

for (const sourceBytes of [70_000, 200_000]) test(`a ${sourceBytes}-byte authored input retains its small launch independently`, () => {
  const collector = createMcpResultsCollector();
  collector.before({ ...event, tool: "execute" });
  const inner = { ...event, tool: "openwork-cloud.create_app", input: { title: "Project board", preparationId: "preparation", reactSource: "x".repeat(sourceBytes) } };
  const receipt = preservedEntry({ ...inner, status: "completed", result: { output } });
  assert.ok(receipt, "large authored input must not discard a small complete delivery receipt");
  assert.deepEqual(receipt.input, { title: "Project board", preparationId: "preparation" });
  collector.before(inner);
  collector.settle(event, collector.claim(inner)!, { status: "completed", output });
  const persisted = JSON.parse(JSON.stringify(collector.metadata(event)));
  assert.equal(persisted.openworkToolDetails[0].inputTruncated, true);
  assert.notEqual(persisted.openworkToolDetails[0].outputTruncated, true);
  assert.deepEqual(persisted.openworkToolDetails[0].output, output);
  assert.deepEqual(persisted.openworkMcpResults[0].input, { title: "Project board", preparationId: "preparation" });
  assert.deepEqual(persisted.openworkMcpResults[0].output, output);
});

test("parallel calls keep invocation order, each result, and each own error", () => {
  const collector = createMcpResultsCollector();
  collector.before({ ...event, tool: "execute" });
  const calls = ["First board", "Second board"].map(title => ({ ...event, tool: "openwork-cloud.create_app", input: { title } }));
  calls.forEach(call => collector.before(call));
  const ids = calls.map(call => collector.claim(call));
  assert.ok(ids[0] && ids[1]);
  collector.settle(event, ids[1], { status: "completed", output });
  collector.settle(event, ids[0], { status: "error", error: "Rejected first board" });
  const metadata = JSON.parse(JSON.stringify(collector.metadata(event)));
  assert.deepEqual(metadata.openworkMcpResults.map((entry: { input: { title: string }; status: string }) => [entry.input.title, entry.status]), [["First board", "error"], ["Second board", "completed"]]);
  assert.equal(metadata.openworkToolDetails[0].error, "Rejected first board");
  assert.notEqual(metadata.openworkToolDetails[0].invocationId, metadata.openworkToolDetails[1].invocationId);
});

test("skill delivery is recorded before its diagnostic output is truncated", () => {
  const collector = createMcpResultsCollector();
  collector.before({ ...event, tool: "execute" });
  const inner = { ...event, tool: "openwork-cloud.get_skill", input: { name: "review" } };
  collector.before(inner);
  collector.settle(event, collector.claim(inner)!, { status: "completed", output: { name: "review", content: "Review each section. ".repeat(10_000) } });
  const metadata = JSON.parse(JSON.stringify(collector.metadata(event)));
  assert.equal(metadata.openworkToolDetails[0].truncated, true);
  assert.deepEqual(metadata.openworkToolDetails[0].skillDelivery, { name: "review", state: "instructions-loaded" });
});

test("the successful final hook does not duplicate already published receipts", () => {
  const collector = createMcpResultsCollector();
  collector.before({ ...event, tool: "execute" });
  const inner = { ...event, tool: "openwork-cloud.create_app", input: {} };
  collector.before(inner);
  collector.settle(event, collector.claim(inner)!, { status: "completed", output });
  collector.after({ ...inner, status: "completed", result: { output } });
  const terminal: Parameters<typeof collector.after>[0] = { ...event, tool: "execute", input: {}, status: "completed", result: { output: "script return" } };
  collector.after(terminal);
  assert.equal(JSON.parse(JSON.stringify(terminal.result.metadata)).openworkMcpResults.length, 1);
});
