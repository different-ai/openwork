import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { startWorkbotDemoReads, verifyWorkbotDemoReads } from "./workbot-demo-reads.ts";

const reads = ["gcal_list_events", "gmail_search_threads", "slack_search_messages", "slack_read_channel"];

test("demo reads authenticate with Den and never grant a greeting write access", async () => {
  await using stack = new AsyncDisposableStack();
  const called: string[] = [];
  const provider = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const rpc = JSON.parse(body);
    response.setHeader("content-type", "application/json");
    if (request.url === "/den") {
      if (request.headers.authorization !== "Bearer read-only-fixture") { response.writeHead(401).end("{}"); return; }
      if (rpc.method === "tools/list") response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { tools: [] } }));
      else response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { isError: true, content: [{ type: "text", text: "insufficient_mcp_scope" }] } }));
      return;
    }
    if (rpc.method === "tools/list") {
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { tools: [...reads.map((name) => ({ name, description: name, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } })), { name: "gmail_send", annotations: { readOnlyHint: false } }] } }));
    } else {
      called.push(rpc.params.name);
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { isError: false, structuredContent: { items: [{ title: "seeded data" }] } } }));
    }
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  stack.defer(async () => {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  });
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  const url = await startWorkbotDemoReads(stack, { denUrl: `${base}/den`, demoUrl: base });
  const call = (name: string, token: string) => fetch(url, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
  });
  await verifyWorkbotDemoReads(url, "read-only-fixture");
  assert.deepEqual(called, ["gcal_list_events", "gmail_search_threads", "slack_search_messages"]);
  const blocked = await call("gmail_send", "read-only-fixture");
  assert.equal((await blocked.json()).result.isError, true);
  assert.equal(called.length, 3, "a write never reaches the fixture");
  const unauthorized = await call("gcal_list_events", "not-authorized");
  assert.equal(unauthorized.status, 403);
  assert.equal(called.length, 3, "an invalid token never reaches the fixture");
  await assert.rejects(startWorkbotDemoReads(stack, { denUrl: "https://api.example.test/mcp", demoUrl: base }), /loopback/);
});
