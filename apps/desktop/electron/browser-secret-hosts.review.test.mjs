// Defensive review regressions. These assert the safe outcome against real hidden Electron windows.
// A made-up value is inspected only in memory; receipts contain booleans, never request contents.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import electron from "electron";

const SCRATCH = path.join(tmpdir(), "openwork-review-hosts");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture() {
  const { app, BrowserWindow } = electron;
  const { createBrowserSecrets } = await import("../../../packages/computer-use/browser-secrets.mjs");
  const { createSecretInterception } = await import("./browser-secret-interception.mjs");
  app.setPath("userData", process.env.OPENWORK_REVIEW_PROFILE);
  app.on("window-all-closed", () => {});
  await app.whenReady();
  const value = "fake-review-password-123456";
  let deliverRedirect;
  let firstArrived;
  let receivedForbidden = false;
  let forbiddenArrived = false;
  let firstHadValue = false;
  const initial = new Promise((resolve) => { firstArrived = resolve; });
  const forbidden = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    forbiddenArrived = true;
    receivedForbidden ||= Buffer.concat(chunks).includes(value);
    response.writeHead(200, { "Access-Control-Allow-Origin": "*" });
    response.end("done");
  });
  forbidden.listen(0, "127.0.0.1");
  await once(forbidden, "listening");
  const other = `http://127.0.0.1:${forbidden.address().port}`;
  const allowed = createServer(async (request, response) => {
    if (request.url === "/") { response.end('<!doctype html><form method="POST" action="/slow" enctype="text/plain"><input id="field" name="password"></form>'); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    firstHadValue = Buffer.concat(chunks).includes(value);
    deliverRedirect = () => { response.writeHead(307, { Location: `${other}/collect`, "Access-Control-Allow-Origin": "*" }); response.end(); };
    firstArrived();
  });
  allowed.listen(0, "127.0.0.1");
  await once(allowed, "listening");
  const origin = `http://127.0.0.1:${allowed.address().port}`;
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const secrets = createBrowserSecrets({ allowLoopbackHttp: true, placeholderTtlMs: 250 });
  const host = createSecretInterception({ secrets, armGraceMs: 1 });
  const tab = { tabId: "review-tab", view: { webContents: window.webContents } };
  let armed = false;
  try {
    await window.loadURL(origin);
    const mode = process.argv.at(-1);
    const secret = secrets.add({ sessionId: "review-chat", label: "Test sign-in", kind: "password", origins: [origin], value });
    armed = mode === "control" || await host.arm(tab);
    const { placeholder } = mode === "control" ? { placeholder: value } : secrets.issue({ sessionId: "review-chat", secretRef: secret.secretRef, tabId: tab.tabId, origin, ref: "field" });
    await window.webContents.executeJavaScript(`document.getElementById('field').value = ${JSON.stringify(placeholder)}; document.querySelector('form').submit(); undefined`);
    await Promise.race([initial, sleep(4000)]);
    if (mode === "remove") secrets.remove("review-chat", secret.secretRef);
    if (mode === "detach") window.webContents.debugger.detach();
    // Expiry/removal releases interception. A lost debugger revokes the same store entries.
    for (let i = 0; i < 100 && host.holds(tab); i++) await sleep(10);
    deliverRedirect?.();
    await sleep(500);
    process.stdout.write(`${JSON.stringify({ review: true, armed, firstHadValue, forbiddenArrived, receivedForbidden })}\n`);
  } finally {
    await host.dispose();
    window.destroy();
    for (const server of [allowed, forbidden]) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    app.quit();
  }
}

if (process.versions.electron) {
  fixture().catch(() => { process.stdout.write('{"review":true,"fixtureFailed":true}\n'); electron.app.exit(1); });
} else {
  test("only the page's own session is intercepted: no frame or worker target is attached or answered", async () => {
    const { createSecretInterception } = await import("./browser-secret-interception.mjs");
    const calls = [];
    const cdp = Object.assign(new EventEmitter(), {
      isAttached: () => true,
      async sendCommand(method, _params, sessionId) { calls.push({ method, sessionId }); return {}; },
    });
    const contents = Object.assign(new EventEmitter(), { debugger: cdp, isDestroyed: () => false, isCrashed: () => false });
    const secrets = { guarded: () => false, onGuardChange: () => () => {}, interceptionLost() {} };
    const host = createSecretInterception({ secrets });
    const tab = { tabId: "review-owner", view: { webContents: contents } };
    const paused = (requestId) => ({ requestId, request: { url: "https://example.test/", method: "GET", headers: {} } });
    try {
      assert.equal(await host.arm(tab), true);
      // Someone else sharing the debugger may have such targets attached and paused.
      for (const type of ["iframe", "service_worker", "shared_worker", "worker"]) {
        cdp.emit("message", {}, "Target.attachedToTarget", { sessionId: type, targetInfo: { type }, waitingForDebugger: true });
        cdp.emit("message", {}, "Fetch.requestPaused", paused(`in-${type}`), type);
      }
      cdp.emit("message", {}, "Fetch.requestPaused", paused("in-page"), "");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await host.release(tab);
      assert.deepEqual(calls.filter(({ method }) => method.startsWith("Target.")), [], "no Target command is ever sent");
      assert.deepEqual(calls.filter(({ sessionId }) => sessionId !== undefined), [], "no command is ever sent to a child session");
      // One answer: the page's own request. Nothing paused in another session is decided here.
      assert.deepEqual(calls.map(({ method }) => method), ["Fetch.enable", "Fetch.continueRequest", "Fetch.disable"]);
    } finally { await host.dispose(); }
  });

  for (const mode of ["control", "expire", "remove", "detach"]) {
    test(`a rewritten POST cannot escape its allow-list after ${mode}`, { timeout: 15_000 }, async (t) => {
      await mkdir(SCRATCH, { recursive: true });
      const profile = await mkdtemp(path.join(SCRATCH, "profile-"));
      t.after(() => rm(profile, { recursive: true, force: true }));
      const env = { ...process.env, OPENWORK_REVIEW_PROFILE: profile };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(electron, [fileURLToPath(import.meta.url), mode], { env, stdio: ["ignore", "pipe", "ignore"] });
      t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
      let output = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
      await once(child, "close");
      const line = output.split("\n").find((entry) => entry.startsWith('{"review":'));
      assert.ok(line, "the hidden-window fixture returned its fixed-shape receipt");
      const receipt = JSON.parse(line);
      assert.equal(receipt.fixtureFailed, undefined, "fixture completed");
      assert.equal(receipt.armed, true, "interception armed");
      assert.equal(receipt.firstHadValue, true, "the allowed first hop received the rewritten body");
      t.diagnostic(`redirect destination reached: ${receipt.forbiddenArrived === true}`);
      assert.equal(receipt.receivedForbidden, mode === "control", mode === "control"
        ? "the unprotected control must prove that a native 307 really repeats the POST body"
        : "the disallowed redirect destination must never receive the value");
    });
  }
}
