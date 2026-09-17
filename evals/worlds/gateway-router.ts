import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { eventually } from "@openwork/testkit";
import { denFetch, type DenSession } from "@openwork/behaviors";
import { close, listen, stopChild } from "./openwork-server-cli.ts";

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return Object.fromEntries(Object.entries(value));
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected nonempty string");
  return value;
}
export function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected array");
  return value.map(record);
}
export async function api(session: DenSession, orgId: string, path: string, method = "GET", body?: unknown) {
  return denFetch(session, path, {
    method, headers: { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
}
export async function orgId(session: DenSession, name: string) {
  const result = await api(session, "", "/v1/me/orgs");
  return text(rows(record(result.body).orgs).find((org) => org.name === name)?.id);
}

/** Only the provider boundary is fake; actual Gateway resolves aliases and credentials. */
export async function routerUpstream(reply: (body: Record<string, unknown>) => string = () => "routed answer") {
  const requests: Array<{ path: string; authorization: string; body: Record<string, unknown> }> = [];
  const http = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      requests.push({ path: req.url ?? "", authorization: req.headers.authorization ?? "", body });
      if (req.headers.authorization !== "Bearer fixture-upstream-key") { res.writeHead(401); res.end(); return; }
      const content = reply(body);
      const completion = { id: "chatcmpl-fixture", created: Math.floor(Date.now() / 1000), object: "chat.completion", model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ ...completion, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      } else { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(completion)); }
    });
  });
  const baseUrl = await listen(http);
  return { baseUrl, requests, async [Symbol.asyncDispose]() { await close(http); } };
}

/** Child-process harness, same real DB/auth/proxy as production; only Jev is injected. */
export async function routerGateway(databaseUrl: string, allowedOrigin: string) {
  const source = `
    import { Hono } from 'hono';
    import { serve } from '@hono/node-server';
    import { registerProxyRoutes } from './src/proxy.ts';
    import { createInferenceEgressFetch } from '@openwork-ee/utils/inference-egress';
    const app = new Hono();
    const evaluations = [];
    const dispatches = [];
    app.use('*', async (c, next) => {
      const body = c.req.method === 'POST' ? await c.req.raw.clone().json() : null;
      await next();
      if (body) dispatches.push({body, status:c.res.status, route:c.res.headers.get('x-openwork-router-route-id'), fallback:c.res.headers.get('x-openwork-router-fallback')});
    });
    app.get('/ready', c => c.json({ok:true}));
    app.get('/witness', c => c.json({evaluations, dispatches}));
    registerProxyRoutes(app, {fetch: createInferenceEgressFetch(), gateway: {classifyRoute: async ({text, routes}) => {
      evaluations.push({text, routes});
      const choice = text.includes('TypeScript') ? 'code' : text.includes('poem') ? 'writing' : 'code';
      return {type:'choice', choice, probabilities:{[choice]:text.includes('uncertain') ? 0.1 : 0.99}};
    }}});
    serve({fetch:app.fetch, port:0, hostname:'127.0.0.1'}, info => console.log('ROUTER_PORT='+info.port));
  `;
  const child = spawn("pnpm", ["exec", "tsx", "--eval", source], {
    cwd: fileURLToPath(new URL("../../ee/apps/gateway", import.meta.url)),
    env: { ...process.env, NODE_ENV: "test", OPENWORK_DEV_MODE: "1", NODE_OPTIONS: "--conditions=development",
      DATABASE_URL: databaseUrl, DB_MODE: "mysql", GATEWAY_ENABLED: "true",
      GATEWAY_PUBLIC_BASE_URL: "http://127.0.0.1:19999", GATEWAY_PROXY_BASE_URL: "http://127.0.0.1:19999",
      DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890",
      GATEWAY_EGRESS_ALLOWED_ORIGINS: allowedOrigin, SENTRY_DSN: "", SENTRY_LOG_LEVEL: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout?.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
  try {
    const port = await eventually(() => {
      if (child.exitCode !== null) throw new Error(`Gateway exited ${child.exitCode}: ${logs}`);
      return logs.match(/ROUTER_PORT=(\d+)/)?.[1];
    }, { within: 60_000, intervalMs: 250, label: "injected Gateway listening" });
    return { baseUrl: `http://127.0.0.1:${port}`, async [Symbol.asyncDispose]() { await stopChild(child); } };
  } catch (error) { await stopChild(child); throw new Error(`${String(error)}\n${logs}`); }
}
