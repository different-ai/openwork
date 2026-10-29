// Standalone Node 22+ integration proof; no product dependencies or external identity provider.
// node --test evals/packages/open-workplace/src/workshop-auth.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { createWorkshopAuth } from "./workshop-auth.mjs";

const participants = [
  { id: "alice", name: "Alice <Workshop>", token: "alice-" + "a".repeat(40) },
  { id: "bob", name: "Bob Workshop", token: "bob-" + "b".repeat(40) },
];
async function fixture(t, storage, options = {}) {
  let auth;
  const server = createServer(async (req, res) => {
    if (await auth.handle(req, res, new URL(req.url, origin))) return;
    if (!auth.requireMutationOrigin(req)) { res.writeHead(403); res.end(); return; }
    const participant = auth.authenticate(req);
    res.writeHead(participant ? 200 : 401, { "Content-Type": "application/json" });
    res.end(JSON.stringify(participant ? { id: participant.id, name: participant.name } : null));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  auth = createWorkshopAuth({ origin, participants, storage, ...options });
  const restart = async (roster = participants, nextStorage = storage) => {
    await auth.close(); auth = createWorkshopAuth({ origin, participants: roster, storage: nextStorage, ...options });
    await request(options.automaticJoin ? "/signed-out" : "/login");
  };
  t.after(async () => { await auth.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const request = (path, requestOptions = {}) => fetch(origin + path, { redirect: "manual", ...requestOptions, headers: { ...(options.automaticJoin ? { Accept: "text/html" } : {}), ...requestOptions.headers } });
  const form = (path, fields, headers = {}) => request(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin, ...headers }, body: new URLSearchParams(fields) });
  const login = async (participant, next = "/", headers = {}) => {
    const response = await form("/login", { token: participant.token, next }, headers);
    assert.equal(response.status, 303);
    return { response, cookie: response.headers.get("set-cookie").split(";")[0] };
  };
  const register = async (redirectUri = "http://127.0.0.1:54321/callback", extra = {}) => {
    const response = await request("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Test <client>", ...extra }) });
    assert.equal(response.status, 201); return { ...await response.json(), redirectUri };
  };
  const authorization = (client, resource = origin + "/outlook/mcp") => {
    const verifier = randomBytes(32).toString("base64url");
    const fields = { client_id: client.client_id, redirect_uri: client.redirectUri, response_type: "code", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"), scope: "workplace", state: "opaque-state", resource };
    return { verifier, fields, path: "/oauth/authorize?" + new URLSearchParams(fields) };
  };
  const issue = async (client, cookie, resource) => {
    const attempt = authorization(client, resource);
    const consent = await request(attempt.path, { headers: { Cookie: cookie } });
    assert.equal(consent.status, 200); assert.equal(consent.headers.get("location"), null);
    const html = await consent.text(); assert.match(html, /Allow workplace access/); assert.match(html, /Test &lt;client&gt;/);
    const response = await form("/oauth/authorize", { ...attempt.fields, decision: "allow" }, { Cookie: cookie });
    assert.equal(response.status, 303);
    const target = new URL(response.headers.get("location")); assert.equal(target.searchParams.get("state"), "opaque-state");
    return { ...attempt, code: target.searchParams.get("code") };
  };
  const redeem = (client, attempt, extra = {}) => form("/oauth/token", { grant_type: "authorization_code", client_id: client.client_id, redirect_uri: client.redirectUri, code: attempt.code, code_verifier: attempt.verifier, resource: attempt.fields.resource, ...extra });
  return { get auth() { return auth; }, server, origin, request, form, login, register, authorization, issue, redeem, restart };
}

test("two browser identities, session rotation, logout, bearer precedence, and escaped persona", async (t) => {
  const f = await fixture(t);
  const alice = await f.login(participants[0], "/jira"), bob = await f.login(participants[1]);
  assert.notEqual(alice.cookie, bob.cookie);
  assert.equal(alice.response.headers.get("location"), "/jira");
  assert.match(alice.response.headers.get("set-cookie"), /HttpOnly; SameSite=Strict; Max-Age=28800/);
  for (const [session, participant] of [[alice, participants[0]], [bob, participants[1]]]) {
    assert.deepEqual(await (await f.request("/who", { headers: { Cookie: session.cookie } })).json(), { id: participant.id, name: participant.name });
  }
  assert.equal((await f.request("/who", { headers: { Cookie: alice.cookie, Authorization: "Bearer invalid" } })).status, 401);
  assert.equal((await f.request("/who", { headers: { Cookie: alice.cookie, Authorization: "Basic invalid" } })).status, 401);
  assert.equal((await (await f.request("/who", { headers: { Cookie: alice.cookie, Authorization: `Bearer ${participants[1].token}` } })).json()).id, "bob");
  const html = await (await f.request("/login", { headers: { Cookie: alice.cookie } })).text();
  assert.match(html, /Alice &lt;Workshop&gt;/); assert.doesNotMatch(html, /Alice <Workshop>/); assert.doesNotMatch(html, new RegExp(participants[0].token));
  const rotated = await f.login(participants[0], "/", { Cookie: alice.cookie });
  assert.notEqual(rotated.cookie, alice.cookie);
  assert.equal((await f.request("/who", { headers: { Cookie: alice.cookie } })).status, 401);
  assert.equal((await f.form("/logout", {}, { Cookie: rotated.cookie })).status, 303);
  assert.equal((await f.request("/who", { headers: { Cookie: rotated.cookie } })).status, 401);
  assert.equal((await f.request("/who", { headers: { Cookie: bob.cookie } })).status, 200);
});

test("same-origin policy rejects foreign Origin even with bearer and on GET; cookie writes require origin", async (t) => {
  const f = await fixture(t), alice = await f.login(participants[0]);
  assert.equal((await f.request("/who", { headers: { Cookie: alice.cookie, Origin: "https://foreign.example" } })).status, 403);
  assert.equal((await f.request("/who", { headers: { Authorization: `Bearer ${participants[0].token}`, Origin: "https://foreign.example" } })).status, 403);
  assert.equal((await f.request("/write", { method: "POST", headers: { Cookie: alice.cookie } })).status, 403);
  assert.equal((await f.request("/write", { method: "POST", headers: { Cookie: alice.cookie, Referer: f.origin + "/jira" } })).status, 200);
  assert.equal((await f.request("/write", { method: "POST", headers: { Authorization: `Bearer ${participants[0].token}` } })).status, 200);
  assert.equal((await f.form("/login", { token: participants[0].token }, { Origin: "https://foreign.example" })).status, 403);
  assert.equal((await f.form("/logout", {}, { Cookie: alice.cookie, Origin: "https://foreign.example" })).status, 403);
  assert.equal((await f.request("/logout", { method: "POST", headers: { Cookie: alice.cookie } })).status, 403);
});

test("login rejects URL tokens and unsafe next destinations; body bounded and failures throttled", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/login?token=never-use-query-tokens")).status, 400);
  for (const next of ["https://foreign.example", "//foreign.example", "/\\foreign.example", "/%2fforeign.example", "/%5cforeign.example", "/\nLocation:bad"]) {
    assert.equal((await f.login(participants[0], next)).response.headers.get("location"), "/");
  }
  assert.equal((await f.form("/login", { token: "x".repeat(17000) })).status, 413);
  const oversized = await f.request("/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: f.origin }, duplex: "half", body: (async function* () { yield "token="; yield "x".repeat(17000); })() });
  assert.equal(oversized.status, 413);
  for (let i = 0; i < 20; i++) assert.equal((await f.form("/login", { token: "wrong" })).status, 401);
  assert.equal((await f.form("/login", { token: "wrong" })).status, 429);
  assert.equal((await f.login(participants[1])).response.status, 303, "A shared venue IP's failed guesses must not block valid attendees");
});

test("OAuth discovery, DCR restrictions and credentialless CORS", async (t) => {
  const f = await fixture(t);
  const metadataResponse = await f.request("/.well-known/oauth-authorization-server"), metadata = await metadataResponse.json();
  assert.equal(metadata.issuer, f.origin); assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.equal(metadataResponse.headers.get("cache-control"), "no-store");
  assert.equal((await (await f.request("/.well-known/oauth-protected-resource/outlook/mcp")).json()).resource, f.origin + "/outlook/mcp");
  for (const redirect of ["http://foreign.example/cb", "https://user:password@example.com/cb", "https://example.com/cb#fragment", "https://example.com/cb#", "javascript:alert(1)"]) {
    const response = await f.request("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect] }) });
    assert.equal(response.status, 400);
  }
  await f.register("https://client.example/callback");
  const preflight = await f.request("/oauth/token", { method: "OPTIONS", headers: { Origin: "https://client.example" } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get("access-control-allow-origin"), "*"); assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
});

test("OAuth requires browser login and explicit same-origin consent before issuing a code", async (t) => {
  const f = await fixture(t), client = await f.register(), attempt = f.authorization(client);
  const anonymous = await f.request(attempt.path);
  assert.equal(anonymous.status, 303);
  const next = new URL(anonymous.headers.get("location"), f.origin).searchParams.get("next"); assert.equal(next, attempt.path);
  const alice = await f.login(participants[0], next);
  const page = await f.request(attempt.path, { headers: { Cookie: alice.cookie } });
  assert.equal(page.status, 200); assert.equal(page.headers.get("location"), null);
  const html = await page.text(); assert.match(html, /Alice &lt;Workshop&gt;/); assert.match(html, /127.0.0.1:54321/);
  assert.equal((await f.form("/oauth/authorize", attempt.fields, { Cookie: alice.cookie, Origin: "https://foreign.example" })).status, 403);
  assert.equal((await f.request(attempt.path, { headers: { Cookie: alice.cookie, Origin: "https://foreign.example" } })).status, 403);
  assert.equal((await f.request("/oauth/authorize", { method: "POST", headers: { Cookie: alice.cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(attempt.fields) })).status, 403);
});

test("OAuth PKCE tokens retain participant isolation, reject replay and enforce resource path", async (t) => {
  const f = await fixture(t), client = await f.register();
  const alice = await f.login(participants[0]), bob = await f.login(participants[1]);
  for (const [session, id] of [[alice, "alice"], [bob, "bob"]]) {
    const attempt = await f.issue(client, session.cookie, f.origin + "/outlook/mcp");
    const response = await f.redeem(client, attempt); assert.equal(response.status, 200);
    const token = await response.json(); assert.equal(token.scope, "workplace"); assert.equal(token.token_type, "Bearer"); assert.equal(typeof token.refresh_token, "string"); assert.equal(token.expires_in, 3600);
    assert.equal((await (await f.request("/outlook/mcp", { headers: { Authorization: `Bearer ${token.access_token}` } })).json()).id, id);
    assert.equal((await f.request("/jira/mcp", { headers: { Authorization: `Bearer ${token.access_token}`, Cookie: bob.cookie } })).status, 401);
    assert.equal((await f.request("/outlook/mcpevil", { headers: { Authorization: `Bearer ${token.access_token}` } })).status, 401);
    assert.equal((await f.redeem(client, attempt)).status, 400);
  }
});

test("OAuth rejects wrong verifier, client, redirect, audience, scope and non-S256 requests", async (t) => {
  const f = await fixture(t), client = await f.register(), other = await f.register(), alice = await f.login(participants[0]);
  for (const extra of [{ code_verifier: "z".repeat(43) }, { client_id: other.client_id }, { redirect_uri: "http://127.0.0.1:54321/other" }, { resource: "https://foreign.example/mcp" }, { resource: f.origin + "/mcp/other" }, { scope: "admin" }]) {
    const attempt = await f.issue(client, alice.cookie);
    assert.equal((await f.redeem(client, attempt, extra)).status, 400);
    assert.equal((await f.redeem(client, attempt)).status, 400, "failed redemption consumes the code");
  }
  for (const extra of [{ code_challenge_method: "plain" }, { scope: "admin" }, { redirect_uri: "https://foreign.example/callback" }, { resource: "https://foreign.example/mcp" }]) {
    const attempt = f.authorization(client);
    const response = await f.request("/oauth/authorize?" + new URLSearchParams({ ...attempt.fields, ...extra }), { headers: { Cookie: alice.cookie } });
    assert.equal(response.status, 400); assert.equal(response.headers.get("location"), null);
  }
});

test("DCR registrations are rate bounded", async (t) => {
  const f = await fixture(t);
  // A cohort can register all five connectors behind one venue/proxy IP.
  for (let i = 0; i < 600; i++) await f.register();
  const response = await f.request("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://localhost/callback"] }) });
  assert.equal(response.status, 429);
});

test("one participant cannot evict another's browser sessions or consume their authorization quota", async (t) => {
  const f = await fixture(t), alice = await f.login(participants[0]), bob = await f.login(participants[1]);
  let latestAlice = alice;
  for (let i = 0; i < 29; i++) latestAlice = await f.login(participants[0]);
  assert.equal((await f.form("/login", { token: participants[0].token })).status, 429);
  assert.equal((await f.request("/who", { headers: { Cookie: alice.cookie } })).status, 401, "Only Alice's old sessions may be reclaimed");
  assert.equal((await f.request("/who", { headers: { Cookie: bob.cookie } })).status, 200);
  const client = await f.register();
  const current = await f.login(participants[1]);
  for (let i = 0; i < 16; i++) await f.issue(client, current.cookie);
  const rejected = f.authorization(client);
  assert.equal((await f.form("/oauth/authorize", rejected.fields, { Cookie: current.cookie })).status, 429);
  assert.ok((await f.issue(client, latestAlice.cookie)).code, "Bob's quota must not block Alice's authorization");
});

test("authorization codes, access tokens and browser sessions expire", async (t) => {
  const f = await fixture(t), client = await f.register(), alice = await f.login(participants[0]);
  const code = await f.issue(client, alice.cookie);
  const secondCode = await f.issue(client, alice.cookie);
  const token = await (await f.redeem(client, secondCode)).json();
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 5 * 60 * 1000 + 1000);
  assert.equal((await f.redeem(client, code)).status, 400);
  t.mock.method(Date, "now", () => now + 60 * 60 * 1000 + 1000);
  assert.equal(f.auth.authenticate({ headers: { authorization: `Bearer ${token.access_token}` }, url: "/outlook/mcp" }), null);
  assert.equal(f.auth.authenticate({ headers: { cookie: alice.cookie }, url: "/outlook/mcp" }).id, "alice");
  t.mock.method(Date, "now", () => now + 8 * 60 * 60 * 1000 + 1000);
  assert.equal(f.auth.authenticate({ headers: { cookie: alice.cookie }, url: "/outlook/mcp" }), null);
  assert.equal((await f.form("/oauth/token", { grant_type: "refresh_token", client_id: client.client_id, refresh_token: token.refresh_token })).status, 400);
});

const memoryStorage = () => {
  const data = new Map();
  return { data, read(key) { return structuredClone(data.get(key)); }, write(key, value) { data.set(key, structuredClone(value)); }, delete(key) { data.delete(key); }, close() {} };
};
const refresh = (f, client, token, extra = {}) => f.form("/oauth/token", { grant_type: "refresh_token", client_id: client.client_id, refresh_token: token.refresh_token, resource: f.origin + "/outlook/mcp", ...extra });
const bearer = (token) => ({ headers: { Authorization: `Bearer ${token.access_token}` } });

test("native sign-in, actionable errors, consent denial and sign-in cancellation", async (t) => {
  const f = await fixture(t), client = await f.register(), attempt = f.authorization(client);
  const signIn = await (await f.request("/login?next=" + encodeURIComponent(attempt.path))).text();
  assert.match(signIn, /Acme Workplace/); assert.match(signIn, /Fictional workshop sandbox/);
  assert.match(signIn, /name="token"/); assert.match(signIn, /name="next"/); assert.doesNotMatch(signIn, /type="email"/);
  const invalid = await f.form("/login", { token: "wrong", next: attempt.path });
  assert.equal(invalid.status, 401); assert.match(await invalid.text(), /role="alert"/);
  const cancel = await f.form("/login", { decision: "cancel", next: attempt.path });
  const canceled = new URL(cancel.headers.get("location"));
  assert.equal(canceled.searchParams.get("error"), "access_denied"); assert.equal(canceled.searchParams.get("state"), "opaque-state");
  const alice = await f.login(participants[0]);
  const consent = await (await f.request(attempt.path, { headers: { Cookie: alice.cookie } })).text();
  for (const text of [/Signed in as/, /Unverified workshop application/, /Workplace permissions/, /name="decision" value="deny"/, /No real work accounts/]) assert.match(consent, text);
  const denied = await f.form("/oauth/authorize", { ...attempt.fields, decision: "deny" }, { Cookie: alice.cookie });
  const target = new URL(denied.headers.get("location")); assert.equal(target.searchParams.get("error"), "access_denied"); assert.equal(target.searchParams.has("code"), false);
});

test("refresh rotation preserves client, resource and identity; replay revokes its family only", async (t) => {
  const f = await fixture(t), client = await f.register(), other = await f.register();
  const alice = await f.login(participants[0]), bob = await f.login(participants[1]);
  const token = await (await f.redeem(client, await f.issue(client, alice.cookie))).json();
  const bobToken = await (await f.redeem(client, await f.issue(client, bob.cookie))).json();
  assert.equal((await refresh(f, other, token)).status, 400);
  assert.equal((await refresh(f, client, token, { resource: f.origin + "/other" })).status, 400);
  assert.equal((await refresh(f, client, token, { scope: "admin" })).status, 400);
  const rotatedResponse = await refresh(f, client, token, { resource: f.origin + "/outlook/mcp" });
  assert.equal(rotatedResponse.status, 200); const rotated = await rotatedResponse.json();
  assert.notEqual(rotated.refresh_token, token.refresh_token); assert.equal(rotated.expires_in, 3600);
  assert.equal((await f.request("/outlook/mcp", bearer(rotated))).status, 200);
  assert.equal((await f.request("/other", bearer(rotated))).status, 401);
  assert.equal((await refresh(f, client, token)).status, 400);
  assert.equal((await refresh(f, client, rotated)).status, 400);
  assert.equal((await f.request("/outlook/mcp", bearer(rotated))).status, 401);
  assert.equal((await f.request("/outlook/mcp", bearer(bobToken))).status, 200);
});

test("RFC 7009 revocation checks client and resource, is idempotent, and invalidates access and refresh", async (t) => {
  const f = await fixture(t), client = await f.register(), other = await f.register(), alice = await f.login(participants[0]);
  const metadata = await (await f.request("/.well-known/oauth-authorization-server")).json();
  assert.deepEqual(metadata.grant_types_supported, ["authorization_code", "refresh_token"]); assert.equal(metadata.revocation_endpoint, f.origin + "/oauth/revoke");
  for (const hint of ["access_token", "refresh_token"]) {
    const token = await (await f.redeem(client, await f.issue(client, alice.cookie))).json();
    const revoke = (fields) => f.form("/oauth/revoke", { token: token[hint], token_type_hint: hint, ...fields });
    assert.equal((await revoke({ client_id: other.client_id })).status, 200);
    assert.equal((await revoke({ client_id: client.client_id, resource: f.origin + "/other" })).status, 200);
    assert.equal((await f.request("/outlook/mcp", bearer(token))).status, 200);
    assert.equal((await revoke({ client_id: client.client_id, resource: f.origin + "/outlook/mcp" })).status, 200);
    assert.equal((await revoke({ client_id: client.client_id })).status, 200);
    assert.equal((await f.request("/outlook/mcp", bearer(token))).status, 401);
    assert.equal((await refresh(f, client, token)).status, 400);
  }
  assert.equal((await f.form("/oauth/revoke", { client_id: client.client_id, token: "unknown" })).status, 200);
});

test("storage restores clients, codes, sessions, tokens and refresh replay history without raw secrets", async (t) => {
  const storage = memoryStorage(), f = await fixture(t, storage), client = await f.register(), alice = await f.login(participants[0]);
  const attempt = await f.issue(client, alice.cookie);
  await f.restart();
  assert.equal((await f.request("/who", { headers: { Cookie: alice.cookie } })).status, 200);
  const token = await (await f.redeem(client, attempt)).json();
  const rotated = await (await refresh(f, client, token)).json();
  const saved = JSON.stringify([...storage.data]);
  for (const value of [participants[0].token, participants[1].token, alice.cookie.split("=")[1], attempt.code, token.access_token, token.refresh_token, rotated.refresh_token]) assert.equal(saved.includes(value), false, "Persistent auth must not contain raw credentials");
  assert.equal(saved.includes(participants[0].name), false);
  await f.restart();
  assert.equal((await f.request("/outlook/mcp", bearer(rotated))).status, 200);
  assert.equal((await refresh(f, client, token)).status, 400);
  await f.restart();
  assert.equal((await f.request("/outlook/mcp", bearer(rotated))).status, 401);
  assert.equal((await refresh(f, client, rotated)).status, 400);
});

test("roster removal and changed passwords invalidate restored identities, not other attendees", async (t) => {
  const f = await fixture(t, memoryStorage()), client = await f.register(), alice = await f.login(participants[0]), bob = await f.login(participants[1]);
  const token = await (await f.redeem(client, await f.issue(client, alice.cookie))).json();
  const code = await f.issue(client, alice.cookie);
  await f.restart([{ ...participants[0], token: "changed-workshop-password" }, participants[1]]);
  assert.equal((await f.request("/who", { headers: { Cookie: alice.cookie } })).status, 401);
  assert.equal((await f.request("/who", { headers: { Cookie: bob.cookie } })).status, 200);
  assert.equal((await f.request("/outlook/mcp", bearer(token))).status, 401);
  assert.equal((await refresh(f, client, token)).status, 400);
  assert.equal((await f.redeem(client, code)).status, 400);
  await f.restart([participants[0]]);
  assert.equal((await f.request("/who", { headers: { Cookie: bob.cookie } })).status, 401);
});

test("corrupt snapshots and failed acknowledged writes fail closed", async (t) => {
  const storage = memoryStorage(), f = await fixture(t, storage), alice = await f.login(participants[0]);
  storage.write = () => { throw new Error("disk unavailable"); };
  const failed = await f.form("/login", { token: participants[0].token });
  assert.equal(failed.status, 503); assert.equal(failed.headers.get("set-cookie"), null);
  assert.equal(f.auth.authenticate({ headers: { cookie: alice.cookie }, url: "/who" }), null);
  const corrupt = memoryStorage(); corrupt.data.set("workshop-auth:v1", { version: 1, origin: f.origin, tables: {} });
  await f.restart(participants, corrupt);
  assert.equal((await f.request("/login")).status, 503);
  assert.equal(corrupt.data.get("workshop-auth:v1").tables.sessions, undefined, "Do not overwrite or reseed corrupt storage");
});

test("a full connection quota cannot evict another participant's grant", async (t) => {
  const f = await fixture(t), client = await f.register(), alice = await f.login(participants[0]), bob = await f.login(participants[1]);
  const bobToken = await (await f.redeem(client, await f.issue(client, bob.cookie))).json();
  for (let i = 0; i < 32; i++) assert.equal((await f.redeem(client, await f.issue(client, alice.cookie))).status, 200);
  assert.equal((await f.redeem(client, await f.issue(client, alice.cookie))).status, 429);
  assert.equal((await f.request("/outlook/mcp", bearer(bobToken))).status, 200);
  assert.equal((await refresh(f, client, bobToken)).status, 200);
});

test("OAuth requires one of five exact resources at authorization, exchange and refresh", async (t) => {
  const f = await fixture(t), client = await f.register(), alice = await f.login(participants[0]);
  const badResources = [undefined, f.origin, f.origin + "/", f.origin + "/state", f.origin + "/reset", f.origin + "/outlook/mcp/", f.origin + "/outlook/mcp/child", f.origin + "/outlook/mcp?x=1", f.origin + "/arbitrary", f.origin + "/outlook/mcp#fragment"];
  for (const value of badResources) {
    const attempt = f.authorization(client), fields = { ...attempt.fields };
    if (value === undefined) delete fields.resource; else fields.resource = value;
    assert.equal((await f.request("/oauth/authorize?" + new URLSearchParams(fields), { headers: { Cookie: alice.cookie } })).status, 400);
    const valid = await f.issue(client, alice.cookie);
    const exchange = { grant_type: "authorization_code", client_id: client.client_id, redirect_uri: client.redirectUri, code: valid.code, code_verifier: valid.verifier };
    if (value !== undefined) exchange.resource = value;
    assert.equal((await f.form("/oauth/token", exchange)).status, 400);
  }
  for (const path of ["/outlook/mcp", "/calendar/mcp", "/drive/mcp", "/jira/mcp", "/confluence/mcp"]) {
    const audience = f.origin + path, attempt = await f.issue(client, alice.cookie, audience);
    const response = await f.redeem(client, attempt); assert.equal(response.status, 200);
    const token = await response.json();
    assert.equal((await f.request(path, bearer(token))).status, 200);
    for (const denied of ["/", "/state", "/reset", "/api/state", "/api/reset", path + "/", path + "/child", path === "/jira/mcp" ? "/outlook/mcp" : "/jira/mcp"]) assert.equal((await f.request(denied, bearer(token))).status, 401);
    const fields = { grant_type: "refresh_token", client_id: client.client_id, refresh_token: token.refresh_token };
    assert.equal((await f.form("/oauth/token", fields)).status, 400);
    assert.equal((await f.form("/oauth/token", { ...fields, resource: f.origin })).status, 400);
    assert.equal((await f.form("/oauth/token", { ...fields, resource: f.origin + (path === "/jira/mcp" ? "/outlook/mcp" : "/jira/mcp") })).status, 400);
    assert.equal((await f.form("/oauth/token", { ...fields, resource: audience })).status, 200);
    assert.equal((await f.request("/.well-known/oauth-protected-resource" + path)).status, 200);
  }
  assert.equal((await f.request("/.well-known/oauth-protected-resource")).status, 200);
  for (const path of ["/state", "/reset", "/outlook/mcp/child", "/arbitrary"]) assert.equal((await f.request("/.well-known/oauth-protected-resource" + path)).status, 404);
});

test("refresh extends expired one-hour access but never its original eight-hour grant", async (t) => {
  const f = await fixture(t, memoryStorage()), client = await f.register(), alice = await f.login(participants[0]);
  const token = await (await f.redeem(client, await f.issue(client, alice.cookie))).json(), now = Date.now();
  t.mock.method(Date, "now", () => now + 7.5 * 60 * 60 * 1000);
  await f.restart();
  assert.equal((await f.request("/outlook/mcp", bearer(token))).status, 401);
  const response = await refresh(f, client, token); assert.equal(response.status, 200);
  const rotated = await response.json(); assert.ok(rotated.expires_in <= 1800);
  t.mock.method(Date, "now", () => now + 8 * 60 * 60 * 1000 + 1000);
  assert.equal((await refresh(f, client, rotated)).status, 400);
  assert.equal((await f.request("/outlook/mcp", bearer(rotated))).status, 401);
});

test("malformed persisted credential records cannot authenticate or be silently reseeded", async (t) => {
  const storage = memoryStorage(), f = await fixture(t, storage), client = await f.register(), alice = await f.login(participants[0]);
  await f.redeem(client, await f.issue(client, alice.cookie));
  const baseline = structuredClone(storage.data.get("workshop-auth:v1"));
  const changes = [
    () => null,
    (saved) => { saved.tables.tokens[0][1].resource = f.origin; return saved; },
    (saved) => { saved.tables.tokens[0][1].participant = { id: "forged" }; return saved; },
    (saved) => { saved.tables.sessions[0][1].credentialFingerprint = "malformed"; return saved; },
    (saved) => { saved.tables.refreshes[0][1].used = "false"; return saved; },
    (saved) => { saved.tables.clients[0][1].redirect_uris = ["http://foreign.example/callback"]; return saved; },
  ];
  for (const change of changes) {
    const corrupt = memoryStorage(), saved = change(structuredClone(baseline));
    corrupt.data.set("workshop-auth:v1", saved);
    await f.restart(participants, corrupt);
    assert.equal((await f.request("/login")).status, 503);
    assert.equal(f.auth.authenticate({ headers: { cookie: alice.cookie }, url: "/who" }), null);
    assert.deepEqual(corrupt.data.get("workshop-auth:v1"), saved);
  }
});

async function unfinishedPost(t, f, path, { type = "application/x-www-form-urlencoded", chunk = "x=", length } = {}) {
  const accepted = once(f.server, "request");
  const req = httpRequest(f.origin + path, { method: "POST", agent: false, headers: { Origin: f.origin, "Content-Type": type, ...(length === undefined ? {} : { "Content-Length": length }) } });
  const response = new Promise((resolve) => {
    req.once("response", (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (part) => { text += part; });
      res.once("end", () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.once("error", () => resolve({ status: 0 }));
  });
  t.after(() => req.destroy());
  req.write(chunk); await accepted;
  await new Promise((resolve) => setImmediate(resolve));
  return { req, response };
}

test("unfinished public auth uploads cannot block another participant's API or completed sign-in", { timeout: 4000 }, async (t) => {
  const f = await fixture(t), bob = await f.login(participants[1]);
  const uploads = [];
  for (const path of ["/login", "/logout", "/oauth/authorize", "/oauth/register", "/oauth/token", "/oauth/revoke"]) uploads.push(await unfinishedPost(t, f, path, { type: path === "/oauth/register" ? "application/json" : "application/x-www-form-urlencoded", chunk: path === "/oauth/register" ? "{" : "x=" }));
  try {
    const api = await f.request("/outlook/mcp", { headers: { Cookie: bob.cookie }, signal: AbortSignal.timeout(1000) });
    assert.equal(api.status, 200); assert.equal((await api.json()).id, "bob");
    const complete = await f.request("/login", { method: "POST", headers: { Origin: f.origin, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: participants[0].token, next: "/" }), signal: AbortSignal.timeout(1000) });
    assert.equal(complete.status, 303); assert.ok(complete.headers.get("set-cookie"));
    assert.equal(f.auth.isReady(), true);
  } finally { for (const upload of uploads) upload.req.destroy(); }
});

test("auth bodies have an absolute five-second deadline even while bytes keep arriving", { timeout: 10000 }, async (t) => {
  const f = await fixture(t), start = performance.now();
  const uploads = [];
  for (const path of ["/login", "/oauth/register", "/oauth/token", "/oauth/revoke"]) uploads.push(await unfinishedPost(t, f, path, { type: path === "/oauth/register" ? "application/json" : "application/x-www-form-urlencoded", chunk: path === "/oauth/register" ? "{" : "x=" }));
  const trickle = setInterval(() => { for (const upload of uploads) if (!upload.req.destroyed) upload.req.write(" "); }, 100);
  t.after(() => clearInterval(trickle));
  try {
    const responses = await Promise.all(uploads.map((upload) => upload.response));
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 4500 && elapsed < 8000, "The deadline must not reset when more bytes arrive");
    for (const response of responses) { assert.equal(response.status, 408); assert.deepEqual(JSON.parse(response.text), { error: "request_timeout" }); assert.equal(response.headers.connection, "close"); }
    assert.equal((await f.login(participants[0])).response.status, 303);
  } finally { clearInterval(trickle); for (const upload of uploads) upload.req.destroy(); }
});

test("incomplete declared and chunked oversized bodies fail before queueing, with bounded request-local errors", { timeout: 4000 }, async (t) => {
  const f = await fixture(t);
  for (const options of [{ length: 17000, chunk: "x=" }, { chunk: "x=" + "x".repeat(17000) }, { type: "text/plain", chunk: "x=" }]) {
    const upload = await unfinishedPost(t, f, "/oauth/token", options);
    const response = await Promise.race([upload.response, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Body rejection waited for end-of-upload")), 1000); timer.unref(); })]);
    assert.equal(response.status, options.type ? 415 : 413);
    assert.deepEqual(JSON.parse(response.text), { error: "invalid_request" });
    assert.equal(response.headers.connection, "close"); upload.req.destroy();
  }
  const invalidJson = await f.request("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{invalid" });
  assert.equal(invalidJson.status, 400);
  const duplicate = await f.request("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=a&grant_type=b" });
  assert.equal(duplicate.status, 400);
  assert.equal((await f.login(participants[1])).response.status, 303);
});

test("pre-queue body failures and normal API reads cannot steal a pending auth commit response", { timeout: 4000 }, async (t) => {
  const storage = memoryStorage(), f = await fixture(t, storage), bob = await f.login(participants[1]);
  const write = storage.write; let release, entered;
  const blocked = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  storage.write = async (key, value) => { entered(); await gate; write(key, value); };
  const complete = f.form("/login", { token: participants[0].token, next: "/drive" });
  await blocked;
  try {
    const malformed = await f.request("/oauth/token", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "invalid", signal: AbortSignal.timeout(1000) });
    assert.equal(malformed.status, 415);
    const api = await f.request("/who", { headers: { Cookie: bob.cookie }, signal: AbortSignal.timeout(1000) });
    assert.equal(api.status, 200); assert.equal((await api.json()).id, "bob");
  } finally { release(); }
  const signedIn = await complete;
  assert.equal(signedIn.status, 303); assert.equal(signedIn.headers.get("location"), "/drive"); assert.ok(signedIn.headers.get("set-cookie"));
  assert.equal((await f.request("/who", { headers: { Cookie: signedIn.headers.get("set-cookie").split(";")[0] } })).status, 200);
});

// Native HTTP allows an honest navigation Fetch Metadata combination; undici
// fetch always sends Sec-Fetch-Mode: cors, even if a test sets a document dest.
const documentGet = (f, path, headers = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(f.origin + path, { headers: { Accept: "text/html", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", ...headers } }, (res) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
  });
  req.once("error", reject); req.end();
});
const join = async (f, cookie, next = "/") => {
  const response = await f.request("/login?next=" + encodeURIComponent(next), { headers: cookie ? { Cookie: cookie } : {} });
  assert.equal(response.status, 303);
  return { response, cookie: response.headers.get("set-cookie")?.split(";")[0] || cookie };
};

test("automatic browser join reuses one private guest; separate jars and assigned roster stay isolated", async (t) => {
  const storage = memoryStorage(), f = await fixture(t, storage, { automaticJoin: true });
  for (const path of ["/", "/unknown", "/outlook/mcp", "/api/state"]) {
    const response = await f.request(path);
    assert.equal(response.status, 401); assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.equal(storage.data.size, 0, "API and unknown routes do not create guests");
  const first = await join(f, null, "/jira"), second = await join(f);
  assert.match(first.response.headers.get("set-cookie"), /HttpOnly; SameSite=Lax; Max-Age=2592000/);
  assert.equal(first.response.headers.get("location"), "/jira");
  assert.equal((await join(f, first.cookie)).response.headers.get("set-cookie"), null);
  const who = (cookie) => f.request("/who", { headers: { Cookie: cookie } }).then((response) => response.json());
  const a = await who(first.cookie), b = await who(second.cookie);
  assert.match(a.id, /^guest-[a-f0-9]{24}$/); assert.equal(a.name, "Workshop guest 1"); assert.notEqual(a.id, b.id);
  assert.equal(storage.data.get("workshop-auth:v1").guests.length, 2);
  assert.equal((await f.request("/who", { headers: { Authorization: `Bearer ${participants[0].token}` } })).status, 401, "Automatic mode does not accept obsolete passwords as API credentials");
  for (const next of ["//foreign.example", "/%5cforeign.example", "https://foreign.example"]) assert.equal((await join(f, first.cookie, next)).response.headers.get("location"), "/");
  assert.equal((await f.form("/login", { token: participants[0].token })).status, 405);
  for (const key of ["token", "code", "password"]) assert.equal((await f.request(`/login?${key}=obsolete`)).status, 400);
});

test("automatic OAuth validates before joining, always requires explicit consent, and shares one guest across five resources and Den origins", async (t) => {
  const storage = memoryStorage(), f = await fixture(t, storage, { automaticJoin: true });
  const client = await f.register("https://den-one.example/callback"), other = await f.register("https://den-two.example/callback");
  const initial = f.authorization(client);
  for (const extra of [{ client_id: "unknown" }, { resource: f.origin }, { code_challenge_method: "plain" }, { code_challenge: "short" }]) {
    const response = await f.request("/oauth/authorize?" + new URLSearchParams({ ...initial.fields, ...extra }));
    assert.equal(response.status, 400); assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(storage.data.get("workshop-auth:v1").guests.length, 0);
  }
  const first = await documentGet(f, initial.path, { Referer: "https://den-one.example/" });
  assert.equal(first.status, 200); assert.equal(first.headers.get("location"), null);
  assert.match(first.headers.get("set-cookie"), /SameSite=Lax/);
  const cookie = first.headers.get("set-cookie").split(";")[0], html = await first.text();
  assert.match(html, /Private workspace/); assert.match(html, /not a verified person/); assert.match(html, /Allow workplace access/);
  assert.doesNotMatch(html, /password|account card|assigned sandbox/i);
  assert.equal(storage.data.get("workshop-auth:v1").tables.codes.length, 0, "GET cannot issue a code");
  assert.equal((await f.form("/oauth/authorize", initial.fields, { Cookie: cookie })).status, 400, "Missing allow decision is not consent");
  assert.equal((await f.form("/oauth/authorize", { ...initial.fields, decision: "allow" })).status, 401, "POST cannot mint a guest");
  const guestId = (await (await f.request("/who", { headers: { Cookie: cookie } })).json()).id;
  for (const [index, path] of ["/outlook/mcp", "/calendar/mcp", "/drive/mcp", "/jira/mcp", "/confluence/mcp"].entries()) {
    const current = index % 2 ? other : client, attempt = f.authorization(current, f.origin + path);
    const consent = await documentGet(f, attempt.path, { Cookie: cookie, Referer: new URL(current.redirectUri).origin });
    assert.equal(consent.status, 200); assert.equal(consent.headers.get("set-cookie"), null);
    const token = await (await f.redeem(current, await f.issue(current, cookie, f.origin + path))).json();
    assert.equal((await (await f.request(path, bearer(token))).json()).id, guestId);
    assert.equal((await f.request("/state", bearer(token))).status, 401);
    assert.equal((await refresh(f, current, token, { resource: f.origin })).status, 400);
  }
  assert.equal(storage.data.get("workshop-auth:v1").guests.length, 1);
});

test("automatic joins reject web fetches, foreign origins and embedded destinations without consuming guest slots", async (t) => {
  const storage = memoryStorage(), f = await fixture(t, storage, { automaticJoin: true }), client = await f.register();
  for (const path of ["/login", f.authorization(client).path]) {
    for (const headers of [{ Origin: "https://foreign.example" }, { "Sec-Fetch-Dest": "iframe" }, { "Sec-Fetch-Dest": "image" }, { "Sec-Fetch-Dest": "empty" }, { Accept: "application/json" }, { Accept: "*/*" }]) {
      const response = await f.request(path, { headers });
      assert.equal(response.status, 403); assert.equal(response.headers.get("set-cookie"), null);
    }
  }
  assert.equal(storage.data.get("workshop-auth:v1").guests.length, 0);
  const response = await documentGet(f, "/login", { Referer: "https://foreign.example/" });
  assert.equal(response.status, 303, "Real top-level cross-site navigation can join");
});

test("automatic guest registry restores across restarts; fingerprints are not bearer tokens and actual capabilities stay hashed", async (t) => {
  const storage = memoryStorage(), f = await fixture(t, storage, { automaticJoin: true });
  const session = await join(f), client = await f.register(), attempt = await f.issue(client, session.cookie);
  const token = await (await f.redeem(client, attempt)).json();
  const before = storage.data.get("workshop-auth:v1"), guest = before.guests[0];
  assert.deepEqual(Object.keys(guest).sort(), ["createdAt", "fingerprint", "id", "name"]);
  assert.match(guest.fingerprint, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await f.request("/outlook/mcp", { headers: { Authorization: `Bearer ${guest.fingerprint}` } })).status, 401);
  const saved = JSON.stringify(before);
  for (const value of [session.cookie.split("=")[1], attempt.code, token.access_token, token.refresh_token]) assert.equal(saved.includes(value), false);
  await f.restart();
  assert.equal((await join(f, session.cookie)).response.headers.get("set-cookie"), null);
  assert.equal((await (await f.request("/who", { headers: { Cookie: session.cookie } })).json()).id, guest.id);
  assert.equal((await f.request("/outlook/mcp", bearer(token))).status, 200);
  const rotated = await (await refresh(f, client, token)).json();
  await f.restart();
  assert.equal((await refresh(f, client, token)).status, 400);
  assert.equal((await f.request("/outlook/mcp", bearer(rotated))).status, 401);
  assert.equal(storage.data.get("workshop-auth:v1").guests.length, 1);
});

test("obsolete automatic capacity settings are ignored; joins have no registration cap", async (t) => {
  for (const automaticJoin of [null, 1, "true"]) assert.throws(() => createWorkshopAuth({ origin: "http://localhost", automaticJoin }), /configuration/);
  for (const automaticLimit of [0, -1, 1001, 1.5, "200", null, 2]) {
    const f = await fixture(t, memoryStorage(), { automaticJoin: true, automaticLimit });
    const first = await join(f), second = await join(f), third = await join(f);
    assert.equal((await join(f, first.cookie)).response.headers.get("set-cookie"), null);
    for (const session of [first, second, third]) assert.equal((await f.request("/who", { headers: { Cookie: session.cookie } })).status, 200);
  }
});

test("automatic sign-out leaves the browser without immediately creating a new workspace; grants survive and sessions last thirty days", async (t) => {
  const storage = memoryStorage(), f = await fixture(t, storage, { automaticJoin: true });
  const session = await join(f), client = await f.register(), token = await (await f.redeem(client, await f.issue(client, session.cookie))).json();
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 9 * 60 * 60 * 1000);
  assert.equal((await f.request("/who", { headers: { Cookie: session.cookie } })).status, 200);
  assert.equal((await refresh(f, client, token)).status, 400, "Thirty-day browser lifetime must not extend eight-hour OAuth grants");
  t.mock.method(Date, "now", () => now);
  const currentClient = await f.register();
  const active = await (await f.redeem(currentClient, await f.issue(currentClient, session.cookie))).json();
  const logout = await f.form("/logout", {}, { Cookie: session.cookie });
  assert.equal(logout.headers.get("location"), "/signed-out"); assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
  const signedOut = await f.request("/signed-out"), html = await signedOut.text();
  assert.equal(signedOut.status, 200); assert.equal(signedOut.headers.get("set-cookie"), null);
  assert.match(html, /Open a new private workspace/); assert.doesNotMatch(html, /password|account card/i);
  assert.equal((await f.request("/who", { headers: { Cookie: session.cookie } })).status, 401);
  assert.equal((await f.request("/outlook/mcp", bearer(active))).status, 200);
  assert.equal(storage.data.get("workshop-auth:v1").guests.length, 1);
  assert.notEqual((await join(f)).cookie, session.cookie);
  t.mock.method(Date, "now", () => now + 30 * 24 * 60 * 60 * 1000 + 1000);
  assert.equal((await f.request("/who", { headers: { Cookie: session.cookie } })).status, 401);
});

test("v1 assigned snapshots migrate to v2 without changing legacy identities", async (t) => {
  const storage = memoryStorage(), f = await fixture(t, storage), session = await f.login(participants[0]);
  const saved = storage.data.get("workshop-auth:v1"); saved.version = 1; delete saved.guests;
  storage.data.set("workshop-auth:v1", saved);
  await f.restart();
  assert.equal((await f.request("/who", { headers: { Cookie: session.cookie } })).status, 200);
  await f.login(participants[1]);
  assert.equal(storage.data.get("workshop-auth:v1").version, 2);
  assert.deepEqual(storage.data.get("workshop-auth:v1").guests, []);
});

test("corrupt automatic guest registries and failed guest commits fail closed without reseeding", async (t) => {
  const storage = memoryStorage(), f = await fixture(t, storage, { automaticJoin: true }), session = await join(f);
  const baseline = structuredClone(storage.data.get("workshop-auth:v1"));
  const changes = [
    (saved) => { delete saved.guests; },
    (saved) => { saved.guests.push(saved.guests[0]); },
    (saved) => { saved.guests[0].id = participants[0].id; },
    (saved) => { saved.guests[0].token = "forged"; },
    (saved) => { saved.guests[0].createdAt = "yesterday"; },
    (saved) => { saved.guests[0].fingerprint = "invalid"; },
    (saved) => { saved.guests[0].fingerprint = "x".repeat(43); },
    (saved) => { saved.guests = []; },
  ];
  for (const change of changes) {
    const corrupt = memoryStorage(), saved = structuredClone(baseline); change(saved); corrupt.data.set("workshop-auth:v1", saved);
    await f.restart(participants, corrupt);
    assert.equal((await f.request("/login")).status, 503);
    assert.equal(f.auth.authenticate({ headers: { cookie: session.cookie }, url: "/who" }), null);
    assert.deepEqual(corrupt.data.get("workshop-auth:v1"), saved);
  }
  await f.restart(participants, storage);
  storage.write = () => { throw new Error("disk unavailable"); };
  const failed = await f.request("/login");
  assert.equal(failed.status, 503); assert.equal(failed.headers.get("set-cookie"), null); assert.equal(failed.headers.get("location"), null);
});

// Exercise the auth boundary directly: thousands of guests need neither thousands
// of HTTP servers nor repeated storage clones. Snapshots contain detached records.
const authNavigation = async (auth, origin, cookie) => {
  const headers = new Map();
  const res = { setHeader(key, value) { headers.set(key.toLowerCase(), value); }, getHeader(key) { return headers.get(key.toLowerCase()); }, writeHead(status) { this.status = status; }, end() {} };
  const req = { method: "GET", url: "/login", headers: { accept: "text/html", ...(cookie ? { cookie } : {}) }, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(await auth.handle(req, res, new URL(req.url, origin)), true);
  assert.equal(res.status, 303);
  return headers.get("set-cookie")?.split(";")[0] || cookie;
};

test("1001 fresh guests from one IP join in one minute without evicting earlier sessions", async (t) => {
  const origin = "http://localhost", now = Date.now();
  t.mock.method(Date, "now", () => now);
  let saved;
  const storage = { read() { return saved; }, write(key, value) { saved = value; }, close() {} };
  const auth = createWorkshopAuth({ origin, automaticJoin: true, storage });
  t.after(() => auth.close());
  const identities = new Set(), cookies = [];
  for (let index = 0; index < 1001; index++) {
    const cookie = await authNavigation(auth, origin);
    cookies.push(cookie);
    identities.add(auth.authenticate({ headers: { cookie } }).id);
  }
  assert.equal(identities.size, 1001);
  assert.equal(saved.guests.length, 1001);
  assert.equal(saved.tables.sessions.length, 1001);
  for (const cookie of cookies) assert.ok(auth.authenticate({ headers: { cookie } }));
  assert.equal(await authNavigation(auth, origin, cookies[0]), cookies[0]);
});

test("large durable guest registries and session tables restore and admit new browsers beyond 2048 and 4096", async (t) => {
  const origin = "http://localhost", cookie = "restored-browser-secret";
  const guests = Array.from({ length: 4200 }, (_, index) => ({
    id: "guest-" + index.toString(16).padStart(24, "0"), name: `Workshop guest ${index + 1}`,
    fingerprint: createHash("sha256").update(`fingerprint-${index}`).digest("base64url"), createdAt: Date.now(),
  }));
  const sessions = guests.map((guest, index) => [createHash("sha256").update(index === 0 ? cookie : `session-${index}`).digest("base64url"), { participantId: guest.id, credentialFingerprint: guest.fingerprint, expires: Date.now() + 60000 }]);
  let saved = { version: 2, origin, guests, tables: { sessions, clients: [], codes: [], tokens: [], refreshes: [] } };
  const storage = { read() { return saved; }, write(key, value) { saved = value; }, close() {} };
  let auth = createWorkshopAuth({ origin, automaticJoin: true, storage });
  t.after(() => auth.close());
  assert.equal(auth.isReady(), true);
  const restoredCookie = "workshop_session=" + cookie;
  assert.equal(auth.authenticate({ headers: { cookie: restoredCookie } }).id, guests[0].id);
  const joinedCookie = await authNavigation(auth, origin);
  const joinedId = auth.authenticate({ headers: { cookie: joinedCookie } }).id;
  assert.equal(saved.guests.length, 4201); assert.equal(saved.tables.sessions.length, 4201);
  await auth.close();
  auth = createWorkshopAuth({ origin, automaticJoin: true, storage });
  assert.equal(auth.isReady(), true);
  assert.equal(auth.authenticate({ headers: { cookie: restoredCookie } }).id, guests[0].id);
  assert.equal(auth.authenticate({ headers: { cookie: joinedCookie } }).id, joinedId);
  assert.ok(await authNavigation(auth, origin));
  assert.equal(saved.guests.length, 4202);
});

test("automatic browser expiry is thirty days and HTTPS cookies are host-only secure", async (t) => {
  const f = await fixture(t, memoryStorage(), { automaticJoin: true }), session = await join(f), now = Date.now();
  t.mock.method(Date, "now", () => now + 29 * 24 * 60 * 60 * 1000);
  await f.restart();
  assert.equal((await f.request("/who", { headers: { Cookie: session.cookie } })).status, 200);
  t.mock.method(Date, "now", () => now + 30 * 24 * 60 * 60 * 1000 + 1000);
  assert.equal((await f.request("/who", { headers: { Cookie: session.cookie } })).status, 401);
  const auth = createWorkshopAuth({ origin: "https://workshop.example", automaticJoin: true });
  t.after(() => auth.close());
  const headers = new Map();
  const res = { setHeader(key, value) { headers.set(key.toLowerCase(), value); }, getHeader(key) { return headers.get(key.toLowerCase()); }, writeHead(status) { this.status = status; }, end() {} };
  assert.equal(await auth.handle({ method: "GET", url: "/login", headers: { accept: "text/html" } }, res, new URL("https://workshop.example/login")), true);
  assert.equal(res.status, 303);
  assert.match(headers.get("set-cookie"), /^__Host-workshop_session=.*; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/);
  assert.doesNotMatch(headers.get("set-cookie"), /Domain=/);
});

test("automatic GET guest commits serialize durably without blocking existing API traffic or pre-queue body failures", { timeout: 4000 }, async (t) => {
  const storage = memoryStorage(), f = await fixture(t, storage, { automaticJoin: true }), session = await join(f);
  const write = storage.write; let entered, release;
  const blocked = new Promise((resolve) => { entered = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  storage.write = async (key, value) => { entered(); await gate; write(key, value); };
  const creating = f.request("/login"); await blocked;
  const upload = await unfinishedPost(t, f, "/login");
  try {
    const invalid = await f.request("/oauth/token", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "bad", signal: AbortSignal.timeout(1000) });
    assert.equal(invalid.status, 415);
    const api = await f.request("/who", { headers: { Cookie: session.cookie }, signal: AbortSignal.timeout(1000) });
    assert.equal(api.status, 200);
    assert.equal(storage.data.get("workshop-auth:v1").guests.length, 1, "Uncommitted guest must not be acknowledged");
  } finally { release(); upload.req.destroy(); }
  const joined = await creating;
  assert.equal(joined.status, 303); assert.ok(joined.headers.get("set-cookie"));
  assert.equal(storage.data.get("workshop-auth:v1").guests.length, 2);
});

test("guest restore rejects valid-format roster collisions and duplicate fingerprints but ignores obsolete capacity", async (t) => {
  const storage = memoryStorage(), f = await fixture(t, storage, { automaticJoin: true }), first = await join(f);
  await join(f);
  const saved = structuredClone(storage.data.get("workshop-auth:v1"));
  await f.restart([...participants, { id: saved.guests[0].id, name: "Roster collision", token: "assigned-only" }]);
  assert.equal((await f.request("/login")).status, 503);
  assert.equal(f.auth.authenticate({ headers: { cookie: first.cookie }, url: "/who" }), null);
  const duplicate = memoryStorage(), corrupt = structuredClone(saved);
  corrupt.guests[1].fingerprint = corrupt.guests[0].fingerprint; duplicate.data.set("workshop-auth:v1", corrupt);
  await f.restart(participants, duplicate);
  assert.equal((await f.request("/login")).status, 503);
  const limited = createWorkshopAuth({ origin: f.origin, participants, storage, automaticJoin: true, automaticLimit: 1 });
  assert.equal(limited.isReady(), true);
  assert.equal(limited.authenticate({ headers: { cookie: first.cookie }, url: "/who" }).id, saved.guests[0].id);
  await limited.close();
  assert.deepEqual(storage.data.get("workshop-auth:v1"), saved);
});
