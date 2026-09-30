import { addInitScript, evaluate, type CdpClient, type Surface } from "@openwork/cdp";

function receiptObserver() {
  const marker = Symbol.for("fixture.hosted.receipt-observer");
  if (Reflect.get(window, marker)) return;
  Reflect.set(window, marker, true);
  for (const method of ["log", "info", "warn", "error", "debug"]) Reflect.set(console, method, () => undefined);
  const ready = () => {
    if (location.href === "about:srcdoc" && window.parent !== window.top) window.parent.postMessage({ method: "fixture/observer-ready", params: {} }, "*");
  };
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();
  window.addEventListener("message", (event) => {
    if (location.href !== "about:srcdoc" || window.parent === window.top || event.source !== window.parent) return;
    const data: unknown = event.data;
    if (typeof data !== "object" || data === null || !("method" in data) || !("params" in data)) return;
    if (data.method !== "ui/notifications/tool-input" && data.method !== "ui/notifications/tool-result") return;
    window.parent.postMessage({ method: "fixture/hosted-received", params: { kind: data.method === "ui/notifications/tool-input" ? "input" : "result", payload: data.params } }, "*");
  }, true);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function installHostedReceiptObserver(browser: Surface) {
  if (!browser.client.targetId || browser.handle.kind !== "chrome" || browser.handle.hostKind !== "local") throw new Error("Observer requires the fixture-owned local Chrome target");
  const version: unknown = await fetch(`${browser.handle.cdpUrl}/json/version`, { signal: AbortSignal.timeout(5_000) }).then((response) => response.json());
  if (!record(version) || typeof version.webSocketDebuggerUrl !== "string") throw new Error("Fixture browser endpoint unavailable");
  const endpoint = new URL(version.webSocketDebuggerUrl);
  const ownedEndpoint = new URL(browser.handle.cdpUrl);
  if (endpoint.hostname !== ownedEndpoint.hostname || endpoint.port !== ownedEndpoint.port) throw new Error("Fixture browser endpoint mismatch");
  const stats = { attachedFrames: 0, installedFrames: 0, installFailures: 0, waitingFrames: 0, completeAtInstall: 0 };
  const socket = new WebSocket(endpoint);
  let sequence = 0;
  let stopped = false;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const installing = new Set<Promise<void>>();
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => {
    stopped = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Fixture observer disposed")); }
    pending.clear();
    socket.close();
  });
  function client(sessionId?: string): CdpClient {
    return {
      send(method, params = {}, options = {}) {
        if (stopped || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Fixture observer transport closed"));
        const id = ++sequence;
        return new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(id); reject(new Error("Fixture observer CDP deadline exceeded")); }, options.timeoutMs ?? 5_000);
          pending.set(id, { resolve, reject, timer });
          socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
      },
      close() {},
    };
  }
  socket.addEventListener("message", (event) => {
    let message: unknown;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (!record(message)) return;
    if (typeof message.id === "number") {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error("Fixture observer CDP request rejected"));
      else request.resolve(message.result);
      return;
    }
    if (message.method !== "Target.attachedToTarget" || !record(message.params) || typeof message.params.sessionId !== "string") return;
    const child = client(message.params.sessionId);
    const iframe = record(message.params.targetInfo) && message.params.targetInfo.type === "iframe";
    const page = record(message.params.targetInfo) && message.params.targetInfo.type === "page";
    const tab = record(message.params.targetInfo) && message.params.targetInfo.type === "tab";
    const waiting = message.params.waitingForDebugger === true;
    if (iframe) stats.attachedFrames += 1;
    if (iframe && waiting) stats.waitingFrames += 1;
    const installation = (async () => {
      try {
        if (tab) await child.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
        if (iframe || page) {
          await evaluate(child, receiptObserver);
          await child.send("Page.enable");
          await addInitScript(child, receiptObserver);
          await child.send("Runtime.enable");
          if (iframe && await evaluate(child, () => document.readyState === "complete")) stats.completeAtInstall += 1;
          await child.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
          if (iframe) stats.installedFrames += 1;
        }
      } catch {
        stats.installFailures += 1;
      } finally {
        if (!tab && waiting) await child.send("Runtime.runIfWaitingForDebugger").catch(() => { stats.installFailures += 1; });
      }
    })();
    installing.add(installation);
    void installation.finally(() => installing.delete(installation));
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("Fixture observer connection deadline exceeded")); }, 5_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Fixture observer connection failed")); }, { once: true });
  });
  const root = client();
  cleanup.use(await addInitScript(browser.client, receiptObserver));
  await root.send("Target.setDiscoverTargets", { discover: true });
  await root.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "tab" }, { exclude: true }] });
  cleanup.defer(async () => {
    await Promise.allSettled([...installing]);
    await root.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
  });
  const settle = async () => {
    const deadline = Date.now() + 10_000;
    while (installing.size) {
      if (Date.now() > deadline) throw new Error("Fixture observer attachment deadline exceeded");
      await Promise.all([...installing]);
    }
  };
  await settle();
  const retained = cleanup.move();
  return {
    stats,
    settle,
    async [Symbol.asyncDispose]() { await retained.disposeAsync(); },
  };
}
