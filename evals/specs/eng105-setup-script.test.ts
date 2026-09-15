import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { needs, test } from "@openwork/testkit";
import { sanitizedLiveProofEnvironment } from "./eng105-live-environment.ts";

const script = fileURLToPath(new URL("../../scripts/demo/setup-eng105-den.sh", import.meta.url));
const prefix = "exp-eng105-test-";
const org = "org_eng105_witness";
const apiKey = "eng105-synthetic-admin-canary";
const credential = "eng105-synthetic-provider-canary";
const home = `${prefix}acme-home-demo`;
const clocks = `${prefix}world-clocks-demo`;
const calendar = `${prefix}personal-calendar-demo`;
const keys = [home, clocks, calendar];
const byKey = "/v1/mcp-connections/by-key/";
const listPath = "/v1/mcp-connections?scope=manageable";

test("ENG105 live child environment excludes inherited shell startup hooks", async ({ evidence }) => {
  const source = {
    PATH: process.env.PATH,
    DEN_API_KEY: apiKey,
    BASH_ENV: "synthetic-startup-hook",
    ENV: "synthetic-env-hook",
    PROMPT_COMMAND: "synthetic-prompt-hook",
    SHELLOPTS: "xtrace",
    PS4: "synthetic-trace-prefix",
  };
  const childEnvironment = sanitizedLiveProofEnvironment(source);
  for (const name of ["BASH_ENV", "ENV", "PROMPT_COMMAND", "SHELLOPTS", "PS4"]) {
    assert.equal(Object.hasOwn(childEnvironment, name), false);
  }
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ["-e", "const names=['BASH_ENV','ENV','PROMPT_COMMAND','SHELLOPTS','PS4'];console.log(JSON.stringify({present:names.filter(name=>Object.hasOwn(process.env,name)),hasCredential:Boolean(process.env.DEN_API_KEY)}))"],
      { env: childEnvironment, encoding: "utf8" }, (error, result) => error ? reject(error) : resolve(result));
  });
  assert.deepEqual(JSON.parse(stdout), { present: [], hasCredential: true });
  assert.equal(source.BASH_ENV, "synthetic-startup-hook", "The parent environment is not mutated");
  evidence.recordAssertionEvidence("Live child receives no shell startup hooks", "Observed child environment contains none of BASH_ENV, ENV, PROMPT_COMMAND, SHELLOPTS or PS4; a synthetic credential is retained without printing its value.", true);
});

interface Connection {
  id: string;
  externalKey: string;
  name: string;
  url: string;
  authType: string;
  credentialMode: string;
  exposeDirectly: boolean;
  access: { orgWide: boolean; memberIds: string[]; teamIds: string[] };
  connected?: boolean;
  authorizationServerIssuer?: string;
  requestedScopes?: string[];
  apiKey?: string;
}

interface RequestRecord {
  method: string;
  path: string;
  authenticated: boolean;
  body: Record<string, unknown> | null;
}

interface Fault {
  method: string;
  path: string;
  status: number;
  body: unknown;
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Expected a JSON object");
  return Object.fromEntries(Object.entries(value));
}

function jsonObjects(text: string): Record<string, unknown>[] {
  const value: unknown = JSON.parse(text);
  assert.ok(Array.isArray(value), "stdout must contain exactly one JSON receipts array");
  return value.map(object);
}

function seed(key: string, id: string): Connection {
  const oauth = key === calendar;
  const label = key === home ? "Acme Home" : key === clocks ? "World Clocks" : "Personal Calendar";
  const host = key === home ? "home" : key === clocks ? "clocks" : "calendar";
  return {
    id,
    externalKey: key,
    name: `${prefix}${label}`,
    url: `https://${host}.example.test/mcp`,
    authType: oauth ? "oauth" : "none",
    credentialMode: oauth ? "per_member" : "shared",
    exposeDirectly: false,
    access: { orgWide: true, memberIds: ["member_existing"], teamIds: ["team_existing"] },
    apiKey: credential,
    ...(oauth ? { authorizationServerIssuer: "https://calendar.example.test", requestedScopes: ["calendar.read"] } : {}),
  };
}

async function witness(options: { advertisedGet?: boolean; routeStatus?: number; calendarScopes?: string[]; full?: boolean; dashboardApi?: boolean; teammateEmail?: string; afterConnect?: boolean } = {}) {
  needs({ commands: ["bash", "curl", "jq"], placement: "local" });
  const root = await mkdtemp(join(tmpdir(), "eng105-setup-script-"));
  const state = join(root, "state");
  const manifestPath = join(state, "owner.json");
  const connections = new Map<string, Connection>();
  const dashboards = new Map<string, { id: string; name: string; elements: unknown[] }>();
  const grants = new Map<string, Record<string, unknown>[]>();
  const invitations: { id: string; email: string; status: string; inviteToken: string }[] = [];
  const members = [{ id: "member_admin", user: { email: "admin@example.test" } }];
  const requests: RequestRecord[] = [];
  const faults: Fault[] = [];
  const unexpected: string[] = [];
  let nextId = 0;
  let organizationId = org;
  const advertisedGet = options.advertisedGet ?? true;

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? object(JSON.parse(text)) : null;
    const method = request.method ?? "";
    const path = request.url ?? "";
    const authenticated = request.headers["x-api-key"] === apiKey;
    requests.push({ method, path, authenticated, body });
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify(value));
    };
    if (!authenticated) return reply(401, { error: "Missing witness authentication" });
    const fault = faults.find((item) => item.method === method && item.path === path);
    if (fault) return reply(fault.status, fault.body);
    if (method === "GET" && path === "/v1/org") {
      return reply(200, { organization: { id: organizationId }, currentMember: { id: "member_admin" }, members, invitations, apiKey: credential });
    }
    if (method === "GET" && path === "/openapi.json") {
      return reply(200, { paths: {
        "/v1/mcp-connections/by-key/{externalKey}": { put: {}, ...(advertisedGet ? { get: {} } : {}) },
        "/v1/invitations": { post: {} },
        ...(options.dashboardApi ? {
          "/v1/dashboards": { get: {}, post: {} },
          "/v1/dashboards/{dashboardId}": { get: {}, delete: {}, patch: {} },
          "/v1/dashboards/{dashboardId}/access": { get: {}, post: {} },
        } : {}),
      } });
    }
    if (method === "POST" && path === "/v1/invitations") {
      assert.ok(body && typeof body.email === "string");
      const invite = { id: `inv_created_${++nextId}`, email: body.email, status: "pending", inviteToken: credential };
      invitations.push(invite);
      return reply(201, { invitationId: invite.id, inviteToken: credential });
    }
    if (method === "POST" && path.startsWith("/v1/invitations/") && path.endsWith("/cancel")) {
      const invitation = invitations.find((item) => path === `/v1/invitations/${item.id}/cancel`);
      assert.ok(invitation);
      invitation.status = "canceled";
      return reply(200, { ok: true });
    }
    if (path === "/v1/dashboards") {
      if (method === "GET") return reply(200, { items: [...dashboards.values()] });
      if (method === "POST") {
        assert.ok(body && typeof body.name === "string" && Array.isArray(body.elements));
        const dashboard = { id: `dsb_created_${++nextId}`, name: body.name, elements: body.elements };
        dashboards.set(dashboard.id, dashboard);
        grants.set(dashboard.id, []);
        return reply(201, { item: dashboard });
      }
    }
    if (path.startsWith("/v1/dashboards/")) {
      const id = path.split("/")[3];
      assert.ok(id);
      const dashboard = dashboards.get(id);
      if (!dashboard) return reply(404, { error: "not_found" });
      if (path.endsWith("/access")) {
        if (method === "GET") return reply(200, { items: grants.get(id) ?? [] });
        if (method === "POST") {
          assert.ok(body);
          const grant = { id: `dsg_created_${++nextId}`, ...body, orgWide: false, removedAt: null };
          grants.set(id, [...(grants.get(id) ?? []), grant]);
          return reply(201, { item: grant });
        }
      } else {
        if (method === "GET") return reply(200, { item: dashboard });
        if (method === "DELETE") { dashboards.delete(id); return reply(204, null); }
        if (method === "PATCH") {
          assert.ok(body && Array.isArray(body.elements));
          dashboard.elements = body.elements;
          return reply(200, { item: dashboard });
        }
      }
    }
    if (method === "GET" && path === listPath) {
      return reply(200, { connections: [...connections.values()].map(({ id, externalKey }) => ({ id, externalKey })) });
    }
    if (path.startsWith(byKey)) {
      const key = path.slice(byKey.length);
      const existing = connections.get(key);
      if (method === "GET") {
        if (options.routeStatus !== undefined) return reply(options.routeStatus, { error: "Witness route unavailable" });
        return existing ? reply(200, existing) : reply(404, { error: "Connection not found" });
      }
      if (method === "PUT") {
        assert.ok(body);
        assert.ok(keys.includes(key), "Script must not mutate an unrelated key");
        const connection = Object.assign(seed(key, existing?.id ?? `mcp_created_${++nextId}`), existing, body);
        connections.set(key, connection);
        return reply(existing ? 200 : 201, connection);
      }
      if (method === "DELETE") {
        return reply(200, { ok: true, deleted: connections.delete(key) });
      }
    }
    if (method === "GET" && path.startsWith("/v1/mcp-connections/") && path.endsWith("/mcp-apps")) {
      const id = path.split("/")[3];
      const connection = [...connections.values()].find((item) => item.id === id);
      assert.ok(connection);
      const toolName = connection.externalKey === home ? "acme_home" : connection.externalKey === calendar ? "show_calendar" : "show_world_clocks";
      const app = { serverName: "witness", connectionId: id, toolName, projectedToolName: `mcp:${id}:${toolName}`, resourceUri: `ui://witness/${toolName}.html`, title: toolName, requiresInput: false, requiresApproval: false };
      return reply(200, { apps: [app, ...(connection.externalKey === clocks ? [{ ...app, toolName: "unrelated_clock_app", projectedToolName: `mcp:${id}:unrelated_clock_app`, resourceUri: "ui://witness/unrelated.html" }] : [])] });
    }
    if (method === "GET" && path.startsWith("/v1/mcp-connections/")) {
      const id = path.slice("/v1/mcp-connections/".length);
      const connection = [...connections.values()].find((item) => item.id === id);
      return connection ? reply(200, connection) : reply(404, { error: "Connection not found" });
    }
    unexpected.push(`${method} ${path}`);
    reply(500, { error: "Unexpected witness request" });
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      unexpected.push("Witness handler rejected a request");
      response.writeHead(500);
      response.end('{"error":"Witness handler failure"}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const api = `http://127.0.0.1:${address.port}`;

  return {
    connections,
    dashboards,
    grants,
    invitations,
    members,
    requests,
    faults,
    api,
    state,
    manifestPath,
    setOrganization(id: string) { organizationId = id; },
    async manifest() { return object(JSON.parse(await readFile(manifestPath, "utf8"))); },
    async run(mode: "--apply" | "--verify" | "--teardown", expectedOrg = org, afterConnect = options.afterConnect ?? false) {
      const start = requests.length;
      const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
        execFile("bash", [script, mode, ...(options.full ? [] : ["--connections-only"]), ...(afterConnect ? ["--after-connect"] : [])], {
          cwd: root,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            HOME: root,
            TMPDIR: root,
            LC_ALL: "C",
            NO_PROXY: "*",
            DEN_API_URL: api,
            DEN_API_KEY: apiKey,
            DEMO_EXPECTED_ORG_ID: expectedOrg,
            DEMO_KEY_PREFIX: prefix,
            DEMO_STATE_DIR: state,
            DEMO_HOME_URL: "https://home.example.test/mcp",
            DEMO_CLOCKS_URL: "https://clocks.example.test/mcp",
            DEMO_CALENDAR_URL: "https://calendar.example.test/mcp",
            DEMO_CALENDAR_ISSUER: "https://calendar.example.test",
            DEMO_CALENDAR_SCOPES: JSON.stringify(options.calendarScopes ?? ["calendar.read"]),
            DEMO_TEAMMATE_EMAIL: options.teammateEmail,
          },
        }, (error, stdout, stderr) => {
          if (!error) {
            resolve({ code: 0, stdout, stderr });
          } else if (!error.killed && typeof error.code === "number") {
            resolve({ code: error.code, stdout, stderr });
          } else {
            reject(new Error("Setup script failed to launch or exceeded its 30-second bound"));
          }
        });
      });
      for (const marker of [apiKey, credential]) {
        assert.equal(result.stdout.includes(marker), false, "stdout leaked a synthetic credential");
        assert.equal(result.stderr.includes(marker), false, "stderr leaked a synthetic credential");
      }
      assert.deepEqual(unexpected, [], "Only modeled public connection APIs may be used");
      const calls = requests.slice(start);
      assert.ok(calls.length > 0);
      assert.ok(calls.every((call) => call.authenticated));
      const receipts = jsonObjects(result.stdout);
      for (const row of receipts) {
        for (const field of ["key", "phase", "url", "status", "ok", "connectionId", "errorBody"]) {
          assert.ok(Object.hasOwn(row, field), `Receipt missing ${field}`);
        }
        assert.equal(typeof row.key, "string");
        assert.equal(typeof row.phase, "string");
        assert.equal(typeof row.status, "number");
        assert.equal(typeof row.ok, "boolean");
        assert.ok(row.url === null || (typeof row.url === "string" && row.url.startsWith(`${api}/`)));
        assert.ok(row.connectionId === null || typeof row.connectionId === "string");
      }
      return { ...result, receipts, requests: calls };
    },
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

function mutations(requests: RequestRecord[]) {
  return requests.filter((request) => request.method !== "GET");
}

function rows(receipts: Record<string, unknown>[], phase: string) {
  return receipts.filter((row) => row.phase === phase);
}

function populate(connections: Map<string, Connection>) {
  for (const [index, key] of keys.entries()) connections.set(key, seed(key, `mcp_existing_${index}`));
}

test("ENG105 connections-only apply is idempotent and persists ownership without credentials", async ({ evidence }) => {
  await using api = await witness();
  const first = await api.run("--apply");
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(rows(first.receipts, "apply").map((row) => row.status), [201, 201, 201]);
  const ids = rows(first.receipts, "apply").map((row) => row.connectionId);
  assert.equal(new Set(ids).size, 3);
  const before = structuredClone([...api.connections]);
  const manifestBefore = await readFile(api.manifestPath, "utf8");
  const second = await api.run("--apply");
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(rows(second.receipts, "apply").map((row) => row.status), [200, 200, 200]);
  assert.deepEqual(rows(second.receipts, "apply").map((row) => row.connectionId), ids);
  assert.deepEqual([...api.connections], before);
  assert.deepEqual(mutations(first.requests).map((call) => [call.method, call.path]), keys.map((key) => ["PUT", `${byKey}${key}`]));
  assert.deepEqual(mutations(second.requests).map((call) => [call.method, call.path]), keys.map((key) => ["PUT", `${byKey}${key}`]));
  assert.equal(await readFile(api.manifestPath, "utf8"), manifestBefore);
  const manifest = await api.manifest();
  assert.deepEqual(manifest, {
    version: 1,
    api: api.api,
    org,
    prefix,
    resources: [...keys].sort().map((key) => ({ kind: "mcp", key, id: api.connections.get(key)?.id })),
  });
  assert.deepEqual(await readdir(api.state), ["owner.json"]);
  assert.equal((await stat(api.state)).mode & 0o777, 0o700);
  assert.equal((await stat(api.manifestPath)).mode & 0o777, 0o600);
  for (const marker of [apiKey, credential]) assert.equal(manifestBefore.includes(marker), false);
  evidence.recordAssertionEvidence("Idempotent connection setup and secret-free ownership", "Two connections-only applies returned 201 then 200 for all three stable IDs; state was unchanged and owner-only manifest contained only resource identities, never synthetic credentials.", true);
});

for (const conflict of ["issuer", "scopes"]) {
  test(`ENG105 OAuth ${conflict} conflict preserves credentials and grants without replacement`, async ({ evidence }) => {
    await using api = await witness();
    populate(api.connections);
    const existing = api.connections.get(calendar);
    assert.ok(existing);
    existing.access.orgWide = false;
    if (conflict === "issuer") existing.authorizationServerIssuer = "https://original-issuer.example.test";
    else existing.requestedScopes = ["calendar.read", "calendar.write"];
    const before = structuredClone([...api.connections]);
    const result = await api.run("--apply");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Existing OAuth issuer\/scopes differ/);
    assert.deepEqual(mutations(result.requests).map((call) => [call.method, call.path]), [["PUT", `${byKey}${home}`], ["PUT", `${byKey}${clocks}`]]);
    assert.deepEqual(rows(result.receipts, "apply").map((row) => [row.key, row.status]), [[home, 200], [clocks, 200]]);
    assert.deepEqual(rows(result.receipts, "verified-state").map((row) => row.key), [home, clocks]);
    assert.deepEqual([...api.connections], before, "Issuer, scopes, credentials, and private member/team grants must remain unchanged");
    assert.deepEqual((await api.manifest()).resources, [], "A preserved preexisting connection must not become script-owned");
    const manifest = await readFile(api.manifestPath, "utf8");
    for (const marker of [apiKey, credential]) assert.equal(manifest.includes(marker), false);
    assert.deepEqual(await readdir(api.state), ["owner.json"]);
    evidence.recordAssertionEvidence(
      "Conflicting OAuth configuration never rotates credentials or grants",
      `The ${conflict} conflict returned exit 1 without a PUT, DELETE, or OAuth action for the protected calendar. Its ID, issuer, scopes, credential canary, private access, and member/team grants were unchanged; other MCPs still completed without acquiring ownership.`,
      true,
    );
  });
}

test("ENG105 equivalent reordered OAuth scopes allow PUT without credential or grant rotation", async ({ evidence }) => {
  const requestedScopes = ["calendar.read", "calendar.write"];
  await using api = await witness({ calendarScopes: requestedScopes });
  populate(api.connections);
  const existing = api.connections.get(calendar);
  assert.ok(existing);
  existing.requestedScopes = [...requestedScopes].reverse();
  const before = structuredClone(existing);
  const result = await api.run("--apply");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(mutations(result.requests).map((call) => [call.method, call.path]), keys.map((key) => ["PUT", `${byKey}${key}`]));
  const put = mutations(result.requests).find((call) => call.path === `${byKey}${calendar}`);
  assert.ok(put);
  assert.deepEqual(put.body, {
    name: before.name,
    url: before.url,
    authType: before.authType,
    credentialMode: before.credentialMode,
    exposeDirectly: false,
    access: before.access,
    authorizationServerIssuer: before.authorizationServerIssuer,
    requestedScopes,
  }, "PUT must preserve complete grants and omit all credential/rotation fields");
  assert.deepEqual(api.connections.get(calendar), { ...before, requestedScopes });
  assert.deepEqual(rows(result.receipts, "apply").map((row) => row.status), [200, 200, 200]);
  assert.deepEqual((await api.manifest()).resources, []);
  evidence.recordAssertionEvidence(
    "Equivalent scopes preserve existing credentials and complete grants",
    "A reordered but equivalent scope set allowed HTTP200 with the same ID and issuer. The exact PUT contained unchanged member/team grants and no credential fields; the stored credential canary survived and no preexisting resource became owned.",
    true,
  );
});

for (const missing of ["access", "null access", "memberIds", "teamIds"]) {
  test(`ENG105 missing ${missing} refuses replacement and preserves existing credentials and grants`, async ({ evidence }) => {
    await using api = await witness();
    populate(api.connections);
    const existing = api.connections.get(home);
    assert.ok(existing);
    existing.access.orgWide = false;
    const response = object(existing);
    if (missing === "access") delete response.access;
    else if (missing === "null access") response.access = null;
    else {
      const access = object(existing.access);
      delete access[missing];
      response.access = access;
    }
    api.faults.push({ method: "GET", path: `${byKey}${home}`, status: 200, body: response });
    const before = structuredClone([...api.connections]);
    const result = await api.run("--apply");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Existing grants unavailable; refuse replacement/);
    assert.deepEqual(mutations(result.requests).map((call) => [call.method, call.path]), [["PUT", `${byKey}${clocks}`], ["PUT", `${byKey}${calendar}`]]);
    assert.deepEqual(rows(result.receipts, "apply").map((row) => [row.key, row.status]), [[clocks, 200], [calendar, 200]]);
    assert.deepEqual(rows(result.receipts, "verified-state").map((row) => row.key), [clocks, calendar]);
    assert.deepEqual([...api.connections], before, "Missing read-side grants must never clear server-side grants or credentials");
    assert.deepEqual((await api.manifest()).resources, []);
    const manifest = await readFile(api.manifestPath, "utf8");
    for (const marker of [apiKey, credential]) assert.equal(manifest.includes(marker), false);
    assert.deepEqual(await readdir(api.state), ["owner.json"]);
    evidence.recordAssertionEvidence(
      "Incomplete access summaries cannot authorize grant replacement",
      `A GET with missing ${missing} stopped the affected MCP before any PUT or DELETE. Its existing ID, credential canary, private access, and member/team grants survived; both later MCPs still completed and ownership remained empty.`,
      true,
    );
  });
}

test("ENG105 exact 404 fallback uses externalKey equality and detail, not names or neighboring keys", async ({ evidence }) => {
  await using api = await witness({ advertisedGet: false, routeStatus: 404 });
  const neighbor = seed(`${home}-neighbor`, "mcp_unrelated");
  neighbor.name = `${prefix}Acme Home`;
  api.connections.set(neighbor.externalKey, neighbor);
  populate(api.connections);
  const before = structuredClone([...api.connections]);
  const result = await api.run("--verify");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(mutations(result.requests), []);
  assert.deepEqual(result.requests.filter((call) => call.path.startsWith(byKey)).map((call) => call.path), [`${byKey}${home}`]);
  assert.equal(result.requests.filter((call) => call.path === listPath).length, 3);
  assert.deepEqual(result.requests.filter((call) => /^\/v1\/mcp-connections\/mcp_/.test(call.path)).map((call) => call.path), keys.map((key) => `/v1/mcp-connections/${api.connections.get(key)?.id}`));
  assert.deepEqual(rows(result.receipts, "verified-state").map((row) => row.connectionId), keys.map((key) => api.connections.get(key)?.id));
  assert.deepEqual(rows(result.receipts, "lookup-by-key").map((row) => [row.status, row.ok]), [[404, false]]);
  assert.deepEqual([...api.connections], before);
  evidence.recordAssertionEvidence("Exact 404 fallback preserves identity", "An unadvertised GET returned exactly 404, then each exact externalKey was resolved through list plus detail; a same-name neighboring key was never selected and no writes occurred.", true);
});

for (const status of [401, 403, 500]) {
  test(`ENG105 HTTP ${status} must not authorize list fallback when by-key GET is unadvertised`, async ({ evidence }) => {
    await using api = await witness({ advertisedGet: false, routeStatus: status });
    populate(api.connections);
    const before = structuredClone([...api.connections]);
    const result = await api.run("--apply");
    assert.equal(result.code, 1);
    const fallbackRequests = result.requests.filter((call) => call.path === listPath);
    const writes = mutations(result.requests).map((call) => `${call.method} ${call.path}`);
    evidence.recordAssertionEvidence(
      "Fallback requires a confirmed 404 before any later MCP mutation",
      `By-key HTTP ${status}: ${fallbackRequests.length} list requests; writes: ${JSON.stringify(writes)}. Expected zero fallback requests and zero writes.`,
      fallbackRequests.length === 0 && writes.length === 0,
    );
    assert.deepEqual(fallbackRequests, [], "Only an exact 404 may authorize list fallback, including subsequent MCPs");
    assert.deepEqual(mutations(result.requests), [], "Failed lookups cannot authorize mutations");
    assert.deepEqual([...api.connections], before);
    assert.deepEqual(result.requests.filter((call) => call.path.startsWith(byKey)).map((call) => call.path), keys.map((key) => `${byKey}${key}`));
    evidence.recordAssertionEvidence("Non-404 lookup errors never authorize fallback or writes", `HTTP ${status} remained an error; all MCP lookups were attempted without using list fallback or mutating existing resources.`, true);
  });
}

test("ENG105 advertised by-key 404 means missing, not list fallback", async ({ evidence }) => {
  await using api = await witness();
  const result = await api.run("--verify");
  assert.equal(result.code, 1);
  assert.deepEqual(mutations(result.requests), []);
  assert.equal(result.requests.some((call) => call.path === listPath), false);
  assert.deepEqual(rows(result.receipts, "lookup-by-key").map((row) => [row.status, row.ok]), [[404, false], [404, false], [404, false]]);
  assert.deepEqual(rows(result.receipts, "verified-state"), []);
  evidence.recordAssertionEvidence("Advertised missing-key reads are not success", "Three advertised by-key 404s remained diagnostics, produced no verified rows, and caused neither fallback nor mutation.", true);
});

test("ENG105 verify is read-only and distinguishes connected false from unknown", async ({ evidence }) => {
  await using api = await witness();
  populate(api.connections);
  const homeConnection = api.connections.get(home);
  const calendarConnection = api.connections.get(calendar);
  assert.ok(homeConnection && calendarConnection);
  homeConnection.connected = true;
  calendarConnection.connected = false;
  const before = structuredClone([...api.connections]);
  const result = await api.run("--verify");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(mutations(result.requests), []);
  assert.deepEqual([...api.connections], before);
  assert.deepEqual(rows(result.receipts, "verified-state").map((row) => [row.key, row.connected]), [[home, true], [clocks, "unknown"], [calendar, false]]);
  assert.deepEqual((await api.manifest()).resources, []);
  assert.match(result.stderr, new RegExp(`${calendar}\\t[^\\n]*\\tfalse(?:\\n|$)`));
  assert.match(result.stderr, new RegExp(`${clocks}\\t[^\\n]*\\tunknown(?:\\n|$)`));
  assert.match(result.stderr, /Registration is not OAuth readiness/);
  evidence.recordAssertionEvidence("Read-only readiness preserves false and unknown", "Verify made only GETs, kept all connection state unchanged, and reported false, unknown, and true distinctly without claiming registration completes OAuth.", true);
});

test("ENG105 teardown removes only created IDs and preserves preexisting and replacement identities", async ({ evidence }) => {
  await using api = await witness();
  const preexisting = seed(home, "mcp_preexisting");
  const unrelated = seed(`${prefix}unrelated`, "mcp_unrelated");
  api.connections.set(home, preexisting);
  api.connections.set(unrelated.externalKey, unrelated);
  const applied = await api.run("--apply");
  assert.equal(applied.code, 0, applied.stderr);
  assert.deepEqual(rows(applied.receipts, "apply").map((row) => row.status), [200, 201, 201]);
  const owned = await api.manifest();
  assert.ok(Array.isArray(owned.resources));
  assert.deepEqual(owned.resources.map(object).map((row) => row.key), [calendar, clocks].sort());
  const originalCalendar = api.connections.get(calendar);
  assert.ok(originalCalendar);
  const replacement = { ...originalCalendar, id: "mcp_replacement" };
  api.connections.set(calendar, replacement);
  const removedId = api.connections.get(clocks)?.id;
  const result = await api.run("--teardown");
  assert.equal(result.code, 1, "An identity mismatch must make teardown incomplete");
  assert.deepEqual(mutations(result.requests).map((call) => [call.method, call.path]), [["DELETE", `${byKey}${clocks}`]]);
  assert.equal(api.connections.has(clocks), false);
  assert.deepEqual(api.connections.get(home), preexisting);
  assert.deepEqual(api.connections.get(calendar), replacement);
  assert.deepEqual(api.connections.get(unrelated.externalKey), unrelated);
  assert.equal([...api.connections.values()].some((connection) => connection.id === removedId), false);
  assert.deepEqual((await api.manifest()).resources, [{ kind: "mcp", key: calendar, id: originalCalendar.id }]);
  const second = await api.run("--teardown");
  assert.equal(second.code, 1);
  assert.deepEqual(mutations(second.requests), []);
  assert.deepEqual(api.connections.get(calendar), replacement);
  evidence.recordAssertionEvidence("Teardown is limited to proven script ownership", "Only the created clock ID was deleted. A preexisting connection, unrelated connection, and replacement calendar ID survived; retry performed no writes and retained unresolved ownership.", true);
});

test("ENG105 wrong-org guard rejects a fresh target before discovery or mutation", async ({ evidence }) => {
  await using api = await witness();
  populate(api.connections);
  const before = structuredClone([...api.connections]);
  const result = await api.run("--apply", "org_wrong_target");
  assert.equal(result.code, 1);
  assert.deepEqual(result.requests.map((call) => [call.method, call.path]), [["GET", "/v1/org"]]);
  assert.deepEqual(mutations(result.requests), []);
  assert.deepEqual([...api.connections], before);
  assert.deepEqual(await readdir(api.state), []);
  assert.match(result.stderr, /Organization mismatch/);
  evidence.recordAssertionEvidence("Wrong organization fails closed", "A mismatched expected org stopped after the identity GET, without discovery, server mutations, or a persisted owner manifest.", true);
});

test("ENG105 owner manifest refuses reuse for a different organization", async ({ evidence }) => {
  await using api = await witness();
  const applied = await api.run("--apply");
  assert.equal(applied.code, 0, applied.stderr);
  const manifest = await readFile(api.manifestPath, "utf8");
  const before = structuredClone([...api.connections]);
  api.setOrganization("org_replacement_target");
  const result = await api.run("--teardown", "org_replacement_target");
  assert.equal(result.code, 1);
  assert.deepEqual(result.requests.map((call) => [call.method, call.path]), [["GET", "/v1/org"]]);
  assert.deepEqual(mutations(result.requests), []);
  assert.equal(await readFile(api.manifestPath, "utf8"), manifest);
  assert.deepEqual([...api.connections], before);
  evidence.recordAssertionEvidence("Manifest ownership is organization-bound", "Even when the expected org matched the new identity, an old-org manifest prevented deletion and remained byte-for-byte unchanged.", true);
});

test("ENG105 sanitized HTTP errors remain failures while other MCP applies continue", async ({ evidence }) => {
  await using api = await witness();
  api.faults.push({
    method: "PUT",
    path: `${byKey}${home}`,
    status: 500,
    body: {
      error: "upstream_unavailable",
      apiKey,
      nested: { accessToken: credential, password: credential, authorization: `Bearer ${credential}` },
      message: `Denied ${apiKey}; token=${credential}; https://oauth.example.test/callback?code=${credential}`,
    },
  });
  const result = await api.run("--apply");
  assert.equal(result.code, 1);
  assert.deepEqual(rows(result.receipts, "apply").map((row) => [row.key, row.status, row.ok]), [[home, 500, false], [clocks, 201, true], [calendar, 201, true]]);
  const failed = rows(result.receipts, "apply")[0];
  assert.ok(failed);
  const error = object(failed.errorBody);
  assert.equal(error.error, "upstream_unavailable");
  assert.equal(error.apiKey, "[REDACTED]");
  assert.equal(object(error.nested).accessToken, "[REDACTED]");
  assert.equal(object(error.nested).password, "[REDACTED]");
  assert.equal(object(error.nested).authorization, "[REDACTED]");
  assert.equal(JSON.stringify(error).includes("https://oauth.example.test"), false);
  assert.equal(result.stderr.includes("https://oauth.example.test"), false);
  assert.equal(api.connections.has(home), false);
  assert.ok(api.connections.has(clocks) && api.connections.has(calendar));
  assert.deepEqual(mutations(result.requests).map((call) => call.path), keys.map((key) => `${byKey}${key}`));
  assert.deepEqual(rows(result.receipts, "verified-state").map((row) => row.key), [clocks, calendar]);
  const manifest = await readFile(api.manifestPath, "utf8");
  for (const marker of [apiKey, credential, "upstream_unavailable", "oauth.example.test"]) assert.equal(manifest.includes(marker), false);
  assert.deepEqual(await readdir(api.state), ["owner.json"]);
  evidence.recordAssertionEvidence("Sanitized failure does not block independent MCPs", "The first PUT retained HTTP500 and a useful error code but redacted credentials and OAuth URLs; both remaining MCPs were created and verified, with no failure body or credentials persisted.", true);
});

test("ENG105 full API setup creates three discovered Apps with named access once and cleans up only owned resources", async ({ evidence }) => {
  await using api = await witness({ full: true, dashboardApi: true, teammateEmail: "teammate@example.test", afterConnect: true });
  api.members.push({ id: "member_teammate", user: { email: "teammate@example.test" } });
  api.dashboards.set("dsb_unrelated", { id: "dsb_unrelated", name: "Existing human dashboard", elements: [] });
  const first = await api.run("--apply");
  assert.equal(first.code, 0, first.stderr);
  assert.equal(rows(first.receipts, "dashboard-create").length, 1);
  const ownedDashboard = [...api.dashboards.values()].find((item) => item.id !== "dsb_unrelated");
  assert.ok(ownedDashboard);
  assert.equal(ownedDashboard.name, `${prefix}ENG105 API Demo`);
  assert.equal(ownedDashboard.elements.length, 3);
  assert.deepEqual(ownedDashboard.elements.map(object).map((item) => item.projectedToolName), keys.map((key) => {
    const id = api.connections.get(key)?.id;
    const tool = key === home ? "acme_home" : key === calendar ? "show_calendar" : "show_world_clocks";
    return `mcp:${id}:${tool}`;
  }));
  assert.ok(ownedDashboard.elements.map(object).every((item) => item.organizationAutoLaunch === true));
  const subjects = api.grants.get(ownedDashboard.id) ?? [];
  assert.deepEqual(subjects.map((item) => item.orgMembershipId).sort(), ["member_admin", "member_teammate"]);
  assert.ok(subjects.every((item) => item.orgWide === false && item.role === "viewer"));
  assert.equal(api.invitations.length, 0);
  const manifest = await readFile(api.manifestPath, "utf8");
  const second = await api.run("--apply");
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(rows(second.receipts, "apply").map((item) => [item.status, item.changedFields]), [[200, []], [200, []], [200, []]]);
  assert.deepEqual(mutations(second.requests).map((item) => item.method), ["PUT", "PUT", "PUT"]);
  assert.equal(await readFile(api.manifestPath, "utf8"), manifest);
  const verify = await api.run("--verify");
  assert.equal(verify.code, 0, verify.stderr);
  assert.deepEqual(mutations(verify.requests), []);
  const teardown = await api.run("--teardown");
  assert.equal(teardown.code, 0, teardown.stderr);
  assert.equal(api.connections.size, 0);
  assert.deepEqual([...api.dashboards.keys()], ["dsb_unrelated"]);
  assert.deepEqual((await api.manifest()).resources, []);
  evidence.recordAssertionEvidence("Full API setup is separate, idempotent and owner-scoped", "Three live-discovered bindings and two named viewer grants were created once; second apply wrote only unchanged MCP PUTs. Verify was read-only; teardown preserved the unrelated dashboard.", true);
});

test("ENG105 absent dashboard API exits with explicit manual steps and never allocates a substitute", async ({ evidence }) => {
  await using api = await witness({ full: true });
  const applied = await api.run("--apply");
  assert.equal(applied.code, 0, applied.stderr);
  assert.ok(rows(applied.receipts, "manual-step").some((row) => row.ok === false));
  assert.match(applied.stderr, /Public dashboard API absent/);
  assert.equal(api.dashboards.size, 0);
  assert.ok(mutations(applied.requests).every((row) => row.method === "PUT"));
  evidence.recordAssertionEvidence("Missing API remains an explicit manual gap", "Connection configuration succeeded, but receipts and stderr identify manual dashboard work without claiming readiness or creating a substitute.", true);
});

test("ENG105 full API setup preserves a same-name preexisting dashboard and never claims its ownership", async ({ evidence }) => {
  await using api = await witness({ full: true, dashboardApi: true });
  const original = { id: "dsb_preexisting", name: `${prefix}ENG105 API Demo`, elements: [] };
  api.dashboards.set(original.id, original);
  const applied = await api.run("--apply");
  assert.equal(applied.code, 1);
  assert.deepEqual(api.dashboards.get(original.id), original);
  assert.ok(mutations(applied.requests).every((row) => row.method === "PUT"));
  assert.equal(rows(applied.receipts, "dashboard-create").length, 0);
  const teardown = await api.run("--teardown");
  assert.equal(teardown.code, 0, teardown.stderr);
  assert.deepEqual(api.dashboards.get(original.id), original);
  evidence.recordAssertionEvidence("Same name is not ownership", "The preexisting named dashboard was neither updated, granted, adopted nor deleted; only script-created MCPs were cleaned up.", true);
});

test("ENG105 optional invitation is created once, redacts its token and cancels only its pending owned ID", async ({ evidence }) => {
  await using api = await witness({ teammateEmail: "teammate@example.test" });
  api.invitations.push({ id: "inv_unrelated", email: "other@example.test", status: "pending", inviteToken: credential });
  const first = await api.run("--apply");
  assert.equal(first.code, 0, first.stderr);
  assert.equal(rows(first.receipts, "invite").length, 1);
  assert.equal(api.invitations.length, 2);
  const second = await api.run("--apply");
  assert.equal(second.code, 0, second.stderr);
  assert.equal(rows(second.receipts, "invite").length, 0);
  const manifest = await readFile(api.manifestPath, "utf8");
  assert.equal(manifest.includes(credential), false);
  assert.equal(manifest.includes("teammate@example.test"), false);
  const teardown = await api.run("--teardown");
  assert.equal(teardown.code, 0, teardown.stderr);
  assert.equal(api.invitations.find((item) => item.id === "inv_unrelated")?.status, "pending");
  assert.equal(api.invitations.find((item) => item.id !== "inv_unrelated")?.status, "canceled");
  assert.deepEqual((await api.manifest()).resources, []);
  evidence.recordAssertionEvidence("Invitation idempotence and ownership", "Only an explicitly configured absent teammate was invited; the token stayed out of receipts/state, second apply did not refresh it, and teardown canceled only the newly created pending invitation.", true);
});

test("ENG105 an existing teammate invitation is never refreshed, adopted or canceled", async ({ evidence }) => {
  await using api = await witness({ teammateEmail: "teammate@example.test" });
  api.invitations.push({ id: "inv_preexisting", email: "teammate@example.test", status: "pending", inviteToken: credential });
  const applied = await api.run("--apply");
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(rows(applied.receipts, "invite").length, 0);
  const teardown = await api.run("--teardown");
  assert.equal(teardown.code, 0, teardown.stderr);
  assert.equal(api.invitations[0]?.status, "pending");
  assert.equal(rows(teardown.receipts, "teardown-invitation").length, 0);
  evidence.recordAssertionEvidence("Preexisting invitations are preserved", "An existing pending invitation prevented any invite refresh and never entered ownership or cleanup.", true);
});

test("ENG105 expected Calendar consent creates only shared tiles, then after-connect appends the granted third tile", async ({ evidence }) => {
  await using api = await witness({ full: true, dashboardApi: true });
  populate(api.connections);
  const calendarId = api.connections.get(calendar)?.id;
  const consent = { error: "connection_not_ready", message: "Connect your account before using this MCP's tools." };
  api.faults.push({ method: "GET", path: `/v1/mcp-connections/${calendarId}/mcp-apps`, status: 409, body: consent });
  const stageOne = await api.run("--apply");
  assert.equal(stageOne.code, 0, stageOne.stderr);
  const expected = rows(stageOne.receipts, "expected");
  assert.equal(expected.length, 1);
  assert.deepEqual(expected.map((row) => [row.status, row.ok, row.expected, row.errorBody]), [[409, false, true, consent]]);
  assert.match(stageOne.stderr, /Each member: Connections → Personal Calendar → Connect \(auto-approved\)/);
  const dashboard = [...api.dashboards.values()][0];
  assert.ok(dashboard);
  assert.equal(dashboard.elements.length, 2);
  assert.deepEqual(dashboard.elements.map(object).map((row) => row.toolName), ["acme_home", "show_world_clocks"]);
  assert.ok(dashboard.elements.map(object).every((row) => row.organizationAutoLaunch === true));
  const originalGrants = structuredClone(api.grants.get(dashboard.id));
  const premature = await api.run("--apply", org, true);
  assert.equal(premature.code, 1, "After-connect cannot claim success without the caller's grant");
  assert.equal(dashboard.elements.length, 2);
  assert.equal(mutations(premature.requests).some((row) => row.method === "PATCH"), false);
  api.faults.splice(0); // Witness now represents the calling member having connected.
  const stageTwo = await api.run("--apply", org, true);
  assert.equal(stageTwo.code, 0, stageTwo.stderr);
  assert.equal(rows(stageTwo.receipts, "dashboard-create").length, 0);
  assert.equal(rows(stageTwo.receipts, "dashboard-add-calendar").length, 1);
  assert.equal(dashboard.elements.length, 3);
  assert.equal(object(dashboard.elements[2]).toolName, "show_calendar");
  assert.equal(object(dashboard.elements[2]).organizationAutoLaunch, true);
  assert.deepEqual(api.grants.get(dashboard.id), originalGrants);
  const repeat = await api.run("--apply", org, true);
  assert.equal(repeat.code, 0, repeat.stderr);
  assert.equal(mutations(repeat.requests).some((row) => row.method === "PATCH" || row.method === "POST"), false);
  const verify = await api.run("--verify", org, true);
  assert.equal(verify.code, 0, verify.stderr);
  evidence.recordAssertionEvidence("Explicit shared stage versus consent-complete stage", "Exact Calendar409 remained an expected, unsuccessful discovery receipt. Default created two auto-run shared tiles and named access; premature after-connect made no PATCH. After the caller grant became available, one PATCH appended Calendar without changing identity or grants; repeat made no dashboard writes.", true);
});

for (const change of ["human-edit", "replaced-id"]) {
  test(`ENG105 after-connect preserves ${change} instead of blindly replacing a dashboard`, async ({ evidence }) => {
    await using api = await witness({ full: true, dashboardApi: true });
    const first = await api.run("--apply");
    assert.equal(first.code, 0, first.stderr);
    const dashboard = [...api.dashboards.values()][0];
    assert.ok(dashboard);
    if (change === "human-edit") dashboard.elements[0] = { ...object(dashboard.elements[0]), title: "Human edit" };
    else { api.dashboards.delete(dashboard.id); api.dashboards.set("dsb_replacement", { ...dashboard, id: "dsb_replacement" }); }
    const before = structuredClone([...api.dashboards]);
    const second = await api.run("--apply", org, true);
    assert.equal(second.code, 1);
    assert.deepEqual([...api.dashboards], before);
    assert.equal(mutations(second.requests).some((row) => row.method === "PATCH" || row.method === "POST" || row.method === "DELETE"), false);
    evidence.recordAssertionEvidence("After-connect requires the exact untouched owned stage", `The ${change} was preserved; no dashboard write, replacement allocation, grant change or deletion occurred.`, true);
  });
}
