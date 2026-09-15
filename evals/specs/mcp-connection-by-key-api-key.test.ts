import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { localMysqlIsRunning, localRedisIsRunning, needs, server, test } from "@openwork/testkit";
import { mcpPutProofWitness } from "../fixtures/mcp-put-proof-witness.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected response object");
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected response string");
  return value;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected response list");
  return value.map(record);
}

function sessionHeaders(session: DenSession, orgId?: string): Record<string, string> {
  return { authorization: `Bearer ${session.token}`, ...(orgId ? { "x-openwork-org-id": orgId } : {}) };
}

const mysqlOpen = await localMysqlIsRunning();
const redisOpen = await localRedisIsRunning();
const title = !mysqlOpen ? "Lane2 skipped — needs MySQL at OPENWORK_EVAL_MYSQL_URL"
  : !redisOpen ? "Lane2 skipped — needs Redis at DATABASE_REDIS_URL"
    : "Lane2 API-key provisioning converges, replaces access, retains secrets, and isolates organization identities";

test.skipIf(!mysqlOpen || !redisOpen)(title, { timeout: 300_000 }, async ({ evidence, place }) => {
  needs({ placement: "local", commands: ["bun", "pnpm"], env: ["OPENWORK_EVAL_MYSQL_URL", "DATABASE_REDIS_URL"] });
  await using witness = await mcpPutProofWitness();
  const since = new Date().toISOString();
  await using den = await server({
    place, web: false,
    org: { name: "Lane2 API Key Proof", members: { teammate: {}, control: {} } },
    env: { DEN_PLAN_GATING_ENABLED: "false" },
  });
  expect(den.database).toBeDefined();
  const context = await denFetch(den.ref, "/v1/org", { headers: sessionHeaders(den.admin) });
  expect(context.response.status).toBe(200);
  const orgId = text(record(record(context.body).organization).id);
  const teammate = den.members.teammate;
  const control = den.members.control;
  if (!teammate || !control) throw new Error("Missing provisioned members");
  const teammateContext = await denFetch(den.ref, "/v1/org", { headers: sessionHeaders(teammate, orgId) });
  expect(teammateContext.response.status).toBe(200);
  const teammateId = text(record(record(teammateContext.body).currentMember).id);
  async function mint(session: DenSession, organizationId: string) {
    const result = await denFetch(den.ref, "/v1/api-keys", {
      method: "POST", headers: sessionHeaders(session, organizationId), body: JSON.stringify({ name: "Lane2 provisioning fixture" }),
    });
    expect(result.response.status).toBe(201);
    return { "x-api-key": text(record(result.body).key) };
  }
  const headers = await mint(den.admin, orgId);
  expect(Object.keys(headers)).toEqual(["x-api-key"]);
  async function request(path: string, method = "GET", body?: unknown, auth: Record<string, string> = headers) {
    const result = await denFetch(den.ref, path, {
      method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    expect(result.text.includes(witness.secret), "No response may echo the MCP bearer secret").toBe(false);
    expect(result.text.includes(headers["x-api-key"]), "No response may echo the organization API key").toBe(false);
    return result;
  }
  async function checked(path: string, method: string, body: unknown, status: number, auth: Record<string, string> = headers) {
    const result = await request(path, method, body, auth);
    expect(result.response.status, `${method} ${path}: ${result.text}`).toBe(status);
    return record(result.body);
  }
  async function connections(auth = headers) {
    return rows((await checked("/v1/mcp-connections?scope=manageable", "GET", undefined, 200, auth)).connections);
  }
  const key = "lane2-managed-connector";
  const keyed = `/v1/mcp-connections/by-key/${key}`;
  const body = { name: "Lane2 Public Connector", url: witness.publicUrl, authType: "none", credentialMode: "shared", access: { orgWide: true } };
  const created = await checked(keyed, "PUT", body, 201);
  const id = text(created.id);
  expect(id).toMatch(/^emc_/);
  expect(created.externalKey).toBe(key);
  evidence.recordAssertionEvidence("1. API-key-only keyed PUT creates a no-auth connection", "Real HTTP x-api-key PUT returned 201, a nonempty emc_ ID, and the requested externalKey; no session bearer or cookie was sent.", true);

  const identical = await checked(keyed, "PUT", body, 200);
  expect(identical.id).toBe(id);
  expect(identical.externalKey).toBe(key);
  expect((await connections()).filter(row => row.externalKey === key)).toEqual([expect.objectContaining({ id, name: body.name })]);
  evidence.recordAssertionEvidence("2. Identical PUT converges without a duplicate", "The byte-identical body returned 200 and the original ID; the manageable list contained exactly one row for the externalKey.", true);

  const team = await checked("/v1/teams", "POST", { name: "Lane2 Restricted Team", memberIds: [teammateId] }, 201);
  const teamId = text(record(team.team).id);
  const renamedBody = { ...body, name: "Lane2 Renamed Connector" };
  const renamed = await checked(keyed, "PUT", { ...renamedBody, access: { orgWide: false, memberIds: [teammateId] } }, 200);
  expect(renamed.id).toBe(id);
  expect(renamed.name).toBe(renamedBody.name);
  const restricted = await checked(keyed, "PUT", { ...renamedBody, access: { orgWide: false, teamIds: [teamId] } }, 200);
  expect(restricted.id).toBe(id);
  const direct = `/v1/mcp-connections/${id}`;
  const teamRead = await checked(direct, "GET", undefined, 200);
  expect(teamRead.access).toEqual({ orgWide: false, teamIds: [teamId], memberIds: [] });
  expect((await request(`${direct}/tools`, "GET", undefined, sessionHeaders(teammate, orgId))).response.status).toBe(200);
  expect((await request(`${direct}/tools`, "GET", undefined, sessionHeaders(control, orgId))).response.status).toBe(403);
  const { access: omittedAccess, ...withoutAccess } = renamedBody;
  expect(omittedAccess).toEqual({ orgWide: true });
  await checked(keyed, "PUT", withoutAccess, 200);
  const widened = await checked(direct, "GET", undefined, 200);
  expect(widened.access).toEqual({ orgWide: true, memberIds: [], teamIds: [] });
  expect((await request(`${direct}/tools`, "GET", undefined, sessionHeaders(control, orgId))).response.status).toBe(200);
  const afterRename = await connections();
  expect(afterRename.filter(row => row.externalKey === key)).toHaveLength(1);
  expect(afterRename.some(row => row.name === body.name)).toBe(false);
  evidence.recordAssertionEvidence("3. Replacement removes old grants; omitted access widens to organization-wide", "Rename preserved the ID. Team replacement cleared direct member grants; teammate tools GET was 200 and non-team control was 403. Omitting access cleared team grants, returned orgWide=true, and the same control tools GET became 200. No old-name or duplicate row remained.", true);

  const duplicate = await checked("/v1/mcp-connections", "POST", { ...body, externalKey: key }, 409);
  expect(duplicate.error).toBe("external_key_exists");
  expect(text(duplicate.message)).toContain(id);
  expect(text(duplicate.message)).toContain(`PUT ${keyed}`);
  expect((await connections()).filter(row => row.externalKey === key)).toHaveLength(1);
  evidence.recordAssertionEvidence("4. Duplicate POST points the client to keyed PUT", "POST with the same externalKey returned 409 external_key_exists, named the existing ID and keyed PUT route, and left exactly one matching connection.", true);

  const beforeConditional = await checked(direct, "GET", undefined, 200);
  const expectedUpdatedAt = text(beforeConditional.updatedAt);
  await new Promise(resolve => setTimeout(resolve, 10));
  const conditionalBody = { ...renamedBody, name: "Lane2 Conditional Update", expectedUpdatedAt };
  const updated = await checked(direct, "PUT", conditionalBody, 200);
  expect(updated.id).toBe(id);
  const afterConditional = await checked(direct, "GET", undefined, 200);
  expect(afterConditional.name).toBe(conditionalBody.name);
  expect(afterConditional.updatedAt).not.toBe(expectedUpdatedAt);
  const stale = await request(direct, "PUT", { ...conditionalBody, name: "Lane2 Stale Rejected" });
  expect([409, 412]).toContain(stale.response.status);
  expect(record(stale.body).error).toBe("connection_conflict");
  const afterStale = await checked(direct, "GET", undefined, 200);
  expect(afterStale.name).toBe(conditionalBody.name);
  expect(afterStale.updatedAt).toBe(afterConditional.updatedAt);
  evidence.recordAssertionEvidence("5. ID PUT accepts current expectedUpdatedAt and rejects the consumed version", `GET supplied the current timestamp; ID PUT returned 200 with the same ID and a new timestamp. Reusing the old timestamp returned ${stale.response.status} connection_conflict and changed neither name nor updatedAt.`, true);

  const invalidCredentials: Record<string, string>[] = [{}, { authorization: "Bearer incorrect-fixture-token" }];
  for (const auth of invalidCredentials) {
    const denied = await fetch(witness.bearerUrl, {
      method: "POST", headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), signal: AbortSignal.timeout(5_000),
    });
    expect(denied.status).toBe(401);
    await denied.text();
  }
  const bearerKey = `${key}-bearer`;
  const bearerPath = `/v1/mcp-connections/by-key/${bearerKey}`;
  const bearerBody = { ...body, name: "Lane2 Bearer Connector", url: witness.bearerUrl, authType: "apikey" };
  const bearerCreated = await checked(bearerPath, "PUT", { ...bearerBody, apiKey: witness.secret }, 201);
  const bearerId = text(bearerCreated.id);
  const bearerDirect = `/v1/mcp-connections/${bearerId}`;
  for (const response of [bearerCreated, await checked(bearerDirect, "GET", undefined, 200)]) {
    expect(response.apiKey).toBeUndefined();
    expect(response.authType).toBe("apikey");
  }
  const catalogBefore = await checked(`${bearerDirect}/tools`, "GET", undefined, 200);
  expect(rows(catalogBefore.tools).map(tool => tool.name)).toContain(witness.toolName);
  const beforeOmission = witness.requests(since).filter(row => row.path === "/bearer" && row.method === "tools/list" && row.status === 200).length;
  const retained = await checked(bearerPath, "PUT", { ...bearerBody, name: "Lane2 Bearer Renamed" }, 200);
  expect(retained.id).toBe(bearerId);
  expect(retained.apiKey).toBeUndefined();
  const retainedRead = await checked(bearerDirect, "GET", undefined, 200);
  expect(retainedRead.apiKey).toBeUndefined();
  expect(retainedRead.name).toBe("Lane2 Bearer Renamed");
  const catalogAfter = await checked(`${bearerDirect}/tools`, "GET", undefined, 200);
  expect(rows(catalogAfter.tools).map(tool => tool.name)).toContain(witness.toolName);
  const accepted = witness.requests(since).filter(row => row.path === "/bearer" && row.method === "tools/list" && row.status === 200);
  expect(accepted.length).toBeGreaterThan(beforeOmission);
  expect(accepted.every(row => row.tokenId === witness.tokenId)).toBe(true);
  expect(witness.requests(since).filter(row => row.path === "/bearer" && row.status === 401)).toHaveLength(2);
  evidence.recordAssertionEvidence("6. Write-only bearer credentials survive omission and still authenticate upstream", `Missing and wrong bearer controls each returned 401. Secret PUT/GET and omission PUT/GET never echoed the secret or exposed apiKey. After omission, Den tools GET returned the witness tool and increased authenticated tools/list observations from ${beforeOmission} to ${accepted.length}, all attributed to the original credential fingerprint.`, true);

  const removed = await request(keyed, "DELETE");
  expect([200, 204]).toContain(removed.response.status);
  await checked(direct, "GET", undefined, 404);
  expect((await connections()).some(row => row.id === id || row.externalKey === key)).toBe(false);
  const recreated = await checked(keyed, "PUT", body, 201);
  const newId = text(recreated.id);
  expect(newId).not.toBe(id);
  expect(recreated.externalKey).toBe(key);
  await checked(direct, "GET", undefined, 404);
  await checked(bearerDirect, "GET", undefined, 200);
  evidence.recordAssertionEvidence("7. Keyed deletion removes the old identity; recreation allocates a new one", `DELETE returned ${removed.response.status}; old ID GET returned 404 and the list lost the key. Recreation returned 201 with a different ID and the same externalKey; the old ID remained 404 and the bearer sibling survived.`, true);

  const newDirect = `/v1/mcp-connections/${newId}`;
  const newRead = await checked(newDirect, "GET", undefined, 200);
  const editBody = { ...body, name: "Lane2 Unauthorized Edit", expectedUpdatedAt: text(newRead.updatedAt) };
  const anonymousCases = [
    { path: newDirect, method: "GET" },
    { path: keyed, method: "PUT", body },
    { path: keyed, method: "DELETE" },
    { path: newDirect, method: "PUT", body: editBody },
    { path: "/v1/mcp-connections", method: "POST", body: { ...body, externalKey: `${key}-unauthorized` } },
  ];
  const anonymousStatuses: number[] = [];
  for (const entry of anonymousCases) {
    const denied = await request(entry.path, entry.method, entry.body, {});
    expect([401, 403]).toContain(denied.response.status);
    anonymousStatuses.push(denied.response.status);
  }
  const otherOrg = await checked("/v1/org", "POST", { name: "Lane2 Foreign Control" }, 201, sessionHeaders(control));
  const otherId = text(record(otherOrg.organization).id);
  expect(otherId).not.toBe(orgId);
  const foreign = await mint(control, otherId);
  for (const method of ["GET", "PUT", "DELETE"]) {
    const denied = await request(newDirect, method, method === "PUT" ? editBody : undefined, foreign);
    expect(denied.response.status).toBe(404);
    expect(record(denied.body).error).toBe("connection_not_found");
  }
  expect(await connections(foreign)).toEqual([]);
  const otherCreated = await checked(keyed, "PUT", { ...body, name: "Lane2 Foreign Connector" }, 201, foreign);
  const otherConnectionId = text(otherCreated.id);
  expect(otherConnectionId).not.toBe(newId);
  expect(otherCreated.externalKey).toBe(key);
  expect((await connections(foreign)).filter(row => row.externalKey === key)).toEqual([expect.objectContaining({ id: otherConnectionId })]);
  expect((await request(`/v1/mcp-connections/${otherConnectionId}`)).response.status).toBe(404);
  const original = await checked(newDirect, "GET", undefined, 200);
  expect(original.name).toBe(body.name);
  expect(original.updatedAt).toBe(newRead.updatedAt);
  expect((await connections()).some(row => row.externalKey === `${key}-unauthorized` || row.id === otherConnectionId)).toBe(false);
  expect((await connections()).filter(row => row.externalKey === key)).toHaveLength(1);
  evidence.recordAssertionEvidence("8. Anonymous callers and foreign organization keys cannot access another identity", `No-key GET, keyed PUT, keyed DELETE, ID PUT, and POST returned ${anonymousStatuses.join(", ")}. A different user's foreign-org key received 404 for ID GET/PUT/DELETE, then created the same slug with 201 and a distinct own ID. Reciprocal ID GET was 404, lists were disjoint, and rejected writes preserved the original name/timestamp without creating an unauthorized key.`, true);
});
