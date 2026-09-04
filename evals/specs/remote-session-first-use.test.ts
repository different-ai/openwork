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

test("first cloud task provisions once over MCP, preserves access boundaries, and runs without a browser setup step", { timeout: 300_000 }, async ({ place, evidence, skip }) => {
  needs({ placement: "local" });
  if (!available) skip("needs: local MySQL and Redis");
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

  // Seed the paid entitlement, not a Stripe charge. All access checks and
  // provisioning still use the real API, subscription resolver, and database.
  await queryDenDatabase(databaseUrl,
    "INSERT INTO org_subscriptions (id, organization_id, type, status, stripe_customer_id, stripe_subscription_id, stripe_price_id, quantity) VALUES (?, ?, 'web', 'active', ?, ?, ?, 2)",
    ["osub_00000000000000000000000001", orgId, "cus_first_use_witness", "sub_first_use_witness", "price_first_use_witness"],
  );
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

  const colleague = den.members.colleague;
  if (!colleague) throw new Error("Colleague session missing");
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

  await queryDenDatabase(databaseUrl, "UPDATE org_subscriptions SET status = 'canceled' WHERE organization_id = ?", [orgId]);
  expect((await call(writeToken, "create", task)).payload.error).toBe("openwork_web_access_required");
  expect(witness.sessions).toHaveLength(1);
  expect(witness.sandboxes).toHaveLength(2);
  expect(await workers()).toHaveLength(2);
  evidence.recordAssertionEvidence("Lapsed paid access blocks new work even with an existing workspace", "After the seeded subscription was canceled, the same token was denied and session, worker, and sandbox counts remained unchanged.", true);
});
