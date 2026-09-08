import { createHash, randomBytes } from "node:crypto";
import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import { localMysqlIsRunning, localRedisIsRunning, server, test } from "@openwork/testkit";
import { SkipError } from "@openwork/env";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an OAuth response object");
  return value;
}
function string(value: unknown, key: string): string {
  const field = record(value)[key];
  if (typeof field !== "string" || !field) throw new Error(`Missing OAuth field: ${key}`);
  return field;
}

test("overlapping MCP refreshes reuse one successor without granting another client or broader scopes", { timeout: 300_000 }, async ({ place, evidence }) => {
  const remote = process.env.OPENWORK_EVAL_DAYTONA === "1" || Boolean(process.env.OPENWORK_EVAL_DEN_API_URL?.trim());
  if (!remote) {
    const missing = [];
    if (!await localMysqlIsRunning()) missing.push("MySQL on 127.0.0.1:3306");
    if (!await localRedisIsRunning()) missing.push("Redis on 127.0.0.1:6379");
    if (missing.length) {
      const message = missing.join(" and ");
      if (process.env.OPENWORK_EVAL_MCP_OAUTH_REQUIRED === "1") throw new Error(`Required MCP OAuth regression needs ${message}`);
      throw new SkipError(message);
    }
  }
  await using den = await server({ place, web: false, org: { name: "MCP refresh regression", members: {} } });
  const login = await denFetch(den.ref, "/api/auth/sign-in/email", {
    method: "POST", body: JSON.stringify({ email: den.admin.email, password: den.admin.password }),
  });
  expect(login.response.status).toBe(200);
  const cookie = login.response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Sign-in did not return a session cookie");
  const orgs = await denFetch(den.admin, "/v1/me/orgs", { headers: { authorization: `Bearer ${den.admin.token}` } });
  const entries = record(orgs.body).orgs;
  if (!Array.isArray(entries) || !entries.length) throw new Error("Missing test organization");
  const organizationId = string(entries[0], "id");
  const selected = await denFetch(den.admin, "/v1/me/active-organization", {
    method: "POST", headers: { authorization: `Bearer ${string(login.body, "token")}`, cookie }, body: JSON.stringify({ organizationId }),
  });
  expect(selected.response.status).toBe(200);

  const metadata = await denFetch(den.ref, "/.well-known/oauth-protected-resource/mcp/agent");
  const resource = string(metadata.body, "resource");
  const scope = "mcp:read offline_access";
  const redirectUri = "http://127.0.0.1:1455/callback";
  async function register() {
    const result = await denFetch(den.ref, "/register", {
      method: "POST", body: JSON.stringify({ client_name: "MCP refresh regression", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope }),
    });
    expect(result.response.status).toBe(201);
    return string(result.body, "client_id");
  }
  const clientId = await register();
  const otherClientId = await register();
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri, scope, resource, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", prompt: "consent" });
  const authorize = await denFetch(den.ref, `/api/auth/oauth2/authorize?${query}`, { headers: { cookie }, redirect: "manual" });
  expect(authorize.response.status).toBe(302);
  const location = authorize.response.headers.get("location");
  if (!location) throw new Error("Authorize did not return consent location");
  const consent = await denFetch(den.ref, "/api/auth/oauth2/consent", {
    method: "POST", headers: { cookie, origin: new URL(location).origin }, body: JSON.stringify({ accept: true, scope, oauth_query: new URL(location).search.slice(1) }),
  });
  expect(consent.response.status).toBe(200);
  const code = new URL(string(consent.body, "url")).searchParams.get("code");
  if (!code) throw new Error("Consent did not return authorization code");
  async function token(params: Record<string, string>) {
    return denFetch(den.ref, "/api/auth/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() });
  }
  const issued = await token({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource });
  expect(issued.response.status).toBe(200);
  let refreshToken = string(issued.body, "refresh_token");
  const originalRefreshToken = refreshToken;
  const statuses: number[][] = [];
  for (let round = 0; round < 3; round++) {
    // Separate HTTP requests model independent MCP workers holding the same credential.
    const results = await Promise.all(Array.from({ length: 4 }, () => token({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken })));
    statuses.push(results.map((result) => result.response.status));
    evidence.recordAssertionEvidence(`Concurrent refresh round ${round + 1} succeeds`, `HTTP statuses: ${statuses[round].join(", ")}`, results.every((result) => result.response.status === 200));
    expect(results.map((result) => result.response.status)).toEqual([200, 200, 200, 200]);
    expect(results.every((result) => !record(result.body).error)).toBe(true);
    const successors = results.map((result) => string(result.body, "refresh_token"));
    expect(new Set(successors).size).toBe(1);
    expect(successors[0]).not.toBe(refreshToken);
    for (const restrictedToken of [refreshToken, successors[0]]) {
      const wrongClient = await token({ grant_type: "refresh_token", client_id: otherClientId, refresh_token: restrictedToken });
      expect(wrongClient.response.status).toBe(400);
      expect(record(wrongClient.body).error).toBe("invalid_grant");
      const widerScope = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: restrictedToken, scope: "mcp:read mcp:write offline_access" });
      expect(widerScope.response.status).toBe(400);
      expect(record(widerScope.body).error).toBe("invalid_scope");
    }
    refreshToken = successors[0];
  }
  const mismatchedReplay = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: originalRefreshToken, scope: "mcp:read" });
  expect(mismatchedReplay.response.status).toBe(400);
  expect(record(mismatchedReplay.body).error).toBe("invalid_grant");
  const foreignResource = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: originalRefreshToken, resource: "https://unrelated.example/mcp" });
  expect(foreignResource.response.status).toBe(400);
  expect(record(foreignResource.body).error).toBe("invalid_target");
  const final = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
  expect(final.response.status).toBe(200);
  const initialized = await denFetch(den.ref, "/mcp/agent", {
    method: "POST", headers: { authorization: `Bearer ${string(final.body, "access_token")}`, accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex-mcp-client-regression", version: "1.0" } } }),
  });
  expect(initialized.response.status).toBe(200);
  expect(initialized.text).toContain("protocolVersion");
  // A valid replay still succeeds well inside the configured 30-second grace.
  await new Promise((resolve) => setTimeout(resolve, 20_000));
  const delayedReplay = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
  expect(delayedReplay.response.status).toBe(200);
  expect(string(delayedReplay.body, "refresh_token")).toBe(string(final.body, "refresh_token"));
  expect(string(delayedReplay.body, "access_token")).toBe(string(final.body, "access_token"));
  evidence.recordAssertionEvidence("Replay remains usable later within the grace interval", "After 20 seconds, the same refresh request returns HTTP 200 and the identical access and refresh tokens.", true);
  // Stale replay retains the provider's existing family-revocation policy.
  await new Promise((resolve) => setTimeout(resolve, 11_000));
  const stale = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: originalRefreshToken });
  expect(stale.response.status).toBe(400);
  expect(record(stale.body).error).toBe("invalid_grant");
  const revokedSuccessor = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: string(final.body, "refresh_token") });
  expect(revokedSuccessor.response.status).toBe(400);
  expect(record(revokedSuccessor.body).error).toBe("invalid_grant");
  evidence.recordAssertionEvidence("Replay remains bound to the original request and grace interval", "Narrower-scope replay and a foreign resource returned 400. After 31 seconds, stale replay and its revoked successor both returned invalid_grant.", true);
  evidence.recordAssertionEvidence("One successor remains usable and replay cannot cross clients or expand scopes", "All overlapping responses shared one successor; wrong-client and wider-scope attempts returned 400; the final successor refreshed and initialized MCP with HTTP 200.", true);
});
