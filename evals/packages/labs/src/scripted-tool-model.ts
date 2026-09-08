import { createServer } from "node:http";

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => record(part) && typeof part.text === "string" ? part.text : "").join("\n");
  return "";
}

export type ToolReceipt = { id: string; name: string; args: Record<string, unknown>; output: string };
export type ScriptedToolStep = {
  id: string;
  name: string;
  args: Record<string, unknown> | ((receipts: ToolReceipt[]) => Record<string, unknown>);
  gate?: string;
};
export type ScriptedToolTurn = { prompt: string; reply: string; steps: ScriptedToolStep[] };

/** Only the provider is scripted. Receipts are outputs returned by the real engine. */
export async function scriptedToolModel(turns: ScriptedToolTurn[]) {
  const calls: Omit<ToolReceipt, "output">[] = [];
  const receipts: ToolReceipt[] = [];
  const catalogs: string[][] = [];
  const errors: string[] = [];
  const waiting = new Set<string>();
  const gates = new Map<string, () => void>();
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ object: "list", data: [{ id: "scripted", object: "model" }] })); return;
      }
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404); response.end(); return; }
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 4_000_000) throw new Error("Model witness request exceeded its bound");
      }
      const body: unknown = JSON.parse(raw);
      if (!record(body) || !Array.isArray(body.messages)) throw new Error("Model witness needs chat messages");
      const messages = body.messages.filter(record);
      const lastUser = messages.map((message) => message.role === "user").lastIndexOf(true);
      const prompt = text(messages[lastUser]?.content);
      const turn = turns.find((candidate) => prompt.includes(candidate.prompt));
      const tools = Array.isArray(body.tools) ? body.tools.filter(record) : [];
      const catalog = tools.map((tool) => record(tool.function) && typeof tool.function.name === "string" ? tool.function.name : "");
      catalogs.push(catalog);
      const outputs = messages.slice(lastUser + 1).filter((message) => message.role === "tool");
      for (const output of outputs) {
        const call = calls.find((candidate) => candidate.id === output.tool_call_id);
        if (!call) throw new Error("Unexpected tool result at model witness");
        if (!receipts.some((receipt) => receipt.id === call.id)) receipts.push({ ...call, output: text(output.content) });
      }
      const step = tools.length ? turn?.steps[outputs.length] : undefined;
      const packet = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: "computer-fixture-reply", object: "chat.completion.chunk", created: 1, model: "scripted", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
      response.write(packet({ role: "assistant" }));
      if (step?.gate) {
        const gate = step.gate;
        waiting.add(gate);
        await new Promise<void>((resolve, reject) => {
          const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 2_000);
          const timer = setTimeout(() => finish(new Error(`Unreleased witness gate: ${gate}`)), 60_000);
          const disconnected = () => finish(new Error(`Disconnected witness gate: ${gate}`));
          const finish = (error?: Error) => {
            clearInterval(heartbeat); clearTimeout(timer); gates.delete(gate); waiting.delete(gate);
            response.off("close", disconnected);
            if (error) reject(error); else resolve();
          };
          gates.set(gate, () => finish());
          response.once("close", disconnected);
        });
      }
      if (response.destroyed) return;
      if (step) {
        if (!catalog.includes(step.name)) throw new Error(`Native engine did not advertise ${step.name}`);
        if (calls.some((call) => call.id === step.id)) throw new Error(`Unexpected repeated model step: ${step.id}`);
        const args = typeof step.args === "function" ? step.args(receipts) : step.args;
        calls.push({ id: step.id, name: step.name, args });
        response.write(packet({ tool_calls: [{ index: 0, id: step.id, type: "function", function: { name: step.name, arguments: JSON.stringify(args) } }] }));
        response.write(packet({}, "tool_calls"));
      } else {
        // Native title/summarization requests are harmless text-only replies.
        response.write(packet({ content: turn ? turn.reply : "Disposable window check" }));
        response.write(packet({}, "stop"));
      }
      response.end("data: [DONE]\n\n");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  server.requestTimeout = 90_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Model witness did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, calls, receipts, catalogs, errors, waiting,
    release(gate: string) {
      const release = gates.get(gate);
      if (!release) throw new Error(`Model is not waiting at ${gate}`);
      release();
    },
    async [Symbol.asyncDispose]() {
      for (const release of gates.values()) release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
