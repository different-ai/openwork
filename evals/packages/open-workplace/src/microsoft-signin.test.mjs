// The sign-in front door: a real authorization-code + PKCE flow, then Graph calls that reach only the signed-in
// person's own Open Workplace backend, within the approved scopes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createMicrosoftSignIn, requiredScopes, signInConfig } from "./microsoft-signin.mjs";

const TENANT = "11111111-2222-4333-8444-555555555555";
const REDIRECT = "http://127.0.0.1:9/v1/oauth-providers/microsoft-365/connect/callback";
const CLIENT = { id: "open-workplace-test-client", secret: "test-client-secret-0123456789" };
const SCOPES = "openid profile email offline_access User.Read Mail.Read Calendars.ReadWrite Files.Read";

async function backend(t, person) {
  const child = fork(new URL("./microsoft365.mjs", import.meta.url), [], {
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: "0", OPEN_WORKPLACE_PERSON: person, OPEN_WORKPLACE_NOW: "2026-10-16T16:00:00Z" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } });
  const [message] = await once(child, "message");
  return `http://127.0.0.1:${message.port}`;
}

async function start(t) {
  const alex = await backend(t, "Alex Chen|alex|CEO");
  const casey = await backend(t, "Casey Park|casey|Operations lead");
  const signIn = createMicrosoftSignIn({
    tenantId: TENANT, clientId: CLIENT.id, clientSecret: CLIENT.secret, redirectUris: [REDIRECT],
    people: [{ handle: "alex", name: "Alex Chen", email: "alex@acme.test", graph: alex }, { handle: "casey", name: "Casey Park", email: "casey@acme.test", graph: casey }],
  });
  const server = createServer((request, response) => { void signIn.handle(request, response); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  signIn.setOrigin(origin);
  return { origin, signIn, alex, casey };
}

const pkce = () => { const verifier = randomBytes(32).toString("base64url"); return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }; };

async function authorize(origin, { scope = SCOPES, challenge, redirect = REDIRECT, client = CLIENT.id } = {}) {
  const url = new URL(`${origin}/${TENANT}/oauth2/v2.0/authorize`);
  for (const [key, value] of Object.entries({ client_id: client, redirect_uri: redirect, response_type: "code", scope, state: "state-123", code_challenge: challenge, code_challenge_method: "S256" })) if (value) url.searchParams.set(key, value);
  return fetch(url, { redirect: "manual" });
}

async function consent(origin, page, person, decision = "allow") {
  const request = (await page.text()).match(/name="request" value="([^"]+)"/)?.[1];
  assert.ok(request, "the consent page carries its request");
  return fetch(`${origin}/${TENANT}/oauth2/v2.0/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request, person, decision }) });
}

async function token(origin, fields) {
  const response = await fetch(`${origin}/${TENANT}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: CLIENT.id, client_secret: CLIENT.secret, ...fields }) });
  return { status: response.status, body: await response.json() };
}

async function signIn(origin, person, scope) {
  const { verifier, challenge } = pkce();
  const page = await authorize(origin, { challenge, scope });
  assert.equal(page.status, 200);
  const approved = await consent(origin, page, person);
  assert.equal(approved.status, 302);
  const back = new URL(approved.headers.get("location"));
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
  assert.equal(back.searchParams.get("state"), "state-123");
  const exchanged = await token(origin, { grant_type: "authorization_code", code: back.searchParams.get("code"), redirect_uri: REDIRECT, code_verifier: verifier });
  assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
  return { ...exchanged.body, code: back.searchParams.get("code"), verifier };
}

const graph = (origin, accessToken, path, init = {}) => fetch(`${origin}/v1.0${path}`, { ...init, headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", ...init.headers } });

test("configuration refuses anything an operator must fix", () => {
  const base = { tenantId: TENANT, clientId: "c", clientSecret: "0123456789abcdef", redirectUris: [REDIRECT], people: [{ handle: "alex", name: "Alex", email: "alex@acme.test", graph: "http://127.0.0.1:1" }] };
  assert.doesNotThrow(() => signInConfig(base));
  assert.throws(() => signInConfig({ ...base, tenantId: "common" }), /GUID/);
  assert.throws(() => signInConfig({ ...base, clientSecret: "short" }), /16/);
  assert.throws(() => signInConfig({ ...base, redirectUris: [] }), /redirect/);
  assert.throws(() => signInConfig({ ...base, people: [...base.people, base.people[0]] }), /unique/);
  assert.throws(() => signInConfig({ ...base, people: [{ ...base.people[0], graph: "http://127.0.0.1:1/v1.0" }] }), /origin/);
});

test("Graph permissions follow Microsoft's delegated scopes and refuse unknown paths", () => {
  assert.deepEqual(requiredScopes("GET", "/me/calendarView"), ["Calendars.Read", "Calendars.ReadWrite"]);
  assert.deepEqual(requiredScopes("PATCH", "/me/events/abc"), ["Calendars.ReadWrite"]);
  assert.deepEqual(requiredScopes("POST", "/me/messages/abc/send"), ["Mail.Send"]);
  assert.deepEqual(requiredScopes("POST", "/me/messages"), ["Mail.ReadWrite"]);
  assert.ok(requiredScopes("POST", "/search/query").includes("Files.Read"));
  assert.deepEqual(requiredScopes("PUT", "/me/drive/root:/a.txt:/content"), ["Files.ReadWrite", "Files.ReadWrite.All"]);
  assert.deepEqual(requiredScopes("GET", "/users"), ["(none)"]);
});

test("a person signs in with PKCE and reaches only their own calendar", async (t) => {
  const { origin } = await start(t);
  const casey = await signIn(origin, "casey");
  const alex = await signIn(origin, "alex");
  assert.equal(casey.token_type, "Bearer");
  assert.match(casey.scope, /Calendars\.ReadWrite/);
  const claims = JSON.parse(Buffer.from(casey.id_token.split(".")[1], "base64url").toString());
  assert.equal(claims.email, "casey@acme.test");
  assert.equal(claims.tid, TENANT);

  const me = await (await graph(origin, casey.access_token, "/me")).json();
  assert.equal(me.mail, "casey@acme.test");
  const created = await graph(origin, casey.access_token, "/me/events", { method: "POST", body: JSON.stringify({ subject: "Casey only: supplier call", start: { dateTime: "2026-10-20T17:00:00", timeZone: "UTC" }, end: { dateTime: "2026-10-20T17:30:00", timeZone: "UTC" } }) });
  assert.equal(created.status, 201);
  const event = await created.json();

  const caseyEvents = await (await graph(origin, casey.access_token, "/me/events")).json();
  assert.ok(caseyEvents.value.some((entry) => entry.id === event.id));
  const alexEvents = await (await graph(origin, alex.access_token, "/me/events")).json();
  assert.ok(!alexEvents.value.some((entry) => entry.subject === "Casey only: supplier call"), "another person's event never appears");
  assert.equal((await graph(origin, alex.access_token, `/me/events/${event.id}`)).status, 404, "and cannot be read by ID");

  const moved = await graph(origin, casey.access_token, `/me/events/${event.id}`, { method: "PATCH", body: JSON.stringify({ start: { dateTime: "2026-10-21T17:00:00", timeZone: "UTC" }, end: { dateTime: "2026-10-21T17:30:00", timeZone: "UTC" } }) });
  assert.equal(moved.status, 200);
  assert.match((await moved.json()).start.dateTime, /^2026-10-21T17:00/);
});

test("scopes the person did not approve are refused", async (t) => {
  const { origin } = await start(t);
  const reader = await signIn(origin, "alex", "openid offline_access User.Read Calendars.Read");
  assert.equal((await graph(origin, reader.access_token, "/me/calendarView")).status, 200);
  const events = await (await graph(origin, reader.access_token, "/me/events")).json();
  const denied = await graph(origin, reader.access_token, `/me/events/${events.value[0].id}`, { method: "PATCH", body: JSON.stringify({ subject: "changed" }) });
  assert.equal(denied.status, 403);
  assert.equal((await graph(origin, reader.access_token, "/me/messages")).status, 403);
  assert.equal((await graph(origin, reader.access_token, "/me/drive/root/children")).status, 403);
  assert.equal((await graph(origin, reader.access_token, "/users")).status, 403);
  assert.equal((await graph(origin, "not-a-real-token-but-long-enough", "/me")).status, 401);
});

test("codes are single use, bound to PKCE and the redirect, and refresh tokens rotate", async (t) => {
  const { origin } = await start(t);
  const first = await signIn(origin, "alex");
  const replay = await token(origin, { grant_type: "authorization_code", code: first.code, redirect_uri: REDIRECT, code_verifier: first.verifier });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error, "invalid_grant");

  const { challenge } = pkce();
  const page = await authorize(origin, { challenge });
  const back = new URL((await consent(origin, page, "alex")).headers.get("location"));
  const wrongVerifier = await token(origin, { grant_type: "authorization_code", code: back.searchParams.get("code"), redirect_uri: REDIRECT, code_verifier: pkce().verifier });
  assert.equal(wrongVerifier.body.error, "invalid_grant");

  const badClient = await fetch(`${origin}/${TENANT}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: CLIENT.id, client_secret: "wrong-secret-0123456789", grant_type: "refresh_token", refresh_token: first.refresh_token }) });
  assert.equal(badClient.status, 401);

  const refreshed = await token(origin, { grant_type: "refresh_token", refresh_token: first.refresh_token });
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.body.refresh_token, first.refresh_token);
  assert.equal((await graph(origin, refreshed.body.access_token, "/me")).status, 200);
  const reused = await token(origin, { grant_type: "refresh_token", refresh_token: first.refresh_token });
  assert.equal(reused.body.error, "invalid_grant");
});

test("unregistered apps get no redirect; declining and missing PKCE return errors to the app", async (t) => {
  const { origin } = await start(t);
  const { challenge } = pkce();
  const elsewhere = await authorize(origin, { challenge, redirect: "https://attacker.example/callback" });
  assert.equal(elsewhere.status, 400);
  assert.equal(elsewhere.headers.get("location"), null);
  assert.equal((await authorize(origin, { challenge, client: "someone-else" })).status, 400);

  const noPkce = await authorize(origin, {});
  assert.equal(new URL(noPkce.headers.get("location")).searchParams.get("error"), "invalid_request");
  const unknownScope = await authorize(origin, { challenge, scope: "openid Directory.ReadWrite.All" });
  assert.equal(new URL(unknownScope.headers.get("location")).searchParams.get("error"), "invalid_scope");

  const page = await authorize(origin, { challenge });
  const html = await page.clone().text();
  assert.match(html, /Fictional sandbox sign-in/);
  assert.match(html, /Casey Park/);
  const declined = await consent(origin, page, "alex", "deny");
  const location = new URL(declined.headers.get("location"));
  assert.equal(location.searchParams.get("error"), "access_denied");
  assert.equal(location.searchParams.get("code"), null);
});
