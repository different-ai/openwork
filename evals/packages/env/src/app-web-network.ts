/** Observe module-load failures without retaining headers, bodies or URL queries. */
export async function observeAppWebNetwork(debuggerUrl: string | undefined, webUrl: string) {
  if (!debuggerUrl) throw new Error("App-web startup needs a page debugger URL");
  const origin = new URL(webUrl).origin;
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const requests = new Map<string, { path: string; startedMs: number; status?: number; mimeType?: string }>();
  const failures: Array<{ path: string; atMs: number; status?: number; mimeType?: string; error?: string; canceled?: boolean; blockedReason?: string; type?: string }> = [];
  const browserErrors: string[] = [];
  // Page lifecycle, renderer crashes and the Vite client's own console lines
  // tell apart a navigation, a reload, a crash and a server disconnect.
  const lifecycle: string[] = [];
  const counts = { started: 0, finished: 0, failed: 0, canceled: 0, crossOrigin: 0 };
  let lastFinished: { path: string; atMs: number } | null = null;
  const socket = new WebSocket(debuggerUrl);
  const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
  const note = (line: string) => { if (lifecycle.length < 40) lifecycle.push(`${elapsed()}ms ${line.replace(/https?:\/\/\S+/g, "[url]").slice(0, 300)}`); };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("App-web network observer did not attach")), 10_000);
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ id: 1, method: "Network.enable" }));
        socket.send(JSON.stringify({ id: 2, method: "Log.enable" }));
        socket.send(JSON.stringify({ id: 3, method: "Runtime.enable" }));
        socket.send(JSON.stringify({ id: 4, method: "Page.enable" }));
        socket.send(JSON.stringify({ id: 5, method: "Page.setLifecycleEventsEnabled", params: { enabled: true } }));
        socket.send(JSON.stringify({ id: 6, method: "Inspector.enable" }));
      });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("App-web network observer disconnected")); });
      socket.addEventListener("close", () => note("observer socket closed"));
      socket.addEventListener("message", event => {
        const message: unknown = JSON.parse(String(event.data));
        if (!record(message)) return;
        if (message.id === 1) {
          clearTimeout(timer);
          if (message.error) reject(new Error("App-web network observation failed"));
          else resolve();
        }
        const params = message.params;
        const method = typeof message.method === "string" ? message.method : "";
        if (method.startsWith("Inspector.")) note(`${method} ${record(params) && typeof params.reason === "string" ? params.reason : ""}`);
        if (method === "Page.frameNavigated" && record(params) && record(params.frame) && params.frame.parentId === undefined) {
          note(`navigated ${typeof params.frame.url === "string" ? new URL(params.frame.url).pathname : "?"}`);
        }
        if ((method === "Page.frameRequestedNavigation" || method === "Page.frameScheduledNavigation") && record(params)) {
          note(`${method.slice(5)} ${typeof params.reason === "string" ? params.reason : ""} ${typeof params.disposition === "string" ? params.disposition : ""}`);
        }
        if (method === "Page.lifecycleEvent" && record(params) && typeof params.name === "string"
          && ["init", "DOMContentLoaded", "load", "networkIdle"].includes(params.name)) note(`lifecycle ${params.name}`);
        if (method === "Page.frameStoppedLoading") note("frame stopped loading");
        if (method === "Runtime.consoleAPICalled" && record(params) && Array.isArray(params.args)) {
          const first = params.args[0];
          const text = record(first) && typeof first.value === "string" ? first.value : "";
          if (text.startsWith("[vite]")) note(`console ${text}`);
        }
        if (method === "Runtime.exceptionThrown" && record(params) && record(params.exceptionDetails)
          && browserErrors.length < 20) {
          const details = params.exceptionDetails;
          const description = record(details.exception) && typeof details.exception.description === "string"
            ? details.exception.description : details.text;
          if (typeof description === "string") browserErrors.push(description.replace(/https?:\/\/\S+/g, "[url]").slice(0, 1000));
        }
        if (method === "Log.entryAdded" && record(params) && record(params.entry)
          && params.entry.level === "error" && typeof params.entry.text === "string" && browserErrors.length < 20) {
          browserErrors.push(params.entry.text.replace(/https?:\/\/\S+/g, "[url]").slice(0, 500));
        }
        if (!record(params) || typeof params.requestId !== "string") return;
        if (method === "Network.requestWillBeSent" && record(params.request) && typeof params.request.url === "string") {
          const url = new URL(params.request.url);
          if (url.origin === origin) {
            counts.started += 1;
            requests.set(params.requestId, { path: url.pathname, startedMs: elapsed() });
          } else if (url.protocol.startsWith("http")) counts.crossOrigin += 1;
        }
        const request = requests.get(params.requestId);
        if (!request) return;
        if (method === "Network.responseReceived" && record(params.response)
          && typeof params.response.status === "number") {
          request.status = params.response.status;
          if (typeof params.response.mimeType === "string") request.mimeType = params.response.mimeType;
          if (params.response.status >= 400 && failures.length < 20) failures.push({ path: request.path, atMs: elapsed(), status: request.status, mimeType: request.mimeType });
        }
        if (method === "Network.loadingFailed") {
          counts.failed += 1;
          if (params.canceled === true) counts.canceled += 1;
          if (failures.length < 20) failures.push({ path: request.path, atMs: elapsed(), status: request.status, mimeType: request.mimeType,
            canceled: params.canceled === true,
            ...(typeof params.blockedReason === "string" ? { blockedReason: params.blockedReason } : {}),
            ...(typeof params.type === "string" ? { type: params.type } : {}),
            error: typeof params.errorText === "string" ? params.errorText.replace(/https?:\/\/\S+/g, "[url]").slice(0, 200) : "loading failed" });
          requests.delete(params.requestId);
        }
        if (method === "Network.loadingFinished") {
          counts.finished += 1;
          lastFinished = { path: request.path, atMs: elapsed() };
          requests.delete(params.requestId);
        }
      });
    });
    const summary = () => ({
      counts,
      lastFinished,
      pending: [...requests.values()].slice(0, 8).map(request => ({ path: request.path, startedMs: request.startedMs, status: request.status })),
      lifecycle,
    });
    return { failures, browserErrors, summary, close: () => socket.close() };
  } catch (error) {
    socket.close();
    throw error;
  }
}
