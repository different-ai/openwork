import { setTimeout as delay } from "node:timers/promises";
import type { Surface } from "@openwork/cdp";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Keep Den's actual browser origin/authentication, faulting only this read's transport. */
export async function activityTransportFaults(web: Surface, origin: string, path: string) {
  if (!web.client.webSocketDebuggerUrl) throw new Error("Activity faults require browser CDP.");
  const socket = new WebSocket(web.client.webSocketDebuggerUrl);
  const calls = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const active = new Set<Promise<void>>();
  const log: { path: string; status: number; faulted: boolean }[] = [];
  const errors: Error[] = [];
  let mode: "healthy" | "delay" | "fail" = "healthy";
  let sequence = 0;
  const send = (method: string, params: Record<string, unknown>): Promise<void> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { calls.delete(id); reject(new Error(`Activity transport timeout: ${method}`)); }, 10_000);
    calls.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });

  async function intercept(params: Record<string, unknown>) {
    if (typeof params.requestId !== "string") throw new Error("Activity interception has no request ID.");
    const request = record(params.request);
    const url = new URL(String(request.url));
    const currentMode = mode;
    if (currentMode === "delay") await delay(8_000);
    if (currentMode === "fail") {
      await send("Fetch.fulfillRequest", {
        requestId: params.requestId,
        responseCode: 503,
        responseHeaders: [{ name: "content-type", value: "application/json" }, { name: "cache-control", value: "no-store" }],
        body: Buffer.from(JSON.stringify({ error: "activity_transport_unavailable" })).toString("base64"),
      });
    } else {
      // Continue the original server response unchanged, including its real rows.
      await send("Fetch.continueResponse", { requestId: params.requestId });
    }
    log.push({ path: `${url.pathname}${url.search}`, status: currentMode === "fail" ? 503 : Number(params.responseStatusCode), faulted: currentMode !== "healthy" });
  }

  socket.addEventListener("message", (event) => {
    const message = record(JSON.parse(String(event.data)));
    if (typeof message.id === "number") {
      const call = calls.get(message.id);
      if (call) {
        clearTimeout(call.timer);
        calls.delete(message.id);
        if (message.error) call.reject(new Error(JSON.stringify(message.error)));
        else call.resolve();
      }
    }
    if (message.method === "Fetch.requestPaused") {
      const task = intercept(record(message.params)).catch((error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        // React may cancel a read during navigation/Strict Mode before release.
        if (!/Invalid (InterceptionId|interceptionId)|Invalid Fetch request id/i.test(failure.message)) errors.push(failure);
      });
      active.add(task);
      void task.finally(() => active.delete(task));
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Activity transport connection timed out.")), 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Activity transport connection failed.")); }, { once: true });
    });
    await send("Fetch.enable", { patterns: [{ urlPattern: `${origin}${path}*`, requestStage: "Response" }] });
  } catch (error) {
    socket.close();
    throw error;
  }
  return {
    async delay() { mode = "delay"; },
    async fail() { mode = "fail"; },
    async recover() { mode = "healthy"; },
    async requests() {
      if (errors[0]) throw errors[0];
      return [...log];
    },
    async [Symbol.asyncDispose]() {
      mode = "healthy";
      await Promise.all(active);
      await send("Fetch.disable", {}).finally(() => socket.close());
    },
  };
}
