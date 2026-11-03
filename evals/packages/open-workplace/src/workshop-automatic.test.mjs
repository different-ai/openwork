import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWorkshop } from "./workshop.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("automatic browser workspaces remain private and durable after restart and idle worker eviction", { timeout: 90000 }, async (t) => {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "workshop-automatic-"));
  const options = { joinMode: "automatic", dataDir: directory, automaticLimit: 2, maxActiveParticipants: 1, idleEvictionMs: 30 };
  let workshop = await startWorkshop({ ...options, port: 0 });
  const base = workshop.origin, port = workshop.server.address().port;
  t.after(async () => { await workshop?.close(); await rm(directory, { recursive: true, force: true }); });
  async function enter(cookie) {
    const response = await fetch(base + "/login?next=%2F", { redirect: "manual", headers: { accept: "text/html", ...(cookie ? { cookie } : {}) } });
    assert.equal(response.status, 303);
    return response.headers.get("set-cookie")?.split(";")[0] || cookie;
  }
  const a = await enter(), b = await enter(); assert.notEqual(a, b);
  const own = (cookie, path, method = "GET", body) => fetch(base + path, { method, redirect: "manual", headers: { cookie, origin: base, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const portal = await own(a, "/"); assert.equal(portal.status, 200); assert.ok(!(await portal.text()).includes('type="password"'));
  assert.equal(await enter(a), a, "Returning to the entry point must keep the same workspace");
  const aMe = await (await own(a, "/v1.0/me")).json(); assert.match(aMe.mail, /^guest-[a-f0-9]{24}@acme\.test$/);
  const saved = await own(a, "/v1.0/me/drive/root:/automatic-private.txt:/content", "PUT", "Private A document"); assert.equal(saved.status, 201); const file = await saved.json();
  const large = await own(a, "/drive/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "file_write", arguments: { path: "bounded-audit.txt", content: "x".repeat(70000) } } });
  assert.equal(large.status, 200); assert.equal((await large.json()).result.isError, false);
  const audit = (await (await own(a, "/_workshop/state/microsoft")).json()).audit.at(-1);
  assert.equal(audit.input.truncated, true); assert.ok(audit.input.bytes > 65536); assert.equal(typeof audit.input.sha256, "string");
  const bMe = await (await own(b, "/v1.0/me")).json(); assert.notEqual(aMe.mail, bMe.mail);
  assert.equal((await own(b, `/download/${file.id}`)).status, 404);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await (await own(a, `/download/${file.id}`)).text(), JSON.stringify("Private A document"), "Evicting an idle worker must preserve its acknowledged file bytes");
  const third = await fetch(base + "/login", { redirect: "manual", headers: { accept: "text/html" } }); assert.equal(third.status, 303, "Legacy guest limits do not restrict joining");
  assert.equal((await own(a, "/v1.0/me")).status, 200, "Join capacity cannot evict a current browser session");
  assert.equal((await fetch(base + "/v1.0/me")).status, 401);
  assert.equal((await fetch(base + "/login", { method: "POST", headers: { origin: base, "content-type": "application/x-www-form-urlencoded" }, body: "token=unused" })).status, 405);
  await workshop.close(); workshop = undefined;
  workshop = await startWorkshop({ ...options, port });
  assert.equal((await (await own(a, "/v1.0/me")).json()).mail, aMe.mail);
  assert.equal((await (await own(b, "/v1.0/me")).json()).mail, bMe.mail);
  assert.equal((await own(b, `/download/${file.id}`)).status, 404);
  assert.equal((await own(a, `/download/${file.id}`)).status, 200);
  const reset = await own(a, "/_workshop/reset", "POST"); assert.equal(reset.status, 303);
  assert.equal((await own(a, `/download/${file.id}`)).status, 404);
  assert.equal((await (await own(b, "/v1.0/me")).json()).mail, bMe.mail);
  const logout = await fetch(base + "/logout", { method: "POST", redirect: "manual", headers: { cookie: a, origin: base, "content-type": "application/x-www-form-urlencoded" }, body: "" }); assert.equal(logout.status, 303); assert.equal(logout.headers.get("location"), "/signed-out");
  const signedOut = await fetch(base + "/signed-out", { headers: { accept: "text/html" } }); assert.equal(signedOut.status, 200); assert.equal(signedOut.headers.get("set-cookie"), null);
});

test("the standalone CLI defaults to automatic joining without any roster", { timeout: 30000 }, async (t) => {
  const child = spawn(process.execPath, [new URL("./workshop.mjs", import.meta.url).pathname], { env: { HOST: "127.0.0.1", PORT: "0" }, stdio: ["ignore", "pipe", "ignore"] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; } });
  const base = await new Promise((resolve, reject) => {
    let output = ""; const timer = setTimeout(() => reject(new Error("CLI did not start")), 10000);
    child.stdout.on("data", (chunk) => { output += chunk; const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output); if (match) { clearTimeout(timer); resolve(match[0]); } });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("CLI failed before readiness")); });
  });
  assert.equal((await (await fetch(base + "/health")).json()).joinMode, "automatic");
  const joined = await fetch(base + "/login", { redirect: "manual", headers: { accept: "text/html" } }); assert.equal(joined.status, 303);
  const cookie = joined.headers.get("set-cookie").split(";")[0];
  const html = await (await fetch(base + "/", { headers: { cookie } })).text(); assert.match(html, /Workshop guest 1/); assert.ok(!html.includes('type="password"'));
});

test("legacy worker capacity does not restrict independent in-memory participants", { timeout: 30000 }, async (t) => {
  const workshop = await startWorkshop({ joinMode: "automatic", port: 0, maxActiveParticipants: 1, idleEvictionMs: 1 }); t.after(() => workshop.close());
  const base = workshop.origin;
  const enter = async () => (await fetch(base + "/login", { redirect: "manual", headers: { accept: "text/html" } })).headers.get("set-cookie").split(";")[0];
  const cookies = [await enter(), await enter(), await enter()];
  const people = await Promise.all(cookies.map(async (cookie) => {
    const response = await fetch(base + "/v1.0/me", { headers: { cookie } }); assert.equal(response.status, 200); return response.json();
  }));
  assert.equal(new Set(people.map((person) => person.mail)).size, 3);
  assert.equal((await fetch(base + "/v1.0/me/messages/mail-blueharbor-2", { method: "PATCH", headers: { cookie: cookies[0], origin: base, "content-type": "application/json" }, body: JSON.stringify({ categories: ["retain-memory"] }) })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual((await (await fetch(base + "/v1.0/me/messages/mail-blueharbor-2", { headers: { cookie: cookies[0] } })).json()).categories, ["retain-memory"]);
  for (const cookie of cookies) assert.equal((await fetch(base + "/v1.0/me", { headers: { cookie } })).status, 200);
});
