import { createServer, request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { denFetch } from "@openwork/behaviors";
import { server } from "../packages/env/src/den.ts";
import { resolvePlace } from "../packages/env/src/place.ts";
import { isRecord } from "./packaged-sandbox-fixtures.ts";
import { uxDockerDatabase } from "./sandbox-ux-docker-db.ts";

export async function uxSignedInDen(flag = true) {
  // Pin infrastructure to the local test containers even under infisical run.
  delete process.env.OPENWORK_EVAL_DEN_API_URL;
  delete process.env.OPENWORK_EVAL_DEN_WEB_URL;
  const stack = new AsyncDisposableStack();
  try {
    const configured = process.env.OPENWORK_EVAL_MYSQL_URL?.trim();
    if (configured && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(configured).hostname)) throw new Error("Only a loopback test database is allowed");
    const db = configured ? { mysql: configured, redis: "redis://127.0.0.1:6379", close: async () => {} } : await uxDockerDatabase();
    stack.defer(db.close);
    process.env.DATABASE_REDIS_URL = db.redis;
    process.env.OPENWORK_EVAL_MYSQL_URL = db.mysql;
    const place = resolvePlace({ OPENWORK_EVAL_MYSQL_URL: db.mysql });
    if (place.kind !== "local") throw new Error("Expected local Den placement");
    const den = await server({ place, web: false, org: { name: "Sandbox UX timing", members: { riley: { name: "Riley Test Member" } } } }).catch(error => {
      const message = error instanceof Error ? error.message.split("\n")[0] ?? "unknown" : "unknown";
      throw new Error(`Local Den boot failed: ${message.replace(/https?:\/\/127\.0\.0\.1:\d+[^\s]*/g, "[loopback URL]").replaceAll(db.mysql, "[test database]")}`);
    });
    stack.use(den);
    // Same platform-admin API used by organization-capabilities.ts, without the Seed runtime.
    const headers = { authorization: `Bearer ${den.admin.token}`, "content-type": "application/json" };
    const context = await denFetch(den.admin, "/v1/org", { headers });
    const org = isRecord(context.body) && isRecord(context.body.organization) ? context.body.organization : null;
    if (typeof org?.id !== "string") throw new Error("No seeded org ID");
    const enabled = await denFetch(den.admin, `/v1/admin/organizations/${org.id}/capabilities`, {
      method: "PUT", headers, body: JSON.stringify({ capabilities: { sandboxTools: flag } }),
    });
    if (!enabled.response.ok) throw new Error(`Enabling sandboxTools failed: HTTP ${enabled.response.status}`);
    const member = den.members.riley;
    if (!member) throw new Error("Local Den did not provision test member");
    const proxy = await uxDenProxy(den.ref.apiUrl);
    stack.defer(proxy.close);
    return { ...proxy, member, close: () => stack.disposeAsync() };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}

/** Loopback-only Den link; keep hung responses open until the caller times out. */
export async function uxDenProxy(apiUrl: string) {
  const upstream = new URL(apiUrl);
  if (upstream.hostname !== "127.0.0.1") throw new Error("Only owned loopback Den is allowed");
  let latency: number | "hang" = 0;
  let failOrg = false;
  const requests: { method: string; path: string; at: string; ms: number; durationMs?: number; status?: number; outcome?: "response" | "client-closed"; forwardedAtMs?: number; upstreamError?: string; injected?: boolean }[] = [];
  const proxy = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", upstream);
    const path = url.pathname.replace(/^\/api\/den(?=\/|$)/, "");
    const entry: (typeof requests)[number] = { method: incoming.method ?? "", path, at: new Date().toISOString(), ms: performance.now() };
    requests.push(entry);
    outgoing.once("finish", () => { entry.durationMs = performance.now() - entry.ms; entry.status = outgoing.statusCode; entry.outcome = "response"; });
    outgoing.once("close", () => { if (!outgoing.writableFinished) { entry.durationMs = performance.now() - entry.ms; entry.outcome = "client-closed"; } });
    if (latency === "hang") return;
    void delay(latency, undefined, { ref: false }).then(() => {
      if (outgoing.destroyed) return;
      if (failOrg && path === "/v1/org") {
        entry.injected = true;
        outgoing.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: "fixture_org_unavailable" }));
        return;
      }
      entry.forwardedAtMs = performance.now();
      const forwarded = request(upstream, { method: incoming.method, path: path + url.search, headers: { ...incoming.headers, host: upstream.host } }, response => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      });
      forwarded.on("error", error => { entry.upstreamError = error.code ?? "OTHER"; if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      outgoing.on("close", () => forwarded.destroy());
      incoming.pipe(forwarded);
    });
  });
  await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });

  const bound = proxy.address();
  if (!bound || typeof bound === "string") throw new Error("Delay proxy did not bind");
  const url = `http://127.0.0.1:${bound.port}`;
  return { url, requests, setLatency(ms: number | "hang") { latency = ms; }, setOrgFault(value: boolean) { failOrg = value; }, close: () => new Promise<void>(resolve => { proxy.close(() => resolve()); proxy.closeAllConnections(); }) };
}
