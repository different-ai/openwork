import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected receipt object");
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

function hex(value: unknown, length: 16 | 64): string {
  const result = text(value);
  expect(result).toMatch(new RegExp(`^[0-9a-f]{${length}}$`));
  return result;
}

function priorInputs(value: unknown) {
  const inputs = record(value);
  expect(Object.keys(inputs).sort()).toEqual([
    "mcp-put-by-key-tenant-transcript-2026-09-14.json",
    "mcp-put-by-key-transcript-2026-09-14.json",
  ]);
  for (const digest of Object.values(inputs)) hex(digest, 64);
  return inputs;
}

function credentialChecks(value: unknown) {
  const checks = records(value);
  expect(checks.map((check) => text(check.label)).sort()).toEqual(["run1-provider-connect", "run2-provider-connect"]);
  return checks;
}

const transcript = record(JSON.parse(await readFile(new URL("../../reports/mcp-put-by-key-job-transcript-2026-09-14.json", import.meta.url), "utf8")));
const requests = records(transcript.requests);
const witness = records(transcript.witnessReceipts);

function receipt(label: string) {
  const rows = requests.filter((row) => row.label === label);
  expect(rows, label).toHaveLength(1);
  const row = rows[0];
  if (!row) throw new Error(`Missing ${label}`);
  return row;
}

function response(label: string, status = 200) {
  const value = record(receipt(label).response);
  expect(value.status, label).toBe(status);
  return value;
}

function body(label: string, status = 200) {
  return record(response(label, status).body);
}

function input(label: string) {
  return record(record(receipt(label).request).body);
}

function ids(label: string, field: string) {
  return records(body(label)[field]).map((row) => text(row.id)).sort();
}

function snapshot(run: string) {
  return {
    providers: ids(`${run}-snapshot-providers`, "llmProviders"),
    teams: ids(`${run}-snapshot-org-teams`, "teams"),
    mcpConnections: ids(`${run}-snapshot-mcp`, "connections"),
    desktopPolicies: ids(`${run}-snapshot-policies`, "desktopPolicies"),
    marketplaces: ids(`${run}-snapshot-marketplaces`, "items"),
  };
}

test("recorded integrity inputs reject missing fingerprints, prior transcripts and duplicated check labels", () => {
  const lengths: (16 | 64)[] = [16, 64];
  for (const length of lengths) {
    expect(hex("a".repeat(length), length)).toBe("a".repeat(length));
    for (const value of [undefined, null, "", 123, "g".repeat(length), "a".repeat(length - 1)]) expect(() => hex(value, length)).toThrow();
  }
  const valid = {
    "mcp-put-by-key-transcript-2026-09-14.json": "a".repeat(64),
    "mcp-put-by-key-tenant-transcript-2026-09-14.json": "b".repeat(64),
  };
  expect(priorInputs(valid)).toEqual(valid);
  for (const value of [undefined, {}, { ...valid, extra: "c".repeat(64) }, { ...valid, "mcp-put-by-key-transcript-2026-09-14.json": undefined }]) expect(() => priorInputs(value)).toThrow();
  expect(credentialChecks([{ label: "run2-provider-connect" }, { label: "run1-provider-connect" }])).toHaveLength(2);
  for (const value of [[], [{}, {}], [{ label: "run1-provider-connect" }, { label: "run1-provider-connect" }]]) expect(() => credentialChecks(value)).toThrow();
});

test("Lane3 recorded job uses the pinned release and preserves both prior transcripts", async ({ evidence }) => {
  expect(transcript.kind).toBe("recorded-release-post-deploy-job");
  expect(requests).toHaveLength(71);
  for (const email of JSON.stringify(transcript).matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) expect(email[0]).toMatch(/@example\.com$/);
  expect(record(transcript.inspection).containerImage).toBe("ghcr.io/different-ai/openwork-den-api@sha256:e254a3842e7ecb6d0c7128b5f17201e92ac4ee566ad82c70c468938a3faa6407");
  expect(record(transcript.inspection).composeSha256).toBe("7b94efe1ac4be68d56b8ecb91206e9c005360b0f7954ba36c6f6ae7bd87a9430");
  for (const [filename, expected] of Object.entries(priorInputs(transcript.priorTranscripts))) {
    const bytes = await readFile(new URL(`../../reports/${filename}`, import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(hex(expected, 64));
  }
  const job = await readFile(new URL("../../examples/declarative-org/rs-post-deploy-job.sh", import.meta.url));
  expect(createHash("sha256").update(job).digest("hex")).toBe(hex(transcript.jobSha256, 64));
  for (const run of ["run1", "run2"]) {
    const api = body(`${run}-openapi`);
    expect(record(api.info).version).toBe("dev");
    expect(record(record(api.paths)["/v1/mcp-connections/by-key/{externalKey}"])).toHaveProperty("put");
  }
  for (const row of requests) {
    const request = record(row.request);
    if (!text(request.url).startsWith("http://localhost:18788/")) continue;
    expect(record(request.headers)["x-api-key"]).toBe("[REDACTED]");
    expect(record(request.headers)).not.toHaveProperty("Authorization");
    expect(record(request.headers)).not.toHaveProperty("Cookie");
  }
  evidence.recordAssertionEvidence("Released API-key job provenance", "Pinned 0.18.46 container, unchanged Compose and prior evidence; OpenAPI reports dev, while the actual release is established by the image digest. No Den session headers.", true);
});

test("final producer records exactly two real applies with execution-time arguments, timestamps, exits and digests", async ({ evidence }) => {
  expect(transcript.schemaVersion).toBe(2);
  expect(transcript.recordingRevision).toBe(2);
  expect(transcript.supersedesTranscriptSha256).toBe("7c341e0250954711616dbf24afede97d6d95f8ce6782a5064950c0aab466e63e");
  const invocations = records(transcript.jobInvocations);
  expect(invocations).toHaveLength(2);
  expect(invocations.map((row) => row.argv)).toEqual([
    ["bash", "examples/declarative-org/rs-post-deploy-job.sh", "apply", "run1"],
    ["bash", "examples/declarative-org/rs-post-deploy-job.sh", "apply", "run2"],
  ]);
  let previousEnd = 0;
  for (const invocation of invocations) {
    expect(invocation.mode).toBe("apply");
    expect(invocation.exitCode).toBe(0);
    expect(invocation.scriptUnchanged).toBe(true);
    expect(hex(invocation.scriptSha256, 64)).toBe(hex(transcript.jobSha256, 64));
    expect(invocation.scriptSha256After).toBe(invocation.scriptSha256);
    const start = Date.parse(text(invocation.startedAt));
    const end = Date.parse(text(invocation.endedAt));
    expect(start).toBeGreaterThan(previousEnd);
    expect(end).toBeGreaterThan(start);
    previousEnd = end;
    expect(text(invocation.curlExecutable)).toMatch(/\/curl$/);
    expect(text(invocation.jqExecutable)).toMatch(/\/jq$/);
    expect(text(invocation.curlExecutable)).not.toContain("failure-bin");
  }
  const other = records(transcript.otherInvocations);
  expect(other.map((row) => row.mode)).toEqual(["prepare", "lifecycle", "cleanup"]);
  for (const row of other) {
    expect(row.exitCode).toBe(0);
    expect(row.scriptSha256).toBe(transcript.jobSha256);
    expect(row.scriptUnchanged).toBe(true);
  }
  const produced = requests.filter((row) => typeof row.category === "string");
  expect(produced).toHaveLength(55);
  for (const row of produced) {
    expect(row.curlExit).toBe(0);
    expect(record(row.response).status).toBe(row.expectedStatus);
    if (row.expectedStatus === 404) {
      expect(row.category).toBe("diagnostic");
      expect(record(row.request).method).toBe("GET");
      expect(["http://localhost:18788/v1/members", "http://localhost:18788/v1/teams"]).toContain(record(row.request).url);
    }
  }
  evidence.recordAssertionEvidence("Actual final job invocations", "Exactly two real applies have recorded argv, start/end UTC timestamps, exit 0, and the same execution-time script digest verified again afterwards; setup/lifecycle/cleanup are separate invocations and every produced request matches its explicit expected status.", true);
});

test("recipe rerun observes actual incoming headers without backfilling historical receipts", async ({ evidence }) => {
  const supplemental = record(JSON.parse(await readFile(new URL("../../reports/mcp-put-by-key-recipe-headers-transcript-2026-09-14.json", import.meta.url), "utf8")));
  expect(supplemental.kind).toBe("released-recipe-observed-headers-rerun");
  expect(supplemental.historicalHeadersBackfilled).toBe(false);
  expect(supplemental.originalTranscriptSha256).toBe("c5f6ca7feb2abf0ec2229630cb78f981dec0b0fe5ee06e5998a21fd6d131f6bc");
  expect(supplemental.containerImage).toBe(record(transcript.inspection).containerImage);
  const rows = records(supplemental.requests);
  expect(rows).toHaveLength(5);
  const recipes = rows.filter((row) => row.label === "recipe-first" || row.label === "recipe-second");
  expect(recipes).toHaveLength(2);
  expect(recipes.map((row) => record(row.response).status)).toEqual([201, 200]);
  const ids = recipes.map((row) => record(record(row.response).body).id);
  expect(ids[0]).toMatch(/^emc_/);
  expect(ids[1]).toBe(ids[0]);
  const recipeBytes = await readFile(new URL("../fixtures/mcp-put-release-recipe.sh", import.meta.url));
  for (const row of recipes) {
    const request = record(row.request);
    expect(request.headersSource).toBe("observed_proxy_incoming");
    const headers = Object.fromEntries(Object.entries(record(request.headers)).map(([key, value]) => [key.toLowerCase(), value]));
    expect(headers).toMatchObject({ host: "localhost:18443", "x-api-key": "[REDACTED]", "content-type": "application/json", accept: "*/*" });
    expect(headers).not.toHaveProperty("authorization");
    expect(headers).not.toHaveProperty("cookie");
    expect(headers["user-agent"]).toMatch(/^curl\//);
    expect(Number(headers["content-length"])).toBeGreaterThan(0);
    expect(row.observedKeyMatchesConfigured).toBe(true);
    const recipe = record(row.recipe);
    expect(recipe).toMatchObject({ verbatim: true, exit: 0, tlsVerification: true });
    expect(recipe.lines).toEqual(recipeBytes.toString("utf8").trimEnd().split("\n"));
    expect(recipe.scriptSha256).toBe(createHash("sha256").update(recipeBytes).digest("hex"));
  }
  expect(rows.find((row) => row.label === "tls-untrusted-control")?.curlExit).toBe(60);
  const cleanup = rows.find((row) => row.label === "recipe-rerun-cleanup-list");
  if (!cleanup) throw new Error("Missing recipe cleanup receipt");
  expect(record(record(cleanup.response).body).connections).toEqual([]);
  evidence.recordAssertionEvidence("Observed recipe headers", "A new 201/200 HTTPS recipe pair observed six incoming curl headers at the proxy, including the matching API key and no session/cookie headers. Historical constructed header maps remain historical, not retroactively observed; the original 51-receipt hash is unchanged.", true);
});

test("two whole recorded jobs converge with seven run2 mutations all 200 and identical list counts and IDs", async ({ evidence }) => {
  const suffixes = ["provider-put", "org-patch", "team-put", "unkeyed-put", "oauth-put", "policy-put", "marketplace-put"];
  const firstStatuses = [201, 200, 201, 200, 201, 201, 201];
  for (const [index, suffix] of suffixes.entries()) {
    const expected = firstStatuses[index];
    if (expected === undefined) throw new Error("Missing expected status");
    response(`run1-${suffix}`, expected);
    response(`run2-${suffix}`, 200);
    expect(receipt(`run2-${suffix}`).category).toBe("convergent");
  }
  const secondWrites = requests.filter((row) => text(row.label).startsWith("run2-") && row.category === "convergent");
  expect(secondWrites).toHaveLength(7);
  expect(secondWrites.map((row) => record(row.response).status)).toEqual(Array(7).fill(200));
  const first = snapshot("run1");
  const second = snapshot("run2");
  expect(second).toEqual(first);
  expect(Object.fromEntries(Object.entries(first).map(([key, values]) => [key, values.length]))).toEqual({ providers: 1, teams: 1, mcpConnections: 2, desktopPolicies: 2, marketplaces: 3 });
  expect(record(transcript.comparison)).toMatchObject({ countsAndIdsIdentical: true, run2ConvergentAll200: true });
  evidence.recordAssertionEvidence("Whole-job convergence", "Both jobs completed; seven run2 convergent mutations returned 200, not 201. Raw list projections independently match: providers 1, teams 1, MCPs 2, policies 2, marketplaces 3, including unchanged built-ins.", true);
});

test("recorded provider usability consumes persisted credentials and performs real synthetic completions", async ({ evidence }) => {
  const checks = credentialChecks(transcript.credentialChecksBeforeRedaction);
  const expectedFingerprint = hex(transcript.expectedSyntheticProviderSecretFingerprint, 16);
  for (const check of checks) expect(check).toMatchObject({ storedCredentialPresent: true, storedCredentialMatchesConfigured: true });
  for (const run of ["run1", "run2"]) {
    const provider = record(body(`${run}-provider-connect`).llmProvider);
    expect(provider.apiKey).toBe("[REDACTED]");
    expect(provider.credentialMode).toBe("shared");
    const usability = body(`${run}-provider-usability`);
    expect(record(usability.result)).toMatchObject({ ok: true, status: 200, vendor: "openai-compatible" });
    expect(records(usability.verifications)).toEqual([{ id: "lane3-model", status: "ok", npm: "@ai-sdk/openai-compatible", message: null }]);
  }
  const completions = witness.filter((row) => record(row.request).path === "/v1/chat/completions");
  expect(completions).toHaveLength(2);
  for (const completion of completions) {
    expect(completion.authenticated).toBe(true);
    expect(hex(record(completion.request).secretFingerprint, 16)).toBe(expectedFingerprint);
    expect(record(record(completion.request).body)).toMatchObject({ model: "lane3-model", max_tokens: 16 });
    expect(record(completion.response).status).toBe(200);
    expect(record(record(record(completion.response).body).usage).completion_tokens).toBe(1);
  }
  const modelLists = witness.filter((row) => record(row.request).path === "/v1/models" && row.authenticated === true);
  expect(modelLists).toHaveLength(2);
  expect(record(body("control-provider-missing-credential").result)).toMatchObject({ ok: false, status: 401 });
  evidence.recordAssertionEvidence("Provider usability and missing-credential negative", "Den test-connection uses the persisted connect credential, authenticates GET models and two actual synthetic completions, each producing one token (the test operation requests max_tokens=16). Missing credential yields upstream 401 inside a 200 diagnostic envelope.", true);
});

test("recorded unkeyed MCP is created only once then preserved by both ID updates and rejects stale state", async ({ evidence }) => {
  const created = body("setup-unkeyed-create");
  expect(created.externalKey).toBeNull();
  expect(created.id).toMatch(/^emc_/);
  const creates = requests.filter((row) => record(row.request).method === "POST" && record(row.request).url === "http://localhost:18788/v1/mcp-connections");
  expect(creates).toHaveLength(1);
  for (const run of ["run1", "run2"]) {
    const before = body(`${run}-unkeyed-get`);
    expect(before.id).toBe(created.id);
    expect(input(`${run}-unkeyed-put`).expectedUpdatedAt).toBe(before.updatedAt);
    expect(body(`${run}-unkeyed-put`)).toMatchObject({ id: created.id, externalKey: null, name: "Lane3 managed existing MCP" });
  }
  expect(input("control-unkeyed-stale").expectedUpdatedAt).toBe(created.updatedAt);
  expect(body("control-unkeyed-stale", 409).error).toBe("connection_conflict");
  const successful = body("run2-unkeyed-put");
  expect(body("control-unkeyed-after-stale")).toMatchObject({ id: created.id, name: successful.name, updatedAt: successful.updatedAt });
  evidence.recordAssertionEvidence("Unkeyed identity roundtrip", "One POST before both jobs; GET/PUT ID preserves the original unkeyed ID twice. A deliberately stale PUT afterwards returns 409 and cannot overwrite the successful state.", true);
});

test("OAuth client secret omitted in job2 authenticates the first protocol token exchange afterwards", async ({ evidence }) => {
  const first = input("run1-oauth-put");
  const second = input("run2-oauth-put");
  expect(record(first.oauthClient).clientSecret).toBe("[REDACTED]");
  expect(record(second.oauthClient)).not.toHaveProperty("clientSecret");
  expect(record(second.oauthClient)).toEqual({ clientId: "lane3-client", tokenEndpointAuthMethod: "client_secret_post" });
  for (const field of ["url", "authType", "credentialMode", "access", "authorizationServerIssuer", "requestedScopes"]) expect(second[field]).toEqual(first[field]);
  const created = body("run1-oauth-put", 201);
  expect(body("run2-oauth-put")).toMatchObject({ id: created.id, connected: false });
  expect(body("control-oauth-before-first-connect")).toMatchObject({ id: created.id, connected: false });
  expect(requests.findIndex((row) => row.label === "control-oauth-start")).toBeGreaterThan(requests.findIndex((row) => row.label === "run2-snapshot-marketplaces"));
  response("control-oauth-start");
  response("control-oauth-synthetic-consent", 302);
  response("control-oauth-callback");
  expect(body("control-oauth-after-connect")).toMatchObject({ id: created.id, connected: true });
  const exchanges = witness.filter((row) => record(row.request).path === "/token" && row.authenticated === true);
  expect(exchanges).toHaveLength(1);
  const exchange = exchanges[0];
  if (!exchange) throw new Error("Missing actual OAuth token exchange");
  expect(hex(record(exchange.request).secretFingerprint, 16)).toBe(hex(transcript.expectedSyntheticClientSecretFingerprint, 16));
  expect(record(record(exchange.request).body)).toMatchObject({ client_id: "lane3-client", grant_type: "authorization_code" });
  expect(record(exchange.response).status).toBe(200);
  expect(body("control-oauth-missing-client-secret", 401).error).toBe("invalid_client");
  const result = record(body("control-oauth-tool").result);
  expect(result.isError).toBe(false);
  const content = records(result.content)[0];
  if (!content) throw new Error("Missing authenticated MCP result");
  expect(JSON.parse(text(content.text))).toEqual({ authenticated: true, nonce: "after-client-secret-omission" });
  evidence.recordAssertionEvidence("OAuth secret preserved, not merely an existing token", "No connection token existed before job2. After secret omission, a fresh authorization-code/PKCE exchange supplied the original client-secret fingerprint and succeeded; missing-secret control gets 401 and a subsequent MCP call is authenticated.", true);
});

test("actual release contracts resolve members and teams through org without SSO configuration writes", async ({ evidence }) => {
  for (const run of ["run1", "run2"]) {
    expect(input(`${run}-org-patch`)).toEqual({ requireSso: false });
    expect(record(receipt(`${run}-org-patch`).request).method).toBe("PATCH");
    response(`${run}-members-contract`, 404);
    response(`${run}-snapshot-teams-contract`, 404);
    const org = body(`${run}-members-org`);
    const members = records(org.members).filter((row) => record(row.user).email === "release-admin@example.com");
    expect(members).toHaveLength(1);
    expect(input(`${run}-team-put`)).toEqual({ name: "Lane3 team", memberIds: [members[0]?.id], grantsOrganizationAdmin: false });
    const policy = record(input(`${run}-policy-put`).policy);
    expect(record(policy.access).mode).toBe("custom");
    expect(record(policy.execution)).toMatchObject({ commands: "deny", blockedCommands: ["rm -rf"], blockBrowserUploads: true });
    expect(input(`${run}-provider-put`)).toMatchObject({ source: "custom", credentialMode: "shared", allMembers: true, memberIds: [], teamIds: [] });
    expect(input(`${run}-provider-put`)).not.toHaveProperty("llmProvider");
    expect(input(`${run}-team-put`)).not.toHaveProperty("team");
    expect(input(`${run}-policy-put`)).not.toHaveProperty("desktopPolicy");
    expect(input(`${run}-marketplace-put`)).not.toHaveProperty("item");
  }
  expect(requests.filter((row) => text(record(row.request).url).includes("/v1/sso"))).toHaveLength(0);
  evidence.recordAssertionEvidence("Contract compatibility and restricted org mutation", "Literal GET members/teams return 404; member email and teams resolve via GET org. PATCH org sends only requireSso:false. No SSO route is called; writes use real unwrapped request contracts.", true);
});

test("marketplace destructive lifecycle is separate from convergence and cleanup preserves baseline resources", async ({ evidence }) => {
  const before = record(body("lifecycle-marketplace-before").item);
  expect(before.id).toBe(record(body("run2-marketplace-put").item).id);
  response("lifecycle-marketplace-delete");
  const recreated = record(body("lifecycle-marketplace-recreate", 201).item);
  expect(recreated.id).not.toBe(before.id);
  expect(record(body("lifecycle-marketplace-after").item).id).toBe(recreated.id);
  expect(receipt("lifecycle-marketplace-recreate").category).toBe("lifecycle");
  expect(requests.findIndex((row) => row.label === "lifecycle-marketplace-before")).toBeGreaterThan(requests.findIndex((row) => row.label === "run2-snapshot-marketplaces"));
  for (const suffix of ["oauth", "unkeyed", "provider", "policy", "marketplace", "team"]) response(`cleanup-${suffix}`);
  expect(ids("cleanup-snapshot-providers", "llmProviders")).toEqual(ids("baseline-providers", "llmProviders"));
  expect(ids("cleanup-snapshot-org-teams", "teams")).toEqual(ids("baseline-org", "teams"));
  expect(ids("cleanup-snapshot-mcp", "connections")).toHaveLength(0);
  expect(ids("cleanup-snapshot-policies", "desktopPolicies")).toEqual(ids("baseline-policies", "desktopPolicies"));
  expect(ids("cleanup-snapshot-marketplaces", "items")).toEqual(ids("baseline-marketplaces", "items"));
  evidence.recordAssertionEvidence("Destructive exception and cleanup", "Marketplace DELETE 200 then PUT 201/new ID is deliberately after both stable snapshots, not part of the all-200 claim. All Lane3 records removed; pre-existing default policy and marketplaces retained by ID.", true);
});
