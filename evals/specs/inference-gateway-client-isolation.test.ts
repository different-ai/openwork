import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { eventually, needs, test } from "@openwork/testkit";
import { isRecord, readBody, stopChild } from "../worlds/openwork-server-cli.ts";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const hostHeaders = { "x-openwork-host-token": "test-host-token", "content-type": "application/json" };
const clientHeaders = { authorization: "Bearer test-client-token", "content-type": "application/json" };
const oldId = "lpr_01kx4t3amgendr682dmp6120jv";
const oldEnv = "LPR_120JV_GOOGLE_GENERATIVE_AI_API_KEY";
const key = "ow_inf_fixture_only";
const authorizationUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture&state=fixture-pkce";

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected JSON object");
  return value;
}

async function fixture(gatewayIds = ["ipr_first", "ipr_second"]) {
  needs({ commands: ["pnpm", "bun"] });
  const root = await mkdtemp(join(tmpdir(), "gateway-client-isolation-"));
  const requests: Array<{ path: string; authorization: string | undefined; org: string | undefined; legacyOrg: string | undefined; cookie: string | undefined; accept: string | undefined }> = [];
  const engineAuth = new Map<string, string>([["personal", "personal-auth"], [oldId, "old-org-key"]]);
  let gatewayEnabled = false;
  let unscopedGateway = false;
  let shortGatewayNames = false;
  let responseUrl = authorizationUrl;
  let redirect = false;
  let releaseOAuth: (() => void) | null = null;
  let holdOAuth = false;
  const gateway = (id: string) => {
    const prefix = shortGatewayNames ? `IPR_${id.slice(-5).toUpperCase()}` : id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const envName = `${prefix}_GOOGLE_GENERATIVE_AI_API_KEY`;
    return {
      id, name: `Vertex ${id}`, providerId: "google-vertex", source: "openwork_gateway",
      credentialMode: "org", credentialStatus: "ready", updatedAt: "2026-09-07T00:00:00Z", authUrl: null,
      providerConfig: { npm: "@ai-sdk/google", env: [envName], options: { baseURL: `https://gateway.example.test/api/v1/providers/${id}` } },
      models: [{ id: "fixture-model", name: "Fixture model", config: {} }],
      apiKey: key, apiKeys: { [envName]: key },
    };
  };
  const http = createServer(async (request, response) => {
    const path = request.url ?? "";
    if (path.startsWith("/auth/")) {
      const id = decodeURIComponent(path.slice(6));
      if (request.method === "PUT") {
        const payload = record(JSON.parse(await readBody(request)));
        if (typeof payload.key === "string") engineAuth.set(id, payload.key);
      }
      if (request.method === "DELETE") engineAuth.delete(id);
      response.setHeader("content-type", "application/json");
      response.end("true");
      return;
    }
    if (!path.startsWith("/api/den/")) {
      if (path === "/exfiltration") requests.push({ path, authorization: request.headers.authorization, org: undefined, legacyOrg: undefined, cookie: request.headers.cookie, accept: request.headers.accept });
      response.setHeader("content-type", "application/json");
      response.end("{}");
      return;
    }
    requests.push({ path, authorization: request.headers.authorization, org: request.headers["x-openwork-org-id"]?.toString(), legacyOrg: request.headers["x-openwork-legacy-org-id"]?.toString(), cookie: request.headers.cookie, accept: request.headers.accept });
    response.setHeader("content-type", "application/json");
    if (request.headers.authorization !== "Bearer desktop-fixture-session") {
      response.statusCode = 401; response.end('{}'); return;
    }
    if (path.endsWith("/oauth/start")) {
      if (path.includes("ipr_other")) { response.statusCode = 403; response.end('{}'); return; }
      if (holdOAuth) await new Promise<void>((resolve) => { releaseOAuth = resolve; });
      if (redirect) {
        response.statusCode = 302;
        response.setHeader("location", `${base}/exfiltration`);
        response.end(); return;
      }
      response.end(JSON.stringify({ authUrl: responseUrl })); return;
    }
    if (path === "/api/den/v1/llm-providers") { response.end('{"llmProviders":[]}'); return; }
    if (path === "/api/den/v1/inference-providers?scope=usable") {
      response.end(JSON.stringify({ inferenceProviders: gatewayEnabled ? gatewayIds.map(gateway) : [] })); return;
    }
    const match = /^\/api\/den\/v1\/inference-providers\/(ipr_[a-z0-9]+)\/connect$/.exec(path);
    const provider = match && gatewayIds.includes(match[1]) ? gateway(match[1]) : null;
    response.end(JSON.stringify(provider ? { inferenceProvider: unscopedGateway
      ? { ...provider, providerConfig: { ...provider.providerConfig, env: ["GOOGLE_GENERATIVE_AI_API_KEY"] }, apiKeys: { GOOGLE_GENERATIVE_AI_API_KEY: key } }
      : provider } : {}));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  const configPath = join(root, "server.json");
  await writeFile(configPath, JSON.stringify({
    host: "127.0.0.1", port: 0, token: "test-client-token", hostToken: "test-host-token",
    approval: { mode: "auto" }, corsOrigins: ["http://localhost:5173"],
    workspaces: [{ id: "ws_fixture", name: "Fixture", path: root, baseUrl: base }],
    authorizedRoots: [root], opencodeBaseUrl: base, logRequests: false,
  }));
  let child: ChildProcess | null = null;
  let serverUrl = "";
  async function boot() {
    let logs = "";
    child = spawn("pnpm", ["exec", "bun", "--conditions=development", "src/cli.ts", "--config", configPath], {
      cwd: join(repo, "apps/server"),
      env: {
        PATH: process.env.PATH, HOME: root, OPENWORK_DATA_DIR: root,
        OPENWORK_RUNTIME_DB: join(root, "runtime.sqlite"), OPENWORK_ENV_STORE: join(root, "env.json"),
        OPENWORK_TOKEN_STORE: join(root, "tokens.json"), OPENWORK_MANAGE_OPENCODE: "0",
        OPENWORK_CLOUD_PROVIDER_SYNC_INTERVAL_MS: "3600000", OPENWORK_LOG_REQUESTS: "false",
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (data: Buffer) => { logs += data.toString(); });
    child.stderr?.on("data", (data: Buffer) => { logs += data.toString(); });
    await eventually(async () => {
      if (child?.exitCode !== null) throw new Error(`Server exited: ${logs}`);
      const url = /OpenWork server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(logs)?.[1];
      if (!url) return false;
      serverUrl = url;
      return (await fetch(`${url}/health`)).ok;
    }, { within: 30_000, intervalMs: 100, label: "isolated local server boot" });
  }
  const request = (path: string, method = "GET", data?: unknown, headers: Record<string, string> = hostHeaders) =>
    fetch(`${serverUrl}${path}`, { method, headers, ...(data !== undefined ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(15_000) });
  const session = async () => {
    expect((await request("/den-session", "PUT", { baseUrl: `${base}/api/den`, token: "desktop-fixture-session", orgId: "org_fixture" })).status).toBe(204);
    const result = await request("/cloud-provider-sync/run", "POST", {});
    expect(record(await result.json()).status).not.toBe("failed");
  };
  const dispose = async () => {
    releaseOAuth?.();
    if (child) await stopChild(child);
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  };
  try {
    await boot();
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    requests, engineAuth, request, session, base,
    enableGateway() { gatewayEnabled = true; },
    removeGateway(id: string) { gatewayIds = gatewayIds.filter((entry) => entry !== id); },
    useShortGatewayNames() { shortGatewayNames = true; },
    useUnscopedGateway() { unscopedGateway = true; },
    setOAuthResponse(url: string) { responseUrl = url; },
    redirectOAuth() { redirect = true; },
    holdOAuth() { holdOAuth = true; },
    releaseOAuth() { releaseOAuth?.(); },
    async restart() { if (child) await stopChild(child); await boot(); },
    [Symbol.asyncDispose]: dispose,
  };
}

test("desktop OAuth uses the authenticated local boundary, never browser cookies or caller URLs", async ({ evidence }) => {
  await using f = await fixture();
  const path = "/cloud-provider-sync/providers/ipr_first/oauth/start";
  expect((await f.request(path, "POST", { orgId: "org_fixture" }, {})).status).toBe(401);
  expect((await f.request(path, "POST", { orgId: "org_fixture" }, clientHeaders)).status).toBe(401);
  expect((await f.request(path, "POST", { orgId: "org_fixture" })).status).toBe(401);
  await f.session();
  expect((await fetch(`${f.base}/api/den/v1/inference-providers/ipr_first/oauth/start`)).status).toBe(401);
  const result = await f.request(path, "POST", { orgId: "org_fixture" });
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ authorizationUrl });
  const started = f.requests.filter((entry) => entry.path.endsWith("/oauth/start") && entry.authorization);
  expect(started).toHaveLength(1);
  expect(started[0]).toMatchObject({ authorization: "Bearer desktop-fixture-session", org: "org_fixture", legacyOrg: "org_fixture", accept: "application/json", cookie: undefined });
  const before = f.requests.length;
  expect((await f.request(path, "POST", { orgId: "org_other" })).status).toBe(403);
  expect((await f.request(path, "POST", { orgId: "org_fixture", authUrl: `${f.base}/exfiltration` })).status).toBe(400);
  expect((await f.request(path, "POST", { orgId: "org_fixture" }, { ...hostHeaders, origin: "https://evil.example.test" })).status).toBe(403);
  expect(f.requests).toHaveLength(before);
  expect((await f.request(path.replace("ipr_first", "ipr_other"), "POST", { orgId: "org_fixture" })).ok).toBe(false);
  for (const url of ["https://evil.example.test/authorize", "javascript:alert(1)", `${authorizationUrl}&token=desktop-fixture-session`]) {
    f.setOAuthResponse(url);
    expect((await f.request(path, "POST", { orgId: "org_fixture" })).status).toBe(502);
  }
  f.redirectOAuth();
  expect((await f.request(path, "POST", { orgId: "org_fixture" })).ok).toBe(false);
  expect(f.requests.every((entry) => !entry.path.includes("desktop-fixture-session") && !entry.path.includes("exfiltration"))).toBe(true);
  evidence.recordAssertionEvidence("Authenticated OAuth handoff isolates credentials", "The clean-browser Den request returned 401 while the host-authorized JSON action returned the Google URL. Unauthenticated/client-token/wrong-org/forged-URL/foreign-origin requests failed. Den saw both organization headers and Accept JSON without cookies. Non-Google, token-bearing and redirect responses were rejected without visiting the exfiltration target.", true);
});

test("an OAuth response from a previous desktop session cannot be opened after logout", async ({ evidence }) => {
  await using f = await fixture();
  await f.session();
  f.holdOAuth();
  const pending = f.request("/cloud-provider-sync/providers/ipr_first/oauth/start", "POST", { orgId: "org_fixture" });
  await eventually(() => f.requests.some((entry) => entry.path.endsWith("/oauth/start")), { within: 5_000, intervalMs: 20 });
  expect((await f.request("/den-session", "DELETE")).status).toBe(204);
  f.releaseOAuth();
  expect((await pending).status).toBe(409);
  evidence.recordAssertionEvidence("Stale OAuth response is withheld", "Logout completed while the Den OAuth response was held; releasing it returned 409 rather than an authorization URL.", true);
});

test("cold migration and logout remove only proven cloud credentials while two gateway rows and personal providers coexist", async ({ evidence }) => {
  await using f = await fixture();
  const personal = "personal-google-key";
  const orphan = "LPR_ORPHAN_GOOGLE_GENERATIVE_AI_API_KEY";
  expect((await f.request("/env", "PUT", { entries: [
    { key: "GOOGLE_GENERATIVE_AI_API_KEY", value: personal },
    { key: oldEnv, value: "old-org-key" }, { key: orphan, value: "manual-orphan-key" },
  ] })).status).toBe(200);
  expect((await f.request("/workspace/ws_fixture/config", "PATCH", { opencode: { provider: {
    [oldId]: { id: "google", npm: "@ai-sdk/google", env: [oldEnv], models: {} },
    personal: { id: "google", npm: "@ai-sdk/google", env: ["GOOGLE_GENERATIVE_AI_API_KEY"] },
    lpr_manual: { id: "manual", npm: "@ai-sdk/google", env: [orphan] },
  } } }, clientHeaders)).status).toBe(200);
  await f.restart();
  f.enableGateway();
  await f.session();
  const env = record(await (await f.request("/env")).json()).items;
  expect(env).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: "GOOGLE_GENERATIVE_AI_API_KEY", value: personal }),
    expect.objectContaining({ key: orphan, value: "manual-orphan-key" }),
    expect.objectContaining({ key: "IPR_FIRST_GOOGLE_GENERATIVE_AI_API_KEY", value: key }),
    expect.objectContaining({ key: "IPR_SECOND_GOOGLE_GENERATIVE_AI_API_KEY", value: key }),
  ]));
  expect(JSON.stringify(env)).not.toContain(oldEnv);
  expect(f.engineAuth.has(oldId)).toBe(false);
  expect(f.engineAuth.get("ipr_first")).toBe(key);
  expect(f.engineAuth.get("ipr_second")).toBe(key);
  const providers = record(record(await (await f.request("/runtime-config/providers")).json()).provider);
  expect(Object.keys(providers).sort()).toEqual(["ipr_first", "ipr_second", "lpr_manual", "personal"]);
  expect(record(providers.ipr_first).env).not.toEqual(record(providers.ipr_second).env);
  await f.restart();
  expect((await f.request("/den-session", "DELETE")).status).toBe(204);
  const after = record(await (await f.request("/env")).json()).items;
  expect(JSON.stringify(after)).not.toContain("IPR_");
  expect(JSON.stringify(after)).toContain(personal);
  expect(JSON.stringify(after)).toContain("manual-orphan-key");
  expect(f.engineAuth.has("ipr_first")).toBe(false);
  expect(f.engineAuth.has("ipr_second")).toBe(false);
  expect(f.engineAuth.get("personal")).toBe(personal);
  expect(f.engineAuth.get("lpr_manual")).toBe("manual-orphan-key");
  expect(Object.keys(record(record(await (await f.request("/runtime-config/providers")).json()).provider)).sort()).toEqual(["lpr_manual", "personal"]);
  evidence.recordAssertionEvidence("Cold credential ownership and row isolation", "After a real CLI restart, the migrated BYOK row's exact scoped env and engine auth were removed. Two gateway rows used distinct env bindings; personal and unrelated imported keys remained. Another cold restart followed by logout removed both gateway env/auth records while retaining personal and imported provider config/auth.", true);
});

test("an unscoped gateway connect payload cannot overwrite a personal env slot", async ({ evidence }) => {
  await using f = await fixture();
  expect((await f.request("/env", "PUT", { key: "GOOGLE_GENERATIVE_AI_API_KEY", value: "personal-key" })).status).toBe(200);
  f.enableGateway();
  f.useUnscopedGateway();
  expect((await f.request("/den-session", "PUT", { baseUrl: `${f.base}/api/den`, token: "desktop-fixture-session", orgId: "org_fixture" })).status).toBe(204);
  expect(record(await (await f.request("/cloud-provider-sync/run", "POST", {})).json()).status).toBe("failed");
  expect(record(await (await f.request("/env/GOOGLE_GENERATIVE_AI_API_KEY")).json()).item).toMatchObject({ value: "personal-key" });
  expect(f.engineAuth.has("ipr_first")).toBe(false);
  expect((await f.request("/den-session", "DELETE")).status).toBe(204);
  expect(record(await (await f.request("/env/GOOGLE_GENERATIVE_AI_API_KEY")).json()).item).toMatchObject({ value: "personal-key" });
  evidence.recordAssertionEvidence("Unscoped gateway credentials fail closed", "The invalid Den connect payload failed sync before env/auth materialization. The personal bare key survived both the failed sync and logout.", true);
});

test("gateway rows with the same last five ID characters retain independent full-ID credentials and display identities", async ({ evidence }) => {
  const first = "ipr_01kx4t3amgendr682dmp6120jv";
  const second = "ipr_01kx4t3amgendr682dmp7120jv";
  const firstEnv = "IPR_01KX4T3AMGENDR682DMP6120JV_GOOGLE_GENERATIVE_AI_API_KEY";
  const secondEnv = "IPR_01KX4T3AMGENDR682DMP7120JV_GOOGLE_GENERATIVE_AI_API_KEY";
  expect(first).toMatch(/^ipr_[0-9a-hjkmnp-tv-z]{26}$/);
  expect(second).toMatch(/^ipr_[0-9a-hjkmnp-tv-z]{26}$/);
  expect(first.slice(-5)).toBe(second.slice(-5));
  await using f = await fixture([first, second]);
  f.enableGateway();
  await f.session();
  const providers = record(record(await (await f.request("/runtime-config/providers")).json()).provider);
  expect(record(providers[first])).toMatchObject({ name: `Vertex ${first}`, env: [firstEnv] });
  expect(record(providers[second])).toMatchObject({ name: `Vertex ${second}`, env: [secondEnv] });
  const status = record(await (await f.request("/cloud-provider-sync/status", "GET", undefined, clientHeaders)).json());
  expect(status.providers).toEqual(expect.arrayContaining([first, second].map((id) => expect.objectContaining({ cloudProviderId: id, providerId: id, name: `Vertex ${id}`, source: "openwork_gateway" }))));
  expect(record(await (await f.request(`/env/${firstEnv}`)).json()).item).toMatchObject({ value: key });
  expect(record(await (await f.request(`/env/${secondEnv}`)).json()).item).toMatchObject({ value: key });
  expect(f.engineAuth.get(first)).toBe(key);
  expect(f.engineAuth.get(second)).toBe(key);
  await f.restart();
  f.removeGateway(first);
  await f.session();
  expect((await f.request(`/env/${firstEnv}`)).status).toBe(404);
  expect(record(await (await f.request(`/env/${secondEnv}`)).json()).item).toMatchObject({ value: key });
  expect(f.engineAuth.has(first)).toBe(false);
  expect(f.engineAuth.get(second)).toBe(key);
  f.useShortGatewayNames();
  expect(record(await (await f.request("/cloud-provider-sync/run", "POST", {})).json()).status).toBe("failed");
  expect((await f.request("/env/IPR_120JV_GOOGLE_GENERATIVE_AI_API_KEY")).status).toBe(404);
  expect(record(await (await f.request(`/env/${secondEnv}`)).json()).item).toMatchObject({ value: key });
  evidence.recordAssertionEvidence("Full gateway IDs isolate same-suffix rows", "Two real-form ipr IDs sharing 120jv materialized separate full-ID env/auth bindings, retained their names and gateway source per resource, and removing one after restart preserved the other. The former last-five env format was rejected without creating its shared slot or changing the surviving credential.", true);
});
