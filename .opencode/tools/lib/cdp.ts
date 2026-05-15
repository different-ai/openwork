/**
 * Minimal CDP (Chrome DevTools Protocol) client.
 * Raw WebSocket, no Puppeteer, no dependencies.
 *
 * Supports connecting to any Chrome/Electron instance that exposes CDP.
 */

import WebSocket from "ws";

type CDPResponse = {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

export class CDPClient {
  private ws: WebSocket | null = null;
  private id = 0;
  private pending = new Map<number, { resolve: (v: CDPResponse) => void; reject: (e: Error) => void }>();
  private eventHandlers = new Map<string, Array<(params: Record<string, unknown>) => void>>();

  constructor(public readonly endpoint: string) {}

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.endpoint);
      this.ws.once("open", () => resolve());
      this.ws.once("error", (err) => reject(err));
      this.ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          p.resolve(msg);
        }
        if (msg.method && this.eventHandlers.has(msg.method)) {
          for (const handler of this.eventHandlers.get(msg.method)!) {
            handler(msg.params ?? {});
          }
        }
      });
      this.ws.on("close", () => { this.ws = null; });
    });
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("CDP not connected");
    }
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timeout);
          if (msg.error) reject(new Error(`CDP error: ${msg.error.message}`));
          else resolve(msg.result ?? {});
        },
        reject: (err) => { clearTimeout(timeout); reject(err); },
      });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, handler: (params: Record<string, unknown>) => void) {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, []);
    this.eventHandlers.get(event)!.push(handler);
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}

/**
 * Discover targets (pages, iframes, workers) from a CDP HTTP endpoint.
 */
export async function listTargets(browserUrl: string): Promise<Array<{
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}>> {
  const url = browserUrl.replace(/\/$/, "");
  const res = await fetch(`${url}/json/list`);
  if (!res.ok) throw new Error(`Failed to list targets: ${res.status}`);
  const targets = await res.json();

  // CDP returns ws://localhost:PORT/... URLs. When accessing via a proxy
  // (e.g. Daytona), we need to rewrite them to use the proxy host.
  const parsed = new URL(url);
  const isProxy = !["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname);
  if (isProxy) {
    const wsScheme = parsed.protocol === "https:" ? "wss:" : "ws:";
    for (const target of targets) {
      if (target.webSocketDebuggerUrl) {
        const wsPath = new URL(target.webSocketDebuggerUrl).pathname;
        target.webSocketDebuggerUrl = `${wsScheme}//${parsed.host}${wsPath}`;
      }
    }
  }
  return targets;
}

/**
 * Connect to a specific target by its webSocketDebuggerUrl.
 */
export async function connectTarget(wsUrl: string): Promise<CDPClient> {
  const client = new CDPClient(wsUrl);
  await client.connect();
  return client;
}

/**
 * Connect to the first page target on a browser endpoint.
 */
export async function connectFirstPage(browserUrl: string): Promise<{ client: CDPClient; target: { id: string; title: string; url: string } }> {
  const targets = await listTargets(browserUrl);
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("No page target found");
  const client = await connectTarget(page.webSocketDebuggerUrl);
  return { client, target: { id: page.id, title: page.title, url: page.url } };
}
