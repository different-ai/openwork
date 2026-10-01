import { expect, test } from "bun:test";
import plugin, { createMcpResultsCollector } from "./openwork-mcp-results-v2.js";
import { renderOpencodeV2Config } from "../managed-opencode-v2.js";

// Shapes recorded from opencode2 v0.0.0-beta-19086: inner Code Mode calls fire
// execute.after with the outer call's messageID and id; MCP structuredContent
// arrives as `output`; an isError result arrives as the error message text.
const payload = {
  schemaVersion: "1", connectionId: "conn_notion", connectionName: "Notion", state: "needs_connection", actor: "member",
  message: "Connect Notion to continue.", action: { type: "connect", label: "Connect", surface: "openwork_your_connections" },
};
const call = { messageID: "msg_1", id: "call_1" };

test("connection reports from Code Mode calls are attached to the outer execute", () => {
  const collector = createMcpResultsCollector();
  collector.before({ ...call, tool: "execute" });
  collector.after({ ...call, tool: "openwork-cloud_connection_action", input: { connectionId: "conn_notion" }, status: "completed", result: { output: payload } });
  collector.after({ ...call, tool: "openwork-cloud_execute_capability", input: { name: "notion.search" }, status: "error",
    error: new Error(JSON.stringify({ error: "needs_connection", connectionStatus: payload })) });
  // Ordinary results and other servers are not preserved.
  collector.after({ ...call, tool: "openwork-cloud_execute_capability", input: {}, status: "completed", result: { output: { rows: [1, 2] } } });
  collector.after({ ...call, tool: "paper-local_get_children", input: {}, status: "completed", result: { output: payload } });
  collector.after({ ...call, tool: "openwork-cloud_search_capabilities", input: {}, status: "completed", result: { output: { matches: [payload] } } });
  const metadata: Record<string, unknown> = { toolCalls: [] };
  const outer = { ...call, tool: "execute", input: { code: "…" }, status: "completed" as const, result: { output: {}, metadata } };
  collector.after(outer);
  expect(outer.result.metadata).toEqual({ toolCalls: [], openworkMcpResults: [
    { tool: "openwork-cloud_connection_action", input: { connectionId: "conn_notion" }, status: "completed", output: payload },
    { tool: "openwork-cloud_execute_capability", input: { name: "notion.search" }, status: "error",
      error: JSON.stringify({ error: "needs_connection", connectionStatus: payload }) },
  ] });
});

test("a reused call id in another message and direct calls outside Code Mode stay separate", () => {
  const collector = createMcpResultsCollector();
  collector.before({ ...call, tool: "execute" });
  collector.after({ ...call, tool: "execute", input: {}, status: "completed", result: { output: {} } });
  // Same call id, new message: a direct call is not collected (no open execute).
  collector.after({ messageID: "msg_2", id: "call_1", tool: "openwork-cloud_connection_action", input: {}, status: "completed", result: { output: payload } });
  collector.before({ messageID: "msg_2", id: "call_1", tool: "execute" });
  const result: { output: unknown; metadata?: Record<string, unknown> } = { output: {} };
  const outer = { messageID: "msg_2", id: "call_1", tool: "execute", input: {}, status: "completed" as const, result };
  collector.after(outer);
  expect(outer.result.metadata).toBeUndefined();
});

test("the plugin registers both hooks and is always in the v2 config", async () => {
  const names: string[] = [];
  let disposed = 0;
  const close = await plugin.setup({ tool: { async hook(name: string) {
    names.push(name);
    return { async dispose() { disposed++; } };
  } } });
  expect(names).toEqual(["execute.before", "execute.after"]);
  await close();
  expect(disposed).toBe(2);
  const config = renderOpencodeV2Config({ providers: [], skills: [], mcpResultsPluginDirectory: "/runtime/mcp-results" });
  expect(config.plugins).toEqual([{ package: "file:///runtime/mcp-results" }]);
});

test("parallel repeated calls retain invocation order when completion arrives backwards", () => {
  const collector = createMcpResultsCollector();
  collector.before({ ...call, tool: "execute" });
  const first = { query: "first" }; const second = { query: "second" };
  collector.before({ ...call, tool: "service_search", input: first });
  const firstId = collector.claim({ ...call, tool: "service_search", input: first });
  collector.before({ ...call, tool: "service_search", input: second });
  const secondId = collector.claim({ ...call, tool: "service_search", input: second });
  collector.after({ ...call, tool: "service_search", input: second, invocationId: secondId, status: "completed", result: { output: "second result" } });
  collector.after({ ...call, tool: "service_search", input: first, invocationId: firstId, status: "completed", result: { output: "first result" } });
  const details = collector.details(call);
  expect(details.map(detail => [detail.ordinal, detail.input, detail.output])).toEqual([
    [0, first, "first result"], [1, second, "second result"],
  ]);
  expect(new Set(details.map(detail => detail.invocationId)).size).toBe(2);
});

test("shared inputs without a claimed identity cannot attach another invocation's result", () => {
  const collector = createMcpResultsCollector();
  collector.before({ ...call, tool: "execute" });
  const input = { query: "same" };
  collector.before({ ...call, tool: "service_search", input });
  collector.before({ ...call, tool: "service_search", input });
  expect(collector.claim({ ...call, tool: "service_search", input })).toBeUndefined();
  collector.after({ ...call, tool: "service_search", input, status: "completed", result: { output: "uncorrelated" } });
  expect(collector.details(call).every(detail => detail.output === undefined)).toBe(true);
});

test("large results bound the full metadata and explicitly report omitted details", () => {
  const collector = createMcpResultsCollector();
  collector.before({ ...call, tool: "execute" });
  for (let index = 0; index < 200; index++) {
    const input = { index, text: "i".repeat(80_000) };
    collector.before({ ...call, tool: "service_search", input });
    collector.after({ ...call, tool: "service_search", input, status: "completed", result: { output: "o".repeat(80_000) } });
  }
  const details = collector.details(call);
  expect(details.length).toBeGreaterThan(0);
  expect(details.length).toBeLessThan(200);
  expect(details.every(detail => detail.truncated)).toBe(true);
  expect(details[0]?.output).toContain("[Result truncated by OpenWork]");
  const outer = { ...call, tool: "execute", input: {}, status: "completed" as const, result: { output: {}, metadata: {} } };
  collector.after(outer);
  expect(outer.result.metadata).toMatchObject({ openworkToolDetailsTruncated: true });
  const payloadBytes = new TextEncoder().encode(JSON.stringify(outer.result.metadata)).byteLength;
  expect(payloadBytes).toBeLessThan(1_024 * 1_024);
});

test("many tiny calls cannot grow the metadata beyond its execution budget", () => {
  const collector = createMcpResultsCollector();
  collector.before({ ...call, tool: "execute" });
  for (let index = 0; index < 8_000; index++) {
    const input = {};
    collector.before({ ...call, tool: "service_search", input });
    collector.after({ ...call, tool: "service_search", input, status: "completed", result: { output: 0 } });
  }
  const details = collector.details(call);
  expect(details.length).toBeGreaterThan(0);
  expect(details.length).toBeLessThan(8_000);
  expect(details.map(detail => detail.ordinal)).toEqual(Array.from({ length: details.length }, (_, index) => index));
  const outer = { ...call, tool: "execute", input: {}, status: "completed" as const, result: { output: {}, metadata: {} } };
  collector.after(outer);
  expect(outer.result.metadata).toMatchObject({ openworkToolDetailsTruncated: true });
  expect(new TextEncoder().encode(JSON.stringify(outer.result.metadata)).byteLength).toBeLessThanOrEqual(1_024 * 1_024);
});

test("escaped payloads count serialized bytes and omitted errors never become fabricated text", () => {
  const collector = createMcpResultsCollector();
  collector.before({ ...call, tool: "execute" });
  for (let index = 0; index < 200; index++) {
    const input = { index, text: "\u0000\\".repeat(80_000) };
    collector.before({ ...call, tool: "service_search", input });
    collector.after({ ...call, tool: "service_search", input, status: "error", error: new Error("\u0000\\".repeat(80_000)) });
  }
  const details = collector.details(call);
  expect(details.length).toBeGreaterThan(0);
  expect(details.every(detail => new TextEncoder().encode(JSON.stringify(detail)).byteLength <= 64 * 1_024)).toBe(true);
  expect(details.every(detail => detail.error !== "undefined")).toBe(true);
  const outer = { ...call, tool: "execute", input: {}, status: "completed" as const, result: { output: {}, metadata: {} } };
  collector.after(outer);
  expect(outer.result.metadata).toMatchObject({ openworkToolDetailsTruncated: true });
  expect(new TextEncoder().encode(JSON.stringify(outer.result.metadata)).byteLength).toBeLessThanOrEqual(1_024 * 1_024);
});

test("the supported transform enriches live progress and history without changing tool results", async () => {
  type BeforeEvent = Parameters<ReturnType<typeof createMcpResultsCollector>["before"]>[0];
  type AfterEvent = Parameters<ReturnType<typeof createMcpResultsCollector>["after"]>[0];
  const hooks = new Map<string, (event: AfterEvent) => void>();
  const progress: Record<string, unknown>[] = [];
  const returned = { output: { rows: [{ version: 3 }] }, metadata: { existing: "retained" } };
  const tool = { execute: async (_input: unknown, _context: BeforeEvent & { progress(metadata: Record<string, unknown>): Promise<void> }) => {
    expect(progress).toMatchObject([{ openworkToolDetails: [{ invocationId: "call_1:0", ordinal: 0,
      startedAt: expect.any(Number), status: "running" }] }]);
    return returned;
  } };
  let transformed = "";
  const close = await plugin.setup({ tool: {
    async hook(name, callback) { hooks.set(name, event => callback(event)); return { async dispose() {} }; },
    async transform(callback) {
      callback({ list: () => [{ id: "service_search", name: "Search" }], update: (id, update) => { transformed = id; update(tool); } });
      return { async dispose() {} };
    },
  } });
  const outer: AfterEvent = { ...call, tool: "execute", input: {}, status: "completed", result: { output: "Script finished" } };
  const input = { query: "fixture" };
  hooks.get("execute.before")!({ ...outer });
  hooks.get("execute.before")!({ ...call, tool: "service_search", input, status: "completed", result: {} });
  const result = await tool.execute(input, { ...call, tool: "service_search", async progress(metadata) { progress.push(metadata); } });
  expect(transformed).toBe("service_search");
  expect(result).toBe(returned);
  expect(progress).toMatchObject([
    { openworkToolDetails: [{ invocationId: "call_1:0", ordinal: 0, status: "running" }] },
    { openworkToolDetails: [{ invocationId: "call_1:0", ordinal: 0, output: returned.output, status: "completed" }] },
  ]);
  hooks.get("execute.after")!(outer);
  expect(outer.result.metadata).toMatchObject({ openworkToolDetails: [{ output: returned.output }] });
  await close();
});
