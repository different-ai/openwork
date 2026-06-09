/**
 * Minimal Chrome DevTools Protocol client for the eval runner.
 *
 * Zero dependencies: uses the global fetch + WebSocket available in Node 22+.
 * Mirrors the pattern proven in apps/app/scripts/voice-cdp.mjs.
 */

export async function listTargets(baseUrl) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/json/list`);
  if (!response.ok) {
    throw new Error(`Could not list CDP targets at ${baseUrl}: ${response.status}`);
  }
  return response.json();
}

export async function pickAppTarget(baseUrl) {
  const targets = await listTargets(baseUrl);
  const pages = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  const target =
    pages.find((page) => page.title === "OpenWork") ??
    pages.find(
      (page) =>
        page.url.includes("localhost") ||
        page.url.includes("127.0.0.1") ||
        page.url.includes("[::1]"),
    ) ??
    pages[0];
  if (!target) {
    throw new Error(`No CDP page target found at ${baseUrl}.`);
  }
  return target;
}

/**
 * Chromium reports webSocketDebuggerUrl with its own local host
 * (e.g. ws://127.0.0.1:9825/devtools/page/<id>), which breaks when the
 * endpoint is reached through a proxy (e.g. Daytona preview URLs).
 * Rebuild the ws URL on the base URL's host and scheme.
 */
export function debuggerUrlFor(baseUrl, target) {
  const base = new URL(baseUrl);
  const ws = new URL(target.webSocketDebuggerUrl);
  ws.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  ws.hostname = base.hostname;
  ws.port = base.port;
  return ws.toString();
}

/**
 * Probe a list of CDP base URL candidates and return the first that responds.
 */
export async function resolveCdpBaseUrl(candidates) {
  const errors = [];
  for (const candidate of candidates) {
    try {
      await listTargets(candidate);
      return candidate;
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    `No CDP endpoint reachable. Tried:\n  ${errors.join("\n  ")}\n` +
      "Start the app first (pnpm dev) or pass --cdp-url.",
  );
}

export function connect(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    let nextId = 1;
    const pending = new Map();
    let opened = false;

    const rejectPending = (error) => {
      for (const callbacks of pending.values()) callbacks.reject(error);
      pending.clear();
    };

    socket.addEventListener("open", () => {
      opened = true;
      resolve({
        close: () => socket.close(),
        send(method, params = {}) {
          const id = nextId++;
          return new Promise((innerResolve, innerReject) => {
            pending.set(id, { resolve: innerResolve, reject: innerReject });
            try {
              socket.send(JSON.stringify({ id, method, params }));
            } catch (error) {
              pending.delete(id);
              innerReject(error);
            }
          });
        },
      });
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const callbacks = pending.get(message.id);
      if (!callbacks) return;
      pending.delete(message.id);
      if (message.error) callbacks.reject(new Error(message.error.message));
      else callbacks.resolve(message.result);
    });
    socket.addEventListener("error", () => {
      const error = new Error("CDP websocket failed.");
      rejectPending(error);
      if (!opened) reject(error);
    });
    socket.addEventListener("close", () => {
      const error = new Error("CDP websocket closed.");
      rejectPending(error);
      if (!opened) reject(error);
    });
  });
}

export async function evaluate(client, expression, { awaitPromise = false } = {}) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Evaluation failed.",
    );
  }
  return result.result?.value;
}

export async function captureScreenshot(client) {
  const result = await client.send("Page.captureScreenshot", { format: "png" });
  return Buffer.from(result.data, "base64");
}
