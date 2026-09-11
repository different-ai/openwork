import { createServer, type ServerResponse } from "node:http";
import { expect } from "vitest";
import { denFetch, type DenSession } from "@openwork/behaviors";
import {
  eventually, gatewayBearerKey, gatewayBearerKeyLookupDigest, inferenceBearerKey,
  legacyInferenceBearerKeyLookupDigest, localMysqlIsRunning, queryDenDatabase, server, test,
} from "@openwork/testkit";

const local = process.env.OPENWORK_EVAL_DAYTONA !== "1" && !process.env.OPENWORK_EVAL_DEN_API_URL;
const mysql = await localMysqlIsRunning();
const title = !local ? "inference lifecycle skipped - needs isolated local placement"
  : !mysql ? "inference lifecycle skipped - needs scratch MySQL on 127.0.0.1:3306"
    : "member inference keys, OAuth revocation fences, and fail-safe gateway migration";

// A test-only Node preload in the isolated Den child, not a runner/global module mock.
// Only Google's two fixed endpoints are replaced; all product handlers and MySQL remain real.
const googlePreload = `
const originalFetch = globalThis.fetch;
const witness = new URL(process.env.INFERENCE_LIFECYCLE_WITNESS);
if (witness.hostname !== "127.0.0.1") throw new Error("Witness must be loopback");
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === "https://oauth2.googleapis.com/token") {
    const body = new URLSearchParams(init?.body);
    return originalFetch(witness.origin + "/exchange", {
      method: "POST", body: new URLSearchParams({code: body.get("code"), clientId: body.get("client_id")}), signal: init?.signal
    });
  }
  if (url === "https://oauth2.googleapis.com/revoke") {
    return originalFetch(witness.origin + "/revoke", {method: "POST", signal: init?.signal});
  }
  return originalFetch(input, init);
};`;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return { ...value };
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string");
  return value;
}
function list(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected array");
  return value.map(record);
}

async function googleWitness() {
  const calls: string[] = [];
  let pending: ServerResponse | undefined;
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = new URLSearchParams(Buffer.concat(chunks).toString());
    const code = body.get("code") ?? "";
    calls.push(req.url === "/revoke" ? "revoke" : code);
    if (code.startsWith("wait-")) { pending = res; return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ access_token: `fake-access-${code}`, refresh_token: `fake-refresh-${code}`, expires_in: 3600 }));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Witness failed to bind");
  return {
    url: `http://127.0.0.1:${address.port}`, calls,
    release() {
      if (!pending) throw new Error("No pending Google exchange");
      pending.setHeader("content-type", "application/json");
      pending.end(JSON.stringify({ access_token: "fake-delayed-access", refresh_token: "fake-delayed-refresh", expires_in: 3600 }));
      pending = undefined;
    },
    async [Symbol.asyncDispose]() {
      pending?.destroy();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

test.skipIf(!local || !mysql)(title, { timeout: 600_000 }, async ({ place }) => {
  await using google = await googleWitness();
  const name = `Gateway lifecycle ${Date.now()}`;
  await using den = await server({ place, web: false, env: {
    NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql",
    GATEWAY_ENABLED: "true",
    GATEWAY_PROXY_BASE_URL: "http://127.0.0.1:18791",
    GATEWAY_PUBLIC_BASE_URL: "http://127.0.0.1:18791",
    NODE_OPTIONS: `--conditions=development --import=data:text/javascript,${encodeURIComponent(googlePreload)}`,
    INFERENCE_LIFECYCLE_WITNESS: google.url,
  }, org: { name, admin: { name: "Lifecycle Owner" }, members: { member: { name: "Lifecycle Member" }, outsider: { name: "Lifecycle Outsider" } } } });
  const database = den.database?.url;
  if (!database) throw new Error("Refusing lifecycle fixtures without a testkit-owned scratch database");
  const member = den.members.member;
  const outsider = den.members.outsider;
  if (!member || !outsider) throw new Error("Missing provisioned identities");
  const orgs = await denFetch(den.admin, "/v1/me/orgs", { headers: { authorization: `Bearer ${den.admin.token}` } });
  const orgId = text(list(record(orgs.body).orgs).find((org) => org.name === name)?.id);
  async function request(session: DenSession, path: string, method = "GET", body?: Record<string, unknown>) {
    return denFetch(session, path, { method, headers: { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId, accept: "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
  }
  const org = await request(den.admin, "/v1/org");
  const members = list(record(org.body).members);
  const memberId = text(members.find((entry) => record(entry.user).email === member.email)?.id);
  const ownerId = text(members.find((entry) => record(entry.user).email === den.admin.email)?.id);
  const outsiderRow = members.find((entry) => record(entry.user).email === outsider.email);
  const outsiderId = text(outsiderRow?.id);
  const outsiderUserId = text(record(outsiderRow?.user).id);
  const sql = (statement: string, values: string[] = []) => queryDenDatabase(database, statement, values);
  const keys = (id = memberId) => sql("SELECT id, key_hash, status, encrypted_key FROM gateway_keys WHERE organization_id = ? AND org_membership_id = ? AND status = 'active' AND revoked_at IS NULL", [orgId, id]);
  const modelsKeys = () => sql("SELECT id, key_hash, status, encrypted_key FROM inference_keys WHERE organization_id = ? AND org_membership_id = ? AND status = 'active'", [orgId, memberId]);
  const gatewayDigest = (value: string) => gatewayBearerKeyLookupDigest(gatewayBearerKey(value));
  // The legacy SHA-only digest is also the negative control for Gateway's domain separation.
  const legacyDigest = (value: string) => legacyInferenceBearerKeyLookupDigest(inferenceBearerKey(value));
  // No Models tier and no /connect yet: join itself must provision exactly one key.
  const inferenceEnabled = record((await sql("SELECT JSON_EXTRACT(metadata, '$.inference.enabled') AS enabled FROM organization WHERE id = ?", [orgId]))[0]).enabled;
  expect(inferenceEnabled == null || inferenceEnabled === false || inferenceEnabled === "false").toBe(true);
  expect(await keys()).toHaveLength(1);
  expect(await modelsKeys()).toHaveLength(0);
  const ownerKeys = await keys(ownerId);
  const outsiderKeys = await keys(outsiderId);
  expect(ownerKeys).toHaveLength(1);
  expect(outsiderKeys).toHaveLength(1);
  async function model(providerId: string) {
    const catalog = await request(den.admin, `/v1/llm-provider-catalog/${providerId}`);
    expect(catalog.response.status).toBe(200);
    const provider = record(record(catalog.body).provider);
    const compatible = list(provider.models).find((entry) => {
      const override = record(entry.config).provider;
      return !override || record(override).npm === undefined || record(override).npm === provider.npm;
    });
    return text(compatible?.id);
  }
  const anthropic = await model("anthropic");
  const gemini = await model("google-vertex");
  async function create(input: Record<string, unknown>) {
    const result = await request(den.admin, "/v1/inference-providers", "POST", input);
    expect(result.response.status).toBe(201);
    expect(result.text).not.toContain("fake-upstream-secret");
    expect(result.text).not.toContain("fake-client-secret");
    return record(record(result.body).inferenceProvider);
  }
  const shared = await create({ name: "Scoped Anthropic", providerId: "anthropic", modelIds: [anthropic], allMembers: true,
    credential: { kind: "api_key", secret: "fake-upstream-secret" } });
  const sharedId = text(shared.id);
  async function connect(session = member) {
    const result = await request(session, `/v1/inference-providers/${sharedId}/connect`);
    expect(result.response.status).toBe(200);
    expect(result.text).not.toContain("fake-upstream-secret");
    return record(record(result.body).inferenceProvider);
  }
  // Concurrent lazy repair on a member with no key must not issue multiple active rows.
  await sql("DELETE FROM gateway_keys WHERE organization_id = ? AND org_membership_id = ?", [orgId, memberId]);
  const connections = await Promise.all(Array.from({ length: 12 }, () => connect()));
  const key = text(connections[0]?.apiKey);
  expect(key).toMatch(/^ow_gw_[A-Za-z0-9_-]{43}$/);
  expect(new Set(connections.map((entry) => entry.apiKey)).size).toBe(1);
  expect(await keys()).toHaveLength(1);
  expect(record((await keys())[0]).key_hash).toBe(await gatewayDigest(key));
  expect(record((await keys())[0]).key_hash).not.toBe(await legacyDigest(key));
  expect(text(record((await keys())[0]).encrypted_key)).toMatch(/^enc:v1:/);
  const scopedEnv = `${sharedId.toUpperCase()}_ANTHROPIC_API_KEY`;
  expect(record(connections[0]?.providerConfig).env).toEqual([scopedEnv]);
  expect(record(connections[0]?.apiKeys)).toEqual({ [scopedEnv]: key });
  expect((await connect(outsider)).apiKey).not.toBe(key);

  // Models-only legacy backfill remains supported, but never supplies a Gateway key.
  await sql("UPDATE organization SET metadata = JSON_SET(COALESCE(metadata, JSON_OBJECT()), '$.inference', JSON_OBJECT('enabled', true, 'tier', 'tier1')) WHERE id = ?", [orgId]);
  const modelsList = await request(member, "/v1/llm-providers");
  expect(modelsList.response.status).toBe(200);
  const legacyId = text(list(record(modelsList.body).llmProviders).find((provider) => provider.source === "openwork")?.id);
  async function modelsConnect() {
    expect((await request(member, "/v1/llm-providers")).response.status).toBe(200);
    const result = await request(member, `/v1/llm-providers/${legacyId}/connect`);
    expect(result.response.status).toBe(200);
    return text(record(record(result.body).llmProvider).apiKey);
  }
  const modelsKey = await modelsConnect();
  expect(modelsKey).toMatch(/^ow_inf_[A-Za-z0-9_-]{43}$/);
  expect(modelsKey).not.toBe(key);
  expect(await modelsKeys()).toHaveLength(1);
  const gatewayBeforeModelsRepair = await keys();
  await sql("UPDATE inference_keys SET encrypted_key = NULL WHERE organization_id = ? AND org_membership_id = ? AND status = 'active'", [orgId, memberId]);
  expect(await modelsConnect()).toBe(modelsKey);
  expect(record((await modelsKeys())[0]).key_hash).toBe(await legacyDigest(modelsKey));
  await sql("UPDATE inference_keys SET encrypted_key = NULL, key_hash = ? WHERE organization_id = ? AND org_membership_id = ? AND status = 'active'", ["0".repeat(64), orgId, memberId]);
  const rotatedModelsKey = await modelsConnect();
  expect(rotatedModelsKey).toMatch(/^ow_inf_[A-Za-z0-9_-]{43}$/);
  expect(rotatedModelsKey).not.toBe(modelsKey);
  expect(rotatedModelsKey).not.toBe(key);
  expect(await modelsKeys()).toHaveLength(1);
  expect(await keys()).toEqual(gatewayBeforeModelsRepair);

  const modelsBeforeGatewayRepair = await modelsKeys();
  // Even valid Models ciphertext must not be imported into the Gateway store.
  await sql("UPDATE gateway_keys SET encrypted_key = (SELECT api_key FROM llm_provider WHERE id = ?) WHERE organization_id = ? AND org_membership_id = ?", [legacyId, orgId, memberId]);
  const recovered = await Promise.all(Array.from({ length: 8 }, () => connect()));
  const repairedKey = text(recovered[0]?.apiKey);
  expect(repairedKey).toMatch(/^ow_gw_[A-Za-z0-9_-]{43}$/);
  expect(repairedKey).not.toBe(key);
  expect(repairedKey).not.toBe(rotatedModelsKey);
  expect(new Set(recovered.map((entry) => entry.apiKey)).size).toBe(1);
  expect(await keys()).toHaveLength(1);
  expect(record((await keys())[0]).key_hash).toBe(await gatewayDigest(repairedKey));
  expect((await connect()).apiKey).toBe(repairedKey);
  expect(await modelsConnect()).toBe(rotatedModelsKey);
  expect(await modelsKeys()).toEqual(modelsBeforeGatewayRepair);
  expect(await keys(ownerId)).toEqual(ownerKeys);
  expect(await keys(outsiderId)).toEqual(outsiderKeys);

  const azure = await create({ name: "Azure Gateway", providerId: "azure", modelIds: [await model("azure")], memberIds: [memberId],
    settings: { resourceName: "fixture-resource", apiVersion: "2025-04-01-preview" }, credential: { kind: "api_key", secret: "fake-upstream-secret" } });
  const azureId = text(azure.id);
  const azureResponse = await request(member, `/v1/inference-providers/${azureId}/connect`);
  expect(azureResponse.response.status).toBe(200);
  expect(azureResponse.text).not.toContain("fake-upstream-secret");
  const azureConnect = record(record(azureResponse.body).inferenceProvider);
  const azureConfig = record(azureConnect.providerConfig);
  expect(azureConnect.id).toBe(azureId);
  expect(azureConnect.providerId).toBe("azure");
  expect(azureConfig.id).toBe("azure");
  expect(azureConfig.npm).toBe("@ai-sdk/azure");
  expect(azureConfig.env).toEqual([`${azureId.toUpperCase()}_AZURE_API_KEY`]);
  expect(azureConfig.options).toMatchObject({ resourceName: "fixture-resource", apiVersion: "2025-04-01-preview", baseURL: azureConfig.api });
  expect(text(azureConfig.api).endsWith(`/api/v1/providers/${azureId}`)).toBe(true);
  expect(azureConnect.apiKeys).toEqual({ [`${azureId.toUpperCase()}_AZURE_API_KEY`]: repairedKey });

  const vertex = await create({ name: "Member Vertex", providerId: "google-vertex", modelIds: [gemini], memberIds: [memberId],
    credentialMode: "member", settings: { project: "test-project", location: "us-central1" }, oauthClientId: "fake-client.apps.googleusercontent.com", oauthClientSecret: "fake-client-secret" });
  const vertexId = text(vertex.id);
  const vertexBase = `/v1/inference-providers/${vertexId}`;
  const vertexSets = list(vertex.credentialSets);
  expect(vertexSets).toHaveLength(1);
  const vertexSetId = text(vertexSets[0]?.id);
  const vertexGroups = list(vertex.modelGroups);
  expect(vertexGroups).toHaveLength(1);
  const vertexGroupId = text(vertexGroups[0]?.id);
  const vertexGrants = list(vertex.accessGrants);
  expect(vertexGrants).toHaveLength(1);
  let vertexGrantId = text(vertexGrants[0]?.id);
  expect(vertexGrants[0]).toMatchObject({ modelGroupId: vertexGroupId, credentialSetId: vertexSetId, audience: { type: "member", memberId } });
  async function grantMember() {
    const result = await request(den.admin, `${vertexBase}/access-grants`, "POST", { modelGroupId: vertexGroupId, credentialSetId: vertexSetId, audience: { type: "member", memberId } });
    expect(result.response.status).toBe(201);
    const grant = record(record(result.body).accessGrant);
    expect(grant).toMatchObject({ modelGroupId: vertexGroupId, credentialSetId: vertexSetId, audience: { type: "member", memberId } });
    vertexGrantId = text(grant.id);
  }
  expect(vertex.settings).toEqual({ project: "test-project", location: "us-central1" });
  expect(vertexSets[0]?.hasOauthClientSecret).toBe(true);
  expect(text(vertex.oauthCallbackUrl)).toMatch(/\/v1\/inference-providers\/oauth\/callback$/);
  expect(record(vertex.providerConfig).env).toEqual([`${vertexId.toUpperCase()}_GOOGLE_GENERATIVE_AI_API_KEY`]);
  expect((await request(outsider, `/v1/inference-providers/${vertexId}/oauth/start`)).response.status).toBe(403);
  async function start(session = member) {
    const result = await request(session, `${vertexBase}/oauth/start?credentialSetId=${vertexSetId}`);
    expect(result.response.status).toBe(200);
    const url = new URL(text(record(result.body).authUrl));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toBe(vertex.oauthCallbackUrl);
    const state = text(url.searchParams.get("state"));
    const rows = await sql("SELECT gateway_provider_id, credential_set_id, org_membership_id FROM gateway_provider_oauth_states WHERE state = ?", [state]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ gateway_provider_id: vertexId, credential_set_id: vertexSetId, org_membership_id: session === outsider ? outsiderId : memberId });
    return state;
  }
  async function callback(state: string, code: string) {
    return fetch(`${text(vertex.oauthCallbackUrl)}?state=${encodeURIComponent(state)}&code=${code}`, { signal: AbortSignal.timeout(30_000) });
  }
  const firstState = await start();
  expect((await callback(firstState, "success")).status).toBe(200);
  const replay = await callback(firstState, "replay");
  expect(replay.status).toBe(400);
  expect(google.calls).not.toContain("replay");
  const detail = await request(den.admin, `/v1/inference-providers/${vertexId}`);
  expect(detail.text).not.toContain("fake-access");
  expect(list(record(record(detail.body).inferenceProvider).credentials)).toContainEqual(expect.objectContaining({ credentialSetId: vertexSetId, subject: memberId, orgMembershipId: memberId, memberEmail: member.email, kind: "oauth_google", status: "active" }));
  const flatPatch = await request(den.admin, vertexBase, "PATCH", { memberIds: [] });
  expect(flatPatch.response.status).toBe(409);
  expect(record(flatPatch.body).error).toBe("matrix_write_required");
  // Access is reauthorized at callback; client/disable/disconnect explicitly invalidate consent.
  for (const action of ["disable", "access", "client", "disconnect"]) {
    if (action === "disconnect") expect((await callback(await start(), "reconnect")).status).toBe(200);
    const state = await start();
    const code = `wait-${action}`;
    const inflight = callback(state, code);
    await eventually(() => google.calls.includes(code), { within: 10_000, intervalMs: 20 });
    if (action === "disable") {
      expect((await request(den.admin, `/v1/inference-providers/${vertexId}`, "PATCH", { status: "disabled" })).response.status).toBe(200);
      expect((await request(den.admin, `/v1/inference-providers/${vertexId}`, "PATCH", { status: "active" })).response.status).toBe(200);
    } else if (action === "access") {
      expect((await request(den.admin, `${vertexBase}/access-grants/${vertexGrantId}`, "DELETE")).response.status).toBe(204);
      expect((await request(member, `${vertexBase}/connect`)).response.status).toBe(403);
    } else if (action === "client") {
      expect((await request(den.admin, `${vertexBase}/credential-sets/${vertexSetId}`, "PATCH", { oauthClientSecret: "fake-rotated-client-secret" })).response.status).toBe(200);
    } else {
      expect((await request(member, `/v1/inference-providers/${vertexId}/oauth`, "DELETE")).response.status).toBe(204);
    }
    google.release();
    expect((await inflight).status).toBe(400);
    expect(await sql("SELECT id FROM gateway_provider_oauth_states WHERE state = ? AND used_at IS NULL", [state])).toHaveLength(0);
    const callsBeforeReplay = google.calls.length;
    expect((await callback(state, "replay-denied")).status).toBe(400);
    expect(google.calls).toHaveLength(callsBeforeReplay);
    if (action === "access") await grantMember();
  }
  expect(await sql("SELECT id FROM gateway_provider_credentials WHERE gateway_provider_id = ? AND credential_set_id = ? AND subject = ? AND status = 'active'", [vertexId, vertexSetId, memberId])).toHaveLength(0);
  expect(google.calls.filter((call) => call === "revoke").length).toBeGreaterThanOrEqual(4);

  const teamResult = await request(den.admin, "/v1/teams", "POST", { name: "Lifecycle Team", memberIds: [memberId] });
  expect(teamResult.response.status).toBe(201);
  const teamId = text(record(record(teamResult.body).team).id);
  expect((await request(den.admin, `${vertexBase}/access-grants/${vertexGrantId}`, "PATCH", { audience: { type: "team", teamId } })).response.status).toBe(200);
  const teamState = await start();
  const teamInflight = callback(teamState, "wait-team");
  await eventually(() => google.calls.includes("wait-team"), { within: 10_000, intervalMs: 20 });
  expect((await request(den.admin, `/v1/teams/${teamId}`, "PATCH", { memberIds: [] })).response.status).toBe(200);
  expect((await request(member, `${vertexBase}/connect`)).response.status).toBe(403);
  google.release();
  expect((await teamInflight).status).toBe(400);
  expect((await request(den.admin, `/v1/teams/${teamId}`, "PATCH", { memberIds: [memberId] })).response.status).toBe(200);
  const callsBeforeTeamReplay = google.calls.length;
  expect((await callback(teamState, "team-replay")).status).toBe(400);
  expect(google.calls).toHaveLength(callsBeforeTeamReplay);
  expect((await request(den.admin, `${vertexBase}/access-grants/${vertexGrantId}`, "PATCH", { audience: { type: "member", memberId } })).response.status).toBe(200);

  for (const settings of [
    { project: "test-project", location: "us-central1.attacker.example/" },
    { project: "test-project", location: "us-central1", upstreamBaseUrl: "https://127.1" },
    { project: "test-project", location: "us-central1", upstreamBaseUrl: "https://127.1", allowPrivate: true },
  ]) {
    expect((await request(den.admin, `/v1/inference-providers/${vertexId}`, "PATCH", { settings })).response.status).toBe(400);
  }
  const rename = await request(den.admin, `/v1/inference-providers/${vertexId}`, "PATCH", { name: "Renamed Vertex" });
  expect(rename.response.status).toBe(200);
  expect(record(record(rename.body).inferenceProvider).settings).toEqual(vertex.settings);

  // Migration preserves selected IDs and audiences; matrix model metadata follows the trusted catalog.
  async function legacy(mode: string, providerId = "anthropic") {
    const result = await request(den.admin, "/v1/llm-providers", "POST", { source: "models_dev", providerId, name: `Legacy ${mode}`, modelIds: [providerId === "anthropic" ? anthropic : gemini], credentialMode: mode, apiKey: "fake-upstream-secret", allMembers: true });
    expect(result.response.status).toBe(201);
    return text(record(record(result.body).llmProvider).id);
  }
  const migrate = (id: string) => request(den.admin, "/v1/inference-providers/migrate-from-llm-provider", "POST", { llmProviderId: id });
  for (const template of [
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    "https://api.infomaniak.com/2/ai/${INFOMANIAK_PRODUCT_ID}/openai/v1",
    "https://api.example/%24%7BACCOUNT_ID%7D/v1",
  ]) {
    const id = await legacy("shared");
    await sql("UPDATE llm_provider SET provider_config = JSON_SET(provider_config, '$.api', ?) WHERE id = ?", [template, id]);
    const before = await sql("SELECT * FROM llm_provider WHERE id = ?", [id]);
    const children = await sql("SELECT * FROM llm_provider_model WHERE llm_provider_id = ?", [id]);
    const refused = await migrate(id);
    expect(refused.response.status).toBe(400);
    expect(record(refused.body).error).toBe("migration_requires_configuration");
    expect(await sql("SELECT * FROM llm_provider WHERE id = ?", [id])).toEqual(before);
    expect(await sql("SELECT * FROM llm_provider_model WHERE llm_provider_id = ?", [id])).toEqual(children);
  }
  const incompatibleSource = await legacy("shared");
  await sql("UPDATE llm_provider_model SET model_config = JSON_SET(model_config, '$.provider', JSON_OBJECT('npm', '@ai-sdk/openai')) WHERE llm_provider_id = ?", [incompatibleSource]);
  const incompatibleModels = await sql("SELECT * FROM llm_provider_model WHERE llm_provider_id = ?", [incompatibleSource]);
  expect((await migrate(incompatibleSource)).response.status).toBe(400);
  expect(await sql("SELECT id FROM llm_provider WHERE id = ?", [incompatibleSource])).toHaveLength(1);
  expect(await sql("SELECT * FROM llm_provider_model WHERE llm_provider_id = ?", [incompatibleSource])).toEqual(incompatibleModels);
  const sourceId = await legacy("shared");
  await sql("UPDATE llm_provider_model SET name = 'Pinned Custom Name', model_config = JSON_SET(model_config, '$.limit.output', 1234) WHERE llm_provider_id = ?", [sourceId]);
  const sourceAudiences = (await sql("SELECT org_membership_id, team_id FROM llm_provider_access WHERE llm_provider_id = ?", [sourceId])).map((value) => {
    const grant = record(value);
    expect(grant.org_membership_id === null || grant.team_id === null).toBe(true);
    return grant.org_membership_id !== null ? { type: "member", memberId: text(grant.org_membership_id) }
      : grant.team_id !== null ? { type: "team", teamId: text(grant.team_id) }
      : { type: "organization" };
  });
  expect(sourceAudiences).toEqual(expect.arrayContaining([{ type: "organization" }, { type: "member", memberId: ownerId }]));
  const migration = await Promise.all([migrate(sourceId), migrate(sourceId)]);
  expect(migration.map((result) => result.response.status).sort()).toEqual([201, 409]);
  const moved = record(record(migration.find((result) => result.response.status === 201)?.body).inferenceProvider);
  expect(moved.migration).toEqual({ llmProviderId: sourceId, runtimeEnvNames: [`LPR_${sourceId.slice(-5).toUpperCase()}_ANTHROPIC_API_KEY`] });
  const catalogReply = await request(den.admin, "/v1/llm-provider-catalog/anthropic");
  expect(catalogReply.response.status).toBe(200);
  const catalogModel = list(record(record(catalogReply.body).provider).models).find((entry) => entry.id === anthropic);
  if (!catalogModel) throw new Error("Migrated model is missing from the trusted catalog");
  const movedModels = list(moved.models);
  const movedGroups = list(moved.modelGroups);
  const movedSets = list(moved.credentialSets);
  expect(movedModels).toHaveLength(1);
  expect(movedGroups).toHaveLength(1);
  expect(movedSets).toHaveLength(1);
  expect(moved.modelIds).toEqual([anthropic]);
  expect(movedGroups[0]?.modelIds).toEqual([anthropic]);
  expect(movedSets[0]).toMatchObject({ credentialMode: "org", status: "active", configured: true, credentialStatus: "ready" });
  expect(movedModels[0]).toEqual({
    id: expect.stringMatching(/^gwm_[a-z0-9]+_[a-z0-9]+_[a-z0-9]+$/),
    name: catalogModel.name,
    config: { ...record(catalogModel.config), id: movedModels[0]?.id, name: catalogModel.name },
    upstreamModelId: anthropic,
    modelGroupId: movedGroups[0]?.id, modelGroupName: movedGroups[0]?.name,
    credentialSetId: movedSets[0]?.id, credentialSetName: movedSets[0]?.name,
  });
  const migratedGrants = list(moved.accessGrants);
  expect(new Set(migratedGrants.map((grant) => grant.id)).size).toBe(migratedGrants.length);
  const migratedTuples = migratedGrants.map(({ id, ...tuple }) => {
    expect(id).toMatch(/^ipa_/);
    return tuple;
  }).sort((left, right) => JSON.stringify(left.audience).localeCompare(JSON.stringify(right.audience)));
  const expectedTuples = sourceAudiences.map((audience) => ({ modelGroupId: movedGroups[0]?.id, credentialSetId: movedSets[0]?.id, audience }))
    .sort((left, right) => JSON.stringify(left.audience).localeCompare(JSON.stringify(right.audience)));
  expect(migratedTuples).toEqual(expectedTuples);
  expect(await sql("SELECT organization_id, created_by_org_membership_id FROM gateway_providers WHERE id = ?", [text(moved.id)])).toEqual([{ organization_id: orgId, created_by_org_membership_id: ownerId }]);
  expect(await sql("SELECT id FROM llm_provider WHERE id = ?", [sourceId])).toHaveLength(0);
  expect(await sql("SELECT id FROM llm_provider_model WHERE llm_provider_id = ?", [sourceId])).toHaveLength(0);
  expect(await sql("SELECT id FROM llm_provider_access WHERE llm_provider_id = ?", [sourceId])).toHaveLength(0);
  for (const [mode, providerId] of [["per_member", "anthropic"], ["shared", "google-vertex"]]) {
    const id = await legacy(mode, providerId);
    if (mode === "per_member") {
      expect((await request(member, `/v1/llm-providers/${id}/my-credential`, "PUT", { apiKey: "fake-member-key" })).response.status).toBe(200);
    }
    const before = await sql("SELECT * FROM llm_provider WHERE id = ?", [id]);
    const bindings = await sql("SELECT * FROM llm_provider_member_credential WHERE llm_provider_id = ?", [id]);
    const rejected = await migrate(id);
    expect(rejected.response.status).toBe(400);
    expect(record(rejected.body).error).toBe("migration_requires_configuration");
    expect(await sql("SELECT * FROM llm_provider WHERE id = ?", [id])).toEqual(before);
    expect(await sql("SELECT * FROM llm_provider_member_credential WHERE llm_provider_id = ?", [id])).toEqual(bindings);
    if (mode === "per_member") {
      expect(bindings).toHaveLength(1);
      await sql("UPDATE llm_provider SET credential_mode = 'shared' WHERE id = ?", [id]);
      expect((await migrate(id)).response.status).toBe(400);
      expect(await sql("SELECT * FROM llm_provider_member_credential WHERE llm_provider_id = ?", [id])).toEqual(bindings);
    }
  }
  // Removal while a code exchange is in flight must revoke keys and prevent new grants.
  expect((await callback(await start(), "before-remove")).status).toBe(200);
  const revokesBeforeRemoval = google.calls.filter((call) => call === "revoke").length;
  const state = await start();
  const inflight = callback(state, "wait-remove");
  await eventually(() => google.calls.includes("wait-remove"), { within: 10_000, intervalMs: 20 });
  const removed = await request(den.admin, `/v1/members/${memberId}`, "DELETE");
  expect(removed.response.ok).toBe(true);
  google.release();
  expect((await inflight).status).toBe(400);
  expect(google.calls.filter((call) => call === "revoke").length).toBeGreaterThanOrEqual(revokesBeforeRemoval + 2);
  expect(await keys()).toHaveLength(0);
  expect(await modelsKeys()).toHaveLength(0);
  expect(await sql("SELECT id FROM gateway_provider_oauth_states WHERE org_membership_id = ?", [memberId])).toHaveLength(0);
  expect(await sql("SELECT id FROM gateway_provider_credentials WHERE org_membership_id = ? AND status = 'active'", [memberId])).toHaveLength(0);
  // Global account deletion has a separate transaction from organization offboarding.
  expect((await request(den.admin, `${vertexBase}/access-grants`, "POST", { modelGroupId: vertexGroupId, credentialSetId: vertexSetId, audience: { type: "member", memberId: outsiderId } })).response.status).toBe(201);
  expect((await callback(await start(outsider), "before-account-delete")).status).toBe(200);
  const accountInflight = callback(await start(outsider), "wait-account-delete");
  await eventually(() => google.calls.includes("wait-account-delete"), { within: 10_000, intervalMs: 20 });
  expect((await request(den.admin, `/v1/admin/users/${outsiderUserId}`, "DELETE")).response.status).toBe(200);
  google.release();
  expect((await accountInflight).status).toBe(400);
  expect(await keys(outsiderId)).toHaveLength(0);
  expect(await sql("SELECT id FROM inference_keys WHERE org_membership_id = ? AND status = 'active'", [outsiderId])).toHaveLength(0);
  expect(await sql("SELECT id FROM gateway_provider_oauth_states WHERE org_membership_id = ?", [outsiderId])).toHaveLength(0);
  expect(await sql("SELECT id FROM gateway_provider_credentials WHERE org_membership_id = ? AND status = 'active'", [outsiderId])).toHaveLength(0);
  expect(await keys(ownerId)).toEqual(ownerKeys);
});
