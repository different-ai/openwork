import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

class CDPClient {
  ws = null;
  id = 0;
  pending = new Map();
  eventHandlers = new Map();
  closed = false;
  abortListener;

  constructor(endpoint, signal, Socket) {
    this.endpoint = endpoint;
    this.signal = signal;
    this.Socket = Socket;
  }

  assertActive() {
    this.signal?.throwIfAborted();
    if (this.closed) throw new Error("CDP connection closed");
  }

  async connect() {
    this.assertActive();
    if (this.ws?.readyState === this.Socket.OPEN) return;
    return await new Promise((resolve, reject) => {
      const fail = (error) => { reject(error); this.close(error); };
      this.assertActive();
      this.ws = new this.Socket(this.endpoint);
      this.ws.once("open", () => {
        try { this.assertActive(); resolve(); } catch (error) { fail(error); }
      });
      this.ws.on("error", fail);
      this.ws.on("message", (data) => {
        if (this.closed) return;
        let message;
        try {
          this.assertActive();
          message = JSON.parse(data.toString());
          this.assertActive();
        } catch (error) {
          fail(error);
          return;
        }
        if (message.id !== undefined && this.pending.has(message.id)) {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          pending.resolve(message);
        }
        if (message.method && this.eventHandlers.has(message.method)) {
          for (const handler of this.eventHandlers.get(message.method)) handler(message.params ?? {});
        }
      });
      this.ws.on("close", () => fail(new Error("CDP connection closed")));
      this.abortListener = () => fail(this.signal.reason ?? new Error("Browser tool cancelled"));
      this.signal?.addEventListener("abort", this.abortListener, { once: true });
      if (this.signal?.aborted) this.abortListener();
    });
  }

  async send(method, params = {}) {
    this.assertActive();
    if (!this.ws || this.ws.readyState !== this.Socket.OPEN) throw new Error("CDP not connected");
    const id = ++this.id;
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timeout);
          if (message.error) reject(new Error(`CDP error: ${message.error.message}`));
          else resolve(message.result ?? {});
        },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      try {
        const payload = JSON.stringify({ id, method, params });
        this.assertActive();
        this.ws.send(payload);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  on(event, handler) {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, []);
    this.eventHandlers.get(event).push(handler);
  }

  close(reason = new Error("CDP connection closed")) {
    if (this.closed) return;
    this.closed = true;
    this.signal?.removeEventListener("abort", this.abortListener);
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
    this.eventHandlers.clear();
    const socket = this.ws;
    this.ws = null;
    socket?.terminate();
  }
}

function walkAXTree(axNode, allNodes, byUid, uids) {
  const role = axNode.role?.value ?? "";
  const name = axNode.name?.value ?? "";
  const value = axNode.value?.value;
  const backendNodeId = axNode.backendDOMNodeId ?? 0;
  const uid = axNode.ignored ? null : uids.next++;
  const children = [];
  for (const childId of axNode.childIds ?? []) {
    const child = allNodes[childId];
    if (child) children.push(...walkAXTree(child, allNodes, byUid, uids));
  }
  if (axNode.ignored || (!name && !value && (role === "generic" || role === "none") && children.length <= 1)) return children;
  const node = {
    uid,
    role,
    name,
    ...(value !== undefined ? { value } : {}),
    backendNodeId,
    ...(children.length > 0 ? { children } : {}),
  };
  byUid.set(uid, node);
  return [node];
}

function renderTree(nodes, indent = 0) {
  const lines = [];
  for (const node of nodes) {
    const parts = [`[${node.uid}]`, node.role];
    if (node.name) parts.push(`"${node.name}"`);
    if (node.value) parts.push(`value="${node.value}"`);
    lines.push(`${"  ".repeat(indent)}${parts.join(" ")}`);
    if (node.children) lines.push(renderTree(node.children, indent + 1));
  }
  return lines.join("\n");
}

async function takeSnapshot(client) {
  const result = await client.send("Accessibility.getFullAXTree");
  client.assertActive();
  const axNodes = result.nodes;
  if (!axNodes || axNodes.length === 0) return { nodes: [], byUid: new Map(), text: "(empty page)" };
  const indexed = Object.create(null);
  for (const node of axNodes) indexed[node.nodeId] = node;
  const byUid = new Map();
  const roots = walkAXTree(axNodes[0], indexed, byUid, { next: 1 });
  return { nodes: roots, byUid, text: renderTree(roots) };
}

function cacheKey(browserUrl, targetId) {
  return JSON.stringify([browserUrl, targetId ?? null]);
}

export async function createBrowserTools({ fetch: request = globalThis.fetch, WebSocket: Socket } = {}) {
  Socket ??= (await import("ws")).default;
  const snapshotCache = new Map();

  async function listTargets(browserUrl, signal) {
    const url = browserUrl.replace(/\/$/, "");
    signal?.throwIfAborted();
    const response = await request(`${url}/json/list`, { signal });
    signal?.throwIfAborted();
    if (!response.ok) throw new Error(`Failed to list targets: ${response.status}`);
    const targets = await response.json();
    signal?.throwIfAborted();
    const parsed = new URL(url);
    if (!["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname)) {
      const scheme = parsed.protocol === "https:" ? "wss:" : "ws:";
      for (const target of targets) {
        if (target.webSocketDebuggerUrl) {
          const wsPath = new URL(target.webSocketDebuggerUrl).pathname;
          target.webSocketDebuggerUrl = `${scheme}//${parsed.host}${wsPath}`;
        }
      }
    }
    return targets;
  }

  async function getClient(browserUrl, targetId, signal) {
    const targets = await listTargets(browserUrl, signal);
    const target = targetId === undefined ? targets.find((item) => item.type === "page") : targets.find((item) => item.id === targetId);
    if (!target) throw new Error(targetId === undefined ? "No page target found" : `Target ${targetId} not found`);
    const client = new CDPClient(target.webSocketDebuggerUrl, signal, Socket);
    try {
      await client.connect();
      client.assertActive();
      return { client, target };
    } catch (error) {
      client.close(error);
      throw error;
    }
  }

  return {
    tool: {
      browser_list: {
        description: "List page targets on a Chrome/Electron CDP endpoint. Returns target IDs, titles, and URLs.",
        async execute(args, context) {
          const targets = await listTargets(args.browser_url, context?.abort);
          const pages = targets.filter((target) => target.type === "page");
          if (pages.length === 0) return "No page targets found.";
          return pages.map((target) => `[${target.id}] ${target.title}\n  ${target.url}`).join("\n\n");
        },
      },
      browser_navigate: {
        description: "Navigate a browser target to a URL and return the resulting page title.",
        async execute(args, context) {
          const { client } = await getClient(args.browser_url, args.target_id, context?.abort);
          try {
            await client.send("Page.enable");
            await client.send("Page.navigate", { url: args.url });
            await new Promise((resolve, reject) => {
              const done = (error) => {
                clearTimeout(timeout);
                context?.abort?.removeEventListener("abort", abort);
                if (error) reject(error); else resolve();
              };
              const abort = () => done(context.abort.reason ?? new Error("Browser tool cancelled"));
              const timeout = setTimeout(() => done(), 10_000);
              client.on("Page.loadEventFired", () => done());
              context?.abort?.addEventListener("abort", abort, { once: true });
              if (context?.abort?.aborted) abort();
            });
            const result = await client.send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
            return `Navigated to: ${args.url}\nTitle: ${result.result?.value ?? ""}`;
          } finally {
            client.close();
          }
        },
      },
      browser_snapshot: {
        description: "Get an accessibility tree snapshot with [uid] markers. Use the UIDs with browser_click and browser_fill.",
        async execute(args, context) {
          const { client } = await getClient(args.browser_url, args.target_id, context?.abort);
          try {
            await client.send("Accessibility.enable");
            const snapshot = await takeSnapshot(client);
            const key = cacheKey(args.browser_url, args.target_id);
            client.assertActive();
            snapshotCache.set(key, snapshot);
            if (!snapshot.text || snapshot.text === "(empty page)") {
              const result = await client.send("Runtime.evaluate", {
                expression: "document.body?.innerText?.substring(0, 3000) ?? '(empty)'",
                returnByValue: true,
              });
              return `Page text:\n${result.result?.value ?? "(empty)"}`;
            }
            return snapshot.text;
          } finally {
            client.close();
          }
        },
      },
      browser_click: {
        description: "Click an element identified by its snapshot UID. Call browser_snapshot first.",
        async execute(args, context) {
          context?.abort?.throwIfAborted();
          const snapshot = snapshotCache.get(cacheKey(args.browser_url, args.target_id));
          if (!snapshot) return "No snapshot cached. Call browser_snapshot first.";
          const node = snapshot.byUid.get(args.uid);
          if (!node) return `UID ${args.uid} not found in snapshot.`;
          const { client } = await getClient(args.browser_url, args.target_id, context?.abort);
          try {
            const resolved = await client.send("DOM.resolveNode", { backendNodeId: node.backendNodeId });
            const objectId = resolved.object?.objectId;
            if (!objectId) return `Could not resolve UID ${args.uid} to a DOM node.`;
            const box = await client.send("DOM.getBoxModel", { backendNodeId: node.backendNodeId });
            const content = box.model?.content;
            if (content && content.length >= 8) {
              const x = (content[0] + content[2] + content[4] + content[6]) / 4;
              const y = (content[1] + content[3] + content[5] + content[7]) / 4;
              await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
              await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
              return `Clicked [${args.uid}] "${node.name}" at (${Math.round(x)}, ${Math.round(y)})`;
            }
            await client.send("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: "function() { this.scrollIntoView({ block: 'center' }); this.click(); }",
            });
            return `Clicked [${args.uid}] "${node.name}" via JS fallback`;
          } finally {
            client.close();
          }
        },
      },
      browser_fill: {
        description: "Fill an input element identified by its snapshot UID. Clears the existing value first.",
        async execute(args, context) {
          context?.abort?.throwIfAborted();
          const snapshot = snapshotCache.get(cacheKey(args.browser_url, args.target_id));
          if (!snapshot) return "No snapshot cached. Call browser_snapshot first.";
          const node = snapshot.byUid.get(args.uid);
          if (!node) return `UID ${args.uid} not found in snapshot.`;
          const { client } = await getClient(args.browser_url, args.target_id, context?.abort);
          try {
            const resolved = await client.send("DOM.resolveNode", { backendNodeId: node.backendNodeId });
            const objectId = resolved.object?.objectId;
            if (!objectId) return `Could not resolve UID ${args.uid}.`;
            await client.send("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: `function() {
                this.focus();
                this.value = '';
                this.dispatchEvent(new Event('input', { bubbles: true }));
              }`,
            });
            for (const char of args.value) {
              await client.send("Input.dispatchKeyEvent", { type: "keyDown", text: char });
              await client.send("Input.dispatchKeyEvent", { type: "keyUp", text: char });
            }
            return `Filled [${args.uid}] "${node.name}" with "${args.value}"`;
          } finally {
            client.close();
          }
        },
      },
      browser_eval: {
        description: "Evaluate a JavaScript expression in the page and return the result.",
        async execute(args, context) {
          const { client } = await getClient(args.browser_url, args.target_id, context?.abort);
          try {
            const result = await client.send("Runtime.evaluate", { expression: args.expression, returnByValue: true, awaitPromise: true });
            if (result.exceptionDetails) {
              const error = result.exceptionDetails;
              return `Error: ${error.text ?? JSON.stringify(error)}`;
            }
            const value = result.result?.value;
            if (value === undefined) return "(undefined)";
            return typeof value === "string" ? value : JSON.stringify(value, null, 2);
          } finally {
            client.close();
          }
        },
      },
      browser_screenshot: {
        description: "Take a PNG screenshot of the page and return the saved file path.",
        async execute(args, context) {
          const { client } = await getClient(args.browser_url, args.target_id, context?.abort);
          try {
            const result = await client.send("Page.captureScreenshot", { format: "png" });
            client.assertActive();
            const data = result.data;
            if (!data) return "Failed to capture screenshot.";
            const path = join(tmpdir(), `browser-screenshot-${Date.now()}.png`);
            const image = Buffer.from(data, "base64");
            client.assertActive();
            writeFileSync(path, image);
            return `Screenshot saved: ${path}\n(${Math.round(data.length * 0.75 / 1024)} KB)`;
          } finally {
            client.close();
          }
        },
      },
    },
  };
}
