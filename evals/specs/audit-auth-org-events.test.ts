import { createHash, randomBytes } from "node:crypto";
import { afterAll, expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenFetchResult, DenSession } from "@openwork/behaviors";
import { localMysqlIsRunning, localRedisIsRunning, queryDenDatabase, server, test } from "@openwork/testkit";
import type { Den, Place } from "@openwork/testkit";

// Behaviour proof for organization-bound auth endpoints: an MCP OAuth token is
// recorded (oauth_token.issued, later oauth_token.revoked) in the organization
// its consent names, with the user as actor and no token material; a raw
// better-auth mutation Den refuses records a denied attempt only in the
// caller's own organization and still answers 403; an invitee rejecting an
// invitation records invitation.rejected in the invitation's organization.
// Observed across the public HTTP boundary plus the disposable scratch database
// server() owns (openwork_eval_*). Synthetic example.test identities only;
// every secret below is a throwaway fixture value.

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
  operationId: string;
  action: string;
  category: string;
  outcome: string;
  reasonCode: string | null;
  requestId: string | null;
  actor: Row;
  resources: Row[];
  changes: Row | null;
  raw: string;
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
function json(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}
function count(rows: Row[]): number {
  return Number(rows[0]?.n ?? 0);
}
function envelopeOf(value: unknown): Envelope {
  const raw = record(json(value), "audit envelope");
  return {
    operationId: text(raw.operationId, "envelope.operationId"),
    action: text(raw.action, "envelope.action"),
    category: text(raw.category, "envelope.category"),
    outcome: text(raw.outcome, "envelope.outcome"),
    reasonCode: typeof raw.reasonCode === "string" ? raw.reasonCode : null,
    requestId: typeof raw.requestId === "string" ? raw.requestId : null,
    actor: record(raw.actor, "envelope.actor"),
    resources: Array.isArray(raw.resources) ? raw.resources.filter(isRecord) : [],
    changes: isRecord(raw.changes) ? raw.changes : null,
    raw: JSON.stringify(raw),
  };
}
function summary(events: Envelope[]): string {
  return events.map((event, index) => `${index + 1}:${event.action}/${event.outcome}${event.reasonCode ? `(${event.reasonCode})` : ""}`).join(", ") || "(none)";
}
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Identity = { userId: string; memberId: string };
type World = {
  den: Den;
  dbUrl: string;
  stamp: string;
  orgA: string;
  orgB: string;
  admin: DenSession;
  adminA: Identity;
  member: DenSession;
  memberA: Identity;
  secrets: Set<string>;
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

type RawResponse = { status: number; text: string; body: unknown; headers: Headers };

/** Raw request against the Den API origin (better-auth endpoints: cookie sessions, form bodies). */
async function raw(den: Den, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<RawResponse> {
  const base = den.ref.apiUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { origin: new URL(den.ref.apiUrl).origin, ...init.headers },
    ...(init.body === undefined ? {} : { body: init.body }),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const responseText = await response.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(responseText); } catch { parsed = null; }
  return { status: response.status, text: responseText, body: parsed, headers: response.headers };
}

function cookieJar(...responses: RawResponse[]): string {
  const cookies = new Map<string, string>();
  for (const response of responses) {
    for (const entry of response.headers.getSetCookie()) {
      const pair = entry.split(";")[0] ?? "";
      cookies.set(pair.slice(0, pair.indexOf("=")), pair);
    }
  }
  return [...cookies.values()].join("; ");
}

async function signIn(w: World, email: string, password: string): Promise<{ response: RawResponse; cookie: string }> {
  const response = await raw(w.den, "/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  expect(response.status, response.text).toBe(200);
  const cookie = cookieJar(response);
  for (const pair of cookie.split("; ")) {
    const value = decodeURIComponent(pair.slice(pair.indexOf("=") + 1));
    w.secrets.add(value);
    w.secrets.add(value.split(".")[0] ?? value);
  }
  return { response, cookie };
}

async function sql(world: { dbUrl: string }, statement: string, values: (string | number | null)[] = []): Promise<Row[]> {
  const rows = await queryDenDatabase(world.dbUrl, statement, values);
  return rows.filter(isRecord);
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

async function pollEvents(world: { dbUrl: string }, orgId: string, mark: string, action: string, minimum = 1): Promise<Envelope[]> {
  const deadline = Date.now() + 10_000;
  let events: Envelope[] = [];
  while (Date.now() < deadline) {
    events = (await tenantEvents(world, orgId, mark)).filter((event) => event.action === action);
    if (events.length >= minimum) return events;
    await sleep(200);
  }
  return events;
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

async function memberIdentity(den: Den, admin: DenSession, orgId: string, email: string): Promise<Identity> {
  const result = await call(den, "/v1/org", { headers: orgHeaders(admin, orgId) });
  expect(result.response.status, result.text).toBe(200);
  const members = isRecord(result.body) && Array.isArray(result.body.members) ? result.body.members.filter(isRecord) : [];
  const member = members.find((entry) => isRecord(entry.user) && entry.user.email === email);
  if (!member) throw new Error(`Member ${email} not found in ${result.text.slice(0, 400)}`);
  const user = record(member.user, "member.user");
  return { memberId: text(member.id, "member.id"), userId: text(member.userId ?? user.id, "member.userId") };
}

async function setAuditFlag(den: Den, admin: DenSession, orgId: string) {
  const result = await call(den, `/v1/admin/organizations/${orgId}/capabilities`, { method: "PUT", headers: { authorization: `Bearer ${admin.token}` }, body: { capabilities: { auditLogs: true } } });
  expect(result.response.status, result.text).toBe(200);
}

let booted: Promise<World> | null = null;
const owned = new AsyncDisposableStack();
afterAll(async () => {
  await owned.disposeAsync();
}, 60_000);

function world(place: Place): Promise<World> {
  booted ??= (async () => {
    const stamp = `${Date.now().toString(36)}${process.pid.toString(36)}`;
    const organizationName = `Audit auth org ${stamp}`;
    const den = owned.use(await server({
      place,
      web: false,
      org: {
        name: organizationName,
        admin: { name: "Audit Auth Admin", email: `audit-auth-admin+${stamp}@example.test` },
        members: { member: { name: "Audit Auth Member", email: `audit-auth-member+${stamp}@example.test` } },
      },
      env: {
        DEN_AUDIT_SELF_HOSTED_ENABLED: "true",
        DEN_AUDIT_CAPTURE_ENABLED: undefined,
        DEN_AUDIT_VISIBILITY_ENABLED: undefined,
        DEN_FEATURE_PLATFORM_AUDIT_READS: undefined,
        DEN_PLAN_GATING_ENABLED: "false",
        RESEND_API_KEY: "",
        STRIPE_SECRET_KEY: "",
      },
    }));
    const dbUrl = guardedDatabaseUrl(den);
    const admin = den.admin;
    const member = den.members.member;
    if (!member) throw new Error("Expected the synthetic member session");
    const orgA = await organizationIdNamed(admin, organizationName);
    // The admin also owns flagged B; the member belongs to A only.
    const createdB = await call(den, "/v1/org", { method: "POST", headers: { authorization: `Bearer ${admin.token}` }, body: { name: `Audit auth org B ${stamp}` } });
    expect(createdB.response.status, createdB.text).toBe(201);
    const orgB = text(record(record(createdB.body, "org").organization, "organization").id, "B id");
    await setAuditFlag(den, admin, orgA);
    await setAuditFlag(den, admin, orgB);
    return {
      den, dbUrl, stamp, orgA, orgB, admin, member,
      secrets: new Set([admin.token, member.token, admin.password, member.password]),
      adminA: await memberIdentity(den, admin, orgA, admin.email),
      memberA: await memberIdentity(den, admin, orgA, member.email),
    };
  })();
  return booted;
}

test.skipIf(skip)(name("1. an MCP OAuth token exchange records oauth_token.issued in the consent organization, revocation records oauth_token.revoked, and no token value is stored"), LONG, async ({ evidence, place }) => {
  const w = await world(place);
  const login = await signIn(w, w.admin.email, w.admin.password);
  const selected = await raw(w.den, "/api/auth/organization/set-active", { method: "POST", headers: { cookie: login.cookie, "content-type": "application/json" }, body: JSON.stringify({ organizationId: w.orgA }) });
  expect(selected.status, selected.text).toBe(200);
  const cookie = cookieJar(login.response, selected);
  const redirectUri = "http://127.0.0.1:19876/callback";
  const scope = "mcp:read mcp:write offline_access";
  const registration = await raw(w.den, "/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Audit org events", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope }) });
  expect(registration.status, registration.text).toBe(201);
  const clientId = text(record(registration.body, "registration").client_id, "client_id");
  const challenge = await raw(w.den, "/mcp/agent");
  const metadataUrl = challenge.headers.get("www-authenticate")?.match(/resource_metadata="([^"]+)"/)?.[1];
  if (!metadataUrl) throw new Error("Missing protected-resource discovery URL");
  const discovery = await raw(w.den, new URL(metadataUrl).pathname);
  const resource = text(record(discovery.body, "protected resource").resource, "resource");
  const verifier = randomBytes(32).toString("base64url");
  const authorizeQuery = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri, scope, resource, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", prompt: "consent" });
  const authorization = await raw(w.den, `/api/auth/oauth2/authorize?${authorizeQuery}`, { headers: { cookie } });
  expect(authorization.status, authorization.text).toBe(302);
  const consentLocation = text(authorization.headers.get("location"), "consent redirect");
  const consent = await raw(w.den, "/api/auth/oauth2/consent", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ accept: true, scope, oauth_query: new URL(consentLocation, w.den.ref.apiUrl).search.slice(1) }) });
  expect(consent.status, consent.text).toBe(200);
  const code = text(new URL(text(record(consent.body, "consent").url, "consent url")).searchParams.get("code"), "authorization code");
  w.secrets.add(code);
  w.secrets.add(verifier);

  const markA = await watermark(w, w.orgA);
  const markB = await watermark(w, w.orgB);
  const exchange = await raw(w.den, "/api/auth/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource }).toString() });
  expect(exchange.status, exchange.text).toBe(200);
  const tokens = record(exchange.body, "token response");
  const accessToken = text(tokens.access_token, "access_token");
  w.secrets.add(accessToken);
  const refreshToken = text(tokens.refresh_token, "refresh_token (offline_access)");
  w.secrets.add(refreshToken);

  const issued = await pollEvents(w, w.orgA, markA, "oauth_token.issued");
  expect(issued.map((event) => event.action), summary(issued)).toEqual(["oauth_token.issued"]);
  const [event] = issued;
  if (!event) throw new Error("missing oauth_token.issued");
  const operation = (await tenantEvents(w, w.orgA, markA)).filter((entry) => entry.operationId === event.operationId);
  expect(operation.map((entry) => entry.action), summary(operation)).toEqual(["auth.oauth.token.issue.requested", "oauth_token.issued", "auth.oauth.token.issue.succeeded"]);
  expect(event.actor).toEqual({ type: "user", id: w.adminA.userId, memberId: w.adminA.memberId });
  const after = record(event.changes?.after, "after");
  expect(after).toEqual({ clientId, scopes: ["mcp:read", "mcp:write", "offline_access"], grantType: "authorization_code", resource });
  const grant = await sql(w, "SELECT id FROM oauthConsent WHERE client_id = ? AND reference_id = ?", [clientId, w.orgA]);
  expect(event.resources).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "oauth_consent", id: text(grant[0]?.id, "consent id"), relationship: "target" }),
    expect.objectContaining({ type: "member", id: w.adminA.memberId, relationship: "related" }),
    expect.objectContaining({ type: "organization", id: w.orgA, relationship: "parent" }),
  ]));
  expect((await tenantEvents(w, w.orgB, markB)).filter((entry) => entry.action.startsWith("oauth_token.") || entry.action.startsWith("auth.oauth.token."))).toEqual([]);

  const markRefresh = await watermark(w, w.orgA);
  const refreshed = await raw(w.den, "/api/auth/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken, resource }).toString() });
  expect(refreshed.status, refreshed.text).toBe(200);
  const rotated = record(refreshed.body, "refresh response");
  const rotatedAccess = text(rotated.access_token, "rotated access_token");
  const rotatedRefresh = text(rotated.refresh_token, "rotated refresh_token");
  w.secrets.add(rotatedAccess);
  w.secrets.add(rotatedRefresh);
  const reissued = await pollEvents(w, w.orgA, markRefresh, "oauth_token.issued");
  expect(reissued.map((entry) => entry.action), summary(reissued)).toEqual(["oauth_token.issued"]);
  expect(record(reissued[0]?.changes?.after, "after")).toMatchObject({ clientId, grantType: "refresh_token", resource });

  const markRevoke = await watermark(w, w.orgA);
  const revoke = await raw(w.den, "/api/auth/oauth2/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: rotatedRefresh, token_type_hint: "refresh_token", client_id: clientId }).toString() });
  expect(revoke.status, revoke.text).toBe(200);
  const revoked = await pollEvents(w, w.orgA, markRevoke, "oauth_token.revoked");
  expect(revoked.map((entry) => entry.action), summary(revoked)).toEqual(["oauth_token.revoked"]);
  expect(revoked[0]?.actor).toEqual({ type: "user", id: w.adminA.userId, memberId: w.adminA.memberId });
  expect(record(revoked[0]?.changes?.before, "before")).toEqual({ clientId, scopes: ["mcp:read", "mcp:write", "offline_access"], tokenType: "refresh_token" });
  const revokedSummary = summary(revoked);

  const audit = await allAuditText(w);
  const leaked = [accessToken, refreshToken, rotatedAccess, rotatedRefresh, code, verifier].filter((secret) => audit.includes(secret));
  expect(leaked.length, "token material stored").toBe(0);
  const accessHash = createHash("sha256").update(accessToken).digest("base64url");
  expect(audit.includes(accessHash), "token hash stored").toBe(false);
  evidence.recordAssertionEvidence(
    "POST /api/auth/oauth2/token (authorization_code) is attributed to the consent organization A after it succeeds: requested → oauth_token.issued (clientId, scopes, grantType, resource; target the MCP grant; actor the user + member) → succeeded in one operation, nothing in B; the refresh_token grant records a second oauth_token.issued (grantType refresh_token); revoking the rotated refresh token records oauth_token.revoked in A; no access token, refresh token, code, verifier or hash is stored",
    `issue: ${summary(operation)} after=${JSON.stringify(after)}; refresh: ${summary(reissued)}; revoke: ${revokedSummary}; leaked=${leaked.length}`,
    true,
  );
});

test.skipIf(skip)(name("2. a refused raw better-auth mutation records a denied attempt in the caller's own organization only and still answers 403"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const { cookie } = await signIn(w, w.member.email, w.member.password);
  const markA = await watermark(w, w.orgA);
  const markB = await watermark(w, w.orgB);
  const platformBefore = count(await sql(w, "SELECT COUNT(*) AS n FROM platform_audit_event WHERE route = '/api/auth/organization/update-member-role'"));
  const own = await raw(w.den, "/api/auth/organization/update-member-role", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ memberId: w.memberA.memberId, role: "admin", organizationId: w.orgA }) });
  expect(own.status, own.text).toBe(403);
  const attempts = await pollEvents(w, w.orgA, markA, "auth.organization.member.role.update.attempted");
  expect(attempts.map((event) => event.action), summary(attempts)).toEqual(["auth.organization.member.role.update.attempted"]);
  const [attempt] = attempts;
  expect(attempt?.outcome).toBe("denied");
  expect(attempt?.reasonCode).toBe("raw_endpoint_refused");
  expect(attempt?.category).toBe("security");
  expect(attempt?.actor).toEqual({ type: "user", id: w.memberA.userId, memberId: w.memberA.memberId });
  const intents = (await tenantEvents(w, w.orgA, markA)).filter((event) => event.action.endsWith(".requested"));
  expect(summary(intents), "a refusal writes no intent").toBe("(none)");

  const foreign = await raw(w.den, "/api/auth/organization/update-member-role", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ memberId: w.memberA.memberId, role: "admin", organizationId: w.orgB }) });
  expect(foreign.status).toBe(403);
  expect(foreign.body).toEqual(own.body);
  await sleep(500);
  const inB = await tenantEvents(w, w.orgB, markB);
  expect(summary(inB), "never attributed to an organization the caller is not a member of").toBe("(none)");
  const platformAfter = count(await sql(w, "SELECT COUNT(*) AS n FROM platform_audit_event WHERE route = '/api/auth/organization/update-member-role'"));
  expect(platformAfter - platformBefore, "the foreign attempt stays platform evidence").toBe(1);
  const role = await sql(w, "SELECT role FROM member WHERE id = ?", [w.memberA.memberId]);
  expect(role[0]?.role).toBe("member");
  evidence.recordAssertionEvidence(
    "A member's cookie POST /api/auth/organization/update-member-role naming their own organization A answers 403 and records auth.organization.member.role.update.attempted (denied, raw_endpoint_refused, security, member actor, no intent) in A; the same call naming flagged B (not a member) answers the same 403 and records nothing in B, only platform evidence; the role is unchanged",
    `A: ${summary(attempts)}; B: ${summary(inB)}; platform rows +${platformAfter - platformBefore}; bodies equal=${JSON.stringify(foreign.body) === JSON.stringify(own.body)}`,
    true,
  );
});

test.skipIf(skip)(name("2b. a raw better-auth custom-role mutation is still refused with 403 and recorded as a denied attempt in the caller's organization although better-auth no longer serves it"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const { cookie } = await signIn(w, w.member.email, w.member.password);
  const markA = await watermark(w, w.orgA);
  const markB = await watermark(w, w.orgB);
  const own = await raw(w.den, "/api/auth/organization/create-role", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ role: "auditor", permission: { member: ["delete"] }, organizationId: w.orgA }) });
  expect(own.status, own.text).toBe(403);
  expect(own.body).toEqual({ error: "forbidden", message: "Custom organization roles are not supported." });
  const attempts = await pollEvents(w, w.orgA, markA, "auth.organization.role.create.attempted");
  expect(attempts.map((event) => event.action), summary(attempts)).toEqual(["auth.organization.role.create.attempted"]);
  const [attempt] = attempts;
  expect(attempt?.outcome).toBe("denied");
  expect(attempt?.reasonCode).toBe("raw_endpoint_refused");
  expect(attempt?.category).toBe("security");
  expect(attempt?.actor).toEqual({ type: "user", id: w.memberA.userId, memberId: w.memberA.memberId });
  const intents = (await tenantEvents(w, w.orgA, markA)).filter((event) => event.action.endsWith(".requested"));
  expect(summary(intents), "a refusal writes no intent").toBe("(none)");

  const foreign = await raw(w.den, "/api/auth/organization/delete-role", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ roleName: "auditor", organizationId: w.orgB }) });
  expect(foreign.status).toBe(403);
  await sleep(500);
  const inB = await tenantEvents(w, w.orgB, markB);
  expect(summary(inB), "never attributed to an organization the caller is not a member of").toBe("(none)");
  const anonymous = await raw(w.den, "/api/auth/organization/update-role", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roleName: "auditor", organizationId: w.orgA }) });
  expect(anonymous.status).toBe(403);
  evidence.recordAssertionEvidence(
    "A member's cookie POST /api/auth/organization/create-role naming organization A answers 403 (custom roles are not supported) and records auth.organization.role.create.attempted (denied, raw_endpoint_refused, security, member actor, no intent) in A; delete-role naming B (not a member) answers 403 and records nothing in B; an anonymous update-role answers 403",
    `A: ${summary(attempts)}; B: ${summary(inB)}; anonymous=${anonymous.status}`,
    true,
  );
});

test.skipIf(skip)(name("3. an invitee rejecting an invitation records invitation.rejected in the invitation's organization with the invitee as actor"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const invited = await call(w.den, "/v1/invitations", { method: "POST", headers: orgHeaders(w.admin, w.orgB), body: { email: w.member.email, role: "member" } });
  expect([201, 502], invited.text).toContain(invited.response.status);
  const invitation = record(invited.body, "invitation response");
  const invitationId = text(invitation.invitationId, "invitationId");
  if (typeof invitation.inviteToken === "string") w.secrets.add(invitation.inviteToken);
  const { cookie } = await signIn(w, w.member.email, w.member.password);
  const markB = await watermark(w, w.orgB);
  const rejected = await raw(w.den, "/api/auth/organization/reject-invitation", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ invitationId }) });
  expect(rejected.status, rejected.text).toBe(200);
  const events = await pollEvents(w, w.orgB, markB, "invitation.rejected");
  expect(events.map((event) => event.action), summary(events)).toEqual(["invitation.rejected"]);
  const [event] = events;
  const operation = (await tenantEvents(w, w.orgB, markB)).filter((entry) => entry.operationId === event?.operationId);
  expect(operation.map((entry) => entry.action), summary(operation)).toEqual(["auth.organization.invitation.reject.requested", "invitation.rejected", "auth.organization.invitation.reject.succeeded"]);
  expect(event?.actor).toEqual({ type: "user", id: w.memberA.userId });
  expect(event?.changes).toEqual({ before: { status: "pending" }, after: { status: "rejected" }, changedFields: ["status"] });
  expect(event?.resources).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "invitation", id: invitationId, relationship: "target" }),
    expect.objectContaining({ type: "organization", id: w.orgB, relationship: "parent" }),
  ]));
  expect(event?.raw.toLowerCase().includes(w.member.email.toLowerCase())).toBe(false);
  const audit = await allAuditText(w);
  const leaked = [...w.secrets].filter((secret) => secret.length >= 8 && audit.includes(secret));
  expect(leaked.length, "secrets found in audit tables").toBe(0);
  evidence.recordAssertionEvidence(
    "The invitee (a member of A, not B) rejects B's invitation: requested → invitation.rejected (status pending → rejected, actor the invitee user without a member id, no email) → succeeded in B; no session token, password, join token or OAuth material from this spec is stored",
    `B: ${summary(operation)} actor=${JSON.stringify(event?.actor)}; ${w.secrets.size} secrets checked, ${leaked.length} found`,
    true,
  );
});
