import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { expect, onTestFinished } from "vitest";
import { denFetch, eventually, needs, queryDenDatabase, server, test } from "@openwork/testkit";
import type { DenSession } from "@openwork/testkit";
import { bootCloudModelInfraWorker } from "../worlds/infra/cloud-model-infra-worker.ts";

/**
 * A Cloud Automation runs on its owner's OpenWork Web computer, and a provider
 * that issues a separate key to each member reaches that computer only with
 * the owner's own key (#4819, #5370). This proves what the owner sees when
 * they have no key yet: the run stops with a reason that names the provider
 * and the key, not an OpenWork Connect problem, and a teammate's key is never
 * borrowed. Once the owner has a key, their computer receives it and the
 * Automation can be resumed.
 *
 * The owner's computer is a real source-first openwork-server with its
 * managed engine, registered with Den at the database seam the way a Daytona
 * sandbox would be. Den's Daytona endpoint is a ledger that must stay empty.
 */

const PROVIDER_NAME = "Team Gateway";
const PROVIDER_KEY = "team-gateway";
const PROVIDER_ENV = "TEAM_GATEWAY_API_KEY";
const MODEL_ID = "team-model";
// Never called: the run must stop before any model request.
const PROVIDER_API = "http://127.0.0.1:9/v1";
const OWNER_SECRET = `sk-owner-${randomBytes(8).toString("hex")}`;
const TEAMMATE_SECRET = `sk-teammate-${randomBytes(8).toString("hex")}`;
const GATEWAY_KEY = "per-member-automation-gateway-key";
const REQUEST_TIMEOUT_MS = 30_000;
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "skipped"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(record: Record<string, unknown> | null | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function recordAt(record: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  const value = record?.[key];
  return isRecord(value) ? value : null;
}

/** Valid Den typeid: prefix plus a 26-char lowercase Crockford suffix whose first char keeps the 128-bit bound. */
function denId(prefix: string): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const bytes = randomBytes(26);
  let suffix = "";
  for (let index = 0; index < 26; index += 1) {
    const byte = bytes[index] ?? 0;
    suffix += index === 0 ? String(byte % 8) : alphabet[byte % 32];
  }
  return `${prefix}_${suffix}`;
}

function orgHeaders(session: DenSession, orgId: string): Record<string, string> {
  return { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId };
}

async function call(session: DenSession, orgId: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const result = await denFetch(session, path, {
    method: init.method ?? "GET",
    headers: { ...orgHeaders(session, orgId), ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: result.response.status, body: isRecord(result.body) ? result.body : {}, text: result.text };
}

async function organizationId(session: DenSession): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${session.token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const organizations = isRecord(result.body) && Array.isArray(result.body.orgs) ? result.body.orgs.filter(isRecord) : [];
  const id = stringAt(organizations[0], "id");
  if (!result.response.ok || !id) throw new Error(`Finding the test organization failed: HTTP ${result.response.status}`);
  return id;
}

async function memberKeyState(member: DenSession, orgId: string, providerId: string): Promise<string> {
  const connect = await call(member, orgId, `/v1/llm-providers/${encodeURIComponent(providerId)}/connect`);
  if (connect.status !== 200) throw new Error(`Connect failed: HTTP ${connect.status} ${connect.text.slice(0, 300)}`);
  return stringAt(recordAt(recordAt(connect.body, "llmProvider"), "memberCredential"), "state");
}

async function setMyKey(member: DenSession, orgId: string, providerId: string, apiKey: string): Promise<void> {
  const stored = await call(member, orgId, `/v1/llm-providers/${encodeURIComponent(providerId)}/my-credential`, { method: "PUT", body: { apiKey } });
  if (stored.status !== 200) throw new Error(`Storing the member key failed: HTTP ${stored.status} ${stored.text.slice(0, 300)}`);
}

/** Den's ledger for the Daytona API: the seeded computer must never need the Daytona SDK. */
async function startDaytonaLedger() {
  const requests: string[] = [];
  const ledger = createServer((request, response) => {
    requests.push(`${request.method ?? "GET"} ${request.url ?? ""}`);
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "this world must not reach the Daytona API" }));
  });
  await new Promise<void>((resolve, reject) => {
    ledger.once("error", reject);
    ledger.listen(0, "127.0.0.1", resolve);
  });
  const address = ledger.address();
  if (!address || typeof address === "string") throw new Error("The Daytona ledger did not bind a TCP port.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve) => ledger.close(() => resolve()));
    },
  };
}

test("an Automation owner without their own provider key is told to get one, and is never given a teammate's", { timeout: 1_200_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["bun"], placement: "local" });
  await using daytonaLedger = await startDaytonaLedger();
  await using stack = new AsyncDisposableStack();
  const den = stack.use(await server({
    place,
    web: false,
    env: {
      DEN_ORG_MODE: "multi_org",
      DEN_GATEWAY_KEY: GATEWAY_KEY,
      DEN_OPENWORK_WEB_ENABLED: "true",
      DEN_AUTOMATIONS_ENABLED: "true",
      DEN_BOOTSTRAP_ADMIN_EMAILS: "per-member-admin@openwork.test",
      PROVISIONER_MODE: "daytona",
      DAYTONA_API_KEY: "per-member-automation-daytona-guard-key",
      DAYTONA_API_URL: daytonaLedger.url,
      WORKER_PROVISIONING_RECONCILE_INTERVAL_MS: "0",
      CLOUD_IDLE_LOOP_SECONDS: "0",
    },
    org: {
      name: "Per-member Key Automations",
      admin: { name: "Provider Admin", email: "per-member-admin@openwork.test" },
      members: { owner: { name: "Automation Owner" }, teammate: { name: "Teammate" } },
    },
  }));
  const owner = den.members.owner;
  const teammate = den.members.teammate;
  const databaseUrl = den.database?.url;
  if (!owner || !teammate) throw new Error("The isolated Den did not provision both members.");
  if (!databaseUrl) throw new Error("The isolated Den did not expose its database.");
  const orgId = await organizationId(den.admin);
  const access = await call(den.admin, orgId, `/v1/admin/organizations/${orgId}/openwork-web-access`, {
    method: "PUT",
    body: { enabled: true, reason: "Per-member key Cloud Automation coverage" },
  });
  expect(access.status, access.text).toBeLessThan(300);

  // given: a provider that issues a separate key to each member, granted to everyone
  const created = await call(den.admin, orgId, "/v1/llm-providers", {
    method: "POST",
    body: {
      name: PROVIDER_NAME,
      source: "custom",
      customConfig: {
        id: PROVIDER_KEY, name: PROVIDER_NAME, npm: "@ai-sdk/openai-compatible", env: [PROVIDER_ENV], api: PROVIDER_API,
        models: [{ id: MODEL_ID, name: "Team model" }],
      },
      credentialMode: "per_member",
      allMembers: true, memberIds: [], teamIds: [],
    },
  });
  const providerId = stringAt(recordAt(created.body, "llmProvider"), "id");
  expect(created.status, created.text).toBe(201);
  expect(providerId).not.toBe("");
  onTestFinished(async () => {
    await call(den.admin, orgId, `/v1/llm-providers/${encodeURIComponent(providerId)}`, { method: "DELETE" }).catch(() => undefined);
  });
  await setMyKey(teammate, orgId, providerId, TEAMMATE_SECRET);
  const ownerKeyBefore = await memberKeyState(owner, orgId, providerId);
  const teammateKey = await memberKeyState(teammate, orgId, providerId);
  expect(ownerKeyBefore).toBe("missing");
  expect(teammateKey).toBe("active");
  evidence.recordAssertionEvidence(
    "given: the team's provider gives each member their own key, and only the teammate has one",
    `${PROVIDER_NAME} (${providerId}) is per-member and granted to everyone; owner key: ${ownerKeyBefore}, teammate key: ${teammateKey}`,
    true,
  );

  // given: the owner's OpenWork Web computer is ready
  const computer = await bootCloudModelInfraWorker(stack, {
    name: `per-member-automation-${process.pid}`,
    workspace: `/tmp/openwork-per-member-automation-${process.pid}`,
    replace: true,
  });
  const runtime = { url: computer.manifest.openworkUrl, clientToken: computer.manifest.token, hostToken: computer.manifest.hostToken };
  await eventually(async () => {
    const response = await fetch(`${runtime.url}/opencode/config`, {
      headers: { authorization: `Bearer ${runtime.clientToken}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => null);
    return response?.ok === true;
  }, { within: 180_000, intervalMs: 2_000, label: "the computer's engine is serving its config" });

  const users = await queryDenDatabase(databaseUrl, "SELECT id FROM `user` WHERE email = ? LIMIT 1", [owner.email]);
  const ownerUserId = stringAt(users.filter(isRecord)[0], "id");
  expect(ownerUserId).not.toBe("");
  const workerId = denId("wrk");
  await queryDenDatabase(
    databaseUrl,
    `INSERT INTO worker (id, org_id, created_by_user_id, name, description, destination, status, image_version, workspace_path,
       sandbox_backend, last_heartbeat_at, last_active_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, 'cloud', 'healthy', NULL, NULL, 'cloud-instance', NULL, NULL, NOW(3), NOW(3))`,
    [workerId, orgId, ownerUserId, "Automation Owner's computer"],
  );
  for (const [scope, token] of [["client", runtime.clientToken], ["host", runtime.hostToken], ["activity", randomBytes(32).toString("hex")]]) {
    await queryDenDatabase(
      databaseUrl,
      "INSERT INTO worker_token (id, worker_id, scope, token, created_at, revoked_at) VALUES (?, ?, ?, ?, NOW(3), NULL)",
      [denId("wkt"), workerId, scope, token],
    );
  }
  const sandboxId = `sbx-per-member-automation-${process.pid}`;
  await queryDenDatabase(
    databaseUrl,
    `INSERT INTO cloud_runtime_instance (id, worker_id, provider_id, provider_ref, workspace_volume_id, data_volume_id,
       endpoint_url, endpoint_expires_at, endpoint_kind, region, created_at, updated_at)
     VALUES (?, ?, 'daytona', ?, 'vol-workspace', 'vol-data', ?, DATE_ADD(NOW(3), INTERVAL 12 HOUR), 'signed-expiring', NULL, NOW(3), NOW(3))`,
    [denId("cri"), workerId, JSON.stringify({ sandboxId }), runtime.url],
  );

  const ready = await eventually(() => call(owner, orgId, "/v1/cloud/gateway/resolve", { headers: { "x-openwork-gateway-key": GATEWAY_KEY } }), {
    within: 120_000,
    intervalMs: 3_000,
    label: "the owner's computer resolves ready",
    until: (value) => value.status === 200 && value.body.status === "ready",
  });
  expect(stringAt(ready.body, "url")).toBe(runtime.url);
  const providersWithoutKey = await readProviders(runtime);
  expect(providersWithoutKey).not.toHaveProperty(providerId);
  const bareEnvWithoutKey = await readEnv(runtime, PROVIDER_ENV);
  expect(bareEnvWithoutKey).not.toBe(TEAMMATE_SECRET);
  evidence.recordAssertionEvidence(
    "given: the owner's computer is ready and the teammate's key was not put on it",
    `Computer ${workerId} resolves ready; providers on it: [${Object.keys(providersWithoutKey).join(", ")}]; ${providerId} absent; ${PROVIDER_ENV} ${bareEnvWithoutKey === null ? "unset" : "holds a different value"}`,
    true,
  );

  // when: the owner creates a Cloud Automation on that provider's model and runs it now
  const automation = await call(owner, orgId, "/v1/cloud-automations", {
    method: "POST",
    body: {
      name: "Weekly team summary",
      schedule: { kind: "weekly", timezone: "America/Los_Angeles", daysOfWeek: [1], hour: 9, minute: 0 },
      action: { kind: "agent", instructions: "Summarize last week's team updates.", model: { providerId, modelId: MODEL_ID } },
    },
  });
  expect(automation.status, automation.text).toBe(201);
  const automationId = stringAt(recordAt(automation.body, "automation"), "id");
  const queued = await call(owner, orgId, `/v1/automations/${encodeURIComponent(automationId)}/run`, { method: "POST", body: {} });
  expect(queued.status, queued.text).toBe(202);
  const runId = stringAt(recordAt(queued.body, "run"), "id");
  expect(runId).not.toBe("");
  evidence.recordAssertionEvidence(
    "when: the owner creates a Cloud Automation on the team model and runs it now",
    `Automation ${automationId} created (HTTP ${automation.status}); run ${runId} queued (HTTP ${queued.status})`,
    true,
  );

  // after: the run stops and says the owner needs their own key for this provider
  const finished = await eventually(() => call(owner, orgId, `/v1/automation-runs/${encodeURIComponent(runId)}`), {
    within: 300_000,
    intervalMs: 3_000,
    label: "the Cloud Automation run finished",
    until: (value) => TERMINAL_RUN_STATUSES.has(stringAt(recordAt(value.body, "run"), "status")),
  });
  const run = recordAt(finished.body, "run");
  const runError = recordAt(run, "error");
  const runMessage = stringAt(runError, "message");
  evidence.recordAssertionEvidence(
    "after: the run stops and tells the owner they need their own key for the team's provider",
    `Run status ${stringAt(run, "status")}, code ${stringAt(runError, "code")}: "${runMessage}"`,
    stringAt(runError, "code") === "provider_unavailable" && runMessage.includes(PROVIDER_NAME),
  );
  expect(stringAt(run, "status")).toBe("failed");
  expect(stringAt(runError, "code")).toBe("provider_unavailable");
  expect(runMessage).toContain(PROVIDER_NAME);
  expect(runMessage).toContain("no active key");
  expect(runMessage).not.toContain("OpenWork Connect");

  const paused = await call(owner, orgId, `/v1/automations/${encodeURIComponent(automationId)}`);
  const pausedAutomation = recordAt(paused.body, "automation");
  const reason = recordAt(pausedAutomation, "needsAttentionReason");
  expect(stringAt(pausedAutomation, "state")).toBe("needs_attention");
  expect(stringAt(reason, "code")).toBe("provider_unavailable");
  expect(stringAt(reason, "message")).toBe(runMessage);
  evidence.recordAssertionEvidence(
    "after: the Automation is paused with the same reason, so the owner sees what to fix",
    `Automation state ${stringAt(pausedAutomation, "state")}; reason ${stringAt(reason, "code")}: "${stringAt(reason, "message")}"`,
    true,
  );

  // then: once the owner has their own key, their computer receives it, never the teammate's
  await setMyKey(owner, orgId, providerId, OWNER_SECRET);
  const withKey = await eventually(async () => {
    await call(owner, orgId, "/v1/cloud/gateway/resolve", { headers: { "x-openwork-gateway-key": GATEWAY_KEY } });
    return readProviders(runtime);
  }, {
    within: 120_000,
    intervalMs: 3_000,
    label: "the owner's key reaches their computer",
    until: (providers) => providerId in providers,
  });
  const block = recordAt(withKey, providerId);
  const envNames = Array.isArray(block?.env) ? block.env.filter((name): name is string => typeof name === "string") : [];
  expect(envNames).toHaveLength(1);
  const deliveredKey = await readEnv(runtime, envNames[0] ?? "");
  expect(deliveredKey).toBe(OWNER_SECRET);
  evidence.recordAssertionEvidence(
    "then: once the owner has their own key, their computer receives that key and not the teammate's",
    `${providerId} now on the owner's computer under ${envNames[0]}; the value is the owner's key (compared in memory, not recorded)`,
    deliveredKey === OWNER_SECRET,
  );

  const resumed = await call(owner, orgId, `/v1/automations/${encodeURIComponent(automationId)}/activate`, { method: "POST", body: {} });
  const resumedAutomation = recordAt(resumed.body, "automation");
  expect(resumed.status, resumed.text).toBe(200);
  expect(stringAt(resumedAutomation, "state")).toBe("active");
  expect(resumedAutomation?.needsAttentionReason ?? null).toBeNull();
  expect(daytonaLedger.requests).toEqual([]);
  evidence.recordAssertionEvidence(
    "after: the owner resumes the Automation and it is active again",
    `Activate returned HTTP ${resumed.status}; state ${stringAt(resumedAutomation, "state")}; no attention reason; Daytona API calls: ${daytonaLedger.requests.length}`,
    true,
  );
});

async function readProviders(runtime: { url: string; clientToken: string }): Promise<Record<string, unknown>> {
  const response = await fetch(`${runtime.url}/opencode/config`, {
    headers: { authorization: `Bearer ${runtime.clientToken}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload: unknown = await response.json();
  if (!response.ok || !isRecord(payload)) throw new Error(`Reading the computer's models failed: HTTP ${response.status}`);
  return isRecord(payload.provider) ? payload.provider : {};
}

async function readEnv(runtime: { url: string; hostToken: string }, key: string): Promise<string | null> {
  const response = await fetch(`${runtime.url}/env/${encodeURIComponent(key)}`, {
    headers: { "x-openwork-host-token": runtime.hostToken }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  const payload: unknown = await response.json();
  return response.ok && isRecord(payload) && isRecord(payload.item) && typeof payload.item.value === "string" ? payload.item.value : null;
}
