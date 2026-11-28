import { afterEach, describe, expect, test } from "bun:test";
import { mcpEventsBridgeInput, registerMcpEventTool, type McpEventToolCall } from "../src/opencode-plugins/openwork-mcp-server-events-v2.js";

describe("the agent's MCP events tool", () => {
  let stop: (() => Promise<void>) | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(async () => { await stop?.(); server?.stop(true); });

  test("is offered only while a server on this computer offers events", async () => {
    let servers = ["tracker"];
    server = Bun.serve({ port: 0, async fetch() { return Response.json({ ok: true, servers }); } });
    const tools = new Map<string, { execute(input: unknown, call: Parameters<McpEventToolCall>[2]): Promise<unknown> }>();
    const calls: unknown[] = [];
    let tick: (() => void) | undefined;
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((callback: () => void) => {
      tick = callback;
      return { unref() {} };
    }) as unknown as typeof setInterval;
    try {
      stop = await registerMcpEventTool({
        options: { url: `http://127.0.0.1:${server.port}/read`, token: "t" },
        tool: { async transform(callback) {
          const added: string[] = [];
          callback({ add: tool => { added.push(tool.name); tools.set(tool.name, tool); } });
          return { dispose: async () => { for (const name of added) tools.delete(name); } };
        } },
      }, async (name, input) => { calls.push({ name, input }); return { content: [{ type: "text", text: "ok" }] }; });
    } finally {
      globalThis.setInterval = realSetInterval;
    }
    for (let attempt = 0; attempt < 100 && tools.size === 0; attempt++) await Bun.sleep(10);
    expect([...tools.keys()]).toEqual(["mcp_events"]);

    await tools.get("mcp_events")?.execute({ action: "watch", server: "tracker", name: "issue.created", instruction: "Tell me." }, { signal: new AbortController().signal, sessionID: "ses_1" });
    expect(calls).toEqual([{ name: "openwork_mcp_events", input: { action: "watch", server: "tracker", name: "issue.created", arguments: {}, instruction: "Tell me." } }]);

    servers = [];
    tick?.();
    for (let attempt = 0; attempt < 100 && tools.size > 0; attempt++) await Bun.sleep(10);
    expect(tools.size).toBe(0);
  });

  test("asks for what a watch or a stop needs before calling OpenWork", () => {
    expect(mcpEventsBridgeInput({ action: "list" })).toEqual({ action: "list" });
    expect(mcpEventsBridgeInput({ action: "list", server: "tracker", id: "ignored" })).toEqual({ action: "list", server: "tracker" });
    expect(mcpEventsBridgeInput({ action: "stop", id: "abc" })).toEqual({ action: "stop", id: "abc" });
    expect(() => mcpEventsBridgeInput({ action: "stop" })).toThrow("stop needs the watch's id");
    expect(() => mcpEventsBridgeInput({ action: "watch", server: "tracker" })).toThrow("watch needs server, name, arguments and instruction.");
  });
});
