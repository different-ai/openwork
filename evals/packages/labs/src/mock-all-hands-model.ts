import { createServer } from "node:http";

/** A local model witness: real engine requests and streaming, no provider spend. */
export async function allHandsModel() {
  const prompts: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url?.endsWith("/models")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ object: "list", data: [{ id: "team", object: "model" }] })); return;
    }
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) { response.writeHead(404); response.end(); return; }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    prompts.push(raw);
    const routing = raw.includes("You are the facilitator of the group chat") || raw.includes("Your last answer was not accepted");
    const text = routing
      ? JSON.stringify({ speakers: [{ slug: "scout", brief: "Check the current evidence." }, { slug: "editor", brief: "Summarize the evidence for the person." }], mode: "sequential", dependsOn: [["editor", "scout"]], followUp: null, synthesizer: null })
      : "The team is ready to review the launch. I recommend checking the remaining customer blockers first; I have not taken any external action.";
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const packet = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: "all-hands-reply", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "team", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    response.write(packet({ role: "assistant", content: text }));
    response.write(packet({}, "stop")); response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Model witness did not bind");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, prompts, async [Symbol.asyncDispose]() { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}
