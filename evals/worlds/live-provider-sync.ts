import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { allocateFreePort } from "@openwork/cdp";
import { denFetch } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { readHeadlessRuntimeManifest, resolveHeadlessWorldRuntimePaths } from "@openwork/world";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";
import { isRecord } from "./openwork-server-cli.ts";

export interface ManagedModel {
  providerId: string;
  providerName: string;
  id: string;
  upstreamId: string;
  name: string;
}
export interface ExpectedProvider { id: string; models: string[]; name?: string }
export interface AdminAcknowledgement { acknowledgedAt: number; status: number; path: string; body: unknown }

/** Real authenticated Den writes, bundled plugin, real v2 engine, real picker. */
export async function liveProviderSync(seed: Seed) {
  if (process.env.OPENWORK_EVAL_DEN_API_URL) throw new Error("Live provider lifecycle proof requires a cold, isolated seeded Den, not a reused server");
  const gatewayUrl = `http://127.0.0.1:${await allocateFreePort()}`;
  const { den, webPort } = await denForAppWeb(seed, {
    web: false,
    org: { admin: { name: "Avery Owner" }, members: { riley: { name: "Riley Member" }, jordan: { name: "Jordan Member" } } },
    env: { GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: gatewayUrl, GATEWAY_PUBLIC_BASE_URL: gatewayUrl },
  });
  const organizationId = await seededOrganizationId(seed, den.admin);
  const adminRequest = (path: string, method = "GET", body?: unknown) => denFetch(den.ref, path, {
    method,
    headers: { authorization: `Bearer ${den.admin.token}`, "x-openwork-org-id": organizationId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function write(path: string, method: string, body?: unknown): Promise<AdminAcknowledgement> {
    const result = await adminRequest(path, method, body);
    const acknowledgedAt = Date.now();
    if (!result.response.ok) throw new Error(`${method} ${path}: ${result.response.status} ${result.text.slice(0, 500)}`);
    return { acknowledgedAt, status: result.response.status, path: `${method} ${path}`, body: result.body };
  }
  const context = await adminRequest("/v1/org");
  const members = isRecord(context.body) && Array.isArray(context.body.members) ? context.body.members.filter(isRecord) : [];
  function memberId(name: string) {
    const id = members.find((member) => isRecord(member.user) && member.user.name === name)?.id;
    if (typeof id !== "string") throw new Error(`Missing seeded member ${name}`);
    return id;
  }
  const rileyId = memberId("Riley Member");
  const jordanId = memberId("Jordan Member");
  async function team(name: string, id: string) {
    const result = await write("/v1/teams", "POST", { name, memberIds: [id] });
    const value = isRecord(result.body) && isRecord(result.body.team) ? result.body.team.id : null;
    if (typeof value !== "string") throw new Error("Creating the isolated audience team failed");
    return value;
  }
  const rileyTeam = await team("Live sync readers", rileyId);
  const jordanTeam = await team("Other readers", jordanId);
  const initialModel = "gpt-4o-mini";
  const siblingModel = "gpt-4.1-mini";
  const addedModel = "gpt-4.1";
  const initialName = "Live sync baseline";
  const extraName = "Live sync added provider";
  const renamedName = "Live sync renamed provider";
  async function createProvider(name: string, modelIds: string[]) {
    const acknowledgement = await write("/v1/inference-providers", "POST", {
      name, providerId: "openai", modelIds,
      credential: { kind: "api_key", secret: "synthetic-live-sync-upstream-key" }, memberIds: [rileyId],
    });
    const provider = isRecord(acknowledgement.body) && isRecord(acknowledgement.body.inferenceProvider) ? acknowledgement.body.inferenceProvider : null;
    const group = provider && Array.isArray(provider.modelGroups) ? provider.modelGroups.find(isRecord) : null;
    const set = provider && Array.isArray(provider.credentialSets) ? provider.credentialSets.find(isRecord) : null;
    const grant = provider && Array.isArray(provider.accessGrants) ? provider.accessGrants.find(isRecord) : null;
    if (!provider || typeof provider.id !== "string" || !group || typeof group.id !== "string" || !set || typeof set.id !== "string" || !grant || typeof grant.id !== "string") {
      throw new Error("Creating the real Den provider did not return its identity, model group, credential set and member grant");
    }
    return { acknowledgement, id: provider.id, groupId: group.id, setId: set.id, grantId: grant.id };
  }
  const baseline = await createProvider(initialName, [initialModel, siblingModel]);
  const fixtureHostToken = randomBytes(32).toString("hex");
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, as: "riley", engine: "v2", name: "live-provider-sync", workspacePath: seed.tmpPath("live-provider-sync"),
    env: {
      OPENWORK_HOST_TOKEN: fixtureHostToken, VITE_OPENWORK_HOST_TOKEN: fixtureHostToken,
      // A five-second pass must not be ordinary periodic sync in disguise.
      OPENWORK_CLOUD_PROVIDER_SYNC_INTERVAL_MS: "600000",
      // Without an override, the shipping server installs its pinned verified v2
      // binary. No external opencode2 command or CLI --engine flag is required.
      ...(process.env.OPENWORK_OPENCODE_BIN ? { OPENWORK_OPENCODE_BIN: process.env.OPENWORK_OPENCODE_BIN } : {}),
      ...(process.env.OPENWORK_OPENCODE2_BIN ? { OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_OPENCODE2_BIN } : {}),
    },
  });
  const paths = resolveHeadlessWorldRuntimePaths(fileURLToPath(new URL("../../", import.meta.url)), app.handle.name);
  const manifest = await readHeadlessRuntimeManifest(paths.runtimeManifestPath);
  if (!manifest) throw new Error("Missing owned app runtime manifest");
  const minted = await fetch(`${app.openworkUrl}/tokens`, {
    method: "POST", headers: { "X-OpenWork-Host-Token": manifest.hostToken, "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "owner", label: "live-provider-sync-proof" }),
  });
  const owner: unknown = await minted.json();
  if (!minted.ok || !isRecord(owner) || typeof owner.token !== "string") throw new Error("Could not mint the app observer token");
  const token = owner.token;
  let session: Awaited<ReturnType<typeof seed.session>>;
  try {
    session = await seed.session(app, { title: "Organization models arrive live" });
  } catch (error) {
    const response = await fetch(`${app.openworkUrl}/experimental/engine-v2-preview/status`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
    });
    const status: unknown = await response.json();
    throw new Error(`Cold v2 session creation failed: ${error instanceof Error ? error.message : String(error)}; native startup status ${JSON.stringify(status)}`);
  }
  await app.client.send("Performance.enable");
  // Den is the source of canonical opaque aliases and catalog display names.
  // Keep identity witnesses across removal, disablement and access revocation.
  const knownModels = new Map<string, ManagedModel>();
  async function catalog(person: "riley" | "jordan", expected: ExpectedProvider[]): Promise<ManagedModel[]> {
    const member = den.members[person];
    if (!member) throw new Error(`Missing signed-in member ${person}`);
    const result = await denFetch(den.ref, "/v1/inference-providers", { headers: {
      authorization: `Bearer ${member.token}`, "x-openwork-org-id": organizationId,
    } });
    if (!result.response.ok || !isRecord(result.body) || !Array.isArray(result.body.inferenceProviders)) throw new Error("Reading the member's real Den catalog failed");
    const providers = result.body.inferenceProviders.filter(isRecord);
    if (providers.map((provider) => provider.id).sort().join() !== expected.map((provider) => provider.id).sort().join()) throw new Error(`${person}'s provider scope differs from the explicitly expected provider IDs`);
    const models: ManagedModel[] = [];
    for (const provider of providers) {
      const expectation = expected.find((item) => item.id === provider.id);
      if (!expectation || !Array.isArray(provider.models) || typeof provider.id !== "string" || typeof provider.name !== "string") throw new Error("Invalid Den provider summary");
      if (expectation.name !== undefined && provider.name !== expectation.name) throw new Error("Den provider metadata differs from the acknowledged rename");
      const entries = provider.models.filter(isRecord);
      if (entries.map((model) => model.upstreamModelId).sort().join() !== [...expectation.models].sort().join()) throw new Error(`${person}'s model scope differs from the explicitly expected upstream IDs`);
      for (const model of entries) {
        if (typeof model.id !== "string" || typeof model.upstreamModelId !== "string" || typeof model.name !== "string" || !model.name) throw new Error("Invalid Den model identity or display name");
        const value = { providerId: provider.id, providerName: provider.name, id: model.id, upstreamId: model.upstreamModelId, name: model.name };
        const key = `${provider.id}/${model.upstreamModelId}`;
        const previous = knownModels.get(key);
        if (previous && (previous.id !== value.id || previous.name !== value.name)) throw new Error(`Model identity or catalog name changed unexpectedly for ${key}`);
        knownModels.set(key, value);
        models.push(value);
      }
    }
    return models;
  }
  return {
    app, den, workspace, session, organizationId, baseline, initialModel, siblingModel, addedModel, initialName, extraName, renamedName,
    rileyId, jordanId, rileyTeam, jordanTeam, catalog,
    async diagnostics() {
      const call = async (path: string) => {
        const response = await fetch(`${app.openworkUrl}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
        const body: unknown = await response.json();
        return { status: response.status, body };
      };
      const engine = await call("/experimental/engine-v2-preview/status");
      const plugins = await call(`/workspace/${workspace.workspaceId}/opencode2/api/plugin`);
      const models = await call(`/workspace/${workspace.workspaceId}/opencode2/api/model`);
      return {
        engine,
        plugins: { status: plugins.status, entries: Array.isArray(plugins.body) ? plugins.body.map((entry) => isRecord(entry) ? { id: entry.id, status: entry.status, error: entry.error } : null) : plugins.body },
        models: { status: models.status, ids: Array.isArray(models.body) ? models.body.filter(isRecord).map((model) => ({ providerID: model.providerID, id: model.id })) : models.body },
      };
    },
    pickerRows: '[data-testid="composer-model-picker"] [data-model-key^="ipr_"]',
    rowSelector(model: ManagedModel) { return `[data-testid="composer-model-picker"] [data-model-key="${model.providerId}:${model.id}"]`; },
    async documentIdentity() {
      const metrics = await app.client.send("Performance.getMetrics");
      const navigation = isRecord(metrics) && Array.isArray(metrics.metrics) ? metrics.metrics.find((metric) => isRecord(metric) && metric.name === "NavigationStart") : null;
      if (!isRecord(navigation) || typeof navigation.value !== "number") throw new Error("Missing browser navigation witness");
      return navigation.value;
    },
    async runtime() {
      const result = await fetch(`${app.openworkUrl}/experimental/engine-v2-preview/status`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
      });
      const body: unknown = await result.json();
      return isRecord(body) ? body : {};
    },
    createProvider,
    patchProvider(id: string, body: unknown) { return write(`/v1/inference-providers/${id}`, "PATCH", body); },
    deleteProvider(id: string) { return write(`/v1/inference-providers/${id}`, "DELETE"); },
    addModel() { return write(`/v1/inference-providers/${baseline.id}/enable-models`, "POST", { modelGroupId: baseline.groupId, modelIds: [addedModel] }); },
    enableModels(id: string, groupId: string, modelIds: string[]) { return write(`/v1/inference-providers/${id}/enable-models`, "POST", { modelGroupId: groupId, modelIds }); },
    patchGroup(id: string, groupId: string, body: unknown) { return write(`/v1/inference-providers/${id}/model-groups/${groupId}`, "PATCH", body); },
    revokeGrant(id: string, grantId: string) { return write(`/v1/inference-providers/${id}/access-grants/${grantId}`, "DELETE"); },
    grant(id: string, groupId: string, setId: string, audience: { type: "member"; memberId: string } | { type: "team"; teamId: string }) {
      return write(`/v1/inference-providers/${id}/access-grants`, "POST", { modelGroupId: groupId, credentialSetId: setId, audience });
    },
    patchGrant(id: string, grantId: string, audience: { type: "member"; memberId: string } | { type: "team"; teamId: string }) {
      return write(`/v1/inference-providers/${id}/access-grants/${grantId}`, "PATCH", { audience });
    },
  };
}
