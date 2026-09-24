import { createInterface } from "node:readline";
import { appendFileSync, readFileSync } from "node:fs";

// A real local stdio MCP. The model must choose and call it; answers are not
// scripted. The changing proof lives outside the agent's workspace.
const [proofPath, witnessPath] = process.argv.slice(2);
if (!proofPath || !witnessPath) throw new Error("Expected proof and witness paths");
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  let result;
  if (message.method === "initialize") result = {
    protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "live-report", version: "1.0.0" },
  };
  else if (message.method === "ping") result = {};
  else if (message.method === "tools/list") result = { tools: [{ name: "current_report", description: "Read the current amber verification report. Always fetch fresh data.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] };
  else if (message.method === "tools/call" && message.params?.name === "current_report") {
    const proof = readFileSync(proofPath, "utf8").trim();
    appendFileSync(witnessPath, JSON.stringify({ tool: "current_report", proof, time: Date.now() }) + "\n");
    result = { content: [{ type: "text", text: proof }] };
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown method or tool" } }) + "\n");
    continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
}
