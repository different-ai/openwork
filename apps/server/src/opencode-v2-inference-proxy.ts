import { timingSafeEqual } from "node:crypto";
import { gatewayBase, record } from "./gateway-quota.js";
import type { CloudProviderDenSession } from "./cloud-provider-sync.js";

export type ProviderProxyFetch = (url: string, init?: RequestInit) => Promise<Response>;
export function providerProxyBaseAllowed(base: string): boolean {
  try {
    const url = new URL(base);
    return !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)));
  } catch { return false; }
}
const fail = (status: number, error: string) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
function equal(value: string, expected: string): boolean {
  const one = Buffer.from(value); const two = Buffer.from(expected);
  return one.length === two.length && timingSafeEqual(one, two);
}

/** Incremental exact-secret redaction; retain only an actual secret-prefix suffix,
 * not a fixed tail that would delay short SSE heartbeats or ordinary tokens. */
export function createProviderSecretRedactor(secrets: readonly string[]) {
  const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  let pending = "";
  return (text: string, done = false): string => {
    pending += text;
    for (const value of values) pending = pending.replaceAll(value, "[redacted]");
    let keep = 0;
    if (!done) for (const value of values) {
      for (let size = Math.min(value.length - 1, pending.length); size > keep; size--) {
        if (pending.endsWith(value.slice(0, size))) { keep = size; break; }
      }
    }
    const result = pending.slice(0, pending.length - keep);
    pending = keep ? pending.slice(-keep) : "";
    return result;
  };
}

/** HTTP inference only. No WebSocket, catalog, arbitrary URL, admin or mutation proxy. */
export async function proxyV2ProviderInference(input: {
  request: Request;
  session: CloudProviderDenSession | null;
  expectedKey: string;
  current: () => boolean;
  fetch: ProviderProxyFetch;
  active: Set<AbortController>;
}): Promise<Response> {
  const { request, session, current, fetch: fetcher, active } = input;
  const url = new URL(request.url);
  const route = /^\/api\/v1\/providers\/(ipr_[a-z0-9]{1,128})\/(.+)$/.exec(url.pathname);
  if (request.method !== "POST" || request.headers.has("origin") || !route) return fail(404, "not_found");
  const [, providerId, suffix] = route;
  if (!/^(?:(?:v1|v1beta)\/)?(?:chat\/completions|responses|messages|models\/[A-Za-z0-9._~-]+:(?:generateContent|streamGenerateContent))$/.test(suffix)) return fail(404, "not_found");
  if (!session || !current()) return fail(401, "provider_identity_changed");
  const credentials = [request.headers.get("authorization")?.replace(/^Bearer /i, ""), request.headers.get("x-api-key"), request.headers.get("api-key"), request.headers.get("x-goog-api-key"), url.searchParams.get("key")].filter((value): value is string => value !== null && value !== undefined);
  if (!credentials.length || credentials.some(value => !equal(value, input.expectedKey))) return fail(401, "provider_inference_unauthorized");
  const query = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (url.searchParams.getAll(key).length !== 1) return fail(404, "not_found");
    if (key === "key") continue;
    if ((key === "alt" && value === "sse") || (key === "api-version" && /^[A-Za-z0-9.-]{1,80}$/.test(value))) query.set(key, value);
    else return fail(404, "not_found");
  }
  if (!providerProxyBaseAllowed(session.baseUrl)) return fail(502, "provider_inference_unavailable");
  const controller = new AbortController();
  active.add(controller);
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const release = () => { active.delete(controller); controller.abort(); };
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = request.body?.getReader();
    if (reader) try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 64 * 1024 * 1024) { release(); return fail(413, "inference_request_too_large"); }
        chunks.push(chunk.value);
      }
    } finally { void reader.cancel().catch(() => {}); }
    if (!current() || signal.aborted) { release(); return fail(409, "provider_identity_changed"); }
    // No reusable gateway key cache: resolve current provider/member authority for
    // every request. Only this host-side stack frame ever owns the raw key.
    const connected = await fetcher(`${session.baseUrl.replace(/\/+$/, "")}/v1/inference-providers/${providerId}/connect`, {
      method: "GET", redirect: "error", signal,
      headers: { accept: "application/json", authorization: `Bearer ${session.token}`,
        ...(session.orgId ? { "x-openwork-org-id": session.orgId, "x-openwork-legacy-org-id": session.orgId } : {}) },
    });
    if (!current() || signal.aborted) { void connected.body?.cancel().catch(() => {}); release(); return fail(409, "provider_identity_changed"); }
    if (!connected.ok) { void connected.body?.cancel().catch(() => {}); release(); return fail(connected.status === 401 || connected.status === 403 ? connected.status : 502, "provider_inference_unavailable"); }
    const data: unknown = await connected.json();
    if (!current() || signal.aborted) { release(); return fail(409, "provider_identity_changed"); }
    const provider = record(data) && record(data.inferenceProvider) ? data.inferenceProvider : null;
    const config = provider && record(provider.providerConfig) ? provider.providerConfig : null;
    const options = config && record(config.options) ? config.options : null;
    const base = gatewayBase(providerId, config?.api ?? options?.baseURL);
    const key = provider?.apiKey;
    if (!provider || provider.id !== providerId || typeof key !== "string" || !/^ow_gw_[A-Za-z0-9_-]+$/.test(key)
      || !base || !providerProxyBaseAllowed(base.href)) { release(); return fail(502, "provider_inference_unavailable"); }
    const headers = new Headers();
    for (const name of ["content-type", "accept", "anthropic-version", "anthropic-beta", "openai-beta", "x-goog-api-client", "x-openwork-gateway-request-model"]) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set("authorization", `Bearer ${key}`);
    const response = await fetcher(`${base.href.replace(/\/+$/, "")}/${suffix}${query.size ? `?${query}` : ""}`, {
      method: "POST", headers, body: Buffer.concat(chunks, size), redirect: "error", signal,
    });
    if (!current() || signal.aborted) { void response.body?.cancel().catch(() => {}); release(); return fail(409, "provider_identity_changed"); }
    if (response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => {}); release(); return fail(502, "provider_inference_unavailable"); }
    const secrets = [session.token, key, JSON.stringify(session.token).slice(1, -1), JSON.stringify(key).slice(1, -1)];
    const safeHeaders = new Headers({ "cache-control": "no-store" });
    for (const name of ["content-type", "retry-after", "x-openwork-error-code", "x-openwork-usage-state", "x-should-retry"]) {
      const value = response.headers.get(name);
      if (value !== null && !secrets.some(secret => secret && value.includes(secret))) safeHeaders.set(name, value);
    }
    if (!response.body) { release(); return new Response(null, { status: response.status, headers: safeHeaders }); }
    const upstream = response.body.getReader();
    const decoder = new TextDecoder(); const encoder = new TextEncoder();
    const redact = createProviderSecretRedactor(secrets);
    const body = new ReadableStream<Uint8Array>({
      start(output) {
        void (async () => {
          try {
            while (!signal.aborted && current()) {
              const chunk = await upstream.read();
              if (signal.aborted || !current()) break;
              const safe = redact(chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true }), chunk.done);
              if (safe) output.enqueue(encoder.encode(safe));
              if (chunk.done) break;
            }
            output.close();
          } catch { try { if (signal.aborted || !current()) output.close(); else output.error(new Error("Inference stream ended")); } catch {} }
          finally { void upstream.cancel().catch(() => {}); release(); }
        })();
      },
      cancel() { void upstream.cancel().catch(() => {}); release(); },
    });
    return new Response(body, { status: response.status, headers: safeHeaders });
  } catch { release(); return fail(502, "provider_inference_unavailable"); }
}
