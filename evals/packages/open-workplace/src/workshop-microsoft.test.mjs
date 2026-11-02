// node --test evals/packages/open-workplace/src/workshop-microsoft.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWorkshop } from "./workshop.mjs";
import { workshopTenantId } from "./workshop-microsoft.mjs";

const CALLBACK = "http://127.0.0.1:8790/v1/oauth-providers/microsoft-365/connect/callback";
const SCOPES = "openid profile email offline_access User.Read Mail.Read Mail.ReadWrite Calendars.Read Calendars.ReadWrite Files.Read Files.ReadWrite";

async function fixture(t) {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "workshop-microsoft-"));
  const options = { joinMode: "automatic", dataDir: directory, idleEvictionMs: 60_000 };
  let workshop = await startWorkshop({ ...options, port: 0 });
  const port = workshop.server.address().port;
  t.after(async () => { await workshop?.close(); await rm(directory, { recursive: true, force: true }); });
  const base = workshop.origin;
  const tenant = workshopTenantId(base);
  const get = (path, headers = {}) => fetch(base + path, { redirect: "manual", headers });
  const enter = async () => {
    const response = await get("/login?next=%2F", { accept: "text/html" });
    assert.equal(response.status, 303);
    return response.headers.get("set-cookie").split(";")[0];
  };
  const register = async (uris = [CALLBACK]) => {
    const response = await fetch(`${base}/_workshop/microsoft/clients`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "OpenWork", redirect_uris: uris }) });
    return { status: response.status, body: await response.json() };
  };
  const authorizePath = (client, scope = SCOPES, extra = {}) => {
    const verifier = randomBytes(32).toString("base64url");
    const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: CALLBACK, response_type: "code", scope, state: "den-state", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", ...extra });
    return { verifier, path: `/${tenant}/oauth2/v2.0/authorize?${params}` };
  };
  const approve = async (client, cookie, scope) => {
    const attempt = authorizePath(client, scope);
    const consent = await get(attempt.path, { cookie, accept: "text/html" });
    assert.equal(consent.status, 200);
    const html = await consent.text();
    assert.match(html, /Allow workplace access/);
    assert.match(html, /not a Microsoft account/);
    assert.match(html, /Connect App at 127\.0\.0\.1:8790/, "the app is named by its callback, not by what it claimed at registration");
    assert.match(consent.headers.get("content-security-policy"), /form-action 'self' http:\/\/127\.0\.0\.1:8790;/, "the browser may follow the approval back to the app");
    const request = html.match(/name="request" value="([^"]+)"/)[1];
    const allowed = await fetch(base + `/${tenant}/oauth2/v2.0/authorize`, { method: "POST", redirect: "manual", headers: { cookie, origin: base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request, decision: "allow" }) });
    assert.equal(allowed.status, 303);
    const target = new URL(allowed.headers.get("location"));
    assert.equal(target.origin + target.pathname, CALLBACK);
    assert.equal(target.searchParams.get("state"), "den-state");
    return { code: target.searchParams.get("code"), verifier: attempt.verifier };
  };
  const token = (client, fields) => fetch(base + `/${tenant}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, ...fields }) });
  const redeem = async (client, approval) => token(client, { grant_type: "authorization_code", code: approval.code, code_verifier: approval.verifier, redirect_uri: CALLBACK });
  const graph = (accessToken, path, init = {}) => fetch(base + "/v1.0" + path, { ...init, redirect: "manual", headers: { authorization: `Bearer ${accessToken}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  const restart = async () => { await workshop.close(); workshop = await startWorkshop({ ...options, port }); };
  return { base, tenant, get, enter, register, authorizePath, approve, token, redeem, graph, restart };
}

test("an app's Microsoft 365 connector reaches the same private workspace the browser sees, and only that one", { timeout: 90_000 }, async (t) => {
  const w = await fixture(t);
  assert.equal((await (await fetch(w.base + "/health")).json()).microsoftSignIn, true);
  const { status, body: client } = await w.register();
  assert.equal(status, 201);
  assert.equal(client.tenant_id, w.tenant);
  assert.equal(client.authorize_endpoint, `${w.base}/${w.tenant}/oauth2/v2.0/authorize`);
  assert.equal(client.graph_base_url, `${w.base}/v1.0`);

  const a = await w.enter(), b = await w.enter();
  const aSeen = await (await w.get("/v1.0/me", { cookie: a })).json();
  const tokens = await (await w.redeem(client, await w.approve(client, a))).json();
  assert.ok(tokens.access_token && tokens.refresh_token);
  const claims = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString());
  assert.equal(claims.email, aSeen.mail, "The connected account is the browser's own workspace mailbox");
  assert.equal(claims.tid, w.tenant);

  const me = await (await w.graph(tokens.access_token, "/me")).json();
  assert.equal(me.mail, aSeen.mail);
  // Writes through the token land in the browser's workspace, and never in another browser's.
  const saved = await w.graph(tokens.access_token, "/me/drive/root:/den-note.txt:/content", { method: "PUT", body: JSON.stringify("from Den") });
  assert.equal(saved.status, 201);
  const file = await saved.json();
  assert.equal((await w.get(`/download/${file.id}`, { cookie: a })).status, 200);
  assert.equal((await w.get(`/download/${file.id}`, { cookie: b })).status, 404);
  assert.notEqual((await (await w.get("/v1.0/me", { cookie: b })).json()).mail, me.mail);

  // Graph refuses what the token does not grant, and anything without a valid token.
  const calendarOnly = await (await w.redeem(client, await w.approve(client, b, "openid offline_access Calendars.Read"))).json();
  assert.equal((await w.graph(calendarOnly.access_token, "/me/messages")).status, 403);
  assert.equal((await w.graph(calendarOnly.access_token, "/me/events")).status, 200);
  assert.equal((await w.graph("x".repeat(43), "/me")).status, 401);

  // Rotating refresh: a used refresh token is refused and revokes its family.
  const refreshed = await (await w.token(client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token })).json();
  assert.ok(refreshed.access_token);
  assert.equal((await w.token(client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status, 400);
  assert.equal((await w.graph(refreshed.access_token, "/me")).status, 401, "Replaying a refresh token revokes the whole family");

  // Grants and clients survive a restart.
  const second = await (await w.redeem(client, await w.approve(client, a))).json();
  await w.restart();
  assert.equal((await (await w.graph(second.access_token, "/me")).json()).mail, aSeen.mail);
  assert.ok((await (await w.token(client, { grant_type: "refresh_token", refresh_token: second.refresh_token })).json()).access_token);
});

test("the sign-in refuses unregistered apps, wrong secrets, other browsers and cross-site approvals", { timeout: 60_000 }, async (t) => {
  const w = await fixture(t);
  assert.equal((await w.register(["http://evil.example/callback"])).status, 400, "Only trusted (or loopback) callbacks register");
  assert.equal((await w.register(["https://evil.example/v1/oauth-providers/microsoft-365/connect/callback"])).status, 400, "An untrusted https app cannot register a client people could be asked to approve");
  const cloud = await w.register(["https://api.openworklabs.com/v1/oauth-providers/microsoft-365/connect/callback"]);
  assert.equal(cloud.status, 201, "OpenWork Cloud's Den may register");
  const { body: client } = await w.register();
  const a = await w.enter(), b = await w.enter();

  // An unknown client or callback never redirects.
  const unknown = await w.get(w.authorizePath({ client_id: "nobody" }).path, { cookie: a, accept: "text/html" });
  assert.equal(unknown.status, 400); assert.equal(unknown.headers.get("location"), null);
  const otherCallback = await w.get(w.authorizePath(client, SCOPES, { redirect_uri: "https://elsewhere.example/cb" }).path, { cookie: a, accept: "text/html" });
  assert.equal(otherCallback.status, 400); assert.equal(otherCallback.headers.get("location"), null);
  // Without a workspace, the browser is sent to the workshop's own entry point first.
  const fresh = await w.get(w.authorizePath(client).path, { accept: "text/html" });
  assert.equal(fresh.status, 303); assert.match(fresh.headers.get("location"), /^\/login\?next=/);
  // Unsupported scopes and missing PKCE go back to the app as errors.
  const badScope = await w.get(w.authorizePath(client, "openid Sites.Read.All").path, { cookie: a });
  assert.equal(new URL(badScope.headers.get("location")).searchParams.get("error"), "invalid_scope");

  const consent = await (await w.get(w.authorizePath(client).path, { cookie: a, accept: "text/html" })).text();
  const request = consent.match(/name="request" value="([^"]+)"/)[1];
  const post = (cookie, origin) => fetch(w.base + `/${w.tenant}/oauth2/v2.0/authorize`, { method: "POST", redirect: "manual", headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request, decision: "allow" }) });
  assert.equal((await post(a, "https://evil.example")).status, 403, "A cross-site form cannot approve");
  assert.equal((await post(b, w.base)).status, 403, "Another browser cannot approve someone else's request");
  assert.equal((await post(a, w.base)).status, 400, "A refused attempt uses up the request");

  const approval = await w.approve(client, a);
  assert.equal((await w.token({ ...client, client_secret: "wrong-secret-wrong-secret" }, { grant_type: "authorization_code", code: approval.code, code_verifier: approval.verifier, redirect_uri: CALLBACK })).status, 401);
  assert.equal((await w.redeem(client, { ...approval, verifier: randomBytes(32).toString("base64url") })).status, 400);
  assert.equal((await w.redeem(client, approval)).status, 400, "A failed redemption consumes the code");
  const denied = await (async () => {
    const page = await (await w.get(w.authorizePath(client).path, { cookie: a, accept: "text/html" })).text();
    const id = page.match(/name="request" value="([^"]+)"/)[1];
    return fetch(w.base + `/${w.tenant}/oauth2/v2.0/authorize`, { method: "POST", redirect: "manual", headers: { cookie: a, origin: w.base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request: id, decision: "deny" }) });
  })();
  assert.equal(new URL(denied.headers.get("location")).searchParams.get("error"), "access_denied");
});
