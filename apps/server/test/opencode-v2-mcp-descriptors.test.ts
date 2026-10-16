import assert from "node:assert/strict";
import { test } from "node:test";
import { readV2McpDescriptors, withEngineMcpContributions } from "../src/opencode-v2-mcp-descriptors.js";

const statusPayload = {
  data: [
    { name: "web-search", status: { status: "connected" } },
    { name: "crawler", status: { status: "failed", error: "MCP error" } },
  ],
};

// A fake host: `/workspaces` lists workspaces; each engine answers its own session and MCP routes.
function hostRead(owners: Record<string, string>, mcpByWorkspace: Record<string, unknown>) {
  const reads: string[] = [];
  const read = async (path: string) => {
    reads.push(path);
    if (path === "/workspaces") return { items: [{ id: "ws-a" }, { id: "ws-b" }] };
    const session = /^\/workspace\/([^/]+)\/opencode2\/api\/session\/([^/]+)$/.exec(path);
    if (session) {
      if (owners[decodeURIComponent(session[2])] === session[1]) return { id: session[2] };
      throw new Error("Not found");
    }
    const mcp = /^\/workspace\/([^/]+)\/opencode2\/api\/mcp$/.exec(path);
    if (mcp && mcpByWorkspace[mcp[1]] !== undefined) return mcpByWorkspace[mcp[1]];
    throw new Error(`Unexpected read ${path}`);
  };
  return { read, reads };
}

test("v2 connector status comes from the workspace engine that owns the session", async () => {
  const { read, reads } = hostRead({ ses_1: "ws-b" }, { "ws-b": statusPayload, "ws-a": { data: [] } });
  const descriptors = await readV2McpDescriptors(read, "ses_1");
  assert.deepEqual(descriptors, [
    { name: "web-search", status: "connected", toolAccess: "codemode" },
    { name: "crawler", status: "failed", toolAccess: "codemode" },
  ]);
  assert.equal(reads.includes("/workspace/ws-b/opencode2/api/mcp"), true);
  assert.equal(reads.includes("/workspace/ws-a/opencode2/api/mcp"), false);
});

test("no v2 workspace owning the session yields no connectors", async () => {
  const { read } = hostRead({}, {});
  assert.deepEqual(await readV2McpDescriptors(read, "ses_unknown"), []);
});

test("entries without a usable status are skipped", async () => {
  const { read } = hostRead({ ses_2: "ws-a" }, {
    "ws-a": { data: [{ name: "web-search", status: { status: "connected" } }, { name: "bad" }, "nope"] },
  });
  assert.deepEqual(await readV2McpDescriptors(read, "ses_2"), [{ name: "web-search", status: "connected", toolAccess: "codemode" }]);
});

test("the merge replaces the snapshot's mcp entries and keeps other contributions", () => {
  const context = {
    ok: true,
    context: null,
    availableAffordances: [],
    contributions: [
      { featureId: "sessions", provider: { id: "openwork-server", kind: "builtin" }, affordances: [], guidance: [] },
      { featureId: "mcp:stale", provider: { id: "stale", kind: "mcp" }, affordances: [], guidance: [] },
    ],
  };
  const merged = withEngineMcpContributions(context, [{ name: "web-search", status: "connected", toolAccess: "codemode" }]) as typeof context;
  assert.deepEqual(merged.contributions.map((item) => item.featureId), ["sessions", "mcp:web-search"]);
  const connector = merged.contributions.find((item) => item.featureId === "mcp:web-search") as { status?: string; toolNamespace?: string; toolNamePrefix?: string };
  assert.equal(connector.status, "connected");
  assert.equal(connector.toolNamespace, "web-search");
  assert.equal(connector.toolNamePrefix, undefined);
});

test("the merge also handles the snapshot nested under a context wrapper", () => {
  const context = { ok: true, context: { contributions: [] } };
  const merged = withEngineMcpContributions(context, [{ name: "web-search", status: "connected" }]) as { context: { contributions: { featureId: string }[] } };
  assert.deepEqual(merged.context.contributions.map((item) => item.featureId), ["mcp:web-search"]);
});

test("the merge leaves non-object results alone", () => {
  assert.equal(withEngineMcpContributions("text", []), "text");
});
