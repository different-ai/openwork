import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { allocateFreePort } from "@openwork/cdp";
import type { Place, Seed } from "@openwork/env";
import { readAvailableModels, selectModel, signInDesktopAs, waitUntilInteractive } from "@openwork/behaviors";
import { engineParity } from "./engine-parity.ts";

export function parityRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a response object");
  return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a nonempty response string");
  return value;
}

/** Real Den + Gateway + MySQL. Only the upstream model response is synthetic. */
export async function engineGatewayParity(seed: Seed, context: { place: Place }) {
  await using setup = new AsyncDisposableStack();
  const port = await allocateFreePort();
  const gatewayUrl = `http://127.0.0.1:${port}`;
  const mock = (await seed.mock({ isolatedProcessEnv: true }).boot(context.place)).handle;
  setup.defer(() => mock.stop());
  const den = await seed.den({ web: true, env: {
    NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql", DEN_ORG_MODE: "multi_org",
    GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: gatewayUrl, GATEWAY_PUBLIC_BASE_URL: gatewayUrl,
    GATEWAY_EGRESS_ALLOWED_ORIGINS: new URL(mock.url).origin,
  }, org: { name: "Engine parity", members: { member: { name: "Parity Member" } } } });
  const base = setup.use(await engineParity(seed, context, { mock, env: {
    OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "1", OPENWORK_DEV_DEN_PROXY_TARGET: den.ref.webUrl,
    OPENWORK_DEV_HEADLESS_DEN_API_TARGET: den.ref.apiUrl,
    VITE_DEN_BASE_URL: den.ref.webUrl, VITE_DEN_API_BASE_URL: "/api/den",
  } }));
  const databaseUrl = den.database?.url;
  if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/openwork_eval_")) throw new Error("Expected disposable Den database");
  const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", "src/server.ts"], {
    cwd: fileURLToPath(new URL("../../ee/apps/gateway", import.meta.url)), stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", OPENWORK_DEV_MODE: "1",
      PORT: String(port), GATEWAY_PORT: String(port), GATEWAY_ENABLED: "true", DATABASE_URL: databaseUrl, DB_MODE: "mysql",
      DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890",
      GATEWAY_PROXY_BASE_URL: gatewayUrl, GATEWAY_PUBLIC_BASE_URL: gatewayUrl, GATEWAY_EGRESS_ALLOWED_ORIGINS: new URL(base.mock.url).origin,
      OPENROUTER_UPSTREAM_URL: `${base.mock.url}/v1`, SENTRY_DSN: "", SENTRY_LOG_LEVEL: "off",
    },
  });
  let logs = "";
  child.stdout.on("data", (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-4000); });
  child.stderr.on("data", (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-4000); });
  setup.defer(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  });
  const deadline = Date.now() + 60_000;
  while (!await fetch(`${gatewayUrl}/ready`).then((response) => response.ok).catch(() => false)) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Gateway did not start: ${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const member = den.members.member;
  if (!member) throw new Error("Missing synthetic member");
  await signInDesktopAs(base.app, { ...den.ref, apiUrl: `${base.app.webUrl}/api/den` }, member);
  const org = await seed.api(member, "/v1/org");
  const orgId = string(parityRecord(parityRecord(org.body).organization).id);
  const installed = await base.hostRequest("/den-session", "PUT", { baseUrl: den.ref.apiUrl, token: member.token, orgId });
  if (installed.status !== 204) throw new Error(`Could not deliver member identity: ${installed.status}`);
  // Sign-in resolves before the renderer finishes restoring the workspace.
  // Wait for that visible navigation instead of reading its transient root URL.
  const workspaceDeadline = Date.now() + 30_000;
  let workspaceId: string | undefined;
  while (!workspaceId) {
    const route = await base.route();
    workspaceId = /\/workspace\/([^/]+)/.exec(route)?.[1];
    if (workspaceId) break;
    if (Date.now() >= workspaceDeadline) throw new Error(`Gateway workspace did not restore after sign-in: ${route}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const observer = base.engine === "v2" ? await base.observeNativeCatalog(workspaceId) : null;
  if (observer) setup.defer(() => observer.stop());
  let providerId = "";
  let groupId = "";
  const models = ["openai/gpt-4o-mini", "openai/gpt-4o"];
  const resources = setup.move();
  return {
    ...base, den, models,
    readModels: () => readAvailableModels(base.app),
    nativeEvents: () => observer?.events ?? [],
    async nativeModelIds() {
      if (base.engine !== "v2") return [];
      const result = await base.request(`/workspace/${workspaceId}/opencode2/api/model`);
      const data = parityRecord(result.body).data;
      return Array.isArray(data) ? data.map(value => { const model = parityRecord(value); return { id: model.id, providerID: model.providerID }; }) : [];
    },
    selectModel: (id: string) => selectModel(base.app, id),
    async refreshLegacyCatalog() {
      if (base.engine !== "v1") throw new Error("A v2 test must never request the legacy refresh");
      const result = await base.hostRequest("/cloud-provider-sync/run", "POST", { reason: "parity-v1-legacy-refresh" });
      if (result.status !== 200) throw new Error(`Legacy sync failed: ${result.status}`);
      const reload = await base.request(`/workspace/${workspaceId}/engine/reload`, "POST");
      if (reload.status !== 200) throw new Error(`Legacy engine reload failed: ${reload.status}`);
      const previousDocument = await base.documentIdentity();
      await base.app.client.send("Page.reload");
      const deadline = Date.now() + 15_000;
      while (await base.documentIdentity().catch(() => previousDocument) === previousDocument) {
        if (Date.now() > deadline) throw new Error("Legacy app refresh did not create a new document");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await waitUntilInteractive(base.app);
    },
    async publish() {
      const result = await seed.api(den.admin, "/v1/inference-providers", { method: "POST", body: JSON.stringify({
        name: "Parity Gateway", providerId: "openrouter", modelIds: [models[0]], allMembers: true,
        credential: { kind: "api_key", secret: "parity-upstream-only" },
        settings: { upstreamBaseUrl: `${mock.url}/v1` },
      }) });
      if (result.response.status !== 201) throw new Error(`Publish gateway: ${result.response.status} ${result.text.slice(0, 300)}`);
      const provider = parityRecord(parityRecord(result.body).inferenceProvider);
      providerId = string(provider.id);
      if (!Array.isArray(provider.modelGroups) || !provider.modelGroups[0]) throw new Error("Missing initial Gateway model group");
      groupId = string(parityRecord(provider.modelGroups[0]).id);
      return providerId;
    },
    async updateModels(modelIds: string[]) {
      const result = await seed.api(den.admin, `/v1/inference-providers/${providerId}`, { method: "PATCH", body: JSON.stringify({ modelIds }) });
      if (!result.response.ok) throw new Error(`Update gateway models: ${result.response.status} ${result.text.slice(0, 300)}`);
      const group = await seed.api(den.admin, `/v1/inference-providers/${providerId}/model-groups/${groupId}`, {
        method: "PATCH", body: JSON.stringify({ modelIds }),
      });
      if (!group.response.ok) throw new Error(`Update assigned model group: ${group.response.status} ${group.text.slice(0, 300)}`);
    },
    async inventory() {
      const result = await seed.api(member, `/v1/inference-providers/${providerId}/connect`);
      if (!result.response.ok) throw new Error(`Gateway inventory: ${result.response.status}`);
      const models = parityRecord(parityRecord(result.body).inferenceProvider).models;
      if (!Array.isArray(models)) throw new Error("Missing gateway models");
      return models.map((value: unknown) => { const model = parityRecord(value); return { id: string(model.id), name: string(model.name), upstreamModelId: string(model.upstreamModelId) }; });
    },
    async routing() {
      const result = await seed.api(member, `/v1/inference-providers/${providerId}/connect`);
      const provider = parityRecord(parityRecord(result.body).inferenceProvider);
      const config = parityRecord(provider.providerConfig);
      const options = parityRecord(config.options ?? {});
      return { npm: config.npm, api: config.api, baseURL: options.baseURL, gatewayOrigin: gatewayUrl };
    },
    async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
  };
}
