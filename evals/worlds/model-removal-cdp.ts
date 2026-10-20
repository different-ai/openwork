import type { AppWeb } from "@openwork/env";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An explicit HTTP-edge reply, rather than an application-state override. */
export class HttpFixtureReply {
  readonly status: number;
  readonly headers: Array<{ name: string; value: string }>;
  readonly body: string;
  constructor(status: number, headers: Array<{ name: string; value: string }>, body = "") {
    this.status = status; this.headers = headers; this.body = body;
  }
}

/** World-owned native HTTP fault fixture. It never evaluates renderer JavaScript. */
export async function modelRemovalHttpFixture(app: Pick<AppWeb, "client" | "webUrl">, patterns: string[], respond: (url: URL) => unknown | Promise<unknown>, observe?: (request: { url: string; method: string }) => void) {
  const endpoint = app.client.webSocketDebuggerUrl;
  if (!endpoint) throw new Error("The model-removal fixture requires browser CDP.");
  const socket = new WebSocket(endpoint);
  const pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
  let sequence = 0;
  let failure: Error | undefined;
  let disposing = false;
  const fail = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    for (const call of pending.values()) call.reject(failure);
  };
  const command = async (method: string, params: Record<string, unknown> = {}) => {
    if (failure) throw failure;
    const id = ++sequence;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => reject(new Error(`Model-removal CDP timeout: ${method}`)), 15_000);
        socket.send(JSON.stringify({ id, method, params }));
      });
    } finally { clearTimeout(timer); pending.delete(id); }
  };
  async function paused(params: Record<string, unknown>) {
    const { requestId, request } = params;
    if (typeof requestId !== "string" || !isRecord(request) || typeof request.url !== "string") throw new Error("Malformed Fetch.requestPaused event.");
    observe?.({ url: request.url, method: typeof request.method === "string" ? request.method : "GET" });
    const body = request.method === "GET" ? await respond(new URL(request.url)) : undefined;
    if (body === undefined) return command("Fetch.continueRequest", { requestId });
    if (body instanceof HttpFixtureReply) return command("Fetch.fulfillRequest", {
      requestId, responseCode: body.status, responseHeaders: body.headers,
      body: Buffer.from(body.body).toString("base64"),
    });
    await command("Fetch.fulfillRequest", {
      requestId, responseCode: 200,
      responseHeaders: [
        { name: "Content-Type", value: "application/json" },
        { name: "Access-Control-Allow-Origin", value: new URL(app.webUrl).origin },
        { name: "Access-Control-Allow-Credentials", value: "true" },
        { name: "Cache-Control", value: "no-store" },
      ],
      body: Buffer.from(JSON.stringify(body)).toString("base64"),
    });
  }
  socket.addEventListener("message", ({ data }) => {
    try {
      const message: unknown = JSON.parse(String(data));
      if (!isRecord(message)) return;
      if (typeof message.id === "number") {
        if (message.error) pending.get(message.id)?.reject(new Error(JSON.stringify(message.error)));
        else pending.get(message.id)?.resolve();
      }
      if (message.method === "Fetch.requestPaused" && isRecord(message.params)) void paused(message.params).catch(fail);
    } catch (error) { fail(error); }
  });
  socket.addEventListener("error", () => fail(new Error("Model-removal CDP connection failed.")));
  socket.addEventListener("close", () => { if (!disposing) fail(new Error("Model-removal CDP connection closed.")); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Model-removal CDP connection timeout.")), 15_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Model-removal CDP connection failed.")); }, { once: true });
  });
  await command("Fetch.enable", { patterns: patterns.map(urlPattern => ({ urlPattern, requestStage: "Request" })) });
  return {
    check() { if (failure) throw failure; },
    async [Symbol.asyncDispose]() {
      try { if (socket.readyState === WebSocket.OPEN) await command("Fetch.disable"); }
      finally { disposing = true; socket.close(); }
    },
  };
}
