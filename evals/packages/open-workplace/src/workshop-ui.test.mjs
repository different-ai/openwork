// Standalone, dependency-free proof: two real Chrome contexts sign in through the workshop UI.
// Node 22+; CHROME_BIN selects Chrome/Chromium. Screenshots are opt-in and never include login forms.
// OPEN_WORKPLACE_SCREENSHOT_DIR=/approved/path node --test evals/packages/open-workplace/src/workshop-ui.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { access, mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function waitFor(fn, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await fn()) return; } catch { /* Navigation/startup may replace the execution context. */ }
    await delay(60);
  }
  throw new Error(message);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGTERM");
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
}

test("Alice and Bob sign in normally and keep mail, Drive and sign-out isolated in real Chrome contexts", { timeout: 120000 }, async (t) => {
  const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  try { await access(chrome); } catch { t.skip("Set CHROME_BIN to an installed Chrome/Chromium for browser verification."); return; }
  // Import at execution time: this proof does not need auth credentials in environment variables.
  const { startWorkshop } = await import("./workshop.mjs");
  const participants = process.env.OPEN_WORKPLACE_TEST_PARTICIPANTS_FILE
    ? JSON.parse(await readFile(process.env.OPEN_WORKPLACE_TEST_PARTICIPANTS_FILE, "utf8"))
    : [
      { id: "alice", name: "Alice", token: randomBytes(32).toString("base64url") },
      { id: "bob", name: "Bob", token: randomBytes(32).toString("base64url") },
    ];
  assert.equal(participants.length, 2, "Use exactly two dedicated verification accounts, not the attendee roster");
  if (process.env.OPEN_WORKPLACE_TEST_URL && !process.env.OPEN_WORKPLACE_TEST_PARTICIPANTS_FILE) throw new Error("A hosted proof requires a private test-account roster file");
  const runId = randomBytes(4).toString("hex");
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "open-workplace-workshop-browser-"));
  let workshop, browser, socket;
  const contexts = [], pending = new Map();
  t.after(async () => {
    socket?.close();
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Browser proof closed")); }
    pending.clear();
    try { if (browser) await stop(browser); }
    finally { try { await workshop?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
  });
  workshop = process.env.OPEN_WORKPLACE_TEST_URL
    ? { origin: new URL(process.env.OPEN_WORKPLACE_TEST_URL).origin, close: async () => {} }
    : await startWorkshop({ participants, port: 0 });
  const base = workshop.origin;
  browser = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${join(directory, "profile")}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let output = "";
  browser.stderr.on("data", (data) => { output += data; });
  await waitFor(() => /DevTools listening on (ws:\/\/[^\s]+)/.test(output), "Headless Chrome did not start");
  socket = new WebSocket(/DevTools listening on (ws:\/\/[^\s]+)/.exec(output)[1]);
  await once(socket, "open");
  let sequence = 0;
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome command timed out: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const context = contexts.find((entry) => entry.sessionId === message.sessionId);
    // Record no request bodies, headers, console arguments or source expressions: login secrets stay private.
    if (message.method === "Runtime.exceptionThrown" && context) context.errors.push("Uncaught browser script exception");
    if (message.method === "Network.requestWillBeSent" && context) {
      const request = message.params.request;
      if (request.method === "POST" && new URL(request.url).pathname === "/login") context.loginPosts++;
    }
    if (pending.has(message.id)) {
      const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(new Error("Chrome protocol command failed")) : entry.resolve(message.result);
    }
  });
  async function newContext() {
    const { browserContextId } = await cdp("Target.createBrowserContext");
    const { targetId } = await cdp("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
    const context = { browserContextId, sessionId, errors: [], loginPosts: 0 };
    contexts.push(context);
    const command = (method, params) => cdp(method, params, sessionId);
    const evaluate = async (expression) => {
      const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      // Never echo evaluated expressions: the login expression contains a one-time test credential.
      if (result.exceptionDetails) throw new Error("Browser evaluation failed");
      return result.result.value;
    };
    const navigate = async (path, condition) => {
      await command("Page.navigate", { url: base + path });
      await waitFor(() => evaluate(condition), `${path} did not render`);
    };
    const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const fill = (selector, value) => evaluate(`{const field=document.querySelector(${JSON.stringify(selector)});field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('input',{bubbles:true}));}`);
    const submit = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`);
    await command("Runtime.enable"); await command("Page.enable"); await command("Network.enable");
    await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    return Object.assign(context, { command, evaluate, navigate, click, fill, submit });
  }
  const alice = await newContext(), bob = await newContext();
  assert.notEqual(alice.browserContextId, bob.browserContextId, "Participants must have separate Chrome cookie jars");
  const screenshot = async (context, name) => {
    if (!process.env.OPEN_WORKPLACE_SCREENSHOT_DIR) return;
    assert.equal(await context.evaluate("location.pathname!=='/login' && !document.querySelector('[name=token]')"), true, "Never photograph a login credential");
    assert.equal(await context.evaluate(`${JSON.stringify(participants.map(({ token }) => token))}.some(secret=>document.documentElement.outerHTML.includes(secret))`), false, "Screenshots must not contain credentials");
    await mkdir(process.env.OPEN_WORKPLACE_SCREENSHOT_DIR, { recursive: true });
    const image = await context.command("Page.captureScreenshot", { format: "png" });
    await writeFile(join(process.env.OPEN_WORKPLACE_SCREENSHOT_DIR, name + ".png"), Buffer.from(image.data, "base64"));
  };
  const rest = async (participant, path, method = "GET", body) => {
    const response = await fetch(base + "/v1.0" + path, { method, headers: { authorization: `Bearer ${participant.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.ok, true, `Independent REST oracle failed (${response.status})`);
    return response.status === 204 ? null : response.json();
  };
  async function login(context, participant) {
    // Follow the unauthenticated portal redirect; no cookies, headers or storage are injected.
    await context.navigate("/", "location.pathname==='/login' && !!document.querySelector('form[action=\"/login\"] [name=token]')");
    assert.equal(await context.evaluate("!!document.querySelector('form[action=\"/login\"] [name=next]')"), true);
    await context.fill("[name=token]", participant.token);
    await context.submit('form[action="/login"]');
    try {
      await waitFor(() => context.evaluate(`location.pathname==='/' && document.querySelector('h1')?.textContent===${JSON.stringify(participant.name)}`), "Normal login form did not open the participant portal");
    } catch {
      const diagnostic = await context.evaluate("JSON.stringify({path:location.pathname,heading:document.querySelector('h1')?.textContent,text:document.body.innerText.slice(0,500)})");
      throw new Error(`Normal login did not open the portal: ${diagnostic}`);
    }
    assert.equal(context.loginPosts, 1, "Login must submit a real browser POST /login");
    assert.equal(await context.evaluate("document.cookie"), "", "Workshop session must not be readable by page scripts");
  }
  await login(alice, participants[0]);
  await login(bob, participants[1]);
  await screenshot(alice, "workshop-alice-portal");
  await screenshot(bob, "workshop-bob-portal");

  // A real browser approves OAuth; the loopback callback receives the authorization code.
  const callbacks = [];
  const callback = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
    callbacks.push(url); res.end("Workshop connector connected");
  });
  await new Promise((resolve) => callback.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { callback.close(resolve); callback.closeAllConnections(); }));
  const redirectUri = `http://127.0.0.1:${callback.address().port}/callback`;
  const registered = await fetch(base + "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Workshop browser proof", redirect_uris: [redirectUri] }) });
  assert.equal(registered.status, 201); const client = await registered.json();
  const oauthTokens = [];
  for (const [index, context] of [alice, bob].entries()) {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri, response_type: "code", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"), resource: base + "/outlook/mcp", scope: "workplace", state: `browser-${index}` });
    await context.navigate("/oauth/authorize?" + query, "!!document.querySelector('form[action=\"/oauth/authorize\"]')");
    assert.equal(callbacks.length, index, "GET must not silently grant OAuth access");
    await screenshot(context, `workshop-${index === 0 ? "alice" : "bob"}-oauth-consent`);
    await context.submit('form[action="/oauth/authorize"]');
    try { await waitFor(() => callbacks.length === index + 1, "Browser OAuth consent did not reach the loopback callback"); }
    catch { throw new Error("OAuth callback not reached: " + await context.evaluate("JSON.stringify({path:location.pathname,text:document.body.innerText.slice(0,500)})")); }
    assert.equal(callbacks[index].searchParams.get("state"), `browser-${index}`);
    const redeemed = await fetch(base + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, redirect_uri: redirectUri, code: callbacks[index].searchParams.get("code"), code_verifier: verifier, resource: base + "/outlook/mcp" }) });
    assert.equal(redeemed.status, 200); oauthTokens.push((await redeemed.json()).access_token);
  }
  assert.notEqual(oauthTokens[0], oauthTokens[1]);

  await Promise.all([alice, bob].map((context) => context.navigate("/outlook", "document.querySelectorAll('.mailrow').length>0")));
  // The witness uses exactly the same seeded message ID, not different records with coincidentally different IDs.
  const seeded = (await rest(participants[0], "/me/messages")).value;
  const sharedId = seeded.find((message) => !message.isDraft && message.parentFolderId === "inbox").id;
  assert.equal((await rest(participants[1], `/me/messages/${encodeURIComponent(sharedId)}`)).id, sharedId);
  const bobSubject = seeded.find((message) => message.id === sharedId).subject;
  await rest(participants[0], `/me/messages/${encodeURIComponent(sharedId)}`, "PATCH", { isRead: true, categories: ["Alice private category"] });
  await rest(participants[1], `/me/messages/${encodeURIComponent(sharedId)}`, "PATCH", { isRead: false, categories: ["Bob private category"] });
  const row = `.mailrow[data-id="${sharedId}"]`;
  await waitFor(() => alice.evaluate(`document.querySelector(${JSON.stringify(row)})?.classList.contains('unread')===false`), "Alice's same-ID read state did not render");
  await waitFor(() => bob.evaluate(`document.querySelector(${JSON.stringify(row)})?.classList.contains('unread')===true`), "Bob's same-ID unread state did not render");
  assert.deepEqual((await rest(participants[0], `/me/messages/${encodeURIComponent(sharedId)}`)).categories, ["Alice private category"]);
  assert.deepEqual((await rest(participants[1], `/me/messages/${encodeURIComponent(sharedId)}`)).categories, ["Bob private category"]);

  const draftSubject = `Alice-only browser workshop notes ${runId}`;
  await alice.click("#compose");
  await alice.fill("#to", "reviewer@acme.test");
  await alice.fill("#subject", draftSubject);
  await alice.fill("#body", "Created through the compose form in Alice's isolated browser.");
  await alice.submit("#composeform");
  await waitFor(async () => (await rest(participants[0], "/me/messages")).value.some((message) => message.isDraft && message.subject === draftSubject), "Alice's UI draft was not persisted");
  await waitFor(() => alice.evaluate(`document.getElementById('list').textContent.includes(${JSON.stringify(draftSubject)})`), "Alice's saved draft did not render");
  // Reload Bob after the write so absence cannot pass merely because polling has not fired yet.
  await bob.navigate("/outlook", `document.getElementById('list')?.textContent.includes(${JSON.stringify(bobSubject)})`);
  assert.equal(await bob.evaluate(`document.body.textContent.includes(${JSON.stringify(draftSubject)})`), false);
  assert.equal((await rest(participants[1], "/me/messages")).value.some((message) => message.subject === draftSubject), false);
  await screenshot(alice, "workshop-alice-private-mail");
  await screenshot(bob, "workshop-bob-private-mail");
  for (const [index, token] of oauthTokens.entries()) {
    const response = await fetch(base + "/outlook/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mail_search", arguments: { query: draftSubject } } }) });
    assert.equal(response.status, 200); const result = await response.json();
    assert.equal(result.result.isError, false);
    assert.equal(JSON.parse(result.result.content[0].text).value.some((entry) => entry.subject === draftSubject), index === 0, "Browser-granted OAuth tokens must select the correct participant's data");
    const wrongAudience = await fetch(base + "/drive/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    assert.equal(wrongAudience.status, 401);
  }

  await alice.navigate("/drive", "!!document.querySelector('#upload') && document.querySelectorAll('.filetable tbody tr').length>0");
  const uploadName = `alice-workshop-private-${runId}.txt`, contents = "Alice's private workshop upload.\n";
  const uploadPath = join(directory, uploadName); await writeFile(uploadPath, contents);
  const dom = await alice.command("DOM.getDocument");
  const input = await alice.command("DOM.querySelector", { nodeId: dom.root.nodeId, selector: "#upload" });
  await alice.command("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [uploadPath] });
  await waitFor(async () => (await rest(participants[0], "/me/drive/root/children")).value.some((file) => file.name === uploadName), "Browser upload was not persisted in Alice's Drive");
  await waitFor(() => alice.evaluate(`document.body.textContent.includes(${JSON.stringify(uploadName)})`), "Uploaded text file did not render");
  const uploaded = (await rest(participants[0], "/me/drive/root/children")).value.find((file) => file.name === uploadName);
  const bytes = await fetch(base + `/v1.0/me/drive/items/${encodeURIComponent(uploaded.id)}/content`, { headers: { authorization: `Bearer ${participants[0].token}` } });
  assert.equal(bytes.ok, true); assert.equal(await bytes.text(), contents);
  await bob.navigate("/drive", "document.querySelectorAll('.filetable tbody tr').length>0");
  assert.equal(await bob.evaluate(`document.body.textContent.includes(${JSON.stringify(uploadName)})`), false);
  assert.equal((await rest(participants[1], "/me/drive/root/children")).value.some((file) => file.name === uploadName), false);
  await screenshot(alice, "workshop-alice-drive-upload");

  for (const context of [alice, bob]) {
    await context.navigate("/jira", "document.querySelectorAll('#issue-rows tr').length>3");
    await context.navigate("/confluence", "document.querySelectorAll('.page-row').length>10");
  }
  await alice.navigate("/", `document.querySelector('h1')?.textContent===${JSON.stringify(participants[0].name)}`);
  await alice.submit('form[action="/logout"]');
  await waitFor(() => alice.evaluate("location.pathname==='/login' && !!document.querySelector('[name=token]')"), "Sign out did not return Alice to login");
  assert.equal(await alice.evaluate("fetch('/v1.0/me/messages').then(response=>response.status)"), 401, "Signed-out browser must not read mail directly");
  assert.equal(await alice.evaluate("fetch('/_workshop/state/microsoft').then(response=>response.status)"), 401, "Signed-out browser must not read private fixture state");
  await bob.navigate("/", `document.querySelector('h1')?.textContent===${JSON.stringify(participants[1].name)}`);
  const bobMail = await bob.evaluate("fetch('/v1.0/me/messages').then(async response=>({status:response.status,body:await response.json()}))");
  assert.equal(bobMail.status, 200, "Alice's sign-out must preserve Bob's cookie");
  assert.equal(bobMail.body.value.find((message) => message.id === sharedId).subject, bobSubject);
  assert.equal(bobMail.body.value.some((message) => message.subject === draftSubject), false);
  for (const context of contexts) assert.deepEqual(context.errors, [], "Workshop pages must not raise uncaught JavaScript errors");
});
