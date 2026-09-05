import { createHash, randomBytes } from "node:crypto";
import { expect } from "vitest";
import { requestDenLoopback, server, test } from "@openwork/testkit";

function stringField(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null || !(key in value)) throw new Error(`Missing ${key}`);
  const field = Reflect.get(value, key);
  if (typeof field !== "string" || !field) throw new Error(`Invalid ${key}`);
  return field;
}

test("MCP requests keep valid credentials after the public auth rate limit is exhausted", { timeout: 300_000 }, async ({ evidence, place }) => {
  await using den = await server({
    place,
    web: false,
    org: { name: "MCP Auth Regression", members: {} },
    env: { OPENWORK_DEV_MODE: "0", DEN_TRUSTED_PROXIES: "192.0.2.10" },
  });
  const origin = den.ref.webUrl;
  const forwarded = { "x-forwarded-for": "198.51.100.10, 192.0.2.10" };
  const request = (path: string, init: RequestInit = {}) => {
    const options = { ...init, headers: { origin, ...forwarded, ...init.headers } };
    if (den.placement?.kind === "daytona") return requestDenLoopback(den.placement.sandboxId, path, options);
    return fetch(`${den.ref.apiUrl}${path}`, { ...options, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  };
  const login = await request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: den.admin.email, password: den.admin.password }),
  });
  expect(login.status).toBe(200);
  let cookie = login.headers.getSetCookie().map((entry) => entry.split(";")[0]).join("; ");
  expect(cookie.length).toBeGreaterThan(0);
  const organizations = await request("/api/auth/organization/list", { headers: { cookie } });
  expect(organizations.status).toBe(200);
  const availableOrganizations: unknown = await organizations.json();
  if (!Array.isArray(availableOrganizations)) throw new Error("Missing organization list");
  const organization = availableOrganizations.find((entry) => stringField(entry, "name") === "MCP Auth Regression");
  const selected = await request("/api/auth/organization/set-active", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ organizationId: stringField(organization, "id") }),
  });
  expect(selected.status).toBe(200);
  const cookies = new Map<string, string>();
  for (const entry of [...login.headers.getSetCookie(), ...selected.headers.getSetCookie()]) {
    const pair = entry.split(";")[0];
    cookies.set(pair.slice(0, pair.indexOf("=")), pair);
  }
  cookie = [...cookies.values()].join("; ");
  const redirectUri = "http://127.0.0.1:19876/callback";
  const scope = "mcp:read mcp:write offline_access";
  const registration = await request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Rate limit regression", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope }),
  });
  expect(registration.status).toBe(201);
  const clientId = stringField(await registration.json(), "client_id");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = await request("/mcp/agent");
  expect(challenge.status).toBe(401);
  const metadataUrl = challenge.headers.get("www-authenticate")?.match(/resource_metadata="([^"]+)"/)?.[1];
  expect(metadataUrl).toBe(`${den.ref.apiUrl}/.well-known/oauth-protected-resource/mcp/agent`);
  await challenge.arrayBuffer();
  if (!metadataUrl) throw new Error("Missing protected-resource discovery URL");
  const discovery = await request(new URL(metadataUrl).pathname);
  expect(discovery.status).toBe(200);
  const metadata: unknown = await discovery.json();
  const resource = stringField(metadata, "resource");
  expect(resource).toBe(`${den.ref.apiUrl}/mcp/agent`);
  expect(metadata).toMatchObject({ authorization_servers: [`${origin}/api/auth`], bearer_methods_supported: ["header"] });
  const authorize = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri, scope, resource, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", prompt: "consent" });
  for (const resources of [[], ["https://unrelated.example/mcp"], [resource, resource]]) {
    const rejectedQuery = new URLSearchParams(authorize);
    rejectedQuery.delete("resource");
    for (const value of resources) rejectedQuery.append("resource", value);
    const rejected = await request(`/api/auth/oauth2/authorize?${rejectedQuery}`, { headers: { cookie } });
    expect(rejected.status).toBe(400);
    expect(rejected.headers.has("location")).toBe(false);
    expect(await rejected.json()).toMatchObject({ error: "invalid_target" });
  }
  const authorization = await request(`/api/auth/oauth2/authorize?${authorize}`, { headers: { cookie } });
  expect(authorization.status).toBe(302);
  const consentLocation = authorization.headers.get("location");
  if (!consentLocation) throw new Error("Missing consent redirect");
  const consent = await request("/api/auth/oauth2/consent", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ accept: true, scope, oauth_query: new URL(consentLocation, origin).search.slice(1) }),
  });
  expect(consent.status, await consent.clone().text()).toBe(200);
  const callback = new URL(stringField(await consent.json(), "url"));
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("Missing authorization code");
  for (const resources of [[], ["https://unrelated.example/mcp"], [resource, resource]]) {
    const rejectedBody = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri });
    for (const value of resources) rejectedBody.append("resource", value);
    const rejected = await request("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: rejectedBody,
    });
    expect(rejected.status).toBe(400);
    expect(rejected.headers.get("cache-control")).toBe("no-store");
    const error: unknown = await rejected.json();
    expect(error).toMatchObject({ error: "invalid_target" });
    expect(error).not.toHaveProperty("access_token");
    expect(error).not.toHaveProperty("refresh_token");
  }
  const exchange = await request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource }),
  });
  expect(exchange.status).toBe(200);
  const token = stringField(await exchange.json(), "access_token");
  expect(token.split(".")).toHaveLength(3);
  evidence.recordAssertionEvidence(
    "Protected-resource discovery supports a synthetic OAuth client without accepting invalid resources",
    "The unauthenticated challenge led to agent metadata. Missing, unknown, and repeated resources returned invalid_target at authorization and code exchange; no redirect or token was issued. The same code then exchanged successfully with the discovered resource.",
    true,
  );

  // This also proves the server is running with production rate limits enabled.
  const burstStarted = Date.now();
  let limited = false;
  for (let attempt = 0; attempt < 25; attempt++) {
    const response = await request("/api/auth/jwks");
    await response.arrayBuffer();
    if (response.status === 429) { limited = true; break; }
    expect(response.status).toBe(200);
  }
  expect(limited).toBe(true);
  const spoofedClient = await request("/api/auth/jwks", { headers: { "x-forwarded-for": "203.0.113.44, 198.51.100.10, 192.0.2.10" } });
  expect(spoofedClient.status).toBe(429);
  await spoofedClient.arrayBuffer();
  const otherClient = await request("/api/auth/jwks", { headers: { "x-forwarded-for": "198.51.100.11, 192.0.2.10" } });
  expect(otherClient.status).toBe(200);
  await otherClient.arrayBuffer();

  for (let attempt = 0; attempt < 25; attempt++) {
    const response = await request("/mcp/agent", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: attempt + 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "regression-test", version: "1" } } }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.has("www-authenticate")).toBe(false);
    expect(await response.text()).toContain("serverInfo");
  }
  expect(Date.now() - burstStarted).toBeLessThan(60_000);
  const invalid = await request("/mcp/agent", { headers: { authorization: "Bearer invalid.jwt.token" } });
  expect(invalid.status).toBe(401);
  expect(invalid.headers.get("www-authenticate")).toContain("invalid_token");
  await invalid.arrayBuffer();
  evidence.recordAssertionEvidence(
    "Public auth throttling isolates client addresses and does not invalidate MCP credentials",
    "Observed 429 for the exhausted client, 200 for another client and 25 signed MCP requests, and 401 with invalid_token for a malformed token.",
    true,
  );
});
