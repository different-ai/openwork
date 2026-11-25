#!/usr/bin/env node
// Read-only landing-page proof. No sales form is submitted.
// node scripts/check-sovereign-ai-browser.mjs --base-url http://localhost:3418 --cdp http://127.0.0.1:9348 --screenshots /absolute/path
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const option = key => process.argv[process.argv.indexOf(key) + 1];
for (const key of ["--base-url", "--cdp", "--screenshots"]) assert.ok(process.argv.includes(key) && option(key), `Required: ${key}`);
const base = option("--base-url");
const output = option("--screenshots");
await mkdir(output, { recursive: true });
const target = await (await fetch(`${option("--cdp")}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
const errors = [];
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timeout);
    pending.delete(message.id);
    if (message.error) request.reject(message.error); else request.resolve(message.result);
  }
  if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const requestId = ++id;
  const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
  pending.set(requestId, { resolve, reject, timeout });
  ws.send(JSON.stringify({ id: requestId, method, params }));
});
async function read(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }).catch(error => { throw new Error(`${error.message}: ${expression}`, { cause: error }); });
  assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function waitFor(expression) {
  await read(`new Promise((resolve, reject) => { const end = Date.now() + 15000; const check = () => { if (${expression}) resolve(true); else if (Date.now() > end) reject(new Error('UI state timed out')); else requestAnimationFrame(check); }; check(); })`);
}
async function key(key, code, windowsVirtualKeyCode) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode, ...(key === "Enter" ? { text: "\r" } : {}) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
}
async function click(selector) {
  const point = await read(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:'center',behavior:'instant'}); const r = el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  assert.ok(point, `Missing control ${selector}`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
}
async function shot(name, selector) {
  await read(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); window.scrollTo({top:el.getBoundingClientRect().top+scrollY-120,behavior:'instant'}); })()`);
  await read("document.fonts.ready");
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(output, `${name}.png`), Buffer.from(data, "base64"));
}
const percent = () => read('Number(document.querySelector("#pieces [aria-live=polite] span").textContent.replace("%", ""))');
try {
  await send("Target.activateTarget", { targetId: target.id });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const response = await fetch(`${base}/sovereign-ai`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /canonical[^>]*sovereign-ai/);
  assert.match(html, /FAQPage/);
  const sitemap = await (await fetch(`${base}/sitemap.xml`)).text();
  assert.match(sitemap, /\/sovereign-ai/);
  for (const width of [1440, 1000, 768, 390, 320]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 768 });
    await send("Page.navigate", { url: `${base}/sovereign-ai` });
    await waitFor('document.querySelector("#pieces input[value=self]")?.checked && document.querySelector("#pieces input[value=eu]")?.checked');
    await waitFor('document.readyState === "complete"');
    // The HTML arrives before the Next.js client bundle; let hydration attach native handlers.
    await read('new Promise(resolve => setTimeout(resolve, 1500))');
    assert.equal(await read('document.querySelectorAll("h1").length'), 1);
    assert.equal(await read("document.documentElement.scrollWidth <= innerWidth"), true, `No horizontal overflow at ${width}px`);
    assert.deepEqual(await read(`Array.from(document.querySelectorAll('main a[href^="#"]')).filter(a => !document.getElementById(a.hash.slice(1))).map(a => a.hash)`), []);
    const original = await percent();
    assert.ok(original > 0 && original < 100);
    if (width === 1440) await shot("default-desktop", "#pieces");
    if (width === 1000) await shot("default-narrow", "#pieces [aria-live]");
    if (width === 390) await shot("default-mobile", "#pieces [aria-live]");
    // Click the native label first; this also exercises React's hydration event replay.
    await click('#pieces label:has(input[value="cloud"])');
    await waitFor('document.querySelector("#pieces input[value=cloud]").checked');
    await waitFor(`Number(document.querySelector('#pieces [aria-live=polite] span').textContent.replace('%','')) < ${original}`);
    const cloud = await percent();
    if (width === 1440) await shot("cloud-desktop", "#pieces [aria-live]");
    await key("ArrowRight", "ArrowRight", 39);
    await waitFor('document.querySelector("#pieces input[value=self]").checked');
    await waitFor(`Number(document.querySelector('#pieces [aria-live=polite] span').textContent.replace('%','')) === ${original}`);
    await click("#last button");
    await waitFor('document.querySelector("#pieces input[value=own]").checked');
    const best = await percent();
    assert.ok(best >= original && best < 100);
    assert.equal(await read('document.querySelectorAll("#last > ul > li").length'), 10, "No setup hides the vendor gaps");
    assert.equal(await read('document.querySelector("#last h3").textContent'), `The last ${100 - best}%.`);
    assert.equal(await read(`document.querySelector('#last a[href="/enterprise#book"]').textContent`), `Talk to sales about the last ${100 - best}%`);
    assert.equal(await read(`document.querySelector('#last a[href="/enterprise#book"]').getAttribute("href")`), "/enterprise#book");
    if (width === 1440) {
      await shot("best-desktop", "#pieces [aria-live]");
      await send("Emulation.setDeviceMetricsOverride", { width, height: 1400, deviceScaleFactor: 1, mobile: false });
      await shot("remaining-gaps", "#last");
    }
    await read('document.querySelector("main summary").focus()');
    await key("Enter", "Enter", 13);
    await waitFor('document.querySelector("main details").open');
    await key("Enter", "Enter", 13);
    await waitFor('!document.querySelector("main details").open');
    console.log(`PASS ${width}px: layout, anchors, keyboard radios, setup gain, ${cloud}% Cloud / ${original}% default / ${best}% best, ten gaps, sales CTA, keyboard FAQ`);
  }
  assert.deepEqual(errors, [], "No browser runtime exceptions");
  await writeFile(join(output, "result.json"), JSON.stringify({ route: "/sovereign-ai", widths: [1440, 1000, 768, 390, 320], errors }, null, 2));
} catch (error) {
  console.error("Browser diagnostics", errors, await read('({ready:document.readyState, text:document.querySelector("#pieces [aria-live]")?.textContent, selected:Array.from(document.querySelectorAll("#pieces input:checked")).map(el=>el.value)})'));
  await shot("failure", "#pieces");
  throw error;
} finally {
  await send("Page.close");
  ws.close();
}
