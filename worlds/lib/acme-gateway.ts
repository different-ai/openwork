import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { allocateFreePort } from "../../evals/packages/cdp/src/index.ts";
import { denFetch } from "../../evals/packages/behaviors/src/den.ts";
import type { DenSession } from "../../evals/packages/behaviors/src/den.ts";
import { trackResource } from "../../packages/world/src/ledger.ts";

export const ACME_MODEL = "claude-haiku-4-5-20251001";
export const ACME_REPLY = "Acme AI Gateway is working.";
export const ACME_ENCRYPTION_KEY = "local-dev-db-encryption-key-please-change-1234567890";

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function startAcmeUpstream(stack: AsyncDisposableStack) {
  const key = randomUUID();
  const requests: { model: string; authenticated: boolean }[] = [];
  const upstream = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url?.split("?")[0] !== "/v1/messages") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 1024 * 1024) { response.writeHead(413).end(); return; }
        chunks.push(bytes);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const model = record(body) && typeof body.model === "string" ? body.model : "";
      const authenticated = request.headers["x-api-key"] === key;
      requests.push({ model, authenticated });
      if (!authenticated) { response.writeHead(401).end(); return; }
      if (model !== ACME_MODEL) { response.writeHead(400).end(); return; }
      const message = { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model,
        content: [{ type: "text", text: ACME_REPLY }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 25, output_tokens: 12 } };
      if (record(body) && body.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream", "request-id": randomUUID() });
        for (const event of [
          { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 25, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ACME_REPLY } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } },
          { type: "message_stop" },
        ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        response.end();
      } else {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message));
      }
    } catch { response.writeHead(400).end(); }
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  stack.defer(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  });
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Acme upstream did not bind.");
  return { baseUrl: `http://127.0.0.1:${address.port}`, key, requests };
}

export async function gatewayEnvironment(upstreamUrl: string) {
  const port = await allocateFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  return { baseUrl, env: {
    GATEWAY_ENABLED: "true", GATEWAY_PORT: String(port),
    GATEWAY_PROXY_BASE_URL: baseUrl, GATEWAY_PUBLIC_BASE_URL: baseUrl,
    GATEWAY_EGRESS_ALLOWED_ORIGINS: upstreamUrl, DEN_DB_ENCRYPTION_KEY: ACME_ENCRYPTION_KEY,
    GATEWAY_WEBHOOK_SECRET: randomUUID(),
  } };
}

export async function startAcmeGateway(stack: AsyncDisposableStack, databaseUrl: string, settings: Awaited<ReturnType<typeof gatewayEnvironment>>) {
  const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", "src/server.ts"], {
    cwd: fileURLToPath(new URL("../../ee/apps/gateway", import.meta.url)),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", OPENWORK_DEV_MODE: "1",
      DB_MODE: "mysql", DATABASE_URL: databaseUrl, ...settings.env, SENTRY_DSN: "", SENTRY_LOG_LEVEL: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  let spawnError: Error | undefined;
  child.on("error", (error) => { spawnError = error; });
  const capture = (chunk: Buffer) => { logs = `${logs}${chunk.toString()}`.slice(-4000); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  stack.defer(async () => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  });
  if (child.pid) await trackResource({ kind: "process", id: String(child.pid), label: "acme-ai-gateway", match: "src/server.ts" });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (spawnError || child.exitCode !== null) throw new Error(`Acme Gateway failed: ${spawnError?.message ?? logs}`);
    if (await fetch(`${settings.baseUrl}/ready`, { signal: AbortSignal.timeout(2000) }).then((res) => res.ok).catch(() => false)) return;
    await delay(500);
  }
  throw new Error(`Acme Gateway readiness timed out: ${logs}`);
}

export async function seedAcmeGateway(admin: DenSession, upstream: Awaited<ReturnType<typeof startAcmeUpstream>>) {
  const headers = { authorization: `Bearer ${admin.token}` };
  const orgs = await denFetch(admin, "/v1/me/orgs", { headers });
  const org = record(orgs.body) && Array.isArray(orgs.body.orgs) ? orgs.body.orgs.find(record) : undefined;
  if (!orgs.response.ok || !org || typeof org.id !== "string") throw new Error("Acme organization missing.");
  const orgId = org.id;
  const orgHeaders = { ...headers, "x-openwork-org-id": orgId };
  const capability = await denFetch(admin, `/v1/admin/organizations/${orgId}/capabilities`, {
    method: "PUT", headers, body: JSON.stringify({ capabilities: { gatewayDashboard: true } }),
  });
  if (!capability.response.ok) throw new Error(`Acme gateway dashboard setup failed: HTTP ${capability.response.status}`);
  const created = await denFetch(admin, "/v1/inference-providers", {
    method: "POST", headers: orgHeaders,
    body: JSON.stringify({ name: "Acme AI Gateway", providerId: "anthropic", modelIds: [ACME_MODEL],
      credential: { kind: "api_key", secret: upstream.key }, settings: { upstreamBaseUrl: `${upstream.baseUrl}/v1` }, allMembers: true }),
  });
  const provider = record(created.body) && record(created.body.inferenceProvider) ? created.body.inferenceProvider : undefined;
  if (created.response.status !== 201 || typeof provider?.id !== "string") throw new Error(`Acme provider creation failed: HTTP ${created.response.status}`);
  const providerId = provider.id;
  const connected = await denFetch(admin, `/v1/inference-providers/${providerId}/connect`, { headers: orgHeaders });
  const connection = record(connected.body) && record(connected.body.inferenceProvider) ? connected.body.inferenceProvider : undefined;
  const model = Array.isArray(connection?.models) ? connection.models.find(record) : undefined;
  if (!connected.response.ok || typeof model?.id !== "string" || typeof model.name !== "string") {
    throw new Error(`Acme gateway model not usable: HTTP ${connected.response.status}`);
  }
  return { orgId, providerId, modelId: model.id, modelName: model.name };
}
