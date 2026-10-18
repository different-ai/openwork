import { describe, expect, test } from "bun:test";
import type { ToolPart } from "@opencode-ai/sdk/v2/client";
import { codeModeConnectionParts } from "../src/app/lib/opencode-v2-adapter";
import plugin, { createMcpResultsCollector } from "../../server/src/opencode-plugins/openwork-mcp-results-v2";
import { parseDynamicToolUIPart } from "../src/react-app/domains/session/sync/parse-tool-parts";
import { mcpAppSourceSchema } from "@openwork/types/mcp-app";

const event = { messageID: "message", id: "execute" };
const launch = { appId: "app", title: "Project board", resourceUri: "ui://project-board" };
const result = { app: { title: "Project board" }, launch };
function parent(metadata: Record<string, unknown>, status: "running" | "completed" | "error"): ToolPart {
  const base = { id: "execute", callID: "execute", messageID: "message", sessionID: "session", type: "tool" as const,
    tool: "execute", metadata: { openworkV2CodeMode: true } };
  if (status === "running") return { ...base, state: { status, input: {}, metadata, title: "execute", time: { start: 1 } } };
  if (status === "error") return { ...base, state: { status, input: {}, metadata, error: "Later script failure", time: { start: 1, end: 10 } } };
  return { ...base, state: { status, input: {}, metadata, output: "arbitrary script return", title: "execute", time: { start: 1, end: 10 } } };
}

test("direct MCP calls keep their own result without script projection", () => {
  const direct: ToolPart = { id: "direct", callID: "direct", messageID: "message", sessionID: "session", type: "tool", tool: "openwork_create_app",
    state: { status: "completed", input: {}, output: JSON.stringify(result), title: "App", metadata: { openworkMcpResult: { structuredContent: result, _meta: { "openwork/mcpApp": launch } } }, time: { start: 1, end: 2 } } };
  expect(codeModeConnectionParts(direct)).toEqual([]);
  expect(parseDynamicToolUIPart(direct)?.callProviderMetadata?.openwork?.mcpResult).toMatchObject({ _meta: { "openwork/mcpApp": launch } });
});

test("a previously persisted successful inner receipt survives a later script error", () => {
  const [app] = codeModeConnectionParts(parent({ openworkMcpResults: [{ tool: "openwork_create_app", input: {}, status: "completed", output: result }],
    toolCalls: [{ tool: "openwork.create_app", input: {}, status: "completed" }] }, "error"));
  expect(app?.state).toMatchObject({ status: "completed", metadata: { openworkMcpResult: { _meta: { "openwork/mcpApp": launch } } } });
});

for (const status of ["running", "completed", "error"] as const) {
  test(`a completed App retains its launch while its parent is ${status}`, () => {
    const collector = createMcpResultsCollector();
    collector.before({ ...event, tool: "execute" });
    const input = { title: "Project board", reactSource: "x".repeat(40_000) };
    const call = { ...event, tool: "openwork-cloud.create_app", input };
    collector.before(call);
    const id = collector.claim(call)!;
    collector.settle(event, id, { status: "completed", output: result });
    const metadata = collector.metadata(event);
    const outer = parent(metadata, status);
    const [app] = codeModeConnectionParts(outer);
    expect(app?.state.status).toBe("completed");
    expect(app?.state).toMatchObject({ metadata: { openworkMcpResult: { _meta: { "openwork/mcpApp": launch } } } });
    if (status === "error") expect(outer.state).toMatchObject({ error: "Later script failure" });
  });
}

for (const size of [70_000, 200_000]) test(`a supported ${size}-byte source cannot displace its complete App launch`, () => {
  const prefix = "export default function Board(){return null;}\n//";
  const source = prefix + "x".repeat(size - prefix.length);
  expect(source.length).toBe(size);
  expect(mcpAppSourceSchema.safeParse({ reactSource: source, cssSource: "" }).success).toBe(true);
  const collector = createMcpResultsCollector();
  collector.before({ ...event, tool: "execute" });
  const call = { ...event, tool: "openwork.create_app", input: { title: "Project board", reactSource: source } };
  collector.before(call);
  collector.settle(event, collector.claim(call)!, { status: "completed", output: result });
  const metadata = collector.metadata(event);
  expect(metadata).toMatchObject({ openworkToolDetails: [{ inputTruncated: true, output: result }],
    openworkMcpResults: [{ input: { title: "Project board" }, output: result }] });
  const [app] = codeModeConnectionParts(parent(metadata, "error"));
  expect(app?.state).toMatchObject({ status: "completed", metadata: { openworkMcpResult: { _meta: { "openwork/mcpApp": launch } } } });
  expect(app?.state.input.reactSource).toBeUndefined();
});

test("legacy combined truncation never discards a complete structured output", () => {
  const [app] = codeModeConnectionParts(parent({ openworkToolDetails: [{ invocationId: "execute:0", ordinal: 0,
    tool: "openwork_create_app", input: "[Input preview]", status: "completed", startedAt: 1, truncated: true, output: result }] }, "error"));
  expect(app?.state).toMatchObject({ status: "completed", metadata: { openworkMcpResult: { _meta: { "openwork/mcpApp": launch } } } });
});

test("the success hook keeps one receipt after the tool wrapper already settled it", () => {
  const collector = createMcpResultsCollector();
  collector.before({ ...event, tool: "execute" });
  const call = { ...event, tool: "openwork.create_app", input: { title: "Project board" } };
  collector.before(call);
  collector.settle(event, collector.claim(call)!, { status: "completed", output: result });
  collector.after({ ...call, status: "completed", result: { output: result } });
  const outer: Parameters<typeof collector.after>[0] = { ...event, tool: "execute", input: {}, status: "completed", result: { output: "not the App" } };
  collector.after(outer);
  expect(outer.result.metadata?.openworkMcpResults).toHaveLength(1);
  expect(codeModeConnectionParts(parent(outer.result.metadata!, "completed"))[0]?.state.status).toBe("completed");
});

test("parallel App results keep invocation identity when they finish in reverse order", () => {
  const collector = createMcpResultsCollector();
  collector.before({ ...event, tool: "execute" });
  const calls = ["First board", "Second board"].map(title => ({ ...event, tool: "openwork-cloud.create_app", input: { title } }));
  calls.forEach(call => collector.before(call));
  const ids = calls.map(call => collector.claim(call)!);
  collector.settle(event, ids[1]!, { status: "completed", output: { launch: { ...launch, title: "Second board" } } });
  const live = codeModeConnectionParts(parent(collector.metadata(event), "running"));
  expect(live.map(call => call.state.status)).toEqual(["running", "completed"]);
  const secondId = live[1]!.callID;
  collector.settle(event, ids[0]!, { status: "completed", output: { launch: { ...launch, title: "First board" } } });
  const done = codeModeConnectionParts(parent(collector.metadata(event), "error"));
  expect(done.map(call => call.state.input.title)).toEqual(["First board", "Second board"]);
  expect(done[1]!.callID).toBe(secondId);
  expect(done.every(call => call.state.status === "completed")).toBe(true);
});

test("older status-only captures retain successful calls without inventing a launch", () => {
  const [app] = codeModeConnectionParts(parent({ toolCalls: [{ tool: "openwork-cloud.create_app", input: {}, status: "completed" }] }, "error"));
  expect(app?.state).toMatchObject({ status: "completed", output: JSON.stringify({ unrecorded: true }) });
});

for (const source of [
  { title: "decoded output", result: { output: result } },
  { title: "standard MCP envelope", result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, _meta: { "openwork/mcpApp": launch } } },
  { title: "MCP text projection", result: { content: [{ type: "text", text: JSON.stringify(result) }] } },
]) test(`the actual tool wrapper persists ${source.title} before the script can fail`, async () => {
  type Context = Parameters<typeof plugin.setup>[0];
  type Editor = Parameters<Parameters<Context["tool"]["transform"]>[0]>[0];
  type Editable = Parameters<Parameters<Editor["update"]>[1]>[0];
  let before: ((event: { tool: string; messageID: string; id: string; input: unknown }) => void) | undefined;
  const call = { ...event, tool: "openwork-cloud.create_app", input: { title: "Project board" } };
  const tool: Editable = { async execute() { return source.result; } };
  const context: Context = { tool: {
    async transform(update) {
      update({ get: () => undefined, list: () => [{ id: call.tool }], update: (_id, wrap) => wrap(tool) });
      return { async dispose() {} };
    },
    async hook(...args:
      | ["execute.before", (event: Parameters<ReturnType<typeof createMcpResultsCollector>["before"]>[0] & { input: unknown }) => void]
      | ["execute.after", (event: Parameters<ReturnType<typeof createMcpResultsCollector>["after"]>[0]) => void]
    ) {
      if (args[0] === "execute.before") before = args[1];
      return { async dispose() {} };
    },
  } };
  const dispose = await plugin.setup(context);
  before?.({ ...event, tool: "execute", input: {} });
  before?.(call);
  const progress: Record<string, unknown>[] = [];
  await tool.execute(call.input, { ...event, async progress(metadata) { progress.push(metadata); } });
  const [app] = codeModeConnectionParts(parent(progress.at(-1)!, "error"));
  expect(app?.state.status).toBe("completed");
  expect(JSON.stringify(app)).toContain("ui://project-board");
  await dispose();
});
