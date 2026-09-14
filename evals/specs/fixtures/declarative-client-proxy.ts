import { createServer } from "node:http";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object");
  return value;
}

export function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string");
  return value;
}

export interface ClientRequest {
  method: string;
  path: string;
  body: unknown;
  ifMatch: string | null;
  status: number;
  response: unknown;
}

type Fault = number | "race" | "disconnect";

export async function declarativeClientProxy(upstream: string, sentinel: string) {
  const requests: ClientRequest[] = [];
  const faults: Fault[] = [];
  const failures: string[] = [];
  let invalidProbes = 0;
  let races = 0;
  const server = createServer(async (request, response) => {
    try {
      const path = request.url ?? "/";
      if (path === "/invalid-mcp") {
        invalidProbes++;
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(sentinel);
        return;
      }
      request.setEncoding("utf8");
      let body = "";
      for await (const chunk of request) body += chunk;
      const method = request.method ?? "GET";
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value !== undefined && !["host", "connection", "content-length"].includes(key)) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const entry: ClientRequest = {
        method, path, body: body ? JSON.parse(body) : undefined, ifMatch: headers.get("if-match"), status: 0, response: undefined,
      };
      requests.push(entry);
      const fault = method === "PUT" && path.startsWith("/v1/mcp-connections/by-key/") ? faults.shift() : undefined;
      if (typeof fault === "number") {
        entry.status = fault;
        entry.response = { error: "injected_failure", message: sentinel };
      } else {
        const forward = (payload = body) => fetch(new URL(path, upstream), {
          method, headers, ...(payload ? { body: payload } : {}), redirect: "error", signal: AbortSignal.timeout(30_000),
        });
        if (fault === "race") {
          const concurrent = await forward(JSON.stringify({ ...record(entry.body), name: `Concurrent MCP writer ${++races}` }));
          if (concurrent.status !== 200) throw new Error("Concurrent witness update failed");
          await concurrent.arrayBuffer();
        }
        const result = await forward();
        entry.status = result.status;
        entry.response = await result.json();
        if (fault === "disconnect") {
          response.destroy();
          return;
        }
      }
      response.writeHead(entry.status, { "content-type": "application/json" });
      response.end(JSON.stringify(entry.response));
    } catch {
      failures.push("Proxy forwarding failed");
      response.writeHead(500);
      response.end("Proxy forwarding failed");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy did not listen");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    faults,
    failures,
    invalidProbes: () => invalidProbes,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
