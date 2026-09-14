import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { denFetch, localMysqlIsRunning, localRedisIsRunning, mcpMock, needs, server, test } from "@openwork/testkit";
import { declarativeClientProxy, record, text } from "./fixtures/declarative-client-proxy.ts";
import type { ClientRequest } from "./fixtures/declarative-client-proxy.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const client = join(root, "examples/declarative-org/apply.mjs");
const shippedManifest = join(root, "examples/declarative-org/organization.json");
const mysql = await localMysqlIsRunning();
const redis = await localRedisIsRunning();
const title = !mysql ? "declarative CLI skipped — needs local MySQL on 127.0.0.1:3306"
  : !redis ? "declarative CLI skipped — needs local Redis on 127.0.0.1:6379"
    : "the shipped organization CLI converges MCP identities, uses conditional bare PUTs, and stops unsafe retries";

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected an array");
  return value.map(record);
}

function writes(requests: ClientRequest[]) {
  return requests.filter((request) => request.method !== "GET");
}

function conditionalPuts(requests: ClientRequest[]) {
  const puts = requests.filter((request) => request.method === "PUT" && request.path.startsWith("/v1/mcp-connections/"));
  for (const put of puts) {
    const index = requests.indexOf(put);
    const listing = requests[index - 2];
    const read = requests[index - 1];
    expect(listing).toMatchObject({ method: "GET", path: "/v1/mcp-connections?scope=manageable", status: 200 });
    expect(read).toMatchObject({ method: "GET", status: 200 });
    const current = record(read.response);
    expect(read.path).toBe(`/v1/mcp-connections/${text(current.id)}`);
    expect(put.ifMatch).toBe(text(current.updatedAt));
    expect(put.ifMatch).not.toBeNull();
    expect(put.body).not.toHaveProperty("expectedUpdatedAt");
    expect(put.body).not.toHaveProperty("connection");
    expect(put.body).not.toHaveProperty("teamIds");
    expect(put.body).not.toHaveProperty("teams");
    expect(rows(record(listing.response).connections).find((row) => row.externalKey === current.externalKey)?.id).toBe(current.id);
  }
  return puts;
}

test("the declarative proxy rejects non-API and authority-bearing request targets", async ({ evidence }) => {
  await using proxy = await declarativeClientProxy("http://127.0.0.1:1", "unused diagnostic");
  for (const path of [
    "http://127.0.0.1:1/v1/org", "https://example.invalid/v1/org",
    "//127.0.0.1:1/v1/org", "/health", "/invalid-mcp",
    "/v1/../health", "/v1/%2e%2e/health", "/v1/\\\\example.invalid", "/v1/org#fragment",
  ]) {
    // Node's raw request path preserves absolute/protocol-relative targets;
    // fetch would normalize them before the proxy could inspect them.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const incoming = request(proxy.url, { path, signal: AbortSignal.timeout(5_000) }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
        response.on("error", reject);
      });
      incoming.on("error", reject);
      incoming.end();
    });
    expect(status, path).toBe(400);
  }
  expect(proxy.requests).toEqual([]);
  expect(proxy.failures).toEqual([]);
  expect(proxy.invalidProbes()).toBe(0);
  evidence.recordAssertionEvidence("Proxy rejects unsafe URL targets before forwarding", "Raw absolute and protocol-relative targets, non-/v1/ paths, normalized traversal, backslashes, and fragments returned 400; no forwarding requests, upstream failures, or witness probes occurred.", true);
});

test.skipIf(!mysql || !redis)(title, { timeout: 300_000 }, async ({ place, evidence }) => {
  needs({ commands: ["bun", "pnpm", "node"] });
  expect(place.kind, "This CLI witness requires the user-requested local lane").toBe("local");
  const manifest = record(JSON.parse(await readFile(shippedManifest, "utf8")));
  expect(manifest).toHaveProperty("mcpConnections");
  const connections = record(manifest.mcpConnections);
  const httpEntry = Object.entries(connections).find(([, value]) => record(value).authType === "none");
  const oauthEntry = Object.entries(connections).find(([, value]) => record(value).authType === "oauth");
  expect(Object.keys(connections).length).toBeGreaterThanOrEqual(2);
  if (!httpEntry || !oauthEntry) throw new Error("The shipped manifest must contain HTTP and OAuth MCP examples");
  const [httpKey] = httpEntry;
  const [oauthKey] = oauthEntry;
  const name = `Declarative client ${Date.now()}`;
  const secret = 'synthetic-cli-"quoted"\nsecond-line';
  const oauthSecret = "synthetic-oauth-client-secret";
  const errorSentinel = "synthetic-private-upstream-diagnostic";
  await using den = await server({
    place, web: false, org: { name, members: {} }, env: { DEN_PLAN_GATING_ENABLED: "false" },
    mocks: { http: mcpMock({ allowUnauthenticatedMcp: true, isolatedProcessEnv: true }), oauth: mcpMock({ oauthClientSecret: oauthSecret, isolatedProcessEnv: true }) },
  });
  const orgs = await denFetch(den.admin, "/v1/me/orgs", { headers: { authorization: `Bearer ${den.admin.token}` } });
  expect(orgs.response.status).toBe(200);
  const org = rows(record(orgs.body).orgs).find((entry) => entry.name === name);
  if (!org) throw new Error("Isolated organization missing");
  const minted = await denFetch(den.admin, "/v1/api-keys", {
    method: "POST", headers: { authorization: `Bearer ${den.admin.token}`, "x-openwork-org-id": text(org.id) },
    body: JSON.stringify({ name: "Declarative CLI witness" }),
  });
  expect(minted.response.status).toBe(201);
  const apiKey = text(record(minted.body).key);
  await using proxy = await declarativeClientProxy(den.ref.apiUrl, errorSentinel);
  const directory = await mkdtemp(join(root, "evals/results/declarative-client-"));
  const environment = {
    ...process.env, DEN_API_URL: proxy.url, DEN_API_KEY: apiKey,
    INFERENCE_URL: "https://inference.eval.invalid/v1", COMPANY_INFERENCE_KEY: secret,
    MCP_HTTP_URL: den.mocks.http.mcpUrl, MCP_OAUTH_URL: den.mocks.oauth.mcpUrl,
    MCP_CLIENT_ID: "synthetic-client", MCP_CLIENT_SECRET: oauthSecret, MCP_ISSUER: den.mocks.oauth.url,
  };
  async function cli(input?: unknown, remove = false, missingEnv = false) {
    let filename = shippedManifest;
    if (input !== undefined) {
      filename = join(directory, "organization.json");
      await writeFile(filename, JSON.stringify(input), { mode: 0o600 });
    }
    const start = proxy.requests.length;
    const result = await new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [client, filename, ...(remove ? ["--delete"] : [])], {
        cwd: root, env: { ...environment, ...(missingEnv ? { MCP_HTTP_URL: "", MCP_OAUTH_URL: "", MCP_CLIENT_ID: "", MCP_CLIENT_SECRET: "", MCP_ISSUER: "", COMPANY_INFERENCE_KEY: "" } : {}) },
        timeout: 60_000, maxBuffer: 1_000_000,
      }, (error, stdout, stderr) => resolve({ status: error ? typeof error.code === "number" ? error.code : -1 : 0, stdout, stderr }));
    });
    const output = result.stdout + result.stderr;
    for (const value of [apiKey, secret, JSON.stringify(secret).slice(1, -1), oauthSecret, errorSentinel]) {
      expect(output.includes(value), "CLI output must not reveal credentials or raw upstream errors").toBe(false);
    }
    expect(proxy.failures).toEqual([]);
    return { ...result, requests: proxy.requests.slice(start) };
  }
  async function request(path: string, method = "GET", body?: unknown) {
    return denFetch(den.admin, path, { method, headers: { "x-api-key": apiKey }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  }
  async function snapshot() {
    const result = await request("/v1/mcp-connections?scope=manageable");
    expect(result.response.status).toBe(200);
    return rows(record(result.body).connections).filter((row) => Object.hasOwn(connections, text(row.externalKey)));
  }
  try {
    const invalidAccess: unknown[] = [undefined, null, true, [], "org", { orgWide: "false" }, { orgWide: null }, { memberIds: "member" }, { memberIds: [null] }, { memberIds: [" "] }, { teamIds: [3] }, { teamIds: ["not-a-team-id"] }, { memberIds: ["tem_00000000000000000000000000"] }, { teamIds: ["tem_80000000000000000000000000"] }, { teamIds: Array(201).fill("tem_00000000000000000000000000") }, { unexpected: true }];
    for (const access of invalidAccess) {
      const invalid = { ...manifest, mcpConnections: { ...connections, [httpKey]: { ...record(httpEntry[1]), access } } };
      const rejected = await cli(invalid);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("Explicit valid MCP access is required");
      expect(rejected.stdout).toBe("");
      expect(rejected.requests).toEqual([]);
    }
    const conflict = await cli({ ...manifest, mcpConnections: { ...connections, [httpKey]: { ...record(httpEntry[1]), teams: [Object.keys(record(manifest.teams))[0]], access: { orgWide: false, teamIds: [] } } } });
    expect(conflict.status).not.toBe(0);
    expect(conflict.stderr).toContain("Use teams or access.teamIds, not both");
    expect(conflict.requests).toEqual([]);
    const missing = await cli(undefined, false, true);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("Missing environment variable");
    expect(missing.requests).toEqual([]);
    expect(await snapshot()).toEqual([]);
    evidence.recordAssertionEvidence("MCP access and environment preflight happen before any organization writes", "Missing and malformed access, conflicting team references, and absent environment substitutions all exited nonzero with zero HTTP requests, no progress output, and no MCP identities.", true);

    const first = await cli();
    expect(first.status, first.stderr).toBe(0);
    const count = Object.entries(manifest).filter(([key]) => key !== "version").reduce((total, [, value]) => total + Object.keys(record(value)).length, 0);
    expect(writes(first.requests)).toHaveLength(count);
    expect(writes(first.requests).map((entry) => entry.status)).toEqual(Array(count).fill(201));
    const firstConnections = await snapshot();
    expect(firstConnections).toHaveLength(Object.keys(connections).length);
    const firstMcpPuts = writes(first.requests).filter((entry) => entry.path.startsWith("/v1/mcp-connections/"));
    for (const entry of firstMcpPuts) {
      expect(entry.ifMatch).toBeNull();
      expect(entry.body).not.toHaveProperty("expectedUpdatedAt");
      expect(entry.body).not.toHaveProperty("connection");
      expect(entry.response).not.toHaveProperty("connection");
      expect(text(record(entry.response).id)).toMatch(/^emc_/);
    }
    const second = await cli();
    expect(second.status, second.stderr).toBe(0);
    expect(writes(second.requests)).toHaveLength(count);
    expect(writes(second.requests).map((entry) => entry.status)).toEqual(Array(count).fill(200));
    expect(second.stdout).not.toContain("created ");
    expect(second.stdout.match(/^updated /gm)).toHaveLength(count);
    expect(conditionalPuts(second.requests)).toHaveLength(Object.keys(connections).length);
    const secondConnections = await snapshot();
    expect(secondConnections.map((row) => [row.externalKey, row.id])).toEqual(firstConnections.map((row) => [row.externalKey, row.id]));
    for (const entry of writes(second.requests)) {
      const previous = writes(first.requests).find((candidate) => candidate.path === entry.path);
      if (!previous) throw new Error("First PUT missing");
      const envelopes = new Map<string, string | null>([["teams", "team"], ["llm-providers", "llmProvider"], ["mcp-connections", null], ["desktop-policies", "desktopPolicy"], ["marketplaces", "item"]]);
      const envelope = envelopes.get(entry.path.split("/")[2]);
      if (envelope === undefined) throw new Error("Unknown resource response");
      if (envelope !== null) {
        expect(entry.body).not.toHaveProperty(envelope);
        expect(previous.body).not.toHaveProperty(envelope);
      }
      const current = envelope === null ? record(entry.response) : record(record(entry.response)[envelope]);
      const original = envelope === null ? record(previous.response) : record(record(previous.response)[envelope]);
      expect(text(current.id)).toBe(text(original.id));
      expect(current.externalKey).toBe(original.externalKey);
    }
    const teamKey = Object.keys(record(manifest.teams))[0];
    const teamRead = await request(`/v1/teams/by-key/${teamKey}`);
    expect(teamRead.response.status).toBe(200);
    const teamId = text(record(record(teamRead.body).team).id);
    const httpPut = firstMcpPuts.find((entry) => entry.path.endsWith(`/${httpKey}`));
    if (!httpPut) throw new Error("HTTP MCP PUT missing");
    for (const application of [first, second]) {
      const oauthPut = writes(application.requests).find((entry) => entry.path === `/v1/mcp-connections/by-key/${oauthKey}`);
      const http = writes(application.requests).find((entry) => entry.path === `/v1/mcp-connections/by-key/${httpKey}`);
      if (!oauthPut || !http) throw new Error("MCP PUTs missing");
      const oauthClient = record(record(oauthPut.body).oauthClient);
      expect(oauthClient.clientSecret === oauthSecret).toBe(true);
      expect(oauthClient.clientId).toBe(environment.MCP_CLIENT_ID);
      expect(oauthClient.tokenEndpointAuthMethod).toBe("client_secret_basic");
      for (const value of [oauthPut.body, oauthPut.response]) {
        expect(value).toMatchObject({
          url: environment.MCP_OAUTH_URL, authType: "oauth", credentialMode: "per_member", exposeDirectly: false,
          authorizationServerIssuer: environment.MCP_ISSUER, requestedScopes: ["tools:read"],
          access: { orgWide: false, memberIds: [], teamIds: [teamId] },
        });
      }
      for (const value of [http.body, http.response]) {
        expect(value).toMatchObject({
          url: environment.MCP_HTTP_URL, authType: "none", credentialMode: "shared", exposeDirectly: false,
          access: { orgWide: true, memberIds: [], teamIds: [] },
        });
      }
      expect(http.body).not.toHaveProperty("oauthClient");
      expect(http.body).not.toHaveProperty("requestedScopes");
      const providerPut = writes(application.requests).find((entry) => entry.path.startsWith("/v1/llm-providers/"));
      if (!providerPut) throw new Error("Provider PUT missing");
      expect(record(providerPut.body).apiKey === secret).toBe(true);
      expect(providerPut.body).toMatchObject({
        source: "custom", credentialMode: "shared", allMembers: false, memberIds: [], teamIds: [teamId],
        customConfig: { api: environment.INFERENCE_URL, models: [{ id: "company-model" }] },
      });
      for (const field of ["llmProvider", "mode", "models", "access", "teams"]) expect(providerPut.body).not.toHaveProperty(field);
    }
    expect((await den.mocks.http.handshakes({ atLeast: 1, timeoutMs: 5_000 })).length).toBeGreaterThan(0);
    evidence.recordAssertionEvidence("The complete shipped manifest converges with bare conditional MCP requests", "The shipped organization.json was applied twice: every first PUT returned 201, every second PUT returned 200, MCP IDs stayed unchanged, and each update used the exact timestamp read by ID after manageable external-key discovery. Bodies omitted expectedUpdatedAt and wrappers; responses were bare. Both applies sent OAuth client_secret_basic and tools:read. Requests and responses preserved per_member/team-only OAuth access versus shared/org-wide HTTP access, with exposeDirectly false on both. Custom provider writes used source/credentialMode/customConfig.models and top-level allMembers/memberIds/teamIds; none of the response envelopes were sent as write wrappers. Synthetic environment credentials arrived exactly without CLI disclosure.", true);

    const httpBody = record(httpPut.body);
    const scoped = { version: 1, teams: manifest.teams, mcpConnections: { [httpKey]: { ...httpBody, teams: [teamKey], access: { orgWide: false } } } };
    const scopedResult = await cli(scoped);
    expect(scopedResult.status, scopedResult.stderr).toBe(0);
    const scopedPut = conditionalPuts(scopedResult.requests)[0];
    expect(record(record(scopedPut.body).access).teamIds).toEqual([teamId]);
    expect(record(record(scopedPut.response).access).teamIds).toEqual([teamId]);
    expect(record(scopedPut.response).id).toBe(record(httpPut.response).id);
    const emptyTeams = await cli({ ...scoped, mcpConnections: { [httpKey]: { ...httpBody, teams: [], access: { orgWide: false } } } });
    expect(emptyTeams.status, emptyTeams.stderr).toBe(0);
    expect(record(record(conditionalPuts(emptyTeams.requests)[0].response).access).teamIds).toEqual([]);
    evidence.recordAssertionEvidence("Top-level MCP teams resolve into access.teamIds, including removal", "The CLI sent the created team ID only under MCP access.teamIds, the bare server response confirmed the grant, an empty teams array removed it, and the MCP ID stayed stable.", true);

    const single = { version: 1, mcpConnections: { [httpKey]: httpBody } };
    proxy.faults.push("race");
    const raced = await cli(single);
    expect(raced.status, raced.stderr).toBe(0);
    const racePuts = conditionalPuts(raced.requests);
    expect(racePuts.map((entry) => entry.status)).toEqual([409, 200]);
    expect(racePuts[1].ifMatch).not.toBe(racePuts[0].ifMatch);
    expect(record(racePuts[1].response).id).toBe(record(httpPut.response).id);
    proxy.faults.push("race", "race");
    const stopped = await cli(single);
    expect(stopped.status).not.toBe(0);
    expect(stopped.stderr).toContain("HTTP 409");
    expect(conditionalPuts(stopped.requests).map((entry) => entry.status)).toEqual([409, 409]);
    expect(stopped.stdout).toBe("");
    evidence.recordAssertionEvidence("A stale MCP replacement rereads once and stops on the second conflict", "A real concurrent update made the first If-Match stale: CLI received 409, rediscovered/reread a different timestamp, then received 200 with the same ID. Two consecutive concurrent writes produced exactly two 409 PUTs and a nonzero exit, not a third attempt.", true);

    const faults: Array<number | "disconnect"> = [429, 500, 502, 503, "disconnect"];
    for (const fault of faults) {
      proxy.faults.push(fault);
      const failed = await cli(single);
      expect(failed.status).not.toBe(0);
      expect(writes(failed.requests)).toHaveLength(1);
      expect(failed.stdout).toBe("");
      if (fault === 502) expect(failed.stderr).toContain("could not be validated");
      else if (fault === "disconnect") expect(failed.stderr).toContain("outcome uncertain");
      else expect(failed.stderr).toContain(`HTTP ${fault}`);
    }
    const invalid = await cli({ version: 1, mcpConnections: { "invalid-probe": { ...httpBody, name: "Invalid MCP witness", url: `${proxy.url}/v1/invalid-mcp` } }, marketplaces: { "must-not-run": { name: "Must not run after MCP failure" } } });
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain("HTTP 502");
    expect(invalid.stderr).toContain("could not be validated");
    expect(writes(invalid.requests)).toHaveLength(1);
    expect(writes(invalid.requests)[0].status).toBe(502);
    expect(proxy.invalidProbes()).toBeGreaterThan(0);
    expect((await request("/v1/marketplaces/by-key/must-not-run")).response.status).toBe(404);
    const afterFailures = await request("/v1/mcp-connections?scope=manageable");
    expect(rows(record(afterFailures.body).connections).some((row) => row.externalKey === "invalid-probe")).toBe(false);
    expect((await snapshot()).map((row) => row.id)).toEqual(secondConnections.map((row) => row.id));
    evidence.recordAssertionEvidence("MCP network and server failures never trigger blind retries or expose raw errors", "429/500/502/503 and a response lost after persistence each caused exactly one PUT and a nonzero exit. Both injected and real validation 502s said could not be validated without the synthetic secret diagnostic. Real failed creation reserved no key and the later marketplace was not written; existing MCP IDs survived.", true);

    const deleteWithoutAccess = { ...manifest, mcpConnections: Object.fromEntries(Object.keys(connections).map((key) => [key, {}])) };
    const removed = await cli(deleteWithoutAccess, true, true);
    expect(removed.status, removed.stderr).toBe(0);
    expect(removed.requests).toHaveLength(count);
    expect(removed.requests.every((entry) => entry.method === "DELETE" && entry.body === undefined && entry.ifMatch === null)).toBe(true);
    expect(await snapshot()).toEqual([]);
    const repeat = await cli(deleteWithoutAccess, true, true);
    expect(repeat.status, repeat.stderr).toBe(0);
    expect(repeat.requests.every((entry) => entry.status === 200)).toBe(true);
    expect(proxy.faults).toEqual([]);
    evidence.recordAssertionEvidence("Deletion needs neither MCP access nor environment credentials", "The complete manifest deleted in reverse order with MCP entries containing keys only and all substituted credentials unset. No reads or PUTs occurred; a repeated delete succeeded and the manageable MCP set was empty.", true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
