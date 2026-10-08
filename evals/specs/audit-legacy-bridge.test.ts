import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { localMysqlIsRunning, localRedisIsRunning, queryDenDatabase, server, test } from "@openwork/testkit";
import type { Den } from "@openwork/testkit";

// Behaviour proof for den-api's single-writer legacy audit bridge
// (src/audit/domain/legacy.ts + LEGACY_ACTION_BRIDGE). An organization without
// the auditLogs rollout keeps writing legacy audit_event rows unchanged; once
// the flag is on, the same management actions append operation change events
// with allowlisted before/after snapshots inside the business transaction and
// write no legacy row. Observed over HTTP plus the disposable scratch database
// server() owns (openwork_eval_*). All identities are synthetic example.test.

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
  ? `legacy organization audit actions bridge to operation change events (skipped — ${skipReason})`
  : "an unflagged org keeps legacy audit rows while a flagged org records allowlisted change events instead, never both";

type Row = Record<string, unknown>;
type Changes = { before: Row | null; after: Row | null; changedFields: string[] };
type Envelope = { action: string; category: string; outcome: string; operationId: string; actor: Row; operation: Row; resources: Row[]; changes: Changes | null; reasonCode: string | null; raw: string };

// Keys that must never appear anywhere in change evidence (secrets, tokens,
// secret-derived hashes, free-text admin reasons).
const FORBIDDEN_KEYS = ["key", "start", "inviteToken", "scimToken", "oidcConfig", "samlConfig", "configRevision", "lastTestedRevision", "domainVerificationToken", "reason", "permission", "metadata"];

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
function changesOf(value: unknown): Changes | null {
  if (!isRecord(value)) return null;
  const before = isRecord(value.before) ? value.before : null;
  const after = isRecord(value.after) ? value.after : null;
  const changedFields = Array.isArray(value.changedFields) ? value.changedFields.filter((field): field is string => typeof field === "string") : [];
  return { before, after, changedFields };
}
function envelopeOf(value: unknown): Envelope {
  const rawText = typeof value === "string" ? value : JSON.stringify(value);
  const raw = record(typeof value === "string" ? JSON.parse(value) : value, "audit envelope");
  return {
    action: text(raw.action, "action"), category: text(raw.category, "category"), outcome: text(raw.outcome, "outcome"), operationId: text(raw.operationId, "operationId"),
    actor: record(raw.actor, "actor"), operation: record(raw.operation, "operation"), resources: Array.isArray(raw.resources) ? raw.resources.filter(isRecord) : [],
    changes: changesOf(raw.changes), reasonCode: typeof raw.reasonCode === "string" ? raw.reasonCode : null, raw: rawText,
  };
}
function summary(events: Envelope[]): string {
  return events.map((event) => event.action).join(", ") || "(none)";
}
function keysDeep(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysDeep(item, into);
  else if (isRecord(value)) for (const [key, item] of Object.entries(value)) { into.add(key); keysDeep(item, into); }
  return into;
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
async function legacyRows(dbUrl: string, orgId: string): Promise<Row[]> {
  return sql(dbUrl, "SELECT id, action, payload FROM audit_event WHERE org_id = ? AND operation_id IS NULL ORDER BY created_at, id", [orgId]);
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
async function memberIdentity(admin: DenSession, orgId: string, email: string): Promise<{ memberId: string; userId: string }> {
  const result = await denFetch(admin, "/v1/org", { headers: orgHeaders(admin, orgId) });
  expect(result.response.status, result.text).toBe(200);
  const members = isRecord(result.body) && Array.isArray(result.body.members) ? result.body.members.filter(isRecord) : [];
  const member = members.find((entry) => isRecord(entry.user) && entry.user.email === email);
  if (!member) throw new Error(`member ${email} not found in ${result.text.slice(0, 400)}`);
  return { memberId: text(member.id, "member.id"), userId: text(member.userId ?? record(member.user, "member.user").id, "member.userId") };
}

test.skipIf(skipReason !== "")(title, { timeout: 300_000 }, async ({ evidence, place }) => {
  const stamp = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const organizationName = `Audit legacy bridge ${stamp}`;
  await using den = await server({
    place,
    web: false,
    org: {
      name: organizationName,
      admin: { name: "Audit Bridge Owner", email: `audit-bridge-owner+${stamp}@example.test` },
      members: { teammate: { name: "Audit Bridge Teammate", email: `audit-bridge-teammate+${stamp}@example.test` } },
    },
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
  const teammate = den.members.teammate;
  if (!teammate) throw new Error("teammate session missing");
  const orgId = await organizationIdNamed(admin, organizationName);
  const headers = orgHeaders(admin, orgId);
  const adminHeaders = { authorization: `Bearer ${admin.token}` };

  // Permission sets (the audited replacement for custom roles) need the
  // Permissions feature; it is independent of the auditLogs rollout.
  const permissionsOn = await denFetch(admin, `/v1/admin/organizations/${orgId}/capabilities`, { method: "PUT", headers: adminHeaders, body: JSON.stringify({ capabilities: { permissions: true } }) });
  expect(permissionsOn.response.status, permissionsOn.text).toBe(200);
  // Organization API keys are the owner's by default (they used to need
  // super-admin). Step 4 has an admin teammate hold one, so the owner lets
  // admins manage API keys before audit capture starts.
  const sets = await denFetch(admin, "/v1/permissions/sets", { headers });
  expect(sets.response.status, sets.text).toBe(200);
  const setList = record(sets.body, "permission sets response").sets;
  const adminSetId = text((Array.isArray(setList) ? setList : []).map((entry) => record(entry, "permission set")).find((entry) => entry.kind === "admin_default")?.id, "Admin permissions id");
  const adminKeys = await denFetch(admin, `/v1/permissions/sets/${adminSetId}/permissions`, { method: "PUT", headers, body: JSON.stringify({ changes: [{ key: "api_keys.manage", status: "allow" }] }) });
  expect(adminKeys.response.status, adminKeys.text).toBe(200);
  const createTeam = async (name: string) => {
    const created = await denFetch(admin, "/v1/teams", { method: "POST", headers, body: JSON.stringify({ name, memberIds: [] }) });
    expect(created.response.status, created.text).toBe(201);
    return text(record(record(created.body, "team response").team, "team").id, `team ${name}`);
  };

  // 1. Unflagged: legacy rows exactly as before, no operation evidence at all.
  const legacyTeamId = await createTeam(`Legacy reviewers ${stamp}`);
  const legacySet = await denFetch(admin, "/v1/permissions/sets", { method: "POST", headers, body: JSON.stringify({ teamId: legacyTeamId, permissions: [{ key: "teams.view", status: "allow" }] }) });
  expect(legacySet.response.status, legacySet.text).toBe(201);
  const legacyDpa = await denFetch(admin, `/v1/admin/organizations/${orgId}/dpa`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ dpaSigned: false, reason: "Synthetic unsigned agreement" }) });
  expect(legacyDpa.response.status, legacyDpa.text).toBe(200);
  const unflaggedLegacy = await legacyRows(dbUrl, orgId);
  const unflaggedOperations = await sql(dbUrl, "SELECT COUNT(*) AS n FROM audit_event WHERE org_id = ? AND operation_id IS NOT NULL", [orgId]);
  const legacyActions = unflaggedLegacy.map((row) => String(row.action));
  const dpaPayload = unflaggedLegacy.find((row) => row.action === "organization.dpa_signed.updated")?.payload;
  const dpaPayloadRecord = record(typeof dpaPayload === "string" ? JSON.parse(dpaPayload) : dpaPayload, "legacy DPA payload");
  expect(legacyActions).toEqual(expect.arrayContaining(["organization.permission_set.created", "organization.dpa_signed.updated"]));
  expect(dpaPayloadRecord).toEqual({ previousDpaSigned: null, dpaSigned: false, reason: "Synthetic unsigned agreement" });
  expect(Number(unflaggedOperations[0]?.n ?? -1)).toBe(0);
  evidence.recordAssertionEvidence(
    "1. Without the auditLogs rollout the legacy audit_event rows are written unchanged",
    `Legacy rows: ${legacyActions.join(", ")}; DPA payload ${JSON.stringify(dpaPayloadRecord)}; operation-bound audit rows: ${String(unflaggedOperations[0]?.n)}.`,
    legacyActions.includes("organization.permission_set.created") && Number(unflaggedOperations[0]?.n) === 0,
  );

  const enabled = await denFetch(admin, `/v1/admin/organizations/${orgId}/capabilities`, { method: "PUT", headers: adminHeaders, body: JSON.stringify({ capabilities: { auditLogs: true } }) });
  expect(enabled.response.status, enabled.text).toBe(200);
  const legacyBefore = (await legacyRows(dbUrl, orgId)).length;
  const start = await watermark(dbUrl, orgId);
  const secrets: string[] = [];

  // 2. Team permission set: create, change permissions, archive (custom roles were removed).
  const reviewersTeamName = `Audit reviewers ${stamp}`;
  const reviewersTeamId = await createTeam(reviewersTeamName);
  const setName = `${reviewersTeamName} Permissions`;
  const created = await denFetch(admin, "/v1/permissions/sets", { method: "POST", headers, body: JSON.stringify({ teamId: reviewersTeamId, permissions: [{ key: "teams.view", status: "allow" }] }) });
  expect(created.response.status, created.text).toBe(201);
  const createdSetId = text(record(record(created.body, "permission set response").set, "permission set").id, "permission set id");
  const updated = await denFetch(admin, `/v1/permissions/sets/${createdSetId}/permissions`, { method: "PUT", headers, body: JSON.stringify({ changes: [{ key: "api_keys.view", status: "allow" }, { key: "teams.view", status: "deny" }] }) });
  expect(updated.response.status, updated.text).toBe(200);
  const deleted = await denFetch(admin, `/v1/permissions/sets/${createdSetId}`, { method: "DELETE", headers });
  expect(deleted.response.status, deleted.text).toBe(204);

  // 3. Invitation create + cancel (placeholder member removal joins the same operation).
  const inviteEmail = `audit-bridge-invitee+${stamp}@example.test`;
  const invited = await denFetch(admin, "/v1/invitations", { method: "POST", headers, body: JSON.stringify({ email: inviteEmail, role: "member" }) });
  expect([201, 502], invited.text).toContain(invited.response.status);
  const invitation = record(invited.body, "invitation response");
  const invitationId = text(invitation.invitationId, "invitationId");
  if (typeof invitation.inviteToken === "string") secrets.push(invitation.inviteToken);
  const canceled = await denFetch(admin, `/v1/invitations/${invitationId}/cancel`, { method: "POST", headers });
  expect(canceled.response.status, canceled.text).toBe(200);

  // 4. Member role changes; the teammate's own key is implicitly revoked on the downgrade.
  const teammateMemberId = (await memberIdentity(admin, orgId, teammate.email)).memberId;
  const promoted = await denFetch(admin, `/v1/members/${teammateMemberId}/role`, { method: "POST", headers, body: JSON.stringify({ role: "admin" }) });
  expect(promoted.response.status, promoted.text).toBe(200);
  const unchanged = await denFetch(admin, `/v1/members/${teammateMemberId}/role`, { method: "POST", headers, body: JSON.stringify({ role: "admin" }) });
  expect(unchanged.response.status, unchanged.text).toBe(200);
  const teammateKey = await denFetch(teammate, "/v1/api-keys", { method: "POST", headers: orgHeaders(teammate, orgId), body: JSON.stringify({ name: `Teammate key ${stamp}` }) });
  expect(teammateKey.response.status, teammateKey.text).toBe(201);
  const teammateKeyBody = record(teammateKey.body, "teammate key response");
  secrets.push(text(teammateKeyBody.key, "teammate plaintext key"));
  const teammateKeyId = text(record(teammateKeyBody.apiKey, "teammate apiKey").id, "teammate key id");
  const demoted = await denFetch(admin, `/v1/members/${teammateMemberId}/role`, { method: "POST", headers, body: JSON.stringify({ role: "member" }) });
  expect(demoted.response.status, demoted.text).toBe(200);

  // 5. Owner API key create + delete.
  const ownerKey = await denFetch(admin, "/v1/api-keys", { method: "POST", headers, body: JSON.stringify({ name: `Owner key ${stamp}` }) });
  expect(ownerKey.response.status, ownerKey.text).toBe(201);
  const ownerKeyBody = record(ownerKey.body, "owner key response");
  secrets.push(text(ownerKeyBody.key, "owner plaintext key"));
  const ownerKeyId = text(record(ownerKeyBody.apiKey, "owner apiKey").id, "owner key id");
  const keyDeleted = await denFetch(admin, `/v1/api-keys/${ownerKeyId}`, { method: "DELETE", headers });
  expect(keyDeleted.response.status, keyDeleted.text).toBe(204);

  // 6. Web origin approve + remove.
  const origin = `https://audit-bridge-${stamp}.example.test`;
  const approved = await denFetch(admin, "/v1/org/web-origins", { method: "POST", headers, body: JSON.stringify({ origin }) });
  expect(approved.response.status, approved.text).toBe(201);
  const webOriginId = text(record(approved.body, "web origin response").id, "web origin id");
  const removedOrigin = await denFetch(admin, `/v1/org/web-origins/${webOriginId}`, { method: "DELETE", headers });
  expect(removedOrigin.response.status, removedOrigin.text).toBe(204);

  // 7. Platform-admin DPA toggle (origin platform_admin, reason never stored).
  const dpa = await denFetch(admin, `/v1/admin/organizations/${orgId}/dpa`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ dpaSigned: true, reason: "Synthetic signed agreement on file" }) });
  expect(dpa.response.status, dpa.text).toBe(200);

  // 8. Member removal.
  const removedMember = await denFetch(admin, `/v1/members/${teammateMemberId}`, { method: "DELETE", headers });
  expect(removedMember.response.status, removedMember.text).toBe(204);

  const events = await eventsAfter(dbUrl, orgId, start);
  const changeEvents = events.filter((event) => event.changes !== null);
  const byAction = (action: string) => changeEvents.filter((event) => event.action === action);
  const one = (action: string): Envelope => {
    const matches = byAction(action);
    expect(matches.map((event) => event.action), `${action} in ${summary(changeEvents)}`).toEqual([action]);
    const [event] = matches;
    if (!event) throw new Error(`missing ${action}`);
    return event;
  };

  const setCreated = one("permission_set.created");
  const setChanged = one("permission_set.permissions_changed");
  const setArchived = one("permission_set.archived");
  expect(setCreated.changes).toMatchObject({ before: null, after: { id: createdSetId, name: setName, kind: "team", teamId: reviewersTeamId, allowed: ["teams.view"], archivedAt: null } });
  expect(setChanged.changes?.before).toMatchObject({ id: createdSetId, allowed: ["teams.view"] });
  expect(setChanged.changes?.after).toMatchObject({ id: createdSetId, allowed: ["api_keys.view"] });
  expect(setChanged.changes?.changedFields).toEqual(["allowed"]);
  expect(setArchived.changes?.before).toMatchObject({ id: createdSetId, archivedAt: null });
  expect(typeof setArchived.changes?.after?.archivedAt).toBe("string");
  expect(setArchived.changes?.changedFields).toEqual(["archivedAt"]);
  expect(setCreated.resources).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "permission_set", id: createdSetId, relationship: "target" }),
    expect.objectContaining({ type: "team", id: reviewersTeamId }),
    expect.objectContaining({ type: "organization", id: orgId, relationship: "parent" }),
  ]));
  evidence.recordAssertionEvidence(
    "2. Team permission set create, change and archive append permission_set.* change events with before/after snapshots",
    `permission_set.created after=${JSON.stringify(setCreated.changes?.after)}; permission_set.permissions_changed allowed ${JSON.stringify(setChanged.changes?.before?.allowed)} → ${JSON.stringify(setChanged.changes?.after?.allowed)}; permission_set.archived changedFields=${JSON.stringify(setArchived.changes?.changedFields)}.`,
    setCreated.changes?.before === null && setArchived.changes?.changedFields.includes("archivedAt") === true,
  );

  const invitationCreated = one("invitation.created");
  const invitationCanceled = one("invitation.canceled");
  const placeholderRemoved = changeEvents.filter((event) => event.action === "member.removed" && event.operationId === invitationCanceled.operationId);
  expect(invitationCreated.changes).toMatchObject({ before: null, after: { id: invitationId, email: inviteEmail, role: "member", status: "pending" } });
  expect(invitationCanceled.changes).toMatchObject({ before: { status: "pending" }, after: { status: "canceled" }, changedFields: ["status"] });
  expect(placeholderRemoved).toHaveLength(1);
  evidence.recordAssertionEvidence(
    "3. Invitation create/cancel append invitation.* events; the placeholder member removal shares the cancel operation",
    `invitation.created after=${JSON.stringify(invitationCreated.changes?.after)}; invitation.canceled changedFields=${JSON.stringify(invitationCanceled.changes?.changedFields)}; member.removed in the cancel operation: ${placeholderRemoved.length}.`,
    placeholderRemoved.length === 1,
  );

  const roleChanges = byAction("member.role_updated");
  expect(roleChanges.map((event) => [event.changes?.before?.role, event.changes?.after?.role])).toEqual([["member", "admin"], ["admin", "member"]]);
  const revoked = one("api_key.revoked");
  const demotion = roleChanges[1];
  expect(revoked.operationId).toBe(demotion?.operationId);
  expect(revoked.reasonCode).toBe("member_role_changed");
  expect(revoked.changes).toMatchObject({ before: { id: teammateKeyId, enabled: true }, after: { id: teammateKeyId, enabled: false }, changedFields: ["enabled"] });
  evidence.recordAssertionEvidence(
    "4. Member role changes record member.role_updated (none for the unchanged repeat) and the implicit key revocation joins the demotion",
    `member.role_updated roles=${JSON.stringify(roleChanges.map((event) => [event.changes?.before?.role, event.changes?.after?.role]))}; api_key.revoked reason=${String(revoked.reasonCode)} same operation=${String(revoked.operationId === demotion?.operationId)}.`,
    roleChanges.length === 2 && revoked.operationId === demotion?.operationId,
  );

  const keyCreated = byAction("api_key.created");
  const keyDeletedEvent = one("api_key.deleted");
  expect(keyCreated.map((event) => event.changes?.after?.id).sort()).toEqual([ownerKeyId, teammateKeyId].sort());
  expect(keyCreated.every((event) => event.changes?.before === null)).toBe(true);
  expect(keyDeletedEvent.changes).toMatchObject({ before: { id: ownerKeyId, name: `Owner key ${stamp}`, enabled: true }, after: null });
  const ownerKeyCreated = keyCreated.find((event) => event.changes?.after?.id === ownerKeyId);
  const owner = await memberIdentity(admin, orgId, admin.email);
  expect(ownerKeyCreated?.actor).toMatchObject({ type: "user", id: owner.userId, memberId: owner.memberId });
  evidence.recordAssertionEvidence(
    "5. API key create/delete append api_key.created (after-snapshot read back from the row) and api_key.deleted",
    `api_key.created ids=${JSON.stringify(keyCreated.map((event) => event.changes?.after?.id))}; api_key.deleted before.id=${String(keyDeletedEvent.changes?.before?.id)} after=${JSON.stringify(keyDeletedEvent.changes?.after)}.`,
    keyCreated.length === 2 && keyDeletedEvent.changes?.after === null,
  );

  const originApproved = one("web_origin.approved");
  const originRemoved = one("web_origin.removed");
  expect(originApproved.changes).toMatchObject({ before: null, after: { id: webOriginId, origin } });
  expect(originRemoved.changes).toMatchObject({ before: { id: webOriginId, origin }, after: null });
  const dpaEvent = one("organization.dpa_signed.updated");
  expect(dpaEvent.changes).toEqual({ before: { dpaSigned: false }, after: { dpaSigned: true, reasonProvided: true }, changedFields: ["dpaSigned"] });
  expect(dpaEvent.operation.origin).toBe("platform_admin");
  expect(dpaEvent.actor.memberId).toBeUndefined();
  const memberRemoved = changeEvents.filter((event) => event.action === "member.removed" && event.changes?.before?.id === teammateMemberId);
  expect(memberRemoved).toHaveLength(1);
  expect(memberRemoved[0]?.changes?.after).toBeNull();
  evidence.recordAssertionEvidence(
    "6. Web origins, the platform-admin DPA toggle and member removal append their change events",
    `web_origin.approved/removed ids=${String(originApproved.changes?.after?.id)}/${String(originRemoved.changes?.before?.id)}; DPA changes=${JSON.stringify(dpaEvent.changes)} origin=${String(dpaEvent.operation.origin)}; member.removed for teammate: ${memberRemoved.length}.`,
    dpaEvent.operation.origin === "platform_admin" && memberRemoved.length === 1,
  );

  // Single writer: no legacy row for any bridged action once the org is flagged.
  const legacyAfter = await legacyRows(dbUrl, orgId);
  expect(legacyAfter.length, JSON.stringify(legacyAfter.slice(legacyBefore).map((row) => row.action))).toBe(legacyBefore);
  // Allowlisted evidence: no secret field names or values anywhere in change snapshots.
  const evidenceKeys = keysDeep(changeEvents.map((event) => event.changes));
  const leakedKeys = FORBIDDEN_KEYS.filter((key) => evidenceKeys.has(key));
  const leakedValues = secrets.filter((secret) => events.some((event) => event.raw.includes(secret)));
  expect(leakedKeys).toEqual([]);
  expect(leakedValues).toEqual([]);
  evidence.recordAssertionEvidence(
    "7. A flagged org writes no legacy row and its snapshots carry no secret fields or values",
    `Legacy rows before/after flagged actions: ${legacyBefore}/${legacyAfter.length}; change events: ${summary(changeEvents)}; forbidden keys present: ${JSON.stringify(leakedKeys)}; plaintext secrets found: ${leakedValues.length} of ${secrets.length}.`,
    legacyAfter.length === legacyBefore && leakedKeys.length === 0 && leakedValues.length === 0,
  );

  // The audit API serves the same change events and lists the new actions as filterable types.
  const operationEvents = await denFetch(admin, `/v1/audit/operations/${encodeURIComponent(setChanged.operationId)}/events?limit=50`, { headers });
  expect(operationEvents.response.status, operationEvents.text).toBe(200);
  const served = isRecord(operationEvents.body) && Array.isArray(operationEvents.body.events) ? operationEvents.body.events.map(envelopeOf) : [];
  const catalog = await denFetch(admin, "/v1/audit/event-types", { headers });
  expect(catalog.response.status, catalog.text).toBe(200);
  const eventTypes = isRecord(catalog.body) && Array.isArray(catalog.body.eventTypes) ? catalog.body.eventTypes : [];
  expect(served.map((event) => event.action)).toEqual(expect.arrayContaining(["permission_set.permissions.update.requested", "permission_set.permissions_changed", "permission_set.permissions.update.succeeded"]));
  expect(eventTypes).toEqual(expect.arrayContaining(["permission_set.created", "invitation.canceled", "member.removed", "api_key.revoked", "organization.dpa_signed.updated", "web_origin.removed"]));
  evidence.recordAssertionEvidence(
    "8. GET /v1/audit serves the change event inside the request operation and catalogs the bridged actions",
    `Operation ${setChanged.operationId} events: ${summary(served)}; catalog has ${eventTypes.length} event types including the bridged change actions.`,
    served.some((event) => event.action === "permission_set.permissions_changed"),
  );
});
