import { createServer } from "node:http";

export type InferenceFixtureMode = "success" | "tools" | "engine-tool" | "length-tools" | "extra-choice" | "interrupted" | "malformed" | "rate-limit" | "access-denied" | "capability-400" | "capability-422" | "stall" | "partial-frame-stall" | "first-frame" | "first-frame-json" | "first-frame-utf8" | "first-frame-delimiter" | "first-frame-bytes" | "json" | "length-json" | "unfinished-json" | "malformed-json" | "header-stall" | "json-stall" | "heartbeat" | "two-choices" | "two-json";
export type InferenceWitness = { credential: string; body: Record<string, unknown>; cancelled: boolean; partialFrameAt: number | null };

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
      const witness: InferenceWitness = { credential: request.headers.authorization ?? "", body, cancelled: false, partialFrameAt: null };
      requests.push(witness);
      response.once("close", () => { witness.cancelled = !response.writableFinished; });
      if (mode === "header-stall") return;
      if (mode === "rate-limit" || mode === "access-denied" || mode === "capability-400" || mode === "capability-422") {
        const status = mode === "rate-limit" ? 429 : mode === "access-denied" ? 401 : mode === "capability-400" ? 400 : 422;
        response.writeHead(status, { "content-type": "application/json", "retry-after": "7" });
        response.end(JSON.stringify({ error: { code: status === 400 || status === 422 ? "unsupported_parameter" : "fixture_error", message: "private provider error payload", metadata: { raw: "private response", parameter: "reasoning.effort" } } }));
        return;
      }
      if (mode === "json-stall" || mode === "malformed-json") {
        response.writeHead(200, { "content-type": "application/json" });
        if (mode === "json-stall") response.write('{"choices":');
        else response.end("{invalid");
        return;
      }
      if (mode === "length-json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{" } }] }, finish_reason: "length" }], usage: { total_tokens: 24 } }));
        return;
      }
      if (mode === "json" || mode === "unfinished-json" || mode === "two-json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: Array.from({ length: mode === "two-json" ? 2 : 1 }, (_, index) => ({ index, message: { role: "assistant", content: mode === "two-json" ? `Choice ${index}` : "Complete", tool_calls: null }, finish_reason: mode === "unfinished-json" ? null : "stop" })), usage: { prompt_tokens: 11, completion_tokens: 13, total_tokens: 24 } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`;
      if (mode === "heartbeat") {
        const started = Date.now();
        const beat = () => {
          if (response.destroyed) return;
          if (Date.now() - started >= 3200) {
            response.end(frame({ content: "Complete" }, "stop") + "data: [DONE]\n\n");
            return;
          }
          response.write(": processing\n\n");
          const timer = setTimeout(() => { timers.delete(timer); beat(); }, 100);
          timers.add(timer);
        };
        beat();
        return;
      }
      if (mode === "two-choices") {
        response.write(`data: ${JSON.stringify({ choices: [0, 1].map((index) => ({ index, delta: { content: `Choice ${index}` }, finish_reason: null })) })}\n\n`);
        response.end(`data: ${JSON.stringify({ choices: [1, 0].map((index) => ({ index, delta: {}, finish_reason: "stop" })) })}\n\ndata: ${JSON.stringify({ choices: [], usage: { total_tokens: 24 } })}\n\ndata: [DONE]\n\n`);
        return;
      }
      // No heartbeat or complete frame may precede these first-read regressions.
      if (mode === "partial-frame-stall") {
        response.write('data: {"choices":[{"index":0,"delta":{"content":"Partial', () => { witness.partialFrameAt = Date.now(); });
        return;
      }
      if (mode.startsWith("first-frame")) {
        const firstFrame = Buffer.from(frame({ content: "Complete café", reasoning_details: [{ type: "reasoning.text", text: "Fixture reasoning" }], tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"key":' } }] }));
        const ending = frame({ tool_calls: [{ index: 0, function: { arguments: '"value"}' } }] }) + frame({}, "tool_calls") + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 13, total_tokens: 24, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 3 } } })}\n\ndata: [DONE]\n\n`;
        const cuts = mode === "first-frame-json" ? [firstFrame.indexOf('"choices"') + 5]
          : mode === "first-frame-utf8" ? [firstFrame.indexOf(Buffer.from("é")) + 1]
          : mode === "first-frame-delimiter" ? [firstFrame.length - 1]
          : mode === "first-frame-bytes" ? Array.from({ length: firstFrame.length - 1 }, (_, index) => index + 1) : [];
        request.socket.setNoDelay(true);
        const write = (index: number, start: number) => {
          if (response.destroyed) return;
          const end = cuts[index];
          if (end === undefined) {
            response.end(Buffer.concat([firstFrame.subarray(start), Buffer.from(ending)]));
            return;
          }
          response.write(firstFrame.subarray(start, end));
          // Yield between HTTP writes so the gateway must consume partial data.
          const timer = setTimeout(() => { timers.delete(timer); write(index + 1, end); }, mode === "first-frame-bytes" ? 2 : 50);
          timers.add(timer);
        };
        write(0, 0);
        return;
      }
      response.write(": processing\r\n\r\n");
      if (mode === "extra-choice") {
        response.end(frame({ content: "Partial" }) + `data: ${JSON.stringify({ choices: [{ index: 1, delta: { content: "Unrequested second choice" }, finish_reason: "stop" }] })}\n\n` + frame({}, "stop") + "data: [DONE]\n\n");
        return;
      }
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
      if (mode === "tools" || mode === "length-tools") {
        response.write(frame({ reasoning_details: [{ type: "reasoning.text", text: "Fixture reasoning" }] }));
        response.write(frame({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"key":' } }] }));
        if (mode === "tools") response.write(frame({ tool_calls: [{ index: 0, function: { arguments: '"value"}' } }] }));
        response.end(frame({}, mode === "length-tools" ? "length" : "tool_calls") + `data: ${JSON.stringify({ choices: [], usage: { total_tokens: 24 } })}\n\ndata: [DONE]\n\n`);
        return;
      }
      // Keep the original heartbeat-backed UTF-8 fragmentation coverage too.
      const content = Buffer.from(frame({ content: "Complete café" }) + frame({}, "stop") + `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "", role: "assistant", tool_calls: [], reasoning_details: [] }, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 13, total_tokens: 24, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 3 } } })}\n\ndata: [DONE]\n\n`);
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
