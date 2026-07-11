import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

const script = resolve(import.meta.dir, "mock-oauth-mcp-server.mjs");
const children = new Set<ChildProcess>();
const DIAGNOSTICS_KEY = "mock-test-diagnostics-key";
const diagnosticsHeaders = { "x-mock-diagnostics-key": DIAGNOSTICS_KEY };
const REDIRECT_URI = "http://127.0.0.1:19876/mock/callback";
const PREREGISTERED_CLIENT = {
  clientId: "mock-preregistered-client",
  clientSecret: "mock-preregistered-secret",
};
const PKCE_VERIFIER = "mock-pkce-verifier-that-is-long-enough-for-testing";
const PKCE_CHALLENGE = createHash("sha256").update(PKCE_VERIFIER).digest("base64url");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function getFreePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error("failed to allocate a mock port");
  return port;
}

async function waitForHealth(baseUrl: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      const body: unknown = await response.json();
      if (response.ok && isRecord(body)) return body;
    } catch {
      // The child process may still be binding its listener.
    }
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting for diagnostic MCP mock");
}

async function startMock(options: {
  profile?: string;
  responseMode?: "json" | "sse";
  fault?: string;
  disableDcr?: boolean;
  autoApprove?: boolean;
  extraEnv?: Record<string, string>;
} = {}) {
  const port = await getFreePort();
  const argv = [script, "--port", String(port)];
  if (options.profile) argv.push("--profile", options.profile);
  if (options.responseMode) argv.push("--response-mode", options.responseMode);
  if (options.fault) argv.push("--fault", options.fault);
  const child = spawn(process.execPath, argv, {
    env: {
      ...process.env,
      AUTO_APPROVE: options.autoApprove === false ? "0" : "1",
      MCP_MOCK_DIAGNOSTICS_KEY: DIAGNOSTICS_KEY,
      ...(options.disableDcr ? { DISABLE_DCR: "1" } : {}),
      ...options.extraEnv,
    },
    stdio: "ignore",
  });
  children.add(child);
  const baseUrl = `http://127.0.0.1:${port}`;
  const health = await waitForHealth(baseUrl);
  return { child, baseUrl, health };
}

async function stopMock(child: ChildProcess) {
  children.delete(child);
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit());
    setTimeout(resolveExit, 1_000);
  });
}

async function launchWithHost(host: string) {
  const port = await getFreePort();
  const child = spawn(process.execPath, [script, "--port", String(port), "--host", host], {
    env: { ...process.env, MCP_MOCK_UNSAFE_ALLOW_NON_LOOPBACK: "0" },
    stdio: "ignore",
  });
  children.add(child);
  return { child, port };
}

async function expectRejectedBindHost(host: string) {
  const { child } = await launchWithHost(host);
  const exitCode = await Promise.race([
    new Promise<number | null>((resolveExit) => child.once("exit", resolveExit)),
    Bun.sleep(2_000).then(() => "still-running"),
  ]);
  if (exitCode === "still-running") await stopMock(child);
  else children.delete(child);
  expect(exitCode).toBe(2);
}

afterEach(async () => {
  await Promise.all([...children].map(stopMock));
});

async function registerPublicClient(baseUrl: string, redirectUri = REDIRECT_URI): Promise<string> {
  const registration = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
  });
  expect(registration.status).toBe(201);
  const registered: unknown = await registration.json();
  if (!isRecord(registered) || typeof registered.client_id !== "string") throw new Error("mock registration omitted client_id");
  return registered.client_id;
}

function buildAuthorizeUrl(input: {
  baseUrl: string;
  endpoint: string;
  clientId: string;
  scopes: string[];
  overrides?: Record<string, string | null>;
}): URL {
  const authorizeUrl = new URL(`${input.baseUrl}/authorize`);
  const values: Record<string, string> = {
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: REDIRECT_URI,
    state: "mock-state",
    scope: input.scopes.join(" "),
    resource: `${input.baseUrl}${input.endpoint}`,
    code_challenge: PKCE_CHALLENGE,
    code_challenge_method: "S256",
  };
  for (const [key, value] of Object.entries({ ...values, ...input.overrides })) {
    if (value !== null) authorizeUrl.searchParams.set(key, value);
  }
  return authorizeUrl;
}

async function issueCode(input: {
  baseUrl: string;
  endpoint: string;
  clientId: string;
  scopes: string[];
}): Promise<string> {
  const response = await fetch(buildAuthorizeUrl(input), { redirect: "manual" });
  expect(response.status).toBe(302);
  const location = response.headers.get("location");
  if (!location) throw new Error("authorization response omitted location");
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error("authorization response omitted code");
  return code;
}

function exchangeCode(input: {
  baseUrl: string;
  endpoint: string;
  clientId: string;
  code: string;
  overrides?: Record<string, string>;
}): Promise<Response> {
  return fetch(`${input.baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      client_id: input.clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: PKCE_VERIFIER,
      resource: `${input.baseUrl}${input.endpoint}`,
      ...input.overrides,
    }),
  });
}

async function expectOAuthError(response: Response, expected: string): Promise<void> {
  expect(response.status).toBe(400);
  const body: unknown = await response.json();
  expect(isRecord(body) && body.error).toBe(expected);
}

async function authorize(
  baseUrl: string,
  endpoint: string,
  scopes: string[],
  preregistered?: { clientId: string; clientSecret: string },
): Promise<string> {
  let clientId = preregistered?.clientId;
  if (!clientId) clientId = await registerPublicClient(baseUrl);
  const resource = `${baseUrl}${endpoint}`;
  const authorizeUrl = buildAuthorizeUrl({ baseUrl, endpoint, clientId, scopes });

  const authorization = await fetch(authorizeUrl, { redirect: "manual" });
  expect(authorization.status).toBe(302);
  const location = authorization.headers.get("location");
  if (!location) throw new Error("mock authorization omitted callback location");
  const callback = new URL(location);
  expect(callback.searchParams.get("state")).toBe("mock-state");
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("mock authorization omitted code");

  const tokenInput: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_verifier: PKCE_VERIFIER,
    resource,
  };
  if (preregistered) tokenInput.client_secret = preregistered.clientSecret;
  const token = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(tokenInput),
  });
  expect(token.status).toBe(200);
  const tokenBody: unknown = await token.json();
  if (!isRecord(tokenBody) || typeof tokenBody.access_token !== "string") throw new Error("mock token response omitted access_token");
  return tokenBody.access_token;
}

function mcpHeaders(token: string, protocolVersion?: string, sessionId?: string) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  };
}

async function readMcpBody(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type") || "";
  let value: unknown;
  if (contentType.startsWith("text/event-stream")) {
    const text = await response.text();
    const data = text.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    if (!data) throw new Error("SSE response omitted a data frame");
    value = JSON.parse(data);
  } else {
    value = await response.json();
  }
  if (!isRecord(value)) throw new Error("MCP response was not an object");
  return value;
}

async function initialize(baseUrl: string, endpoint: string, token: string) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: mcpHeaders(token),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "initialize-1",
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "mock-test", version: "1" } },
    }),
  });
  expect(response.status).toBe(200);
  const body = await readMcpBody(response);
  const result = body.result;
  if (!isRecord(result) || typeof result.protocolVersion !== "string") throw new Error("initialize response omitted protocolVersion");
  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("initialize response omitted MCP-Session-Id");

  const initialized = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: mcpHeaders(token, result.protocolVersion, sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  expect(initialized.status).toBe(202);
  return { protocolVersion: result.protocolVersion, sessionId };
}

async function listEntireCatalogDefinitions(baseUrl: string, endpoint: string, token: string, protocolVersion: string, sessionId: string) {
  const definitions: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: mcpHeaders(token, protocolVersion, sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", id: `tools-${page}`, method: "tools/list", params: cursor ? { cursor } : {} }),
    });
    expect(response.status).toBe(200);
    const body = await readMcpBody(response);
    if (!isRecord(body.result) || !Array.isArray(body.result.tools)) throw new Error("tools/list response omitted tools");
    for (const entry of body.result.tools) {
      if (!isRecord(entry) || typeof entry.name !== "string") throw new Error("tool entry omitted name");
      definitions.push(entry);
    }
    if (typeof body.result.nextCursor !== "string") return definitions;
    if (seen.has(body.result.nextCursor)) throw new Error(`cursor loop: ${body.result.nextCursor}`);
    seen.add(body.result.nextCursor);
    cursor = body.result.nextCursor;
  }
  throw new Error("catalog exceeded page limit");
}

async function listEntireCatalog(baseUrl: string, endpoint: string, token: string, protocolVersion: string, sessionId: string) {
  const definitions = await listEntireCatalogDefinitions(baseUrl, endpoint, token, protocolVersion, sessionId);
  return definitions.map((entry) => String(entry.name));
}

describe("enterprise diagnostic OAuth MCP mock", () => {
  test("prefers the isolated hub extra port over the application PORT", async () => {
    const extraPort = await getFreePort();
    const applicationPort = await getFreePort();
    const env = {
      ...process.env,
      OPENWORK_EXTRA_APP_PORTS: String(extraPort),
      PORT: String(applicationPort),
      AUTO_APPROVE: "1",
    };
    delete env.MCP_DIAGNOSTIC_MOCK_PORT;
    const child = spawn(process.execPath, [script], { env, stdio: "ignore" });
    children.add(child);
    const health = await waitForHealth(`http://127.0.0.1:${extraPort}`);
    expect(health.issuer).toBe(`http://127.0.0.1:${extraPort}`);
    await stopMock(child);
  });

  test("refuses non-loopback binding and exposes no permissive CORS or open logs", async () => {
    const port = await getFreePort();
    const child = spawn(process.execPath, [script, "--port", String(port), "--host", "0.0.0.0"], {
      env: { ...process.env, MCP_MOCK_UNSAFE_ALLOW_NON_LOOPBACK: "0" },
      stdio: "ignore",
    });
    children.add(child);
    const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
    children.delete(child);
    expect(exitCode).toBe(2);

    const mock = await startMock();
    const health = await fetch(`${mock.baseUrl}/health`);
    expect(health.headers.get("access-control-allow-origin")).toBeNull();
    expect((await fetch(`${mock.baseUrl}/requests`)).status).toBe(404);
    expect((await fetch(`${mock.baseUrl}/requests`, { headers: diagnosticsHeaders })).status).toBe(200);
  });

  test("parses loopback bind addresses and rejects deceptive 127-prefixed hostnames", async () => {
    await expectRejectedBindHost("127.attacker.example");
    await expectRejectedBindHost("127.0.0.1.example.com");

    const ipv4 = await launchWithHost("127.0.0.1");
    const ipv4Health = await waitForHealth(`http://127.0.0.1:${ipv4.port}`);
    expect(ipv4Health.issuer).toBe(`http://127.0.0.1:${ipv4.port}`);
    await stopMock(ipv4.child);

    const localhost = await launchWithHost("localhost");
    const localhostHealth = await waitForHealth(`http://localhost:${localhost.port}`);
    expect(localhostHealth.issuer).toBe(`http://localhost:${localhost.port}`);
    await stopMock(localhost.child);

    const ipv6 = await launchWithHost("::1");
    const ipv6BaseUrl = `http://[::1]:${ipv6.port}`;
    const ipv6Health = await waitForHealth(ipv6BaseUrl);
    expect(ipv6Health.issuer).toBe(ipv6BaseUrl);
    const resourceMetadata = await (await fetch(`${ipv6BaseUrl}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(resourceMetadata).toMatchObject({
      resource: `${ipv6BaseUrl}/mcp`,
      authorization_servers: [ipv6BaseUrl],
    });
    const authorizationMetadata = await (await fetch(`${ipv6BaseUrl}/.well-known/oauth-authorization-server`)).json();
    expect(authorizationMetadata.issuer).toBe(ipv6BaseUrl);
    expect(authorizationMetadata.authorization_endpoint).toBe(`${ipv6BaseUrl}/authorize`);
    await stopMock(ipv6.child);
  });

  test("redacts token-like query values from the diagnostic request log", async () => {
    const mock = await startMock();
    await fetch(`${mock.baseUrl}/health?diagnostic_token=request-log-secret&state=state-secret&session_id=session-secret`);
    const requestLog = await (await fetch(`${mock.baseUrl}/requests`, { headers: diagnosticsHeaders })).text();
    expect(requestLog).not.toContain("request-log-secret");
    expect(requestLog).not.toContain("state-secret");
    expect(requestLog).not.toContain("session-secret");
    expect(requestLog).toContain("diagnostic_token");
    expect(requestLog).toContain("REDACTED");
  });

  test("binds ServiceNow manual registration to its configured client, exact redirect, S256, resource, and scope", async () => {
    const mock = await startMock({ profile: "servicenow" });
    const endpoint = "/sncapps/mcp-server/mcp/sn_mcp_server_default";
    const clientId = PREREGISTERED_CLIENT.clientId;
    const base = { baseUrl: mock.baseUrl, endpoint, clientId, scopes: ["mcp_server"] };

    const metadata = await (await fetch(`${mock.baseUrl}/.well-known/oauth-authorization-server`)).json();
    expect(metadata.registration_endpoint).toBeUndefined();
    expect((await fetch(`${mock.baseUrl}/register`, { method: "POST" })).status).toBe(404);

    await expectOAuthError(await fetch(buildAuthorizeUrl({ ...base, clientId: "unregistered-client" }), { redirect: "manual" }), "invalid_client");
    await expectOAuthError(await fetch(buildAuthorizeUrl({ ...base, overrides: { redirect_uri: "http://127.0.0.1:19876/other" } }), { redirect: "manual" }), "invalid_request");
    await expectOAuthError(await fetch(buildAuthorizeUrl({ ...base, overrides: { resource: null } }), { redirect: "manual" }), "invalid_target");
    await expectOAuthError(await fetch(buildAuthorizeUrl({ ...base, overrides: { resource: `${mock.baseUrl}/wrong` } }), { redirect: "manual" }), "invalid_target");
    await expectOAuthError(await fetch(buildAuthorizeUrl({ ...base, overrides: { scope: null } }), { redirect: "manual" }), "invalid_scope");
    await expectOAuthError(await fetch(buildAuthorizeUrl({ ...base, overrides: { scope: "MCP.User.Read.All" } }), { redirect: "manual" }), "invalid_scope");
    await expectOAuthError(await fetch(buildAuthorizeUrl({ ...base, overrides: { code_challenge_method: "plain" } }), { redirect: "manual" }), "invalid_request");
    await expectOAuthError(await fetch(buildAuthorizeUrl({ ...base, overrides: { code_challenge: null } }), { redirect: "manual" }), "invalid_request");

    const invalidRegistration = await fetch(`${mock.baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [], token_endpoint_auth_method: "none" }),
    });
    expect(invalidRegistration.status).toBe(404);
  });

  test("accepts HTTPS and exact loopback HTTP callbacks while rejecting deceptive redirect URIs", async () => {
    const mock = await startMock({ profile: "generic" });
    for (const redirectUri of [
      "https://client.example/callback",
      "http://127.0.0.1:19876/callback",
      "http://localhost:19876/callback",
    ]) {
      const response = await fetch(`${mock.baseUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
      });
      expect(response.status).toBe(201);
    }

    for (const redirectUri of [
      "http://client.example/callback",
      "http://127.attacker.example/callback",
      "http://127.0.0.1.example.com/callback",
      "https://user:password@client.example/callback",
      "https://client.example/callback#fragment",
    ]) {
      const response = await fetch(`${mock.baseUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
      });
      await expectOAuthError(response, "invalid_client_metadata");
    }

    const invalidPort = await getFreePort();
    const invalidManual = spawn(process.execPath, [script, "--port", String(invalidPort), "--profile", "servicenow"], {
      env: { ...process.env, MOCK_REDIRECT_URIS: "http://127.0.0.1.example.com/callback" },
      stdio: "ignore",
    });
    children.add(invalidManual);
    const exitCode = await new Promise<number | null>((resolveExit) => invalidManual.once("exit", resolveExit));
    children.delete(invalidManual);
    expect(exitCode).toBe(2);
  });

  test("uses a one-time server-side approval transaction and one-time client-bound code", async () => {
    const mock = await startMock({ profile: "generic", autoApprove: false });
    const endpoint = "/mcp";
    const clientId = await registerPublicClient(mock.baseUrl);
    const authorization = await fetch(buildAuthorizeUrl({
      baseUrl: mock.baseUrl,
      endpoint,
      clientId,
      scopes: ["mcp:read", "mcp:write"],
    }));
    expect(authorization.status).toBe(200);
    const approvalHtml = await authorization.text();
    expect(approvalHtml).not.toContain("mock-state");
    expect(approvalHtml).not.toContain(REDIRECT_URI);
    const approvalTransaction = approvalHtml.match(/name="approval_transaction" value="([^"]+)"/)?.[1];
    if (!approvalTransaction) throw new Error("approval page omitted transaction");

    const approved = await fetch(`${mock.baseUrl}/approve?state=tampered&redirect_uri=https://attacker.invalid/callback`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ approval_transaction: approvalTransaction }),
    });
    expect(approved.status).toBe(302);
    const approvedLocation = approved.headers.get("location");
    if (!approvedLocation) throw new Error("approval omitted redirect");
    const callback = new URL(approvedLocation);
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("state")).toBe("mock-state");
    const code = callback.searchParams.get("code");
    if (!code) throw new Error("approval omitted code");

    await expectOAuthError(await fetch(`${mock.baseUrl}/approve`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ approval_transaction: approvalTransaction }),
    }), "invalid_request");

    const wrongClient = await exchangeCode({
      baseUrl: mock.baseUrl,
      endpoint,
      clientId,
      code,
      overrides: { client_id: "unregistered-client" },
    });
    await expectOAuthError(wrongClient, "invalid_client");
    await expectOAuthError(await exchangeCode({ baseUrl: mock.baseUrl, endpoint, clientId, code }), "invalid_grant");
  });

  test("requires token and refresh client/resource binding and rotates refresh tokens", async () => {
    const mock = await startMock({ profile: "generic" });
    const endpoint = "/mcp";
    const clientId = await registerPublicClient(mock.baseUrl);
    const scopes = ["mcp:read", "mcp:write"];

    const missingResourceCode = await issueCode({ baseUrl: mock.baseUrl, endpoint, clientId, scopes });
    await expectOAuthError(await exchangeCode({
      baseUrl: mock.baseUrl,
      endpoint,
      clientId,
      code: missingResourceCode,
      overrides: { resource: "" },
    }), "invalid_target");

    const badPkceCode = await issueCode({ baseUrl: mock.baseUrl, endpoint, clientId, scopes });
    await expectOAuthError(await exchangeCode({
      baseUrl: mock.baseUrl,
      endpoint,
      clientId,
      code: badPkceCode,
      overrides: { code_verifier: `${PKCE_VERIFIER}-wrong` },
    }), "invalid_grant");

    const badRedirectCode = await issueCode({ baseUrl: mock.baseUrl, endpoint, clientId, scopes });
    await expectOAuthError(await exchangeCode({
      baseUrl: mock.baseUrl,
      endpoint,
      clientId,
      code: badRedirectCode,
      overrides: { redirect_uri: "http://127.0.0.1:19876/other" },
    }), "invalid_grant");

    const badScopeCode = await issueCode({ baseUrl: mock.baseUrl, endpoint, clientId, scopes });
    await expectOAuthError(await exchangeCode({
      baseUrl: mock.baseUrl,
      endpoint,
      clientId,
      code: badScopeCode,
      overrides: { scope: "MCP.User.Read.All" },
    }), "invalid_scope");

    const code = await issueCode({ baseUrl: mock.baseUrl, endpoint, clientId, scopes });
    const tokenResponse = await exchangeCode({ baseUrl: mock.baseUrl, endpoint, clientId, code });
    expect(tokenResponse.status).toBe(200);
    const token: unknown = await tokenResponse.json();
    if (!isRecord(token) || typeof token.refresh_token !== "string") throw new Error("token response omitted refresh token");
    await expectOAuthError(await exchangeCode({ baseUrl: mock.baseUrl, endpoint, clientId, code }), "invalid_grant");

    const refreshInput = {
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
      client_id: clientId,
      resource: `${mock.baseUrl}${endpoint}`,
    };
    await expectOAuthError(await fetch(`${mock.baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...refreshInput, client_id: "unregistered-client" }),
    }), "invalid_client");
    await expectOAuthError(await fetch(`${mock.baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...refreshInput, resource: `${mock.baseUrl}/wrong` }),
    }), "invalid_target");
    await expectOAuthError(await fetch(`${mock.baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...refreshInput, scope: "MCP.User.Read.All" }),
    }), "invalid_scope");
    const refreshed = await fetch(`${mock.baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(refreshInput),
    });
    expect(refreshed.status).toBe(200);
    await expectOAuthError(await fetch(`${mock.baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(refreshInput),
    }), "invalid_grant");
  });

  test("caps request and client state and expires every non-permanent state class", async () => {
    const capped = await startMock({ profile: "generic", extraEnv: { MCP_MOCK_TEST_STATE_CAP: "5" } });
    const endpoint = "/mcp";
    const scopes = ["mcp:read", "mcp:write"];
    const clientIds: string[] = [];
    for (let index = 0; index < 10; index += 1) clientIds.push(await registerPublicClient(capped.baseUrl));
    const activeClientId = clientIds.at(-1)!;
    let lastAccessToken = "";
    for (let index = 0; index < 8; index += 1) {
      const code = await issueCode({ baseUrl: capped.baseUrl, endpoint, clientId: activeClientId, scopes });
      const tokenResponse = await exchangeCode({ baseUrl: capped.baseUrl, endpoint, clientId: activeClientId, code });
      const token: unknown = await tokenResponse.json();
      if (!isRecord(token) || typeof token.access_token !== "string") throw new Error("capped token missing access token");
      lastAccessToken = token.access_token;
    }
    let lastSession: { protocolVersion: string; sessionId: string } | null = null;
    for (let index = 0; index < 8; index += 1) lastSession = await initialize(capped.baseUrl, endpoint, lastAccessToken);
    if (!lastSession) throw new Error("capped session missing");
    for (let index = 0; index < 8; index += 1) {
      await fetch(`${capped.baseUrl}/gmail/v1/users/me/drafts`, {
        method: "POST",
        headers: { authorization: `Bearer ${lastAccessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ message: { raw: `capped-${index}` } }),
      });
    }
    for (let index = 0; index < 8; index += 1) {
      await issueCode({ baseUrl: capped.baseUrl, endpoint, clientId: activeClientId, scopes });
      const manual = await fetch(buildAuthorizeUrl({
        baseUrl: capped.baseUrl,
        endpoint,
        clientId: activeClientId,
        scopes,
        overrides: { force_consent: "1", state: `manual-${index}` },
      }));
      expect(manual.status).toBe(200);
    }
    await Promise.all(Array.from({ length: 10 }, (_, index) => fetch(`${capped.baseUrl}/health?probe=${index}`)));
    const cappedState = await (await fetch(`${capped.baseUrl}/__diagnostics/state`, { headers: diagnosticsHeaders })).json();
    expect(cappedState.counts).toMatchObject({
      clients: 5,
      approvalTransactions: 5,
      codes: 5,
      accessTokens: 5,
      refreshTokens: 5,
      sessions: 5,
      requests: 5,
      drafts: 5,
      ledger: 0,
    });
    await expectOAuthError(await fetch(buildAuthorizeUrl({
      baseUrl: capped.baseUrl,
      endpoint,
      clientId: clientIds[0],
      scopes,
    }), { redirect: "manual" }), "invalid_client");
    expect((await fetch(buildAuthorizeUrl({
      baseUrl: capped.baseUrl,
      endpoint,
      clientId: clientIds.at(-1)!,
      scopes,
    }), { redirect: "manual" })).status).toBe(302);
    await stopMock(capped.child);

    const expiring = await startMock({
      profile: "generic",
      extraEnv: { MCP_MOCK_TEST_STATE_TTL_MS: "200" },
    });
    const clientId = await registerPublicClient(expiring.baseUrl);
    await issueCode({ baseUrl: expiring.baseUrl, endpoint, clientId, scopes });
    const approval = await fetch(buildAuthorizeUrl({
      baseUrl: expiring.baseUrl,
      endpoint,
      clientId,
      scopes,
      overrides: { force_consent: "1" },
    }));
    expect(approval.status).toBe(200);
    const tokenCode = await issueCode({ baseUrl: expiring.baseUrl, endpoint, clientId, scopes });
    const tokenResponse = await exchangeCode({ baseUrl: expiring.baseUrl, endpoint, clientId, code: tokenCode });
    const tokenBody: unknown = await tokenResponse.json();
    if (!isRecord(tokenBody) || typeof tokenBody.access_token !== "string") throw new Error("expiring token missing access token");
    const initialized = await initialize(expiring.baseUrl, endpoint, tokenBody.access_token);
    const draft = await fetch(`${expiring.baseUrl}/gmail/v1/users/me/drafts`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenBody.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ message: { raw: "sensitive-expiring-draft" } }),
    });
    expect(draft.status).toBe(200);
    await Bun.sleep(250);
    const expiredState = await (await fetch(`${expiring.baseUrl}/__diagnostics/state`, { headers: diagnosticsHeaders })).json();
    expect(expiredState.counts).toMatchObject({
      clients: 1,
      approvalTransactions: 0,
      codes: 0,
      accessTokens: 1,
      refreshTokens: 0,
      sessions: 0,
      drafts: 0,
      ledger: 0,
    });
  });

  test("caps and expires synthetic mutation ledger entries without changing provider data", async () => {
    const exerciseMutations = async (baseUrl: string, count: number) => {
      const endpoint = "/mcp";
      const token = "mock-access-token";
      const initialized = await initialize(baseUrl, endpoint, token);
      for (let index = 0; index < count; index += 1) {
        const response = await fetch(`${baseUrl}${endpoint}`, {
          method: "POST",
          headers: mcpHeaders(token, initialized.protocolVersion, initialized.sessionId),
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: `mutation-${index}`,
            method: "tools/call",
            params: {
              name: "create_entity",
              arguments: { parentUrl: "/me/messages", jsonBody: "{}" },
              _meta: { openworkMockApproval: true, idempotencyKey: `ledger-${index}` },
            },
          }),
        });
        expect(response.status).toBe(200);
      }
    };

    const capped = await startMock({ profile: "workiq", extraEnv: { MCP_MOCK_TEST_STATE_CAP: "5" } });
    await exerciseMutations(capped.baseUrl, 8);
    const cappedState = await (await fetch(`${capped.baseUrl}/__diagnostics/state`, { headers: diagnosticsHeaders })).json();
    expect(cappedState.counts.ledger).toBe(5);
    await stopMock(capped.child);

    const expiring = await startMock({ profile: "workiq", extraEnv: { MCP_MOCK_TEST_STATE_TTL_MS: "200" } });
    await exerciseMutations(expiring.baseUrl, 1);
    await Bun.sleep(250);
    const expiredState = await (await fetch(`${expiring.baseUrl}/__diagnostics/state`, { headers: diagnosticsHeaders })).json();
    expect(expiredState.counts.ledger).toBe(0);
  });

  test("destroys oversized request bodies instead of continuing to buffer", async () => {
    const mock = await startMock();
    await expect(fetch(`${mock.baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"padding":"${"x".repeat(300 * 1024)}"}`,
    })).rejects.toThrow();
    expect((await fetch(`${mock.baseUrl}/health`)).status).toBe(200);
  });

  test("returns a generic correlated 500 without internal exception text", async () => {
    const mock = await startMock({ fault: "internal_error" });
    const response = await fetch(`${mock.baseUrl}/__fault/internal`);
    expect(response.status).toBe(500);
    const bodyText = await response.text();
    expect(bodyText).toContain("internal_mock_error");
    expect(bodyText).toContain("correlationId");
    expect(bodyText).not.toContain("sensitive internal mock detail");
  });

  const cases = [
    { profile: "servicenow", endpoint: "/sncapps/mcp-server/mcp/sn_mcp_server_default", scopes: ["mcp_server"], expectedProtocol: "2025-06-18", expectedTools: 4, preregistered: PREREGISTERED_CLIENT },
    { profile: "workiq", endpoint: "/mcp", scopes: ["api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask"], expectedProtocol: "2025-11-25", expectedTools: 10, preregistered: PREREGISTERED_CLIENT },
    { profile: "microsoft-enterprise", endpoint: "/enterprise", scopes: ["MCP.User.Read.All"], expectedProtocol: "2025-11-25", expectedTools: 3, preregistered: PREREGISTERED_CLIENT },
    { profile: "agent365-mail", endpoint: "/agents/tenants/mock-tenant/servers/mcp_MailTools", scopes: ["McpServers.Mail.All"], expectedProtocol: "2025-11-25", expectedTools: 10, preregistered: PREREGISTERED_CLIENT },
  ];

  for (const scenario of cases) {
    test(`${scenario.profile} completes OAuth, initialization, pagination, and shutdown`, async () => {
      const mock = await startMock({ profile: scenario.profile });
      expect(mock.health.profile).toBe(scenario.profile);
      expect(mock.health.endpoint).toBe(scenario.endpoint);

      const challenge = await fetch(`${mock.baseUrl}${scenario.endpoint}`, {
        method: "POST",
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      expect(challenge.status).toBe(401);
      expect(challenge.headers.get("www-authenticate")).toContain("resource_metadata=");

      const token = await authorize(mock.baseUrl, scenario.endpoint, scenario.scopes, scenario.preregistered);
      const initialized = await initialize(mock.baseUrl, scenario.endpoint, token);
      expect(initialized.protocolVersion).toBe(scenario.expectedProtocol);
      const names = await listEntireCatalog(mock.baseUrl, scenario.endpoint, token, initialized.protocolVersion, initialized.sessionId);
      expect(names).toHaveLength(scenario.expectedTools);
      expect(new Set(names).size).toBe(names.length);
      const requestLog = await (await fetch(`${mock.baseUrl}/requests`, { headers: diagnosticsHeaders })).text();
      expect(requestLog).not.toContain(token);
      expect(requestLog).not.toContain(initialized.sessionId);
      expect(requestLog).not.toContain("mock-state");

      const deleted = await fetch(`${mock.baseUrl}${scenario.endpoint}`, {
        method: "DELETE",
        headers: mcpHeaders(token, initialized.protocolVersion, initialized.sessionId),
      });
      expect(deleted.status).toBe(200);
      await stopMock(mock.child);
    });
  }

  test("pins ServiceNow, Work IQ, and Agent 365 enterprise topology and catalog fixtures to official references", async () => {
    const serviceNow = await startMock({ profile: "servicenow" });
    expect(serviceNow.health.fixtureContract).toMatchObject({
      verifiedAt: "2026-07-10",
      registrationMode: "manual",
      identityProvider: "servicenow-instance-oauth",
      resource: `${serviceNow.baseUrl}/sncapps/mcp-server/mcp/sn_mcp_server_default`,
      scopes: ["mcp_server"],
    });
    expect((serviceNow.health.fixtureContract as { documentation: string[] }).documentation).toContain(
      "https://www.servicenow.com/docs/r/intelligent-experiences/connect-mcp-server-client.html",
    );
    const serviceNowInitialized = await initialize(
      serviceNow.baseUrl,
      "/sncapps/mcp-server/mcp/sn_mcp_server_default",
      "mock-access-token",
    );
    const serviceNowNames = await listEntireCatalog(
      serviceNow.baseUrl,
      "/sncapps/mcp-server/mcp/sn_mcp_server_default",
      "mock-access-token",
      serviceNowInitialized.protocolVersion,
      serviceNowInitialized.sessionId,
    );
    expect(serviceNowNames).toEqual([
      "case_summarization",
      "incident_summarization",
      "look_up_case_records",
      "look_up_incident_records",
    ]);
    await stopMock(serviceNow.child);

    const workIq = await startMock({ profile: "workiq" });
    expect(workIq.health.fixtureContract).toMatchObject({
      verifiedAt: "2026-07-10",
      registrationMode: "pre_registered",
      identityProvider: "microsoft-entra-tenant",
      tenantId: "mock-tenant",
      authorizationIssuer: `${workIq.baseUrl}/mock-entra/mock-tenant/v2.0`,
      audience: "api://workiq.svc.cloud.microsoft",
      scopes: ["api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask"],
    });
    const workIqMetadata = await (await fetch(`${workIq.baseUrl}/.well-known/oauth-authorization-server`)).json();
    expect(workIqMetadata.issuer).toBe(`${workIq.baseUrl}/mock-entra/mock-tenant/v2.0`);
    expect(workIqMetadata.registration_endpoint).toBeUndefined();
    expect((await fetch(`${workIq.baseUrl}/.well-known/oauth-authorization-server/mock-entra/mock-tenant/v2.0`)).status).toBe(200);
    const workIqInitialized = await initialize(workIq.baseUrl, "/mcp", "mock-access-token");
    const workIqDefinitions = await listEntireCatalogDefinitions(
      workIq.baseUrl,
      "/mcp",
      "mock-access-token",
      workIqInitialized.protocolVersion,
      workIqInitialized.sessionId,
    );
    expect(workIqDefinitions.map((entry) => entry.name)).toEqual([
      "fetch",
      "create_entity",
      "update_entity",
      "delete_entity",
      "do_action",
      "call_function",
      "ask",
      "list_agents",
      "get_schema",
      "search_paths",
    ]);
    const fetchTool = workIqDefinitions.find((entry) => entry.name === "fetch") as any;
    const searchPathsTool = workIqDefinitions.find((entry) => entry.name === "search_paths") as any;
    const actionTool = workIqDefinitions.find((entry) => entry.name === "do_action") as any;
    expect(fetchTool.inputSchema.required).toEqual(["entityUrls"]);
    expect(fetchTool.inputSchema.properties.entityUrls).toMatchObject({ type: "array", items: { type: "string" } });
    expect(searchPathsTool.inputSchema.required).toEqual(["filter"]);
    expect(actionTool.inputSchema.required).toEqual(["actionUrl"]);
    expect(actionTool.inputSchema.properties.jsonBody.type).toBe("string");

    for (const token of [
      "mock-wrong-tenant-token",
      "mock-wrong-issuer-token",
      "mock-wrong-audience-token",
      "mock-wrong-scope-token",
    ]) {
      const rejected = await fetch(`${workIq.baseUrl}/mcp`, {
        method: "POST",
        headers: mcpHeaders(token),
        body: JSON.stringify({ jsonrpc: "2.0", id: "negative-token", method: "initialize", params: {} }),
      });
      expect(rejected.status).toBe(401);
      expect(await rejected.json()).toEqual({ error: "missing_mcp_token" });
    }
    await stopMock(workIq.child);

    const agent365 = await startMock({ profile: "agent365-mail" });
    expect(agent365.health).toMatchObject({
      endpoint: "/agents/tenants/mock-tenant/servers/mcp_MailTools",
      fixtureContract: {
        verifiedAt: "2026-07-10",
        registrationMode: "pre_registered",
        tenantId: "mock-tenant",
        audience: "api://05879165-0320-489e-b644-f72b33f3edf0",
        scopes: ["McpServers.Mail.All"],
      },
    });
    const agentInitialized = await initialize(
      agent365.baseUrl,
      "/agents/tenants/mock-tenant/servers/mcp_MailTools",
      "mock-access-token",
    );
    const agentDefinitions = await listEntireCatalogDefinitions(
      agent365.baseUrl,
      "/agents/tenants/mock-tenant/servers/mcp_MailTools",
      "mock-access-token",
      agentInitialized.protocolVersion,
      agentInitialized.sessionId,
    );
    expect(agentDefinitions.map((entry) => entry.name)).toEqual([
      "mcp_MailTools_graph_mail_createMessage",
      "mcp_MailTools_graph_mail_deleteMessage",
      "mcp_MailTools_graph_mail_getMessage",
      "mcp_MailTools_graph_mail_listSent",
      "mcp_MailTools_graph_mail_reply",
      "mcp_MailTools_graph_mail_replyAll",
      "mcp_MailTools_graph_mail_searchMessages",
      "mcp_MailTools_graph_mail_sendDraft",
      "mcp_MailTools_graph_mail_sendMail",
      "mcp_MailTools_graph_mail_updateMessage",
    ]);
    const createMessage = agentDefinitions[0] as any;
    expect(createMessage.inputSchema.required).toEqual(["subject", "toRecipients", "body"]);
    await stopMock(agent365.child);
  });

  test("generic defaults remain compatible and SSE responses are valid", async () => {
    const mock = await startMock({ responseMode: "sse" });
    const token = await authorize(mock.baseUrl, "/mcp", ["mcp:read", "mcp:write"]);
    const initialized = await initialize(mock.baseUrl, "/mcp", token);
    expect(initialized.protocolVersion).toBe("2025-06-18");
    const names = await listEntireCatalog(mock.baseUrl, "/mcp", token, initialized.protocolVersion, initialized.sessionId);
    expect(names).toEqual(["mock_echo"]);

    const draft = await fetch(`${mock.baseUrl}/gmail/v1/users/me/drafts`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ message: { raw: "c3ludGhldGljIGRyYWZ0" } }),
    });
    expect(draft.status).toBe(200);
    const draftLog = await (await fetch(`${mock.baseUrl}/gmail/drafts-log`, { headers: diagnosticsHeaders })).json();
    expect(draftLog.drafts?.[0]).toMatchObject({
      rawBytes: Buffer.byteLength("c3ludGhldGljIGRyYWZ0"),
      rawSha256: createHash("sha256").update("c3ludGhldGljIGRyYWZ0").digest("hex"),
    });
    expect(JSON.stringify(draftLog)).not.toContain("c3ludGhldGljIGRyYWZ0");
    expect(draftLog.drafts?.[0]?.raw).toBeUndefined();
  });

  test("generic preregistered-client mode remains compatible without DCR", async () => {
    const mock = await startMock({ disableDcr: true });
    const metadata = await (await fetch(`${mock.baseUrl}/.well-known/oauth-authorization-server`)).json();
    expect(metadata.registration_endpoint).toBeUndefined();
    expect((await fetch(`${mock.baseUrl}/register`, { method: "POST" })).status).toBe(404);
    const token = await authorize(mock.baseUrl, "/mcp", ["mcp:read", "mcp:write"], {
      clientId: "mock-preregistered-client",
      clientSecret: "mock-preregistered-secret",
    });
    const initialized = await initialize(mock.baseUrl, "/mcp", token);
    expect(initialized.protocolVersion).toBe("2025-06-18");
  });

  test("advertised OAuth faults have deterministic safe outcomes and no active lifecycle residue", async () => {
    const advertised = await startMock();
    expect(advertised.health.advertisedFaults).toEqual([
      "expired_session",
      "cursor_loop",
      "provider_denied",
      "provider_throttled",
      "missing_auth_challenge",
      "bad_resource_metadata",
      "issuer_mismatch",
      "no_pkce",
      "dcr_unsupported",
      "invalid_client",
      "invalid_grant",
      "wrong_audience",
      "unsupported_version",
      "malformed_initialize",
      "notification_rejected",
      "wrong_content_type",
      "broken_sse",
      "empty_tool_catalog",
    ]);
    await stopMock(advertised.child);

    const missingChallenge = await startMock({ fault: "missing_auth_challenge" });
    const challenge = await fetch(`${missingChallenge.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toBeNull();
    expect(await challenge.json()).toEqual({ error: "missing_mcp_token" });
    expect((await (await fetch(`${missingChallenge.baseUrl}/__diagnostics/state`, { headers: diagnosticsHeaders })).json()).counts.activeRequests).toBe(0);
    await stopMock(missingChallenge.child);

    const badMetadata = await startMock({ fault: "bad_resource_metadata" });
    const badResource = await (await fetch(`${badMetadata.baseUrl}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(badResource).toEqual({ resource: `${badMetadata.baseUrl}/wrong-resource`, authorization_servers: [] });
    await stopMock(badMetadata.child);

    const issuerMismatch = await startMock({ fault: "issuer_mismatch" });
    const mismatchedIssuer = await (await fetch(`${issuerMismatch.baseUrl}/.well-known/oauth-authorization-server`)).json();
    expect(mismatchedIssuer.issuer).toBe(`${issuerMismatch.baseUrl}/wrong-issuer`);
    await stopMock(issuerMismatch.child);

    const noPkce = await startMock({ fault: "no_pkce" });
    const noPkceMetadata = await (await fetch(`${noPkce.baseUrl}/.well-known/oauth-authorization-server`)).json();
    expect(noPkceMetadata.code_challenge_methods_supported).toEqual(["plain"]);
    await stopMock(noPkce.child);

    const noDcr = await startMock({ fault: "dcr_unsupported" });
    const noDcrMetadata = await (await fetch(`${noDcr.baseUrl}/.well-known/oauth-authorization-server`)).json();
    expect(noDcrMetadata.registration_endpoint).toBeUndefined();
    expect((await fetch(`${noDcr.baseUrl}/register`, { method: "POST" })).status).toBe(404);
    await stopMock(noDcr.child);

    const invalidClient = await startMock({ fault: "invalid_client" });
    const clientResponse = await fetch(`${invalidClient.baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
    });
    await expectOAuthError(clientResponse, "invalid_client");
    await stopMock(invalidClient.child);

    const invalidGrant = await startMock({ fault: "invalid_grant" });
    const invalidGrantClient = await registerPublicClient(invalidGrant.baseUrl);
    const invalidGrantCode = await issueCode({
      baseUrl: invalidGrant.baseUrl,
      endpoint: "/mcp",
      clientId: invalidGrantClient,
      scopes: ["mcp:read", "mcp:write"],
    });
    await expectOAuthError(await exchangeCode({
      baseUrl: invalidGrant.baseUrl,
      endpoint: "/mcp",
      clientId: invalidGrantClient,
      code: invalidGrantCode,
    }), "invalid_grant");
    await stopMock(invalidGrant.child);

    const wrongAudience = await startMock({ fault: "wrong_audience" });
    const rejectedToken = await authorize(wrongAudience.baseUrl, "/mcp", ["mcp:read", "mcp:write"]);
    const audienceResponse = await fetch(`${wrongAudience.baseUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders(rejectedToken),
      body: JSON.stringify({ jsonrpc: "2.0", id: "wrong-audience", method: "initialize", params: {} }),
    });
    expect(audienceResponse.status).toBe(401);
    const safeAudienceBody = await audienceResponse.text();
    expect(safeAudienceBody).toBe('{"error":"missing_mcp_token"}');
    expect(safeAudienceBody).not.toContain(rejectedToken);
    const wrongAudienceLog = await (await fetch(`${wrongAudience.baseUrl}/requests`, { headers: diagnosticsHeaders })).text();
    expect(wrongAudienceLog).not.toContain(rejectedToken);
    expect((await (await fetch(`${wrongAudience.baseUrl}/__diagnostics/state`, { headers: diagnosticsHeaders })).json()).counts.activeRequests).toBe(0);
    await stopMock(wrongAudience.child);
  });

  test("provider denial and throttling remain structured tool results in JSON and SSE modes", async () => {
    for (const [fault, expected] of [
      ["provider_denied", { category: "provider_policy", providerStatus: 403, providerCode: "insufficient_privilege" }],
      ["provider_throttled", { category: "provider_api", providerStatus: 429, providerCode: "rate_limited", retryAfterSeconds: 2 }],
    ] as const) {
      for (const responseMode of ["json", "sse"] as const) {
        const mock = await startMock({ profile: "microsoft-enterprise", fault, responseMode });
        const initialized = await initialize(mock.baseUrl, "/enterprise", "mock-access-token");
        const response = await fetch(`${mock.baseUrl}/enterprise`, {
          method: "POST",
          headers: mcpHeaders("mock-access-token", initialized.protocolVersion, initialized.sessionId),
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: `${fault}-${responseMode}`,
            method: "tools/call",
            params: { name: "microsoft_graph_get", arguments: { path: "/users/mock" } },
          }),
        });
        expect(response.status).toBe(200);
        const body = await readMcpBody(response);
        if (!isRecord(body.result) || !isRecord(body.result.structuredContent)) throw new Error("provider fault omitted structured result");
        expect(body.result.isError).toBe(true);
        expect(body.result.structuredContent).toMatchObject(expected);
        expect(JSON.stringify(body)).not.toContain("mock-access-token");
        expect((await (await fetch(`${mock.baseUrl}/__diagnostics/state`, { headers: diagnosticsHeaders })).json()).counts.activeRequests).toBe(0);
        await stopMock(mock.child);
      }
    }
  });

  test("expired_session and cursor_loop are deterministic named faults", async () => {
    const expired = await startMock({ profile: "servicenow", fault: "expired_session" });
    const expiredToken = await authorize(expired.baseUrl, "/sncapps/mcp-server/mcp/sn_mcp_server_default", ["mcp_server"], PREREGISTERED_CLIENT);
    const initialized = await initialize(expired.baseUrl, "/sncapps/mcp-server/mcp/sn_mcp_server_default", expiredToken);
    const expiredResponse = await fetch(`${expired.baseUrl}/sncapps/mcp-server/mcp/sn_mcp_server_default`, {
      method: "POST",
      headers: mcpHeaders(expiredToken, initialized.protocolVersion, initialized.sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(expiredResponse.status).toBe(404);
    await stopMock(expired.child);

    const looping = await startMock({ profile: "workiq", fault: "cursor_loop" });
    const loopToken = await authorize(looping.baseUrl, "/mcp", ["api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask"], PREREGISTERED_CLIENT);
    const loopInitialized = await initialize(looping.baseUrl, "/mcp", loopToken);
    await expect(listEntireCatalog(looping.baseUrl, "/mcp", loopToken, loopInitialized.protocolVersion, loopInitialized.sessionId)).rejects.toThrow("cursor loop");
  });

  test("binds session deletion to its bearer token and makes teardown one-time", async () => {
    const mock = await startMock({ profile: "servicenow" });
    const endpoint = "/sncapps/mcp-server/mcp/sn_mcp_server_default";
    const ownerToken = await authorize(mock.baseUrl, endpoint, ["mcp_server"], PREREGISTERED_CLIENT);
    const otherToken = await authorize(mock.baseUrl, endpoint, ["mcp_server"], PREREGISTERED_CLIENT);
    const initialized = await initialize(mock.baseUrl, endpoint, ownerToken);

    const wrongOwner = await fetch(`${mock.baseUrl}${endpoint}`, {
      method: "DELETE",
      headers: mcpHeaders(otherToken, initialized.protocolVersion, initialized.sessionId),
    });
    expect(wrongOwner.status).toBe(404);
    const removed = await fetch(`${mock.baseUrl}${endpoint}`, {
      method: "DELETE",
      headers: mcpHeaders(ownerToken, initialized.protocolVersion, initialized.sessionId),
    });
    expect(removed.status).toBe(200);
    const repeated = await fetch(`${mock.baseUrl}${endpoint}`, {
      method: "DELETE",
      headers: mcpHeaders(ownerToken, initialized.protocolVersion, initialized.sessionId),
    });
    expect(repeated.status).toBe(404);
  });

  test("provider_denied stays a tool result instead of becoming a transport error", async () => {
    const mock = await startMock({ profile: "microsoft-enterprise", fault: "provider_denied" });
    const token = await authorize(mock.baseUrl, "/enterprise", ["MCP.User.Read.All"], PREREGISTERED_CLIENT);
    const initialized = await initialize(mock.baseUrl, "/enterprise", token);
    const response = await fetch(`${mock.baseUrl}/enterprise`, {
      method: "POST",
      headers: mcpHeaders(token, initialized.protocolVersion, initialized.sessionId),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "call-1",
        method: "tools/call",
        params: { name: "microsoft_graph_get", arguments: { path: "/users/mock" } },
      }),
    });
    expect(response.status).toBe(200);
    const body = await readMcpBody(response);
    if (!isRecord(body.result) || !isRecord(body.result.structuredContent)) throw new Error("provider denial omitted structured tool result");
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.category).toBe("provider_policy");
    expect(body.result.structuredContent.providerStatus).toBe(403);
  });
});
