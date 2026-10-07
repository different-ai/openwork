#!/usr/bin/env node
// 零依赖最小 stdio MCP server：手写 JSON-RPC，3 个工具。
// 作为 mcp.test-endpoint.e2e.test.ts 的 fixture，验证 /test 端点 probeMcpToolCount。
import * as readline from "node:readline";

const TOOLS = [
  { name: "tool_a", description: "Probe tool A", inputSchema: { type: "object", properties: { note: { type: "string" } }, required: [] } },
  { name: "tool_b", description: "Probe tool B", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "tool_c", description: "Probe tool C", inputSchema: { type: "object", properties: {}, required: [] } },
];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method } = msg;
  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "probe-mock", version: "1.0.0" },
        },
      });
      break;
    case "tools/list":
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      break;
    case "tools/call":
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "mock ok" }] } });
      break;
    case "ping":
      send({ jsonrpc: "2.0", id, result: {} });
      break;
    default:
      if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
  }
});

process.stderr.write("[probe-mock] raw JSON-RPC MCP ready on stdio\n");
