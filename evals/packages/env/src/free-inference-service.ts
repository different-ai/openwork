import { createServer } from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

export interface UpstreamPlan {
  cost: number | null;
  hold?: boolean;
}

export interface UpstreamCall {
  prompt: string;
  url: string;
  authorization: string | null;
  redirect: RequestRedirect | undefined;
  requestId: string;
  generationId: string;
  body: Record<string, unknown>;
}

export function record(value: unknown): Record<string, unknown> {
  const isRecord = (input: unknown): input is Record<string, unknown> => Boolean(input) && typeof input === "object" && !Array.isArray(input);
  if (!isRecord(value)) throw new Error("Expected a JSON object");
  return value;
}

export async function bootFreeInferenceService() {
  const plans = new Map<string, UpstreamPlan>();
  const gates = new Map<string, Array<() => void>>();
  const calls: UpstreamCall[] = [];

  // Install before importing the app: its default proxy dependency captures fetch.
  // There is deliberately no network fallback, even for an unexpected URL.
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== "https://openrouter.ai/api/v1/chat/completions") throw new Error(`Unexpected upstream: ${url}`);
    if (typeof init?.body !== "string") throw new Error("Expected a serialized completion");
    const body = record(JSON.parse(init.body));
    const messages = body.messages;
    if (!Array.isArray(messages)) throw new Error("Expected messages");
    const prompt = record(messages[0]).content;
    if (typeof prompt !== "string") throw new Error("Expected a text prompt");
    const plan = plans.get(prompt);
    if (!plan) throw new Error("Unplanned upstream request");
    const headers = new Headers(init.headers);
    const requestId = headers.get("x-openwork-request-id");
    if (!requestId) throw new Error("Missing request identity");
    const generationId = `gen-${requestId}`;
    calls.push({ prompt, url, authorization: headers.get("authorization"), redirect: init.redirect, requestId, generationId, body });
    if (plan.hold) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Unreleased upstream fixture")), 20_000);
        const release = () => { clearTimeout(timer); resolve(); };
        gates.set(prompt, [...(gates.get(prompt) ?? []), release]);
      });
    }
    const usage = { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, ...(plan.cost === null ? {} : { cost: plan.cost }) };
    const identity = { id: generationId, model: body.model };
    if (!body.stream) {
      return Response.json({ ...identity, choices: [{ index: 0, message: { role: "assistant", content: "Fixture reply: caf\u00e9" }, finish_reason: "stop" }], usage });
    }
    const wire = [
      { ...identity, choices: [{ index: 0, delta: { content: "Fixture reply: caf\u00e9" }, finish_reason: null }] },
      { ...identity, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { ...identity, choices: [], usage },
      "[DONE]",
    ].map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\r\n\r\n`).join("");
    const bytes = new TextEncoder().encode(wire);
    let offset = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        // Split inside UTF-8, JSON and SSE delimiters, not just between events.
        controller.enqueue(bytes.slice(offset, ++offset));
      },
    }), { headers: { "content-type": "text/event-stream" } });
  };

  const { default: app } = await import("../../../../ee/apps/inference/src/app.ts");
  app.get("/__fixture/upstream", (c) => c.json(calls));
  app.post("/__fixture/plan", async (c) => {
    const body = record(await c.req.json());
    if (typeof body.prompt !== "string" || (body.cost !== null && typeof body.cost !== "number")) return c.body(null, 400);
    plans.set(body.prompt, { cost: body.cost, hold: body.hold === true });
    return c.body(null, 204);
  });
  app.post("/__fixture/release", async (c) => {
    const body = record(await c.req.json());
    if (typeof body.prompt !== "string") return c.body(null, 400);
    for (const release of gates.get(body.prompt) ?? []) release();
    gates.delete(body.prompt);
    return c.body(null, 204);
  });

  const server = createServer(async (request, response) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const reader = Readable.toWeb(request).getReader();
      const init = {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : new ReadableStream<Uint8Array>({
          async pull(controller) {
            const chunk = await reader.read();
            if (chunk.done) controller.close();
            else controller.enqueue(chunk.value);
          },
          cancel: (reason) => reader.cancel(reason),
        }),
        duplex: "half",
      };
      const result = await app.fetch(new Request(`http://127.0.0.1${request.url}`, init));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      const output = result.body?.getReader();
      if (output) for (;;) {
        const chunk = await output.read();
        if (chunk.done) break;
        response.write(chunk.value);
      }
      response.end();
    } catch (error) {
      console.error(error);
      response.writeHead(500).end();
    }
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    process.send?.({ url: `http://127.0.0.1:${address.port}` });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await bootFreeInferenceService();
