import { createServer } from "node:http";

const READS = [
  { service: "google-calendar", name: "gcal_list_events" },
  { service: "gmail", name: "gmail_search_threads" },
  { service: "slack", name: "slack_search_messages" },
  { service: "slack", name: "slack_read_channel" },
] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** MCP replies may be ordinary JSON or an SSE message with one JSON-RPC result. */
async function rpc(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const body = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).find(Boolean)
    : text;
  const parsed: unknown = JSON.parse(body ?? "null");
  if (!record(parsed)) throw new Error("Demo read bridge received no JSON-RPC response");
  return parsed;
}

/**
 * Local Workbot preview only: add direct, allowlisted fixture reads to the runner's tools, next to Den's ordinary tools.
 * Den intentionally requires write scope for external MCP calls, even provider-marked reads; the automatic greeting
 * must not gain write scope to use the demos. These tools instead call this world's in-memory fixtures, never a real
 * provider. All other requests stay on Den's authenticated path, and even a fixture read requires a successful Den
 * tools/list with the caller's token. No production permission check or token is changed.
 */
export async function startWorkbotDemoReads(stack: AsyncDisposableStack, input: { denUrl: string; demoUrl: string }): Promise<string> {
  for (const url of [input.denUrl, input.demoUrl]) {
    if (new URL(url).hostname !== "127.0.0.1") throw new Error("Demo read bridge only accepts this world's loopback services");
  }
  const tools: Array<Record<string, unknown>> = [];
  for (const service of new Set(READS.map((read) => read.service))) {
    const response = await fetch(`${input.demoUrl}/${service}/mcp`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const result = (await rpc(response)).result;
    if (!record(result) || !Array.isArray(result.tools)) throw new Error(`Missing demo ${service} tools`);
    for (const read of READS.filter((read) => read.service === service)) {
      const tool = result.tools.find((tool: unknown) => record(tool) && tool.name === read.name);
      if (!record(tool) || !record(tool.annotations) || tool.annotations.readOnlyHint !== true) {
        throw new Error(`The allowlisted demo read ${read.name} is missing or no longer read-only`);
      }
      tools.push({ ...tool, description: `Read this demo's ${service} directly with this tool; no capability search is needed. ${String(tool.description ?? "")}` });
    }
  }

  const server = createServer(async (request, response) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value && !["host", "connection", "content-length"].includes(name)) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const parsed: unknown = body ? JSON.parse(body) : null;
      const params = record(parsed) && record(parsed.params) ? parsed.params : null;
      const read = record(parsed) && parsed.method === "tools/call" ? READS.find((read) => read.name === params?.name) : undefined;
      if (read) {
        // Authenticate with Den using this same request's credentials before touching the world fixture.
        const auth = await fetch(input.denUrl, {
          method: "POST", headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
          signal: AbortSignal.timeout(20_000),
        });
        const authorized = auth.ok ? await rpc(auth) : null;
        if (!authorized || !record(authorized.result) || !Array.isArray(authorized.result.tools)) {
          response.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "demo_read_unauthorized" }));
          return;
        }
        const fixture = await fetch(`${input.demoUrl}/${read.service}/mcp`, {
          method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body,
          signal: AbortSignal.timeout(20_000),
        });
        response.writeHead(fixture.status, { "content-type": "application/json" }).end(JSON.stringify(await rpc(fixture)));
        return;
      }
      const upstream = await fetch(input.denUrl, {
        method: request.method, headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(120_000),
      });
      const outgoing: Record<string, string> = {};
      for (const name of ["content-type", "mcp-session-id", "cache-control"]) {
        const value = upstream.headers.get(name);
        if (value) outgoing[name] = value;
      }
      if (upstream.ok && record(parsed) && parsed.method === "tools/list") {
        const value = await rpc(upstream);
        if (record(value.result) && Array.isArray(value.result.tools)) value.result.tools.push(...tools);
        response.writeHead(upstream.status, { ...outgoing, "content-type": "application/json" }).end(JSON.stringify(value));
      } else {
        response.writeHead(upstream.status, outgoing);
        if (upstream.body) for await (const chunk of upstream.body) response.write(chunk);
        response.end();
      }
    } catch {
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "demo_read_bridge_failed" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stack.defer(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Demo read bridge did not bind");
  return `http://127.0.0.1:${address.port}/mcp`;
}

/** Startup proves each seeded service is readable with a real read-only Den token, not just discoverable. */
export async function verifyWorkbotDemoReads(url: string, token: string): Promise<void> {
  const calls = [
    { name: "gcal_list_events", arguments: {} },
    { name: "gmail_search_threads", arguments: { query: "in:inbox", limit: 5 } },
    { name: "slack_search_messages", arguments: { query: "rc4", limit: 5 } },
  ];
  for (const [index, params] of calls.entries()) {
    const response = await fetch(url, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: index + 1, method: "tools/call", params }), signal: AbortSignal.timeout(30_000),
    });
    const value = await rpc(response);
    if (!response.ok || value.error || !record(value.result) || value.result.isError === true) throw new Error(`Demo read probe failed: ${params.name}`);
    const data = value.result.structuredContent;
    if (!record(data) || !Object.values(data).some((value) => Array.isArray(value) && value.length > 0)) throw new Error(`Demo read probe returned no data: ${params.name}`);
  }
}
