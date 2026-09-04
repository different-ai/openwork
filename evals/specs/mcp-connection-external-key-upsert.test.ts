import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { localMysqlIsRunning, localRedisIsRunning, mcpMock, server, test } from "@openwork/testkit";

const daytona = process.env.OPENWORK_EVAL_DAYTONA?.trim() === "1";
const attached = Boolean(process.env.OPENWORK_EVAL_DEN_API_URL?.trim());
const mysqlOpen = daytona || attached || await localMysqlIsRunning();
const redisOpen = daytona || attached || await localRedisIsRunning();
const title = !mysqlOpen
  ? "declarative MCP connection API skipped — needs MySQL on 127.0.0.1:3306"
  : !redisOpen
    ? "declarative MCP connection API skipped — needs Redis on 127.0.0.1:6379"
    : "an admin declaratively creates, replaces, reads, orders, conditionally updates, and deletes MCP connections by external key";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object: ${JSON.stringify(value)}`);
  return value;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") throw new Error(`${field} was not a string: ${JSON.stringify(record)}`);
  return value;
}

function orgHeaders(session: DenSession, orgId: string): Record<string, string> {
  return { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId };
}

async function organizationId(admin: DenSession, organizationName: string): Promise<string> {
  const result = await denFetch(admin, "/v1/me/orgs", { headers: { authorization: `Bearer ${admin.token}` } });
  const organizations = isRecord(result.body) && Array.isArray(result.body.orgs) ? result.body.orgs.filter(isRecord) : [];
  const organization = organizations.find((entry) => entry.name === organizationName);
  const id = organization && typeof organization.id === "string" ? organization.id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding the test organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

test.skipIf(!mysqlOpen || !redisOpen)(title, { timeout: 300_000 }, async ({ evidence, place }) => {
  const stamp = Date.now();
  const organizationName = `MCP External Key ${stamp}`;
  const key = `provisioned-jira-${stamp}`;
  const secondKey = `${key}-2`;
  const firstName = `Provisioned Jira ${stamp}`;
  const replacedName = `Provisioned Jira Updated ${stamp}`;

  await using den = await server({
    place,
    web: false,
    mocks: { connector: mcpMock({ port: 3984, allowUnauthenticatedMcp: true }) },
    org: { name: organizationName, members: {} },
  });
  const admin = den.admin;
  const connector = den.mocks.connector;
  const orgId = await organizationId(admin, organizationName);
  const headers = orgHeaders(admin, orgId);
  const body = {
    name: firstName,
    url: connector.mcpUrl,
    authType: "none",
    credentialMode: "shared",
    access: { orgWide: true },
  };

  async function manageableConnections(): Promise<Record<string, unknown>[]> {
    const result = await denFetch(admin, "/v1/mcp-connections?scope=manageable", { headers });
    expect(result.response.status, result.text).toBe(200);
    return isRecord(result.body) && Array.isArray(result.body.connections)
      ? result.body.connections.filter(isRecord)
      : [];
  }

  const first = await denFetch(admin, `/v1/mcp-connections/by-key/${key}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
  const firstResponse = requireRecord(first.body, "First PUT response");
  const id1 = stringField(firstResponse, "id");
  expect(first.response.status, first.text).toBe(201);
  expect(first.response.status).not.toBe(200);
  expect(firstResponse.externalKey).toBe(key);
  expect(id1).toMatch(/^emc_/);
  expect(id1).not.toBe("");
  evidence.recordAssertionEvidence(
    "1. The first declarative PUT creates a keyed MCP connection",
    `PUT by-key/${key} returned status=${first.response.status}, id=${id1}, externalKey=${String(firstResponse.externalKey)}; it did not return update status 200 or an empty id.`,
    first.response.status === 201 && firstResponse.externalKey === key && id1.startsWith("emc_") && id1 !== "",
  );

  const second = await denFetch(admin, `/v1/mcp-connections/by-key/${key}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ ...body, name: replacedName }),
  });
  const secondResponse = requireRecord(second.body, "Second PUT response");
  expect(second.response.status, second.text).toBe(200);
  expect(second.response.status).not.toBe(201);
  expect(secondResponse.id).toBe(id1);
  expect(secondResponse.name).toBe(replacedName);
  expect(secondResponse.name).not.toBe(firstName);
  expect(secondResponse.externalKey).toBe(key);
  const afterReplace = await manageableConnections();
  const keyedAfterReplace = afterReplace.filter((row) => row.externalKey === key);
  const namedAfterReplace = afterReplace.filter((row) => row.name === firstName || row.name === replacedName);
  expect(keyedAfterReplace).toHaveLength(1);
  expect(namedAfterReplace).toHaveLength(1);
  evidence.recordAssertionEvidence(
    "2. A second PUT replaces the keyed connection without duplicating it",
    `Second PUT returned status=${second.response.status}, id=${String(secondResponse.id)}, name=${String(secondResponse.name)}, externalKey=${String(secondResponse.externalKey)}; manageable counts were key=${keyedAfterReplace.length}, either-name=${namedAfterReplace.length}, not create status 201 or the old name.`,
    second.response.status === 200 && secondResponse.id === id1 && secondResponse.name === replacedName
      && secondResponse.externalKey === key && keyedAfterReplace.length === 1 && namedAfterReplace.length === 1,
  );

  const duplicatePost = await denFetch(admin, "/v1/mcp-connections", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, externalKey: key }),
  });
  const duplicateResponse = requireRecord(duplicatePost.body, "Duplicate POST response");
  expect(duplicatePost.response.status, duplicatePost.text).toBe(409);
  expect(duplicatePost.response.status).not.toBe(200);
  expect(duplicateResponse.error).toBe("external_key_exists");
  const duplicateMessage = stringField(duplicateResponse, "message");
  expect(duplicateMessage).toContain(id1);
  const afterDuplicate = await manageableConnections();
  const duplicateKeyCount = afterDuplicate.filter((row) => row.externalKey === key).length;
  expect(duplicateKeyCount).toBe(1);
  expect(duplicateKeyCount).not.toBeGreaterThan(1);
  evidence.recordAssertionEvidence(
    "3. POST rejects an external key already owned by a connection",
    `POST returned status=${duplicatePost.response.status}, error=${String(duplicateResponse.error)}, message=${duplicateMessage}; manageable key count remained ${duplicateKeyCount}, not greater than one.`,
    duplicatePost.response.status === 409 && duplicateResponse.error === "external_key_exists"
      && duplicateMessage.includes(id1) && duplicateKeyCount === 1,
  );

  const getExisting = await denFetch(admin, `/v1/mcp-connections/${id1}`, { headers });
  const existingResponse = requireRecord(getExisting.body, "Existing GET response");
  expect(getExisting.response.status, getExisting.text).toBe(200);
  expect(getExisting.response.status).not.toBe(404);
  expect(existingResponse.id).toBe(id1);
  expect(existingResponse.externalKey).toBe(key);
  const unknownId = "emc_00000000000000000000000000";
  const getUnknown = await denFetch(admin, `/v1/mcp-connections/${unknownId}`, { headers });
  const unknownResponse = requireRecord(getUnknown.body, "Unknown GET response");
  expect(getUnknown.response.status, getUnknown.text).toBe(404);
  expect(getUnknown.response.status).not.toBe(200);
  expect(unknownResponse.error).toBe("connection_not_found");
  evidence.recordAssertionEvidence(
    "4. Direct GET distinguishes an existing keyed connection from a well-formed unknown id",
    `GET ${id1} returned status=${getExisting.response.status}, id=${String(existingResponse.id)}, externalKey=${String(existingResponse.externalKey)}; GET ${unknownId} returned status=${getUnknown.response.status}, error=${String(unknownResponse.error)}, not 200.`,
    getExisting.response.status === 200 && existingResponse.id === id1 && existingResponse.externalKey === key
      && getUnknown.response.status === 404 && unknownResponse.error === "connection_not_found",
  );

  const createSecond = await denFetch(admin, `/v1/mcp-connections/by-key/${secondKey}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ ...body, name: `${firstName} Second` }),
  });
  const createSecondResponse = requireRecord(createSecond.body, "Second connection PUT response");
  const id2 = stringField(createSecondResponse, "id");
  expect(createSecond.response.status, createSecond.text).toBe(201);
  expect(createSecond.response.status).not.toBe(200);
  const afterSecondCreate = await manageableConnections();
  const orderedKeys = afterSecondCreate
    .filter((row) => row.externalKey === key || row.externalKey === secondKey)
    .map((row) => row.externalKey);
  expect(orderedKeys).toEqual([key, secondKey]);
  expect(orderedKeys).not.toEqual([secondKey, key]);
  evidence.recordAssertionEvidence(
    "5. Manageable connections preserve ascending creation order",
    `Second keyed PUT returned status=${createSecond.response.status}, id=${id2}; filtering the manageable list to both keys returned ${JSON.stringify(orderedKeys)}, not ${JSON.stringify([secondKey, key])}.`,
    createSecond.response.status === 201 && JSON.stringify(orderedKeys) === JSON.stringify([key, secondKey]),
  );

  const staleUpdate = await denFetch(admin, `/v1/mcp-connections/by-key/${secondKey}`, {
    method: "PUT",
    headers: { ...headers, "If-Match": "2000-01-01T00:00:00.000Z" },
    body: JSON.stringify({ ...body, name: `${firstName} Second Stale` }),
  });
  const staleResponse = requireRecord(staleUpdate.body, "Stale PUT response");
  expect(staleUpdate.response.status, staleUpdate.text).toBe(409);
  expect(staleUpdate.response.status).not.toBe(200);
  expect(staleResponse.error).toBe("connection_conflict");
  const getSecond = await denFetch(admin, `/v1/mcp-connections/${id2}`, { headers });
  const secondConnection = requireRecord(getSecond.body, "Second connection GET response");
  expect(getSecond.response.status, getSecond.text).toBe(200);
  const currentUpdatedAt = stringField(secondConnection, "updatedAt");
  const currentUpdate = await denFetch(admin, `/v1/mcp-connections/by-key/${secondKey}`, {
    method: "PUT",
    headers: { ...headers, "If-Match": currentUpdatedAt },
    body: JSON.stringify({ ...body, name: `${firstName} Second Current` }),
  });
  const currentResponse = requireRecord(currentUpdate.body, "Current PUT response");
  expect(currentUpdate.response.status, currentUpdate.text).toBe(200);
  expect(currentUpdate.response.status).not.toBe(409);
  expect(currentResponse.id).toBe(id2);
  evidence.recordAssertionEvidence(
    "7. If-Match rejects stale replacement and accepts the latest updatedAt",
    `Stale If-Match returned status=${staleUpdate.response.status}, error=${String(staleResponse.error)}; GET returned updatedAt=${currentUpdatedAt}, whose If-Match returned status=${currentUpdate.response.status}, id=${String(currentResponse.id)}, not conflict 409.`,
    staleUpdate.response.status === 409 && staleResponse.error === "connection_conflict"
      && currentUpdate.response.status === 200 && currentResponse.id === id2,
  );

  const firstDelete = await denFetch(admin, `/v1/mcp-connections/by-key/${key}`, { method: "DELETE", headers });
  const firstDeleteResponse = requireRecord(firstDelete.body, "First DELETE response");
  expect(firstDelete.response.status, firstDelete.text).toBe(200);
  expect(firstDeleteResponse).toMatchObject({ ok: true, deleted: true });
  const repeatDelete = await denFetch(admin, `/v1/mcp-connections/by-key/${key}`, { method: "DELETE", headers });
  const repeatDeleteResponse = requireRecord(repeatDelete.body, "Repeated DELETE response");
  expect(repeatDelete.response.status, repeatDelete.text).toBe(200);
  expect(repeatDeleteResponse).toMatchObject({ ok: true, deleted: false });
  expect(repeatDeleteResponse.deleted).not.toBe(true);
  const afterDelete = await manageableConnections();
  const deletedKeyCount = afterDelete.filter((row) => row.externalKey === key).length;
  const retainedKeyCount = afterDelete.filter((row) => row.externalKey === secondKey).length;
  expect(deletedKeyCount).toBe(0);
  expect(retainedKeyCount).toBe(1);
  expect(retainedKeyCount).not.toBe(0);
  const cleanup = await denFetch(admin, `/v1/mcp-connections/by-key/${secondKey}`, { method: "DELETE", headers });
  const cleanupResponse = requireRecord(cleanup.body, "Cleanup DELETE response");
  expect(cleanup.response.status, cleanup.text).toBe(200);
  expect(cleanupResponse).toMatchObject({ ok: true, deleted: true });
  evidence.recordAssertionEvidence(
    "6. DELETE by external key is idempotent and does not remove another key",
    `First DELETE returned ${JSON.stringify(firstDeleteResponse)}; repeat returned ${JSON.stringify(repeatDeleteResponse)}; manageable counts became deleted-key=${deletedKeyCount}, retained-key=${retainedKeyCount}; cleanup returned ${JSON.stringify(cleanupResponse)}.`,
    firstDeleteResponse.ok === true && firstDeleteResponse.deleted === true
      && repeatDeleteResponse.ok === true && repeatDeleteResponse.deleted === false
      && deletedKeyCount === 0 && retainedKeyCount === 1
      && cleanupResponse.ok === true && cleanupResponse.deleted === true,
  );
});

// This is the same provisioning journey extended across the org configuration,
// not one test per endpoint. All observations cross the public HTTP boundary.
test.skipIf(!mysqlOpen || !redisOpen)("an API-key client reapplies and changes an organization manifest without duplicating resources or changing unrelated identities", { timeout: 300_000 }, async ({ evidence, place }) => {
  const stamp = Date.now();
  const name = `Declarative org ${stamp}`;
  await using den = await server({ place, web: false, org: { name, members: { reader: {} } }, env: { DEN_PLAN_GATING_ENABLED: "false" } });
  const admin = den.admin;
  const orgId = await organizationId(admin, name);
  const sessionHeaders = orgHeaders(admin, orgId);
  const minted = await denFetch(admin, "/v1/api-keys", { method: "POST", headers: sessionHeaders, body: JSON.stringify({ name: "Declarative provisioning witness" }) });
  expect(minted.response.status, minted.text).toBe(201);
  const headers = { "x-api-key": stringField(requireRecord(minted.body, "API key response"), "key") };
  const providerSecret = "declarative-witness-secret";
  const key = `config-${stamp}`;
  const base = (resource: string) => `/v1/${resource}/by-key/${key}`;
  async function request(path: string, method = "GET", body?: unknown, auth = headers) {
    return denFetch(admin, path, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  }
  async function put(resource: string, body: unknown, status: number) {
    const result = await request(base(resource), "PUT", body);
    expect(result.response.status, `${resource}: ${result.text}`).toBe(status);
    expect(result.text).not.toContain(providerSecret);
    return requireRecord(result.body, resource);
  }
  function item(body: Record<string, unknown>, field: string) { return requireRecord(body[field], field); }
  const team1 = item(await put("teams", { name: "Platform", memberIds: [] }, 201), "team");
  const teamId = stringField(team1, "id");
  const providerInput = {
    name: "Inference", source: "custom", apiKey: providerSecret,
    customConfig: { id: "declarative", name: "Declarative", npm: "@ai-sdk/openai-compatible", env: ["DECLARATIVE_API_KEY"], api: "https://inference.eval.invalid/v1", models: [{ id: "witness", name: "Witness", limit: { context: 32000, input: 32000, output: 32000 } }] },
    teamIds: [teamId],
  };
  const policyInput = { policyName: "Managed desktop", policy: { allowZenModel: false }, teamIds: [teamId], priority: 10, isEnabled: true };
  const marketInput = { name: "Internal catalog", description: "First revision" };
  const provider1 = item(await put("llm-providers", providerInput, 201), "llmProvider");
  const policy1 = item(await put("desktop-policies", policyInput, 201), "desktopPolicy");
  const marketplace1 = item(await put("marketplaces", marketInput, 201), "item");
  const resources = [
    { resource: "teams", field: "team", input: { name: "Platform", memberIds: [] }, original: team1 },
    { resource: "llm-providers", field: "llmProvider", input: providerInput, original: provider1 },
    { resource: "desktop-policies", field: "desktopPolicy", input: policyInput, original: policy1 },
    { resource: "marketplaces", field: "item", input: marketInput, original: marketplace1 },
  ];
  for (const entry of resources) {
    const repeated = item(await put(entry.resource, entry.input, 200), entry.field);
    expect(repeated.id).toBe(entry.original.id);
    expect(repeated.externalKey).toBe(key);
    const read = await request(base(entry.resource));
    expect(read.response.status, read.text).toBe(200);
    expect(read.text).not.toContain(providerSecret);
    expect(item(requireRecord(read.body, "read"), entry.field).id).toBe(entry.original.id);
    const direct = await request(`/v1/${entry.resource}/${entry.original.id}`);
    expect(direct.response.status, direct.text).toBe(200);
    expect(direct.text).not.toContain(providerSecret);
  }
  const lists = [
    ["/v1/org", "teams", "name", "Platform"],
    ["/v1/llm-providers?scope=manageable", "llmProviders", "name", "Inference"],
    ["/v1/desktop-policies", "desktopPolicies", "policyName", "Managed desktop"],
    ["/v1/marketplaces?limit=100", "items", "name", "Internal catalog"],
  ];
  for (const [path, field, nameField, label] of lists) {
    const listing = await request(path);
    expect(listing.response.status, listing.text).toBe(200);
    const rows = requireRecord(listing.body, path)[field];
    expect(Array.isArray(rows), path).toBe(true);
    if (!Array.isArray(rows)) throw new Error(`Missing list ${path}`);
    expect(rows.filter((row) => isRecord(row) && row[nameField] === label), path).toHaveLength(1);
  }
  const providerRead = await request(base("llm-providers"));
  const access = requireRecord(item(requireRecord(providerRead.body, "provider"), "llmProvider").access, "access");
  expect(access.teams).toEqual(expect.arrayContaining([expect.objectContaining({ teamId })]));
  evidence.recordAssertionEvidence("A multi-resource manifest converges through API-key-only authentication", "Teams, providers, policies, and marketplaces returned 201 then 200 with the same IDs and stable keys; both keyed and ID reads succeeded without exposing the provider secret; the provider referenced the created team.", true);

  // Retain an independently managed identity while changing all manifest labels.
  const sibling = await request("/v1/teams", "POST", { name: "Unmanaged team" });
  expect(sibling.response.status, sibling.text).toBe(201);
  const siblingId = stringField(item(requireRecord(sibling.body, "sibling"), "team"), "id");
  const renamed = item(await put("teams", { name: "Platform renamed" }, 200), "team");
  expect(renamed.id).toBe(teamId);
  expect(renamed.name).toBe("Platform renamed");
  const withoutSecret = { ...providerInput, apiKey: undefined };
  const provider2 = item(await put("llm-providers", { ...withoutSecret, name: "Inference renamed", teamIds: [] }, 200), "llmProvider");
  expect(provider2.id).toBe(provider1.id);
  expect(provider2.hasApiKey).toBe(true);
  const policy2 = item(await put("desktop-policies", { policyName: "Desktop renamed", policy: { allowZenModel: true } }, 200), "desktopPolicy");
  expect(policy2.id).toBe(policy1.id);
  expect(policy2.priority).toBe(0);
  expect(policy2.assignments).toEqual([]);
  expect(policy2.policy).toMatchObject({ allowZenModel: true });
  const market2 = item(await put("marketplaces", { name: "Catalog renamed" }, 200), "item");
  expect(market2.id).toBe(marketplace1.id);
  expect(market2.description).toBeNull();
  const afterProvider = item(requireRecord((await request(base("llm-providers"))).body, "provider"), "llmProvider");
  expect(requireRecord(afterProvider.access, "access").teams).toEqual([]);
  const siblingRead = await request(`/v1/teams/${siblingId}`);
  expect(item(requireRecord(siblingRead.body, "sibling"), "team").name).toBe("Unmanaged team");
  evidence.recordAssertionEvidence("Changing desired state preserves identity and replaces assignments", "All four renamed resources retained their IDs, removed provider/policy team assignments disappeared, policy priority reset to zero, marketplace description cleared, omitted provider credentials remained configured, and the unmanaged team was unchanged.", true);

  // Name collision does not adopt an unmanaged team or damage the keyed team.
  const conflict = await request(base("teams"), "PUT", { name: "Unmanaged team" });
  expect(conflict.response.status).toBe(409);
  const stillRenamed = await request(base("teams"));
  expect(item(requireRecord(stillRenamed.body, "team"), "team").name).toBe("Platform renamed");
  for (const entry of resources) {
    const denied = await request(base(entry.resource), "PUT", entry.input, orgHeaders(den.members.reader, orgId));
    expect(denied.response.status, denied.text).toBe(403);
    const invalid = await request(`/v1/${entry.resource}/by-key/INVALID`, "PUT", entry.input);
    expect(invalid.response.status).toBe(400);
    const conditional = await request(base(entry.resource), "PUT", entry.input, { ...headers, "If-Match": "stale" });
    expect(conditional.response.status, conditional.text).toBe(400);
    const absent = await request(`/v1/${entry.resource}/by-key/missing-${stamp}`);
    expect(absent.response.status).toBe(404);
  }
  evidence.recordAssertionEvidence("Invalid or unauthorized writes cannot overwrite managed resources", "Existing-name collision returned 409 without changing the team; members were denied on all four PUT routes, invalid keys and unsupported preconditions returned 400, and unknown keyed reads returned 404.", true);

  // Concurrent first applies must converge too, including under the unique-name
  // constraint on teams. This observes persistence, not just response status.
  for (const entry of resources) {
    const concurrentPath = `/v1/${entry.resource}/by-key/race-${stamp}`;
    const raceBody = { ...entry.input, name: `Concurrent ${entry.resource}`, policyName: "Concurrent desktop" };
    const race = await Promise.all([request(concurrentPath, "PUT", raceBody), request(concurrentPath, "PUT", raceBody)]);
    // Team name checks can see the winning row before the insert is attempted.
    for (const result of race) expect([200, 201, 409]).toContain(result.response.status);
    const recovered = await request(concurrentPath, "PUT", raceBody);
    expect(recovered.response.status, recovered.text).toBe(200);
    const raceRead = await request(concurrentPath);
    expect(item(requireRecord(raceRead.body, "race"), entry.field).id).toBe(item(requireRecord(recovered.body, "recovered"), entry.field).id);
    const removeRace = await request(concurrentPath, "DELETE");
    expect(removeRace.response.status, removeRace.text).toBe(200);
  }
  evidence.recordAssertionEvidence("Concurrent first applies recover without a second identity", "Two concurrent creates per resource completed with success or conflict; a retry updated the persisted identity and keyed reads returned that same ID.", true);

  for (const entry of resources) {
    const legacyBody = { ...entry.input, name: `Legacy ${entry.resource}`, policyName: "Legacy desktop" };
    const created = await request(`/v1/${entry.resource}`, "POST", legacyBody);
    expect(created.response.status, created.text).toBe(201);
    const legacy = item(requireRecord(created.body, "legacy create"), entry.field);
    expect(legacy.externalKey).toBeNull();
    const changed = await request(`/v1/${entry.resource}/${legacy.id}`, "PATCH", { ...legacyBody, name: `Legacy updated ${entry.resource}`, policyName: "Legacy updated desktop" });
    expect(changed.response.status, changed.text).toBe(200);
    expect(item(requireRecord(changed.body, "legacy update"), entry.field).id).toBe(legacy.id);
    const deleted = entry.resource === "marketplaces"
      ? await request(`/v1/marketplaces/${legacy.id}/delete`, "POST")
      : await request(`/v1/${entry.resource}/${legacy.id}`, "DELETE");
    expect(deleted.response.status, deleted.text).toBe(entry.resource === "marketplaces" ? 200 : 204);
    const managed = await request(base(entry.resource));
    expect(item(requireRecord(managed.body, "managed"), entry.field).id).toBe(entry.original.id);
  }
  evidence.recordAssertionEvidence("Existing unkeyed clients retain their create, update, and delete workflow", "POST created unkeyed resources, PATCH updated the same IDs, and original deletion routes succeeded for each resource while keyed resources remained intact.", true);

  const otherOrg = await request("/v1/org", "POST", { name: `Other org ${stamp}` }, sessionHeaders);
  expect(otherOrg.response.status, otherOrg.text).toBe(201);
  const otherId = stringField(item(requireRecord(otherOrg.body, "other org"), "organization"), "id");
  const otherMint = await request("/v1/api-keys", "POST", { name: "Other org provisioning" }, orgHeaders(admin, otherId));
  expect(otherMint.response.status, otherMint.text).toBe(201);
  const otherAuth = { "x-api-key": stringField(requireRecord(otherMint.body, "other key"), "key") };
  for (const entry of resources) {
    const missing = await request(base(entry.resource), "GET", undefined, otherAuth);
    expect(missing.response.status).toBe(404);
    const other = await request(base(entry.resource), "PUT", { ...entry.input, teamIds: [] }, otherAuth);
    expect(other.response.status, other.text).toBe(201);
    expect(item(requireRecord(other.body, "other resource"), entry.field).id).not.toBe(entry.original.id);
    const original = await request(base(entry.resource));
    expect(item(requireRecord(original.body, "original resource"), entry.field).id).toBe(entry.original.id);
  }
  const crossOrgReference = await request(base("desktop-policies"), "PUT", policyInput, otherAuth);
  expect(crossOrgReference.response.status, crossOrgReference.text).toBe(404);
  evidence.recordAssertionEvidence("Stable keys and references are isolated by organization", "A second API key could not read the first org's keyed resources; the same keys created distinct IDs in its own org; the first org's IDs were preserved, and assigning its team in the other org was rejected.", true);

  // Reverse dependency order. A repeat deletion reports absence, and unrelated
  // resources survive. Recreating a deleted identity is supported.
  for (const entry of [...resources].reverse()) {
    const removed = await request(base(entry.resource), "DELETE");
    expect(removed.response.status, removed.text).toBe(200);
    expect(removed.body).toMatchObject({ ok: true, deleted: true });
    const repeat = await request(base(entry.resource), "DELETE");
    expect(repeat.body).toMatchObject({ ok: true, deleted: false });
    const absent = await request(base(entry.resource));
    expect(absent.response.status).toBe(404);
  }
  expect((await request(`/v1/teams/${siblingId}`)).response.status).toBe(200);
  const recreated = item(await put("desktop-policies", { policyName: "Recreated", policy: {} }, 201), "desktopPolicy");
  expect(recreated.id).not.toBe(policy1.id);
  await request(base("desktop-policies"), "DELETE");
  evidence.recordAssertionEvidence("Teardown is repeatable and scoped to the manifest", "Reverse-order deletion removed each managed resource; repeated deletion reported deleted:false and reads returned 404; the unrelated team survived and a deleted policy key could be recreated with a new ID.", true);
});

test.skipIf(!mysqlOpen || !redisOpen)("the shipped manifest CLI provisions five resource types, resumes a partial apply, and tears down without secrets", { timeout: 300_000 }, async ({ evidence, place }) => {
  const orgName = `Manifest CLI ${Date.now()}`;
  await using den = await server({ place, web: false, org: { name: orgName, members: {} }, env: { DEN_PLAN_GATING_ENABLED: "false" }, mocks: { connector: mcpMock({ port: 3987, allowUnauthenticatedMcp: true }) } });
  const orgId = await organizationId(den.admin, orgName);
  const minted = await denFetch(den.admin, "/v1/api-keys", { method: "POST", headers: orgHeaders(den.admin, orgId), body: JSON.stringify({ name: "Manifest CLI witness" }) });
  expect(minted.response.status, minted.text).toBe(201);
  const apiKey = stringField(requireRecord(minted.body, "API key"), "key");
  const headers = { "x-api-key": apiKey };
  const secret = 'cli-witness-"quoted"\nsecond-line';
  const directory = await mkdtemp(join(tmpdir(), "openwork-manifest-cli-"));
  const file = join(directory, "organization.json");
  const client = fileURLToPath(new URL("../../examples/declarative-org/apply.mjs", import.meta.url));
  const manifest = {
    version: 1,
    teams: { platform: { name: "CLI platform", memberIds: [] } },
    llmProviders: { inference: { name: "CLI inference", source: "custom", apiKey: "${PROVISION_CLI_SECRET}", teams: ["platform"], customConfig: { id: "cli-inference", name: "CLI inference", npm: "@ai-sdk/openai-compatible", env: ["CLI_INFERENCE_KEY"], api: "https://inference.eval.invalid/v1", models: [{ id: "witness", name: "Witness", limit: { context: 32000, input: 32000, output: 32000 } }] } } },
    mcpConnections: { tools: { name: "CLI tools", url: den.mocks.connector.mcpUrl, authType: "none", access: { orgWide: true } } },
    desktopPolicies: { managed: { policyName: "CLI managed desktop", policy: { allowZenModel: false }, teams: ["platform"] } },
    marketplaces: { catalog: { name: "CLI catalog", description: "Initial description" } },
  };
  async function request(path: string, method = "GET", body?: unknown) {
    return denFetch(den.admin, path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  }
  async function cli(input: unknown, remove = false, credential: string | undefined = secret) {
    await writeFile(file, JSON.stringify(input), { mode: 0o600 });
    const result = await new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [client, file, ...(remove ? ["--delete"] : [])], {
        env: { ...process.env, DEN_API_URL: den.ref.apiUrl, DEN_API_KEY: apiKey, PROVISION_CLI_SECRET: credential },
        timeout: 45_000, maxBuffer: 1_000_000,
      }, (error, stdout, stderr) => resolve({ status: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout, stderr }));
    });
    expect(result.stdout + result.stderr).not.toContain(apiKey);
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(result.stdout + result.stderr).not.toContain(JSON.stringify(secret).slice(1, -1));
    return result;
  }
  async function snapshot() {
    const entries: Array<[string, string, string]> = [["teams", "platform", "team"], ["llm-providers", "inference", "llmProvider"], ["desktop-policies", "managed", "desktopPolicy"], ["marketplaces", "catalog", "item"]];
    const result = new Map<string, Record<string, unknown>>();
    for (const [resource, key, envelope] of entries) {
      const response = await request(`/v1/${resource}/by-key/${key}`);
      expect(response.response.status, response.text).toBe(200);
      expect(response.text).not.toContain(secret);
      expect(response.text).not.toContain(JSON.stringify(secret).slice(1, -1));
      result.set(resource, requireRecord(requireRecord(response.body, resource)[envelope], envelope));
    }
    const connections = await request("/v1/mcp-connections?scope=manageable");
    expect(connections.response.status, connections.text).toBe(200);
    const rows = requireRecord(connections.body, "connections").connections;
    if (!Array.isArray(rows)) throw new Error("Missing connections list");
    const keyed = rows.filter((row) => isRecord(row) && row.externalKey === "tools");
    expect(keyed).toHaveLength(1);
    result.set("mcp-connections", requireRecord(keyed[0], "MCP"));
    return result;
  }
  try {
    const unrelated = await request("/v1/teams", "POST", { name: "Outside this manifest" });
    expect(unrelated.response.status, unrelated.text).toBe(201);
    const unrelatedId = stringField(requireRecord(requireRecord(unrelated.body, "unrelated").team, "team"), "id");

    // The real client fails after creating the team. A corrected retry must use
    // that team rather than require cleanup or create another identity.
    const broken = { ...manifest, llmProviders: { inference: { ...manifest.llmProviders.inference, source: "invalid" } } };
    const partial = await cli(broken);
    expect(partial.status).not.toBe(0);
    expect(partial.stdout).toContain("created teams/platform");
    expect((await request("/v1/llm-providers/by-key/inference")).response.status).toBe(404);
    const partialTeam = await request("/v1/teams/by-key/platform");
    const partialId = stringField(requireRecord(requireRecord(partialTeam.body, "partial").team, "team"), "id");
    const recovered = await cli(manifest);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(recovered.stdout).toContain("updated teams/platform");
    const first = await snapshot();
    expect(first.get("teams")?.id).toBe(partialId);
    const connected = await request(`/v1/llm-providers/${first.get("llm-providers")?.id}/connect`);
    expect(connected.response.status).toBe(200);
    const runtimeProvider = requireRecord(requireRecord(connected.body, "runtime configuration").llmProvider, "provider");
    expect(runtimeProvider.apiKey === secret, "The runtime credential must exactly match the environment value, including quotes and newline").toBe(true);
    const repeated = await cli(manifest);
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(repeated.stdout.match(/^updated /gm)).toHaveLength(5);
    expect(repeated.stdout).not.toContain("created ");
    const second = await snapshot();
    for (const [resource, row] of first) expect(second.get(resource)?.id).toBe(row.id);
    const providerAccess = requireRecord(first.get("llm-providers")?.access, "provider access");
    expect(providerAccess.teams).toEqual(expect.arrayContaining([expect.objectContaining({ teamId: partialId })]));
    expect(first.get("desktop-policies")?.assignments).toEqual(expect.arrayContaining([expect.objectContaining({ teamId: partialId })]));
    evidence.recordAssertionEvidence("The real CLI resumes partial provisioning and converges all five resources", "The invalid provider stopped the client after team creation; correcting the manifest retained that team ID, resolved provider and policy team references, delivered the exact quoted/newline environment credential to the runtime API, and a repeat run updated all five IDs without another create.", true);

    manifest.teams.platform.name = "CLI platform renamed";
    manifest.llmProviders.inference.teams = [];
    manifest.desktopPolicies.managed.teams = [];
    manifest.desktopPolicies.managed.policy.allowZenModel = true;
    const changed = await cli(manifest);
    expect(changed.status, changed.stderr).toBe(0);
    const after = await snapshot();
    for (const [resource, row] of first) expect(after.get(resource)?.id).toBe(row.id);
    expect(after.get("teams")?.name).toBe("CLI platform renamed");
    expect(requireRecord(after.get("llm-providers")?.access, "provider access").teams).toEqual([]);
    expect(after.get("desktop-policies")?.assignments).toEqual([]);
    expect(after.get("desktop-policies")?.policy).toMatchObject({ allowZenModel: true });
    evidence.recordAssertionEvidence("Manifest edits change assignments without changing resource identity", "The client renamed the team, removed provider/policy team assignments, and changed the policy flag while all five resource IDs stayed stable.", true);

    const invalid = { ...manifest, teams: { ...manifest.teams, unwritten: { name: "Must not be created" } }, llmProviders: { inference: { ...manifest.llmProviders.inference, teams: ["missing"] } } };
    const rejected = await cli(invalid);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stdout).toBe("");
    expect(rejected.stderr).toContain("Unknown team reference");
    expect((await request("/v1/teams/by-key/unwritten")).response.status).toBe(404);
    const missingSecret = await cli(manifest, false, "");
    expect(missingSecret.status).not.toBe(0);
    expect(missingSecret.stdout).toBe("");
    expect(missingSecret.stderr).toContain("Missing environment variable");
    const afterRejected = await snapshot();
    for (const [resource, row] of after) expect(afterRejected.get(resource)?.updatedAt).toBe(row.updatedAt);
    evidence.recordAssertionEvidence("CLI preflight failures cause no provisioning writes or credential logging", "An unknown team reference and missing environment secret both failed before any progress output; the extra desired team was absent and all existing resource timestamps were unchanged. Every invocation's stdout/stderr was checked for API-key and provider-secret leakage.", true);

    const removed = await cli(manifest, true, "");
    expect(removed.status, removed.stderr).toBe(0);
    expect(removed.stdout.match(/^deleted /gm)).toHaveLength(5);
    const repeatDelete = await cli(manifest, true, "");
    expect(repeatDelete.status, repeatDelete.stderr).toBe(0);
    for (const [resource, key] of [["teams", "platform"], ["llm-providers", "inference"], ["desktop-policies", "managed"], ["marketplaces", "catalog"]]) {
      expect((await request(`/v1/${resource}/by-key/${key}`)).response.status).toBe(404);
    }
    expect((await request(`/v1/mcp-connections/${first.get("mcp-connections")?.id}`)).response.status).toBe(404);
    expect((await request(`/v1/teams/${unrelatedId}`)).response.status).toBe(200);
    evidence.recordAssertionEvidence("CLI teardown is repeatable without provider credentials and preserves unrelated state", "Both --delete invocations exited successfully with the provider secret unset; all five managed resources were absent and the unrelated team remained accessible.", true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
