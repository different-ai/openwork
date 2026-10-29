import { join } from "node:path";
import type { Seed } from "@openwork/env";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";
import { modelRemovalHttpFixture } from "./model-removal-cdp.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Scenario = "available" | "catalog-gap" | "removed" | "returned";

/** Real Den login, real native sessions, real app UI. Only the two independent
 * inventory HTTP responses and the native engine catalog HTTP responses are
 * deterministic faults. No renderer state, events, stores or test APIs are set. */
export async function modelRemovalRecovery(seed: Seed) {
  await using setup = new AsyncDisposableStack();
  const { den, webPort } = await denForAppWeb(seed);
  const organizationId = await seededOrganizationId(seed, den.admin);
  const models = [
    { id: "openai/gpt-6-luna", name: "GPT-6 Luna" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
  ];
  const old = models[3]!;
  const replacement = models[2]!;
  const created = await seed.api(den.admin, "/v1/llm-providers", {
    method: "POST", body: JSON.stringify({
      name: "Organization models", source: "custom", allMembers: true, memberIds: [], teamIds: [],
      apiKey: "synthetic-model-removal-key",
      customConfig: {
        id: "model-removal-fixture", name: "Organization models", npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:9/v1" }, env: ["MODEL_REMOVAL_FIXTURE_KEY"],
        models: models.map(model => ({ ...model, tool_call: true })),
      },
    }),
  });
  const provider = isRecord(created.body) && isRecord(created.body.llmProvider) ? created.body.llmProvider : null;
  if (!created.response.ok || !provider || typeof provider.id !== "string") throw new Error(`Creating the organization models failed: ${created.response.status} ${created.text}`);
  const providerID = provider.id;
  const token = "model-removal-local-owner";
  const hostToken = "model-removal-local-host";
  const { app, workspace } = await signedInAppWeb(seed, {
    name: "model-removal-recovery", den, webPort, headless: true, engine: "v2",
    workspacePath: join(seed.tmpPath("model-removal-recovery"), "Planning"),
    env: { OPENWORK_TOKEN: token, OPENWORK_HOST_TOKEN: hostToken, OPENWORK_CLOUD_PROVIDER_SYNC_INTERVAL_MS: "600000" },
  });
  const first = await seed.session(app, { title: "Report planning" });
  const second = await seed.session(app, { title: "Independent planning" });
  // Select through the shipping engine API before the first user act. The proof
  // then chooses the same named option through the picker, as a real member does.
  for (const session of [first, second]) {
    const response = await fetch(`${app.openworkUrl}/workspace/${workspace.workspaceId}/opencode2/api/session/${session.sessionId}/model`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "x-openwork-host-token": hostToken, "Content-Type": "application/json" },
      body: JSON.stringify({ model: { providerID, id: old.id } }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Selecting the saved organization model failed: ${response.status} ${await response.text()}`);
  }
  let scenario: Scenario = "available";
  const reads: { kind: "engine" | "legacy" | "gateway"; scenario: Scenario; at: number; oldPresent: boolean }[] = [];
  const denOrigin = new URL(den.ref.apiUrl).origin;
  const appOrigin = new URL(app.openworkUrl).origin;
  const bases = ["workspace", "w"].map(alias => `/${alias}/${encodeURIComponent(workspace.workspaceId)}/opencode2/api/model`);
  const providerBases = ["workspace", "w"].map(alias => `/${alias}/${encodeURIComponent(workspace.workspaceId)}/opencode2/api/provider`);
  const fixture = setup.use(await modelRemovalHttpFixture(app, [
    `${denOrigin}/v1/llm-providers*`, `${denOrigin}/v1/inference-providers*`,
    ...bases.map(base => `${appOrigin}${base}*`),
    ...providerBases.map(base => `${appOrigin}${base}`),
  ], url => {
    const oldPresent = scenario === "available" || scenario === "returned";
    if (url.origin === appOrigin && providerBases.includes(url.pathname)) {
      return { data: [{ id: providerID, name: "Organization models" }] };
    }
    if (url.origin === appOrigin && bases.includes(url.pathname)) {
      reads.push({ kind: "engine", scenario, at: Date.now(), oldPresent });
      return { data: models.filter(model => oldPresent || model.id !== old.id).map(model => ({
        ...model, providerID, capabilities: { input: ["text"], output: ["text"], tools: true },
        limit: { context: 200000, output: 8192 }, cost: [{ input: 1, output: 2 }],
      })) };
    }
    if (url.origin === denOrigin && url.pathname === "/v1/llm-providers") {
      const assigned = scenario !== "removed";
      reads.push({ kind: "legacy", scenario, at: Date.now(), oldPresent: assigned });
      return { llmProviders: [{ ...provider, pinnedModelIds: [models[0]!.id],
        models: models.filter(model => assigned || model.id !== old.id),
      }] };
    }
    if (url.origin === denOrigin && url.pathname === "/v1/inference-providers" && url.searchParams.get("scope") === "usable") {
      reads.push({ kind: "gateway", scenario, at: Date.now(), oldPresent: false });
      return { inferenceProviders: [] };
    }
    return undefined;
  }));
  const resources = setup.move();
  return {
    app, den, first, second, old, replacement, providerID, organizationId,
    scenario(next: Scenario) { fixture.check(); scenario = next; },
    reads() { fixture.check(); return [...reads]; },
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
  };
}
