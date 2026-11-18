import { createServer, type IncomingHttpHeaders } from "node:http";

export type CatalogTransportMode = "json" | "sse-lf" | "sse-cr" | "sse-crlf" | "older-version" |
  "unsupported-version" | "missing-version" | "initialize-error" | "notification-rejected" |
  "notification-rpc-error" | "read-error" | "wrong-id" | "wrong-json-id" | "unfinished-stream";

export async function startCatalogTransportWitness(mode: CatalogTransportMode) {
  const requests: Array<{ method: string; headers: IncomingHttpHeaders; rpc: Record<string, unknown> }> = [];
  const version = mode === "older-version" ? "2025-03-26" : "2025-06-18";
  const skill = {
    name: "transport-witness", type: "skill-md", title: "Transport witness",
    description: "Synthetic catalog interoperability witness", url: "skill://transport-witness",
    capability: "skill:transport-witness",
  };
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const rpc: Record<string, unknown> = JSON.parse(raw);
    requests.push({ method: request.method, headers: request.headers, rpc });
    const json = (status: number, payload: unknown) => {
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
    };
    const error = { jsonrpc: "2.0", id: rpc.id, error: { code: -32603, message: "Synthetic RPC rejection" } };
    if (request.headers.authorization !== "Bearer synthetic-catalog-token" ||
      !request.headers.accept?.includes("application/json") || !request.headers.accept.includes("text/event-stream")) {
      json(400, error);
      return;
    }
    if (rpc.method !== "initialize" &&
      (request.headers["mcp-protocol-version"] !== version || request.headers["mcp-session-id"] !== "synthetic-session")) {
      json(400, error);
      return;
    }
    if (rpc.method === "notifications/initialized") {
      if (mode === "notification-rejected") json(400, error);
      else if (mode === "notification-rpc-error") json(202, error);
      else response.writeHead(202).end();
      return;
    }
    const initialize = rpc.method === "initialize";
    const result = initialize ? {
      ...(mode === "missing-version" ? {} : { protocolVersion: mode === "unsupported-version" ? "2099-01-01" : version }),
      capabilities: { resources: {} }, serverInfo: { name: "catalog-witness", version: "1.0.0" },
    } : {
      contents: [{ uri: "skill://index.json", mimeType: "application/json", text: JSON.stringify({
        $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json", skills: [skill],
      }) }],
    };
    const payload = (initialize && mode === "initialize-error") || (!initialize && mode === "read-error")
      ? error : { jsonrpc: "2.0", id: !initialize && mode === "wrong-json-id" ? "unrelated" : rpc.id, result };
    if (initialize) {
      response.setHeader("mcp-session-id", "synthetic-session");
      // Most servers omit the version header; even a contradictory header must
      // not override the version negotiated in InitializeResult.
      if (mode === "older-version") response.setHeader("mcp-protocol-version", "1999-01-01");
    }
    const streaming = mode.startsWith("sse-") || mode === "read-error" || mode === "wrong-id" || mode === "unfinished-stream";
    if (!streaming) {
      json(200, payload);
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const newline = mode === "sse-cr" ? "\r" : mode === "sse-crlf" ? "\r\n" : "\n";
    const frame = (value: unknown) => `data: ${JSON.stringify(value)}${newline}${newline}`;
    response.write(`: keepalive${newline}${newline}`);
    response.write(frame({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "Synthetic progress" } }));
    response.write(frame({ jsonrpc: "2.0", id: rpc.id, method: "ping" }));
    response.write(frame({ jsonrpc: "2.0", id: "unrelated", result: {} }));
    if (!initialize && mode === "wrong-id") { response.end(); return; }
    if (!initialize && mode === "unfinished-stream") return;
    // Multiline data and delimiters split across writes, with the stream left open
    // after the matching response. Waiting for response.text() must time out.
    const encoded = JSON.stringify(payload);
    const wire = `data: ${encoded.slice(0, 1)}${newline}data: ${encoded.slice(1)}${newline}${newline}`;
    response.write(wire.slice(0, -1));
    const timer = setTimeout(() => response.write(wire.slice(-1)), 10);
    response.once("close", () => clearTimeout(timer));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Catalog witness did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`, requests, skill, version,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
