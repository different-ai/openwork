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

test("first cloud task provisions once over MCP, recovers its workspace, and preserves member access boundaries", { timeout: 300_000 }, async ({ place, evidence, skip }) => {
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

  async function instance(session = den.admin, action = "") {
    const result = await denFetch(session, `/v1/cloud/instance${action}`, {
      method: action ? "POST" : "GET", headers: { authorization: `Bearer ${session.token}` },
    });
    expect(result.response.status, result.text).toBe(200);
    return record(result.body);
  }

  async function runtimeRecord(workerId: string) {
    const rows = await queryDenDatabase(databaseUrl,
      "SELECT id, sandbox_id, workspace_volume_id, data_volume_id, signed_preview_url, signed_preview_url_expires_at FROM daytona_sandbox WHERE worker_id = ?", [workerId]);
    expect(rows).toHaveLength(1);
    return record(rows[0]);
  }

  async function bothHealthy() {
    await eventually(async () => (await workers()).map((entry) => record(entry).status), {
      within: 60_000, label: "both member workspaces healthy",
      until: (statuses) => statuses.length === 2 && statuses.every((status) => status === "healthy"),
    });
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
  // The worker's HTTP listener can be healthy before its engine has a URL.
  witness.sessionFailure({ code: "opencode_unconfigured", message: "OpenCode base URL is missing for this workspace" });
  const starting = await call(writeToken, "create", task);
  expect(starting.result.isError).toBe(true);
  expect(starting.payload).toMatchObject({ error: "cloud_runtime_waking", retryable: true, retryAfterMs: 30_000 });
  expect(starting.payload.sessionId).toBeUndefined();
  expect(witness.sessions).toHaveLength(0);
  expect(witness.sandboxes).toHaveLength(1);
  witness.sessionFailure({ code: "invalid_payload", message: "Invalid session payload" });
  const invalid = await call(writeToken, "create", task);
  expect(invalid.payload).toMatchObject({ error: "remote_session_request_failed", retryable: false });
  expect(witness.sessions).toHaveLength(0);
  witness.sessionFailure(null);
  const created = await call(writeToken, "create", task);
  expect(created.result.isError).toBeUndefined();
  expect(created.payload).toMatchObject({ target: "cloud", started: true, workerId: record(startedWorkers[0]).id });
  expect(witness.sessions).toHaveLength(1);
  expect(witness.sessions[0]?.prompts).toEqual([task.prompt]);
  expect(witness.sandboxes).toHaveLength(1);
  evidence.recordAssertionEvidence("Engine startup is retryable without duplicate sessions or reprovisioning", "A healthy worker whose session endpoint lacked its engine URL returned a 30-second retry; an unrelated 400 stayed non-retryable. Retrying after engine readiness created exactly one session and submitted the prompt once on the existing sandbox.", true);
  expect((await instance()).status).toBe("ready");
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
  await bothHealthy();
  expect(witness.unexpected).toEqual([]);
  evidence.recordAssertionEvidence("Members get distinct workspaces", "A second member's first call created a different worker and sandbox without creating a session on the first member's runtime.", true);

  const original = witness.sandboxes[0];
  const other = witness.sandboxes[1];
  const sessionId = created.payload.sessionId;
  if (!original || !other || typeof sessionId !== "string") throw new Error("First-use runtime identity missing");
  const otherTask = { title: "Colleague task", prompt: "Keep this member's workspace unchanged" };
  const otherCreated = await call(colleagueToken, "create", otherTask);
  expect(otherCreated.result.isError).toBeUndefined();
  expect((await call(colleagueToken, "send", { sessionId, prompt: "Must not reach the other member" })).payload.error).toBe("unknown_session");
  const otherInstance = await instance(colleague);
  const otherRecord = await runtimeRecord(other.workerId);
  const otherSessions = structuredClone(other.sessions);
  const otherEvents = witness.events.filter((event) => event.sandboxId === other.id);

  async function colleagueUnaffected() {
    expect(await instance(colleague)).toEqual(otherInstance);
    expect(await runtimeRecord(other.workerId)).toEqual(otherRecord);
    expect(other.sessions).toEqual(otherSessions);
    expect(witness.events.filter((event) => event.sandboxId === other.id)).toEqual(otherEvents);
    expect(other.state).toBe("started");
    expect(await workers()).toHaveLength(2);
    expect(witness.events.filter((event) => event.operation === "session-create")).toHaveLength(2);
  }

  // Arrange provider sleep and its durable observation without invoking lifecycle
  // internals. The MCP/API requests below own all recovery decisions.
  witness.sleep(original.id);
  await queryDenDatabase(databaseUrl, "UPDATE worker SET status = 'stopped' WHERE id = ?", [original.workerId]);
  const sleeping = await Promise.all(Array.from({ length: 6 }, () => call(writeToken, "send", { sessionId, prompt: "Continue after sleep" })));
  for (const response of sleeping) {
    expect(response.payload).toMatchObject({ error: "cloud_runtime_waking", retryable: true });
  }
  await eventually(() => witness.events.filter((event) => event.sandboxId === original.id && event.operation === "start").length, {
    within: 20_000, label: "same sandbox starts once", until: (count) => count === 1,
  });
  expect(original.sessions[0]?.prompts).toEqual([task.prompt]);
  witness.ready(original.id);
  await bothHealthy();
  expect((await call(writeToken, "send", { sessionId, prompt: "Continue after sleep" })).payload).toMatchObject({ sessionId, state: "accepted" });
  expect(original.sessions[0]?.prompts).toEqual([task.prompt, "Continue after sleep"]);
  expect(witness.sandboxes).toHaveLength(2);
  expect(witness.events.filter((event) => event.sandboxId === original.id && event.operation === "start")).toHaveLength(1);
  expect((await runtimeRecord(original.workerId)).sandbox_id).toBe(original.id);
  await colleagueUnaffected();
  evidence.recordAssertionEvidence("Concurrent wake resumes the same worker and session", "Six follow-ups while asleep returned retryable waking without submitting prompts. One SDK start resumed the original sandbox; retry appended exactly one prompt to the original session. No duplicate worker, sandbox, or session; the colleague's runtime and data were unchanged.", true);

  const beforeRefresh = await runtimeRecord(original.workerId);
  const beforeRefreshEvents = witness.events.length;
  witness.expireEndpoint(original.id);
  const expired = await fetch(`${beforeRefresh.signed_preview_url}/health`, { signal: AbortSignal.timeout(5_000) });
  expect(expired.status).toBe(410);
  await queryDenDatabase(databaseUrl, "UPDATE daytona_sandbox SET signed_preview_url_expires_at = '2000-01-01 00:00:00' WHERE worker_id = ?", [original.workerId]);
  const refreshed = await instance();
  const afterRefresh = await runtimeRecord(original.workerId);
  expect(refreshed).toMatchObject({ status: "ready", instanceName: original.id });
  expect(refreshed.url).not.toBe(beforeRefresh.signed_preview_url);
  expect(afterRefresh).toMatchObject({ id: beforeRefresh.id, sandbox_id: original.id, signed_preview_url: refreshed.url });
  expect(new Date(String(afterRefresh.signed_preview_url_expires_at)).getTime()).toBeGreaterThan(Date.now());
  expect(witness.events.slice(beforeRefreshEvents)).toEqual([{ sandboxId: original.id, operation: "endpoint" }]);
  expect((await call(writeToken, "read", { sessionId })).payload).toMatchObject({ sessionId, messageCount: 2 });
  expect(witness.sandboxes).toHaveLength(2);
  await colleagueUnaffected();
  evidence.recordAssertionEvidence("Expired endpoint refresh does not recreate the runtime", "The stored endpoint was expired and the witness rejected the old URL. Resolve issued only a new signed endpoint, persisted a future expiry on the same instance row, and read the existing session. No bootstrap/start/create or changes to the colleague.", true);

  // Model an established workspace on an older image. The real public update
  // endpoint must flush, stop, and ask the adapter to prove restore before retire.
  witness.seedImage(original.id, "witness-previous");
  await queryDenDatabase(databaseUrl, "UPDATE worker SET image_version = 'witness-previous' WHERE id = ?", [original.workerId]);
  expect(await instance()).toMatchObject({ status: "ready", imageVersion: "witness-previous", latestVersion: "witness-snapshot" });
  witness.failNextRestore(original.workerId);
  const failedRecycleStart = witness.events.length;
  expect(await instance(den.admin, "/update")).toEqual({ ok: true, status: "update_requested" });
  expect(original.state).toBe("stopped");
  expect((await instance()).status).toBe("waking");
  await bothHealthy();
  const rejected = witness.sandboxes.find((entry) => entry.workerId === original.workerId && entry.id !== original.id);
  expect(rejected, JSON.stringify(witness.events.slice(failedRecycleStart))).toBeDefined();
  if (!rejected) throw new Error("Replacement was not attempted");
  expect(rejected.state).toBe("destroyed");
  expect(witness.events).toContainEqual({ sandboxId: rejected.id, operation: "restore-verify", exitCode: 1 });
  expect(witness.events.filter((event) => event.sandboxId === original.id && event.operation === "destroy")).toEqual([]);
  expect(await instance()).toMatchObject({ status: "ready", instanceName: original.id, imageVersion: "witness-previous" });
  expect((await runtimeRecord(original.workerId)).sandbox_id).toBe(original.id);
  expect((await call(writeToken, "send", { sessionId, prompt: "Continue after rejected restore" })).payload).toMatchObject({ sessionId, state: "accepted" });
  expect(original.sessions[0]?.prompts).toEqual([task.prompt, "Continue after sleep", "Continue after rejected restore"]);
  await colleagueUnaffected();
  evidence.recordAssertionEvidence("Failed restore preserves the old sandbox and version", JSON.stringify(witness.events.slice(failedRecycleStart)), true);

  const recycledStart = witness.events.length;
  expect(await instance(den.admin, "/update")).toEqual({ ok: true, status: "update_requested" });
  expect((await instance()).status).toBe("waking");
  await bothHealthy();
  const replacement = witness.sandboxes.find((entry) => entry.workerId === original.workerId && entry.state === "started");
  if (!replacement) throw new Error("Restored replacement missing");
  expect(replacement.id).not.toBe(original.id);
  expect(replacement.snapshot).toBe("witness-snapshot");
  expect(replacement.volumes).toEqual(original.volumes);
  expect(original.state).toBe("destroyed");
  const recycleEvents = witness.events.slice(recycledStart);
  const flushedAt = recycleEvents.findIndex((event) => event.sandboxId === original.id && event.operation === "checkpoint-flush" && event.exitCode === 0);
  const stoppedAt = recycleEvents.findIndex((event) => event.sandboxId === original.id && event.operation === "stop");
  const restoredAt = recycleEvents.findIndex((event) => event.sandboxId === replacement.id && event.operation === "restore-verify" && event.exitCode === 0);
  const retiredAt = recycleEvents.findIndex((event) => event.sandboxId === original.id && event.operation === "destroy");
  expect(flushedAt).toBeGreaterThanOrEqual(0);
  expect(stoppedAt).toBeGreaterThan(flushedAt);
  expect(restoredAt).toBeGreaterThan(stoppedAt);
  expect(retiredAt).toBeGreaterThan(restoredAt);
  expect(await instance()).toMatchObject({ status: "ready", instanceName: replacement.id, imageVersion: "witness-snapshot", latestVersion: "witness-snapshot" });
  expect(await runtimeRecord(original.workerId)).toMatchObject({ id: beforeRefresh.id, sandbox_id: replacement.id });
  expect((await call(writeToken, "read", { sessionId })).payload).toMatchObject({
    sessionId, messageCount: 3, messages: [
      { text: task.prompt }, { text: "Continue after sleep" }, { text: "Continue after rejected restore" },
    ],
  });
  expect((await call(writeToken, "send", { sessionId, prompt: "Continue on updated runtime" })).payload).toMatchObject({ sessionId, state: "accepted" });
  expect(replacement.sessions[0]?.prompts).toEqual([task.prompt, "Continue after sleep", "Continue after rejected restore", "Continue on updated runtime"]);
  expect(witness.sandboxes.filter((entry) => entry.workerId === "")).toHaveLength(2);
  for (const helper of witness.sandboxes.filter((entry) => entry.workerId === "")) {
    expect(helper.state).toBe("destroyed");
    expect(helper.volumes.map((mount) => mount.subpath)).toEqual([`workers/${original.workerId}/data/checkpoints`]);
  }
  expect(witness.events.filter((event) => event.operation === "process-unavailable")).toEqual([]);
  expect(witness.unexpected).toEqual([]);
  await colleagueUnaffected();
  evidence.recordAssertionEvidence("Version recycle verifies restore before retiring the old sandbox", JSON.stringify(recycleEvents) + " Same worker and session survived; checkpoint helpers were disposed and the colleague was unchanged. HTTP witness models checkpoint contents and command results only; it does not execute Linux bootstrap, tar, SQLite, or volume I/O.", true);

  await queryDenDatabase(databaseUrl, "UPDATE org_subscriptions SET status = 'canceled' WHERE organization_id = ?", [orgId]);
  expect((await call(writeToken, "create", task)).payload.error).toBe("openwork_web_access_required");
  expect(witness.sessions).toHaveLength(2);
  expect(witness.sandboxes).toHaveLength(6);
  expect(await workers()).toHaveLength(2);
  evidence.recordAssertionEvidence("Lapsed paid access blocks new work even with an existing workspace", "After the seeded subscription was canceled, the same token was denied and session, worker, and sandbox counts remained unchanged.", true);
});
