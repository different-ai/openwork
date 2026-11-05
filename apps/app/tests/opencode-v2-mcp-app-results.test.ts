import { describe, expect, test } from "bun:test";
import { codeModeConnectionParts } from "../src/app/lib/opencode-v2-adapter";
import { createMcpResultsCollector } from "../../server/src/opencode-plugins/openwork-mcp-results-v2";

describe("Code Mode MCP App results", () => {
  for (const structuredContent of [{ state: "ask_email" }, { draft_id: "draft_fixture", result: "Draft created; not sent." }]) {
    test(`preserves ${Object.keys(structuredContent)[0]} for the App renderer after transcript reload`, () => {
      const collector = createMcpResultsCollector();
      const identity = { messageID: "msg_fixture", id: "call_fixture" };
      const launch = { connectionId: "emc_fixture", toolName: "open_card", resourceUri: "ui://fixture/card.html", arguments: {} };
      const result = {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
        _meta: { "openwork/mcpApp": launch, "fixture/private": { value: "host-only" } },
        isError: false,
      };
      collector.before({ ...identity, tool: "execute", input: { code: "return await tools.gateway.open_card({});" } });
      const input = { name: "mcp:emc_fixture:open_card", body: {} };
      collector.before({ ...identity, tool: "openwork-cloud.execute_capability", input });
      collector.after({ ...identity, tool: "openwork-cloud.execute_capability", input, status: "completed",
        result: { output: structuredContent, metadata: { mcp: result } } });
      const outer: { output: string; metadata?: Record<string, unknown> } = { output: JSON.stringify(structuredContent) };
      collector.after({ ...identity, tool: "execute", input: {}, status: "completed", result: outer });
      // The engine persists JSON metadata; a reload must not need the original tool object or a new invocation.
      const metadata: Record<string, unknown> = JSON.parse(JSON.stringify(outer.metadata));
      const parts = codeModeConnectionParts({
        id: identity.id, callID: identity.id, messageID: identity.messageID, sessionID: "ses_fixture", type: "tool", tool: "execute",
        metadata: { openworkV2CodeMode: true },
        state: { status: "completed", input: {}, output: outer.output, title: "Execute", time: { start: 1, end: 2 }, metadata },
      });
      expect(parts).toHaveLength(1);
      const part = parts[0];
      expect(part?.state.status).toBe("completed");
      if (!part || part.state.status !== "completed") throw new Error("App launch tool part missing");
      expect(part.state.metadata.openworkMcpResult).toEqual(result);
      expect(part.state.output).toBe(JSON.stringify(structuredContent));
      expect(part.state.output).not.toContain("host-only");
      expect(outer.output).not.toContain("host-only");
    });
  }
});
