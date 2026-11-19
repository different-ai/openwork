import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { startWorkshop, validateParticipants } from "./workshop.mjs";

const secret = () => randomBytes(32).toString("base64url");
const confirmation = { confirm: "RESET ALL SAMPLE DATA" };

async function fixture(t, durable = true, enabled = true) {
  const directory = durable ? await mkdtemp(join(process.env.TMPDIR || tmpdir(), "workshop-reset-")) : undefined;
  const resetToken = secret();
  const options = { joinMode: "automatic", dataDir: directory, ...(enabled ? { resetToken } : {}) };
  let workshop = await startWorkshop({ ...options, port: 0 });
  const base = workshop.origin, port = workshop.server.address().port;
  t.after(async () => { await workshop?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
  const enter = async () => {
    const response = await fetch(base + "/login", { redirect: "manual", headers: { accept: "text/html" } });
    assert.equal(response.status, 303); return response.headers.get("set-cookie").split(";")[0];
  };
  const own = (cookie, path, method = "GET", body) => fetch(base + path, { method, redirect: "manual", headers: { cookie, origin: base, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = async (...args) => { const response = await own(...args); assert.ok(response.ok, `${args[1]}: ${response.status} ${await response.clone().text()}`); return response.status === 204 ? null : response.json(); };
  const reset = (body = confirmation, headers = {}, path = "/_workshop/reset-all", method = "POST") => fetch(base + path, { method, redirect: "manual", headers: { authorization: `Bearer ${resetToken}`, "content-type": "application/json", ...headers }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
  const restart = async () => { await workshop.close(); workshop = undefined; workshop = await startWorkshop({ ...options, port }); };
  return { directory, base, resetToken, enter, own, json, reset, restart };
}

async function oauth(f, cookie) {
  const form = (path, fields, browser) => fetch(f.base + path, { method: "POST", redirect: "manual", headers: { origin: f.base, "content-type": "application/x-www-form-urlencoded", ...(browser ? { cookie: browser } : {}) }, body: new URLSearchParams(fields) });
  const registered = await fetch(f.base + "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Reset proof", redirect_uris: ["http://127.0.0.1:54321/callback"] }) });
  assert.equal(registered.status, 201); const client = await registered.json();
  const verifier = secret(), resource = f.base + "/drive/mcp";
  const fields = { client_id: client.client_id, redirect_uri: "http://127.0.0.1:54321/callback", response_type: "code", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"), resource, scope: "workplace", state: "reset-proof", decision: "allow" };
  const grant = await form("/oauth/authorize", fields, cookie); assert.equal(grant.status, 303);
  const code = new URL(grant.headers.get("location")).searchParams.get("code");
  const exchanged = await form("/oauth/token", { grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: fields.redirect_uri, code_verifier: verifier, resource });
  assert.equal(exchanged.status, 200); const tokens = await exchanged.json();
  return {
    access: tokens.access_token,
    check: async () => {
      const response = await fetch(resource, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
      assert.equal(response.status, 200); assert.ok((await response.json()).result.tools.length);
    },
    refresh: async () => {
      const response = await form("/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id, resource });
      assert.equal(response.status, 200);
    },
  };
}

async function changeAll(f, cookie, marker) {
  await f.json(cookie, "/v1.0/me/messages/mail-blueharbor-2", "PATCH", { categories: [marker] });
  await f.json(cookie, "/v1.0/me/events", "POST", { subject: marker, start: { dateTime: "2026-10-21T09:00:00", timeZone: "UTC" }, end: { dateTime: "2026-10-21T10:00:00", timeZone: "UTC" } });
  const file = await f.json(cookie, `/v1.0/me/drive/root:/${marker}.txt:/content`, "PUT", marker);
  const state = await f.json(cookie, "/_workshop/state/atlassian");
  const issue = Object.values(state.jira.issues)[0];
  await f.json(cookie, `/jira/rest/api/2/issue/${issue.key}`, "PUT", { fields: { summary: marker } });
  const pages = await f.json(cookie, "/confluence/rest/api/content?expand=version,body.storage");
  const page = pages.results[0];
  await f.json(cookie, `/confluence/rest/api/content/${page.id}`, "PUT", { id: page.id, type: "page", title: marker, version: { number: page.version.number + 1 }, body: { storage: { value: `<p>${marker}</p>`, representation: "storage" } } });
  // Exercise tool audit and outstanding capability state as well as ordinary REST writes.
  await f.json(cookie, "/drive/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "file_write", arguments: { path: `${marker}-tool.txt`, content: marker } } });
  const upload = await f.json(cookie, `/v1.0/me/drive/root:/${marker}-upload.txt:/createUploadSession`, "POST", {});
  return { file, upload };
}

const state = async (f, cookie) => [await f.json(cookie, "/_workshop/state/microsoft"), await f.json(cookie, "/_workshop/state/atlassian")];

test("personal reset restores all five services, preserves other people and OAuth across restart", { timeout: 90000 }, async (t) => {
  const f = await fixture(t), a = await f.enter(), b = await f.enter();
  const identity = await f.json(a, "/v1.0/me"), baseline = await state(f, a);
  const connector = await oauth(f, a);
  const changed = await changeAll(f, a, "personal-reset-marker");
  await changeAll(f, b, "other-person-marker"); const other = await state(f, b);
  const confirmationPage = await f.own(a, "/_workshop/reset"); assert.equal(confirmationPage.status, 200);
  assert.notDeepEqual(await state(f, a), baseline, "GET confirmation is not a mutation");
  assert.equal((await f.own(a, "/_workshop/reset", "POST")).status, 303);
  assert.deepEqual(await state(f, a), baseline);
  assert.deepEqual(await state(f, b), other);
  assert.equal((await fetch(changed.upload.uploadUrl, { method: "PUT", body: "late" })).status, 404);
  await connector.check();
  await f.restart();
  assert.equal((await f.json(a, "/v1.0/me")).mail, identity.mail);
  // A tools/list call is non-mutating, including the snapshot audit.
  assert.deepEqual(await state(f, a), baseline);
  assert.deepEqual(await state(f, b), other);
  await connector.check(); await connector.refresh();
});

for (const durable of [true, false]) test(`operator reset clears all business data and uploads (${durable ? "durable" : "memory"})`, { timeout: 90000 }, async (t) => {
  const f = await fixture(t, durable), a = await f.enter(), b = await f.enter();
  const baselines = [await state(f, a), await state(f, b)];
  const connector = await oauth(f, a);
  const changes = [await changeAll(f, a, "all-reset-a"), await changeAll(f, b, "all-reset-b")];
  if (durable) await writeFile(join(f.directory, "operator-note.txt"), "not participant data");
  const response = await f.reset(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, reset: "all-sample-data", workersStopped: 2 });
  if (durable) {
    assert.deepEqual(await readdir(join(f.directory, "participants")), []);
    assert.equal(await readFile(join(f.directory, "operator-note.txt"), "utf8"), "not participant data");
  }
  for (const changed of changes) assert.equal((await fetch(changed.upload.uploadUrl, { method: "PUT", body: "late" })).status, 404);
  assert.deepEqual(await state(f, a), baselines[0]); assert.deepEqual(await state(f, b), baselines[1]);
  await connector.check();
  if (durable) {
    await f.restart();
    assert.deepEqual(await state(f, a), baselines[0]); assert.deepEqual(await state(f, b), baselines[1]);
    await connector.check(); await connector.refresh();
  }
  assert.equal((await f.reset()).status, 200, "Repeated explicit resets are safe");
});

test("operator endpoint fails closed without exposing credentials or changing data", { timeout: 60000 }, async (t) => {
  const f = await fixture(t), a = await f.enter();
  const connector = await oauth(f, a);
  await f.json(a, "/v1.0/me/messages/mail-blueharbor-2", "PATCH", { categories: ["must-survive"] });
  const before = await state(f, a);
  assert.equal((await f.reset(confirmation, {}, undefined, "GET")).status, 405);
  for (const headers of [{ authorization: "" }, { authorization: `Bearer ${secret()}` }, { authorization: `Bearer ${connector.access}` }, { authorization: "", cookie: a }]) assert.equal((await f.reset(confirmation, headers)).status, 403);
  assert.equal((await f.reset(confirmation, { origin: "https://attacker.example" })).status, 403);
  assert.equal((await f.reset(confirmation, { "content-type": "text/plain" })).status, 400);
  assert.equal((await f.reset({}, {}, `/_workshop/reset-all?token=${f.resetToken}`)).status, 400);
  for (const body of [{}, { confirm: "RESET" }, { ...confirmation, extra: true }, null, []]) assert.equal((await f.reset(body)).status, 400);
  assert.equal((await f.reset({ confirm: "x".repeat(2000) })).status, 413);
  const home = await (await f.own(a, "/")).text(); assert.ok(!home.includes("reset-all")); assert.ok(!home.includes(f.resetToken));
  assert.deepEqual(await state(f, a), before);
  const disabled = await fixture(t, false, false);
  assert.equal((await disabled.reset()).status, 404);
  assert.equal((await disabled.reset(confirmation, {}, undefined, "GET")).status, 404);
  for (const resetToken of ["short", "a".repeat(32)]) await assert.rejects(startWorkshop({ joinMode: "automatic", port: 0, resetToken }), /random operator reset secret/);
});

test("in-flight writes prevent whole reset without partial deletion", { timeout: 60000 }, async (t) => {
  const f = await fixture(t), a = await f.enter();
  await f.json(a, "/v1.0/me/messages/mail-blueharbor-2", "PATCH", { categories: ["busy-marker"] });
  const before = await state(f, a);
  const pending = request(f.base + "/v1.0/me/drive/root:/inflight.txt:/content", { method: "PUT", headers: { cookie: a, origin: f.base, "content-type": "text/plain", "content-length": "4" } });
  pending.on("error", () => {}); pending.flushHeaders(); pending.write("a");
  t.after(() => pending.destroy());
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await f.reset()).status, 409);
  assert.deepEqual(await state(f, a), before);
  const finished = new Promise((resolve) => pending.on("response", (response) => { response.resume(); response.on("end", resolve); }));
  pending.end("bcd"); await finished;
  assert.equal((await f.reset()).status, 200);
  assert.deepEqual((await f.json(a, "/v1.0/me/messages/mail-blueharbor-2")).categories, []);
});

test("assigned rosters do not impose an arbitrary hundred-person ceiling", () => {
  assert.equal(validateParticipants(Array.from({ length: 101 }, (_, index) => ({ id: `person-${index}`, name: `Person ${index}`, token: secret() }))).length, 101);
});
