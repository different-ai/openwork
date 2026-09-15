import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected JSON object");
  return value;
}

export async function mcpPutProofWitness() {
  const secret = randomBytes(32).toString("base64url");
  const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
  const requests: { at: string; path: string; method: string; status: number; tokenId: string | null }[] = [];
  const toolName = "lane2_credential_witness";
  const server = createServer(async (request, response) => {
    if (request.url !== "/public" && request.url !== "/bearer") {
      response.writeHead(404).end();
      return;
    }
    try {
      let raw = "";
      request.setEncoding("utf8");
      for await (const chunk of request) raw += chunk;
      const body = raw ? record(JSON.parse(raw)) : {};
      const method = typeof body.method === "string" ? body.method : request.method ?? "";
      const authorization = request.headers.authorization;
      const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
      const authorized = request.url === "/public" || token === secret;
      const status = !authorized ? 401 : request.method !== "POST" ? 405 : body.id === undefined ? 202 : 200;
      requests.push({ at: new Date().toISOString(), path: request.url, method, status, tokenId: token ? fingerprint(token) : null });
      if (status !== 200) {
        response.writeHead(status).end();
        return;
      }
      let result: unknown;
      if (method === "initialize") {
        result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "Lane2 witness", version: "1.0.0" } };
      } else if (method === "tools/list") {
        result = { tools: [{ name: toolName, description: "Auth-enforcing fixture", inputSchema: { type: "object", properties: {} } }] };
      } else if (method === "ping") {
        result = {};
      } else {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Witness did not bind a TCP port");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    secret,
    tokenId: fingerprint(secret),
    toolName,
    publicUrl: `${base}/public`,
    bearerUrl: `${base}/bearer`,
    requests: (sinceIso: string) => requests.filter(entry => entry.at >= sinceIso).map(entry => ({ ...entry })),
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
