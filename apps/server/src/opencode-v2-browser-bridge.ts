import { randomBytes } from "node:crypto";
import { z } from "zod";
import { serve } from "./serve-node.js";
import { server as browserTools } from "./opencode-plugins/openwork-chrome-devtools.js";

const requestSchema = z.object({
  name: z.enum(["browser_tabs", "browser_open", "browser_observe", "browser_act", "browser_navigate", "browser_handoff"]),
  input: z.unknown(),
  sessionId: z.string().min(1),
});

/** Only the existing conversation-scoped browser tools, with their usual
 * approval and policy checks. This credential does not authorize app commands
 * or the read bridge; the desktop's browser credential stays in the host. */
export async function createV2BrowserBridge() {
  const token = randomBytes(32).toString("base64url");
  const tools = await browserTools();
  const server = await serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/browser") return new Response(null, { status: 404 });
    try {
      const text = await request.text();
      if (text.length > 64_000) return new Response(null, { status: 413 });
      const call = requestSchema.parse(JSON.parse(text));
      const result = await tools.tool[call.name].execute(call.input, { sessionID: call.sessionId, abort: request.signal });
      if (typeof result === "string") return Response.json({ content: [{ type: "text", text: result }] });
      return Response.json({ content: [{ type: "text", text: result.output },
        ...result.attachments.map(file => ({ type: "file", uri: file.url, mime: file.mime }))], metadata: result.metadata });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Browser request failed" }, { status: 400 });
    }
  } });
  return { url: `http://127.0.0.1:${server.port}/browser`, token, close: () => server.stop() };
}
