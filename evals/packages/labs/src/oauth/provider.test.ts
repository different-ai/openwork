import { createHash, createPublicKey, verify } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { GOOGLE_OAUTH_ENDPOINTS, startOAuthProvider } from "./index.ts";
import type { OAuthFaults, StartedOAuthProvider } from "./index.ts";

const redirectUri = "http://127.0.0.1:4444/api/auth/callback/google?existing=1";
const client = { clientId: "eval-client", clientSecret: "fictional-eval-secret", redirectUris: [redirectUri] };
const secondClient = { clientId: "second-client", clientSecret: "fictional-second-secret", redirectUris: [redirectUri] };
const account = { sub: "google-sub-123", email: "member@acme.test", name: "Eval Member" };
const state = "state +/&?=雪";
const nonce = "nonce-from-client";
const verifier = "a".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected JSON object");
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string");
  return value;
}

function post(url: string, fields: Record<string, string>, headers?: Record<string, string>) {
  return fetch(url, { method: "POST", body: new URLSearchParams(fields), headers, redirect: "manual" });
}

function handleFromHtml(body: string): string {
  const value = /name="interaction" value="([A-Za-z0-9_-]+)"/.exec(body)?.[1];
  if (!value) throw new Error("No interaction in provider form");
  return value;
}

describe("Google-shaped OAuth/OIDC protocol fixture", () => {
  let provider: StartedOAuthProvider;
  let clock = Date.parse("2026-11-08T12:00:00Z");
  beforeAll(async () => {
    provider = await startOAuthProvider({ clients: [client, secondClient], accounts: [account], now: () => clock });
  });
  afterAll(async () => { await provider.stop(); });
  beforeEach(() => {
    clock = Date.parse("2026-11-08T12:00:00Z");
    provider.setFaults({});
    provider.events.length = 0;
  });

  function authorizationUrl(overrides: Record<string, string> = {}): URL {
    const url = new URL(provider.endpoints.authorization);
    url.search = new URLSearchParams({
      client_id: client.clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid email profile",
      state, nonce, code_challenge: challenge, code_challenge_method: "S256", ...overrides,
    }).toString();
    return url;
  }

  async function choose(url = authorizationUrl()): Promise<string> {
    const response = await fetch(url, { redirect: "manual" });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Choose an account");
    expect(body).toContain(account.email);
    expect(body).toContain(account.name);
    expect(body).toContain('class="avatar" aria-hidden="true">E</span>');
    expect(body).toContain('aria-label="Google"');
    expect(body).toContain("Local OAuth test provider");
    const interaction = handleFromHtml(body);
    const selected = await post(`${provider.baseUrl}/mock-oauth/select`, { interaction, account: account.sub });
    expect(selected.status).toBe(303);
    const consent = await fetch(new URL(text(selected.headers.get("location")), provider.baseUrl));
    expect(consent.status).toBe(200);
    const consentBody = await consent.text();
    expect(consentBody).toContain("Sign in to OpenWork");
    expect(consentBody).toContain('value="approve">Continue</button>');
    expect(consentBody).toContain('value="deny">Cancel</button>');
    expect(consentBody).toContain("Local OAuth test provider");
    expect(consent.headers.get("content-security-policy")).toContain("style-src 'unsafe-inline'");
    return interaction;
  }

  async function approve(overrides: Record<string, string> = {}, decision = "approve"): Promise<URL> {
    const interaction = await choose(authorizationUrl(overrides));
    const response = await post(`${provider.baseUrl}/mock-oauth/consent`, { interaction, decision });
    expect(response.status).toBe(302);
    return new URL(text(response.headers.get("location")));
  }

  async function issue(overrides: Record<string, string> = {}): Promise<string> {
    const callback = await approve(overrides);
    return text(callback.searchParams.get("code"));
  }

  function exchange(code: string, overrides: Record<string, string> = {}, headers?: Record<string, string>) {
    return post(provider.endpoints.token, {
      grant_type: "authorization_code", client_id: client.clientId, client_secret: client.clientSecret,
      redirect_uri: redirectUri, code, code_verifier: verifier, ...overrides,
    }, headers);
  }

  async function assertError(response: Response, status: number, error: string) {
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    expect(response.headers.get("cache-control")).toBe("no-store");
  }

  async function jwtValid(token: string): Promise<boolean> {
    const jwks = object(await (await fetch(provider.endpoints.jwks)).json());
    if (!Array.isArray(jwks.keys)) throw new Error("Expected JWKS keys");
    const key = object(jwks.keys[0]);
    const publicKey = createPublicKey({ key: { kty: text(key.kty), n: text(key.n), e: text(key.e) }, format: "jwk" });
    const [header, payload, signature] = token.split(".");
    return verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(text(signature), "base64url"));
  }

  test("account chooser → consent → callback preserves state, signs RS256 and serves bearer userinfo", async () => {
    const callback = await approve();
    expect(callback.origin + callback.pathname).toBe(new URL(redirectUri).origin + new URL(redirectUri).pathname);
    expect(callback.searchParams.get("existing")).toBe("1");
    expect(callback.searchParams.get("state")).toBe(state);
    const response = await exchange(text(callback.searchParams.get("code")));
    expect(response.status).toBe(200);
    const tokens = object(await response.json());
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 300, scope: "openid email profile" });
    const token = text(tokens.id_token);
    expect(await jwtValid(token)).toBe(true);
    const [header, payload] = token.split(".");
    expect(JSON.parse(Buffer.from(text(header), "base64url").toString())).toMatchObject({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(text(payload), "base64url").toString())).toMatchObject({
      iss: "https://accounts.google.com", aud: client.clientId, sub: account.sub, email: account.email,
      email_verified: true, nonce, iat: clock / 1000, exp: clock / 1000 + 300,
    });
    const info = await fetch(provider.endpoints.userinfo, { headers: { authorization: `Bearer ${text(tokens.access_token)}` } });
    expect(await info.json()).toEqual({ ...account, email_verified: true });
    expect(provider.events.map((event) => event.type)).toEqual(["authorize", "account_selected", "consent", "code_issued", "token", "jwks", "userinfo"]);
    expect(provider.events[0]).toMatchObject({ clientId: client.clientId, redirectUri, state, scope: "openid email profile", at: clock });
    const witness = JSON.stringify(provider.events);
    for (const secret of [client.clientSecret, text(callback.searchParams.get("code")), text(tokens.access_token), token, verifier]) expect(witness).not.toContain(secret);
  });

  test("discovery advertises real Google URLs and JWKS publishes only public RSA material", async () => {
    expect(provider.publicEndpoints).toEqual(GOOGLE_OAUTH_ENDPOINTS);
    const discovery = await fetch(provider.endpoints.discovery);
    expect(await discovery.json()).toMatchObject({
      issuer: "https://accounts.google.com", authorization_endpoint: GOOGLE_OAUTH_ENDPOINTS.authorization,
      token_endpoint: GOOGLE_OAUTH_ENDPOINTS.token, jwks_uri: GOOGLE_OAUTH_ENDPOINTS.jwks,
      userinfo_endpoint: GOOGLE_OAUTH_ENDPOINTS.userinfo, code_challenge_methods_supported: ["S256"],
    });
    const jwks = object(await (await fetch(provider.endpoints.jwks)).json());
    expect(jwks).toMatchObject({ keys: [{ kty: "RSA", alg: "RS256", use: "sig" }] });
    expect(JSON.stringify(jwks)).not.toContain('"d":');
    expect(provider.events.map((event) => event.type)).toEqual(["discovery", "jwks"]);
  });

  test.each<Record<string, string>>([
    { client_id: "not-registered" },
    { redirect_uri: "https://evil.test/callback" },
    { redirect_uri: `${redirectUri}&extra=1` },
    { redirect_uri: `${redirectUri}#fragment` },
    { redirect_uri: "" },
  ])("rejects unregistered clients/redirects without redirecting: %j", async (overrides) => {
    const response = await fetch(authorizationUrl(overrides), { redirect: "manual" });
    expect(response.headers.get("location")).toBeNull();
    await assertError(response, 400, "invalid_request");
    expect(provider.events).toMatchObject([{ type: "rejected" }]);
  });

  test("rejects duplicate authorize parameters and unsupported response types", async () => {
    const url = authorizationUrl();
    url.searchParams.append("client_id", client.clientId);
    await assertError(await fetch(url), 400, "invalid_request");
    await assertError(await fetch(authorizationUrl({ response_type: "token" })), 400, "unsupported_response_type");
  });

  test.each<Record<string, string>>([
    { code_challenge_method: "plain" },
    { code_challenge_method: "" },
    { code_challenge: "short" },
    { code_challenge: "" },
  ])("requires a valid S256 challenge when PKCE is requested: %j", async (overrides) => {
    await assertError(await fetch(authorizationUrl(overrides)), 400, "invalid_request");
  });

  test("rejects PKCE method without a challenge", async () => {
    const url = authorizationUrl();
    url.searchParams.delete("code_challenge");
    await assertError(await fetch(url), 400, "invalid_request");
  });

  test("rejects unknown accounts, guessed handles, consent without selection and reused consent", async () => {
    await assertError(await post(`${provider.baseUrl}/mock-oauth/select`, { interaction: "guessed", account: account.sub }), 400, "invalid_request");
    const response = await fetch(authorizationUrl());
    const interaction = handleFromHtml(await response.text());
    await assertError(await post(`${provider.baseUrl}/mock-oauth/consent`, { interaction, decision: "approve" }), 400, "invalid_request");
    await assertError(await post(`${provider.baseUrl}/mock-oauth/select`, { interaction, account: "other@evil.test" }), 400, "invalid_request");
    expect((await post(`${provider.baseUrl}/mock-oauth/select`, { interaction, account: account.sub })).status).toBe(303);
    await assertError(await post(`${provider.baseUrl}/mock-oauth/consent`, { interaction, decision: "unknown" }), 400, "invalid_request");
    expect((await post(`${provider.baseUrl}/mock-oauth/consent`, { interaction, decision: "approve" })).status).toBe(302);
    await assertError(await post(`${provider.baseUrl}/mock-oauth/consent`, { interaction, decision: "approve" }), 400, "invalid_request");
  });

  test("expires interaction handles", async () => {
    const interaction = await choose();
    clock += 300_000;
    await assertError(await post(`${provider.baseUrl}/mock-oauth/consent`, { interaction, decision: "approve" }), 400, "invalid_request");
  });

  test.each(["explicit", "fault"])("denied consent returns access_denied with original state (%s)", async (mode) => {
    provider.setFaults(mode === "fault" ? { denyConsent: true } : {});
    const callback = await approve({}, mode === "explicit" ? "deny" : "approve");
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("state")).toBe(state);
    expect(callback.searchParams.has("code")).toBe(false);
    expect(provider.events.some((event) => event.type === "code_issued")).toBe(false);
  });

  test("supports authorization without state, nonce or PKCE", async () => {
    const url = authorizationUrl();
    for (const key of ["state", "nonce", "code_challenge", "code_challenge_method"]) url.searchParams.delete(key);
    const interaction = await choose(url);
    const consent = await post(`${provider.baseUrl}/mock-oauth/consent`, { interaction, decision: "approve" });
    const callback = new URL(text(consent.headers.get("location")));
    expect(callback.searchParams.has("state")).toBe(false);
    const tokens = object(await (await exchange(text(callback.searchParams.get("code")))).json());
    const claims = JSON.parse(Buffer.from(text(text(tokens.id_token).split(".")[1]), "base64url").toString());
    expect(claims).not.toHaveProperty("nonce");
  });

  test("authenticates token client before consuming the code", async () => {
    const code = await issue();
    const response = await exchange(code, { client_secret: "wrong-secret" });
    expect(response.headers.get("www-authenticate")).toContain("Basic");
    await assertError(response, 401, "invalid_client");
    expect((await exchange(code)).status).toBe(200);
  });

  test("supports client_secret_basic and rejects conflicting authentication", async () => {
    const code = await issue();
    const authorization = `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`;
    await assertError(await exchange(code, {}, { authorization }), 401, "invalid_client");
    const response = await post(provider.endpoints.token, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }, { authorization });
    expect(response.status).toBe(200);
  });

  test("rejects malformed Basic auth without server error", async () => {
    const code = await issue();
    const authorization = `Basic ${Buffer.from("%ZZ:secret").toString("base64")}`;
    await assertError(await post(provider.endpoints.token, { grant_type: "authorization_code", code }, { authorization }), 401, "invalid_client");
  });

  test("codes are single use even for parallel redemption", async () => {
    const code = await issue();
    const responses = await Promise.all([exchange(code), exchange(code)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    await assertError(await exchange(code), 400, "invalid_grant");
  });

  test.each<Record<string, string>>([
    { redirect_uri: "https://evil.test/callback" },
    { code_verifier: "b".repeat(64) },
    { code_verifier: "" },
    { code_verifier: "a".repeat(129) },
    { client_id: secondClient.clientId, client_secret: secondClient.clientSecret },
  ])("binds code to redirect, client and verifier and consumes failed redemption: %j", async (overrides) => {
    const code = await issue();
    await assertError(await exchange(code, overrides), 400, "invalid_grant");
    await assertError(await exchange(code), 400, "invalid_grant");
  });

  test("unknown codes and unsupported grants fail", async () => {
    await assertError(await exchange("unknown"), 400, "invalid_grant");
    await assertError(await exchange("unknown", { grant_type: "refresh_token" }), 400, "unsupported_grant_type");
  });

  test("codes expire at the precise lifetime boundary", async () => {
    const code = await issue();
    clock += 60_000;
    await assertError(await exchange(code), 400, "invalid_grant");
  });

  test.each<{ fault: OAuthFaults; status: number; error: string }>([
    { fault: { expiredCode: true }, status: 400, error: "invalid_grant" },
    { fault: { invalidClient: true }, status: 401, error: "invalid_client" },
    { fault: { invalidGrant: true }, status: 400, error: "invalid_grant" },
  ])("deterministic protocol fault: $fault", async ({ fault, status, error }) => {
    provider.setFaults(fault);
    const code = await issue();
    await assertError(await exchange(code), status, error);
  });

  test("nonce mismatch is signed while bad signature fails verification against published JWKS", async () => {
    const code = await issue();
    provider.setFaults({ nonceMismatch: true });
    const nonceTokens = object(await (await exchange(code)).json());
    const token = text(nonceTokens.id_token);
    const claims = JSON.parse(Buffer.from(text(token.split(".")[1]), "base64url").toString());
    expect(claims.nonce).toBe(`${nonce}-mismatch`);
    expect(await jwtValid(token)).toBe(true);
    provider.setFaults({ badSignature: true });
    const badTokens = object(await (await exchange(await issue())).json());
    expect(await jwtValid(text(badTokens.id_token))).toBe(false);
  });

  test("userinfo requires unexpired bearer and does not accept query access tokens", async () => {
    await assertError(await fetch(provider.endpoints.userinfo), 401, "invalid_token");
    await assertError(await fetch(provider.endpoints.userinfo, { headers: { authorization: "Bearer unknown" } }), 401, "invalid_token");
    const tokens = object(await (await exchange(await issue())).json());
    const accessToken = text(tokens.access_token);
    await assertError(await fetch(`${provider.endpoints.userinfo}?access_token=${accessToken}`), 401, "invalid_token");
    clock += 300_000;
    const response = await fetch(provider.endpoints.userinfo, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(response.headers.get("www-authenticate")).toContain("invalid_token");
    await assertError(response, 401, "invalid_token");
  });

  test("OAuth-only scope omits id_token", async () => {
    const tokens = object(await (await exchange(await issue({ scope: "email profile" }))).json());
    expect(tokens).not.toHaveProperty("id_token");
    expect(tokens).toHaveProperty("access_token");
  });

  test("escapes request content in consent HTML", async () => {
    const interaction = await choose(authorizationUrl({ scope: '<script>alert("x")</script>' }));
    const response = await fetch(`${provider.baseUrl}/mock-oauth/consent?interaction=${interaction}`);
    const body = await response.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  test("rejects wrong methods, non-form bodies, duplicate token fields and oversized bodies", async () => {
    await assertError(await fetch(provider.endpoints.token), 405, "method_not_allowed");
    await assertError(await fetch(`${provider.baseUrl}/missing`), 404, "not_found");
    await assertError(await fetch(provider.endpoints.token, { method: "POST", body: JSON.stringify({ client_id: client.clientId }), headers: { "content-type": "application/json" } }), 400, "invalid_request");
    await assertError(await fetch(provider.endpoints.token, { method: "POST", body: `client_id=${client.clientId}&client_id=other`, headers: { "content-type": "application/x-www-form-urlencoded" } }), 400, "invalid_request");
    await assertError(await post(provider.endpoints.token, { data: "a".repeat(17_000) }), 400, "invalid_request");
  });
});

describe("OAuth provider configuration", () => {
  test("registers clients after startup and replaces redirect allowlists without retaining mutable inputs", async () => {
    const provider = await startOAuthProvider({ clients: [] });
    try {
      const authorize = (redirect: string) => {
        const url = new URL(provider.endpoints.authorization);
        url.search = new URLSearchParams({ client_id: client.clientId, redirect_uri: redirect, response_type: "code" }).toString();
        return fetch(url, { redirect: "manual" });
      };
      expect((await authorize(redirectUri)).status).toBe(400);
      const redirects = [redirectUri];
      provider.registerClient({ ...client, redirectUris: redirects });
      redirects.push("https://unregistered.test/callback");
      expect((await authorize(redirectUri)).status).toBe(200);
      expect((await authorize(redirects[1] ?? "")).status).toBe(400);
      provider.registerClient({ ...client, redirectUris: ["http://127.0.0.1:5555/new-callback"] });
      expect((await authorize(redirectUri)).status).toBe(400);
      expect((await authorize("http://127.0.0.1:5555/new-callback")).status).toBe(200);
      expect(() => provider.registerClient({ ...client, redirectUris: [] })).toThrow("redirect URIs");
    } finally {
      await provider.stop();
    }
  });

  test("supports other provider endpoints and issuer; stop is idempotent", async () => {
    const endpoints = { authorization: "https://idp.example.test/authorize", token: "https://idp.example.test/token", jwks: "https://idp.example.test/jwks", userinfo: "https://idp.example.test/userinfo", discovery: "https://idp.example.test/.well-known/openid-configuration" };
    const provider = await startOAuthProvider({ clients: [client], issuer: "https://idp.example.test", endpoints });
    try {
      expect(provider.issuer).toBe("https://idp.example.test");
      expect(provider.publicEndpoints).toEqual(endpoints);
      expect(await (await fetch(provider.endpoints.discovery)).json()).toMatchObject({ issuer: provider.issuer, authorization_endpoint: endpoints.authorization });
    } finally {
      await provider.stop();
      await provider.stop();
    }
  });

  test("validates clients, redirects, subjects, TTLs and loopback binding", async () => {
    await expect(startOAuthProvider({ clients: [{ ...client, clientSecret: "" }] })).rejects.toThrow("confidential client");
    await expect(startOAuthProvider({ clients: [client, client] })).rejects.toThrow("Duplicate");
    await expect(startOAuthProvider({ clients: [{ ...client, redirectUris: ["javascript:alert(1)"] }] })).rejects.toThrow("redirect");
    await expect(startOAuthProvider({ clients: [client], accounts: [] })).rejects.toThrow("Accounts");
    await expect(startOAuthProvider({ clients: [client], listen: { host: "0.0.0.0" } })).rejects.toThrow("loopback");
    await expect(startOAuthProvider({ clients: [client], codeTtlMs: 0 })).rejects.toThrow("positive");
    await expect(startOAuthProvider({ clients: [client], endpoints: { token: GOOGLE_OAUTH_ENDPOINTS.jwks } })).rejects.toThrow("distinct");
  });
});
