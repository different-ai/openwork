import { createServer, type Server } from "node:http";
import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { inviteMember, localMysqlIsRunning, server, test } from "@openwork/testkit";

const REQUEST_TIMEOUT_MS = 15_000;
const MODEL_ID = "team-model";
const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1" && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const mysqlOpen = await localMysqlIsRunning();
const title = localPlacement && !mysqlOpen
  ? "provider probe classification skipped — needs MySQL on 127.0.0.1:3306"
  : "organization provider probes classify resolved credentials and stale bindings remain repairable";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function auth(session: DenSession, orgId: string): Record<string, string> {
  return { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId };
}

async function organizationId(admin: DenSession, name: string): Promise<string> {
  const result = await denFetch(admin, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${admin.token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const orgs = isRecord(result.body) && Array.isArray(result.body.orgs) ? result.body.orgs.filter(isRecord) : [];
  const id = orgs.find((org) => org.name === name)?.id;
  if (!result.response.ok || typeof id !== "string") throw new Error(`Could not find test organization: ${result.text}`);
  return id;
}

async function membershipId(admin: DenSession, orgId: string, email: string): Promise<string> {
  const result = await denFetch(admin, "/v1/org", {
    headers: auth(admin, orgId),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const members = isRecord(result.body) && Array.isArray(result.body.members) ? result.body.members.filter(isRecord) : [];
  const id = members.find((member) => isRecord(member.user) && member.user.email === email)?.id;
  if (!result.response.ok || typeof id !== "string") throw new Error(`Could not find membership for ${email}: ${result.text}`);
  return id;
}

interface GatewayWitness extends AsyncDisposable {
  url: string;
  acceptedKey: string;
  modelIds: string[];
  authorizations: string[];
}

async function listen(httpServer: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (address === null || typeof address === "string") throw new Error("Gateway witness did not receive a TCP port.");
  return address.port;
}

async function close(httpServer: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => error ? reject(error) : resolve());
  });
}

async function gatewayWitness(acceptedKey: string): Promise<GatewayWitness> {
  const state: { acceptedKey: string; modelIds: string[]; authorizations: string[] } = {
    acceptedKey,
    modelIds: [MODEL_ID],
    authorizations: [],
  };
  const httpServer = createServer((request, response) => {
    const authorization = request.headers.authorization ?? "";
    state.authorizations.push(authorization);
    if (request.method !== "GET" || request.url !== "/v1/models") {
      response.writeHead(404).end();
      return;
    }
    if (authorization !== `Bearer ${state.acceptedKey}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "upstream body must not escape" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: state.modelIds.map((id) => ({ id })) }));
  });
  const port = await listen(httpServer);
  return {
    url: `http://127.0.0.1:${port}/v1`,
    get acceptedKey() { return state.acceptedKey; },
    set acceptedKey(value: string) { state.acceptedKey = value; },
    get modelIds() { return state.modelIds; },
    set modelIds(value: string[]) { state.modelIds = value; },
    get authorizations() { return state.authorizations; },
    async [Symbol.asyncDispose]() { await close(httpServer); },
  };
}

async function closedPortUrl(): Promise<string> {
  const httpServer = createServer();
  const port = await listen(httpServer);
  await close(httpServer);
  return `http://127.0.0.1:${port}/v1`;
}

function providerConfig(api: string) {
  return {
    id: "probe-gateway",
    name: "Probe gateway",
    npm: "@ai-sdk/openai-compatible",
    env: ["GATEWAY_API_KEY"],
    api,
    models: [{ id: MODEL_ID, name: "Team model" }],
  };
}

async function writeProviderApi(admin: DenSession, orgId: string, providerId: string, api: string) {
  const result = await denFetch(admin, `/v1/llm-providers/${providerId}`, {
    method: "PATCH",
    headers: auth(admin, orgId),
    body: JSON.stringify({
      name: "Probe gateway",
      source: "custom",
      customConfig: providerConfig(api),
      credentialMode: "per_member",
      allMembers: true,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(result.response.status, result.text).toBe(200);
}

async function request(session: DenSession, orgId: string, path: string, method = "GET", body?: object) {
  return denFetch(session, path, {
    method,
    headers: auth(session, orgId),
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function memberBinding(body: unknown, memberId: string): Record<string, unknown> {
  const bindings = isRecord(body) && Array.isArray(body.memberCredentials) ? body.memberCredentials.filter(isRecord) : [];
  const binding = bindings.find((entry) => entry.orgMembershipId === memberId);
  if (!binding) throw new Error(`Missing member credential binding ${memberId}.`);
  return binding;
}

test.skipIf(localPlacement && !mysqlOpen)(title, { timeout: 300_000 }, async ({ evidence, place }) => {
  const runId = `${Date.now().toString(36)}-${process.pid}`;
  const organizationName = `Provider probe ${runId}`;
  const originalKey = `probe-original-${runId}`;
  const rotatedKey = `probe-rotated-${runId}`;
  const repairedKey = `probe-repaired-${runId}`;
  await using witness = await gatewayWitness(originalKey);
  await using den = await server({ place, org: { name: organizationName, members: {} } });
  const memberA = await inviteMember(den, "memberA", {
    email: `probe-a-${runId}@example.com`,
    name: "Probe Member A",
    password: "OpenWorkEval123!",
  });
  const memberB = await inviteMember(den, "memberB", {
    email: `probe-b-${runId}@example.com`,
    name: "Probe Member B",
    password: "OpenWorkEval123!",
  });
  const orgId = await organizationId(den.admin, organizationName);
  const [memberAId, memberBId] = await Promise.all([
    membershipId(den.admin, orgId, memberA.email),
    membershipId(den.admin, orgId, memberB.email),
  ]);

  const created = await request(den.admin, orgId, "/v1/llm-providers", "POST", {
    name: "Probe gateway",
    source: "custom",
    customConfig: providerConfig(witness.url),
    credentialMode: "per_member",
    allMembers: true,
  });
  expect(created.response.status, created.text).toBe(201);
  const providerId = isRecord(created.body) && isRecord(created.body.llmProvider) ? created.body.llmProvider.id : null;
  if (typeof providerId !== "string") throw new Error("Created provider did not return an id.");

  const initialWrite = await request(
    den.admin,
    orgId,
    `/v1/llm-providers/${providerId}/member-credentials/${memberAId}`,
    "PUT",
    { apiKey: originalKey },
  );
  expect(initialWrite.body).toMatchObject({ state: "active", version: 1 });

  const okProbe = await request(memberA, orgId, `/v1/llm-providers/${providerId}/probe`, "POST", {});
  expect(okProbe.response.status, okProbe.text).toBe(200);
  expect(okProbe.body).toMatchObject({ status: "ok", models: 1 });
  expect(isRecord(okProbe.body) && typeof okProbe.body.latencyMs === "number").toBe(true);
  expect(witness.authorizations.at(-1)).toBe(`Bearer ${originalKey}`);
  expect(okProbe.text).not.toContain(originalKey);

  const rotated = await request(
    den.admin,
    orgId,
    `/v1/llm-providers/${providerId}/member-credentials/${memberAId}`,
    "PUT",
    { apiKey: rotatedKey, expectedVersion: 1 },
  );
  expect(rotated.body).toMatchObject({ state: "active", version: 2 });
  const unauthorized = await request(memberA, orgId, `/v1/llm-providers/${providerId}/probe`, "POST", {});
  expect(unauthorized.body).toMatchObject({ status: "unauthorized" });
  expect(unauthorized.text).not.toContain(rotatedKey);
  expect(unauthorized.text).not.toContain("upstream body must not escape");

  const noCredential = await request(memberB, orgId, `/v1/llm-providers/${providerId}/probe`, "POST", {});
  expect(noCredential.response.status).toBe(200);
  expect(noCredential.body).toEqual({ status: "no_credential" });
  const forbidden = await request(memberB, orgId, `/v1/llm-providers/${providerId}/probe`, "POST", { orgMembershipId: memberAId });
  expect(forbidden.response.status).toBe(403);

  const afterForbidden = await request(den.admin, orgId, `/v1/llm-providers/${providerId}/member-credentials`);
  expect(memberBinding(afterForbidden.body, memberAId)).toMatchObject({ state: "active", version: 2 });
  expect(memberBinding(afterForbidden.body, memberBId)).toMatchObject({ state: "missing", version: null });

  const closedUrl = await closedPortUrl();
  await writeProviderApi(den.admin, orgId, providerId, closedUrl);
  const unreachableStartedAt = Date.now();
  const unreachable = await request(memberA, orgId, `/v1/llm-providers/${providerId}/probe`, "POST", {});
  const unreachableElapsedMs = Date.now() - unreachableStartedAt;
  expect(unreachable.body).toMatchObject({ status: "unreachable" });
  expect(unreachableElapsedMs).toBeLessThan(10_000);

  await writeProviderApi(den.admin, orgId, providerId, witness.url);
  witness.acceptedKey = rotatedKey;
  witness.modelIds = [];
  const modelMissing = await request(memberA, orgId, `/v1/llm-providers/${providerId}/probe`, "POST", {});
  expect(modelMissing.body).toMatchObject({ status: "model_missing", models: 0, missingModelIds: [MODEL_ID] });
  expect(modelMissing.text).not.toContain(rotatedKey);

  const stale = await request(
    den.admin,
    orgId,
    `/v1/llm-providers/${providerId}/member-credentials/${memberAId}/stale`,
    "POST",
  );
  expect(stale.body).toMatchObject({ state: "stale", version: 3 });
  const staleConnect = await request(memberA, orgId, `/v1/llm-providers/${providerId}/connect`);
  expect(staleConnect.body).toMatchObject({
    llmProvider: { apiKey: null, apiKeys: null, memberCredential: { state: "stale" } },
  });
  const repaired = await request(memberA, orgId, `/v1/llm-providers/${providerId}/my-credential`, "PUT", { apiKey: repairedKey });
  expect(repaired.body).toMatchObject({ state: "active", version: 4 });

  const blocked = await request(
    den.admin,
    orgId,
    `/v1/llm-providers/${providerId}/member-credentials/${memberAId}/block`,
    "POST",
  );
  expect(blocked.body).toMatchObject({ state: "blocked", version: 5 });
  const blockedWrite = await request(memberA, orgId, `/v1/llm-providers/${providerId}/my-credential`, "PUT", { apiKey: "must-not-unblock" });
  expect(blockedWrite.response.status).toBe(409);
  expect(blockedWrite.body).toEqual({ error: "credential_blocked" });

  evidence.recordAssertionEvidence(
    "Provider probes resolve member credentials without disclosure and stale remains distinct from blocked",
    "The gateway observed member A's bearer key; responses disclosed no key or upstream body, all five probe classifications were exercised, stale was self-repaired, and blocked rejected self-repair.",
    okProbe.response.status === 200
      && witness.authorizations.includes(`Bearer ${originalKey}`)
      && !okProbe.text.includes(originalKey)
      && forbidden.response.status === 403
      && unreachableElapsedMs < 10_000
      && repaired.response.status === 200
      && blockedWrite.response.status === 409,
  );
});
