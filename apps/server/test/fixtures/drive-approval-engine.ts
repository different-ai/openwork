import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";

export type Answer = { effect: "ask" | "allow" | "deny"; reply?: "once" | "always" | "reject"; eventFailure?: boolean };

/** A deterministic engine permission/event witness, never an automatic grant. */
export async function fakeEngine(answer: Answer) {
  const asked: Array<{ query: string; body: Record<string, unknown> }> = [];
  const streams = new Set<ServerResponse>();
  const remembered = new Set<string>();
  const prompts: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.headers.authorization !== `Basic ${Buffer.from("opencode:secret").toString("base64")}`) return void response.writeHead(401).end();
    if (request.method === "GET" && url.pathname === "/api/event") {
      if (answer.eventFailure) { response.writeHead(503).end(); return; }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`);
      streams.add(response);
      request.on("close", () => streams.delete(response));
      return;
    }
    let text = "";
    request.on("data", chunk => { text += chunk; });
    request.on("end", () => {
      const body: Record<string, unknown> = JSON.parse(text);
      asked.push({ query: url.search, body });
      const id = `per_${asked.length}`;
      const key = JSON.stringify([url.pathname, url.search, body.action, body.resources]);
      const effect = answer.effect === "deny" ? "deny" : remembered.has(key) ? "allow" : answer.effect;
      if (effect === "ask") prompts.push(body);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { id, effect } }));
      if (effect === "ask" && answer.reply) setTimeout(() => {
        if (answer.reply === "always" && Array.isArray(body.save) && body.save.length) remembered.add(key);
        for (const stream of streams) stream.write(`data: ${JSON.stringify({ type: "permission.replied", data: { sessionID: "ses_one", requestID: id, reply: answer.reply } })}\n\n`);
      }, 20);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    asked, prompts, connection: { url: `http://127.0.0.1:${address.port}`, username: "opencode", password: "secret" },
    close: () => { for (const stream of streams) stream.end(); return new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
