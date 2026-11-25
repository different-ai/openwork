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
  stop: () => void | Promise<void>;
};

const REQUEST_BODY_TIMEOUT_MS = 12 * 60 * 60 * 1000;

function isResponseWritable(nodeRes: ServerResponse): boolean {
  return !nodeRes.destroyed && !nodeRes.closed && !nodeRes.writableEnded;
}

function isWriteAfterEndError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? error.code : undefined;
  return code === "ERR_STREAM_WRITE_AFTER_END" || error.message.includes("write after end");
}

function isExpectedConnectionAbort(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? error.code : undefined;
  const cause = error.cause;
  const causeCode = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
  return (
    code === "ECONNRESET" ||
    code === "UND_ERR_SOCKET" ||
    causeCode === "UND_ERR_SOCKET" ||
    error.name === "AbortError" ||
    error.message === "terminated"
  );
}

function endResponse(nodeRes: ServerResponse, chunk?: string): void {
  if (!isResponseWritable(nodeRes)) return;
  nodeRes.end(chunk);
}

async function waitForDrainOrClose(nodeRes: ServerResponse): Promise<void> {
  if (!isResponseWritable(nodeRes)) return;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      nodeRes.off("drain", done);
      nodeRes.off("close", done);
      nodeRes.off("error", fail);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };

    nodeRes.once("drain", done);
    nodeRes.once("close", done);
    nodeRes.once("error", fail);
  });
}

function toWebRequest(
  nodeReq: IncomingMessage,
  hostname: string,
  port: number,
): { request: Request; detachCancellation: () => void } {
  const url = `http://${hostname}:${port}${nodeReq.url ?? "/"}`;
  const method = nodeReq.method ?? "GET";
  const headers = new Headers();
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException("The operation was aborted", "AbortError"));
    }
  };
  if (nodeReq.aborted) abort();
  else {
    nodeReq.once("aborted", abort);
    nodeReq.socket.once("close", abort);
  }

  for (const [key, value] of Object.entries(nodeReq.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  const hasBody = method !== "GET" && method !== "HEAD";

  const body = hasBody
    ? (Readable.toWeb(nodeReq) as unknown as ReadableStream<Uint8Array>)
    : null;

  const request = new Request(url, {
    method,
    headers,
    body,
    signal: controller.signal,
    // @ts-expect-error duplex is required for streaming request bodies in Node
    duplex: hasBody ? "half" : undefined,
  });
  return {
    request,
    detachCancellation: () => {
      nodeReq.off("aborted", abort);
      nodeReq.socket.off("close", abort);
    },
  };
}

export async function writeWebResponse(webRes: Response, nodeRes: ServerResponse): Promise<void> {
  const headersObj: Record<string, string | string[]> = {};
  webRes.headers.forEach((value, key) => {
    const existing = headersObj[key];
    if (existing) {
      headersObj[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      headersObj[key] = value;
    }
  });

  if (!isResponseWritable(nodeRes)) return;

  nodeRes.writeHead(webRes.status, headersObj);

  if (!webRes.body) {
    endResponse(nodeRes);
    return;
  }

  const reader = webRes.body.getReader();
  let completed = false;
  let cancelled = false;
  const cancelReader = (reason?: unknown) => {
    if (cancelled) return;
    cancelled = true;
    try {
      void reader.cancel(reason).catch(() => undefined);
    } catch {
    }
  };
  const cancelOnDisconnect = () => {
    cancelReader(new Error("Response client disconnected"));
  };
  nodeRes.once("close", cancelOnDisconnect);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (!isResponseWritable(nodeRes)) break;
      if (!nodeRes.write(value)) {
        await waitForDrainOrClose(nodeRes);
        if (!isResponseWritable(nodeRes)) break;
      }
    }
  } catch (error) {
    nodeRes.destroy();
    throw error;
  } finally {
    nodeRes.off("close", cancelOnDisconnect);
    if (!completed) cancelReader();
    try {
      reader.releaseLock();
    } catch {
    }
  }
  if (completed) endResponse(nodeRes);
}

export function serve(options: ServeOptions): Promise<ServeResult> {
  const { hostname, port, fetch: fetchHandler } = options;

  const server = createServer(async (nodeReq, nodeRes) => {
    nodeRes.on("error", (error) => {
      if (isExpectedConnectionAbort(error)) return;
      if (isWriteAfterEndError(error)) {
        console.warn("[serve-node] Ignored response write after end");
        return;
      }
      console.error("[serve-node] Response stream error:", error);
    });

    let detachCancellation: (() => void) | undefined;
    try {
      const webRequest = toWebRequest(nodeReq, hostname, boundPort);
      detachCancellation = webRequest.detachCancellation;
      const webRes = await fetchHandler(webRequest.request);
      await writeWebResponse(webRes, nodeRes);
    } catch (error) {
      if (isExpectedConnectionAbort(error)) {
        if (!nodeRes.destroyed && !nodeRes.writableEnded) nodeRes.destroy();
        return;
      }
      console.error("[serve-node] Unhandled error:", error);
      if (!isResponseWritable(nodeRes)) return;
      if (nodeRes.headersSent) {
        nodeRes.destroy();
        return;
      }
      nodeRes.writeHead(500, { "Content-Type": "application/json" });
      endResponse(nodeRes, JSON.stringify({ error: "internal_error" }));
    } finally {
      detachCancellation?.();
    }
  });

  if (options.idleTimeout) {
    server.keepAliveTimeout = options.idleTimeout * 1000;
  }
  server.requestTimeout = REQUEST_BODY_TIMEOUT_MS;

  let boundPort = port;

  return new Promise<ServeResult>((resolve, reject) => {
    let retriedFreePort = false;
    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" && !retriedFreePort) {
        retriedFreePort = true;
        server.listen(0, hostname);
        return;
      }
      reject(error);
    });
    server.on("listening", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        boundPort = addr.port;
      }
      let stopPromise: Promise<void> | null = null;
      resolve({
        port: boundPort,
        stop: () => {
          if (stopPromise) return stopPromise;
          stopPromise = new Promise<void>((stopResolve, stopReject) => {
            server.close((error) => {
              if (error) {
                if (String(error).includes("ERR_SERVER_NOT_RUNNING") || String(error).includes("Server is not running")) {
                  stopResolve();
                  return;
                }
                stopReject(error);
                return;
              }
              stopResolve();
            });
            server.closeAllConnections();
          });
          return stopPromise;
        },
      });
    });
    server.listen(port, hostname);
  });
}
