#!/usr/bin/env node
// Drive a dedicated target in an already running headless Chrome. Never submits the sales form.
// node scripts/check-governance-browser.mjs --base-url http://localhost:3027 --cdp http://127.0.0.1:9327 --screenshots /absolute/output/path [--axe /path/to/axe.min.js]
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
const option = key => args[args.indexOf(key) + 1];
for (const key of ["--base-url", "--cdp", "--screenshots"]) assert.ok(args.includes(key) && option(key), `Required: ${key}`);
const base = option("--base-url");
const output = option("--screenshots");
await mkdir(output, { recursive: true });
const target = await (await fetch(`${option("--cdp")}/json/new?about:blank`, {method: "PUT"})).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
const events = new Map();
const errors = [];
ws.onmessage = ({data}) => {
  const message = JSON.parse(data);
  if (message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) request.reject(message.error); else request.resolve(message.result);
  } else {
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
    if (message.method === "Log.entryAdded" && message.params.entry.level === "error") errors.push(message.params.entry.text);
    if (message.method === "Network.responseReceived" && message.params.response.status >= 400) errors.push(`${message.params.response.status} ${message.params.response.url}`);
    if (message.method === "Network.loadingFailed" && !message.params.canceled) errors.push(message.params.errorText);
    events.get(message.method)?.(message.params);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const requestId = ++id;
  const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
  pending.set(requestId, {resolve, reject, timeout});
  ws.send(JSON.stringify({id: requestId, method, params}));
});
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true});
  assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function navigate(path) {
  let timer;
  const loaded = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Navigation timed out: ${path}`)), 30000);
    events.set("Page.loadEventFired", resolve);
  });
  await send("Page.navigate", {url: `${base}${path}`});
  try { await loaded; } finally { clearTimeout(timer); }
  await evaluate("document.fonts.ready.then(() => true)");
}
async function shot(name, full = false) {
  const metrics = await send("Page.getLayoutMetrics");
  const {data} = await send("Page.captureScreenshot", {format: "png", ...(full ? {captureBeyondViewport: true, clip: {x: 0, y: 0, width: metrics.cssContentSize.width, height: metrics.cssContentSize.height, scale: 1}} : {})});
  await writeFile(join(output, `${name}.png`), Buffer.from(data, "base64"));
}
async function enter() {
  await send("Input.dispatchKeyEvent", {type: "keyDown", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13});
  await send("Input.dispatchKeyEvent", {type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13});
}
try {
  for (const domain of ["Page", "Runtime", "Log", "Network"]) await send(`${domain}.enable`);
  await send("Emulation.setFocusEmulationEnabled", {enabled: true});
  for (const width of [1440, 768, 390, 320]) {
    await send("Emulation.setDeviceMetricsOverride", {width, height: width > 768 ? 1000 : 844, deviceScaleFactor: 1, mobile: width < 768});
    for (const path of ["/enterprise", "/shadow-ai", "/ai-governance"]) {
      await navigate(path);
      assert.equal(await evaluate('document.querySelectorAll("h1").length'), 1);
      assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, `${path} overflows at ${width}px`);
      assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('main a[href^="#"]')).filter(a => !document.getElementById(a.hash.slice(1))).map(a => a.hash)`), [], "all section anchors exist");
      if (args.includes("--axe") && (width === 1440 || width === 390)) {
        await evaluate(await readFile(option("--axe"), "utf8"));
        const violations = await evaluate(`axe.run(document.querySelector('main'), {runOnly: {type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa']}}).then(result => result.violations.map(({id, impact, nodes}) => ({id, impact, targets: nodes.map(node => node.target)})))`);
        assert.deepEqual(violations, [], `${path} accessibility at ${width}px`);
      }
      if (width === 1440 || width === 390) {
        const name = `${path.slice(1)}-${width}`;
        await shot(name);
        await shot(`${name}-full`, true);
      }
      await evaluate('document.querySelector("summary").focus()');
      assert.equal(await evaluate('document.activeElement.tagName'), "SUMMARY");
      assert.notEqual(await evaluate('getComputedStyle(document.activeElement).outlineStyle'), "none");
      await enter();
      assert.equal(await evaluate('document.querySelector("details").open'), true, "FAQ opens by keyboard");
      await enter();
      assert.equal(await evaluate('document.querySelector("details").open'), false, "FAQ closes by keyboard");
      if (path === "/enterprise") {
        assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#book input:not([name="website"]), #book textarea')).filter(input => !input.labels.length).map(input => input.name)`), [], "sales fields have associated labels");
        assert.equal(await evaluate('document.querySelector("#book form").checkValidity()'), false, "empty form cannot be submitted");
      }
      console.log(`PASS ${path} at ${width}px: layout, anchors, focus, keyboard FAQ${path === "/enterprise" ? ", form labels and validation" : ""}`);
    }
  }
  // Intercept before exercising form states: no message reaches the sales endpoint.
  await navigate("/enterprise");
  let contactRequests = 0;
  events.set("Fetch.requestPaused", async ({requestId}) => {
    contactRequests++;
    await send("Fetch.fulfillRequest", {requestId, responseCode: contactRequests === 1 ? 503 : 200, responseHeaders: [{name: "Content-Type", value: "application/json"}], body: Buffer.from(JSON.stringify(contactRequests === 1 ? {message: "Test response: please retry."} : {ok: true})).toString("base64")});
  });
  await send("Fetch.enable", {patterns: [{urlPattern: `${base}/api/enterprise-contact`, requestStage: "Request"}]});
  const waitFor = async expression => evaluate(`new Promise((resolve, reject) => { const end = Date.now() + 5000; const check = () => { if (${expression}) resolve(true); else if (Date.now() > end) reject(new Error('UI state timed out')); else requestAnimationFrame(check); }; check(); })`);
  await waitFor('!document.querySelector("#book button[type=submit]").disabled');
  for (const [name, value] of Object.entries({fullName: 'Example Tester', companyEmail: 'tester@example.com', message: 'Local intercepted browser check'})) {
    await evaluate(`document.querySelector('[name="${name}"]').focus()`);
    await send('Input.insertText', {text: value});
  }
  assert.equal(await evaluate('document.querySelector("#book form").checkValidity()'), true, 'filled contact form is valid');
  await evaluate('document.querySelector("#book button[type=submit]").click()');
  await waitFor('document.querySelector("#book [role=alert]").textContent.includes("Test response")');
  await shot("enterprise-contact-mocked-error");
  assert.equal(await evaluate('document.querySelector("#book input[name=companyEmail]").value'), 'tester@example.com', 'failed send preserves input');
  await evaluate('document.querySelector("#book button[type=submit]").click()');
  await waitFor('document.querySelector("#book [role=status]").textContent.includes("Message sent")');
  await shot("enterprise-contact-mocked-success");
  assert.equal(contactRequests, 2, 'both submissions intercepted locally');
  await evaluate('document.querySelector("#book button").click()');
  assert.equal(await evaluate('document.querySelector("#book input[name=companyEmail]").value'), '', 'send another message resets form');
  await send("Fetch.disable");
  console.log("PASS locally intercepted contact error, preserved draft, success, live regions, and reset; no sales message sent");
  await send("Emulation.setEmulatedMedia", {features: [{name: "prefers-reduced-motion", value: "reduce"}]});
  await navigate("/shadow-ai");
  assert.equal(await evaluate('getComputedStyle(document.documentElement).scrollBehavior'), "auto");
  assert.equal(await evaluate('getComputedStyle(document.querySelector("summary span")).transitionProperty'), "none");
  await evaluate(`document.querySelector('button[aria-label="Open navigation menu"]').focus()`);
  await enter();
  assert.equal(await evaluate(`document.querySelector('button[aria-label="Close navigation menu"]').getAttribute('aria-expanded')`), "true");
  await enter();
  assert.ok(await evaluate(`Boolean(document.querySelector('button[aria-label="Open navigation menu"]'))`));
  console.log("PASS reduced motion and keyboard mobile navigation");
  // The intentionally mocked contact 503 is not a real failed page request.
  const unexpectedErrors = errors.filter(error => !error.startsWith(`503 ${base}/api/enterprise-contact`) && !error.includes('the server responded with a status of 503'));
  assert.deepEqual(unexpectedErrors, [], "no unexpected browser exceptions, console errors, or failed requests");
  await writeFile(join(output, "browser-result.json"), JSON.stringify({pages: ["/enterprise", "/shadow-ai", "/ai-governance"], widths: [1440, 768, 390, 320], contactResponses: 'locally intercepted 503 then 200; no message sent', axe: args.includes('--axe'), errors: unexpectedErrors}, null, 2));
} finally {
  await send("Page.close");
  ws.close();
}
