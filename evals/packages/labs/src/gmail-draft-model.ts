import { createServer } from "node:http";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// MCP text can arrive as JSON text, a content array, or a structured envelope.
export function gmailResultObjects(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 10) return [];
  if (typeof value === "string") {
    try { return gmailResultObjects(JSON.parse(value), depth + 1); } catch { return []; }
  }
  if (Array.isArray(value)) return value.flatMap((item) => gmailResultObjects(item, depth + 1));
  if (!record(value)) return [];
  return [value, ...Object.values(value).flatMap((item) => gmailResultObjects(item, depth + 1))];
}

export interface GmailModelPlan {
  prompt: string;
  query: string;
  capability: string;
  body: Record<string, unknown>;
}

/** Deterministic model only; search and execution are performed by the real engine. */
export async function gmailDraftModel() {
  const plans: GmailModelPlan[] = [];
  const inputs: unknown[] = [];
  const emitted: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const failures: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url?.endsWith("/api.json")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      const input: unknown = JSON.parse(raw);
      if (!record(input)) throw new Error("Model input must be an object");
      inputs.push(input);
      const messages = Array.isArray(input.messages) ? input.messages.filter(record) : [];
      const plan = plans.findLast((candidate) => messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes(candidate.prompt)));
      const tools = Array.isArray(input.tools) ? input.tools.filter(record) : [];
      const advertised = tools.flatMap((tool) => record(tool.function) && typeof tool.function.name === "string" ? [tool.function.name] : []);
      const results = messages.filter((message) => message.role === "tool");
      let call: { tool: string; args: Record<string, unknown> } | undefined;
      if (plan && advertised.includes("openwork-cloud_search_capabilities")) {
        if (results.length === 0) {
          call = { tool: "openwork-cloud_search_capabilities", args: { query: plan.query, limit: 20 } };
        } else if (results.length === 1) {
          const found = gmailResultObjects(results[0].content).find((entry) => entry.name === plan.capability);
          if (!found) throw new Error(`Real search did not return selected capability ${plan.capability}`);
          if (!advertised.includes("openwork-cloud_execute_capability")) throw new Error("Managed execute capability was not advertised");
          call = { tool: "openwork-cloud_execute_capability", args: { name: found.name, body: plan.body, ...(typeof found.schemaDigest === "string" ? { schemaDigest: found.schemaDigest } : {}) } };
        }
      }
      if (call) emitted.push(call);
      const delta = call
        ? { tool_calls: [{ index: 0, id: `call_gmail_${results.length}`, type: "function", function: { name: call.tool, arguments: JSON.stringify(call.args) } }] }
        : { content: plan ? "Draft attachment check complete." : "Fixture conversation" };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of [
        { id: "gmail-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
        { id: "gmail-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] },
      ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Deterministic Gmail model rejected the request" }));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Model did not bind a port");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    plan: (plan: GmailModelPlan) => { plans.push(plan); },
    inputs: () => inputs.slice(),
    emitted: () => emitted.slice(),
    failures: () => failures.slice(),
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
