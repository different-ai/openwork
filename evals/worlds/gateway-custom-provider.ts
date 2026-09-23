import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { allocateFreePort } from "@openwork/cdp";
import { localMysqlIsRunning, SkipError, type Place, type Seed } from "@openwork/env";
import { setTimeout as delay } from "node:timers/promises";
import { usageRecord, usageRecords, usageString } from "./gateway-usage-policy.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
export const customEndpointKey = "custom-endpoint-fixture-key";
export const customEndpointModels = ["team-llm-a", "team-llm-b"];

type ChatWitness = { path: string; credential: string; model: unknown };

/** A minimal OpenAI-compatible server: lists its models and answers chat completions. */
async function startCompatibleEndpoint() {
  const chats: ChatWitness[] = [];
  const app = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const authorized = request.headers.authorization === `Bearer ${customEndpointKey}`;
      if (request.method === "GET" && request.url?.endsWith("/models")) {
        response.writeHead(authorized ? 200 : 401, { "content-type": "application/json" });
        response.end(JSON.stringify(authorized ? { object: "list", data: customEndpointModels.map((id) => ({ id, object: "model" })) } : { error: { message: "missing key" } }));
        return;
      }
      if (request.method === "POST" && request.url?.endsWith("/chat/completions")) {
        const body = usageRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        chats.push({ path: request.url, credential: request.headers.authorization ?? "", model: body.model });
        response.writeHead(authorized ? 200 : 401, { "content-type": "application/json" });
        response.end(JSON.stringify(authorized
          ? { id: "chatcmpl-fixture", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "Custom endpoint answered" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }
          : { error: { message: "missing key" } }));
        return;
      }
      response.writeHead(404);
      response.end();
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const address = app.address();
  if (!address || typeof address === "string") throw new Error("Custom endpoint fixture failed to bind");
  return {
    url: `http://127.0.0.1:${address.port}/v1`, chats,
    async [Symbol.asyncDispose]() { await new Promise<void>((resolve) => { app.close(() => resolve()); app.closeAllConnections(); }); },
  };
}

export async function gatewayCustomProvider(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new SkipError("co-located Den, Gateway, MySQL and a loopback OpenAI-compatible endpoint");
  if (process.env.OPENWORK_EVAL_DEN_API_URL?.trim() || process.env.OPENWORK_EVAL_DEN_WEB_URL?.trim()) throw new Error("The custom provider journey requires a fresh testkit Den, never an attached service");
  if (!await localMysqlIsRunning()) throw new SkipError("local MySQL for a disposable openwork_eval_ database");
  await using setup = new AsyncDisposableStack();
  const endpoint = setup.use(await startCompatibleEndpoint());
  const endpointOrigin = new URL(endpoint.url).origin;
  const port = await allocateFreePort();
  const gatewayUrl = `http://127.0.0.1:${port}`;
  const den = await seed.den({
    web: true,
    schema: "migrate",
    env: {
      NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql",
      DEN_ORG_MODE: "multi_org", DEN_PLAN_GATING_ENABLED: "false",
      GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: gatewayUrl,
      GATEWAY_PUBLIC_BASE_URL: gatewayUrl, GATEWAY_EGRESS_ALLOWED_ORIGINS: endpointOrigin,
      PROVISIONER_MODE: "stub", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "", SENTRY_DSN: "",
    },
    org: {
      name: `Custom Provider Journey ${Date.now()}`,
      admin: { name: "Custom Admin", email: "custom-admin@example.test" },
      members: { member: { name: "Custom Member", email: "custom-member@example.test" } },
    },
  });
  const databaseUrl = den.database?.url;
  if (!databaseUrl) throw new Error("Expected testkit scratch database");
  const member = den.members.member;
  if (!member) throw new Error("Expected a synthetic member session");
  const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", "src/server.ts"], {
    cwd: `${root}/ee/apps/gateway`, stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", OPENWORK_DEV_MODE: "1",
      PORT: String(port), GATEWAY_PORT: String(port), GATEWAY_ENABLED: "true",
      DATABASE_URL: databaseUrl, DB_MODE: "mysql",
      DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890",
      GATEWAY_PROXY_BASE_URL: gatewayUrl, GATEWAY_PUBLIC_BASE_URL: gatewayUrl,
      GATEWAY_EGRESS_ALLOWED_ORIGINS: endpointOrigin, GATEWAY_WEBHOOK_SECRET: "custom-journey-webhook-only",
      SENTRY_DSN: "", SENTRY_LOG_LEVEL: "off",
    },
  });
  let logs = "";
  child.stdout?.on("data", (chunk) => { logs = `${logs}${String(chunk)}`.slice(-8000); });
  child.stderr?.on("data", (chunk) => { logs = `${logs}${String(chunk)}`.slice(-8000); });
  setup.defer(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  });
  const deadline = Date.now() + 60_000;
  while (true) {
    if (child.exitCode !== null || Date.now() >= deadline) throw new Error(`Gateway readiness failed (exit ${child.exitCode}): ${logs}`);
    if (await fetch(`${gatewayUrl}/ready`, { signal: AbortSignal.timeout(2000) }).then((response) => response.ok).catch(() => false)) break;
    await delay(500);
  }
  const admin = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/ai-gateway/providers/new", headless: true, viewport: { width: 1440, height: 1200 } });
  const resources = setup.move();
  return {
    den, admin, member, endpointUrl: endpoint.url, gatewayUrl,
    endpointChats: () => endpoint.chats,
    /** The member's view of a provider: Gateway key, Gateway base URL and usable model aliases. */
    async connect(inferenceProviderId: string) {
      const response = await seed.api(member, `/v1/inference-providers/${inferenceProviderId}/connect`);
      if (!response.response.ok) throw new Error(`Member connect: HTTP ${response.response.status} ${response.text.slice(0, 300)}`);
      const connected = usageRecord(usageRecord(response.body).inferenceProvider);
      return {
        apiKey: usageString(connected.apiKey),
        baseUrl: usageString(usageRecord(connected.providerConfig).api),
        models: usageRecords(connected.models).map((model) => usageString(model.id)),
      };
    },
    async chat(baseUrl: string, apiKey: string, model: string) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, stream: false, max_tokens: 16, messages: [{ role: "user", content: "Custom endpoint witness" }] }),
        signal: AbortSignal.timeout(30_000),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
  };
}
