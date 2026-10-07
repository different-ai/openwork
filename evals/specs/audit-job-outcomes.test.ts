import { afterAll, expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenFetchResult, DenSession } from "@openwork/behaviors";
import { localMysqlIsRunning, localRedisIsRunning, queryDenDatabase, server, test } from "@openwork/testkit";
import type { Den, Place } from "@openwork/testkit";

// Behaviour proof for den-api's background job outcome audit
// (src/audit/job-capture.ts): an Automation run records exactly one
// automation_run.completed in a job operation whoever finished it, a retried
// completion callback adds nothing, and a GitHub connector sync event records
// connector_sync.completed with counts only. Observed across the public HTTP
// boundary plus the disposable scratch database server() owns. All identities
// are synthetic example.test accounts; instructions are throwaway fixtures.

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
  jobRunId: string | null;
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
    jobRunId: optionalText(raw.jobRunId),
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
const TYPEID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
function syntheticTypeId(prefix: string): string {
  let suffix = String(Math.floor(Math.random() * 8));
  for (let index = 1; index < 26; index++) suffix += TYPEID_ALPHABET[Math.floor(Math.random() * TYPEID_ALPHABET.length)];
  return `${prefix}_${suffix}`;
}

type World = { den: Den; dbUrl: string; orgId: string; admin: DenSession; adminUserId: string; adminMemberId: string; stamp: string };

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
  return (await queryDenDatabase(world.dbUrl, statement, values)).filter(isRecord);
}

async function tenantEvents(world: { dbUrl: string }, orgId: string, afterSequence = 0): Promise<Envelope[]> {
  const rows = await sql(world, "SELECT envelope FROM audit_event WHERE org_id = ? AND envelope IS NOT NULL AND sequence > ? ORDER BY sequence", [orgId, afterSequence]);
  return rows.map((row) => envelopeOf(row.envelope));
}

async function watermark(world: { dbUrl: string }, orgId: string): Promise<number> {
  const rows = await sql(world, "SELECT COALESCE(MAX(sequence), 0) AS n FROM audit_event WHERE org_id = ? AND envelope IS NOT NULL", [orgId]);
  return Number(rows[0]?.n ?? 0);
}

async function eventsFor(world: { dbUrl: string }, orgId: string, resourceId: string): Promise<Envelope[]> {
  return (await tenantEvents(world, orgId)).filter((event) => event.resources.some((resource) => resource.id === resourceId));
}

async function organizationIdNamed(session: DenSession, organizationName: string): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", { headers: { authorization: `Bearer ${session.token}` } });
  const orgs = isRecord(result.body) && Array.isArray(result.body.orgs) ? result.body.orgs.filter(isRecord) : [];
  return text(orgs.find((entry) => entry.name === organizationName)?.id, `organization ${organizationName} (HTTP ${result.response.status})`);
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

let booted: Promise<World> | null = null;
const owned = new AsyncDisposableStack();
afterAll(async () => {
  await owned.disposeAsync();
});

function world(place: Place): Promise<World> {
  booted ??= (async () => {
    const stamp = `${Date.now().toString(36)}${process.pid.toString(36)}`;
    const organizationName = `Audit job outcomes ${stamp}`;
    const den = owned.use(await server({
      place,
      web: false,
      org: { name: organizationName, admin: { name: "Audit Jobs Admin", email: `audit-jobs-admin+${stamp}@example.test` } },
      env: {
        DEN_AUDIT_SELF_HOSTED_ENABLED: "true",
        DEN_AUDIT_CAPTURE_ENABLED: undefined,
        DEN_AUDIT_VISIBILITY_ENABLED: undefined,
        DEN_PLAN_GATING_ENABLED: "false",
        GITHUB_SYNC_WORKER_INTERVAL_MS: "1000",
        RESEND_API_KEY: "",
        STRIPE_SECRET_KEY: "",
      },
    }));
    const dbUrl = guardedDatabaseUrl(den);
    const admin = den.admin;
    const orgId = await organizationIdNamed(admin, organizationName);
    const flagged = await call(den, `/v1/admin/organizations/${orgId}/capabilities`, { method: "PUT", headers: { authorization: `Bearer ${admin.token}` }, body: { capabilities: { auditLogs: true } } });
    expect(flagged.response.status, flagged.text).toBe(200);
    const identity = await memberIdentity(den, admin, orgId, admin.email);
    return { den, dbUrl, orgId, admin, adminUserId: identity.userId, adminMemberId: identity.memberId, stamp };
  })();
  return booted;
}

const INSTRUCTIONS_MARKER = "synthetic-audit-instructions-marker";
const SUMMARY_MARKER = "synthetic-audit-result-marker";

async function createAutomation(w: World, label: string): Promise<string> {
  const created = await call(w.den, "/v1/automations", {
    method: "POST", headers: orgHeaders(w.admin, w.orgId),
    body: {
      name: `Audit job ${label} ${w.stamp}`,
      instructions: `Produce the ${INSTRUCTIONS_MARKER} receipt.`,
      schedule: { kind: "daily", timezone: "UTC", hour: 23, minute: 59 },
      model: { providerId: "opencode", modelId: "big-pickle", variant: null },
    },
  });
  expect(created.response.status, created.text).toBeLessThan(300);
  return text(record(record(created.body, "automation response").automation, "automation").id, "automation id");
}

async function runNow(w: World, automationId: string): Promise<{ runId: string; status: string }> {
  const queued = await call(w.den, `/v1/automations/${automationId}/run`, { method: "POST", headers: orgHeaders(w.admin, w.orgId) });
  expect(queued.response.status, queued.text).toBe(202);
  const run = record(record(queued.body, "run response").run, "run");
  return { runId: text(run.id, "run id"), status: text(run.status, "run status") };
}

function completedFor(events: Envelope[], runId: string): Envelope[] {
  return events.filter((event) => event.action === "automation_run.completed" && event.jobRunId === runId);
}

test.skipIf(skip)(name("1. a manual desktop run: the start request names the run, and the runner's completion records exactly one automation_run.completed even when the callback is retried"), LONG, async ({ evidence, place }) => {
  const w = await world(place);
  const automationId = await createAutomation(w, "desktop");
  const { runId } = await runNow(w, automationId);

  // The run id exists only after the handler, so the outcome (not the intent) names it.
  const accepted = (await eventsFor(w, w.orgId, runId)).find((event) => event.action === "automation.run.start.accepted");
  if (!accepted) throw new Error("missing accepted event naming the run");
  const started = (await tenantEvents(w, w.orgId)).filter((event) => event.operationId === accepted.operationId);
  expect(started.map((event) => event.action), summary(started)).toEqual(["automation.run.start.requested", "automation.run.start.accepted"]);
  expect(accepted.resources).toEqual(expect.arrayContaining([expect.objectContaining({ type: "automation_run", id: runId })]));
  expect(accepted.requestId).toMatch(/^req_/);

  const runnerId = `audit-jobs-runner-${w.stamp}`;
  const minted = await call(w.den, "/v1/automation-runners/token", { method: "POST", headers: orgHeaders(w.admin, w.orgId), body: { runnerId, protocolVersion: 1, supportedExecutionTargets: ["desktop"], capabilities: [], appVersion: "0.0.0-audit", platform: "linux", concurrency: 1 } });
  expect(minted.response.status, minted.text).toBe(200);
  const runner = { authorization: `Bearer ${text(record(minted.body, "runner token").token, "runner token")}` };
  const claimed = await call(w.den, `/v1/automation-runs/${runId}/claim`, { method: "POST", headers: runner });
  expect(claimed.response.status, claimed.text).toBe(200);
  expect(record(record(claimed.body, "claim").assignment, "assignment").attempt).toBe(1);

  const completion = {
    attempt: 1, status: "succeeded", sessionId: "synthetic-session", workspaceId: "synthetic-workspace",
    resultSummary: `Finished with ${SUMMARY_MARKER}.`, usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 }, error: null,
  };
  const first = await call(w.den, `/v1/automation-runs/${runId}/complete`, { method: "POST", headers: runner, body: completion });
  expect(first.response.status, first.text).toBe(200);
  const retried = await call(w.den, `/v1/automation-runs/${runId}/complete`, { method: "POST", headers: runner, body: completion });
  expect(retried.response.status, retried.text).toBe(200);
  expect(record(record(retried.body, "retry").run, "run").status).toBe("succeeded");

  const events = await eventsFor(w, w.orgId, runId);
  const completed = completedFor(events, runId);
  expect(completed.map((event) => `${event.action}/${event.outcome}/${event.reasonCode}`), summary(events)).toEqual(["automation_run.completed/succeeded/succeeded"]);
  const outcome = completed[0];
  if (!outcome) throw new Error("missing completion");
  expect(outcome.category).toBe("execution");
  expect(outcome.requestId).toBeNull();
  expect(outcome.actor).toEqual({ type: "service", id: `automation-runner:${runnerId}`, memberId: w.adminMemberId });
  expect(outcome.operation).toMatchObject({ kind: "automation.run", scope: runId, origin: "api", initiatingActor: { type: "user", id: w.adminUserId, memberId: w.adminMemberId } });
  expect(outcome.resources).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "automation_run", id: runId, relationship: "target" }),
    expect.objectContaining({ type: "automation", id: automationId, relationship: "parent" }),
    expect.objectContaining({ type: "organization", id: w.orgId, relationship: "parent" }),
  ]));
  expect(outcome.operationId).not.toBe(accepted.operationId);
  const completeRequests = events.filter((event) => event.action === "automation_run.complete.succeeded");
  expect(completeRequests, summary(events)).toHaveLength(2);
  const dump = JSON.stringify(await sql(w, "SELECT envelope FROM audit_event WHERE org_id = ?", [w.orgId]));
  const leaked = dump.includes(INSTRUCTIONS_MARKER) || dump.includes(SUMMARY_MARKER);
  expect(leaked, "instructions or result summary found in audit rows").toBe(false);
  evidence.recordAssertionEvidence(
    "POST /v1/automations/:id/run records automation.run.start requested+accepted naming the run id; the runner completion appends exactly one automation_run.completed in a job operation, and a retried completion callback adds none",
    `start=${summary(started)} (run ${runId} in accepted resources); job op ${outcome.operationId} kind=${String(outcome.operation.kind)} origin=${String(outcome.operation.origin)} jobRunId=${outcome.jobRunId}; completions=${completed.length} after ${completeRequests.length} complete callbacks; actor=${JSON.stringify(outcome.actor)}; instructions/summary stored=${leaked}`,
    !leaked && completed.length === 1,
  );
});

test.skipIf(skip)(name("2. an overlapping manual run and a cancelled queued run each record one automation_run.completed with their terminal reason"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const automationId = await createAutomation(w, "overlap");
  const queued = await runNow(w, automationId);
  expect(queued.status).toBe("queued");
  const overlap = await runNow(w, automationId);
  expect(overlap.status).toBe("skipped");
  const cancelled = await call(w.den, `/v1/automation-runs/${queued.runId}/cancel`, { method: "POST", headers: orgHeaders(w.admin, w.orgId) });
  expect(cancelled.response.status, cancelled.text).toBeLessThan(300);

  const skippedEvents = completedFor(await eventsFor(w, w.orgId, overlap.runId), overlap.runId);
  expect(skippedEvents.map((event) => `${event.outcome}/${event.reasonCode}`)).toEqual(["failed/skipped"]);
  expect(skippedEvents[0]?.actor).toEqual({ type: "system", id: "den-api.automation-executor" });
  const cancelEvents = completedFor(await eventsFor(w, w.orgId, queued.runId), queued.runId);
  expect(cancelEvents.map((event) => `${event.outcome}/${event.reasonCode}`)).toEqual(["failed/cancelled"]);
  expect(cancelEvents[0]?.actor).toEqual({ type: "user", id: w.adminUserId, memberId: w.adminMemberId });
  evidence.recordAssertionEvidence(
    "A manual run skipped for overlap and a queued run cancelled by its owner each record one automation_run.completed (failed) with reason skipped / cancelled",
    `overlap ${overlap.runId}: ${summary(skippedEvents)} actor=${JSON.stringify(skippedEvents[0]?.actor)}; cancel ${queued.runId}: ${summary(cancelEvents)} actor=${JSON.stringify(cancelEvents[0]?.actor)}`,
    skippedEvents.length === 1 && cancelEvents.length === 1,
  );
});

test.skipIf(skip)(name("3. a GitHub connector sync event that fails terminally records one connector_sync.completed with status and counts only"), STEP, async ({ evidence, place }) => {
  const w = await world(place);
  const mark = await watermark(w, w.orgId);
  const eventId = syntheticTypeId("cse");
  const instanceId = syntheticTypeId("cin");
  // Synthetic queued push event whose connector instance does not exist: the
  // worker fails it terminally (not a transient error) without calling GitHub.
  await sql(w, "INSERT INTO connector_sync_event (id, organization_id, connector_instance_id, connector_type, event_type, status, attempt_count) VALUES (?, ?, ?, 'github', 'push', 'queued', 0)", [eventId, w.orgId, instanceId]);
  const deadline = Date.now() + 30_000;
  let completed: Envelope[] = [];
  while (Date.now() < deadline) {
    completed = (await tenantEvents(w, w.orgId, mark)).filter((event) => event.action === "connector_sync.completed" && event.jobRunId === eventId);
    if (completed.length) break;
    await sleep(500);
  }
  const row = (await sql(w, "SELECT status, attempt_count FROM connector_sync_event WHERE id = ?", [eventId]))[0];
  expect(row).toMatchObject({ status: "failed", attempt_count: 1 });
  await sleep(2_500);
  completed = (await tenantEvents(w, w.orgId, mark)).filter((event) => event.action === "connector_sync.completed" && event.jobRunId === eventId);
  expect(completed.map((event) => `${event.outcome}/${event.reasonCode}`)).toEqual(["failed/failed"]);
  const outcome = completed[0];
  if (!outcome) throw new Error("missing connector_sync.completed");
  expect(outcome.actor).toEqual({ type: "system", id: "den-api.github-sync" });
  expect(outcome.operation).toMatchObject({ kind: "connector.sync", scope: eventId, origin: "webhook" });
  expect(outcome.resources).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "connector_sync_event", id: eventId, relationship: "target" }),
    expect.objectContaining({ type: "connector_instance", id: instanceId, relationship: "parent" }),
  ]));
  expect(record(outcome.changes, "changes").after).toEqual({ status: "failed", attemptCount: 1, discoveredPluginCount: null, createdPluginCount: null, materializedConfigObjectCount: null });
  const leaked = outcome.raw.includes("not found");
  expect(leaked, "error message stored in the audit event").toBe(false);
  evidence.recordAssertionEvidence(
    "The GitHub sync worker's terminal failure of a sync event records exactly one connector_sync.completed (failed) in a job operation with status and counts, never the error message",
    `event ${eventId}: ${summary(completed)} op kind=${String(outcome.operation.kind)} origin=${String(outcome.operation.origin)} after=${JSON.stringify(record(outcome.changes, "changes").after)}; message stored=${leaked}`,
    completed.length === 1 && !leaked,
  );
});
