import { afterAll, expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenFetchResult, DenSession } from "@openwork/behaviors";
import { localMysqlIsRunning, localRedisIsRunning, queryDenDatabase, server, test } from "@openwork/testkit";
import type { Den, Place } from "@openwork/testkit";

// Behaviour proof for user-scoped audit events (attribution user_memberships):
// session lifecycle and organization switching land in the session's
// organization (every flagged membership when the session has none); account
// security changes and failed sign-ins fan out to every flagged organization
// where the user is an active member; Den's direct session revocation on member
// removal lands in the affected organization exactly once per session. Observed
// across the public HTTP boundary plus the disposable scratch database that
// server() owns (openwork_eval_*). All identities are synthetic example.test
// accounts; every secret below is a throwaway fixture value.

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
  sequence: number;
  action: string;
  category: string;
  outcome: string;
  reasonCode: string | null;
  requestId: string | null;
  actor: Row;
  operation: Row;
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
    sequence: Number(raw.sequence),
    action: text(raw.action, "envelope.action"),
    category: text(raw.category, "envelope.category"),
    outcome: text(raw.outcome, "envelope.outcome"),
    reasonCode: optionalText(raw.reasonCode),
    requestId: optionalText(raw.requestId),
    actor: record(raw.actor, "envelope.actor"),
    operation: record(raw.operation, "envelope.operation"),
    resources: Array.isArray(raw.resources) ? raw.resources.filter(isRecord) : [],
    changes: isRecord(raw.changes) ? raw.changes : null,
    raw: JSON.stringify(raw),
  };
}
function summary(events: Envelope[]): string {
  return events.map((event) => `${event.sequence}:${event.action}/${event.outcome}${event.reasonCode ? `(${event.reasonCode})` : ""}`).join(", ") || "(none)";
}
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function targets(event: Envelope | undefined, type: string, id: string): boolean {
  return Boolean(event?.resources.some((resource) => resource.type === type && resource.id === id && resource.relationship === "target"));
}

type Identity = { userId: string; memberId: string };
type World = {
  den: Den;
  dbUrl: string;
  stamp: string;
  orgA: string;
  orgB: string;
  orgC: string;
  admin: DenSession;
  adminA: Identity;
  adminB: Identity;
  member: DenSession;
  memberA: Identity;
  leaver: DenSession;
  leaverA: Identity;
  /** Every session token, grant and password used, for the leak check. */
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

/** Cookie-authenticated request (better-auth endpoints have no bearer plugin). */
async function cookieCall(den: Den, path: string, cookie: string | null, body: unknown): Promise<{ status: number; body: unknown; text: string; cookie: string | null }> {
  const base = den.ref.apiUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(den.ref.apiUrl).origin, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const responseText = await response.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(responseText); } catch { parsed = null; }
  const setCookie = response.headers.getSetCookie().map((value) => value.split(";")[0] ?? "").find((value) => value.includes("session_token=")) ?? null;
  return { status: response.status, body: parsed, text: responseText, cookie: setCookie };
}

async function sql(world: { dbUrl: string }, statement: string, values: (string | number | null)[] = []): Promise<Row[]> {
  const rows = await queryDenDatabase(world.dbUrl, statement, values);
  return rows.filter(isRecord);
}

async function tenantEvents(world: { dbUrl: string }, orgId: string, afterSequence = 0): Promise<Envelope[]> {
  const rows = await sql(world, "SELECT envelope FROM audit_event WHERE org_id = ? AND envelope IS NOT NULL AND sequence > ? ORDER BY sequence", [orgId, afterSequence]);
  return rows.map((row) => envelopeOf(row.envelope));
}

async function watermark(world: { dbUrl: string }, orgId: string): Promise<number> {
  return count(await sql(world, "SELECT COALESCE(MAX(sequence), 0) AS n FROM audit_event WHERE org_id = ? AND envelope IS NOT NULL", [orgId]));
}

async function envelopeRows(world: { dbUrl: string }, orgId: string): Promise<number> {
  return count(await sql(world, "SELECT COUNT(*) AS n FROM audit_event WHERE org_id = ? AND envelope IS NOT NULL", [orgId]));
}

/** Events of `action` after the mark, polled until `minimum` exist (detached emitters). */
async function pollEvents(world: { dbUrl: string }, orgId: string, mark: number, action: string, minimum = 1): Promise<Envelope[]> {
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

async function setAuditFlag(den: Den, admin: DenSession, orgId: string, value: boolean) {
  const result = await call(den, `/v1/admin/organizations/${orgId}/capabilities`, { method: "PUT", headers: { authorization: `Bearer ${admin.token}` }, body: { capabilities: { auditLogs: value } } });
  expect(result.response.status, result.text).toBe(200);
  expect(record(record(result.body, "capabilities").capabilities, "capabilities").auditLogs).toBe(value);
}

async function createOrganization(den: Den, admin: DenSession, organizationName: string): Promise<string> {
  const created = await call(den, "/v1/org", { method: "POST", headers: { authorization: `Bearer ${admin.token}` }, body: { name: organizationName } });
  expect(created.response.status, created.text).toBe(201);
  return text(record(record(created.body, "org").organization, "organization").id, `${organizationName} id`);
}

/** Session id and stored active organization for a session cookie (token part only, before the signature). */
async function sessionOf(world: World, cookie: string): Promise<{ id: string; activeOrganizationId: string | null; token: string }> {
  const value = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
  const token = value.split(".")[0] ?? value;
  world.secrets.add(token);
  world.secrets.add(value);
  const [row] = await sql(world, "SELECT id, active_organization_id FROM session WHERE token = ?", [token]);
  return { id: text(row?.id, "session id"), activeOrganizationId: optionalText(row?.active_organization_id), token };
}

async function signInCookie(world: World, email: string, password: string): Promise<string> {
  const result = await cookieCall(world.den, "/api/auth/sign-in/email", null, { email, password });
  expect(result.status, result.text).toBe(200);
  return text(result.cookie, "session cookie");
}

let booted: Promise<World> | null = null;
const owned = new AsyncDisposableStack();
afterAll(async () => {
  await owned.disposeAsync();
}, 60_000);

function world(place: Place): Promise<World> {
  booted ??= (async () => {
    const stamp = `${Date.now().toString(36)}${process.pid.toString(36)}`;
    const organizationName = `Audit sessions ${stamp}`;
    const den = owned.use(await server({
      place,
      web: false,
      org: {
        name: organizationName,
        admin: { name: "Audit Session Admin", email: `audit-session-admin+${stamp}@example.test` },
        members: {
          member: { name: "Audit Session Member", email: `audit-session-member+${stamp}@example.test` },
          leaver: { name: "Audit Session Leaver", email: `audit-session-leaver+${stamp}@example.test` },
        },
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
    const leaver = den.members.leaver;
    if (!member || !leaver) throw new Error("Expected the synthetic member sessions");
    const orgA = await organizationIdNamed(admin, organizationName);
    // The admin owns two more organizations: B flagged, C never flagged.
    const orgB = await createOrganization(den, admin, `Audit sessions B ${stamp}`);
    const orgC = await createOrganization(den, admin, `Audit sessions C ${stamp}`);
    await setAuditFlag(den, admin, orgA, true);
    await setAuditFlag(den, admin, orgB, true);
    const secrets = new Set([admin.token, member.token, leaver.token, admin.password, member.password, leaver.password]);
    return {
      den, dbUrl, stamp, orgA, orgB, orgC, admin, member, leaver, secrets,
      adminA: await memberIdentity(den, admin, orgA, admin.email),
      adminB: await memberIdentity(den, admin, orgB, admin.email),
      memberA: await memberIdentity(den, admin, orgA, member.email),
      leaverA: await memberIdentity(den, admin, orgA, leaver.email),
    };
  })();
  return booted;
}

const state: { adminCookie: string; adminSessionId: string; adminPassword: string; failedStatus: number; failedBody: unknown } = {
  adminCookie: "", adminSessionId: "", adminPassword: "", failedStatus: 0, failedBody: null,
};

test.skipIf(skip)(name("1. a password sign-in records session.created in the session's organization, or every flagged membership when it has none, never with the token"), LONG, async ({ evidence, place }) => {
  const w = await world(place);
  const markA = await watermark(w, w.orgA);
  const markB = await watermark(w, w.orgB);
  const cookie = await signInCookie(w, w.member.email, w.member.password);
  const session = await sessionOf(w, cookie);
  expect(session.activeOrganizationId, "a single-membership session starts in that organization").toBe(w.orgA);
  const created = (await pollEvents(w, w.orgA, markA, "session.created")).filter((event) => targets(event, "session", session.id));
  expect(created.map((event) => event.action), summary(created)).toEqual(["session.created"]);
  const [event] = created;
  if (!event) throw new Error("missing session.created");
  expect(event.category).toBe("change");
  expect(event.outcome).toBe("succeeded");
  expect(event.actor).toEqual({ type: "user", id: w.memberA.userId, memberId: w.memberA.memberId });
  expect(event.operation).toMatchObject({ kind: "session.lifecycle", origin: "api" });
  expect(event.requestId).toMatch(/^req_/);
  expect(event.resources).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "session", id: session.id, relationship: "target" }),
    expect.objectContaining({ type: "member", id: w.memberA.memberId, relationship: "related" }),
    expect.objectContaining({ type: "organization", id: w.orgA, relationship: "parent" }),
  ]));
  expect(record(event.changes?.after, "after")).toEqual({ method: "password", expiresAt: expect.any(String) });
  expect(event.raw.includes(session.token)).toBe(false);

  // A user with several memberships starts without an organization: the session
  // can act in all of them, so session.created fans out to every flagged membership.
  const adminCookie = await signInCookie(w, w.admin.email, w.admin.password);
  const adminSession = await sessionOf(w, adminCookie);
  state.adminCookie = adminCookie;
  state.adminSessionId = adminSession.id;
  state.adminPassword = w.admin.password;
  expect(adminSession.activeOrganizationId).toBeNull();
  const adminInA = (await pollEvents(w, w.orgA, markA, "session.created", 2)).filter((entry) => targets(entry, "session", adminSession.id));
  const adminInB = (await pollEvents(w, w.orgB, markB, "session.created")).filter((entry) => targets(entry, "session", adminSession.id));
  expect(adminInA.map((entry) => entry.action), summary(adminInA)).toEqual(["session.created"]);
  expect(adminInB.map((entry) => entry.action), summary(adminInB)).toEqual(["session.created"]);
  expect(adminInA[0]?.actor).toEqual({ type: "user", id: w.adminA.userId, memberId: w.adminA.memberId });
  expect(adminInB[0]?.actor).toEqual({ type: "user", id: w.adminB.userId, memberId: w.adminB.memberId });
  expect(adminInB[0]?.requestId).toBe(adminInA[0]?.requestId);
  expect(adminInB[0]?.operationId).not.toBe(adminInA[0]?.operationId);
  expect(record(adminInB[0]?.changes?.after, "after")).toEqual({ method: "password", expiresAt: expect.any(String) });
  expect(adminInB[0]?.raw.includes(adminSession.token)).toBe(false);
  expect(await envelopeRows(w, w.orgC), "unflagged C stores nothing").toBe(0);
  evidence.recordAssertionEvidence(
    "Signing in records session.created (method password, expiresAt) in the session's organization with the user/member actor, the session id as target and no token; a multi-membership session without an organization fans session.created out to every flagged membership (own operation each, shared request id) and nothing to unflagged C",
    `A: ${summary(created)} actor=${JSON.stringify(event.actor)} after=${JSON.stringify(event.changes?.after)}; admin session ${adminSession.id} active=${String(adminSession.activeOrganizationId)} → A: ${summary(adminInA)} B: ${summary(adminInB)} request=${adminInA[0]?.requestId}; C envelope rows=0`,
    true,
  );
});

test.skipIf(skip)(name("2. switching the active organization records session.organization_entered only in the destination"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const markA = await watermark(w, w.orgA);
  const markB = await watermark(w, w.orgB);
  const toA = await call(w.den, "/v1/me/active-organization", { method: "POST", headers: { cookie: state.adminCookie }, body: { organizationId: w.orgA } });
  expect(toA.response.status, toA.text).toBe(200);
  const enteredA = (await pollEvents(w, w.orgA, markA, "session.organization_entered")).filter((event) => targets(event, "session", state.adminSessionId));
  expect(enteredA.map((event) => event.action), summary(enteredA)).toEqual(["session.organization_entered"]);
  expect(enteredA[0]?.actor).toEqual({ type: "user", id: w.adminA.userId, memberId: w.adminA.memberId });
  expect(enteredA[0]?.changes).toEqual({ before: null, after: { via: "active_organization" }, changedFields: ["via"] });
  expect((await tenantEvents(w, w.orgB, markB)).filter((event) => event.action === "session.organization_entered")).toEqual([]);

  const markA2 = await watermark(w, w.orgA);
  const toB = await call(w.den, "/v1/me/active-organization", { method: "POST", headers: { cookie: state.adminCookie }, body: { organizationId: w.orgB } });
  expect(toB.response.status, toB.text).toBe(200);
  const enteredB = await pollEvents(w, w.orgB, markB, "session.organization_entered");
  expect(enteredB.map((event) => event.action), summary(enteredB)).toEqual(["session.organization_entered"]);
  expect(enteredB[0]?.actor).toEqual({ type: "user", id: w.adminB.userId, memberId: w.adminB.memberId });
  expect(enteredB[0]?.raw.includes(w.orgA), "the destination never learns the previous organization").toBe(false);
  expect((await tenantEvents(w, w.orgA, markA2)).filter((event) => event.action === "session.organization_entered")).toEqual([]);

  // better-auth organization/set-active is tenant-attributed: the change event joins its request operation.
  const markB2 = await watermark(w, w.orgB);
  const setActive = await cookieCall(w.den, "/api/auth/organization/set-active", state.adminCookie, { organizationId: w.orgA });
  expect(setActive.status, setActive.text).toBe(200);
  const viaAuth = (await tenantEvents(w, w.orgA, markA2)).filter((event) => event.action.startsWith("auth.organization.active.set.") || event.action === "session.organization_entered");
  expect(viaAuth.map((event) => event.action), summary(viaAuth)).toEqual(["auth.organization.active.set.requested", "session.organization_entered", "auth.organization.active.set.succeeded"]);
  expect(new Set(viaAuth.map((event) => event.operationId)).size).toBe(1);
  expect((await tenantEvents(w, w.orgB, markB2)).filter((event) => event.action === "session.organization_entered")).toEqual([]);
  expect(await envelopeRows(w, w.orgC)).toBe(0);
  evidence.recordAssertionEvidence(
    "POST /v1/me/active-organization and better-auth organization/set-active record session.organization_entered only in the destination organization, without the previous organization id; set-active shares its request operation",
    `→A: ${summary(enteredA)}; →B: ${summary(enteredB)} (B event mentions A: ${enteredB[0]?.raw.includes(w.orgA)}); set-active →A: ${summary(viaAuth)}`,
    true,
  );
});

test.skipIf(skip)(name("3. a desktop handoff records desktop_handoff.created and session.handed_off in the session's organization, never a second session.created"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const markA = await watermark(w, w.orgA);
  const markB = await watermark(w, w.orgB);
  const grant = await call(w.den, "/v1/auth/desktop-handoff", { method: "POST", headers: { cookie: state.adminCookie }, body: {} });
  expect(grant.response.status, grant.text).toBe(200);
  const grantValue = text(record(grant.body, "grant").grant, "grant");
  w.secrets.add(grantValue);
  const createdOperation = (await pollEvents(w, w.orgA, markA, "desktop_handoff.created"))[0]?.operationId;
  const createEvents = (await tenantEvents(w, w.orgA, markA)).filter((event) => event.operationId === createdOperation);
  expect(createEvents.map((event) => event.action), summary(createEvents)).toEqual(["auth.desktop_handoff.create.requested", "desktop_handoff.created", "auth.desktop_handoff.create.succeeded"]);
  const handoffCreated = createEvents[1];
  expect(handoffCreated?.actor).toEqual({ type: "user", id: w.adminA.userId, memberId: w.adminA.memberId });
  expect(targets(handoffCreated, "session", state.adminSessionId)).toBe(true);
  expect(record(handoffCreated?.changes?.after, "after")).toEqual({ expiresAt: expect.any(String), returnUrlApproved: false });

  const exchanged = await call(w.den, "/v1/auth/desktop-handoff/exchange", { method: "POST", body: { grant: grantValue } });
  expect(exchanged.response.status, exchanged.text).toBe(200);
  const handedOff = (await pollEvents(w, w.orgA, markA, "session.handed_off")).filter((event) => targets(event, "session", state.adminSessionId));
  expect(handedOff.map((event) => event.action), summary(handedOff)).toEqual(["session.handed_off"]);
  expect(record(handedOff[0]?.changes?.after, "after")).toEqual({ method: "desktop_handoff", expiresAt: expect.any(String) });
  expect(handedOff[0]?.actor).toEqual({ type: "user", id: w.adminA.userId, memberId: w.adminA.memberId });
  const secondCreated = [...await tenantEvents(w, w.orgA, markA), ...await tenantEvents(w, w.orgB, markB)].filter((event) => event.action === "session.created" && targets(event, "session", state.adminSessionId));
  expect(summary(secondCreated), "the handed-over session already exists: no second session.created").toBe("(none)");
  const inB = (await tenantEvents(w, w.orgB, markB)).filter((event) => event.action.startsWith("session.") || event.action.startsWith("desktop_handoff."));
  expect(summary(inB), "the admin is a member of flagged B, but the session is in A").toBe("(none)");
  const audit = await allAuditText(w);
  expect(audit.includes(grantValue), "grant stored").toBe(false);
  evidence.recordAssertionEvidence(
    "Creating a desktop handoff grant is attributed to the session's organization A (requested → desktop_handoff.created → succeeded, one operation, target the session, no grant); exchanging it records session.handed_off (method desktop_handoff) in A, no second session.created for the same session id anywhere, and nothing in flagged B",
    `create: ${summary(createEvents)}; exchange: ${summary(handedOff)}; second session.created: ${summary(secondCreated)}; B: ${summary(inB)}; grant stored=false`,
    true,
  );
});

test.skipIf(skip)(name("4. a password change fans account.password_changed out to every flagged membership and nothing to an unflagged one"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const markA = await watermark(w, w.orgA);
  const markB = await watermark(w, w.orgB);
  const newPassword = `Audit-Changed-${w.stamp}-1!`;
  w.secrets.add(newPassword);
  const changed = await cookieCall(w.den, "/api/auth/change-password", state.adminCookie, { currentPassword: state.adminPassword, newPassword });
  expect(changed.status, changed.text).toBe(200);
  state.adminPassword = newPassword;
  const inA = await pollEvents(w, w.orgA, markA, "account.password_changed");
  const inB = await pollEvents(w, w.orgB, markB, "account.password_changed");
  expect(inA.map((event) => event.action), summary(inA)).toEqual(["account.password_changed"]);
  expect(inB.map((event) => event.action), summary(inB)).toEqual(["account.password_changed"]);
  expect(inA[0]?.actor).toEqual({ type: "user", id: w.adminA.userId, memberId: w.adminA.memberId });
  expect(inB[0]?.actor).toEqual({ type: "user", id: w.adminB.userId, memberId: w.adminB.memberId });
  expect(inA[0]?.requestId).toMatch(/^req_/);
  expect(inB[0]?.requestId).toBe(inA[0]?.requestId);
  expect(inA[0]?.operationId).not.toBe(inB[0]?.operationId);
  expect(inA[0]?.changes).toEqual({ before: null, after: { method: "change_password" }, changedFields: ["method", "password"] });
  expect(targets(inB[0], "user", w.adminB.userId)).toBe(true);
  expect(await envelopeRows(w, w.orgC)).toBe(0);
  evidence.recordAssertionEvidence(
    "POST /api/auth/change-password records account.password_changed (method only) in flagged organizations A and B, each with its own operation and member actor and the same request id; unflagged C stores nothing",
    `A: ${summary(inA)} actor=${JSON.stringify(inA[0]?.actor)}; B: ${summary(inB)} actor=${JSON.stringify(inB[0]?.actor)}; request=${inA[0]?.requestId}; C envelope rows=0`,
    true,
  );
});

test.skipIf(skip)(name("5. a failed password sign-in for an existing member records session.sign_in_failed in each flagged organization without the attempt"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const markA = await watermark(w, w.orgA);
  const markB = await watermark(w, w.orgB);
  const wrongPassword = `Audit-Wrong-Guess-${w.stamp}`;
  w.secrets.add(wrongPassword);
  const failed = await cookieCall(w.den, "/api/auth/sign-in/email", null, { email: w.admin.email, password: wrongPassword });
  expect(failed.status, failed.text).toBe(401);
  state.failedStatus = failed.status;
  state.failedBody = failed.body;
  const inA = await pollEvents(w, w.orgA, markA, "session.sign_in_failed");
  const inB = await pollEvents(w, w.orgB, markB, "session.sign_in_failed");
  expect(inA.map((event) => event.action), summary(inA)).toEqual(["session.sign_in_failed"]);
  expect(inB.map((event) => event.action), summary(inB)).toEqual(["session.sign_in_failed"]);
  for (const { event, identity, orgId } of [{ event: inA[0], identity: w.adminA, orgId: w.orgA }, { event: inB[0], identity: w.adminB, orgId: w.orgB }]) {
    if (!event) throw new Error("missing session.sign_in_failed");
    expect(event.actor).toEqual({ type: "unknown", id: null });
    expect(event.category).toBe("security");
    expect(event.outcome).toBe("denied");
    expect(event.reasonCode).toBe("invalid_credentials");
    expect(event.changes).toEqual({ before: null, after: { method: "password" }, changedFields: [] });
    expect(event.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "user", id: identity.userId, relationship: "target" }),
      expect.objectContaining({ type: "member", id: identity.memberId, relationship: "related" }),
      expect.objectContaining({ type: "organization", id: orgId, relationship: "parent" }),
    ]));
  }
  const platform = await sql(w, "SELECT request_id, status, actor_type FROM platform_audit_event WHERE route = '/api/auth/sign-in/email' AND request_id = ?", [inA[0]?.requestId ?? ""]);
  expect(platform).toEqual([{ request_id: inA[0]?.requestId, status: 401, actor_type: "unknown" }]);
  expect(await envelopeRows(w, w.orgC)).toBe(0);
  const audit = await allAuditText(w);
  const leakedPassword = audit.includes(wrongPassword);
  const leakedEmail = audit.toLowerCase().includes(w.admin.email.toLowerCase());
  expect(leakedPassword, "attempted password stored").toBe(false);
  expect(leakedEmail, "submitted email stored").toBe(false);
  evidence.recordAssertionEvidence(
    "A wrong password for an existing member answers 401 as before and records session.sign_in_failed (security, denied, invalid_credentials, actor unknown, target user) in flagged A and B; the platform row shares the request id; neither the attempted password nor the email is stored",
    `A: ${summary(inA)}; B: ${summary(inB)}; platform=${JSON.stringify(platform)}; password stored=${leakedPassword}; email stored=${leakedEmail}`,
    true,
  );
});

test.skipIf(skip)(name("6. a failed sign-in for an unknown email records nothing in any organization and answers exactly like a failed sign-in"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const before = { a: await watermark(w, w.orgA), b: await watermark(w, w.orgB), c: await envelopeRows(w, w.orgC) };
  const unknownEmail = `audit-nobody+${w.stamp}@example.test`;
  const failed = await cookieCall(w.den, "/api/auth/sign-in/email", null, { email: unknownEmail, password: `Audit-Wrong-Guess-${w.stamp}` });
  expect(failed.status).toBe(state.failedStatus);
  expect(failed.body).toEqual(state.failedBody);
  await sleep(1_500);
  const after = { a: await watermark(w, w.orgA), b: await watermark(w, w.orgB), c: await envelopeRows(w, w.orgC) };
  expect(after).toEqual(before);
  const leaked = (await allAuditText(w)).toLowerCase().includes(unknownEmail.toLowerCase());
  expect(leaked).toBe(false);
  evidence.recordAssertionEvidence(
    "A failed sign-in for an email without an account returns the same status and body as for an existing account and appends no tenant row anywhere; the email is not stored",
    `HTTP ${failed.status} ${JSON.stringify(failed.body)} (existing account: ${state.failedStatus} ${JSON.stringify(state.failedBody)}); watermarks ${JSON.stringify(before)} → ${JSON.stringify(after)}; email stored=${leaked}`,
    true,
  );
});

test.skipIf(skip)(name("7. signing out records session.revoked in the session's organization"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const markA = await watermark(w, w.orgA);
  const markB = await watermark(w, w.orgB);
  const signedOut = await cookieCall(w.den, "/api/auth/sign-out", state.adminCookie, {});
  expect(signedOut.status, signedOut.text).toBe(200);
  const revoked = (await pollEvents(w, w.orgA, markA, "session.revoked")).filter((event) => targets(event, "session", state.adminSessionId));
  expect(revoked.map((event) => event.action), summary(revoked)).toEqual(["session.revoked"]);
  expect(revoked[0]?.reasonCode).toBe("sign_out");
  expect(revoked[0]?.actor).toEqual({ type: "user", id: w.adminA.userId, memberId: w.adminA.memberId });
  expect(revoked[0]?.changes).toEqual({ before: { expiresAt: expect.any(String) }, after: null, changedFields: ["expiresAt"] });
  expect((await tenantEvents(w, w.orgB, markB)).filter((event) => event.action === "session.revoked")).toEqual([]);
  evidence.recordAssertionEvidence(
    "POST /api/auth/sign-out records session.revoked (reasonCode sign_out) for the signed-out session in its organization A only",
    `A: ${summary(revoked)} target=${state.adminSessionId}`,
    true,
  );
});

test.skipIf(skip)(name("7b. removing a member revokes their sessions with session.revoked (member_removed) in that organization exactly once each"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const leaverCookie = await signInCookie(w, w.leaver.email, w.leaver.password);
  await sessionOf(w, leaverCookie);
  const live = await sql(w, "SELECT id FROM session WHERE user_id = ? AND expires_at > NOW(3) ORDER BY id", [w.leaverA.userId]);
  const sessionIds = live.map((row) => text(row.id, "session id"));
  expect(sessionIds.length, "fixture session plus the cookie session").toBeGreaterThanOrEqual(2);
  const markA = await watermark(w, w.orgA);
  const markB = await watermark(w, w.orgB);
  const removed = await call(w.den, `/v1/members/${w.leaverA.memberId}`, { method: "DELETE", headers: orgHeaders(w.admin, w.orgA) });
  expect(removed.response.status, removed.text).toBe(204);
  const revoked = await pollEvents(w, w.orgA, markA, "session.revoked", sessionIds.length);
  const targetIds = revoked.flatMap((event) => event.resources.filter((resource) => resource.type === "session" && resource.relationship === "target").map((resource) => String(resource.id))).sort();
  expect(targetIds, summary(revoked)).toEqual([...sessionIds].sort());
  const removal = (await tenantEvents(w, w.orgA, markA)).find((event) => event.action === "member.removed");
  for (const event of revoked) {
    expect(event.reasonCode).toBe("member_removed");
    expect(event.actor).toEqual({ type: "user", id: w.adminA.userId, memberId: w.adminA.memberId });
    expect(event.operationId, "joins the removal request operation").toBe(removal?.operationId);
    expect(event.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "member", id: w.leaverA.memberId, relationship: "related" }),
      expect.objectContaining({ type: "organization", id: w.orgA, relationship: "parent" }),
    ]));
    expect(event.changes).toEqual({ before: { expiresAt: expect.any(String) }, after: null, changedFields: ["expiresAt"] });
  }
  await sleep(500);
  const again = (await tenantEvents(w, w.orgA, markA)).filter((event) => event.action === "session.revoked");
  expect(again.length, "exactly once per session").toBe(sessionIds.length);
  expect(count(await sql(w, "SELECT COUNT(*) AS n FROM session WHERE user_id = ?", [w.leaverA.userId]))).toBe(0);
  expect((await tenantEvents(w, w.orgB, markB)).filter((event) => event.action === "session.revoked")).toEqual([]);
  evidence.recordAssertionEvidence(
    "DELETE /v1/members/:memberId deletes every session of the removed member directly (no better-auth hook) and records session.revoked (reasonCode member_removed, actor the removing admin, inside the removal request operation) exactly once per session in organization A; nothing in B",
    `sessions ${JSON.stringify(sessionIds)} → ${summary(again)} operation=${removal?.operationId}; rows left=0`,
    true,
  );
});

test.skipIf(skip)(name("8. the event-type catalog lists the user-scoped events and no session token, grant or password reached the audit tables"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const catalog = await call(w.den, "/v1/audit/event-types", { headers: orgHeaders(w.admin, w.orgA) });
  expect(catalog.response.status, catalog.text).toBe(200);
  const eventTypes = Array.isArray(record(catalog.body, "catalog").eventTypes) ? record(catalog.body, "catalog").eventTypes : [];
  const listed = Array.isArray(eventTypes) ? eventTypes.filter((entry): entry is string => typeof entry === "string") : [];
  const expected = ["session.created", "session.handed_off", "desktop_handoff.created", "session.revoked", "session.organization_entered", "session.sign_in_failed", "account.profile_updated", "account.email_changed", "account.password_changed", "account.identity_linked", "account.identity_unlinked", "account.deleted", "account.provider_token.accessed"];
  for (const eventType of expected) expect(listed, eventType).toContain(eventType);
  const audit = await allAuditText(w);
  const leaked = [...w.secrets].filter((secret) => secret.length >= 8 && audit.includes(secret));
  expect(leaked.length, "secrets found in audit tables").toBe(0);
  evidence.recordAssertionEvidence(
    "GET /v1/audit/event-types lists every user-scoped event type, and none of the session tokens, the handoff grant or the passwords used in this spec appear in audit_event, audit_event_resource, audit_operation or platform_audit_event",
    `listed ${expected.filter((eventType) => listed.includes(eventType)).length}/${expected.length}; ${w.secrets.size} secrets checked, ${leaked.length} found`,
    true,
  );
});
