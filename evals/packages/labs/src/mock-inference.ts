import { createServer } from "node:http";

export type InferenceFixtureMode = "success" | "tools" | "engine-tool" | "incomplete-tools" | "interrupted" | "malformed" | "rate-limit" | "access-denied" | "stall" | "json" | "incomplete-json";
export type InferenceWitness = { credential: string; body: Record<string, unknown>; cancelled: boolean };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function startInferenceWitness() {
  let mode: InferenceFixtureMode = "success";
  let toolFile = "";
  const requests: InferenceWitness[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const app = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!record(body)) throw new Error("Expected request object");
      const witness = { credential: request.headers.authorization ?? "", body, cancelled: false };
      requests.push(witness);
      response.once("close", () => { witness.cancelled = !response.writableFinished; });
      if (mode === "rate-limit" || mode === "access-denied") {
        response.writeHead(mode === "rate-limit" ? 429 : 401, { "content-type": "application/json", "retry-after": "7" });
        response.end(JSON.stringify({ error: { message: "private provider error payload", metadata: { raw: "private response" } } }));
        return;
      }
      if (mode === "incomplete-json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{" } }] }, finish_reason: "tool_calls" }] }));
        return;
      }
      if (mode === "json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "Complete" }, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 13, total_tokens: 24 } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`;
      response.write(": processing\r\n\r\n");
      if (mode === "engine-tool" && JSON.stringify(body.messages).includes("Read the managed inference fixture") && Array.isArray(body.messages) && !body.messages.some((message) => record(message) && message.role === "tool")) {
        response.write(frame({ tool_calls: [{ index: 0, id: "call_read_fixture", type: "function", function: { name: "read", arguments: JSON.stringify({ filePath: toolFile }).slice(0, 12) } }] }));
        response.end(frame({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ filePath: toolFile }).slice(12) } }] }) + frame({}, "tool_calls") + "data: [DONE]\n\n");
        return;
      }
      if (mode === "stall") {
        response.write(frame({ content: "Partial" }));
        return;
      }
      if (mode === "malformed") {
        response.end(frame({ content: "Partial" }) + "data: {broken\n\n");
        return;
      }
      if (mode === "interrupted") {
        response.end(frame({ content: "Partial" }));
        return;
      }
      if (mode === "tools" || mode === "incomplete-tools") {
        response.write(frame({ reasoning_details: [{ type: "reasoning.text", text: "Fixture reasoning" }] }));
        response.write(frame({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"key":' } }] }));
        if (mode === "tools") response.write(frame({ tool_calls: [{ index: 0, function: { arguments: '"value"}' } }] }));
        response.end(frame({}, "tool_calls") + "data: [DONE]\n\n");
        return;
      }
      // Fragment even a UTF-8 code point and the SSE delimiter across writes.
      const content = Buffer.from(frame({ content: "Complete café" }) + frame({}, "stop") + `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "", role: "assistant" }, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 13, total_tokens: 24, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 3 } } })}\n\ndata: [DONE]\n\n`);
      const split = content.indexOf(Buffer.from("é")) + 1;
      response.write(content.subarray(0, split));
      const timer = setTimeout(() => { timers.delete(timer); response.end(content.subarray(split)); }, 5);
      timers.add(timer);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const address = app.address();
  if (!address || typeof address === "string") throw new Error("Provider fixture failed to bind");
  return {
    url: `http://127.0.0.1:${address.port}/api/v1`, requests,
    mode(next: InferenceFixtureMode) { mode = next; },
    readToolFile(path: string) { toolFile = path; },
    async [Symbol.asyncDispose]() {
      for (const timer of timers) clearTimeout(timer);
      await new Promise<void>((resolve) => { app.close(() => resolve()); app.closeAllConnections(); });
    },
  };
}
