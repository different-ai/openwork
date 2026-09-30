import { expect, test } from "bun:test";
import plugin, { createMcpResultsCollector } from "./openwork-mcp-results-v2.js";
import { renderOpencodeV2Config } from "../managed-opencode-v2.js";
import { serve } from "../serve-node.js";
import { setTimeout as delay } from "node:timers/promises";
import { waitForConnectionDecision, type ConnectionToolEvent } from "./openwork-connection-gate-v2.js";
import type { ConnectionActionPayload, HostConnectionDecision } from "@openwork/types/connection-action-app";

// Shapes recorded from opencode2 v0.0.0-beta-19086: inner Code Mode calls fire
// execute.after with the outer call's messageID and id; MCP structuredContent
// arrives as `output`; an isError result arrives as the error message text.
const payload: ConnectionActionPayload = {
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

test("a connection result waits at the runtime boundary without asking the model to issue a question", async () => {
  let answer: (value: Response) => void = () => undefined;
  let received = false;
  const bridge = await serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    expect(request.headers.get("authorization")).toBe("Bearer gate-secret");
    expect(await request.json()).toMatchObject({
      sessionID: "ses_1", messageID: "msg_1", id: "call_1",
      tool: "openwork-cloud_search_capabilities", connection: payload,
    });
    received = true;
    return new Promise<Response>(resolve => { answer = resolve; });
  } });
  type AfterEvent = Parameters<ReturnType<typeof createMcpResultsCollector>["after"]>[0];
  let after: (event: AfterEvent) => void | Promise<void> = () => undefined;
  const context = {
    options: { connectionGate: { url: `http://127.0.0.1:${bridge.port}/decision`, token: "gate-secret" } },
    tool: {
      async hook(name: string, callback: (event: AfterEvent) => void | Promise<void>) {
        if (name === "execute.after") after = callback;
        return { async dispose() {} };
      },
    },
  };
  const close = await plugin.setup(context);
  const result: { output: unknown; metadata?: Record<string, unknown> } = { output: { matches: [], connectionAction: payload } };
  const event: AfterEvent = {
    ...call, sessionID: "ses_1",
    tool: "openwork-cloud_search_capabilities", input: { query: "Notion", intent: "connect" },
    status: "completed", result,
  };
  let returnedToModel = false;
  const pending = Promise.resolve(after(event)).then(() => { returnedToModel = true; });
  try {
    // A blocked result must not become the next model turn while the real user
    // decision is pending. No synthetic model-issued question participates.
    for (let count = 0; count < 50 && !received && !returnedToModel; count++) await delay(10);
    expect(returnedToModel, "The blocked result reached the model before a user decision").toBe(false);
    expect(received).toBe(true);
    answer(Response.json({ outcome: "skipped" }));
    await pending;
    expect(result.metadata?.openworkConnectionDecision).toEqual({ connection: payload, outcome: "skipped" });
    expect(result.output).toMatchObject({ connectionDecision: { outcome: "skipped", alternativeAuthorization: false } });
  } finally {
    answer(Response.json({ outcome: "skipped" }));
    await pending;
    await close();
    await bridge.stop();
  }
});

test("incidental discovery, ambiguous identities and non-member repairs never ask for a decision", async () => {
  const signal = new AbortController().signal;
  const endpoint = { url: "http://127.0.0.1:1/must-not-be-called", token: "unused" };
  for (const output of [
    { matches: [{ connectionStatus: payload }] },
    { connectionStatus: { ...payload, authType: "apikey" } },
    { connectionStatus: { ...payload, credentialMode: "shared" } },
    { connectionStatus: { ...payload, actor: "organization_admin" } },
    { connectionStatus: { ...payload, state: "provider_error" } },
    { connectionStatus: payload, connectionAction: { ...payload, connectionId: "conn_other" } },
  ]) {
    const event: ConnectionToolEvent = { ...call, sessionID: "ses_1", tool: "openwork-cloud_search_capabilities", input: {}, status: "completed", result: { output } };
    expect(await waitForConnectionDecision(event, endpoint, signal)).toBeNull();
    if ("connectionStatus" in output && !("matches" in output)) {
      expect(await waitForConnectionDecision({ ...event, tool: "openwork-cloud_execute_capability" }, endpoint, signal)).toBeNull();
    }
  }
  expect(await waitForConnectionDecision({ ...call, sessionID: "ses_1", tool: "other-server_execute_capability", input: {}, status: "completed", result: { output: payload } }, endpoint, signal)).toBeNull();
});

test("failed calls retain their error identity and release a decision without replaying completed work", async () => {
  const bridge = await serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ outcome: "connected" }) });
  const endpoint = { url: `http://127.0.0.1:${bridge.port}/decision`, token: "test" };
  const collector = createMcpResultsCollector();
  const failure = Object.assign(new Error(JSON.stringify({ error: "needs_connection", connectionStatus: payload })), { type: "failed" });
  const event: ConnectionToolEvent = { ...call, sessionID: "ses_1", tool: "openwork-cloud_execute_capability", input: { name: "notes.write" }, status: "error", error: failure };
  const completedWork = { output: { saved: "report.md" }, metadata: { completedWrite: true } };
  try {
    collector.before({ ...call, tool: "execute" });
    collector.after({ ...call, tool: "write", input: { path: "report.md" }, status: "completed", result: completedWork });
    const decision = await waitForConnectionDecision(event, endpoint, new AbortController().signal);
    expect(event.status).toBe("error");
    expect(event.error).toBe(failure);
    expect(failure.type).toBe("failed");
    expect(JSON.parse(failure.message)).toMatchObject({
      error: "needs_connection", connectionDecision: { outcome: "connected", repeatCompletedWrites: false },
      openworkConnectionDecision: { connection: payload, outcome: "connected" },
    });
    collector.after(event, decision);
    const result: { output: unknown; metadata?: Record<string, unknown> } = { output: { continue: true } };
    collector.after({ ...call, tool: "execute", input: {}, status: "completed", result });
    expect(result.metadata?.openworkConnectionDecision).toEqual({ connection: payload, outcome: "connected" });
    expect(completedWork).toEqual({ output: { saved: "report.md" }, metadata: { completedWrite: true } });
  } finally { await bridge.stop(); }
});

test("multiple connection decisions retain each settled outcome inside one Code Mode call", () => {
  const collector = createMcpResultsCollector();
  collector.before({ ...call, tool: "execute" });
  const first = { connection: payload, outcome: "skipped" } satisfies HostConnectionDecision;
  const second = { connection: { ...first.connection, connectionId: "conn_other", connectionName: "Other notes" }, outcome: "connected" } satisfies HostConnectionDecision;
  collector.after({ ...call, tool: "openwork-cloud_search_capabilities", input: { intent: "connect" }, status: "completed", result: { output: { connectionAction: payload } } }, first);
  collector.after({ ...call, tool: "openwork-cloud_execute_capability", input: {}, status: "completed", result: { output: second.connection } }, second);
  const result: { output: unknown; metadata?: Record<string, unknown> } = { output: {} };
  collector.after({ ...call, tool: "execute", input: {}, status: "completed", result });
  expect(result.metadata?.openworkMcpResults).toEqual([
    { tool: "openwork-cloud_search_capabilities", input: { intent: "connect" }, status: "completed", output: { connectionAction: payload }, decision: first },
    { tool: "openwork-cloud_execute_capability", input: {}, status: "completed", output: second.connection, decision: second },
  ]);
});

test("a decision retains the tool's existing text and file content", async () => {
  const bridge = await serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ outcome: "skipped" }) });
  const content = [{ type: "text", text: "A useful partial result" }, { type: "file", uri: "file:///workspace/report.csv", mime: "text/csv" }];
  const result = { output: payload, content };
  try {
    await waitForConnectionDecision({ ...call, sessionID: "ses_1", tool: "openwork-cloud_execute_capability", input: {}, status: "completed", result },
      { url: `http://127.0.0.1:${bridge.port}/decision`, token: "test" }, new AbortController().signal);
    expect(result.content.slice(0, 2)).toEqual(content);
    expect(result.content).toHaveLength(3);
  } finally { await bridge.stop(); }
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
