import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { expect } from "vitest";
import { denFetch, type DenSession } from "@openwork/behaviors";
import { eventually, localMysqlIsRunning, queryDenDatabase, server, test } from "@openwork/testkit";

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
  const keys = () => sql("SELECT id, key_hash, status FROM inference_keys WHERE org_membership_id = ? AND status = 'active'", [memberId]);
  // No Models tier and no /connect yet: join itself must provision exactly one key.
  const inferenceEnabled = record((await sql("SELECT JSON_EXTRACT(metadata, '$.inference.enabled') AS enabled FROM organization WHERE id = ?", [orgId]))[0]).enabled;
  expect(inferenceEnabled == null || inferenceEnabled === false || inferenceEnabled === "false").toBe(true);
  expect(await keys()).toHaveLength(1);
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
  await sql("DELETE FROM inference_keys WHERE org_membership_id = ?", [memberId]);
  const connections = await Promise.all(Array.from({ length: 12 }, () => connect()));
  const key = text(connections[0]?.apiKey);
  expect(new Set(connections.map((entry) => entry.apiKey)).size).toBe(1);
  expect(await keys()).toHaveLength(1);
  expect(record((await keys())[0]).key_hash).toBe(createHash("sha256").update(key).digest("hex"));
  const scopedEnv = `${sharedId.toUpperCase()}_ANTHROPIC_API_KEY`;
  expect(record(connections[0]?.providerConfig).env).toEqual([scopedEnv]);
  expect(record(connections[0]?.apiKeys)).toEqual({ [scopedEnv]: key });
  expect((await connect(outsider)).apiKey).not.toBe(key);

  // Fixture a pre-encrypted-key synthetic provider by copying ciphertext, never exposing its secret.
  const legacyId = `lpr_${sharedId.slice(4)}`;
  await sql("INSERT INTO llm_provider (id, organization_id, created_by_org_membership_id, source, provider_id, name, provider_config, api_key) SELECT ?, organization_id, org_membership_id, 'openwork', 'openwork', 'Legacy Models', '{}', encrypted_key FROM inference_keys WHERE org_membership_id = ? AND status = 'active'", [legacyId, memberId]);
  await sql("UPDATE inference_keys SET encrypted_key = NULL WHERE org_membership_id = ? AND status = 'active'", [memberId]);
  expect(new Set((await Promise.all(Array.from({ length: 8 }, () => connect()))).map((entry) => entry.apiKey))).toEqual(new Set([key]));
  // A stale legacy value must not be returned/backfilled into an unrelated active digest.
  await sql("UPDATE inference_keys SET encrypted_key = NULL, key_hash = ? WHERE org_membership_id = ? AND status = 'active'", ["0".repeat(64), memberId]);
  const recovered = await Promise.all(Array.from({ length: 8 }, () => connect()));
  const repairedKey = text(recovered[0]?.apiKey);
  expect(repairedKey).not.toBe(key);
  expect(new Set(recovered.map((entry) => entry.apiKey)).size).toBe(1);
  expect(await keys()).toHaveLength(1);
  expect(record((await keys())[0]).key_hash).toBe(createHash("sha256").update(repairedKey).digest("hex"));
  await sql("UPDATE organization SET metadata = JSON_SET(COALESCE(metadata, JSON_OBJECT()), '$.inference', JSON_OBJECT('enabled', true, 'tier', 'tier1')) WHERE id = ?", [orgId]);
  expect((await request(member, "/v1/llm-providers")).response.status).toBe(200);
  expect((await connect()).apiKey).toBe(repairedKey);
  const tierConnect = await request(member, `/v1/llm-providers/${legacyId}/connect`);
  expect(tierConnect.response.status).toBe(200);
  expect(record(record(tierConnect.body).llmProvider).apiKey).toBe(repairedKey);

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
  expect(vertex.settings).toEqual({ project: "test-project", location: "us-central1" });
  expect(vertex.hasOauthClientSecret).toBe(true);
  expect(text(vertex.oauthCallbackUrl)).toMatch(/\/v1\/inference-providers\/oauth\/callback$/);
  expect(record(vertex.providerConfig).env).toEqual([`${vertexId.toUpperCase()}_GOOGLE_GENERATIVE_AI_API_KEY`]);
  expect((await request(outsider, `/v1/inference-providers/${vertexId}/oauth/start`)).response.status).toBe(403);
  async function start(session = member) {
    const result = await request(session, `/v1/inference-providers/${vertexId}/oauth/start`);
    expect(result.response.status).toBe(200);
    const url = new URL(text(record(result.body).authUrl));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toBe(vertex.oauthCallbackUrl);
    return text(url.searchParams.get("state"));
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
  expect(list(record(record(detail.body).inferenceProvider).credentials)).toContainEqual(expect.objectContaining({ subject: memberId, orgMembershipId: memberId, memberEmail: member.email, kind: "oauth_google", status: "active" }));
  // Claimed state, exchange paused: both disable and a revoke/regrant cycle must fence the write.
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
      expect((await request(den.admin, `/v1/inference-providers/${vertexId}`, "PATCH", { memberIds: [], allMembers: false })).response.status).toBe(200);
      expect((await request(den.admin, `/v1/inference-providers/${vertexId}`, "PATCH", { memberIds: [memberId] })).response.status).toBe(200);
    } else if (action === "client") {
      expect((await request(den.admin, `/v1/inference-providers/${vertexId}`, "PATCH", { oauthClientSecret: "fake-rotated-client-secret" })).response.status).toBe(200);
    } else {
      expect((await request(member, `/v1/inference-providers/${vertexId}/oauth`, "DELETE")).response.status).toBe(204);
    }
    google.release();
    expect((await inflight).status).toBe(400);
    expect(await sql("SELECT id FROM inference_provider_oauth_states WHERE state = ?", [state])).toHaveLength(0);
  }
  expect(await sql("SELECT id FROM inference_provider_credentials WHERE inference_provider_id = ? AND subject = ? AND status = 'active'", [vertexId, memberId])).toHaveLength(0);
  expect(google.calls.filter((call) => call === "revoke").length).toBeGreaterThanOrEqual(4);

  const teamResult = await request(den.admin, "/v1/teams", "POST", { name: "Lifecycle Team", memberIds: [memberId] });
  expect(teamResult.response.status).toBe(201);
  const teamId = text(record(record(teamResult.body).team).id);
  expect((await request(den.admin, `/v1/inference-providers/${vertexId}`, "PATCH", { memberIds: [], teamIds: [teamId] })).response.status).toBe(200);
  const teamState = await start();
  const teamInflight = callback(teamState, "wait-team");
  await eventually(() => google.calls.includes("wait-team"), { within: 10_000, intervalMs: 20 });
  expect((await request(den.admin, `/v1/teams/${teamId}`, "PATCH", { memberIds: [] })).response.status).toBe(200);
  expect((await request(den.admin, `/v1/teams/${teamId}`, "PATCH", { memberIds: [memberId] })).response.status).toBe(200);
  google.release();
  expect((await teamInflight).status).toBe(400);
  expect((await request(den.admin, `/v1/inference-providers/${vertexId}`, "PATCH", { memberIds: [memberId], teamIds: [] })).response.status).toBe(200);

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

  // Supported migration copies stored model customization, not the current catalog.
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
  const migration = await Promise.all([migrate(sourceId), migrate(sourceId)]);
  expect(migration.map((result) => result.response.status).sort()).toEqual([201, 409]);
  const moved = record(record(migration.find((result) => result.response.status === 201)?.body).inferenceProvider);
  expect(moved.migration).toEqual({ llmProviderId: sourceId, runtimeEnvNames: [`LPR_${sourceId.slice(-5).toUpperCase()}_ANTHROPIC_API_KEY`] });
  expect(list(moved.models)[0]?.name).toBe("Pinned Custom Name");
  expect(record(record(list(moved.models)[0]?.config).limit).output).toBe(1234);
  expect(await sql("SELECT id FROM llm_provider WHERE id = ?", [sourceId])).toHaveLength(0);
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
  expect(await sql("SELECT id FROM inference_provider_oauth_states WHERE org_membership_id = ?", [memberId])).toHaveLength(0);
  expect(await sql("SELECT id FROM inference_provider_credentials WHERE org_membership_id = ? AND status = 'active'", [memberId])).toHaveLength(0);
  // Global account deletion has a separate transaction from organization offboarding.
  expect((await request(den.admin, `/v1/inference-providers/${vertexId}`, "PATCH", { memberIds: [outsiderId] })).response.status).toBe(200);
  expect((await callback(await start(outsider), "before-account-delete")).status).toBe(200);
  const accountInflight = callback(await start(outsider), "wait-account-delete");
  await eventually(() => google.calls.includes("wait-account-delete"), { within: 10_000, intervalMs: 20 });
  expect((await request(den.admin, `/v1/admin/users/${outsiderUserId}`, "DELETE")).response.status).toBe(200);
  google.release();
  expect((await accountInflight).status).toBe(400);
  expect(await sql("SELECT id FROM inference_keys WHERE org_membership_id = ? AND status = 'active'", [outsiderId])).toHaveLength(0);
  expect(await sql("SELECT id FROM inference_provider_oauth_states WHERE org_membership_id = ?", [outsiderId])).toHaveLength(0);
  expect(await sql("SELECT id FROM inference_provider_credentials WHERE org_membership_id = ? AND status = 'active'", [outsiderId])).toHaveLength(0);
  expect(await sql("SELECT id FROM inference_keys WHERE org_membership_id = ? AND status = 'active'", [ownerId])).toHaveLength(1);
});
