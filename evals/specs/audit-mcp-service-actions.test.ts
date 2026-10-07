import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { localMysqlIsRunning, localRedisIsRunning, queryDenDatabase, server, test } from "@openwork/testkit";
import type { Den } from "@openwork/testkit";

// Behaviour proof for den-api's service-layer audit capture of MCP tools that
// mutate organization state without re-entering an HTTP route
// (src/audit/service-actions.ts). Observed over the public HTTP/MCP boundary
// plus the disposable scratch database server() owns (openwork_eval_*). All
// identities are synthetic example.test accounts.

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
const title = skipReason
  ? `MCP direct-mutation tools are audited at the service layer (skipped — ${skipReason})`
  : "MCP tools that mutate without an HTTP route record requested + outcome for the MCP caller, and the transport records nothing";

type Row = Record<string, unknown>;
type Envelope = { action: string; outcome: string; operationId: string; actor: Row; operation: Row; resources: Row[]; http: unknown; requestId: string | null };

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
function envelopeOf(value: unknown): Envelope {
  const raw = record(typeof value === "string" ? JSON.parse(value) : value, "audit envelope");
  return {
    action: text(raw.action, "action"), outcome: text(raw.outcome, "outcome"), operationId: text(raw.operationId, "operationId"),
    actor: record(raw.actor, "actor"), operation: record(raw.operation, "operation"), resources: Array.isArray(raw.resources) ? raw.resources.filter(isRecord) : [],
    http: raw.http ?? null, requestId: typeof raw.requestId === "string" ? raw.requestId : null,
  };
}
function summary(events: Envelope[]): string {
  return events.map((event) => `${event.action}/${event.outcome}`).join(", ") || "(none)";
}

function scratchDatabaseUrl(den: Den): string {
  const url = den.database?.url;
  if (den.placement?.kind !== "local" || !url) throw new Error("This spec requires a testkit-owned local scratch database");
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || !parsed.pathname.startsWith("/openwork_eval_")) {
    throw new Error("Refusing audit SQL outside a disposable loopback openwork_eval_* database");
  }
  return url;
}

async function sql(dbUrl: string, statement: string, values: (string | number)[] = []): Promise<Row[]> {
  return (await queryDenDatabase(dbUrl, statement, values)).filter(isRecord);
}
async function watermark(dbUrl: string, orgId: string): Promise<string> {
  // Newest event id: ids are time-ordered, so "after this id" means "recorded later".
  const rows = await sql(dbUrl, "SELECT COALESCE(MAX(id), '') AS n FROM audit_event WHERE org_id = ? AND envelope IS NOT NULL", [orgId]);
  return String(rows[0]?.n ?? "");
}
async function eventsAfter(dbUrl: string, orgId: string, after: string): Promise<Envelope[]> {
  const rows = await sql(dbUrl, "SELECT envelope FROM audit_event WHERE org_id = ? AND envelope IS NOT NULL AND id > ? ORDER BY id", [orgId, after]);
  return rows.map((row) => envelopeOf(row.envelope));
}

function orgHeaders(session: DenSession, orgId: string): Record<string, string> {
  return { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId };
}

async function organizationIdNamed(session: DenSession, organizationName: string): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", { headers: { authorization: `Bearer ${session.token}` } });
  const orgs = isRecord(result.body) && Array.isArray(result.body.orgs) ? result.body.orgs.filter(isRecord) : [];
  return text(orgs.find((entry) => entry.name === organizationName)?.id, `organization ${organizationName}`);
}

async function memberIdentity(admin: DenSession, orgId: string): Promise<{ memberId: string; userId: string }> {
  const result = await denFetch(admin, "/v1/org", { headers: orgHeaders(admin, orgId) });
  expect(result.response.status, result.text).toBe(200);
  const members = isRecord(result.body) && Array.isArray(result.body.members) ? result.body.members.filter(isRecord) : [];
  const member = members.find((entry) => isRecord(entry.user) && entry.user.email === admin.email);
  if (!member) throw new Error(`Admin member not found in ${result.text.slice(0, 400)}`);
  return { memberId: text(member.id, "member.id"), userId: text(member.userId ?? record(member.user, "member.user").id, "member.userId") };
}

let rpcId = 0;
async function callTool(den: Den, token: string, name: string, args: Record<string, unknown>): Promise<Row> {
  const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
    method: "POST",
    signal: AbortSignal.timeout(60_000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`MCP tools/call ${name} failed: HTTP ${response.status} ${raw.slice(0, 500)}`);
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  const payload = record(JSON.parse(dataLine ? dataLine.slice(5) : raw), "JSON-RPC payload");
  if (payload.error) throw new Error(`MCP tools/call ${name} JSON-RPC error: ${JSON.stringify(payload.error)}`);
  return record(payload.result, `${name} result`);
}

test.skipIf(skipReason !== "")(title, { timeout: 300_000 }, async ({ evidence, place }) => {
  const stamp = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const organizationName = `Audit MCP service ${stamp}`;
  await using den = await server({
    place,
    web: false,
    org: { name: organizationName, admin: { name: "Audit MCP Admin", email: `audit-mcp-admin+${stamp}@example.test` }, members: {} },
    env: {
      DEN_AUDIT_SELF_HOSTED_ENABLED: "true",
      DEN_AUDIT_CAPTURE_ENABLED: undefined,
      DEN_PLAN_GATING_ENABLED: "false",
      RESEND_API_KEY: "",
      STRIPE_SECRET_KEY: "",
    },
  });
  const dbUrl = scratchDatabaseUrl(den);
  const admin = den.admin;
  const orgId = await organizationIdNamed(admin, organizationName);
  const enabled = await denFetch(admin, `/v1/admin/organizations/${orgId}/capabilities`, {
    method: "PUT", headers: { authorization: `Bearer ${admin.token}` }, body: JSON.stringify({ capabilities: { auditLogs: true } }),
  });
  expect(enabled.response.status, enabled.text).toBe(200);
  const identity = await memberIdentity(admin, orgId);
  const minted = await denFetch(admin, "/v1/mcp/token", { method: "POST", headers: orgHeaders(admin, orgId), body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
  expect(minted.response.status, minted.text).toBe(200);
  const token = text(record(minted.body, "mint response").token, "MCP token");

  // 1. create_skill → createPluginBundle directly (no route re-entry).
  const beforeSkill = await watermark(dbUrl, orgId);
  const created = await callTool(den, token, "create_skill", {
    pluginName: `Audit weekly report ${stamp}`,
    skillMarkdown: "---\nname: audit-weekly-report\ndescription: Summarize the week's work for the team.\n---\n\n# Weekly report\n\nSummarize this week's work in five bullet points.\n",
  });
  const createdText = JSON.stringify(created);
  expect(created.isError, createdText).not.toBe(true);
  expect(createdText).toContain("audit-weekly-report");
  const skillEvents = await eventsAfter(dbUrl, orgId, beforeSkill);
  const bundle = skillEvents.filter((event) => event.action.startsWith("plugin.bundle.create."));
  const [requested, succeeded] = bundle;
  expect(bundle.map((event) => `${event.action}/${event.outcome}`), summary(skillEvents)).toEqual(["plugin.bundle.create.requested/unknown", "plugin.bundle.create.succeeded/succeeded"]);
  if (!requested || !succeeded) throw new Error("missing plugin.bundle.create events");
  expect(succeeded.operationId).toBe(requested.operationId);
  expect(requested.operation.origin).toBe("mcp");
  expect(requested.operation.kind).toBe("plugin.configuration");
  expect(requested.actor).toMatchObject({ type: "user", id: identity.userId, memberId: identity.memberId });
  expect(String(requested.actor.credentialId)).toMatch(/^client:/);
  expect(requested.http).toBeNull();
  expect(requested.resources).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "plugin", id: "collection:plugin", relationship: "target" }),
    expect.objectContaining({ type: "organization", id: orgId, relationship: "parent" }),
  ]));
  expect(skillEvents.filter((event) => !event.action.startsWith("plugin.bundle.create.")).map((event) => event.action)).toEqual([]);
  evidence.recordAssertionEvidence(
    "1. create_skill over /mcp/agent records plugin.bundle.create requested + succeeded for the MCP caller",
    `New tenant events: ${summary(skillEvents)}; one operation ${requested.operationId}, origin=${String(requested.operation.origin)}, actor=${JSON.stringify(requested.actor)}, http=${JSON.stringify(requested.http)}.`,
    bundle.length === 2 && requested.operation.origin === "mcp" && requested.actor.memberId === identity.memberId,
  );

  // 2. Platform-admin tool through /mcp/agent: tenant = verified argument org, actor = admin without member.
  const beforeAdmin = await watermark(dbUrl, orgId);
  const adminResult = await callTool(den, token, "execute_capability", { name: "admin:den_set_org_capability", body: { organizationId: orgId, capability: "workbot", enabled: true } });
  expect(adminResult.isError, JSON.stringify(adminResult)).not.toBe(true);
  const adminEvents = (await eventsAfter(dbUrl, orgId, beforeAdmin)).filter((event) => event.action.startsWith("organization.capability.set."));
  expect(adminEvents.map((event) => `${event.action}/${event.outcome}`)).toEqual(["organization.capability.set.requested/unknown", "organization.capability.set.succeeded/succeeded"]);
  const adminRequested = adminEvents[0];
  if (!adminRequested) throw new Error("missing organization.capability.set events");
  expect(adminRequested.operation.origin).toBe("platform_admin");
  expect(adminRequested.actor).toMatchObject({ type: "user", id: identity.userId });
  expect(adminRequested.actor.memberId).toBeUndefined();
  evidence.recordAssertionEvidence(
    "2. The platform-admin capability tool records organization.capability.set with origin platform_admin",
    `Events: ${summary(adminEvents)}; origin=${String(adminRequested.operation.origin)}, actor=${JSON.stringify(adminRequested.actor)} (no memberId).`,
    adminEvents.length === 2 && adminRequested.operation.origin === "platform_admin" && adminRequested.actor.memberId === undefined,
  );

  // 3. The MCP transport itself is never recorded, in the tenant log or the platform store.
  const transportRoutes = ["/mcp", "/mcp/agent", "/mcp/agent/connections/:connectionId", "/mcp/admin"];
  const allEvents = await eventsAfter(dbUrl, orgId, "");
  const transportTenant = allEvents.filter((event) => isRecord(event.http) && transportRoutes.includes(String(event.http.route)));
  const transportPlatform = await sql(dbUrl, "SELECT route, action FROM platform_audit_event WHERE route IN (?, ?, ?, ?)", transportRoutes);
  expect(transportTenant.map((event) => event.action)).toEqual([]);
  expect(transportPlatform).toEqual([]);
  evidence.recordAssertionEvidence(
    "3. MCP transport requests record nothing",
    `${allEvents.length} tenant events in the org, ${transportTenant.length} with a transport route; ${transportPlatform.length} platform_audit_event rows for MCP transport routes.`,
    transportTenant.length === 0 && transportPlatform.length === 0,
  );

  // 4. An admin tool that turns audit off for its own organization keeps its outcome as platform evidence.
  const beforeOff = await watermark(dbUrl, orgId);
  const offResult = await callTool(den, token, "execute_capability", { name: "admin:den_set_org_capability", body: { organizationId: orgId, capability: "auditLogs", enabled: false } });
  expect(offResult.isError, JSON.stringify(offResult)).not.toBe(true);
  const offEvents = (await eventsAfter(dbUrl, orgId, beforeOff)).filter((event) => event.action.startsWith("organization.capability.set."));
  expect(offEvents.map((event) => `${event.action}/${event.outcome}`)).toEqual(["organization.capability.set.requested/unknown"]);
  const fallback = await sql(dbUrl, "SELECT method, route, action, outcome, reason_code, origin, actor_id, target_type, target_id FROM platform_audit_event WHERE route = ? AND target_id = ?", ["service:organization.capability.set", orgId]);
  expect(fallback).toEqual([{
    method: "SERVICE", route: "service:organization.capability.set", action: "organization.capability.set.succeeded", outcome: "succeeded",
    reason_code: "tenant_audit_disabled", origin: "platform_admin", actor_id: identity.userId, target_type: "organization", target_id: orgId,
  }]);
  evidence.recordAssertionEvidence(
    "4. den_set_org_capability auditLogs=false records its intent in the organization and its outcome in the platform store",
    `Tenant: ${summary(offEvents)}; platform: ${JSON.stringify(fallback)}.`,
    offEvents.length === 1 && fallback.length === 1,
  );
});
