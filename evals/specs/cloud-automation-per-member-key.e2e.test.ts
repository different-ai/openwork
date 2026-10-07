import { expect, onTestFinished } from "vitest";
import { denFetch, grantOpenWorkWebAccess } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { eventually, needs, server, SkipError, test } from "@openwork/testkit";

/**
 * A Cloud Automation runs on its owner's OpenWork Web computer, and a provider
 * that issues a separate key to each member only reaches that computer with
 * the owner's own key (#4819, #5370). This proves what the owner sees when
 * they have no key yet: the run stops with a reason that names the provider
 * and the key, not an OpenWork Connect problem, and a teammate's key is never
 * borrowed. Once the owner has a key, their computer receives it and the
 * Automation can be resumed.
 */

const PROVIDER_NAME = "Team Gateway";
const PROVIDER_KEY = "team-gateway";
const PROVIDER_ENV = "TEAM_GATEWAY_API_KEY";
const MODEL_ID = "team-model";
// Never called: the run must stop before any model request.
const PROVIDER_API = "http://127.0.0.1:9/v1";
const OWNER_SECRET = "sk-owner-key-eval-only";
const TEAMMATE_SECRET = "sk-teammate-key-eval-only";
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

function orgHeaders(session: DenSession, orgId: string): Record<string, string> {
  return { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId };
}

async function call(session: DenSession, orgId: string, path: string, init: { method?: string; body?: unknown } = {}) {
  const result = await denFetch(session, path, {
    method: init.method ?? "GET",
    headers: orgHeaders(session, orgId),
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

async function memberCredentialState(member: DenSession, orgId: string, providerId: string): Promise<string> {
  const connect = await call(member, orgId, `/v1/llm-providers/${encodeURIComponent(providerId)}/connect`);
  if (connect.status !== 200) throw new Error(`Connect failed: HTTP ${connect.status} ${connect.text.slice(0, 300)}`);
  return stringAt(recordAt(recordAt(connect.body, "llmProvider"), "memberCredential"), "state");
}

async function setMyKey(member: DenSession, orgId: string, providerId: string, apiKey: string): Promise<void> {
  const stored = await call(member, orgId, `/v1/llm-providers/${encodeURIComponent(providerId)}/my-credential`, {
    method: "PUT",
    body: { apiKey },
  });
  if (stored.status !== 200) throw new Error(`Storing the member key failed: HTTP ${stored.status} ${stored.text.slice(0, 300)}`);
}

async function resolveComputer(member: DenSession, orgId: string, gatewayKey: string) {
  const result = await denFetch(member, "/v1/cloud/gateway/resolve", {
    headers: { ...orgHeaders(member, orgId), "x-openwork-gateway-key": gatewayKey },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: result.response.status, body: isRecord(result.body) ? result.body : {}, text: result.text };
}

async function computerProviders(resolution: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = stringAt(resolution, "url");
  const token = stringAt(resolution, "clientToken");
  if (!url || !token) throw new Error("The gateway resolution omitted the computer URL or client token.");
  const response = await fetch(`${url.replace(/\/$/, "")}/opencode/config`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: "error",
  });
  const payload: unknown = await response.json();
  if (!response.ok || !isRecord(payload)) throw new Error(`Reading the computer's models failed: HTTP ${response.status}`);
  return isRecord(payload.provider) ? payload.provider : {};
}

async function computerEnvValue(resolution: Record<string, unknown>, key: string): Promise<string | null> {
  const url = stringAt(resolution, "url");
  const token = stringAt(resolution, "hostToken");
  if (!url || !token) throw new Error("The gateway resolution omitted the computer URL or host token.");
  const response = await fetch(`${url.replace(/\/$/, "")}/env/${encodeURIComponent(key)}`, {
    headers: { "x-openwork-host-token": token }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: "error",
  });
  if (response.status === 404) return null;
  const payload: unknown = await response.json();
  return response.ok && isRecord(payload) && isRecord(payload.item) && typeof payload.item.value === "string" ? payload.item.value : null;
}

test("an Automation owner without their own provider key is told to get one, and is never given a teammate's", { timeout: 1_200_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], env: ["DAYTONA_API_KEY", "DAYTONA_SNAPSHOT"] });
  if (process.env.OPENWORK_EVAL_DEN_API_URL?.trim()) throw new SkipError("Cloud computers need an isolated Den, not an attached service");
  const gatewayKey = "synthetic-cloud-gateway-key";
  await using den = await server({
    place,
    web: false,
    env: {
      NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql", DEN_ORG_MODE: "multi_org",
      DEN_GATEWAY_KEY: gatewayKey,
      DEN_OPENWORK_WEB_ENABLED: "true",
      DEN_AUTOMATIONS_ENABLED: "true",
      DEN_BOOTSTRAP_ADMIN_EMAILS: "per-member-admin@openwork.test",
      STRIPE_OPENWORK_WEB_PRICE_ID: "price_per_member_automation_witness",
      PROVISIONER_MODE: "daytona",
      DAYTONA_API_KEY: process.env.DAYTONA_API_KEY,
      DAYTONA_API_URL: process.env.DAYTONA_API_URL,
      DAYTONA_SNAPSHOT: process.env.DAYTONA_SNAPSHOT,
      DAYTONA_SHARED_VOLUME_NAME: `per-member-automation-${process.pid}`,
      DAYTONA_USE_DEPRECATED_POLLING: "false",
      DAYTONA_HEALTHCHECK_TIMEOUT_MS: "120000",
      WORKER_PROVISIONING_RECONCILE_INTERVAL_MS: "0",
      CLOUD_IDLE_LOOP_SECONDS: "0",
    },
    org: {
      name: "Per-member Key Automations",
      admin: { name: "Provider Admin", email: "per-member-admin@openwork.test" },
      members: { owner: { name: "Automation Owner" }, teammate: { name: "Teammate" } },
    },
  });
  const owner = den.members.owner;
  const teammate = den.members.teammate;
  if (!owner || !teammate) throw new Error("The isolated Den did not provision both members.");
  const orgId = await organizationId(den.admin);
  await grantOpenWorkWebAccess(den.admin, orgId, "Per-member key Cloud Automation coverage");

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
  const ownerStateBefore = await memberCredentialState(owner, orgId, providerId);
  const teammateState = await memberCredentialState(teammate, orgId, providerId);
  expect(ownerStateBefore).toBe("missing");
  expect(teammateState).toBe("active");
  evidence.recordAssertionEvidence(
    "given: the team's provider gives each member their own key, and only the teammate has one",
    `${PROVIDER_NAME} (${providerId}) is per-member and granted to everyone; owner key state: ${ownerStateBefore}, teammate key state: ${teammateState}`,
    true,
  );

  // given: the owner's OpenWork Web computer is ready and does not carry the provider
  const ready = await eventually(() => resolveComputer(owner, orgId, gatewayKey), {
    within: 600_000,
    intervalMs: 5_000,
    label: "owner's OpenWork Web computer ready",
    until: (value) => value.status === 200 && (value.body.status === "ready" || value.body.status === "failed"),
  });
  expect(ready.body.status, ready.text).toBe("ready");
  const providersWithoutKey = await computerProviders(ready.body);
  expect(providersWithoutKey).not.toHaveProperty(providerId);
  expect(await computerEnvValue(ready.body, PROVIDER_ENV)).not.toBe(TEAMMATE_SECRET);
  evidence.recordAssertionEvidence(
    "given: the owner's computer is ready and the teammate's key was not put on it",
    `Computer status ready; providers on it: [${Object.keys(providersWithoutKey).join(", ")}]; ${providerId} absent; teammate's key not present under ${PROVIDER_ENV}`,
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
    within: 600_000,
    intervalMs: 5_000,
    label: "Cloud Automation run finished",
    until: (value) => TERMINAL_RUN_STATUSES.has(stringAt(recordAt(value.body, "run"), "status")),
  });
  const run = recordAt(finished.body, "run");
  const runError = recordAt(run, "error");
  const runMessage = stringAt(runError, "message");
  expect(stringAt(run, "status")).toBe("failed");
  expect(stringAt(runError, "code")).toBe("provider_unavailable");
  expect(runMessage).toContain(PROVIDER_NAME);
  expect(runMessage).toContain("no active key");
  expect(runMessage).not.toContain("OpenWork Connect");
  evidence.recordAssertionEvidence(
    "after: the run stops and tells the owner they need their own key for the team's provider",
    `Run status ${stringAt(run, "status")}, code ${stringAt(runError, "code")}: "${runMessage}"`,
    true,
  );

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
    const resolved = await resolveComputer(owner, orgId, gatewayKey);
    if (resolved.body.status !== "ready") return { resolved, providers: {} };
    return { resolved, providers: await computerProviders(resolved.body) };
  }, {
    within: 120_000,
    intervalMs: 3_000,
    label: "owner's key reaches their computer",
    until: (value) => providerId in value.providers,
  });
  const block = recordAt(withKey.providers, providerId);
  const envNames = Array.isArray(block?.env) ? block.env.filter((name): name is string => typeof name === "string") : [];
  expect(envNames).toHaveLength(1);
  const deliveredKey = await computerEnvValue(withKey.resolved.body, envNames[0] ?? "");
  expect(deliveredKey).toBe(OWNER_SECRET);
  evidence.recordAssertionEvidence(
    "then: once the owner has their own key, their computer receives that key and not the teammate's",
    `${providerId} now on the owner's computer under ${envNames[0]}; the value is the owner's key (checked in memory, not recorded)`,
    deliveredKey === OWNER_SECRET,
  );

  const resumed = await call(owner, orgId, `/v1/automations/${encodeURIComponent(automationId)}/activate`, { method: "POST", body: {} });
  const resumedAutomation = recordAt(resumed.body, "automation");
  expect(resumed.status, resumed.text).toBe(200);
  expect(stringAt(resumedAutomation, "state")).toBe("active");
  expect(resumedAutomation?.needsAttentionReason ?? null).toBeNull();
  evidence.recordAssertionEvidence(
    "after: the owner resumes the Automation and it is active again",
    `Activate returned HTTP ${resumed.status}; state ${stringAt(resumedAutomation, "state")}; no attention reason`,
    true,
  );
});
