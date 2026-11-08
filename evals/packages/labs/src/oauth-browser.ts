import type { CdpClient } from "@openwork/cdp";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Redirect only the provider's browser entry point; all callback/session work is real Den.
 * Uses protocol interception, not DOM scripts or a mocked sign-in API response.
 */
export async function routeOAuthBrowser(client: CdpClient, options: {
  authorizationEndpoint: string;
  localAuthorizationEndpoint: string;
  /** CDP wildcard patterns for the provider origins that must not escape. */
  interceptPatterns: readonly string[];
}) {
  if (!client.webSocketDebuggerUrl) throw new Error("OAuth browser routing requires CDP");
  const socket = new WebSocket(client.webSocketDebuggerUrl);
  const requests: Record<string, unknown>[] = [];
  const failures: string[] = [];
  const consoleErrors: string[] = [];
  const callbackResponses: Array<{ status: number; error: string | null }> = [];
  const httpErrors: Array<{ path: string; status: number }> = [];
  const authorizationRequests: string[] = [];
  let nextId = 0;
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<void>((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`OAuth CDP timeout: ${method}`)); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  socket.addEventListener("message", (event) => {
    const message = record(JSON.parse(String(event.data)));
    if (typeof message.id === "number") {
      const call = pending.get(message.id);
      if (call) {
        clearTimeout(call.timer); pending.delete(message.id);
        if (message.error) call.reject(new Error(JSON.stringify(message.error)));
        else call.resolve();
      }
      return;
    }
    const params = record(message.params);
    const request = record(params.request);
    if (message.method === "Network.requestWillBeSent" && typeof request.url === "string") {
      if (new URL(request.url).pathname === "/api/auth/sign-in/social" && typeof request.postData === "string") {
        requests.push(record(JSON.parse(request.postData)));
      }
    }
    if (message.method === "Network.loadingFailed" && params.canceled !== true) failures.push(String(params.errorText));
    if (message.method === "Network.responseReceived") {
      const response = record(params.response);
      if (typeof response.url === "string" && typeof response.status === "number") {
        const responseUrl = new URL(response.url);
        if (response.status >= 400) httpErrors.push({ path: responseUrl.pathname, status: response.status });
        if (responseUrl.pathname === "/api/auth/error") callbackResponses.push({ status: response.status, error: responseUrl.searchParams.get("error") });
      }
    }
    if (message.method === "Runtime.exceptionThrown") consoleErrors.push(JSON.stringify(params.exceptionDetails));
    if (message.method === "Runtime.consoleAPICalled" && params.type === "error") consoleErrors.push(JSON.stringify(params.args));
    if (message.method === "Log.entryAdded" && record(params.entry).level === "error" && record(params.entry).source !== "network") consoleErrors.push(JSON.stringify(params.entry));
    if (message.method !== "Fetch.requestPaused" || typeof params.requestId !== "string" || typeof request.url !== "string") return;
    const url = new URL(request.url);
    const endpoint = new URL(options.authorizationEndpoint);
    if (`${url.origin}${url.pathname}` !== `${endpoint.origin}${endpoint.pathname}`) {
      failures.push(`Unexpected provider browser request: ${url.origin}${url.pathname}`);
      void send("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }).catch((error: unknown) => failures.push(String(error)));
      return;
    }
    authorizationRequests.push(request.url);
    const local = new URL(options.localAuthorizationEndpoint);
    local.search = url.search;
    void send("Fetch.fulfillRequest", {
      requestId: params.requestId, responseCode: 302,
      responseHeaders: [{ name: "Location", value: local.href }, { name: "Cache-Control", value: "no-store" }], body: "",
    }).catch((error: unknown) => failures.push(String(error)));
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not connect OAuth CDP transport")), { once: true });
  });
  try {
    await send("Network.enable");
    await send("Runtime.enable");
    await send("Log.enable");
    await send("Fetch.enable", { patterns: options.interceptPatterns.map((urlPattern) => ({ urlPattern, requestStage: "Request" })) });
  } catch (error) { socket.close(); throw error; }
  return { requests, authorizationRequests, failures, consoleErrors, callbackResponses, httpErrors,
    async [Symbol.asyncDispose]() {
      await send("Fetch.disable").catch(() => undefined);
      socket.close();
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error("OAuth browser disposed")); }
      pending.clear();
    },
  };
}
