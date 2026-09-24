import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { allocateFreePort } from "@openwork/cdp";
import { localMysqlIsRunning, queryDenDatabase, resolveEvalEngine, SkipError, type Place, type Seed } from "@openwork/env";
import { engineSessionProbe } from "@openwork/behaviors";
import { startInferenceWitness } from "@openwork/labs";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../..", import.meta.url));
const upstreamSecret = "gateway-usage-fixture-upstream-only";

export function usageRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected Gateway response object");
  return Object.fromEntries(Object.entries(value));
}

export function usageString(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected nonempty Gateway response string");
  return value;
}

export function usageRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected Gateway response array");
  return value.map(usageRecord);
}

export async function gatewayUsagePolicy(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new SkipError("co-located Den, Gateway, MySQL and loopback upstream; this world cannot provision a remote Gateway");
  if (process.env.OPENWORK_EVAL_DEN_API_URL?.trim() || process.env.OPENWORK_EVAL_DEN_WEB_URL?.trim()) throw new Error("Gateway usage journey requires a fresh testkit Den, never an attached service");
  if (!await localMysqlIsRunning()) throw new SkipError("local MySQL for a disposable openwork_eval_ database");
  await using setup = new AsyncDisposableStack();
  const witness = setup.use(await startInferenceWitness({ reportedCostUsd: 1 }));
  witness.mode("json");
  const port = await allocateFreePort();
  const gatewayUrl = `http://127.0.0.1:${port}`;
  const den = await seed.den({
    web: true,
    schema: "migrate",
    env: {
      NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql",
      DEN_ORG_MODE: "multi_org", DEN_PLAN_GATING_ENABLED: "false",
      GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: gatewayUrl,
      GATEWAY_PUBLIC_BASE_URL: gatewayUrl, GATEWAY_EGRESS_ALLOWED_ORIGINS: new URL(witness.url).origin,
      PROVISIONER_MODE: "stub", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "", SENTRY_DSN: "",
    },
    org: {
      name: `Gateway Usage Journey ${Date.now()}`,
      admin: { name: "Usage Admin", email: "usage-admin@example.test" },
      members: {
        member: { name: "Usage Member", email: "usage-member@example.test" },
        control: { name: "Usage Control", email: "usage-control@example.test" },
      },
    },
  });
  const databaseUrl = den.database?.url;
  if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/openwork_eval_")) throw new Error("Expected testkit scratch database");
  for (const name of ["0105_gateway_incremental_usage", "0106_gateway_usage_lifecycle", "0107_gateway_usage_durable_capture", "0108_gateway_usage_organization_assignments"]) {
    const migration = await readFile(`${root}/ee/packages/den-db/drizzle/${name}.sql`, "utf8");
    const migrationHash = createHash("sha256").update(migration).digest("hex");
    const migrationReceipts = await queryDenDatabase(databaseUrl, "SELECT hash FROM __drizzle_migrations WHERE hash = ?", [migrationHash]);
    if (migrationReceipts.length !== 1) throw new Error(`Fresh journey database must have applied canonical migration ${name}`);
  }
  const member = den.members.member;
  const control = den.members.control;
  if (!member || !control) throw new Error("Expected two synthetic member sessions");
  const orgResponse = await seed.api(den.admin, "/v1/org");
  if (!orgResponse.response.ok) throw new Error(`Org lookup: HTTP ${orgResponse.response.status}`);
  const org = usageRecord(orgResponse.body);
  const orgId = usageString(usageRecord(org.organization).id);
  const members = usageRecords(org.members);
  const memberId = usageString(members.find((row) => usageRecord(row.user).email === member.email)?.id);
  const controlId = usageString(members.find((row) => usageRecord(row.user).email === control.email)?.id);
  const adminId = usageString(usageRecord(org.currentMember).id);
  const orgMetadata = await queryDenDatabase(databaseUrl, "SELECT JSON_CONTAINS_PATH(COALESCE(metadata, '{}'), 'one', '$.capabilities.gatewayDashboard') AS hasGatewayDashboard FROM organization WHERE id = ?", [orgId]);
  if (orgMetadata.length !== 1 || usageRecord(orgMetadata[0]).hasGatewayDashboard !== 0) throw new Error("Fresh Gateway journey organization must not have a dashboard capability override");
  const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", "src/server.ts"], {
    cwd: `${root}/ee/apps/gateway`, stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", OPENWORK_DEV_MODE: "1",
      PORT: String(port), GATEWAY_PORT: String(port), GATEWAY_ENABLED: "true",
      DATABASE_URL: databaseUrl, DB_MODE: "mysql",
      DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890",
      GATEWAY_PROXY_BASE_URL: gatewayUrl, GATEWAY_PUBLIC_BASE_URL: gatewayUrl,
      GATEWAY_EGRESS_ALLOWED_ORIGINS: new URL(witness.url).origin,
      OPENROUTER_UPSTREAM_URL: witness.url, GATEWAY_WEBHOOK_SECRET: "usage-journey-webhook-only",
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
  for (const path of ["/v1/inference-providers?scope=manageable", "/v1/gateway/usage-limit-policies"]) {
    const response = await seed.api(den.admin, path);
    if (response.response.status !== 200) throw new Error(`Default organization Gateway management requires no opt-in: ${path}, HTTP ${response.response.status}`);
  }
  const providerResponse = await seed.api(den.admin, "/v1/inference-providers", {
    method: "POST", body: JSON.stringify({
      name: "Usage journey provider", providerId: "openrouter", modelIds: ["openai/gpt-4o-mini"],
      credential: { kind: "api_key", secret: upstreamSecret }, allMembers: true,
      settings: { upstreamBaseUrl: witness.url },
    }),
  });
  if (providerResponse.response.status !== 201) throw new Error(`Provider setup: HTTP ${providerResponse.response.status} ${providerResponse.text.slice(0, 300)}`);
  const providerId = usageString(usageRecord(usageRecord(providerResponse.body).inferenceProvider).id);
  const connectResponse = await seed.api(member, `/v1/inference-providers/${providerId}/connect`);
  if (!connectResponse.response.ok) throw new Error(`Member connect: HTTP ${connectResponse.response.status}`);
  const connected = usageRecord(usageRecord(connectResponse.body).inferenceProvider);
  const apiKey = usageString(connected.apiKey);
  const modelId = usageString(usageRecords(connected.models)[0]?.id);
  const baseUrl = usageString(usageRecord(connected.providerConfig).api);
  if (new URL(baseUrl).origin !== gatewayUrl) throw new Error("Gateway connect escaped the owned loopback origin");
  const admin = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/ai-gateway?tab=limits", headless: true, viewport: { width: 1440, height: 1200 } }).catch((error: unknown) => {
    if (error instanceof Error && "error" in error && "suppressed" in error) {
      throw new AggregateError([error.suppressed, error.error], "Den browser setup and disposal failed");
    }
    throw error;
  });
  const desktop = await seed.desktop({ den, as: "member", name: "gateway-usage-member", model: `${providerId}/${modelId}` });
  const engine = resolveEvalEngine();
  const native = engineSessionProbe({ engine, surface: desktop, workspaceId: desktop.workspaceId });
  const resources = setup.move();
  return {
    den, admin, desktop, member, control, memberId, controlId, adminId, orgId, providerId, modelId, engine,
    modelName: usageString(usageRecords(connected.models)[0]?.name),
    async nativeMessages(sessionId: string) {
      const messages = await native.messages(sessionId);
      if (engine !== "v2" || !messages.ok) return messages;
      const body = usageRecord(messages.body);
      return { ...messages, data: messages.data.toReversed(), body: { ...body, data: usageRecords(body.data).toReversed() } };
    },
    async rejectedCalls() {
      return usageRecords(await queryDenDatabase(databaseUrl, "SELECT id, status, error_code, org_membership_id, requested_model FROM gateway_request_logs WHERE gateway_provider_id = ? AND org_membership_id = ? AND error_code = 'openwork_gateway_usage_limit_exceeded' AND completed_at IS NOT NULL", [providerId, memberId]));
    },
    streamSuccess: () => witness.mode("success"),
    upstreamCount: () => witness.requests.length,
    upstreamModel: () => witness.requests.at(-1)?.body.model,
    upstreamStreamed: () => witness.requests.at(-1)?.body.stream === true,
    async successfulCalls() {
      return usageRecords(await queryDenDatabase(databaseUrl, "SELECT status, outcome, cost_micro_usd, stream, org_membership_id, requested_model FROM gateway_request_logs WHERE gateway_provider_id = ? AND org_membership_id = ? AND outcome = 'ok' AND completed_at IS NOT NULL", [providerId, memberId]));
    },
    upstreamUsesOnlyOrgKey: () => witness.requests.every((request) => request.credential === `Bearer ${upstreamSecret}` && !JSON.stringify(request.body).includes(apiKey)),
    async generate() {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: modelId, stream: false, max_tokens: 32, messages: [{ role: "user", content: "Usage accounting witness" }] }),
        signal: AbortSignal.timeout(30_000),
      });
      const body: unknown = await response.json();
      return { status: response.status, body, errorCode: response.headers.get("x-openwork-error-code"), usageState: response.headers.get("x-openwork-usage-state") };
    },
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
  };
}
