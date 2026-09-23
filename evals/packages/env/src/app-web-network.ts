/** Observe module-load failures without retaining headers, bodies or URL queries. */
export async function observeAppWebNetwork(debuggerUrl: string | undefined, webUrl: string) {
  if (!debuggerUrl) throw new Error("App-web startup needs a page debugger URL");
  const origin = new URL(webUrl).origin;
  const requests = new Map<string, string>();
  const failures: Array<{ path: string; status?: number; error?: string }> = [];
  const browserErrors: string[] = [];
  const socket = new WebSocket(debuggerUrl);
  const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("App-web network observer did not attach")), 10_000);
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ id: 1, method: "Network.enable" }));
        socket.send(JSON.stringify({ id: 2, method: "Log.enable" }));
      });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("App-web network observer disconnected")); });
      socket.addEventListener("message", event => {
        const message: unknown = JSON.parse(String(event.data));
        if (!record(message)) return;
        if (message.id === 1) {
          clearTimeout(timer);
          if (message.error) reject(new Error("App-web network observation failed"));
          else resolve();
        }
        const params = message.params;
        if (message.method === "Log.entryAdded" && record(params) && record(params.entry)
          && params.entry.level === "error" && typeof params.entry.text === "string" && browserErrors.length < 20) {
          browserErrors.push(params.entry.text.replace(/https?:\/\/\S+/g, "[url]").slice(0, 500));
        }
        if (!record(params) || typeof params.requestId !== "string") return;
        if (message.method === "Network.requestWillBeSent" && record(params.request) && typeof params.request.url === "string") {
          const url = new URL(params.request.url);
          if (url.origin === origin) requests.set(params.requestId, url.pathname);
        }
        const path = requests.get(params.requestId);
        if (!path) return;
        if (message.method === "Network.responseReceived" && record(params.response)
          && typeof params.response.status === "number" && params.response.status >= 400 && failures.length < 20) {
          failures.push({ path, status: params.response.status });
        }
        if (message.method === "Network.loadingFailed") {
          if (failures.length < 20) failures.push({ path,
            error: typeof params.errorText === "string" ? params.errorText.replace(/https?:\/\/\S+/g, "[url]").slice(0, 200) : "loading failed" });
          requests.delete(params.requestId);
        }
        if (message.method === "Network.loadingFinished") requests.delete(params.requestId);
      });
    });
    return { failures, browserErrors, close: () => socket.close() };
  } catch (error) {
    socket.close();
    throw error;
  }
}
