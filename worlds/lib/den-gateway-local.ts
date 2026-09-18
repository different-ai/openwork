import { isDeepStrictEqual } from "node:util";
import type { GatewayAccessGrantWrite } from "../../packages/types/src/den/gateway.ts";
import type { GatewayUsagePolicyWrite } from "../../packages/types/src/den/gateway-usage-limits.ts";
import type { DenSession } from "../../evals/packages/behaviors/src/den.ts";
import type { GatewayProviderModelTable, GatewayProviderTable } from "../../ee/packages/den-db/src/schema/inference-providers.ts";
import type { GatewayRequestLogTable } from "../../ee/packages/den-db/src/schema/inference.ts";
import { createDenTypeId, isDenTypeId } from "../../ee/packages/utils/src/typeid.ts";
import type { DenTypeId } from "../../ee/packages/utils/src/typeid.ts";
import { denFetch } from "../../evals/packages/behaviors/src/den.ts";
import { queryDenDatabase } from "../../evals/packages/env/src/den.ts";
import type { Den } from "../../evals/packages/env/src/den.ts";

type RequestLog = typeof GatewayRequestLogTable.$inferInsert;
const DAY_MS = 86_400_000;
const FIXTURE = "den-gateway-local-v1";

function field(row: unknown, name: string): unknown {
  return typeof row === "object" && row !== null ? Reflect.get(row, name) : undefined;
}

async function insertRows(databaseUrl: string, table: "gateway_providers" | "gateway_provider_models" | "gateway_request_logs" | "gateway_credential_sets", rows: readonly Record<string, unknown>[]): Promise<void> {
  if (!rows.length) return;
  const columns = Object.keys(rows[0]);
  const values: (string | number | boolean | null)[] = [];
  const placeholders = rows.map((row) => `(${columns.map((column) => {
    const value = row[column];
    if (value instanceof Date) {
      values.push(value.getTime());
      return "FROM_UNIXTIME(? / 1000)";
    }
    values.push(value === undefined || value === null ? null
      : typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value
      : JSON.stringify(value));
    return "?";
  }).join(", ")})`);
  await queryDenDatabase(databaseUrl, `INSERT INTO \`${table}\` (${columns.map((column) => `\`${column}\``).join(", ")}) VALUES ${placeholders.join(", ")}`, values);
}

export function gatewayFixtures(organizationId: DenTypeId<"organization">, ownerId: DenTypeId<"member">) {
  const providers: (typeof GatewayProviderTable.$inferInsert)[] = ["openai", "anthropic"].map((provider) => ({
    id: createDenTypeId("inferenceProvider"),
    organization_id: organizationId,
    created_by_org_membership_id: ownerId,
    provider_id: provider,
    name: `Synthetic ${provider} (no credentials)`,
    model_ids: [],
    provider_config: { baseURL: "http://127.0.0.1:1", synthetic: true },
    settings: { synthetic: true, fixture: FIXTURE },
    credential_mode: "org",
    status: "disabled",
  }));
  const models: (typeof GatewayProviderModelTable.$inferInsert)[] = providers.flatMap((provider) => ["fast", "reasoning"].map((variant) => ({
    id: createDenTypeId("inferenceProviderModel"),
    gateway_provider_id: provider.id,
    model_id: `synthetic-${provider.provider_id}-${variant}`,
    name: `Synthetic ${provider.provider_id} ${variant}`,
    model_config: { synthetic: true },
  })));
  return { providers, models };
}

export function gatewayDayLogs(input: {
  organizationId: DenTypeId<"organization">;
  members: readonly DenTypeId<"member">[];
  fixtures: ReturnType<typeof gatewayFixtures>;
  daysAgo: number;
  now: Date;
}): RequestLog[] {
  const { organizationId, members, fixtures, daysAgo, now } = input;
  const dayStart = Math.floor(now.getTime() / DAY_MS) * DAY_MS - daysAgo * DAY_MS;
  const availableMs = Math.max(0, Math.min(DAY_MS - 1, now.getTime() - dayStart - 10_000));
  return members.flatMap((memberId, person) => Array.from({ length: 2 + (person + daysAgo) % 5 }, (_, request) => {
    const sequence = daysAgo * members.length * 7 + person * 7 + request;
    const model = fixtures.models[(person + request + daysAgo) % fixtures.models.length];
    const provider = fixtures.providers.find((entry) => entry.id === model.gateway_provider_id);
    if (!provider) throw new Error("Synthetic model is missing its provider.");
    const error = sequence % 19 === 0;
    const missing = error || sequence % 37 === 0;
    const stream = sequence % 3 !== 0;
    const inputTokens = missing ? null : 800 + (sequence * 137) % 12_000;
    const outputTokens = missing ? null : 100 + (sequence * 53) % 2_500;
    const totalTokens = inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens;
    const startedAt = new Date(dayStart + Math.floor(availableMs * ((sequence * 7919) % 997) / 997));
    const latency = 200 + sequence % 4_000;
    const log: RequestLog = {
      id: createDenTypeId("inferenceRequestLog"),
      organization_id: organizationId,
      org_membership_id: memberId,
      gateway_provider_id: provider.id,
      route: "org_provider",
      protocol: provider.provider_id === "anthropic" ? "anthropic_messages" : "openai_chat",
      upstream_provider_id: provider.provider_id,
      upstream_host: "127.0.0.1:1",
      upstream_path: provider.provider_id === "anthropic" ? "/v1/messages" : "/v1/chat/completions",
      method: "POST",
      requested_model: model.model_id,
      upstream_model: model.model_id,
      stream,
      status: error ? (sequence % 2 ? 429 : 503) : 200,
      outcome: error ? "upstream_error" : "ok",
      error_code: error ? "synthetic_upstream_error" : null,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      cache_read_tokens: missing ? null : sequence % 400,
      cache_write_tokens: missing ? null : sequence % 200,
      reasoning_tokens: missing ? null : sequence % 100,
      usage_source: missing ? "missing" : stream ? "stream" : "json",
      cost_micro_usd: inputTokens === null || outputTokens === null || sequence % 41 === 0 ? null : inputTokens * 3 + outputTokens * 15,
      openwork_request_id: createDenTypeId("request"),
      started_at: startedAt,
      first_byte_at: new Date(Math.min(now.getTime(), startedAt.getTime() + 100)),
      completed_at: new Date(Math.min(now.getTime(), startedAt.getTime() + latency)),
      request_bytes: 512 + sequence % 8_000,
      response_bytes: error ? 128 : 1_024 + sequence % 16_000,
      metadata: { synthetic: true, fixture: FIXTURE },
    };
    return log;
  }));
}

function demoList(value: unknown, key: string): unknown[] {
  const rows = field(value, key);
  if (!Array.isArray(rows)) throw new Error(`Synthetic access response is missing ${key}.`);
  return rows;
}

function demoId(value: unknown): string {
  const id = field(value, "id");
  if (typeof id !== "string" || !id) throw new Error("Synthetic access response is missing an ID.");
  return id;
}

function demoJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

export async function seedGatewayAccessDemo(admin: DenSession, databaseUrl: string) {
  const database = new URL(databaseUrl);
  const loopback = (url: URL) => ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (database.protocol !== "mysql:" || !loopback(database) || database.search || database.hash
    || !/^\/openwork_eval_[a-z0-9_]+$/.test(database.pathname)
    || !admin.email.endsWith("@acme.test")) {
    throw new Error("Access fixtures require an isolated loopback openwork_eval_ database and synthetic owner.");
  }
  for (const address of [admin.apiUrl, admin.webUrl]) {
    const url = new URL(address);
    if (!loopback(url) || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Access fixtures require loopback Den API and web origins.");
    }
  }
  const owners = await queryDenDatabase(databaseUrl, `SELECT o.id, o.metadata, m.id AS member_id
    FROM organization o JOIN member m ON m.organization_id = o.id JOIN user u ON u.id = m.user_id
    WHERE o.slug = ? AND u.email = ? AND m.role = ? AND m.removed_at IS NULL`, ["acme-robotics-demo", admin.email, "owner"]);
  const organizationId = field(owners[0], "id");
  const ownerId = field(owners[0], "member_id");
  const marker = field(demoJson(field(owners[0], "metadata")), "gatewayDemo");
  if (owners.length !== 1 || !isDenTypeId("organization", organizationId) || !isDenTypeId("member", ownerId)
    || field(marker, "synthetic") !== true || field(marker, "fixture") !== FIXTURE) {
    throw new Error("Expected the marked synthetic acme-robotics-demo organization and its owner.");
  }
  const teams = await queryDenDatabase(databaseUrl, `SELECT DISTINCT t.id FROM team t
    JOIN team_member tm ON tm.team_id = t.id JOIN member m ON m.id = tm.org_membership_id
    JOIN user u ON u.id = m.user_id WHERE t.organization_id = ? AND t.name = ?
    AND m.organization_id = ? AND m.removed_at IS NULL AND u.email LIKE ?`, [organizationId, "Engineering", organizationId, "%@acme.test"]);
  const teamId = field(teams[0], "id");
  if (teams.length !== 1 || !isDenTypeId("team", teamId)) throw new Error("Expected one populated synthetic Engineering team.");
  const people = await queryDenDatabase(databaseUrl, `SELECT m.id FROM member m JOIN user u ON u.id = m.user_id
    JOIN team_member tm ON tm.org_membership_id = m.id WHERE m.organization_id = ? AND m.removed_at IS NULL
    AND tm.team_id = ? AND m.id <> ? AND u.email LIKE ? ORDER BY u.email`, [organizationId, teamId, ownerId, "%@acme.test"]);
  const personId = field(people[0], "id");
  if (!isDenTypeId("member", personId)) throw new Error("Expected another synthetic Engineering member.");
  const subjects: GatewayAccessGrantWrite["audience"][] = [
    { type: "organization" }, { type: "team", teamId }, { type: "member", memberId: ownerId }, { type: "member", memberId: personId },
  ];
  const rows = await queryDenDatabase(databaseUrl, `SELECT id, provider_id, status, settings, provider_config, model_ids,
    oauth_client_id, oauth_client_secret IS NOT NULL AS has_oauth_secret FROM gateway_providers
    WHERE organization_id = ? AND JSON_UNQUOTE(JSON_EXTRACT(settings, '$.fixture')) = ? ORDER BY provider_id`, [organizationId, FIXTURE]);
  if (rows.length !== 2 || new Set(rows.map((row) => field(row, "provider_id"))).size !== 2) {
    throw new Error("Expected exactly two distinct synthetic providers; refusing duplicate fixtures.");
  }
  const providers = [];
  for (const row of rows) {
    const id = field(row, "id");
    const providerId = field(row, "provider_id");
    if (!isDenTypeId("inferenceProvider", id) || (providerId !== "openai" && providerId !== "anthropic")
      || field(row, "status") !== "disabled" || field(demoJson(field(row, "settings")), "synthetic") !== true
      || !isDeepStrictEqual(demoJson(field(row, "provider_config")), { baseURL: "http://127.0.0.1:1", synthetic: true })
      || !isDeepStrictEqual(demoJson(field(row, "model_ids")), []) || field(row, "oauth_client_id") !== null || field(row, "has_oauth_secret") !== 0) {
      throw new Error("Incompatible synthetic provider; refusing to modify or enable it.");
    }
    const models = await queryDenDatabase(databaseUrl, `SELECT model_id, model_config FROM gateway_provider_models WHERE gateway_provider_id = ?`, [id]);
    const expectedModels = ["fast", "reasoning"].map((variant) => `synthetic-${providerId}-${variant}`);
    if (models.length !== 2 || !isDeepStrictEqual(models.map((model) => field(model, "model_id")).sort(), expectedModels)
      || models.some((model) => !isDeepStrictEqual(demoJson(field(model, "model_config")), { synthetic: true }))) {
      throw new Error("Incompatible synthetic models; refusing catalog replacement.");
    }
    const credentials = await queryDenDatabase(databaseUrl, `SELECT id FROM gateway_provider_credentials WHERE gateway_provider_id = ?
      UNION ALL SELECT id FROM gateway_provider_oauth_states WHERE gateway_provider_id = ?`, [id, id]);
    if (credentials.length) throw new Error("Synthetic providers must not contain credentials or pending sign-ins.");
    providers.push({ id, providerId, expectedModels });
  }
  const request = async (path: string, body?: unknown) => {
    const result = await denFetch(admin, path, { headers: { authorization: `Bearer ${admin.token}` },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
    if (!result.response.ok) throw new Error(`Synthetic access API failed: ${path}, HTTP ${result.response.status}. No automatic retry.`);
    return result.body;
  };
  const session = await request("/v1/me");
  const createdAt = field(field(session, "session"), "createdAt");
  const age = typeof createdAt === "string" ? Date.now() - Date.parse(createdAt) : Number.NaN;
  if (field(field(session, "user"), "email") !== admin.email || !Number.isFinite(age) || age < 0 || age > 15 * 60_000) {
    throw new Error("Sign in normally as the synthetic owner before seeding access fixtures.");
  }
  await request("/v1/me/active-organization", { organizationId });
  const description = `Synthetic access demo fixture: ${FIXTURE}. No live inference.`;
  const setName = `Demo unconfigured credentials (${FIXTURE})`;
  const groupNames = ["fast", "reasoning"].map((variant) => `Demo ${variant} models (${FIXTURE})`);
  const matrix = await Promise.all(providers.map(async (provider) => ({ ...provider,
    details: field(await request(`/v1/inference-providers/${provider.id}`), "inferenceProvider"),
  })));
  const checkMatrix = (provider: typeof matrix[number], complete = false) => {
    if (field(provider.details, "status") !== "disabled" || demoId(provider.details) !== provider.id
      || demoList(provider.details, "credentials").length || demoList(provider.details, "models").length) {
      throw new Error("Synthetic API provider must remain disabled, credential-free and unusable.");
    }
    const groups = demoList(provider.details, "modelGroups");
    const sets = demoList(provider.details, "credentialSets");
    const grants = demoList(provider.details, "accessGrants");
    if (groups.length > 2 || new Set(groups.map((group) => field(group, "name"))).size !== groups.length
      || groups.some((group) => {
        const index = groupNames.indexOf(String(field(group, "name")));
        return index < 0 || field(group, "description") !== description || field(group, "status") !== "active"
          || !isDeepStrictEqual(field(group, "modelIds"), [provider.expectedModels[index]]);
      }) || sets.length > 1 || sets.some((set) => field(set, "name") !== setName || field(set, "configured") !== false
        || field(set, "credentialMode") !== "org" || field(set, "status") !== "active"
        || field(set, "oauthClientId") !== null || field(set, "hasOauthClientSecret") !== false
        || field(field(set, "createdBy"), "id") !== ownerId)) {
      throw new Error("Incompatible existing synthetic model groups or credential sets.");
    }
    const expected = groups.flatMap((group) => subjects.filter((subject) => field(group, "name") === groupNames[0]
      ? subject.type !== "member" || subject.memberId === ownerId : subject.type !== "organization").map((audience) => ({
        modelGroupId: demoId(group), credentialSetId: sets[0] ? demoId(sets[0]) : "", audience,
      })));
    const projection = (grant: unknown) => ({ modelGroupId: field(grant, "modelGroupId"), credentialSetId: field(grant, "credentialSetId"), audience: field(grant, "audience") });
    if (grants.some((grant) => !expected.some((value) => isDeepStrictEqual(value, projection(grant))))
      || expected.some((value) => grants.filter((grant) => isDeepStrictEqual(value, projection(grant))).length > 1)
      || complete && (groups.length !== 2 || sets.length !== 1 || grants.length !== 6)) {
      throw new Error("Incompatible or incomplete synthetic access grants.");
    }
    return { groups, sets, grants, expected, projection };
  };
  for (const provider of matrix) checkMatrix(provider);
  const policyPath = "/v1/gateway/usage-limit-policies";
  const policySpecs: { input: GatewayUsagePolicyWrite; targets: { organization: boolean; memberId: string | null; teamId: string | null }[] }[] = [
    { input: { name: `Demo Everyone (${FIXTURE})`, hardLimit: true, allowRequestReset: true,
      limits: [{ timeframe: "day", costUsd: "10" }, { timeframe: "week", costUsd: "50" }, { timeframe: "month", costUsd: "150" }] },
      targets: [{ organization: true, memberId: null, teamId: null }] },
    { input: { name: `Demo Engineering (${FIXTURE})`, hardLimit: true, allowRequestReset: true,
      limits: [{ timeframe: "day", costUsd: "25" }, { timeframe: "week", costUsd: "125" }, { timeframe: "month", costUsd: "400" }] },
      targets: [{ organization: false, memberId: null, teamId }] },
    { input: { name: `Demo People (${FIXTURE})`, hardLimit: true, allowRequestReset: true,
      limits: [{ timeframe: "day", costUsd: "50" }, { timeframe: "week", costUsd: "250" }, { timeframe: "month", costUsd: "800" }] },
      targets: [ownerId, personId].map((memberId) => ({ organization: false, memberId, teamId: null })) },
  ];
  const assignmentTarget = (assignment: unknown) => ({ organization: field(assignment, "organization"), memberId: field(assignment, "memberId"), teamId: field(assignment, "teamId") });
  const checkPolicies = (policies: unknown[], complete = false) => {
    const own = policies.filter((policy) => String(field(policy, "name")).includes(FIXTURE));
    if (own.some((policy) => !policySpecs.some((spec) => spec.input.name === field(policy, "name")))) {
      throw new Error("Unrecognized synthetic limit policy.");
    }
    for (const spec of policySpecs) {
      const matches = own.filter((policy) => field(policy, "name") === spec.input.name);
      if (matches.length > 1 || complete && matches.length !== 1) throw new Error("Duplicate or missing synthetic limit policy.");
      if (!matches.length) continue;
      const policy = matches[0];
      const limits = demoList(policy, "limits");
      const assignments = demoList(policy, "assignments");
      if (field(policy, "archivedAt") != null || field(policy, "hardLimit") !== true || field(policy, "allowRequestReset") !== true
        || limits.length !== 3 || spec.input.limits.some((limit) => limits.filter((row) => field(row, "timeframe") === limit.timeframe
          && field(row, "costLimitMicroUsd") === Number(limit.costUsd) * 1_000_000).length !== 1)
        || assignments.some((row) => !spec.targets.some((target) => isDeepStrictEqual(target, assignmentTarget(row))))
        || spec.targets.some((target) => assignments.filter((row) => isDeepStrictEqual(target, assignmentTarget(row))).length > 1)
        || complete && assignments.length !== spec.targets.length) {
        throw new Error("Incompatible synthetic policy limits or assignments; refusing to overwrite.");
      }
    }
    return own;
  };
  const policies = demoList(await request(policyPath), "policies");
  checkPolicies(policies);
  for (const provider of matrix) {
    const base = `/v1/inference-providers/${provider.id}`;
    const existing = checkMatrix(provider);
    for (const [index, name] of groupNames.entries()) {
      if (!existing.groups.some((group) => field(group, "name") === name)) {
        await request(`${base}/model-groups`, { name, description, modelIds: [provider.expectedModels[index]], status: "active" });
      }
    }
    if (!existing.sets.length) {
      await insertRows(databaseUrl, "gateway_credential_sets", [{ id: createDenTypeId("gatewayCredentialSet"), gateway_provider_id: provider.id,
        created_by_org_membership_id: ownerId, name: setName, credential_mode: "org", status: "active" }]);
    }
    provider.details = field(await request(base), "inferenceProvider");
    const ready = checkMatrix(provider);
    for (const grant of ready.expected) {
      if (!ready.grants.some((row) => isDeepStrictEqual(grant, ready.projection(row)))) await request(`${base}/access-grants`, grant);
    }
  }
  for (const spec of policySpecs) {
    const policy = policies.find((row) => field(row, "name") === spec.input.name) ?? await request(policyPath, spec.input);
    for (const target of spec.targets) {
      if (!demoList(policy, "assignments").some((row) => isDeepStrictEqual(target, assignmentTarget(row)))) {
        await request(`${policyPath}/${demoId(policy)}/assignments`, target.organization ? { organization: true }
          : target.teamId ? { teamId: target.teamId } : { memberId: target.memberId });
      }
    }
  }
  const verifiedProviders = await Promise.all(matrix.map(async (provider) => {
    provider.details = field(await request(`/v1/inference-providers/${provider.id}`), "inferenceProvider");
    const verified = checkMatrix(provider, true);
    return { provider: provider.providerId, disabled: true, modelGroups: verified.groups.length,
      unconfiguredCredentialSets: verified.sets.length, grants: verified.grants.length, credentials: 0, usableModels: 0 };
  }));
  const verifiedPolicies = checkPolicies(demoList(await request(policyPath), "policies"), true);
  return { synthetic: true, fixture: FIXTURE, providers: verifiedProviders, policies: verifiedPolicies.length,
    assignments: { everyone: 1, teams: 1, people: 2 }, grantSubjects: { everyone: 1, teams: 1, people: 2 },
    policyAmountsUsd: policySpecs.map((spec) => ({ name: spec.input.name, limits: spec.input.limits })) };
}

export async function seedGatewayUsage(den: Den) {
  if (den.placement?.kind !== "local" || !den.database || !/^openwork_eval_[a-z0-9_]+$/.test(den.database.name)) {
    throw new Error("Gateway fixtures require the world-owned ephemeral local Den database.");
  }
  const databaseUrl = den.database.url;
  const owners = await queryDenDatabase(databaseUrl, `SELECT o.id AS organization_id, m.id AS member_id
    FROM organization o JOIN member m ON m.organization_id = o.id JOIN user u ON u.id = m.user_id
    WHERE o.slug = ? AND u.email = ? AND m.role = ? AND m.removed_at IS NULL`, ["acme-robotics-demo", den.admin.email, "owner"]);
  const organizationId = field(owners[0], "organization_id");
  const ownerId = field(owners[0], "member_id");
  if (owners.length !== 1 || !isDenTypeId("organization", organizationId) || !isDenTypeId("member", ownerId)) {
    throw new Error("Expected exactly one isolated demo organization and owner.");
  }
  const rows = await queryDenDatabase(databaseUrl, `SELECT m.id FROM member m JOIN user u ON u.id = m.user_id
    WHERE m.organization_id = ? AND m.removed_at IS NULL AND u.email LIKE ? ORDER BY u.email`, [organizationId, "%@acme.test"]);
  const members = rows.map((row) => {
    const id = field(row, "id");
    if (!isDenTypeId("member", id)) throw new Error("Invalid synthetic member ID.");
    return id;
  });
  const teams = await queryDenDatabase(databaseUrl, `SELECT DISTINCT t.id FROM team t
    JOIN team_member tm ON tm.team_id = t.id JOIN member m ON m.id = tm.org_membership_id
    WHERE t.organization_id = ? AND m.organization_id = ? AND m.removed_at IS NULL`, [organizationId, organizationId]);
  if (members.length < 3 || teams.length < 2) throw new Error("Demo seed must supply multiple people and populated teams.");
  const existing = await queryDenDatabase(databaseUrl, `SELECT id FROM gateway_request_logs WHERE organization_id = ? LIMIT 1`, [organizationId]);
  const rollups = await queryDenDatabase(databaseUrl, `SELECT id FROM gateway_usage_rollups WHERE organization_id = ? LIMIT 1`, [organizationId]);
  if (existing.length || rollups.length) throw new Error("Refusing to overlap existing gateway logs or rollups; start a fresh world stage.");
  await queryDenDatabase(databaseUrl, `UPDATE organization SET metadata = JSON_MERGE_PATCH(COALESCE(metadata, JSON_OBJECT()), CAST(? AS JSON)) WHERE id = ?`, [JSON.stringify({ capabilities: { gatewayDashboard: true }, gatewayDemo: { synthetic: true, fixture: FIXTURE } }), organizationId]);
  const fixtures = gatewayFixtures(organizationId, ownerId);
  await insertRows(databaseUrl, "gateway_providers", fixtures.providers);
  await insertRows(databaseUrl, "gateway_provider_models", fixtures.models);
  const now = new Date();
  let requests = 0;
  let totalTokens = 0;
  let totalCostMicroUsd = 0;
  for (let daysAgo = 30; daysAgo >= 0; daysAgo--) {
    const logs = gatewayDayLogs({ organizationId, members, fixtures, daysAgo, now });
    await insertRows(databaseUrl, "gateway_request_logs", logs);
    requests += logs.length;
    totalTokens += logs.reduce((sum, row) => sum + (row.total_tokens ?? 0), 0);
    totalCostMicroUsd += logs.reduce((sum, row) => sum + (row.cost_micro_usd ?? 0), 0);
  }
  const headers = { authorization: `Bearer ${den.admin.token}` };
  const selected = await denFetch(den.admin, "/v1/me/active-organization", { method: "POST", headers, body: JSON.stringify({ organizationId }) });
  if (!selected.response.ok) throw new Error(`Synthetic organization selection failed: HTTP ${selected.response.status}`);
  for (const groupBy of ["model", "person", "team"]) {
    const result = await denFetch(den.admin, `/v1/inference-providers/usage?groupBy=${groupBy}&days=31`, { headers });
    const usage = field(result.body, "usage");
    const series = field(usage, "series");
    const daily = field(usage, "daily");
    if (!result.response.ok || !Array.isArray(series) || series.length < 2 || !Array.isArray(daily) || daily.length !== 31) {
      throw new Error(`Synthetic ${groupBy} usage verification failed: HTTP ${result.response.status}`);
    }
    if (groupBy !== "team" && (field(usage, "requestCount") !== requests || field(usage, "totalTokens") !== totalTokens || field(usage, "totalCostMicroUsd") !== totalCostMicroUsd)) {
      throw new Error(`Synthetic ${groupBy} usage totals differ from seeded requests; check date boundaries and aggregation.`);
    }
  }
  const limits = await denFetch(den.admin, "/v1/gateway/usage-limit-policies", { headers });
  if (!limits.response.ok || !Array.isArray(field(limits.body, "policies"))) {
    throw new Error(`Gateway limits readiness failed: HTTP ${limits.response.status}`);
  }
  for (const view of ["pending", "history"]) {
    const resets = await denFetch(den.admin, `/v1/gateway/usage-limit-reset-requests?view=${view}&limit=1`, { headers });
    if (!resets.response.ok || !Array.isArray(field(resets.body, "requests"))) {
      throw new Error(`Gateway ${view} reset requests readiness failed: HTTP ${resets.response.status}`);
    }
  }
  const access = await seedGatewayAccessDemo(den.admin, databaseUrl);
  return { database: den.database.name, requests, people: members.length, teams: teams.length, access };
}
