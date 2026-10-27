import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { proxyV2ProviderInference } from "./opencode-v2-inference-proxy.js";
import { serve } from "./serve-node.js";
import { externalFetch } from "./server-fetch.js";
import type { CloudProviderDenSession } from "./cloud-provider-sync.js";

type InventoryFetch = (url: string, init?: RequestInit) => Promise<Response>;
const EVENTS = "/v1/inference-providers/inventory/events";
const IDENTITY_HEADER = "x-openwork-provider-identity";

/** This hash is an identity fence, not a bearer; it survives bridge/engine restarts. */
export function providerSessionIdentity(session: CloudProviderDenSession): string {
  return createHash("sha256").update(JSON.stringify([session.baseUrl.replace(/\/+$/, ""), session.orgId, session.token])).digest("hex");
}
function allowedPath(path: string): boolean {
  return path === "/v1/inference-providers?scope=usable" || path === EVENTS
    || /^\/v1\/inference-providers\/ipr_[a-z0-9_]{1,128}\/connect$/.test(path);
}
function allowedBase(base: string): boolean {
  try {
    const url = new URL(base);
    return !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)));
  } catch { return false; }
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Scoped inventory/inference transport. Reusable Den and Gateway bearers never
 * leave the OpenWork server, even to another engine plugin. No catalog owner,
 * provider state/cache/writer, or background inventory polling.
 */
export async function createV2ProviderSessionBridge(current: () => CloudProviderDenSession | null, options: { fetch?: InventoryFetch } = {}) {
  const token = randomBytes(32).toString("base64url");
  const inferenceSecret = randomBytes(32);
  const inferenceKey = (identity: string) => `ow_local_${createHmac("sha256", inferenceSecret).update(identity).digest("hex")}`;
  const fetcher = options.fetch ?? externalFetch;
  const active = new Set<AbortController>();
  const server = await serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const url = new URL(request.url);
    const session = current();
    const identity = session ? providerSessionIdentity(session) : "";
    const sameIdentity = () => {
      const next = current();
      return next !== null && providerSessionIdentity(next) === identity;
    };
    if (url.pathname.startsWith("/api/v1/providers/")) return proxyV2ProviderInference({
      request, session, expectedKey: inferenceKey(identity), current: sameIdentity, fetch: fetcher, active,
    });
    const supplied = Buffer.from(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(null, 401);
    // Do not forward caller methods, headers, URLs, request bodies, or redirects.
    if (request.headers.has("origin") || request.method !== "GET") return json(null, 404);
    const path = url.pathname + url.search;
    if (path === "/session") return json(session ? {
      apiBaseUrl: session.baseUrl.replace(/\/+$/, ""), orgId: session.orgId, identity,
      inferenceOrigin: url.origin, inferenceKey: inferenceKey(identity),
    } : null);
    if (!allowedPath(path)) return json(null, 404);
    if (!session) return json(null, 401);
    if (request.headers.get(IDENTITY_HEADER) !== identity) return json({ error: "provider_identity_changed" }, 409);
    if (!allowedBase(session.baseUrl)) return json({ error: "provider_inventory_unavailable" }, 502);
    const controller = new AbortController();
    active.add(controller);
    const signal = AbortSignal.any([request.signal, controller.signal, ...(path === EVENTS ? [] : [AbortSignal.timeout(10_000)])]);
    const release = () => { active.delete(controller); controller.abort(); };
    try {
      const upstream = await fetcher(`${session.baseUrl.replace(/\/+$/, "")}${path}`, {
        method: "GET", redirect: "error", signal,
        headers: {
          accept: path === EVENTS ? "text/event-stream" : "application/json",
          authorization: `Bearer ${session.token}`,
          ...(session.orgId ? { "x-openwork-org-id": session.orgId, "x-openwork-legacy-org-id": session.orgId } : {}),
        },
      });
      if (!sameIdentity() || signal.aborted) {
        void upstream.body?.cancel().catch(() => {});
        release();
        return json({ error: "provider_identity_changed" }, 409);
      }
      if (upstream.status >= 300 && upstream.status < 400) {
        void upstream.body?.cancel().catch(() => {});
        release();
        return json({ error: "provider_inventory_unavailable" }, 502);
      }
      if (path === EVENTS && upstream.ok) {
        if (!upstream.body || !upstream.headers.get("content-type")?.includes("text/event-stream")) {
          void upstream.body?.cancel().catch(() => {});
          release();
          return json({ error: "provider_inventory_unavailable" }, 502);
        }
        // Canonical invalidations/heartbeats only: never relay arbitrary Den SSE
        // payloads, cookies, auth headers, error text, or other response headers.
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        let buffer = "";
        let event = "";
        let data = false;
        const body = new ReadableStream<Uint8Array>({
          start(output) {
            void (async () => {
              try {
                while (!signal.aborted && sameIdentity()) {
                  const chunk = await reader.read();
                  if (chunk.done || signal.aborted || !sameIdentity()) break;
                  buffer += decoder.decode(chunk.value, { stream: true });
                  if (buffer.length > 1024 * 1024) throw new Error("Invalid inventory stream");
                  while (true) {
                    const match = /\r\n|\n|\r/.exec(buffer);
                    if (!match || (match[0] === "\r" && match.index === buffer.length - 1)) break;
                    const line = buffer.slice(0, match.index);
                    buffer = buffer.slice(match.index + match[0].length);
                    if (!line) {
                      if (event === "inventory.changed" && data) output.enqueue(encoder.encode("event: inventory.changed\ndata: {}\n\n"));
                      event = ""; data = false;
                    } else if (line.startsWith(":")) output.enqueue(encoder.encode(": heartbeat\n\n"));
                    else if (line.startsWith("event:")) event = line.slice(6).trim();
                    else if (line.startsWith("data:")) data = true;
                  }
                }
                output.close();
              } catch {
                // Host shutdown, client cancellation and identity replacement
                // are ordinary EOFs. Do not turn their aborted upstream read
                // into an unhandled HTTP streaming error; unexpected failures
                // still error the response and trigger client reconciliation.
                try {
                  if (signal.aborted || !sameIdentity()) output.close();
                  else output.error(new Error("Inventory stream ended"));
                } catch { /* The downstream may already have cancelled. */ }
              } finally { void reader.cancel().catch(() => {}); release(); }
            })();
          },
          cancel() { void reader.cancel().catch(() => {}); release(); },
        });
        return new Response(body, { status: upstream.status, headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      }
      // Inventory JSON is bounded and re-encoded. Never pass through arbitrary
      // upstream response headers or a diagnostic echo of the Den credential.
      let text = "";
      if (upstream.body) {
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 8 * 1024 * 1024) throw new Error("Inventory too large");
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } finally { void reader.cancel().catch(() => {}); }
      }
      if (!sameIdentity() || signal.aborted) { release(); return json({ error: "provider_identity_changed" }, 409); }
      let value: unknown = null;
      try { value = text ? JSON.parse(text) : null; }
      catch { if (upstream.ok) throw new Error("Invalid inventory JSON"); }
      const safe = JSON.stringify(value, (_key, item: unknown) => typeof item === "string" ? item.replaceAll(session.token, "[redacted]") : item)
        .replaceAll(JSON.stringify(session.token).slice(1, -1), "[redacted]")
        .replace(/ow_gw_[A-Za-z0-9_-]+/g, "ow_local_catalog");
      const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
      const retry = upstream.headers.get("retry-after");
      if (retry && !retry.includes(session.token) && retry.length <= 100 && (/^\d{1,9}$/.test(retry) || Number.isFinite(Date.parse(retry)))) headers["retry-after"] = retry;
      release();
      return new Response(safe, { status: upstream.status, headers });
    } catch {
      release();
      return json({ error: "provider_inventory_unavailable" }, 502);
    }
  } });
  return { url: `http://127.0.0.1:${server.port}/session`, token, close: async () => {
    for (const controller of active) controller.abort();
    await server.stop();
  } };
}
