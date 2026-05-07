/**
 * Node.js HTTP adapter for the OpenWork server.
 *
 * Provides a `serve()` function with the same interface as Bun.serve()
 * but backed by `node:http`. This allows the server to run in any Node.js
 * environment (including Electron's main process) without Bun.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

export type ServeOptions = {
  hostname: string;
  port: number;
  fetch: (request: Request) => Response | Promise<Response>;
  idleTimeout?: number;
};

export type ServeResult = {
  port: number;
  stop: () => void;
};

/**
 * Convert a Node.js IncomingMessage into a Web API Request.
 */
function toWebRequest(nodeReq: IncomingMessage, hostname: string, port: number): Request {
  const url = `http://${hostname}:${port}${nodeReq.url ?? "/"}`;
  const method = nodeReq.method ?? "GET";
  const headers = new Headers();

  // Node headers can be string | string[] | undefined
  for (const [key, value] of Object.entries(nodeReq.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  const hasBody = method !== "GET" && method !== "HEAD";

  // Readable.toWeb() returns a Node stream/web ReadableStream which is structurally
  // compatible with the global ReadableStream but TypeScript treats them as distinct.
  const body = hasBody
    ? (Readable.toWeb(nodeReq) as unknown as ReadableStream<Uint8Array>)
    : null;

  return new Request(url, {
    method,
    headers,
    body,
    // @ts-expect-error duplex is required for streaming request bodies in Node
    duplex: hasBody ? "half" : undefined,
  });
}

/**
 * Write a Web API Response to a Node.js ServerResponse.
 */
async function writeWebResponse(webRes: Response, nodeRes: ServerResponse): Promise<void> {
  const headersObj: Record<string, string | string[]> = {};
  webRes.headers.forEach((value, key) => {
    const existing = headersObj[key];
    if (existing) {
      headersObj[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      headersObj[key] = value;
    }
  });

  nodeRes.writeHead(webRes.status, headersObj);

  if (!webRes.body) {
    nodeRes.end();
    return;
  }

  const reader = webRes.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!nodeRes.write(value)) {
        await new Promise<void>((resolve) => nodeRes.once("drain", resolve));
      }
    }
  } finally {
    reader.releaseLock();
    nodeRes.end();
  }
}

/**
 * Start an HTTP server with a Web-standard fetch handler.
 *
 * Interface mirrors Bun.serve() so the caller doesn't need to change.
 */
export function serve(options: ServeOptions): Promise<ServeResult> {
  const { hostname, port, fetch: fetchHandler } = options;

  const server = createServer(async (nodeReq, nodeRes) => {
    try {
      const webReq = toWebRequest(nodeReq, hostname, boundPort);
      const webRes = await fetchHandler(webReq);
      await writeWebResponse(webRes, nodeRes);
    } catch (error) {
      console.error("[serve-node] Unhandled error:", error);
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(500, { "Content-Type": "application/json" });
      }
      nodeRes.end(JSON.stringify({ error: "internal_error" }));
    }
  });

  // Set keep-alive timeout to match Bun's idleTimeout
  if (options.idleTimeout) {
    server.keepAliveTimeout = options.idleTimeout * 1000;
  }

  let boundPort = port;

  return new Promise<ServeResult>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, hostname, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        boundPort = addr.port;
      }
      resolve({
        port: boundPort,
        stop: () => {
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}
