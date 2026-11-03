import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { startWorkshop, validateParticipants } from "./workshop.mjs";

const participants = ["alice", "bob"].map((id) => ({ id, name: `${id[0].toUpperCase()}${id.slice(1)} Example`, token: randomBytes(32).toString("base64url") }));
const [alice, bob] = participants;

test("roster fails closed instead of sharing identities", () => {
  assert.throws(() => validateParticipants([]));
  assert.throws(() => validateParticipants([alice, { ...bob, id: alice.id }]));
  assert.throws(() => validateParticipants([alice, { ...bob, token: alice.token }]));
  assert.throws(() => validateParticipants([{ ...alice, token: "short" }]));
  assert.throws(() => validateParticipants([{ ...alice, name: "Bad|Persona" }]));
  assert.equal(validateParticipants(participants).length, 2);
});

test("ten participants can write concurrently without sharing state", { timeout: 90000 }, async (t) => {
  const roster = Array.from({ length: 10 }, (_, i) => ({ id: `attendee-${i}`, name: `Attendee ${i}`, token: randomBytes(32).toString("base64url") }));
  const workshop = await startWorkshop({ participants: roster, port: 0 }); t.after(() => workshop.close());
  await Promise.all(roster.map(async (person) => {
    const headers = { authorization: `Bearer ${person.token}`, "content-type": "application/json" };
    const changed = await fetch(workshop.origin + "/v1.0/me/messages/mail-blueharbor-2", { method: "PATCH", headers, body: JSON.stringify({ categories: [person.id] }) }); assert.equal(changed.status, 200);
    const own = await (await fetch(workshop.origin + "/v1.0/me/messages/mail-blueharbor-2", { headers })).json(); assert.deepEqual(own.categories, [person.id]);
    const file = await fetch(workshop.origin + "/v1.0/me/drive/root:/exercise.txt:/content", { method: "PUT", headers, body: JSON.stringify({ owner: person.id }) }); assert.equal(file.status, 201);
    const metadata = await file.json();
    const bytes = await (await fetch(workshop.origin + `/download/${metadata.id}`, { headers })).json(); assert.deepEqual(bytes, { owner: person.id });
  }));
});

test("participants have separate REST, MCP, UI, uploads, downloads, calendar, Jira, Confluence and reset state", { timeout: 90000 }, async (t) => {
  const workshop = await startWorkshop({ participants, port: 0 });
  t.after(() => workshop.close());
  const base = workshop.origin;
  const request = (person, path, method = "GET", body, extra = {}) => fetch(base + path, { method, redirect: "manual", headers: { ...(person ? { authorization: `Bearer ${person.token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = async (person, path, method, body) => { const r = await request(person, path, method, body); assert.ok(r.ok, `${method || "GET"} ${path}: ${r.status} ${await r.clone().text()}`); return [202, 204].includes(r.status) ? null : r.json(); };
  let rpcId = 0, resetUpload;
  const rpc = async (person, endpoint, method, params) => { const result = await json(person, endpoint, "POST", { jsonrpc: "2.0", id: ++rpcId, method, params }); assert.ok(!result.error, JSON.stringify(result)); return result.result; };
  const tool = async (person, endpoint, name, args) => { const result = await rpc(person, endpoint, "tools/call", { name, arguments: args }); assert.ok(!result.isError, JSON.stringify(result)); return JSON.parse(result.content[0].text); };

  await t.test("no anonymous, fixed-token, query-selected or cross-origin access", async () => {
    for (const path of ["/outlook", "/drive", "/calendar", "/jira", "/confluence", "/download/file-guess", "/preview/file-guess", "/_workshop/state/microsoft", "/_workshop/state/atlassian", "/v1.0/me/messages", "/jira/rest/api/2/search", "/outlook/mcp", "/jira/mcp"]) assert.equal((await request(null, path)).status, 401, path);
    assert.equal((await request({ token: "open-workplace-token" }, "/v1.0/me")).status, 401);
    assert.equal((await request(null, `/?participant=alice&token=${alice.token}`)).status, 401);
    assert.equal((await request(alice, "/v1.0/me/messages", "GET", undefined, { origin: "https://attacker.example" })).status, 403);
    assert.equal((await request(alice, "/reset", "POST", {})).status, 404);
    const challenge = await request(null, "/outlook/mcp", "POST", {});
    assert.match(challenge.headers.get("www-authenticate"), /oauth-protected-resource\/outlook\/mcp/);
  });

  await t.test("concurrent startup and same IDs never select another participant", async () => {
    const [a, b] = await Promise.all([json(alice, "/v1.0/me"), json(bob, "/v1.0/me")]);
    assert.equal(a.mail, "alice@acme.test"); assert.equal(b.mail, "bob@acme.test");
    await Promise.all([json(alice, "/v1.0/me/messages/mail-blueharbor-2", "PATCH", { categories: ["Alice private mail"] }), json(bob, "/v1.0/me/messages/mail-blueharbor-2", "PATCH", { categories: ["Bob private mail"] })]);
    assert.deepEqual((await json(alice, "/v1.0/me/messages/mail-blueharbor-2?participant=bob")).categories, ["Alice private mail"]);
    assert.deepEqual((await json(bob, "/v1.0/me/messages/mail-blueharbor-2")).categories, ["Bob private mail"]);
    await json(alice, "/v1.0/me/messages", "POST", { subject: "Alice private mail" });
    await Promise.all([json(alice, "/v1.0/me/drive/root:/same-name.txt:/content", "PUT", "Alice document"), json(bob, "/v1.0/me/drive/root:/same-name.txt:/content", "PUT", "Bob document")]);
    const [af, bf] = await Promise.all([json(alice, "/v1.0/me/drive/root/children"), json(bob, "/v1.0/me/drive/root/children")]);
    const aFile = af.value.find((f) => f.name === "same-name.txt"), bFile = bf.value.find((f) => f.name === "same-name.txt");
    assert.match(await (await request(alice, `/download/${aFile.id}`)).text(), /Alice document/);
    assert.match(await (await request(bob, `/download/${bFile.id}`)).text(), /Bob document/);
    assert.equal((await request(bob, `/download/${aFile.id}`)).status, 404);
    assert.equal((await request(bob, `/preview/${aFile.id}`)).status, 404);
  });

  await t.test("separate calendar mutations and MCP state", async () => {
    const event = { subject: "Alice only meeting", start: { dateTime: "2026-10-21T09:00:00", timeZone: "America/Los_Angeles" }, end: { dateTime: "2026-10-21T09:30:00", timeZone: "America/Los_Angeles" } };
    const saved = await json(alice, "/v1.0/me/events", "POST", event);
    assert.equal((await request(bob, `/v1.0/me/events/${saved.id}`)).status, 404);
    const a = await rpc(alice, "/outlook/mcp", "tools/list", {});
    assert.ok(a.tools.some((entry) => entry.name === "mail_search"));
    const b = await tool(bob, "/outlook/mcp", "mail_search", { query: "Alice private mail" });
    assert.ok(!JSON.stringify(b).includes("Alice private mail"));
    const own = await tool(alice, "/outlook/mcp", "mail_search", { query: "Alice private mail" });
    assert.ok(JSON.stringify(own).includes("Alice private mail"));
  });

  await t.test("upload capabilities are bounded to a participant, PUT-only and single use", async () => {
    const pending = await json(alice, "/v1.0/me/drive/root:/private-upload.txt:/createUploadSession", "POST", {});
    assert.ok(pending.uploadUrl.startsWith(base + "/_workshop/uploads/"));
    assert.equal((await fetch(pending.uploadUrl, { headers: { authorization: `Bearer ${bob.token}` } })).status, 405);
    assert.equal((await fetch(pending.uploadUrl, { method: "PUT", headers: { authorization: `Bearer ${bob.token}` }, body: "wrong" })).status, 403);
    const uploaded = await fetch(pending.uploadUrl, { method: "PUT", body: "Alice upload capability" }); assert.equal(uploaded.status, 201);
    const file = await uploaded.json();
    assert.equal((await request(bob, `/download/${file.id}`)).status, 404);
    assert.equal((await fetch(pending.uploadUrl, { method: "PUT", body: "replay" })).status, 404);
    assert.equal((await request(alice, "/upload/00000000-0000-4000-8000-000000000001", "PUT", {})).status, 404);
    const viaMcp = await tool(alice, "/drive/mcp", "file_create_upload_session", { path: "mcp-upload.txt" });
    assert.ok(viaMcp.uploadUrl.startsWith(base + "/_workshop/uploads/"));
    const mcpUploaded = await fetch(viaMcp.uploadUrl, { method: "PUT", body: "via MCP" }); assert.equal(mcpUploaded.status, 201);
    const aliasMcp = await tool(alice, "/drive/mcp?alias=1", "file_create_upload_session", { path: "alias-mcp.txt" });
    assert.ok(aliasMcp.uploadUrl.startsWith(base + "/_workshop/uploads/"));
    assert.equal((await fetch(aliasMcp.uploadUrl, { method: "PUT", body: "MCP alias" })).status, 201);
    const aliasRest = await json(alice, "/v1.0/me/drive/root:/alias-rest.txt:/%63reateUploadSession", "POST", {});
    assert.ok(aliasRest.uploadUrl.startsWith(base + "/_workshop/uploads/"));
    assert.equal((await fetch(aliasRest.uploadUrl, { method: "PUT", body: "REST alias" })).status, 201);
  });

  await t.test("Jira issues, Confluence pages and audits are not shared", async () => {
    const aState = await json(alice, "/_workshop/state/atlassian");
    const issue = Object.values(aState.jira.issues)[0];
    const issueKey = issue.key;
    assert.ok(issueKey, JSON.stringify(aState).slice(0, 200));
    await json(alice, `/jira/rest/api/2/issue/${issueKey}`, "PUT", { fields: { summary: "Alice private issue" } });
    assert.equal((await json(alice, `/jira/rest/api/2/issue/${issueKey}`)).fields.summary, "Alice private issue");
    assert.notEqual((await json(bob, `/jira/rest/api/2/issue/${issueKey}`)).fields.summary, "Alice private issue");
    const content = await json(alice, "/confluence/rest/api/content?expand=version,body.storage");
    const original = content.results[0];
    await json(alice, `/confluence/rest/api/content/${original.id}`, "PUT", { id: original.id, type: "page", title: "Alice private page", version: { number: original.version.number + 1 }, body: { storage: { value: "<p>Alice notes</p>", representation: "storage" } } });
    assert.notEqual((await json(bob, `/confluence/rest/api/content/${original.id}`)).title, "Alice private page");
    const tools = await rpc(bob, "/confluence/mcp", "tools/list", {}); assert.ok(tools.tools.some((entry) => entry.name === "confluence_search"));
    const bState = await json(bob, "/_workshop/state/microsoft");
    assert.ok(!bState.messages.some((entry) => entry.subject === "Alice private mail"));
    assert.ok(!bState.audit.some((entry) => entry.name === "file_create_upload_session"));
  });

  await t.test("browser sessions use the same isolation, invalid bearer cannot fall back", async () => {
    const login = await request(null, "/login", "POST", undefined, { origin: base, "content-type": "application/x-www-form-urlencoded" });
    assert.notEqual(login.status, 500);
    const response = await fetch(base + "/login", { method: "POST", redirect: "manual", headers: { origin: base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: alice.token, next: "/" }) });
    assert.equal(response.status, 303, await response.clone().text());
    const cookie = response.headers.get("set-cookie").split(";")[0];
    const read = await request(null, "/v1.0/me/messages/mail-blueharbor-2", "GET", undefined, { cookie }); assert.deepEqual((await read.json()).categories, ["Alice private mail"]);
    assert.equal((await request({ token: "invalid" }, "/v1.0/me", "GET", undefined, { cookie })).status, 401);
    assert.equal((await request(null, "/v1.0/me/messages/mail-blueharbor-2", "PATCH", { subject: "csrf" }, { cookie })).status, 403);
    const html = await (await request(null, "/outlook", "GET", undefined, { cookie })).text();
    assert.ok(html.includes('const TOKEN=""')); assert.ok(!html.includes(alice.token));
    assert.equal((await request(null, "/v1.0/me/messages/mail-blueharbor-2", "PATCH", { isRead: true }, { cookie, origin: base })).status, 200);
  });

  await t.test("JSON document bytes are preserved and demo uploads have no pending-count quota", async () => {
    const document = { link: `${base}/upload/00000000-0000-4000-8000-000000000001`, note: "keep exact bytes" };
    const file = await json(alice, "/v1.0/me/drive/root:/literal-links.json:/content", "PUT", document);
    const download = await request(alice, `/download/${file.id}`);
    assert.equal(await download.text(), JSON.stringify(document));
    for (let i = 0; i < 64; i++) resetUpload = await json(alice, `/v1.0/me/drive/root:/pending-${i}.txt:/createUploadSession`, "POST", {});
    assert.equal((await request(alice, "/v1.0/me/drive/root:/over-quota.txt:/createUploadSession", "POST", {})).status, 200);
    assert.equal((await request(alice, "/v1.0/me/drive/root:/encoded-quota.txt:/%63reateUploadSession", "POST", {})).status, 200);
    const mcpUpload = await request(alice, "/drive/mcp?alias=1", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "file_create_upload_session", arguments: { path: "alias-quota.txt" } } });
    assert.equal(mcpUpload.status, 200);
    const mcpResult = await mcpUpload.json();
    assert.notEqual(mcpResult.result?.isError, true);
    assert.ok(JSON.parse(mcpResult.result.content[0].text).uploadUrl.startsWith(base + "/_workshop/uploads/"));
    const b = await json(bob, "/v1.0/me/drive/root:/bob-independent.txt:/createUploadSession", "POST", {});
    assert.ok(b.uploadUrl.startsWith(base + "/_workshop/uploads/"));
    assert.equal(await (await request(alice, `/download/${file.id}`)).text(), JSON.stringify(document));
  });

  await t.test("reset removes only Alice's state and upload capabilities", async () => {
    const pending = resetUpload;
    assert.equal((await request(alice, "/_workshop/reset", "POST")).status, 303);
    assert.deepEqual((await json(alice, "/v1.0/me/messages/mail-blueharbor-2")).categories, []);
    assert.deepEqual((await json(bob, "/v1.0/me/messages/mail-blueharbor-2")).categories, ["Bob private mail"]);
    assert.equal((await fetch(pending.uploadUrl, { method: "PUT", body: "late" })).status, 404);
    assert.equal((await request(alice, "/state")).status, 404);
  });
});
