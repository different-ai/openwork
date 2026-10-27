import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWorkshop } from "./workshop.mjs";

const participants = ["alice", "bob"].map((id) => ({ id, name: `${id} workshop`, token: randomBytes(32).toString("base64url") }));

test("hosted origins require TLS, while local loopback development still works", async () => {
  for (const options of [
    { origin: "http://workshop.example.com" },
    { origin: "http://127.0.0.1", host: "0.0.0.0" },
    { origin: "http://[2001:db8::1]" },
    { host: "0.0.0.0" },
  ]) await assert.rejects(startWorkshop({ participants, port: 0, ...options }), /HTTPS|PUBLIC_URL/);
  for (const origin of ["http://localhost", "http://127.0.0.1", "http://[::1]"]) {
    const workshop = await startWorkshop({ participants, origin, port: 0 }); await workshop.close();
  }
});

test("business data, browser sessions, connector registration and OAuth tokens survive gateway restart", { timeout: 90000 }, async (t) => {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "workshop-gateway-restart-"));
  let workshop = await startWorkshop({ participants, dataDir: directory, port: 0 });
  const port = workshop.server.address().port, base = workshop.origin;
  t.after(async () => { await workshop?.close(); await rm(directory, { recursive: true, force: true }); });
  const call = (person, path, method = "GET", body) => fetch(base + path, { method, redirect: "manual", headers: { authorization: `Bearer ${person.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const form = (path, body, cookie) => fetch(base + path, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: base, ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(body) });
  const health = await (await fetch(base + "/health")).json(); assert.equal(health.storage, "sqlite");
  const login = await form("/login", { token: participants[0].token, next: "/" }); assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const registration = await fetch(base + "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Restart proof", redirect_uris: ["http://127.0.0.1:54321/callback"] }) });
  assert.equal(registration.status, 201); const client = await registration.json();
  const verifier = randomBytes(32).toString("base64url"), resource = base + "/drive/mcp";
  const fields = { client_id: client.client_id, redirect_uri: "http://127.0.0.1:54321/callback", response_type: "code", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"), resource, scope: "workplace", state: "restart-proof" };
  const granted = await form("/oauth/authorize", fields, cookie); assert.equal(granted.status, 303);
  const code = new URL(granted.headers.get("location")).searchParams.get("code");
  const exchanged = await form("/oauth/token", { grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: fields.redirect_uri, code_verifier: verifier, resource });
  assert.equal(exchanged.status, 200); const tokens = await exchanged.json(); assert.ok(tokens.refresh_token);
  const stored = await call(participants[0], "/v1.0/me/drive/root:/restart-proof.json:/content", "PUT", { owner: "alice", retained: true }); assert.equal(stored.status, 201); const file = await stored.json();
  const b = await call(participants[1], "/v1.0/me/messages/mail-blueharbor-2", "PATCH", { categories: ["Bob persistent marker"] }); assert.equal(b.status, 200);
  await workshop.close(); workshop = undefined;
  workshop = await startWorkshop({ participants, dataDir: directory, port });
  const browser = await fetch(base + "/v1.0/me", { headers: { cookie } }); assert.equal(browser.status, 200); assert.equal((await browser.json()).mail, "alice@acme.test");
  assert.deepEqual(await (await call(participants[0], `/download/${file.id}`)).json(), { owner: "alice", retained: true });
  assert.equal((await call(participants[1], `/download/${file.id}`)).status, 404);
  const rpc = (token) => fetch(resource, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "file_find", arguments: { query: "restart-proof" } } }) });
  const previousToken = await rpc(tokens.access_token); assert.equal(previousToken.status, 200); assert.ok((await previousToken.text()).includes("restart-proof.json"));
  const refreshed = await form("/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id, resource }); assert.equal(refreshed.status, 200); const next = await refreshed.json();
  assert.equal((await rpc(next.access_token)).status, 200);
  assert.equal((await form("/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id, resource })).status, 400);
  assert.equal((await call(participants[0], "/_workshop/reset", "POST")).status, 303);
  assert.equal((await call(participants[0], `/download/${file.id}`)).status, 404);
  assert.deepEqual((await (await call(participants[1], "/v1.0/me/messages/mail-blueharbor-2")).json()).categories, ["Bob persistent marker"]);
});
