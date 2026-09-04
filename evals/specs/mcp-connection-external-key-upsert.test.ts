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
