import { expect } from "vitest";
import { denFetch, type DenSession } from "@openwork/behaviors";
import { queryDenDatabase } from "@openwork/env";
import { startCloudRuntimeWitness } from "@openwork/labs";
import { eventually, localMysqlIsRunning, localRedisIsRunning, needs, server, test } from "@openwork/testkit";

const available = await localMysqlIsRunning() && await localRedisIsRunning();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected a JSON object");
  return value;
}

async function mint(session: DenSession, scopes: string[]) {
  const result = await denFetch(session, "/v1/mcp/token", {
    method: "POST", headers: { authorization: `Bearer ${session.token}` }, body: JSON.stringify({ scopes }),
  });
  expect(result.response.status, result.text).toBe(200);
  const token = record(result.body).token;
  if (typeof token !== "string") throw new Error("MCP token missing");
  return token;
}

test("a seven-day cloud trial starts without a card, provisions the first task once, and expires without charging", { timeout: 300_000 }, async ({ place, evidence, skip }) => {
  needs({ placement: "local" });
  if (!available) skip("needs: local MySQL and Redis");
  {
    await using rolloutDisabled = await server({
      place, web: false,
      org: { name: "Cloud Trial Rollout" },
      env: { DEN_OPENWORK_WEB_ENABLED: "true", DEN_OPENWORK_CLOUD_TRIAL_ENABLED: "false" },
    });
    const headers = { authorization: `Bearer ${rolloutDisabled.admin.token}` };
    const offer = await denFetch(rolloutDisabled.admin, "/v1/billing/web-trial", { headers });
    expect(offer.response.status, offer.text).toBe(200);
    expect(record(record(offer.body).trial).status).toBe("ineligible");
    const start = await denFetch(rolloutDisabled.admin, "/v1/billing/web-trial", { method: "POST", headers });
    expect(start.response.status, start.text).toBe(409);
    expect(record(start.body).error).toBe("trial_unavailable");
    const rolloutDatabase = rolloutDisabled.database;
    if (!rolloutDatabase) throw new Error("Expected isolated rollout database");
    expect(await queryDenDatabase(rolloutDatabase.url, "SELECT organization_id FROM org_cloud_trials")).toEqual([]);
    evidence.recordAssertionEvidence("New trials stay unavailable before compatible-client rollout", "With Web enabled but the trial rollout disabled, no offer is eligible, a start returns trial_unavailable, and no trial row is created.", true);
  }
  await using witness = await startCloudRuntimeWitness();
  await using den = await server({
    place,
    web: false,
    org: { name: "Remote Task Activation", members: { colleague: {} } },
    env: {
      PROVISIONER_MODE: "daytona", DAYTONA_API_KEY: "witness-not-a-real-key", DAYTONA_API_URL: witness.url,
      DAYTONA_SNAPSHOT: "witness-snapshot", DAYTONA_SHARED_VOLUME_NAME: "witness-volume",
      DAYTONA_USE_DEPRECATED_POLLING: "true", DAYTONA_HEALTHCHECK_TIMEOUT_MS: "120000",
      WORKER_PROVISIONING_RECONCILE_INTERVAL_MS: "0", CLOUD_IDLE_LOOP_SECONDS: "0",
      DEN_OPENWORK_WEB_ENABLED: "true",
      DEN_OPENWORK_CLOUD_TRIAL_ENABLED: "true",
      OPENWORK_DEV_MODE: "1", RESEND_API_KEY: "", SMTP_HOST: "",
      OPENWORK_CLOUD_TRIAL_POLL_MS: "1000",
      STRIPE_OPENWORK_WEB_PRICE_ID: "price_first_use_witness",
    },
  });
  if (!den.database) throw new Error("This isolated HTTP journey requires its own database");
  const databaseUrl = den.database.url;
  const orgs = await denFetch(den.admin, "/v1/me/orgs", { headers: { authorization: `Bearer ${den.admin.token}` } });
  const organizations = record(orgs.body).orgs;
  if (!Array.isArray(organizations) || organizations.length !== 1) throw new Error("Expected one isolated organization");
  const orgId = record(organizations[0]).id;
  if (typeof orgId !== "string") throw new Error("Organization id missing");
  const writeToken = await mint(den.admin, ["mcp:read", "mcp:write"]);
  const readToken = await mint(den.admin, ["mcp:read"]);
  let requestId = 0;

  async function call(token: string, action: string, body: unknown) {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST", signal: AbortSignal.timeout(40_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: {
        name: "execute_capability", arguments: { name: `remote-session:${action}`, body },
      } }),
    });
    const raw = await response.text();
    expect(response.status, raw).toBe(200);
    const data = raw.split("\n").find((line) => line.startsWith("data:"));
    const rpc = record(JSON.parse(data ? data.slice(5) : raw));
    expect(rpc.error, raw).toBeUndefined();
    const result = record(rpc.result);
    expect(result.structuredContent, JSON.stringify(result)).toBeDefined();
    return { result, payload: record(result.structuredContent) };
  }

  async function workers() {
    return queryDenDatabase(databaseUrl, "SELECT id, created_by_user_id, status FROM worker WHERE org_id = ?", [orgId]);
  }

  expect((await call(writeToken, "create", {})).payload.error).toBe("openwork_web_access_required");
  expect(await workers()).toEqual([]);
  expect(witness.sandboxes).toHaveLength(0);
  evidence.recordAssertionEvidence("Paid access is checked before provisioning", "A valid write token in an organization without Web access was denied; zero worker rows and zero provider creates.", true);

  const colleague = den.members.colleague;
  if (!colleague) throw new Error("Colleague session missing");
  const trialRequest = (session: DenSession, method = "GET", scopedOrg = orgId) => denFetch(session, "/v1/billing/web-trial", {
    method, headers: { authorization: `Bearer ${session.token}`, "x-openwork-org-id": scopedOrg },
  });
  const trialRows = () => queryDenDatabase(databaseUrl,
    "SELECT organization_id, started_by_user_id, started_at, expires_at, ending_sent_at, expired_sent_at FROM org_cloud_trials WHERE organization_id = ?", [orgId]);
  const trialEmails = async () => {
    const result = await denFetch(den.admin, "/v1/dev/emails?template=cloudTrial", { headers: { authorization: `Bearer ${den.admin.token}` } });
    expect(result.response.status, result.text).toBe(200);
    const emails = record(result.body).emails;
    if (!Array.isArray(emails)) throw new Error("Expected trial email outbox");
    return emails.map(record);
  };
  const eligibility = await trialRequest(den.admin);
  expect(eligibility.response.status, eligibility.text).toBe(200);
  expect(record(record(eligibility.body).trial).status).toBe("eligible");
  expect((await trialRequest(colleague, "POST")).response.status).toBe(403);
  expect(await trialRows()).toEqual([]);
  const starts = await Promise.all(Array.from({ length: 4 }, () => trialRequest(den.admin, "POST")));
  for (const result of starts) {
    expect(result.response.status, result.text).toBe(200);
    expect(record(record(result.body).trial).status).toBe("active");
  }
  const initialTrial = record(record(starts[0]?.body).trial);
  if (typeof initialTrial.startedAt !== "string" || typeof initialTrial.expiresAt !== "string") throw new Error("Expected persisted trial timestamps");
  expect(Date.parse(initialTrial.expiresAt) - Date.parse(initialTrial.startedAt)).toBe(7 * 24 * 60 * 60 * 1000);
  for (const result of starts) expect(record(record(result.body).trial)).toEqual(initialTrial);
  expect(await trialRows()).toHaveLength(1);
  expect(record(record((await trialRequest(colleague)).body).trial)).toEqual(initialTrial);
  expect(await queryDenDatabase(databaseUrl, "SELECT id FROM org_subscriptions WHERE organization_id = ?", [orgId])).toEqual([]);
  expect(await trialEmails()).toEqual([]);
  expect(await workers()).toEqual([]);
  expect(witness.sandboxes).toHaveLength(0);
  evidence.recordAssertionEvidence("Only an administrator can start a single seven-day trial without a card or subscription", "A member was denied before writes; four concurrent administrator requests shared one persisted seven-day window, created no subscription or runtime, and exposed the same status to members.", true);

  const otherOrg = await denFetch(den.admin, "/v1/org", {
    method: "POST", headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({ name: "Trial Isolation" }),
  });
  expect(otherOrg.response.ok, otherOrg.text).toBe(true);
  const otherOrgId = record(record(otherOrg.body).organization).id;
  if (typeof otherOrgId !== "string") throw new Error("Expected second organization id");
  const repeatStarter = await trialRequest(den.admin, "POST", otherOrgId);
  expect(repeatStarter.response.status, repeatStarter.text).toBe(409);
  expect(record(repeatStarter.body).error).toBe("trial_unavailable");
  expect((await trialRequest(colleague, "POST", otherOrgId)).response.status).toBe(404);
  expect(await queryDenDatabase(databaseUrl, "SELECT organization_id FROM org_cloud_trials WHERE organization_id = ?", [otherOrgId])).toEqual([]);
  expect(record(record((await trialRequest(den.admin)).body).trial)).toEqual(initialTrial);
  const selected = await denFetch(den.admin, "/v1/me/active-organization", {
    method: "POST", headers: { authorization: `Bearer ${den.admin.token}` }, body: JSON.stringify({ organizationId: orgId }),
  });
  expect(selected.response.ok, selected.text).toBe(true);
  evidence.recordAssertionEvidence("A trial cannot be multiplied across organizations and another team's member cannot start it", "The same starter received trial_unavailable in a second organization, a member outside that organization was denied, and its trial table remained empty while the first trial retained its original dates.", true);

  expect((await call(readToken, "create", {})).payload.error).toBe("insufficient_mcp_scope");
  expect((await call(writeToken, "create", { prompt: "" })).payload.error).toBe("invalid_capability_arguments");
  expect((await call(readToken, "read", { sessionId: "ses_unknown" })).payload.error).toBe("needs_cloud_setup");
  expect((await call(writeToken, "send", { sessionId: "ses_unknown", prompt: "Continue" })).payload.error).toBe("needs_cloud_setup");
  expect(await workers()).toEqual([]);
  expect(witness.sandboxes).toHaveLength(0);
  evidence.recordAssertionEvidence("Only a valid write-scoped create can allocate a workspace", "Read-only create, invalid input, read, and send allocated no workers and made no provider creates.", true);

  const task = { title: "First cloud task", prompt: "Summarize this workspace" };
  const first = await Promise.all(Array.from({ length: 6 }, () => call(writeToken, "create", task)));
  for (const response of first) {
    expect(response.result.isError).toBe(true);
    expect(response.payload).toMatchObject({ error: "cloud_runtime_provisioning", retryable: true, retryAfterMs: 30_000 });
    expect(response.payload.sessionId).toBeUndefined();
  }
  await eventually(() => witness.sandboxes.length, { within: 20_000, label: "one provider sandbox create", until: (value) => value === 1 });
  const startedWorkers = await workers();
  expect(startedWorkers).toHaveLength(1);
  expect(witness.sandboxes).toHaveLength(1);
  expect(witness.sandboxes[0]?.workerId).toBe(record(startedWorkers[0]).id);
  expect(witness.sessions).toHaveLength(0);
  evidence.recordAssertionEvidence("Concurrent first requests share one provisioning attempt", "Six MCP create calls returned retryable provisioning with no submitted session; one worker row and one Daytona HTTP create were observed, before any browser endpoint was called.", true);

  witness.ready();
  await eventually(async () => (await workers()).map((entry) => record(entry).status), { within: 60_000, label: "real provisioner records ready after witness health", until: (statuses) => statuses.length === 1 && statuses[0] === "healthy" });
  const created = await call(writeToken, "create", task);
  expect(created.result.isError).toBeUndefined();
  expect(created.payload).toMatchObject({ target: "cloud", started: true, workerId: record(startedWorkers[0]).id });
  expect(witness.sessions).toHaveLength(1);
  expect(witness.sessions[0]?.prompts).toEqual([task.prompt]);
  expect(witness.sandboxes).toHaveLength(1);
  const browser = await denFetch(den.admin, "/v1/cloud/instance", { headers: { authorization: `Bearer ${den.admin.token}` } });
  expect(browser.response.status, browser.text).toBe(200);
  expect(record(browser.body).status).toBe("ready");
  expect(await workers()).toHaveLength(1);
  expect(witness.sandboxes).toHaveLength(1);
  evidence.recordAssertionEvidence("Retry runs the first task without browser setup, and the browser reuses its workspace", "The real provisioner observed healthy HTTP, persisted ready state, and the MCP retry created one native session with the original prompt. A subsequent browser request reused that ready workspace without another sandbox.", true);

  const colleagueToken = await mint(colleague, ["mcp:read", "mcp:write"]);
  expect((await call(colleagueToken, "create", task)).payload.error).toBe("cloud_runtime_provisioning");
  await eventually(() => witness.sandboxes.length, { within: 20_000, label: "separate member worker", until: (value) => value === 2 });
  const memberWorkers = await workers();
  expect(memberWorkers).toHaveLength(2);
  expect(new Set(memberWorkers.map((entry) => record(entry).created_by_user_id)).size).toBe(2);
  expect(new Set(witness.sandboxes.map((entry) => entry.workerId)).size).toBe(2);
  expect(witness.sessions).toHaveLength(1);
  await eventually(async () => (await workers()).map((entry) => record(entry).status), { within: 60_000, label: "both member workspaces healthy", until: (statuses) => statuses.length === 2 && statuses.every((status) => status === "healthy") });
  expect(witness.unexpected).toEqual([]);
  evidence.recordAssertionEvidence("Members get distinct workspaces", "A second member's first call created a different worker and sandbox without creating a session on the first member's runtime.", true);

  // Age only the fixture's persisted clock; access and notification processing
  // still run through the real API and background scheduler.
  await queryDenDatabase(databaseUrl,
    "UPDATE org_cloud_trials SET started_at = DATE_SUB(NOW(3), INTERVAL 6 DAY), expires_at = DATE_ADD(NOW(3), INTERVAL 12 HOUR) WHERE organization_id = ?", [orgId]);
  const ending = await eventually(trialEmails, { within: 20_000, label: "scheduled trial ending notification", until: (emails) => emails.length === 1 });
  expect(ending[0]?.to).toBe(den.admin.email);
  await eventually(trialRows, { within: 10_000, label: "durable reminder marker", until: (rows) => record(rows[0]).ending_sent_at !== null });
  expect(record(record((await trialRequest(den.admin)).body).trial).status).toBe("active");
  await queryDenDatabase(databaseUrl,
    "UPDATE org_cloud_trials SET started_at = DATE_SUB(NOW(3), INTERVAL 8 DAY), expires_at = DATE_SUB(NOW(3), INTERVAL 1 DAY) WHERE organization_id = ?", [orgId]);
  expect(record(record((await trialRequest(den.admin)).body).trial).status).toBe("expired");
  expect((await call(writeToken, "create", task)).payload.error).toBe("openwork_web_access_required");
  expect(witness.sessions).toHaveLength(1);
  expect(witness.sandboxes).toHaveLength(2);
  expect(await workers()).toHaveLength(2);
  const expired = await eventually(trialEmails, { within: 20_000, label: "scheduled trial expired notification", until: (emails) => emails.length === 2 });
  expect(expired.map((email) => email.to)).toEqual([den.admin.email, den.admin.email]);
  expect(expired.map((email) => email.subject).sort()).toEqual([
    "Your OpenWork cloud trial ends soon", "Your OpenWork cloud trial has ended",
  ].sort());
  await eventually(trialRows, { within: 10_000, label: "durable expired marker", until: (rows) => record(rows[0]).expired_sent_at !== null });
  const finalRows = await trialRows();
  const restart = await trialRequest(den.admin, "POST");
  expect(restart.response.status, restart.text).toBe(200);
  expect(record(record(restart.body).trial).status).toBe("expired");
  expect(await trialRows()).toEqual(finalRows);
  expect(await queryDenDatabase(databaseUrl, "SELECT id FROM org_subscriptions WHERE organization_id = ?", [orgId])).toEqual([]);
  // Observe more than two scheduler cycles to catch repeated delivery.
  const observedAt = Date.now();
  await eventually(async () => {
    expect(await trialEmails()).toEqual(expired);
    return Date.now() - observedAt;
  }, { within: 6_000, intervalMs: 500, label: "notification markers prevent repeated delivery", until: (elapsed) => elapsed >= 2500 });
  evidence.recordAssertionEvidence("The trial warns its owner, expires once, and blocks new work without renewing or charging", "Aged real trial timestamps produced one ending and one expired email, durable sent markers prevented repeats, repeating start retained the expired window, and existing runtime counts stayed unchanged after access denial. No subscription was created.", true);

  // A paid upgrade is a separate explicit entitlement; seed it without Stripe.
  await queryDenDatabase(databaseUrl,
    "INSERT INTO org_subscriptions (id, organization_id, type, status, stripe_customer_id, stripe_subscription_id, stripe_price_id, quantity) VALUES (?, ?, 'web', 'active', ?, ?, ?, 2)",
    ["osub_00000000000000000000000001", orgId, "cus_first_use_witness", "sub_first_use_witness", "price_first_use_witness"],
  );
  expect(record(record((await trialRequest(den.admin)).body).trial).status).toBe("ineligible");
  const upgraded = await call(writeToken, "create", task);
  expect(upgraded.result.isError).toBeUndefined();
  expect(upgraded.payload.started).toBe(true);
  expect(witness.sessions).toHaveLength(2);
  expect(witness.sandboxes).toHaveLength(2);
  await queryDenDatabase(databaseUrl, "UPDATE org_subscriptions SET status = 'canceled' WHERE organization_id = ?", [orgId]);
  expect((await call(writeToken, "create", task)).payload.error).toBe("openwork_web_access_required");
  expect(witness.sessions).toHaveLength(2);
  expect(witness.sandboxes).toHaveLength(2);
  expect(await workers()).toHaveLength(2);
  evidence.recordAssertionEvidence("An explicit paid upgrade restores access after trial expiry, and canceled paid access still blocks work", "The seeded paid entitlement reused the existing runtime for one new session; canceling it denied further work without another sandbox or session.", true);
});
