import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected a receipt object");
  return value;
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected receipt array");
  return value.map(record);
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected receipt string");
  return value;
}

const originalText = await readFile(new URL("../../reports/mcp-put-by-key-transcript-2026-09-14.json", import.meta.url), "utf8");
const transcript = record(JSON.parse(originalText));
const receipts = records(transcript.requests);
const tenantTranscript = record(JSON.parse(await readFile(new URL("../../reports/mcp-put-by-key-tenant-transcript-2026-09-14.json", import.meta.url), "utf8")));
const tenantReceipts = records(tenantTranscript.requests);

function receipt(label: string, source = receipts) {
  const matches = source.filter((row) => row.label === label);
  expect(matches, label).toHaveLength(1);
  const match = matches[0];
  if (!match) throw new Error(`Missing receipt: ${label}`);
  return match;
}

function response(label: string, status: number, source = receipts) {
  const row = record(receipt(label, source).response);
  expect(row.status, label).toBe(status);
  return record(row.body);
}

function requestBody(label: string) {
  return record(record(receipt(label).request).body);
}

function listed(label: string) {
  return records(response(label, 200).connections);
}

const firstId = text(record(record(receipt("case1-create").response).body).id);

test("recorded release receipts identify the pinned image and API-key-only proof boundary", async ({ evidence }) => {
  expect(transcript.kind).toBe("recorded-release-blackbox");
  const inspection = record(transcript.inspection);
  expect(inspection.containerImage).toBe("ghcr.io/different-ai/openwork-den-api@sha256:e254a3842e7ecb6d0c7128b5f17201e92ac4ee566ad82c70c468938a3faa6407");
  expect(inspection.composeSha256).toBe("7b94efe1ac4be68d56b8ecb91206e9c005360b0f7954ba36c6f6ae7bd87a9430");
  expect(record(inspection.labels)["org.opencontainers.image.version"]).toBe("0.18.46");
  for (const row of receipts.filter((row) => /^(case|recipe-)/.test(text(row.label)))) {
    const headers = record(record(row.request).headers);
    expect(headers).not.toHaveProperty("Authorization");
    expect(headers).not.toHaveProperty("Cookie");
    if (!text(row.label).startsWith("case8-no-key")) expect(headers["x-api-key"]).toBe("[REDACTED]");
  }
  evidence.recordAssertionEvidence("Recorded release provenance", "Pinned 0.18.46 image, unchanged evaluation Compose, no session headers in proof requests; this spec does not run current source.", true);
});

test("recorded release cases 1-2 create then converge to exactly one keyed ID", async ({ evidence }) => {
  expect(response("case1-create", 201)).toMatchObject({ id: firstId, externalKey: "rs-proof-1", authType: "none" });
  expect(firstId).toMatch(/^emc_/);
  expect(requestBody("case2-identical")).toEqual(requestBody("case1-create"));
  expect(response("case2-identical", 200).id).toBe(firstId);
  const matching = listed("case2-list").filter((row) => row.externalKey === "rs-proof-1");
  expect(matching).toHaveLength(1);
  expect(matching[0]?.id).toBe(firstId);
  evidence.recordAssertionEvidence("Recorded keyed convergence", "201 then identical PUT 200, same ID, exactly one manageable list entry.", true);
});

test("recorded release case 3 preserves identity while omitted access widens team scope", async ({ evidence }) => {
  const teamId = record(response("case3-create-team", 201).team).id;
  const scoped = { orgWide: false, memberIds: [], teamIds: [teamId] };
  const wide = { orgWide: true, memberIds: [], teamIds: [] };
  expect(response("case3-rename-team-access", 200)).toMatchObject({ id: firstId, name: "Release proof team scoped", access: scoped });
  expect(response("case3-read-team-access", 200).access).toEqual(scoped);
  expect(requestBody("case3-omit-access")).not.toHaveProperty("access");
  expect(response("case3-omit-access", 200)).toMatchObject({ id: firstId, name: "Release proof omitted access", access: wide });
  expect(response("case3-read-widened-access", 200).access).toEqual(wide);
  evidence.recordAssertionEvidence("Recorded access replacement", "Same ID; team-only grants replaced by org-wide access when access is omitted. This is a widening, not preservation.", true);
});

test("recorded release cases 4-5 reject duplicate POST and stale ID updates", async ({ evidence }) => {
  const duplicate = response("case4-duplicate-post", 409);
  expect(duplicate.error).toBe("external_key_exists");
  expect(duplicate.message).toContain("PUT /v1/mcp-connections/by-key/rs-proof-1");
  const previous = response("case5-get-id", 200);
  expect(requestBody("case5-update-id").expectedUpdatedAt).toBe(previous.updatedAt);
  const updated = response("case5-update-id", 200);
  expect(updated).toMatchObject({ id: firstId, name: "Release proof ID rename" });
  expect(updated.updatedAt).not.toBe(previous.updatedAt);
  expect(requestBody("case5-stale-update-id").expectedUpdatedAt).toBe(previous.updatedAt);
  response("case5-stale-update-id", 409);
  expect(response("case5-read-after-stale", 200)).toMatchObject({ id: firstId, name: updated.name, updatedAt: updated.updatedAt });
  evidence.recordAssertionEvidence("Recorded conflict behavior", "Duplicate POST points to keyed PUT; stale expectedUpdatedAt returns 409 and does not overwrite the successful rename.", true);
});

test("recorded release case 6 retains write-only bearer authentication after secret omission", async ({ evidence }) => {
  const secured = response("case6-secret-create", 201);
  expect(secured.authType).toBe("apikey");
  for (const label of ["case6-secret-create", "case6-secret-read", "case6-omit-secret", "case6-secret-read-after"]) {
    const row = response(label, label === "case6-secret-create" ? 201 : 200);
    expect(row.id).toBe(secured.id);
    expect(row).not.toHaveProperty("apiKey");
    expect(row).not.toHaveProperty("oauthClientSecret");
  }
  const checks = records(transcript.secretChecksBeforeRedaction);
  expect(checks).toHaveLength(4);
  for (const check of checks) expect(check).toMatchObject({ rawResponseContainsWitnessSecret: false, responseHasApiKeyField: false });
  expect(requestBody("case6-omit-secret")).not.toHaveProperty("apiKey");
  for (const field of ["url", "authType", "credentialMode"]) expect(requestBody("case6-omit-secret")[field]).toEqual(requestBody("case6-secret-create")[field]);
  for (const [label, nonce] of [["case6-call-before", "before-secret-omission"], ["case6-call-after", "after-secret-omission"]]) {
    if (!label || !nonce) throw new Error("Missing witness label");
    const result = record(response(label, 200).result);
    expect(result.isError).toBe(false);
    const content = records(result.content)[0];
    if (!content) throw new Error("Missing witness content");
    expect(JSON.parse(text(content.text))).toEqual({ authenticated: true, nonce });
  }
  const calls = records(transcript.witnessCalls).filter((row) => row.authenticated === true);
  expect(calls.map((row) => row.nonce)).toEqual(["before-secret-omission", "after-secret-omission"]);
  expect(calls[0]?.tokenId).toMatch(/^[0-9a-f]{16}$/);
  expect(calls[1]?.tokenId).toBe(calls[0]?.tokenId);
  expect(record(receipt("witness-unauthenticated-control").response).status).toBe(401);
  evidence.recordAssertionEvidence("Recorded secret retention", "Raw responses checked before redaction; two authenticated tools/call results with matching token fingerprints, and an unauthenticated 401 control.", true);
});

test("recorded release cases 7-8 recreate a new ID and reject missing API keys", async ({ evidence }) => {
  expect(response("case7-delete-key", 200)).toMatchObject({ ok: true, deleted: true });
  response("case7-deleted-get", 404);
  const recreated = response("case7-recreate", 201);
  expect(recreated.externalKey).toBe("rs-proof-1");
  expect(recreated.id).not.toBe(firstId);
  expect(recreated.id).toMatch(/^emc_/);
  response("case8-no-key-put", 401);
  response("case8-no-key-get", 401);
  expect(listed("case8-list-after-no-key").filter((row) => row.externalKey === "rs-proof-unauthorized")).toHaveLength(0);
  expect(listed("cleanup-list")).toHaveLength(0);
  evidence.recordAssertionEvidence("Recorded lifecycle and missing-key boundary", "DELETE 200, GET old ID 404, recreate 201 new ID; missing keys get 401 and do not create a row; cleanup list empty.", true);
});

test("recorded release recipe executes the exact three lines over verified HTTPS", async ({ evidence }) => {
  expect(receipt("tls-untrusted-control").curlExit).toBe(60);
  const first = response("recipe-first", 201);
  const second = response("recipe-second", 200);
  expect(second.id).toBe(first.id);
  expect(first.externalKey).toBe("platform-tools");
  const source = (await readFile(new URL("../fixtures/mcp-put-release-recipe.sh", import.meta.url), "utf8")).trimEnd().split("\n");
  expect(source).toHaveLength(3);
  for (const label of ["recipe-first", "recipe-second"]) {
    const row = receipt(label);
    expect(record(row.request).url).toBe("https://localhost:18443/v1/mcp-connections/by-key/platform-tools");
    expect(record(row.recipe)).toMatchObject({ verbatim: true, exit: 0, tlsVerification: true, lines: source });
    expect(source.join("\n")).toContain("--proto '=https'");
    expect(source.join("\n")).not.toContain("--insecure");
  }
  evidence.recordAssertionEvidence("Recorded verbatim HTTPS recipe", "Private CA trusted only through CURL_CA_BUNDLE; untrusted control curl exit 60; exact pipeline 201 then 200 with same ID and exit 0.", true);
});

test("original single-org provisioning refusal remains a configuration boundary, not an auth failure", () => {
  expect(response("setup-foreign-org-attempt", 409).error).toBe("single_org_mode");
  expect(record(transcript.coverage).foreignOrgId).toBe("not_executed_single_org_bootstrap_409");
});

test("supplemental released tenant receipts preserve original evidence and use distinct legitimate owners", async ({ evidence }) => {
  expect(receipts).toHaveLength(51);
  expect(createHash("sha256").update(originalText).digest("hex")).toBe("c5f6ca7feb2abf0ec2229630cb78f981dec0b0fe5ee06e5998a21fd6d131f6bc");
  expect(tenantTranscript.originalTranscriptSha256).toBe("c5f6ca7feb2abf0ec2229630cb78f981dec0b0fe5ee06e5998a21fd6d131f6bc");
  expect(tenantTranscript.kind).toBe("recorded-release-tenant-blackbox");
  expect(tenantTranscript.project).toBe("mcp-put-proof-release-tenant");
  const inspection = record(tenantTranscript.inspection);
  expect(inspection.containerImage).toBe(record(transcript.inspection).containerImage);
  expect(inspection.selectedEnvironment).toEqual({ DEN_ORG_MODE: "multi_org", DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: "true" });
  expect(inspection.baseComposeSha256).toBe(record(transcript.inspection).composeSha256);
  const identities = record(tenantTranscript.identities);
  expect(identities.userA).not.toBe(identities.userB);
  expect(identities.orgA).not.toBe(identities.orgB);
  const issuedKeyIds: string[] = [];
  for (const tenant of ["A", "B"]) {
    const signup = response(`tenant-${tenant}-signup`, 200, tenantReceipts);
    expect(record(signup.user).id).toBe(identities[`user${tenant}`]);
    const org = response(`tenant-${tenant}-create-org`, 201, tenantReceipts);
    expect(record(org.organization).id).toBe(identities[`org${tenant}`]);
    const read = response(`tenant-${tenant}-read-org`, 200, tenantReceipts);
    expect(record(read.currentMember)).toMatchObject({ userId: identities[`user${tenant}`], role: "owner", isOwner: true });
    expect(records(read.members)).toHaveLength(1);
    issuedKeyIds.push(text(record(response(`tenant-${tenant}-issue-key`, 201, tenantReceipts).apiKey).id));
  }
  expect(issuedKeyIds[0]).not.toBe(issuedKeyIds[1]);
  const proof = tenantReceipts.filter((row) => !/^tenant-[AB]-(signup|create-org|read-org|issue-key)$/.test(text(row.label)) && !text(row.label).startsWith("tenant-cleanup-"));
  expect(proof).toHaveLength(21);
  for (const row of proof) {
    const headers = record(record(row.request).headers);
    expect(headers).not.toHaveProperty("Authorization");
    expect(headers).not.toHaveProperty("Cookie");
    if (text(row.label).startsWith("tenant-missing-key-")) expect(headers).not.toHaveProperty("x-api-key");
    else expect(headers["x-api-key"]).toBe("[REDACTED]");
  }
  evidence.recordAssertionEvidence("Supplemental release tenant provenance", "Same pinned release, legitimate multi_org configuration, two different signup users/owner organizations/issued keys; original 51 receipts remain byte-identical and proof carries no sessions.", true);
});

test("released case 8 denies foreign IDs even with spoofed org headers and keeps same-key resources disjoint", async ({ evidence }) => {
  const source = response("tenant-source-create", 201, tenantReceipts);
  expect(source).toMatchObject({ name: "Tenant A source", externalKey: "rs-proof-tenant" });
  const identities = record(tenantTranscript.identities);
  expect(source.id).toBe(identities.sourceId);
  for (const prefix of ["foreign", "spoofed"]) {
    for (const method of ["get", "put", "delete"]) {
      const label = `tenant-${prefix}-${method}`;
      expect(response(label, 404, tenantReceipts).error).toBe("connection_not_found");
      const request = record(receipt(label, tenantReceipts).request);
      expect(request.method).toBe(method.toUpperCase());
      expect(request.url).toBe(`http://localhost:18789/v1/mcp-connections/${text(source.id)}`);
      if (prefix === "spoofed") expect(record(request.headers)["x-openwork-org-id"]).toBe(identities.orgA);
      if (method === "put") expect(record(request.body).expectedUpdatedAt).toBe(source.updatedAt);
    }
    expect(response(`tenant-source-after-${prefix}`, 200, tenantReceipts)).toMatchObject({ id: source.id, name: source.name, updatedAt: source.updatedAt });
  }
  expect(records(response("tenant-B-list-before-own-create", 200, tenantReceipts).connections)).toHaveLength(0);
  const own = response("tenant-own-same-key-create", 201, tenantReceipts);
  expect(own.externalKey).toBe(source.externalKey);
  expect(own.id).toBe(identities.ownId);
  expect(own.id).not.toBe(source.id);
  for (const [label, id] of [["tenant-A-list", source.id], ["tenant-B-list", own.id], ["tenant-B-spoofed-list", own.id], ["tenant-A-final-list", source.id], ["tenant-B-final-list", own.id]]) {
    const rows = records(response(text(label), 200, tenantReceipts).connections);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, externalKey: source.externalKey });
  }
  expect(record(record(receipt("tenant-B-spoofed-list", tenantReceipts).request).headers)["x-openwork-org-id"]).toBe(identities.orgA);
  response("tenant-source-owner-cannot-read-B", 404, tenantReceipts);
  for (const prefix of ["missing-key", "invalid-key"]) {
    response(`tenant-${prefix}-get`, 401, tenantReceipts);
    response(`tenant-${prefix}-put`, 401, tenantReceipts);
  }
  for (const tenant of ["A", "B"]) {
    expect(response(`tenant-cleanup-${tenant}`, 200, tenantReceipts)).toMatchObject({ ok: true, deleted: true });
    expect(records(response(`tenant-cleanup-${tenant}-list`, 200, tenantReceipts).connections)).toHaveLength(0);
    expect(record(receipt(`tenant-cleanup-${tenant}-revoke-key`, tenantReceipts).response).status).toBe(204);
    response(`tenant-cleanup-${tenant}-revoked-key-control`, 401, tenantReceipts);
  }
  evidence.recordAssertionEvidence("Released cross-organization isolation", "Foreign GET/PUT/DELETE all 404 with and without spoofed source-org header, source unchanged; same key creates a distinct resource, disjoint lists including spoofed list; missing/invalid keys 401; resources removed and keys revoked.", true);
});
