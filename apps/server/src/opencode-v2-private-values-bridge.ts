import { randomBytes } from "node:crypto";
import { serve } from "./serve-node.js";
import { uiBridgeRequest } from "./opencode-plugins/openwork-ui-bridge.js";

const BODY_LIMIT = 64_000_000;
const REQUEST_MS = 20_000;

export type PrivateValuesForward = (body: unknown, signal?: AbortSignal) => Promise<unknown>;
export type PrivateValuesRoutes = { redact: PrivateValuesForward; terminal: PrivateValuesForward; state: PrivateValuesForward; use: PrivateValuesForward };

const toDesktop: PrivateValuesRoutes = {
  redact: body => uiBridgeRequest("/private/redact", { method: "POST", body, timeoutMs: REQUEST_MS }),
  terminal: () => uiBridgeRequest("/private/terminal", { method: "POST", body: { check: true }, timeoutMs: 10_000 }),
  state: () => uiBridgeRequest("/private/state", { method: "POST", body: { check: true }, timeoutMs: 3_000 }),
  use: (body, signal) => uiBridgeRequest("/private/use", { method: "POST", body, signal, timeoutMs: null }),
};

function routeOf(path: string): keyof PrivateValuesRoutes | null {
  return path === "/redact" ? "redact" : path === "/terminal" ? "terminal" : path === "/state" ? "state" : path === "/use" ? "use" : null;
}

export async function createV2PrivateValuesBridge(routes: Partial<PrivateValuesRoutes> = {}) {
  const forward = { ...toDesktop, ...routes };
  const token = randomBytes(32).toString("base64url");
  const server = await serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
    const route = request.method === "POST" ? routeOf(new URL(request.url).pathname) : null;
    if (!route) return new Response(null, { status: 404 });
    const text = await request.text();
    if (text.length > BODY_LIMIT) return new Response(null, { status: 413 });
    let body: unknown;
    try { body = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
    try {
      return Response.json(await forward[route](body, request.signal));
    } catch {
      return new Response(null, { status: 502 });
    }
  } });
  return { url: `http://127.0.0.1:${server.port}/redact`, token, close: () => server.stop() };
}
