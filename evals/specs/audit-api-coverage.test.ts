import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, expect } from "vitest";
import { denFetch, signIn } from "@openwork/behaviors";
import type { DenFetchResult, DenSession } from "@openwork/behaviors";
import { localMysqlIsRunning, localRedisIsRunning, queryDenDatabase, server, test } from "@openwork/testkit";
import type { Den, Place } from "@openwork/testkit";

// Behaviour proof for den-api's generic request audit capture. Everything is
// observed across the public HTTP boundary plus the disposable scratch
// database that server() owns (openwork_eval_*). All identities are synthetic
// example.test accounts; every secret below is a throwaway fixture value.

const attached = Boolean(process.env.OPENWORK_EVAL_DEN_API_URL?.trim());
const daytona = process.env.OPENWORK_EVAL_DAYTONA?.trim() === "1";
const mysqlOpen = !attached && !daytona && await localMysqlIsRunning();
const redisOpen = !attached && !daytona && await localRedisIsRunning();
const skipReason = attached
  ? "needs a fresh local Den with a scratch database (unset OPENWORK_EVAL_DEN_API_URL)"
  : daytona
    ? "needs local placement: the spec inspects the scratch MySQL database directly"
    : !mysqlOpen
      ? "needs MySQL on 127.0.0.1:3306 (pnpm dev:den:mysql)"
      : !redisOpen ? "needs Redis on 127.0.0.1:6379 (pnpm dev:den:mysql)" : "";
const skip = skipReason !== "";
const name = (claim: string) => skip ? `${claim} (skipped — ${skipReason})` : claim;
const LONG = { timeout: 420_000 };
const STEP = { timeout: 120_000 };

type Row = Record<string, unknown>;
type Envelope = {
  id: string;
  operationId: string;
  action: string;
  category: string;
  outcome: string;
  reasonCode: string | null;
  requestId: string | null;
  actor: Row;
  operation: Row;
  resources: Row[];
  http: Row | null;
};

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown, label: string): Row {
  if (!isRecord(value)) throw new Error(`${label} was not an object: ${JSON.stringify(value)?.slice(0, 500)}`);
  return value;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} was not a non-empty string: ${JSON.stringify(value)}`);
  return value;
}
function optionalText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function json(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}
function count(rows: Row[]): number {
  return Number(rows[0]?.n ?? 0);
}
function envelopeOf(value: unknown): Envelope {
  const raw = record(json(value), "audit envelope");
  return {
    id: text(raw.id, "envelope.id"),
    operationId: text(raw.operationId, "envelope.operationId"),
    action: text(raw.action, "envelope.action"),
    category: text(raw.category, "envelope.category"),
    outcome: text(raw.outcome, "envelope.outcome"),
    reasonCode: optionalText(raw.reasonCode),
    requestId: optionalText(raw.requestId),
    actor: record(raw.actor, "envelope.actor"),
    operation: record(raw.operation, "envelope.operation"),
    resources: Array.isArray(raw.resources) ? raw.resources.filter(isRecord) : [],
    http: isRecord(raw.http) ? raw.http : null,
  };
}
function summary(events: Envelope[]): string {
  return events.map((event, index) => `${index + 1}:${event.action}/${event.outcome}${event.reasonCode ? `(${event.reasonCode})` : ""}`).join(", ") || "(none)";
}
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type World = {
  den: Den;
  dbUrl: string;
  orgId: string;
  admin: DenSession;
  reader: DenSession;
  adminUserId: string;
  adminMemberId: string;
  readerMemberId: string;
  stamp: string;
};

function guardedDatabaseUrl(den: Den): string {
  const url = den.database?.url;
  if (den.placement?.kind !== "local" || !url) throw new Error("This spec requires a testkit-owned local scratch database");
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || !parsed.pathname.startsWith("/openwork_eval_")) {
    throw new Error("Refusing audit SQL outside a disposable loopback openwork_eval_* database");
  }
  return url;
}

function orgHeaders(session: DenSession, orgId: string): Record<string, string> {
  return { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId };
}

async function call(den: Den, path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<DenFetchResult> {
  return denFetch(den.ref, path, {
    method: init.method ?? "GET",
    headers: init.headers ?? {},
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(60_000),
  });
}

async function sql(world: { dbUrl: string }, statement: string, values: (string | number | null)[] = []): Promise<Row[]> {
  const rows = await queryDenDatabase(world.dbUrl, statement, values);
  return rows.filter(isRecord);
}

type HeldConnection = {
  query(statement: string, values?: (string | number | null)[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
};

/** One dedicated scratch-database connection whose transaction and locks persist across statements. */
async function heldConnection(databaseUrl: string): Promise<HeldConnection> {
  const require = createRequire(import.meta.url);
  const mysql: { createConnection(url: string): Promise<HeldConnection> } = createRequire(require.resolve("@openwork/env"))("mysql2/promise");
  return mysql.createConnection(databaseUrl);
}

async function tenantEvents(world: { dbUrl: string }, orgId: string, afterId = ""): Promise<Envelope[]> {
  const rows = await sql(world, "SELECT envelope FROM audit_event WHERE org_id = ? AND envelope IS NOT NULL AND id > ? ORDER BY id", [orgId, afterId]);
  return rows.map((row) => envelopeOf(row.envelope));
}

async function watermark(world: { dbUrl: string }, orgId: string): Promise<string> {
  // Newest event id: ids are time-ordered, so "after this id" means "recorded later".
  const rows = await sql(world, "SELECT COALESCE(MAX(id), '') AS n FROM audit_event WHERE org_id = ? AND envelope IS NOT NULL", [orgId]);
  return String(rows[0]?.n ?? "");
}

async function totalTenantRows(world: { dbUrl: string }, orgId: string): Promise<number> {
  return count(await sql(world, "SELECT COUNT(*) AS n FROM audit_event WHERE org_id = ? AND envelope IS NOT NULL", [orgId]));
}

async function platformRows(world: { dbUrl: string }, route: string): Promise<Row[]> {
  return sql(world, "SELECT id, method, route, action, outcome, status, reason_code, actor_type, actor_id, credential_id, origin, target_type, target_id FROM platform_audit_event WHERE route = ? ORDER BY occurred_at, id", [route]);
}

async function pollPlatform(world: { dbUrl: string }, route: string, known: Set<string>, predicate: (row: Row) => boolean): Promise<Row> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const fresh = (await platformRows(world, route)).filter((row) => !known.has(String(row.id)) && predicate(row));
    if (fresh[0]) return fresh[0];
    await sleep(200);
  }
  throw new Error(`No new platform_audit_event row for ${route} within 10 s`);
}

async function allAuditText(world: { dbUrl: string }): Promise<string> {
  const events = await sql(world, "SELECT id, org_id, action, payload, envelope, operation_id FROM audit_event");
  const resources = await sql(world, "SELECT * FROM audit_event_resource");
  const operations = await sql(world, "SELECT id, organization_id, kind, scope, principal_key, initiating_actor, origin FROM audit_operation");
  const platform = await sql(world, "SELECT * FROM platform_audit_event");
  return JSON.stringify({ events, resources, operations, platform }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
}

async function organizationIdNamed(session: DenSession, organizationName: string): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", { headers: { authorization: `Bearer ${session.token}` } });
  const orgs = isRecord(result.body) && Array.isArray(result.body.orgs) ? result.body.orgs.filter(isRecord) : [];
  const match = orgs.find((entry) => entry.name === organizationName);
  return text(match?.id, `organization ${organizationName} (HTTP ${result.response.status})`);
}

async function memberIdentity(den: Den, admin: DenSession, orgId: string, email: string): Promise<{ memberId: string; userId: string }> {
  const result = await call(den, "/v1/org", { headers: orgHeaders(admin, orgId) });
  expect(result.response.status, result.text).toBe(200);
  const members = isRecord(result.body) && Array.isArray(result.body.members) ? result.body.members.filter(isRecord) : [];
  const member = members.find((entry) => isRecord(entry.user) && entry.user.email === email);
  if (!member) throw new Error(`Member ${email} not found in ${result.text.slice(0, 400)}`);
  const user = record(member.user, "member.user");
  return { memberId: text(member.id, "member.id"), userId: text(member.userId ?? user.id, "member.userId") };
}

async function setAuditFlag(den: Den, admin: DenSession, orgId: string, value: boolean) {
  const before = await call(den, `/v1/admin/organizations/${orgId}/capabilities`, { headers: { authorization: `Bearer ${admin.token}` } });
  expect(before.response.status, before.text).toBe(200);
  const result = await call(den, `/v1/admin/organizations/${orgId}/capabilities`, { method: "PUT", headers: { authorization: `Bearer ${admin.token}` }, body: { capabilities: { auditLogs: value } } });
  expect(result.response.status, result.text).toBe(200);
  const previous = record(record(before.body, "capabilities").capabilities, "capabilities");
  const next = record(record(result.body, "capabilities").capabilities, "capabilities");
  expect(next.auditLogs).toBe(value);
  for (const [key, current] of Object.entries(previous)) {
    if (key !== "auditLogs") expect(next[key], `capability ${key} preserved`).toEqual(current);
  }
}

async function createTeam(den: Den, headers: Record<string, string>, teamName: string): Promise<string> {
  const result = await call(den, "/v1/teams", { method: "POST", headers, body: { name: teamName } });
  expect(result.response.status, result.text).toBe(201);
  return text(record(record(result.body, "team response").team, "team").id, "team.id");
}

async function teamNames(den: Den, headers: Record<string, string>): Promise<string[]> {
  const result = await call(den, "/v1/org", { headers });
  expect(result.response.status, result.text).toBe(200);
  const teams = isRecord(result.body) && Array.isArray(result.body.teams) ? result.body.teams.filter(isRecord) : [];
  return teams.map((team) => String(team.name));
}

async function auditPolicy(den: Den, admin: DenSession, orgId: string): Promise<{ captureOn: boolean; revision: number }> {
  const usage = await call(den, "/v1/audit/usage", { headers: orgHeaders(admin, orgId) });
  expect(usage.response.status, usage.text).toBe(200);
  const body = record(usage.body, "audit usage");
  const policy = record(body.policy, "audit usage policy");
  return { captureOn: body.captureOn === true, revision: Number(policy.revision) };
}

// No API changes categories (only captureOn). Operator change: add or remove
// "read" and bump the revision, exactly what a policy write would persist.
/** audit_operation.outcome as the audit API lists it (newest 100 operations). */
async function listedOperationOutcome(den: Den, headers: Record<string, string>, operationId: string): Promise<string | null> {
  const listed = await call(den, "/v1/audit/operations?limit=100", { headers });
  if (listed.response.status !== 200) throw new Error(`GET /v1/audit/operations returned ${listed.response.status}: ${listed.text.slice(0, 300)}`);
  const operations = record(listed.body, "operations").operations;
  const match = (Array.isArray(operations) ? operations.filter(isRecord) : []).find((operation) => operation.id === operationId);
  return match ? optionalText(match.outcome) : null;
}

async function setReadCategory(world: { dbUrl: string }, orgId: string, on: boolean) {
  if (on) await sql(world, "UPDATE audit_policy SET categories = JSON_ARRAY_APPEND(categories, '$', 'read'), revision = revision + 1 WHERE organization_id = ? AND NOT JSON_CONTAINS(categories, '\"read\"')", [orgId]);
  else await sql(world, "UPDATE audit_policy SET categories = JSON_REMOVE(categories, JSON_UNQUOTE(JSON_SEARCH(categories, 'one', 'read'))), revision = revision + 1 WHERE organization_id = ? AND JSON_CONTAINS(categories, '\"read\"')", [orgId]);
}

let booted: Promise<World> | null = null;
const owned = new AsyncDisposableStack();
afterAll(async () => {
  await owned.disposeAsync();
});

// Synthetic token for the scratch deployment's maintenance endpoint (not a secret).
const MAINTENANCE_TOKEN = "eval-maintenance-token-0123456789abcdef";

function world(place: Place): Promise<World> {
  booted ??= (async () => {
    const stamp = `${Date.now().toString(36)}${process.pid.toString(36)}`;
    const organizationName = `Audit API coverage ${stamp}`;
    const den = owned.use(await server({
      place,
      web: false,
      org: {
        name: organizationName,
        admin: { name: "Audit Admin", email: `audit-admin+${stamp}@example.test` },
        members: { reader: { name: "Audit Reader", email: `audit-reader+${stamp}@example.test` } },
      },
      env: {
        DEN_AUDIT_SELF_HOSTED_ENABLED: "true",
        // Remove inherited overrides: prove the deployment defaults.
        DEN_AUDIT_CAPTURE_ENABLED: undefined,
        DEN_AUDIT_VISIBILITY_ENABLED: undefined,
        DEN_FEATURE_PLATFORM_AUDIT_READS: undefined,
        DEN_PLAN_GATING_ENABLED: "false",
        DEN_MAINTENANCE_TOKEN: MAINTENANCE_TOKEN,
        RESEND_API_KEY: "",
        STRIPE_SECRET_KEY: "",
      },
    }));
    const dbUrl = guardedDatabaseUrl(den);
    const admin = den.admin;
    const reader = den.members.reader;
    if (!reader) throw new Error("Expected the synthetic reader session");
    const orgId = await organizationIdNamed(admin, organizationName);
    await setAuditFlag(den, admin, orgId, true);
    const adminIdentity = await memberIdentity(den, admin, orgId, admin.email);
    const readerIdentity = await memberIdentity(den, admin, orgId, reader.email);
    return { den, dbUrl, orgId, admin, reader, adminUserId: adminIdentity.userId, adminMemberId: adminIdentity.memberId, readerMemberId: readerIdentity.memberId, stamp };
  })();
  return booted;
}

// Shared across cases 1/2/4/5/6.
const state: { apiKey: string; apiKeyId: string; teamId: string; deletedTeamId: string; liveTeamId: string; liveTeamName: string; providerId: string; providerSecret: string; outsider: DenSession | null; orgB: string } = {
  apiKey: "", apiKeyId: "", teamId: "", deletedTeamId: "", liveTeamId: "", liveTeamName: "", providerId: "", providerSecret: "", outsider: null, orgB: "",
};

test.skipIf(skip)(name("1. an admin's successful team changes each record one operation with intent then outcome, and an API key is named but never stored"), LONG, async ({ evidence, place }) => {
  const w = await world(place);
  const headers = orgHeaders(w.admin, w.orgId);

  let mark = await watermark(w, w.orgId);
  const teamId = await createTeam(w.den, headers, `Audit created ${w.stamp}`);
  state.teamId = teamId;
  const created = (await tenantEvents(w, w.orgId, mark)).filter((event) => event.action.startsWith("team.create."));
  expect(created.map((event) => event.action), summary(created)).toEqual(["team.create.requested", "team.create.succeeded"]);
  const [requested, succeeded] = created;
  if (!requested || !succeeded) throw new Error("missing create events");
  expect(requested.outcome).toBe("unknown");
  expect(succeeded.outcome).toBe("succeeded");
  expect(succeeded.operationId).toBe(requested.operationId);
  expect(requested.requestId).toMatch(/^req_/);
  expect(succeeded.requestId).toBe(requested.requestId);
  expect(requested.operation).toMatchObject({ kind: "team.management", origin: "api" });
  expect(succeeded.http).toEqual({ method: "POST", route: "/v1/teams", status: 201 });
  expect(requested.http).toEqual({ method: "POST", route: "/v1/teams" });
  expect(succeeded.actor).toEqual({ type: "user", id: w.adminUserId, memberId: w.adminMemberId });
  expect(succeeded.resources).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "team", id: "collection:team", relationship: "target" }),
    expect.objectContaining({ type: "organization", id: w.orgId, relationship: "parent" }),
  ]));
  expect(succeeded.resources).toHaveLength(2);
  const resourceRows = await sql(w, "SELECT resource_type, resource_id, relationship FROM audit_event_resource WHERE event_id = ? ORDER BY resource_type", [succeeded.id]);
  expect(resourceRows).toEqual([
    { resource_type: "organization", resource_id: w.orgId, relationship: "parent" },
    { resource_type: "team", resource_id: "collection:team", relationship: "target" },
  ]);
  const operationRows = await sql(w, "SELECT kind, origin, event_count FROM audit_operation WHERE id = ?", [succeeded.operationId]);
  expect(operationRows).toEqual([{ kind: "team.management", origin: "api", event_count: 2 }]);
  const apiEvents = await call(w.den, `/v1/audit/operations/${succeeded.operationId}/events`, { headers });
  expect(apiEvents.response.status, apiEvents.text).toBe(200);
  const apiActions = (Array.isArray(record(apiEvents.body, "events").events) ? record(apiEvents.body, "events").events : []);
  expect(Array.isArray(apiActions) ? apiActions.filter(isRecord).map((event) => event.action) : []).toEqual(["team.create.requested", "team.create.succeeded"]);
  const createdOutcome = await listedOperationOutcome(w.den, headers, succeeded.operationId);
  expect(createdOutcome, "operation outcome projection after a successful create").toBe("succeeded");
  evidence.recordAssertionEvidence(
    "The operations list shows the create operation's outcome as succeeded (projected from the outcome event, not Unknown)",
    `GET /v1/audit/operations → ${succeeded.operationId} outcome=${String(createdOutcome)}`,
    createdOutcome === "succeeded",
  );
  evidence.recordAssertionEvidence(
    "Creating a team records team.create.requested (unknown) then team.create.succeeded in one operation",
    `ops=${succeeded.operationId} kind=${String(requested.operation.kind)} origin=${String(requested.operation.origin)} http=${JSON.stringify(succeeded.http)} actor=${JSON.stringify(succeeded.actor)} resources=${JSON.stringify(resourceRows)}; the audit API returned the same two events.`,
    true,
  );

  const minted = await call(w.den, "/v1/api-keys", { method: "POST", headers, body: { name: `Audit witness key ${w.stamp}` } });
  expect(minted.response.status, minted.text).toBe(201);
  state.apiKey = text(record(minted.body, "api key").key, "api key value");
  state.apiKeyId = text(record(record(minted.body, "api key").apiKey, "apiKey").id, "api key id");
  mark = await watermark(w, w.orgId);
  const updated = await call(w.den, `/v1/teams/${teamId}`, { method: "PATCH", headers: { "x-api-key": state.apiKey }, body: { name: `Audit renamed ${w.stamp}` } });
  expect(updated.response.status, updated.text).toBe(200);
  const updates = (await tenantEvents(w, w.orgId, mark)).filter((event) => event.action.startsWith("team.update."));
  expect(updates.map((event) => event.action), summary(updates)).toEqual(["team.update.requested", "team.update.succeeded"]);
  for (const event of updates) {
    expect(event.actor).toEqual({ type: "user", id: w.adminUserId, memberId: w.adminMemberId, credentialId: state.apiKeyId });
    expect(event.resources).toEqual(expect.arrayContaining([expect.objectContaining({ type: "team", id: teamId, relationship: "target" })]));
  }
  expect(updates[0]?.operationId).toBe(updates[1]?.operationId);
  expect(updates[1]?.http).toEqual({ method: "PATCH", route: "/v1/teams/:teamId", status: 200 });
  const principal = await sql(w, "SELECT principal_key FROM audit_operation WHERE id = ?", [updates[0]?.operationId ?? ""]);
  expect(String(principal[0]?.principal_key)).toBe(`user:${w.adminUserId}:member:${w.adminMemberId}:key:${state.apiKeyId}`);
  const dump = await allAuditText(w);
  const leaked = dump.includes(state.apiKey);
  expect(leaked, "API key value found in audit tables").toBe(false);
  evidence.recordAssertionEvidence(
    "An API-key PATCH names the key id as credentialId; the key value appears nowhere in audit_event, audit_event_resource, audit_operation or platform_audit_event",
    `actor=${JSON.stringify(updates[1]?.actor)} principal=${String(principal[0]?.principal_key)}; scanned ${dump.length} bytes of audit rows for the ${state.apiKey.length}-char key: found=${leaked}`,
    !leaked,
  );

  mark = await watermark(w, w.orgId);
  const removed = await call(w.den, `/v1/teams/${teamId}`, { method: "DELETE", headers });
  expect(removed.response.status, removed.text).toBe(204);
  state.deletedTeamId = teamId;
  const deletes = (await tenantEvents(w, w.orgId, mark)).filter((event) => event.action.startsWith("team.delete."));
  expect(deletes.map((event) => event.action), summary(deletes)).toEqual(["team.delete.requested", "team.delete.succeeded"]);
  expect(deletes[1]?.http).toEqual({ method: "DELETE", route: "/v1/teams/:teamId", status: 204 });
  evidence.recordAssertionEvidence("Deleting the team records team.delete.requested then team.delete.succeeded (HTTP 204)", summary(deletes), true);
});

test.skipIf(skip)(name("2. rejected team changes record .attempted with validation_failed, denied (security) and resource_not_found"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const headers = orgHeaders(w.admin, w.orgId);

  let mark = await watermark(w, w.orgId);
  const invalid = await call(w.den, "/v1/teams", { method: "POST", headers, body: { name: "" } });
  expect(invalid.response.status, invalid.text).toBe(400);
  const invalidEvents = (await tenantEvents(w, w.orgId, mark)).filter((event) => event.action.startsWith("team.create."));
  expect(invalidEvents.map((event) => `${event.action}/${event.outcome}/${event.reasonCode ?? ""}`), summary(invalidEvents)).toEqual(["team.create.requested/unknown/", "team.create.attempted/failed/validation_failed"]);
  expect(invalidEvents[1]?.http).toEqual({ method: "POST", route: "/v1/teams", status: 400 });

  mark = await watermark(w, w.orgId);
  const denied = await call(w.den, "/v1/teams", { method: "POST", headers: orgHeaders(w.reader, w.orgId), body: { name: `Reader team ${w.stamp}` } });
  expect(denied.response.status, denied.text).toBe(403);
  const deniedEvents = (await tenantEvents(w, w.orgId, mark)).filter((event) => event.action.startsWith("team.create."));
  const deniedOutcome = deniedEvents.find((event) => event.action === "team.create.attempted");
  expect(deniedOutcome, summary(deniedEvents)).toBeDefined();
  expect(deniedOutcome).toMatchObject({ outcome: "denied", category: "security", reasonCode: "request_denied" });
  expect(deniedOutcome?.actor).toEqual({ type: "user", id: expect.stringMatching(/^usr_/), memberId: w.readerMemberId });
  expect(deniedOutcome?.http).toEqual({ method: "POST", route: "/v1/teams", status: 403 });
  expect(deniedEvents.map((event) => event.action), summary(deniedEvents)).toEqual(["team.create.requested", "team.create.attempted"]);
  const deniedOperationOutcome = await listedOperationOutcome(w.den, headers, deniedOutcome?.operationId ?? "");
  expect(deniedOperationOutcome, "operation outcome projection after a denied attempt").toBe("failed");
  evidence.recordAssertionEvidence(
    "A denied attempt's operation is listed with outcome failed (denied events project to failed)",
    `GET /v1/audit/operations → ${deniedOutcome?.operationId ?? "(missing)"} outcome=${String(deniedOperationOutcome)}`,
    deniedOperationOutcome === "failed",
  );

  mark = await watermark(w, w.orgId);
  const missing = await call(w.den, `/v1/teams/${state.deletedTeamId}`, { method: "PATCH", headers, body: { name: `Ghost ${w.stamp}` } });
  expect(missing.response.status, missing.text).toBe(404);
  const missingEvents = (await tenantEvents(w, w.orgId, mark)).filter((event) => event.action.startsWith("team.update."));
  expect(missingEvents.map((event) => `${event.action}/${event.outcome}/${event.reasonCode ?? ""}`), summary(missingEvents)).toEqual(["team.update.requested/unknown/", "team.update.attempted/failed/resource_not_found"]);
  expect(missingEvents[1]?.resources).toEqual(expect.arrayContaining([expect.objectContaining({ type: "team", id: state.deletedTeamId, relationship: "target" })]));
  evidence.recordAssertionEvidence(
    "400, 403 and 404 each record .requested then .attempted with the mapped outcome and reason",
    `400 → ${summary(invalidEvents)}; 403 by reader → ${summary(deniedEvents)} category=${deniedOutcome?.category}; 404 → ${summary(missingEvents)}`,
    true,
  );
});

test.skipIf(skip)(name("3. unauthenticated and sign-in failures go to the tenantless platform store without secrets; platform reads are not recorded by default"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const columns = await sql(w, "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'platform_audit_event'");
  const columnNames = columns.map((row) => String(row.c));
  expect(columnNames.length).toBeGreaterThan(5);
  expect(columnNames.filter((column) => /org/i.test(column))).toEqual([]);

  const tenantBefore = await totalTenantRows(w, w.orgId);
  const knownTeams = new Set((await platformRows(w, "/v1/teams")).map((row) => String(row.id)));
  const anonymous = await call(w.den, "/v1/teams", { method: "POST", headers: { "x-openwork-org-id": w.orgId }, body: { name: `Anonymous ${w.stamp}` } });
  expect(anonymous.response.status, anonymous.text).toBe(401);
  const anonymousRow = await pollPlatform(w, "/v1/teams", knownTeams, () => true);
  expect(anonymousRow).toMatchObject({ method: "POST", route: "/v1/teams", action: "team.create.attempted", outcome: "denied", status: 401, actor_type: "unknown", actor_id: null, credential_id: null, origin: "api" });
  expect(await totalTenantRows(w, w.orgId)).toBe(tenantBefore);

  const knownVersion = new Set((await platformRows(w, "/v1/app-version")).map((row) => String(row.id)));
  const version = await call(w.den, "/v1/app-version");
  expect(version.response.status, version.text).toBe(200);

  const platformTotalBeforeUnmatched = count(await sql(w, "SELECT COUNT(*) AS n FROM platform_audit_event"));
  const unmatched = await call(w.den, `/v1/no-such-audit-route-${w.stamp}`, { method: "POST", headers: { authorization: `Bearer ${w.admin.token}` }, body: {} });
  expect(unmatched.response.status).toBe(404);

  const wrongPassword = `Wrong-Audit-Password-${w.stamp}!`;
  const knownSignIn = new Set((await platformRows(w, "/api/auth/sign-in/email")).map((row) => String(row.id)));
  const signInFailure = await call(w.den, "/api/auth/sign-in/email", { method: "POST", body: { email: w.reader.email, password: wrongPassword } });
  expect([400, 401, 403]).toContain(signInFailure.response.status);
  const signInRow = await pollPlatform(w, "/api/auth/sign-in/email", knownSignIn, (row) => row.action === "auth.sign_in.email.attempted");
  expect(signInRow).toMatchObject({ method: "POST", outcome: "denied", actor_type: "unknown", actor_id: null });
  // The sign-in write was issued after the app-version read; give the read's
  // (would-be) fire-and-forget insert the same window before asserting absence.
  await sleep(500);
  const versionRows = (await platformRows(w, "/v1/app-version")).filter((row) => !knownVersion.has(String(row.id)));
  expect(versionRows).toEqual([]);
  // Only the sign-in row is new since the unmatched 404 (anonymous write was earlier).
  const platformTotalAfter = count(await sql(w, "SELECT COUNT(*) AS n FROM platform_audit_event"));
  const unmatchedRows = count(await sql(w, "SELECT COUNT(*) AS n FROM platform_audit_event WHERE route LIKE '%no-such-audit-route%' OR route IN ('/v1/*', '/*')"));
  expect(unmatchedRows).toBe(0);
  expect(platformTotalAfter - platformTotalBeforeUnmatched).toBe(1);
  const dump = await allAuditText(w);
  expect(dump.includes(wrongPassword)).toBe(false);
  const platformDump = JSON.stringify(await sql(w, "SELECT * FROM platform_audit_event"));
  expect(platformDump.includes(w.reader.email)).toBe(false);
  // The failed sign-in targets an existing member of this flagged organization:
  // the only tenant row is the detached session.sign_in_failed (actor unknown).
  const signInRequestId = text((await sql(w, "SELECT request_id FROM platform_audit_event WHERE id = ?", [String(signInRow.id)]))[0]?.request_id, "sign-in request id");
  let signInFailed: Envelope[] = [];
  for (let attempt = 0; attempt < 50 && signInFailed.length === 0; attempt++) {
    signInFailed = (await tenantEvents(w, w.orgId)).filter((event) => event.action === "session.sign_in_failed" && event.requestId === signInRequestId);
    if (signInFailed.length === 0) await sleep(200);
  }
  expect(signInFailed.map((event) => event.actor), summary(signInFailed)).toEqual([{ type: "unknown", id: null }]);
  expect(await totalTenantRows(w, w.orgId)).toBe(tenantBefore + 1);
  evidence.recordAssertionEvidence(
    "An anonymous org write and a failed sign-in are platform rows with an unknown actor and no organization; a successful platform GET is not recorded; the failed sign-in of an existing member adds only session.sign_in_failed to the member's flagged organization",
    `columns=${columnNames.join(",")}; anonymous=${JSON.stringify(anonymousRow)}; sign-in(${signInFailure.response.status})=${JSON.stringify(signInRow)}; app-version rows=${versionRows.length}; unmatched 404 rows=${unmatchedRows} (platform rows +${platformTotalAfter - platformTotalBeforeUnmatched} = the sign-in only); password in audit rows=false, email in platform rows=false; tenant rows ${tenantBefore} → +1 (${summary(signInFailed)})`,
    true,
  );
});

test.skipIf(skip)(name("4. routine reads record nothing by default, record .served once the read category is on, and a credential reveal records .requested and .served"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const headers = orgHeaders(w.admin, w.orgId);
  state.liveTeamName = `Audit live ${w.stamp}`;
  state.liveTeamId = await createTeam(w.den, headers, state.liveTeamName);

  const queryMarker = `audit-query-marker-${w.stamp}`;
  let mark = await watermark(w, w.orgId);
  const firstRead = await call(w.den, `/v1/teams/${state.liveTeamId}`, { headers });
  expect(firstRead.response.status, firstRead.text).toBe(200);
  const firstList = await call(w.den, `/v1/api-keys?probe=${queryMarker}`, { headers });
  expect(firstList.response.status, firstList.text).toBe(200);
  const quiet = (await tenantEvents(w, w.orgId, mark)).filter((event) => event.action.startsWith("team.read") || event.action.startsWith("api_key.list"));
  expect(quiet, summary(quiet)).toEqual([]);

  state.providerSecret = `audit-llm-fixture-secret-${w.stamp}`;
  const provider = await call(w.den, "/v1/llm-providers", { method: "POST", headers, body: {
    name: `Audit provider ${w.stamp}`, source: "custom", apiKey: state.providerSecret, teamIds: [],
    customConfig: { id: `audit-${w.stamp}`, name: "Audit", npm: "@ai-sdk/openai-compatible", env: ["AUDIT_API_KEY"], api: "https://inference.eval.invalid/v1", models: [{ id: "witness", name: "Witness", limit: { context: 32000, input: 32000, output: 32000 } }] },
  } });
  expect(provider.response.status, provider.text).toBe(201);
  state.providerId = text(record(record(provider.body, "provider").llmProvider, "llmProvider").id, "provider id");
  mark = await watermark(w, w.orgId);
  const reveal = await call(w.den, `/v1/llm-providers/${state.providerId}/connect`, { headers });
  expect(reveal.response.status, reveal.text).toBe(200);
  expect(reveal.text).toContain(state.providerSecret);
  const revealEvents = (await tenantEvents(w, w.orgId, mark)).filter((event) => event.action.startsWith("llm_provider.connect."));
  expect(revealEvents.map((event) => `${event.action}/${event.category}/${event.outcome}`), summary(revealEvents)).toEqual(["llm_provider.connect.requested/access/unknown", "llm_provider.connect.served/access/succeeded"]);
  expect(revealEvents[0]?.operationId).toBe(revealEvents[1]?.operationId);
  expect((await allAuditText(w)).includes(state.providerSecret)).toBe(false);

  await setReadCategory(w, w.orgId, true);
  mark = await watermark(w, w.orgId);
  const secondRead = await call(w.den, `/v1/teams/${state.liveTeamId}`, { headers });
  expect(secondRead.response.status, secondRead.text).toBe(200);
  const secondList = await call(w.den, `/v1/api-keys?probe=${queryMarker}`, { headers });
  expect(secondList.response.status, secondList.text).toBe(200);
  const served = (await tenantEvents(w, w.orgId, mark)).filter((event) => event.action.startsWith("team.read") || event.action.startsWith("api_key.list"));
  expect(served.map((event) => `${event.action}/${event.category}/${event.outcome}`), summary(served)).toEqual(["team.read.served/read/succeeded", "api_key.list.served/read/succeeded"]);
  expect(served[0]?.http).toEqual({ method: "GET", route: "/v1/teams/:teamId", status: 200 });
  expect(served[1]?.http).toEqual({ method: "GET", route: "/v1/api-keys", status: 200 });
  expect(served[1]?.resources).toEqual(expect.arrayContaining([expect.objectContaining({ type: "api_key", id: "collection:api_key", relationship: "target" })]));
  expect((await allAuditText(w)).includes(queryMarker)).toBe(false);
  evidence.recordAssertionEvidence(
    "Reads are silent by default, become one .served event when the operator selects the read category, and a key reveal is .requested + .served without the key",
    `default read → ${summary(quiet)}; reveal → ${summary(revealEvents)} (secret absent from audit rows); read on → ${summary(served)}; query-string marker absent from audit rows`,
    true,
  );
});

test.skipIf(skip)(name("5. when the audit store cannot append, a change is refused with 503 before it happens and a captured read releases no content"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const headers = orgHeaders(w.admin, w.orgId);
  const blockedName = `Audit blocked ${w.stamp}`;
  // An allowed browser origin (the testkit web origin is in CORS_ORIGINS): the
  // fail-closed 503 must keep Access-Control-Allow-Origin so browsers can read it.
  const origin = new URL(w.den.ref.webUrl).origin;
  const browserHeaders = { ...headers, origin };
  const control = await call(w.den, `/v1/teams/${state.liveTeamId}`, { headers: browserHeaders });
  expect(control.response.status, control.text).toBe(200);
  expect(control.response.headers.get("access-control-allow-origin")).toBe(origin);
  let change: DenFetchResult | null = null;
  let read: DenFetchResult | null = null;
  await sql(w, "RENAME TABLE audit_event_resource TO audit_event_resource_x");
  try {
    change = await call(w.den, "/v1/teams", { method: "POST", headers: browserHeaders, body: { name: blockedName } });
    read = await call(w.den, `/v1/teams/${state.liveTeamId}`, { headers: browserHeaders });
  } finally {
    await sql(w, "RENAME TABLE audit_event_resource_x TO audit_event_resource");
  }
  expect(change?.response.status, change?.text).toBe(503);
  expect(record(change?.body, "change body").error).toBe("audit_unavailable");
  expect(read?.response.status, read?.text).toBe(503);
  expect(record(read?.body, "read body").error).toBe("audit_unavailable");
  expect(read?.text.includes(state.liveTeamName)).toBe(false);
  const changeCors = change?.response.headers.get("access-control-allow-origin") ?? null;
  const readCors = read?.response.headers.get("access-control-allow-origin") ?? null;
  expect(changeCors, "CORS header on the intent-refused 503").toBe(origin);
  expect(readCors, "CORS header on the served-withheld 503").toBe(origin);
  expect(read?.response.headers.get("content-type") ?? "").toContain("application/json");
  evidence.recordAssertionEvidence(
    "Both fail-closed 503 responses keep Access-Control-Allow-Origin for the allowed browser origin",
    `origin=${origin}; change 503 ACAO=${String(changeCors)}; read 503 ACAO=${String(readCors)} content-type=${String(read?.response.headers.get("content-type"))}`,
    changeCors === origin && readCors === origin,
  );
  // Restore the default categories (read off) after proving the read gate.
  await setReadCategory(w, w.orgId, false);
  const names = await teamNames(w.den, headers);
  expect(names).not.toContain(blockedName);
  expect(names).toContain(state.liveTeamName);
  evidence.recordAssertionEvidence(
    "With audit_event_resource missing, POST /v1/teams returns 503 audit_unavailable and no team exists; GET /v1/teams/:teamId with read captured returns 503 without the team",
    `change=${change?.response.status} ${change?.text}; read=${read?.response.status} ${read?.text}; teams after restore=${JSON.stringify(names)}`,
    true,
  );
});

test.skipIf(skip)(name("5b. a deadlock on the durable intent is retried: the change succeeds with exactly one requested and one outcome event"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const headers = orgHeaders(w.admin, w.orgId);
  expect((await auditPolicy(w.den, w.admin, w.orgId)).captureOn).toBe(true);
  expect(count(await sql(w, "SELECT COUNT(*) AS n FROM audit_policy WHERE organization_id = ?", [w.orgId]))).toBe(1);
  // A disposable ballast table in the scratch database: the holder updates its
  // rows so InnoDB deterministically picks Den's lighter transaction as the
  // deadlock victim (victims are chosen by fewest modified rows and locks).
  const ballast = `audit_retry_ballast_${w.stamp.replace(/[^a-z0-9]/g, "")}`;
  await sql(w, `CREATE TABLE ${ballast} (id INT PRIMARY KEY, n INT NOT NULL)`);
  await sql(w, `INSERT INTO ${ballast} (id, n) WITH RECURSIVE seq (id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM seq WHERE id < 200) SELECT id, 0 FROM seq`);
  const mark = await watermark(w, w.orgId);
  const teamName = `Audit retried ${w.stamp}`;
  const holder = await heldConnection(w.dbUrl);
  let created: DenFetchResult | null = null;
  let holderClosedCycle = false;
  try {
    const [idRows] = await holder.query("SELECT CONNECTION_ID() AS id");
    const holderId = Number(Array.isArray(idRows) && isRecord(idRows[0]) ? idRows[0].id : NaN);
    const newestEvent = String((await sql(w, "SELECT COALESCE(MAX(id), '') AS n FROM audit_event"))[0]?.n ?? "");
    await holder.query("START TRANSACTION");
    // Audit appends take no locks of their own, so build the cycle from the
    // rows Den writes: it inserts its operation, then its event. Holding the
    // gap after the newest event id makes Den wait on its event insert while it
    // holds its new, uncommitted operation row.
    await holder.query("SELECT id FROM audit_event WHERE id > ? FOR UPDATE", [newestEvent]);
    await holder.query(`UPDATE ${ballast} SET n = n + 1`);
    const pending = call(w.den, "/v1/teams", { method: "POST", headers, body: { name: teamName } });
    const deadline = Date.now() + 20_000;
    let waiting = 0;
    while (waiting === 0 && Date.now() < deadline) {
      waiting = count(await sql(w, `SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits lw
        JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = lw.REQUESTING_ENGINE_LOCK_ID
        JOIN performance_schema.threads t ON t.THREAD_ID = lw.BLOCKING_THREAD_ID
        WHERE t.PROCESSLIST_ID = ? AND l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = 'audit_event'`, [holderId]));
      if (waiting === 0) await sleep(25);
    }
    expect(waiting, "Den's intent transaction waits on the held audit_event gap").toBeGreaterThan(0);
    // Close the cycle: this statement only returns once InnoDB rolled back
    // Den's intent transaction (ER_LOCK_DEADLOCK); were the holder chosen, it would throw.
    await holder.query("SELECT id FROM audit_operation WHERE organization_id = ? FOR UPDATE", [w.orgId]);
    holderClosedCycle = true;
    await holder.query("ROLLBACK");
    created = await pending;
  } finally {
    await holder.end();
    await sql(w, `DROP TABLE IF EXISTS ${ballast}`);
  }
  expect(holderClosedCycle).toBe(true);
  expect(created?.response.status, created?.text).toBe(201);
  const teamId = text(record(record(created?.body, "team response").team, "team").id, "team.id");
  const events = (await tenantEvents(w, w.orgId, mark)).filter((event) => event.action.startsWith("team.create."));
  expect(events.map((event) => `${event.action}/${event.outcome}`), summary(events)).toEqual(["team.create.requested/unknown", "team.create.succeeded/succeeded"]);
  expect(new Set(events.map((event) => event.operationId)).size).toBe(1);
  expect(events.every((event) => event.requestId === events[0]?.requestId)).toBe(true);
  expect(count(await sql(w, "SELECT COUNT(*) AS n FROM audit_operation WHERE id = ?", [events[0]?.operationId ?? ""]))).toBe(1);
  expect(await teamNames(w.den, headers)).toContain(teamName);
  const retryLines = (await w.den.apiLog()).split("\n").filter((line) => line.includes("[audit-append-retry]") && line.includes(w.orgId) && line.includes("team.create.requested"));
  expect(retryLines.length, "Den logged the retried intent").toBeGreaterThanOrEqual(1);
  expect(retryLines[0]).toContain("lock_conflict");
  evidence.recordAssertionEvidence(
    "A deadlock on POST /v1/teams' durable intent is retried: InnoDB rolled Den's intent transaction back, the retry committed it, the team was created (201) and the operation holds exactly team.create.requested + team.create.succeeded",
    `holder closed the lock cycle=${holderClosedCycle}; status=${created?.response.status}; events=${summary(events)}; retry log=${retryLines[0]?.slice(0, 400) ?? "(none)"}`,
    true,
  );
});

test.skipIf(skip)(name("5c. operational probes GET /, /health and /ready are excluded from audit logs"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const tenantBefore = await totalTenantRows(w, w.orgId);
  const platformBefore = count(await sql(w, "SELECT COUNT(*) AS n FROM platform_audit_event"));
  const statuses: string[] = [];
  for (const path of ["/", "/health", "/ready"]) {
    // GET / may redirect to the marketing site; the probe itself is what is under test.
    const probe = await denFetch(w.den.ref, path, { headers: orgHeaders(w.admin, w.orgId), redirect: "manual", signal: AbortSignal.timeout(60_000) });
    statuses.push(`${path}=${probe.response.status}`);
    expect(probe.response.status, probe.text).toBeLessThan(500);
  }
  // Control: an always-recorded platform write in the same window proves the platform writer runs.
  const knownTeams = new Set((await platformRows(w, "/v1/teams")).map((row) => String(row.id)));
  const anonymous = await call(w.den, "/v1/teams", { method: "POST", headers: { "x-openwork-org-id": w.orgId }, body: { name: `Probe control ${w.stamp}` } });
  expect(anonymous.response.status, anonymous.text).toBe(401);
  await pollPlatform(w, "/v1/teams", knownTeams, () => true);
  const probeRows = count(await sql(w, "SELECT COUNT(*) AS n FROM platform_audit_event WHERE route IN ('/', '/health', '/ready')"));
  const platformAfter = count(await sql(w, "SELECT COUNT(*) AS n FROM platform_audit_event"));
  expect(probeRows).toBe(0);
  expect(platformAfter - platformBefore).toBe(1);
  expect(await totalTenantRows(w, w.orgId)).toBe(tenantBefore);
  evidence.recordAssertionEvidence(
    "GET /, /health and /ready record no platform or tenant audit row, while an anonymous write in the same window is recorded",
    `${statuses.join(", ")}; probe rows=${probeRows}; platform rows +${platformAfter - platformBefore} (the control); tenant rows unchanged at ${tenantBefore}`,
    true,
  );
});

test.skipIf(skip)(name("5d. GET /v1/plugins/:pluginId/resolved is not audited (high-volume read, ENG-683)"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const headers = orgHeaders(w.admin, w.orgId);
  const tenantBefore = await totalTenantRows(w, w.orgId);
  const platformBefore = count(await sql(w, "SELECT COUNT(*) AS n FROM platform_audit_event WHERE route = ?", ["/v1/plugins/:pluginId/resolved"]));
  const plugins = await call(w.den, "/v1/plugins?limit=5", { headers });
  expect(plugins.response.status, plugins.text).toBe(200);
  const items = Array.isArray(record(plugins.body, "plugins").items) ? record(plugins.body, "plugins").items : [];
  const pluginId = Array.isArray(items) && isRecord(items[0]) && typeof items[0].id === "string" ? items[0].id : "plg_01m4bmd960e2c9d0nfxf5c339y";
  const listed = count(await sql(w, "SELECT COUNT(*) AS n FROM audit_event WHERE org_id = ? AND envelope IS NOT NULL", [w.orgId]));
  const statuses: number[] = [];
  for (let index = 0; index < 5; index++) {
    const resolved = await call(w.den, `/v1/plugins/${encodeURIComponent(pluginId)}/resolved`, { headers });
    expect(resolved.response.status, resolved.text).toBeLessThan(500);
    statuses.push(resolved.response.status);
  }
  const tenantAfter = await totalTenantRows(w, w.orgId);
  const platformAfter = count(await sql(w, "SELECT COUNT(*) AS n FROM platform_audit_event WHERE route = ?", ["/v1/plugins/:pluginId/resolved"]));
  const resolvedEvents = count(await sql(w, "SELECT COUNT(*) AS n FROM audit_event WHERE org_id = ? AND action LIKE 'plugin.resolved.read.%'", [w.orgId]));
  expect(tenantAfter, "five /resolved calls add no tenant audit rows").toBe(listed);
  expect(resolvedEvents).toBe(0);
  expect(platformAfter).toBe(platformBefore);
  evidence.recordAssertionEvidence(
    "Five GET /v1/plugins/:pluginId/resolved calls record no tenant or platform audit row (declared excluded_high_volume)",
    `plugin=${pluginId}; statuses=${statuses.join(",")}; tenant rows ${tenantBefore} → ${listed} after the plugin list → ${tenantAfter} after /resolved; plugin.resolved.read events=${resolvedEvents}; platform rows for the route ${platformBefore} → ${platformAfter}`,
    true,
  );
});

test.skipIf(skip)(name("6. capture OFF stops recording but keeps history readable, stays OFF, and ON resumes"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const headers = orgHeaders(w.admin, w.orgId);
  const before = await auditPolicy(w.den, w.admin, w.orgId);
  expect(before.captureOn).toBe(true);
  const off = await call(w.den, "/v1/audit/settings", { method: "PATCH", headers, body: { captureOn: false, expectedRevision: before.revision } });
  expect(off.response.status, off.text).toBe(200);
  expect(record(off.body, "settings").captureOn).toBe(false);

  const rowsOff = await totalTenantRows(w, w.orgId);
  const offTeam = await createTeam(w.den, headers, `Audit while off ${w.stamp}`);
  const rename = await call(w.den, `/v1/teams/${offTeam}`, { method: "PATCH", headers, body: { name: `Audit while off renamed ${w.stamp}` } });
  expect(rename.response.status, rename.text).toBe(200);
  const history = await call(w.den, "/v1/audit/operations?action=team.create.succeeded", { headers });
  expect(history.response.status, history.text).toBe(200);
  const operations = Array.isArray(record(history.body, "operations").operations) ? record(history.body, "operations").operations : [];
  const historyCount = Array.isArray(operations) ? operations.length : 0;
  expect(historyCount).toBeGreaterThan(0);
  if (!w.den.restartApi) throw new Error("local Den must support restartApi");
  await w.den.restartApi();
  const afterRestart = await call(w.den, `/v1/teams/${offTeam}`, { method: "PATCH", headers, body: { name: `Audit off after restart ${w.stamp}` } });
  expect(afterRestart.response.status, afterRestart.text).toBe(200);
  const stillOff = await auditPolicy(w.den, w.admin, w.orgId);
  expect(stillOff.captureOn).toBe(false);
  expect(stillOff.revision).toBe(before.revision + 1);
  expect(await totalTenantRows(w, w.orgId)).toBe(rowsOff);

  const on = await call(w.den, "/v1/audit/settings", { method: "PATCH", headers, body: { captureOn: true, expectedRevision: stillOff.revision } });
  expect(on.response.status, on.text).toBe(200);
  const mark = await watermark(w, w.orgId);
  const resumed = await call(w.den, `/v1/teams/${offTeam}`, { method: "DELETE", headers });
  expect(resumed.response.status, resumed.text).toBe(204);
  const resumedEvents = (await tenantEvents(w, w.orgId, mark)).filter((event) => event.action.startsWith("team."));
  expect(resumedEvents.map((event) => event.action), summary(resumedEvents)).toEqual(["team.delete.requested", "team.delete.succeeded"]);
  evidence.recordAssertionEvidence(
    "Capture OFF records nothing for two mutations and reads, keeps history readable and stays OFF; ON resumes recording",
    `revision ${before.revision} → OFF; tenant rows stayed ${rowsOff}; history operations=${historyCount}; still OFF after a den-api restart=${!stillOff.captureOn} (revision ${stillOff.revision}); after ON → ${summary(resumedEvents)}`,
    true,
  );
});

test.skipIf(skip)(name("7. an organization without the auditLogs flag records nothing"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const outsiderEmail = `audit-outsider+${w.stamp}@example.test`;
  const password = "Audit-Outsider-Example-1!";
  const signUp = await call(w.den, "/api/auth/sign-up/email", { method: "POST", body: { email: outsiderEmail, name: "Audit Outsider", password } });
  expect(signUp.response.ok, signUp.text).toBe(true);
  const outsider = await signIn(w.den.ref, { email: outsiderEmail, password });
  state.outsider = outsider;
  const createdOrg = await call(w.den, "/v1/org", { method: "POST", headers: { authorization: `Bearer ${outsider.token}` }, body: { name: `Audit other org ${w.stamp}` } });
  expect(createdOrg.response.status, createdOrg.text).toBe(201);
  state.orgB = text(record(record(createdOrg.body, "org").organization, "organization").id, "org B id");
  const headersB = orgHeaders(outsider, state.orgB);
  const team = await createTeam(w.den, headersB, `Unflagged team ${w.stamp}`);
  const rename = await call(w.den, `/v1/teams/${team}`, { method: "PATCH", headers: headersB, body: { name: `Unflagged renamed ${w.stamp}` } });
  expect(rename.response.status, rename.text).toBe(200);
  const rows = await totalTenantRows(w, state.orgB);
  const policies = count(await sql(w, "SELECT COUNT(*) AS n FROM audit_policy WHERE organization_id = ?", [state.orgB]));
  const operations = count(await sql(w, "SELECT COUNT(*) AS n FROM audit_operation WHERE organization_id = ?", [state.orgB]));
  expect(rows).toBe(0);
  expect(operations).toBe(0);
  expect(policies).toBe(0);
  evidence.recordAssertionEvidence(
    "An unflagged organization's team create and rename write no audit rows and no policy",
    `org B audit_event=${rows}, audit_operation=${operations}, audit_policy=${policies}`,
    rows === 0 && operations === 0 && policies === 0,
  );
});

test.skipIf(skip)(name("8. tenants are isolated: another organization's owner sees none of org A's history and org A rows never carry org B"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const outsider = state.outsider;
  if (!outsider || !state.orgB) throw new Error("case 7 must create org B first");
  await setAuditFlag(w.den, w.admin, state.orgB, true);
  const headersA = orgHeaders(w.admin, w.orgId);
  const headersB = orgHeaders(outsider, state.orgB);
  const markA = await watermark(w, w.orgId);
  const rowsA = await totalTenantRows(w, w.orgId);

  await createTeam(w.den, headersB, `Org B audited ${w.stamp}`);
  const outsiderUserId = String((await sql(w, "SELECT id FROM user WHERE email = ?", [outsider.email]))[0]?.id ?? "");
  expect(outsiderUserId).toMatch(/^usr_/);
  const knownTeams = new Set((await platformRows(w, "/v1/teams")).map((row) => String(row.id)));
  const intoA = await call(w.den, "/v1/teams", { method: "POST", headers: orgHeaders(outsider, w.orgId), body: { name: `Intruder ${w.stamp}` } });
  expect([403, 404]).toContain(intoA.response.status);
  const intruderRow = await pollPlatform(w, "/v1/teams", knownTeams, (row) => row.actor_id === outsiderUserId);
  expect(intruderRow).toMatchObject({ action: "team.create.attempted", actor_type: "user", status: intoA.response.status });
  const readA = await call(w.den, "/v1/audit/operations", { headers: orgHeaders(outsider, w.orgId) });
  expect([403, 404]).toContain(readA.response.status);
  expect(await totalTenantRows(w, w.orgId)).toBe(rowsA);

  const aOps = await sql(w, "SELECT id FROM audit_operation WHERE organization_id = ?", [w.orgId]);
  const aOpIds = new Set(aOps.map((row) => String(row.id)));
  const listB = await call(w.den, "/v1/audit/operations?limit=100", { headers: headersB });
  expect(listB.response.status, listB.text).toBe(200);
  const bOperations = record(listB.body, "list B").operations;
  const bOpIds = Array.isArray(bOperations) ? bOperations.filter(isRecord).map((op) => String(op.id)) : [];
  expect(bOpIds.length).toBeGreaterThan(0);
  expect(bOpIds.filter((id) => aOpIds.has(id))).toEqual([]);
  expect(listB.text.includes(w.orgId)).toBe(false);
  const firstA = [...aOpIds][0] ?? "";
  const foreign = await call(w.den, `/v1/audit/operations/${firstA}/events`, { headers: headersB });
  expect(foreign.response.status, foreign.text).toBe(404);

  const bRowsList = await tenantEvents(w, state.orgB);
  const bText = JSON.stringify(bRowsList);
  expect(bText.includes(w.orgId)).toBe(false);
  const aRowsSince = await tenantEvents(w, w.orgId, markA);
  expect(JSON.stringify(aRowsSince).includes(state.orgB)).toBe(false);

  // The platform admin acting on flagged org B is attributed to org B only.
  const markB = await watermark(w, state.orgB);
  await setAuditFlag(w.den, w.admin, state.orgB, true);
  const adminEvents = (await tenantEvents(w, state.orgB, markB)).filter((event) => event.action.startsWith("organization.capabilities.update."));
  expect(adminEvents.map((event) => event.action), summary(adminEvents)).toEqual(["organization.capabilities.update.requested", "organization.capabilities.update.succeeded"]);
  expect(adminEvents[1]?.operation.origin).toBe("platform_admin");
  expect(adminEvents[1]?.actor).toEqual({ type: "user", id: w.adminUserId });
  const bRowsBeforeKey = await totalTenantRows(w, state.orgB);

  // An org-A API key with org B's header: the key's organization wins.
  const crossKey = await call(w.den, "/v1/teams", { method: "POST", headers: { "x-api-key": state.apiKey, "x-openwork-org-id": state.orgB }, body: { name: `Key header mismatch ${w.stamp}` } });
  const bAfter = await totalTenantRows(w, state.orgB);
  const keyEvents = (await tenantEvents(w, w.orgId, markA)).filter((event) => event.action.startsWith("team.create.") && event.actor.credentialId === state.apiKeyId);
  expect(bAfter).toBe(bRowsBeforeKey);
  if (crossKey.response.ok) {
    expect(keyEvents.map((event) => event.action), summary(keyEvents)).toEqual(["team.create.requested", "team.create.succeeded"]);
    expect(keyEvents.every((event) => event.resources.some((resource) => resource.type === "organization" && resource.id === w.orgId))).toBe(true);
  }
  evidence.recordAssertionEvidence(
    "Org B's owner cannot write into or read org A's audit; org B's own list and rows never mention org A; an org-A key sent with org B's header acts in, and is recorded only in, org A",
    `intrusion=${intoA.response.status}, audit read of A=${readA.response.status}, foreign events=${foreign.response.status}; org A rows unchanged at ${rowsA} until the key call; B operations=${bOpIds.length} (0 shared); key+B header → HTTP ${crossKey.response.status}, org A events ${summary(keyEvents)}, org B rows ${bRowsBeforeKey}→${bAfter}; intruder platform row=${JSON.stringify(intruderRow)}; admin on B → ${summary(adminEvents)} origin=${String(adminEvents[1]?.operation.origin)}`,
    true,
  );
});

test.skipIf(skip)(name("9. ten parallel team creations make ten separate operations without waiting on each other, and the usage refresh recomputes the totals"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const headers = orgHeaders(w.admin, w.orgId);
  const mark = await watermark(w, w.orgId);
  const results = await Promise.all(Array.from({ length: 10 }, (_value, index) => call(w.den, "/v1/teams", { method: "POST", headers, body: { name: `Parallel ${index} ${w.stamp}` } })));
  expect(results.map((result) => result.response.status)).toEqual(Array.from({ length: 10 }, () => 201));
  const events = (await tenantEvents(w, w.orgId, mark)).filter((event) => event.action.startsWith("team.create."));
  const byOperation = new Map<string, string[]>();
  for (const event of events) byOperation.set(event.operationId, [...(byOperation.get(event.operationId) ?? []), event.action]);
  expect(byOperation.size, summary(events)).toBe(10);
  for (const actions of byOperation.values()) expect(actions).toEqual(["team.create.requested", "team.create.succeeded"]);
  expect(new Set(events.map((event) => event.requestId)).size).toBe(10);
  // Envelopes no longer carry a per-organization sequence; ids order them.
  const raw = await sql(w, "SELECT envelope, sequence FROM audit_event WHERE org_id = ? AND envelope IS NOT NULL AND id > ?", [w.orgId, mark]);
  const envelopes = raw.map((row) => record(json(row.envelope), "envelope"));
  expect(envelopes.every((envelope) => envelope.schemaVersion === 2 && !("sequence" in envelope))).toBe(true);
  expect(raw.every((row) => row.sequence === null)).toBe(true);

  // Totals are not maintained on the write path: the scheduled refresh recomputes them.
  const denied = await denFetch(w.den.ref, "/internal/audit/usage/refresh", { method: "POST", headers: { authorization: "Bearer wrong-token-0123456789abcdef" }, signal: AbortSignal.timeout(60_000) });
  expect(denied.response.status, denied.text).toBe(401);
  const refreshed = await denFetch(w.den.ref, "/internal/audit/usage/refresh", { method: "POST", headers: { authorization: `Bearer ${MAINTENANCE_TOKEN}` }, signal: AbortSignal.timeout(60_000) });
  expect(refreshed.response.status, refreshed.text).toBe(200);
  expect(Number(record(refreshed.body, "refresh").organizations)).toBeGreaterThanOrEqual(1);
  const totals = (await sql(w, "SELECT COUNT(*) AS events, COALESCE(SUM(logical_bytes), 0) AS bytes FROM audit_event WHERE org_id = ? AND envelope IS NOT NULL AND operation_id IS NOT NULL", [w.orgId]))[0] ?? {};
  const operations = count(await sql(w, "SELECT COUNT(*) AS n FROM audit_operation WHERE organization_id = ? AND retention_state = 'retained'", [w.orgId]));
  const counters = (await sql(w, "SELECT event_count, retained_operations, logical_bytes FROM audit_state WHERE organization_id = ?", [w.orgId]))[0] ?? {};
  expect(Number(counters.event_count)).toBe(Number(totals.events));
  expect(Number(counters.retained_operations)).toBe(operations);
  expect(Number(counters.logical_bytes)).toBe(Number(totals.bytes));
  const usage = await call(w.den, "/v1/audit/usage", { headers });
  expect(usage.response.status, usage.text).toBe(200);
  expect(Number(record(usage.body, "usage").eventCount)).toBe(Number(totals.events));
  evidence.recordAssertionEvidence(
    "Ten concurrent creates give ten operations of exactly requested+succeeded with version 2 envelopes (no sequence); POST /internal/audit/usage/refresh (401 without the token) recomputes audit_state to the row counts and /v1/audit/usage reports them",
    `operations=${byOperation.size}; refresh=${refreshed.text}; audit_state=${JSON.stringify(counters)} vs events=${String(totals.events)} bytes=${String(totals.bytes)} operations=${operations}`,
    true,
  );
});

async function mcpCall(den: Den, token: string, method: string, params: Row, id: number): Promise<Row> {
  const response = await fetch(`${den.ref.apiUrl.replace(/\/+$/, "")}/mcp/agent`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`MCP ${method} failed: HTTP ${response.status} ${raw.slice(0, 500)}`);
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  const payload = record(JSON.parse(dataLine ? dataLine.slice(5) : raw), "MCP JSON-RPC payload");
  if (payload.error) throw new Error(`MCP ${method} JSON-RPC error: ${JSON.stringify(payload.error)}`);
  return record(payload.result, "MCP result");
}

function toolPayload(result: Row): Row {
  if (isRecord(result.structuredContent)) return result.structuredContent;
  const first = Array.isArray(result.content) ? result.content[0] : null;
  return record(isRecord(first) && typeof first.text === "string" ? JSON.parse(first.text) : null, "MCP tool payload");
}

test.skipIf(skip)(name("10. the MCP transport itself is not audited, while a tool call that re-enters POST /v1/teams is recorded with origin mcp"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const headers = orgHeaders(w.admin, w.orgId);
  const minted = await call(w.den, "/v1/mcp/token", { method: "POST", headers, body: { scopes: ["mcp:read", "mcp:write"] } });
  expect(minted.response.status, minted.text).toBe(200);
  const token = text(record(minted.body, "mcp token").token, "mcp token");
  expect((await allAuditText(w)).includes(token)).toBe(false);
  const platformMcpBefore = count(await sql(w, "SELECT COUNT(*) AS n FROM platform_audit_event WHERE route LIKE '/mcp%'"));

  let mark = await watermark(w, w.orgId);
  const tools = await mcpCall(w.den, token, "tools/list", {}, 1);
  expect(Array.isArray(tools.tools)).toBe(true);
  const search = toolPayload(await mcpCall(w.den, token, "tools/call", { name: "search_capabilities", arguments: { query: "create team", limit: 20 } }, 2));
  const matches = Array.isArray(search.matches) ? search.matches.filter(isRecord) : [];
  const match = matches.find((entry) => entry.method === "POST" && entry.path === "/v1/teams");
  if (!match) throw new Error(`No POST /v1/teams capability in ${JSON.stringify(matches.map((entry) => [entry.name, entry.method, entry.path]))}`);
  await sleep(300);
  const transportEvents = await tenantEvents(w, w.orgId, mark);
  expect(transportEvents, summary(transportEvents)).toEqual([]);

  mark = await watermark(w, w.orgId);
  const teamName = `Audit via MCP ${w.stamp}`;
  const executed = await mcpCall(w.den, token, "tools/call", { name: "execute_capability", arguments: { name: text(match.name, "match name"), body: { name: teamName } } }, 3);
  expect(executed.isError, JSON.stringify(executed).slice(0, 500)).not.toBe(true);
  expect(await teamNames(w.den, headers)).toContain(teamName);
  const events = await tenantEvents(w, w.orgId, mark);
  const teamEvents = events.filter((event) => event.action.startsWith("team.create."));
  expect(teamEvents.map((event) => event.action), summary(events)).toEqual(["team.create.requested", "team.create.succeeded"]);
  expect(events.filter((event) => !event.action.startsWith("team.create.") && !event.action.startsWith("organization.read")), summary(events)).toEqual([]);
  for (const event of teamEvents) {
    expect(event.operation.origin).toBe("mcp");
    expect(event.actor).toMatchObject({ type: "user", id: w.adminUserId, memberId: w.adminMemberId });
  }
  expect(teamEvents[1]?.http).toEqual({ method: "POST", route: "/v1/teams", status: 201 });
  const platformMcpAfter = count(await sql(w, "SELECT COUNT(*) AS n FROM platform_audit_event WHERE route LIKE '/mcp%'"));
  expect(platformMcpAfter).toBe(platformMcpBefore);
  evidence.recordAssertionEvidence(
    "tools/list and search_capabilities on /mcp/agent add no audit rows; execute_capability → POST /v1/teams records team.create.* with origin mcp for the token's user",
    `transport events=${transportEvents.length}, platform /mcp rows ${platformMcpBefore}→${platformMcpAfter}; capability ${String(match.name)} → ${summary(teamEvents)} origin=${String(teamEvents[0]?.operation.origin)} actor=${JSON.stringify(teamEvents[1]?.actor)} http=${JSON.stringify(teamEvents[1]?.http)}`,
    true,
  );
});

test.skipIf(skip)(name("11. a request through the legacy /v1/orgs/:orgId proxy records exactly one destination operation"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const mark = await watermark(w, w.orgId);
  const operationsBefore = count(await sql(w, "SELECT COUNT(*) AS n FROM audit_operation WHERE organization_id = ?", [w.orgId]));
  const proxied = await call(w.den, `/v1/orgs/${w.orgId}/teams`, { method: "POST", headers: { authorization: `Bearer ${w.admin.token}` }, body: { name: `Audit via proxy ${w.stamp}` } });
  expect(proxied.response.status, proxied.text).toBe(201);
  const events = await tenantEvents(w, w.orgId, mark);
  const operationsAfter = count(await sql(w, "SELECT COUNT(*) AS n FROM audit_operation WHERE organization_id = ?", [w.orgId]));
  expect(events.map((event) => event.action), summary(events)).toEqual(["team.create.requested", "team.create.succeeded"]);
  expect(new Set(events.map((event) => event.operationId)).size).toBe(1);
  expect(operationsAfter - operationsBefore).toBe(1);
  expect(events[1]?.http).toEqual({ method: "POST", route: "/v1/teams", status: 201 });
  evidence.recordAssertionEvidence(
    "POST /v1/orgs/:orgId/teams adds one operation recorded at the destination route",
    `new operations=${operationsAfter - operationsBefore}; events ${summary(events)} http=${JSON.stringify(events[1]?.http)}`,
    true,
  );
});

test.skipIf(skip)(name("12. the event-type catalog lists the generic route actions once, in order"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const result = await call(w.den, "/v1/audit/event-types", { headers: orgHeaders(w.admin, w.orgId) });
  expect(result.response.status, result.text).toBe(200);
  const types = record(result.body, "event types").eventTypes;
  const list = Array.isArray(types) ? types.filter((value): value is string => typeof value === "string") : [];
  const expected = ["team.create.requested", "team.create.succeeded", "team.create.attempted", "team.read.served", "llm_provider.connect.served", "auth.sign_in.email.attempted"];
  const sorted = [...list].sort();
  expect(list).toEqual(sorted);
  expect(new Set(list).size).toBe(list.length);
  expect(list).toEqual(expect.arrayContaining(expected.filter((type) => !type.startsWith("auth."))));
  evidence.recordAssertionEvidence(
    "GET /v1/audit/event-types is unique, sorted and includes team.create.{requested,succeeded,attempted}, team.read.served and llm_provider.connect.served",
    `${list.length} types; platform-only auth.sign_in.email.attempted listed=${list.includes("auth.sign_in.email.attempted")}`,
    true,
  );
});

// Routes behind orgMemberRoute({ useUserOrganizations: true }) attribute to the caller's verified
// active membership (resolveUserOrganizationsMiddleware → beginUserOrganizationsAuditRequest).
test.skipIf(skip)(name("13. worker routes resolved from the caller's memberships record tenant evidence for the worker delete"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const headers = orgHeaders(w.admin, w.orgId);
  const { workerId } = await seedLocalWorker(w, `Audit worker ${w.stamp}`);
  const mark = await watermark(w, w.orgId);
  const knownPlatform = new Set((await platformRows(w, "/v1/workers/:id")).map((row) => String(row.id)));
  const deleted = await call(w.den, `/v1/workers/${workerId}`, { method: "DELETE", headers });
  expect(deleted.response.status, deleted.text).toBe(204);
  await sleep(500);
  const events = (await tenantEvents(w, w.orgId, mark)).filter((event) => event.action.startsWith("worker."));
  const platform = (await platformRows(w, "/v1/workers/:id")).filter((row) => !knownPlatform.has(String(row.id)));
  const remaining = await sql(w, "SELECT id FROM worker WHERE id = ?", [workerId]);
  evidence.recordAssertionEvidence(
    "DELETE /v1/workers/:id (tenant_external) records tenant operations in the caller's organization",
    `tenant events ${summary(events)}; new platform rows for /v1/workers/:id: ${JSON.stringify(platform)}; worker rows left: ${remaining.length}`,
    events.length > 0,
  );
  expect(events.map((event) => event.action), summary(events)).toEqual(["worker.delete.requested", "worker.delete.confirmed"]);
  for (const event of events) expect(event.actor).toEqual({ type: "user", id: w.adminUserId, memberId: w.adminMemberId });
  expect(events[1]?.resources).toEqual(expect.arrayContaining([expect.objectContaining({ type: "worker", id: workerId, relationship: "target" })]));
  expect(platform).toEqual([]);
  expect(remaining).toEqual([]);
});

// Handler-attributed routes call attributeAuditRequest once their credential is verified: the
// invitation accept attributes to the invitation's organization before accepting it.
// attributeAuditRequest, so an accepted invitation lands only in the platform store.
test.skipIf(skip)(name("14. an invitation and its acceptance are recorded in the inviting organization and the invite token is never stored"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const headers = orgHeaders(w.admin, w.orgId);
  const inviteeEmail = `audit-invitee+${w.stamp}@example.test`;
  const password = "Audit-Invitee-Example-1!";
  let mark = await watermark(w, w.orgId);
  const invited = await call(w.den, "/v1/invitations", { method: "POST", headers, body: { email: inviteeEmail, role: "member" } });
  expect(invited.response.status, invited.text).toBeLessThan(300);
  const inviteToken = text(record(invited.body, "invitation").inviteToken, "inviteToken");
  const inviteEvents = (await tenantEvents(w, w.orgId, mark)).filter((event) => event.action.startsWith("invitation.create."));
  expect(inviteEvents.map((event) => event.action), summary(inviteEvents)).toEqual(["invitation.create.requested", "invitation.create.confirmed"]);
  const signUp = await call(w.den, "/api/auth/sign-up/email", { method: "POST", body: { email: inviteeEmail, name: "Audit Invitee", password } });
  expect(signUp.response.ok, signUp.text).toBe(true);
  const invitee = await signIn(w.den.ref, { email: inviteeEmail, password });
  mark = await watermark(w, w.orgId);
  const knownPlatform = new Set((await platformRows(w, "/v1/orgs/invitations/accept")).map((row) => String(row.id)));
  const accepted = await call(w.den, "/v1/orgs/invitations/accept", { method: "POST", headers: { authorization: `Bearer ${invitee.token}` }, body: { id: inviteToken } });
  expect(accepted.response.status, accepted.text).toBeLessThan(300);
  await sleep(500);
  const acceptEvents = (await tenantEvents(w, w.orgId, mark)).filter((event) => event.action.startsWith("invitation.accept."));
  const platform = (await platformRows(w, "/v1/orgs/invitations/accept")).filter((row) => !knownPlatform.has(String(row.id)));
  const leaked = (await allAuditText(w)).includes(inviteToken);
  expect(leaked, "invite token found in audit tables").toBe(false);
  evidence.recordAssertionEvidence(
    "Inviting records invitation.create requested+confirmed without the bearer invite token; accepting records invitation.accept in the inviting organization",
    `invite → ${summary(inviteEvents)}; token stored=${leaked}; accept(HTTP ${accepted.response.status}) → tenant ${summary(acceptEvents)}, platform ${JSON.stringify(platform)}`,
    !leaked && acceptEvents.length > 0,
  );
  expect(acceptEvents.map((event) => event.action), summary(acceptEvents)).toEqual(["invitation.accept.requested", "invitation.accept.confirmed"]);
  expect(acceptEvents[0]?.actor).toEqual({ type: "user", id: expect.stringMatching(/^usr_/) });
  expect(acceptEvents[1]?.http).toEqual({ method: "POST", route: "/v1/orgs/invitations/accept", status: accepted.response.status });
  expect(platform).toEqual([]);
  const invitationId = text(record(invited.body, "invitation").invitationId, "invitationId");
  expect(inviteEvents[1]?.resources).toEqual(expect.arrayContaining([expect.objectContaining({ type: "invitation", id: invitationId, relationship: "related" })]));
});

const TYPEID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
function syntheticTypeId(prefix: string): string {
  let suffix = String(Math.floor(Math.random() * 8));
  for (let index = 1; index < 26; index++) suffix += TYPEID_ALPHABET[Math.floor(Math.random() * TYPEID_ALPHABET.length)];
  return `${prefix}_${suffix}`;
}

/** A local worker and its activity token, seeded at the database seam (Den no longer creates workers over HTTP). */
async function seedLocalWorker(w: { dbUrl: string; orgId: string; adminUserId: string }, workerName: string): Promise<{ workerId: string; activityToken: string }> {
  const workerId = syntheticTypeId("wrk");
  const activityToken = randomBytes(32).toString("hex");
  await sql(w, "INSERT INTO worker (id, org_id, created_by_user_id, name, destination, status, workspace_path) VALUES (?, ?, ?, ?, 'local', 'healthy', ?)", [workerId, w.orgId, w.adminUserId, workerName, "/tmp/audit-eval-workspace"]);
  await sql(w, "INSERT INTO worker_token (id, worker_id, scope, token) VALUES (?, ?, 'activity', ?)", [syntheticTypeId("wkt"), workerId, activityToken]);
  return { workerId, activityToken };
}

async function sessionCookie(den: Den, email: string, password: string): Promise<string> {
  const response = await fetch(`${den.ref.apiUrl.replace(/\/+$/, "")}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(den.ref.apiUrl).origin },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(30_000),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0] ?? "").find((value) => value.includes("session_token="));
  return text(cookie, "session cookie");
}

test.skipIf(skip)(name("15. a SCIM v2 group create authenticated by the organization's SCIM token is recorded in that organization with the SCIM service actor"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  // better-auth generateSCIMToken reads the cookie session (no bearer plugin);
  // sign in before SSO exists (members of an SSO organization cannot use passwords).
  const adminCookie = await sessionCookie(w.den, w.admin.email, w.admin.password);
  // SCIM token rotation requires an enabled SSO connection with a verified
  // domain; seed a synthetic one directly in the scratch database.
  const providerId = `audit-sso-${w.stamp}`;
  const domain = `audit-${w.stamp}.example.test`;
  await sql(w, "INSERT INTO sso_provider (id, issuer, domain, user_id, provider_id, organization_id, domain_verified) VALUES (?, ?, ?, ?, ?, ?, 1)", [syntheticTypeId("ssp"), `https://idp.${domain}`, domain, w.adminUserId, providerId, w.orgId]);
  await sql(w, "INSERT INTO sso_connection (id, organization_id, provider_id, kind, issuer, domain, status, sign_in_path) VALUES (?, ?, ?, 'oidc', ?, ?, 'enabled', ?)", [syntheticTypeId("ssc"), w.orgId, providerId, `https://idp.${domain}`, domain, `/sso/${w.stamp}`]);
  let rotated: DenFetchResult;
  try {
    rotated = await call(w.den, "/v1/scim/token", { method: "POST", headers: { cookie: adminCookie, origin: new URL(w.den.ref.apiUrl).origin, "x-openwork-org-id": w.orgId }, body: {} });
  } finally {
    // The seeded SSO connection would make example.test sign-ups SSO-only for later cases.
    await sql(w, "DELETE FROM sso_connection WHERE provider_id = ?", [providerId]);
    await sql(w, "DELETE FROM sso_provider WHERE provider_id = ?", [providerId]);
  }
  expect(rotated.response.status, rotated.text).toBe(201);
  const scimToken = text(record(rotated.body, "scim token").scimToken, "scimToken");
  const scimProviderId = text(record(record(rotated.body, "scim token").connection, "scim connection").providerId, "scim providerId");

  const mark = await watermark(w, w.orgId);
  const knownPlatform = new Set((await platformRows(w, "/api/auth/scim/v2/Groups")).map((row) => String(row.id)));
  const created = await call(w.den, "/api/auth/scim/v2/Groups", { method: "POST", headers: { authorization: `Bearer ${scimToken}`, "content-type": "application/scim+json" }, body: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: `Audit SCIM group ${w.stamp}` } });
  expect(created.response.status, created.text).toBe(201);
  const rejected = await call(w.den, "/api/auth/scim/v2/Groups", { method: "POST", headers: { authorization: "Bearer not-a-real-scim-token" }, body: { displayName: `Rejected ${w.stamp}` } });
  expect(rejected.response.status).toBe(401);
  const events = (await tenantEvents(w, w.orgId, mark)).filter((event) => event.action.startsWith("scim_group.create."));
  expect(events.map((event) => event.action), summary(events)).toEqual(["scim_group.create.requested", "scim_group.create.succeeded"]);
  for (const event of events) expect(event.actor).toEqual({ type: "service", id: `scim:${scimProviderId}` });
  expect(events[1]?.http).toEqual({ method: "POST", route: "/api/auth/scim/v2/Groups", status: 201 });
  const rejectedRow = await pollPlatform(w, "/api/auth/scim/v2/Groups", knownPlatform, (row) => row.status === 401);
  expect(rejectedRow).toMatchObject({ action: "scim_group.create.attempted", outcome: "denied", actor_type: "unknown", actor_id: null });
  expect((await allAuditText(w)).includes(scimToken)).toBe(false);
  evidence.recordAssertionEvidence(
    "POST /api/auth/scim/v2/Groups with the org's SCIM token records scim_group.create requested+succeeded for actor scim:<providerId>; a bad token is a tenantless platform denial; the token is never stored",
    `tenant ${summary(events)} actor=${JSON.stringify(events[1]?.actor)}; bad token → ${JSON.stringify(rejectedRow)}`,
    true,
  );
});

test.skipIf(skip)(name("16. runner and worker signals (inventory, work poll, activity heartbeat) record one .observed event each, only once the read category is on"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const headers = orgHeaders(w.admin, w.orgId);
  const runnerId = `audit-runner-${w.stamp}`;
  const minted = await call(w.den, "/v1/automation-runners/token", { method: "POST", headers, body: { runnerId, protocolVersion: 1, supportedExecutionTargets: ["desktop"], capabilities: [], appVersion: "0.0.0-audit", platform: "linux", concurrency: 1 } });
  expect(minted.response.status, minted.text).toBe(200);
  const runnerToken = text(record(minted.body, "runner token").token, "runner token");
  const { workerId, activityToken } = await seedLocalWorker(w, `Audit signal worker ${w.stamp}`);
  const signals = async () => {
    const inventory = await call(w.den, "/v1/automation-runner/inventory", { method: "PUT", headers: { authorization: `Bearer ${runnerToken}` }, body: { computer: { label: "Audit eval runner", platform: "linux", appVersion: "0.0.0-audit" }, workspaces: [] } });
    expect(inventory.response.status, inventory.text).toBe(200);
    const work = await call(w.den, "/v1/automation-runner/work", { headers: { authorization: `Bearer ${runnerToken}` } });
    expect(work.response.status, work.text).toBe(200);
    const heartbeat = await call(w.den, `/v1/workers/${workerId}/activity-heartbeat`, { method: "POST", headers: { authorization: `Bearer ${activityToken}` }, body: { isActiveRecently: true } });
    expect(heartbeat.response.status, heartbeat.text).toBe(200);
  };
  const isSignal = (event: Envelope) => event.action.startsWith("automation_runner.") || event.action.startsWith("worker.activity.");

  let mark = await watermark(w, w.orgId);
  await signals();
  const quiet = (await tenantEvents(w, w.orgId, mark)).filter(isSignal);
  expect(quiet, summary(quiet)).toEqual([]);

  await setReadCategory(w, w.orgId, true);
  let events: Envelope[] = [];
  try {
    mark = await watermark(w, w.orgId);
    await signals();
    events = (await tenantEvents(w, w.orgId, mark)).filter(isSignal);
  } finally {
    await setReadCategory(w, w.orgId, false);
  }
  expect(events.map((event) => `${event.action}/${event.category}/${event.outcome}`), summary(events)).toEqual([
    "automation_runner.inventory.update.observed/read/succeeded",
    "automation_runner.work.poll.observed/read/succeeded",
    "worker.activity.heartbeat.observed/read/succeeded",
  ]);
  expect(new Set(events.map((event) => event.operationId)).size).toBe(3);
  expect(events[0]?.actor).toEqual({ type: "service", id: `automation-runner:${runnerId}`, memberId: w.adminMemberId });
  expect(events[0]?.http).toEqual({ method: "PUT", route: "/v1/automation-runner/inventory", status: 200 });
  expect(events[2]?.actor).toMatchObject({ type: "service", id: `worker:${workerId}` });
  expect(events[2]?.resources).toEqual(expect.arrayContaining([expect.objectContaining({ type: "worker", id: workerId, relationship: "target" })]));
  const dump = await allAuditText(w);
  expect(dump.includes(runnerToken)).toBe(false);
  expect(dump.includes(activityToken)).toBe(false);
  evidence.recordAssertionEvidence(
    "Runner inventory, the work poll and a worker activity heartbeat (tenant_signal) record nothing by default; with the read category on each is one .observed event (no .requested intent) for the runner/worker service; tokens are never stored",
    `read off → ${summary(quiet)}; read on → ${summary(events)} actors=${JSON.stringify(events.map((event) => event.actor))}`,
    true,
  );
});

test.skipIf(skip)(name("18. platform requests are filtered by effect: a token-issuing GET is recorded, a read-only session GET is not, and bearer codes in the path are never stored"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const cookie = await sessionCookie(w.den, w.reader.email, w.reader.password);
  const authHeaders = { cookie, origin: new URL(w.den.ref.apiUrl).origin };
  const knownToken = new Set((await platformRows(w, "/api/auth/token")).map((row) => String(row.id)));
  const knownSession = new Set((await platformRows(w, "/api/auth/get-session")).map((row) => String(row.id)));
  const session = await call(w.den, "/api/auth/get-session", { headers: authHeaders });
  expect(session.response.status, session.text).toBe(200);
  const jwt = await call(w.den, "/api/auth/token", { headers: authHeaders });
  expect(jwt.response.status, jwt.text).toBe(200);
  const issued = text(record(jwt.body, "jwt").token, "jwt");
  const readerUserId = text((await sql(w, "SELECT id FROM user WHERE email = ?", [w.reader.email]))[0]?.id, "reader user id");
  const tokenRow = await pollPlatform(w, "/api/auth/token", knownToken, () => true);
  expect(tokenRow).toMatchObject({ method: "GET", action: "auth.jwt.issue.succeeded", outcome: "succeeded", status: 200, actor_type: "user", actor_id: readerUserId, target_type: "jwt", target_id: null });

  const knownUnsubscribe = new Set((await platformRows(w, "/v1/email/unsubscribe")).map((row) => String(row.id)));
  const forgedToken = `audit-forged-unsubscribe-${w.stamp}`;
  const unsubscribe = await call(w.den, `/v1/email/unsubscribe?email=${encodeURIComponent(w.reader.email)}&token=${forgedToken}`);
  expect(unsubscribe.response.status).toBe(400);
  const unsubscribeRow = await pollPlatform(w, "/v1/email/unsubscribe", knownUnsubscribe, () => true);
  expect(unsubscribeRow).toMatchObject({ method: "GET", action: "email_preference.unsubscribe_link.attempted", outcome: "failed", reason_code: "validation_failed", status: 400 });

  const claimCode = `AUDITCLAIM${w.stamp.toUpperCase()}`;
  const knownClaim = new Set((await platformRows(w, "/v1/bootstrap/claim-codes/:userCode")).map((row) => String(row.id)));
  const claim = await call(w.den, `/v1/bootstrap/claim-codes/${claimCode}`, { headers: { authorization: `Bearer ${w.reader.token}` } });
  expect(claim.response.status, claim.text).toBe(404);
  const claimRow = await pollPlatform(w, "/v1/bootstrap/claim-codes/:userCode", knownClaim, () => true);
  expect(claimRow).toMatchObject({ action: "workspace_claim_code.lookup.attempted", outcome: "failed", reason_code: "resource_not_found", target_type: "workspace_bootstrap", target_id: null });
  const deviceCode = `AUDITDEV${w.stamp.toUpperCase()}`.slice(0, 24);
  const knownDevice = new Set((await platformRows(w, "/v1/auth/device/:userCode")).map((row) => String(row.id)));
  const device = await call(w.den, `/v1/auth/device/${deviceCode}`, { headers: { authorization: `Bearer ${w.reader.token}` } });
  expect(device.response.status, device.text).toBe(404);
  const deviceRow = await pollPlatform(w, "/v1/auth/device/:userCode", knownDevice, () => true);
  expect(deviceRow).toMatchObject({ action: "auth.device_code.lookup.attempted", target_type: "device_code", target_id: null });

  // The get-session read was issued first; give its (would-be) fire-and-forget insert time.
  await sleep(500);
  const sessionRows = (await platformRows(w, "/api/auth/get-session")).filter((row) => !knownSession.has(String(row.id)));
  expect(sessionRows).toEqual([]);
  const dump = await allAuditText(w);
  for (const secret of [issued, forgedToken, claimCode, deviceCode, cookie.split("=")[1] ?? cookie]) expect(dump.includes(secret), "secret found in audit tables").toBe(false);
  evidence.recordAssertionEvidence(
    "GET /api/auth/token (issues a JWT) is a platform row for the signed-in user while GET /api/auth/get-session (readOnly) records nothing by default; a forged unsubscribe link, an unknown claim code and an unknown device code are recorded without their codes",
    `token → ${JSON.stringify(tokenRow)}; get-session rows=${sessionRows.length}; unsubscribe → ${JSON.stringify(unsubscribeRow)}; claim → ${JSON.stringify(claimRow)}; device → ${JSON.stringify(deviceRow)}; JWT, forged token, claim code, device code and session cookie absent from audit rows`,
    true,
  );
});

test.skipIf(skip)(name("19. deleting an organization leaves platform evidence that targets it, for a refusal and for the deletion"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const knownDelete = new Set((await platformRows(w, "/v1/org")).map((row) => String(row.id)));
  const readerUserId = text((await sql(w, "SELECT id FROM user WHERE email = ?", [w.reader.email]))[0]?.id, "reader user id");
  const tenantRowsBefore = await totalTenantRows(w, w.orgId);
  const refused = await call(w.den, "/v1/org", { method: "DELETE", headers: orgHeaders(w.reader, w.orgId) });
  expect(refused.response.status, refused.text).toBe(403);
  const refusedRow = await pollPlatform(w, "/v1/org", knownDelete, (row) => row.method === "DELETE" && row.actor_id === readerUserId);
  expect(refusedRow).toMatchObject({ action: "organization.delete.attempted", outcome: "denied", status: 403, actor_type: "user", target_type: "organization", target_id: w.orgId });
  expect(await totalTenantRows(w, w.orgId)).toBe(tenantRowsBefore);

  const ownerEmail = `audit-deleter+${w.stamp}@example.test`;
  const password = "Audit-Deleter-Example-1!";
  const signUp = await call(w.den, "/api/auth/sign-up/email", { method: "POST", body: { email: ownerEmail, name: "Audit Deleter", password } });
  expect(signUp.response.ok, signUp.text).toBe(true);
  const owner = await signIn(w.den.ref, { email: ownerEmail, password });
  const created = await call(w.den, "/v1/org", { method: "POST", headers: { authorization: `Bearer ${owner.token}` }, body: { name: `Audit doomed org ${w.stamp}` } });
  expect(created.response.status, created.text).toBe(201);
  const doomedId = text(record(record(created.body, "org").organization, "organization").id, "doomed org id");
  await setAuditFlag(w.den, w.admin, doomedId, true);
  await createTeam(w.den, orgHeaders(owner, doomedId), `Doomed team ${w.stamp}`);
  expect(await totalTenantRows(w, doomedId)).toBeGreaterThan(0);
  const ownerUserId = text((await sql(w, "SELECT id FROM user WHERE email = ?", [ownerEmail]))[0]?.id, "owner user id");
  const deleted = await call(w.den, "/v1/org", { method: "DELETE", headers: orgHeaders(owner, doomedId) });
  expect(deleted.response.status, deleted.text).toBe(200);
  const deletedRow = await pollPlatform(w, "/v1/org", knownDelete, (row) => row.method === "DELETE" && row.actor_id === ownerUserId);
  expect(deletedRow).toMatchObject({ action: "organization.delete.succeeded", outcome: "succeeded", status: 200, actor_type: "user", origin: "api", target_type: "organization", target_id: doomedId });
  const remaining = await totalTenantRows(w, doomedId);
  expect(remaining).toBe(0);
  evidence.recordAssertionEvidence(
    "DELETE /v1/org records a platform row targeting the organization from its verified context: denied for a non-owner member, succeeded for the owner after the purge removed the organization's tenant history",
    `refused → ${JSON.stringify(refusedRow)}; deleted → ${JSON.stringify(deletedRow)}; tenant rows of the deleted org afterwards=${remaining}`,
    true,
  );
});

test.skipIf(skip)(name("17. leaving through better-auth organization/leave is recorded in the organization with intent first and a member.removed change"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const leaverEmail = `audit-leaver+${w.stamp}@example.test`;
  const password = "Audit-Leaver-Example-1!";
  const invited = await call(w.den, "/v1/invitations", { method: "POST", headers: orgHeaders(w.admin, w.orgId), body: { email: leaverEmail, role: "member" } });
  expect(invited.response.status, invited.text).toBeLessThan(300);
  const inviteToken = text(record(invited.body, "invitation").inviteToken, "inviteToken");
  const signUp = await call(w.den, "/api/auth/sign-up/email", { method: "POST", body: { email: leaverEmail, name: "Audit Leaver", password } });
  expect(signUp.response.ok, signUp.text).toBe(true);
  const leaver = await signIn(w.den.ref, { email: leaverEmail, password });
  const accepted = await call(w.den, "/v1/orgs/invitations/accept", { method: "POST", headers: { authorization: `Bearer ${leaver.token}` }, body: { id: inviteToken } });
  expect(accepted.response.status, accepted.text).toBeLessThan(300);
  const leaverMember = await memberIdentity(w.den, w.admin, w.orgId, leaverEmail);
  const cookie = await sessionCookie(w.den, leaverEmail, password);

  const mark = await watermark(w, w.orgId);
  const left = await fetch(`${w.den.ref.apiUrl.replace(/\/+$/, "")}/api/auth/organization/leave`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: new URL(w.den.ref.apiUrl).origin },
    body: JSON.stringify({ organizationId: w.orgId }),
    signal: AbortSignal.timeout(30_000),
  });
  const leftText = await left.text();
  expect(left.status, leftText).toBe(200);
  const events = (await tenantEvents(w, w.orgId, mark)).filter((event) => event.action.startsWith("auth.organization.leave.") || event.action.startsWith("member.removed"));
  expect(events.map((event) => event.action), summary(events)).toEqual(["auth.organization.leave.requested", "member.removed", "auth.organization.leave.succeeded"]);
  for (const event of events) expect(event.actor).toEqual({ type: "user", id: leaverMember.userId, memberId: leaverMember.memberId });
  expect(new Set(events.map((event) => event.operationId)).size).toBe(1);
  expect(events[1]?.resources).toEqual(expect.arrayContaining([expect.objectContaining({ type: "member", id: leaverMember.memberId, relationship: "target" })]));
  expect(events[2]?.http).toEqual({ method: "POST", route: "/api/auth/organization/leave", status: 200 });
  const legacy = count(await sql(w, "SELECT COUNT(*) AS n FROM audit_event WHERE org_id = ? AND envelope IS NULL AND action = 'organization.member.removed' AND created_at >= NOW() - INTERVAL 1 MINUTE", [w.orgId]));
  expect(legacy).toBe(0);
  evidence.recordAssertionEvidence(
    "POST /api/auth/organization/leave records auth.organization.leave.requested before the delete, member.removed after it and .succeeded, in one operation for the leaving member; no legacy row is written while capture is on",
    `${summary(events)} actor=${JSON.stringify(events[0]?.actor)} legacy rows=${legacy}`,
    true,
  );
});

test.skipIf(skip)(name("7b. a flagged organization that loses its Enterprise entitlement stops recording and keeps its history"), LONG, async ({ evidence, place }) => {
  const stamp = `${Date.now().toString(36)}${process.pid.toString(36)}e`;
  const organizationName = `Audit entitlement ${stamp}`;
  // A separate install without DEN_AUDIT_SELF_HOSTED_ENABLED: that switch
  // entitles every organization, so per-org entitlement is the plan tier.
  await using den = await server({
    place,
    web: false,
    org: { name: organizationName, admin: { name: "Entitlement Admin", email: `audit-entitlement+${stamp}@example.test` }, members: {} },
    env: { DEN_AUDIT_SELF_HOSTED_ENABLED: undefined, DEN_AUDIT_CAPTURE_ENABLED: undefined, DEN_AUDIT_VISIBILITY_ENABLED: undefined, DEN_PLAN_GATING_ENABLED: "false", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "" },
  });
  const w = { dbUrl: guardedDatabaseUrl(den) };
  const admin = den.admin;
  const orgId = await organizationIdNamed(admin, organizationName);
  const headers = orgHeaders(admin, orgId);
  await setAuditFlag(den, admin, orgId, true);
  await createTeam(den, headers, `Not entitled ${stamp}`);
  const unentitledRows = await totalTenantRows(w, orgId);
  expect(unentitledRows).toBe(0);

  const plan = async (tier: string) => {
    const result = await call(den, `/v1/admin/organizations/${orgId}/plan`, { method: "PATCH", headers: { authorization: `Bearer ${admin.token}` }, body: { tier, seatLimit: 25 } });
    expect(result.response.status, result.text).toBe(200);
  };
  await plan("enterprise");
  const entitledTeam = await createTeam(den, headers, `Entitled ${stamp}`);
  const entitled = (await tenantEvents(w, orgId)).filter((event) => event.action.startsWith("team.create."));
  expect(entitled.map((event) => event.action), summary(entitled)).toEqual(["team.create.requested", "team.create.succeeded"]);

  const planRoute = "/v1/admin/organizations/:organizationId/plan";
  const knownPlan = new Set((await platformRows(w, planRoute)).map((row) => String(row.id)));
  await plan("team");
  // The downgrade's own outcome can no longer be appended to the tenant log
  // (entitlement gone after its intent): it is kept as platform evidence.
  const downgradeIntent = (await tenantEvents(w, orgId)).filter((event) => event.action.startsWith("organization.plan.update.")).at(-1);
  expect(downgradeIntent?.action).toBe("organization.plan.update.requested");
  const downgradeRow = await pollPlatform(w, planRoute, knownPlan, () => true);
  expect(downgradeRow).toMatchObject({ method: "PATCH", action: "organization.plan.update.succeeded", outcome: "succeeded", status: 200, reason_code: "tenant_audit_disabled", actor_type: "user", origin: "platform_admin", target_type: "organization", target_id: orgId });
  const rowsAfterLoss = await totalTenantRows(w, orgId);
  const rename = await call(den, `/v1/teams/${entitledTeam}`, { method: "PATCH", headers, body: { name: `After loss ${stamp}` } });
  expect(rename.response.status, rename.text).toBe(200);
  await createTeam(den, headers, `After loss new ${stamp}`);
  expect(await totalTenantRows(w, orgId)).toBe(rowsAfterLoss);
  const history = await call(den, "/v1/audit/operations?action=team.create.succeeded", { headers });
  expect(history.response.status, history.text).toBe(200);
  const operations = record(history.body, "operations").operations;
  const historyIds = Array.isArray(operations) ? operations.filter(isRecord).map((op) => String(op.id)) : [];
  expect(historyIds).toContain(entitled[1]?.operationId);
  evidence.recordAssertionEvidence(
    "Flag without entitlement records nothing; with Enterprise it records; the downgrade's outcome lands in the platform store targeting the organization; afterwards it records nothing and the earlier operation stays readable",
    `before Enterprise rows=${unentitledRows}; Enterprise → ${summary(entitled)}; downgrade intent ${String(downgradeIntent?.action)} + platform outcome ${JSON.stringify(downgradeRow)}; after downgrade rows stayed ${rowsAfterLoss}; history contains ${String(entitled[1]?.operationId)}=${historyIds.includes(entitled[1]?.operationId ?? "")}`,
    true,
  );
});
