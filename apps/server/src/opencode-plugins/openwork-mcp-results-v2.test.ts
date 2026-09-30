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
