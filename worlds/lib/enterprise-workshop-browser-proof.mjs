#!/usr/bin/env node
// Workplace-domain read-only proof of an owned workshop. Fixture sign-in/model preference sync only; no new model turn.
// DEMO_SCREENSHOT_DIR=evals/results/workshop node worlds/lib/enterprise-workshop-browser-proof.mjs <private-receipt.json> <session-id> [marker]
// Equivalent flags: --session <id> --marker <marker>. Node 22+ and Google Chrome required.
import assert from "node:assert/strict";
import { verifyWorkshop } from "./workshop-verification.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

let stage = "arguments";
const fail = (message) => { throw new Error(message); };
async function waitFor(predicate, label, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { if (await predicate()) return; } catch { /* Only browser render/startup waits; never world readiness polling. */ }
    await delay(100);
  }
  fail(label);
}
function ownedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.hash || url.search) fail("Expected owned loopback URL without credentials/query.");
  return url;
}
async function json(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000), redirect: "error" });
  if (!response.ok) fail(`Read returned HTTP ${response.status}; private body omitted.`);
  return response.json();
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || !args.length) {
    console.log("DEMO_SCREENSHOT_DIR=<private artifact directory> node worlds/lib/enterprise-workshop-browser-proof.mjs <private-receipt.json> <session-id> [marker]\nFlags: --session <id> (required) --marker <marker>. Reads an already-ready world once; never starts or polls a world.");
    return;
  }
  const receiptPath = args.shift();
  let sessionId, marker;
  while (args.length) {
    const argument = args.shift();
    if (argument === "--session") sessionId = args.shift();
    else if (argument === "--marker") marker = args.shift();
    else if (argument.startsWith("--")) fail("Unknown argument.");
    else if (argument.startsWith("ses_") && !sessionId) sessionId = argument;
    else if (!marker) marker = argument;
    else fail("Too many arguments.");
  }
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  if (!process.env.DEMO_SCREENSHOT_DIR) fail("Set DEMO_SCREENSHOT_DIR to a private artifact directory (evals/results is allowed).");
  const screenshots = resolve(process.env.DEMO_SCREENSHOT_DIR);
  const inside = relative(repo, screenshots);
  if ((!inside.startsWith("..") && !isAbsolute(inside)) && inside !== "evals/results" && !inside.startsWith("evals/results/")) fail("Screenshots must be outside the source tree or under evals/results.");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const out = receipt.outputs;
  if (!out || typeof out.openworkToken !== "string" || !out.openworkToken || typeof out.workspaceId !== "string") fail("Private world receipt lacks runtime credentials/workspace.");
  for (const key of ["webUrl", "openworkUrl", "denApi", "denWeb", "jira", "confluence", "outlook", "oneDrive", "atlassianState", "microsoftState"]) ownedUrl(out[key]);
  assert.equal(new URL(out.jira).origin, new URL(out.confluence).origin, "Atlassian browser origins differ");
  assert.equal(new URL(out.outlook).origin, new URL(out.microsoftState).origin, "Outlook is not the receipt's backend");
  assert.equal(new URL(out.oneDrive).origin, new URL(out.microsoftState).origin, "OneDrive is not the receipt's backend");
  const headers = { authorization: `Bearer ${out.openworkToken}` };
  const workspaceBase = `${out.openworkUrl}/workspace/${encodeURIComponent(out.workspaceId)}/opencode`;
  let messages;
  stage = "same-world backend reads";
  if (sessionId) {
    if (!/^ses_[a-zA-Z0-9_-]+$/.test(sessionId)) fail("Invalid session ID.");
    messages = await json(`${workspaceBase}/session/${encodeURIComponent(sessionId)}/message`, headers);
    marker ||= JSON.stringify(messages).match(/Workshop-comparison-\d+/)?.[0];
    if (!Array.isArray(messages)) fail("Session history missing.");
  }
  const [atlassian, microsoft] = await Promise.all([json(out.atlassianState), json(out.microsoftState)]);
  if (!marker) {
    const candidates = atlassian.jira.issues.filter((issue) => /^Workshop-comparison-\d+$/.test(issue.fields?.summary ?? issue.summary ?? ""));
    if (candidates.length !== 1) fail("Supply an explicit marker (could not identify exactly one rehearsal).");
    marker = candidates[0].fields?.summary ?? candidates[0].summary;
  }
  if (!sessionId) fail("Supply the actual paid rehearsal session ID; backend records alone do not prove a connected run.");
  verifyWorkshop({ messages, atlassian, microsoft, marker, providerId: out.providerId, modelId: out.modelId });
  const issue = atlassian.jira.issues.find((item) => (item.fields?.summary ?? item.summary) === marker);
  if (!issue || !/^DOC-\d+$/.test(issue.key)) fail("Matching created DOC issue missing.");
  const assignee = issue.fields?.assignee ?? issue.assignee;
  const nora = atlassian.jira.users?.find((user) => /Nora Patel/i.test(user.displayName ?? user.name ?? ""));
  if (!/nora/i.test(JSON.stringify(assignee)) && !(nora && [nora.key, nora.name, nora.username].filter(Boolean).includes(assignee))) fail("DOC issue is not assigned to Nora.");
  const document = microsoft.files.find((file) => file.name === `${marker}.txt`);
  if (!document || !document.preview?.text || !/Atlas\s*2/i.test(document.preview.text) || !/Atlas\s*Lift/i.test(document.preview.text)) fail("OneDrive comparison document missing or lacks both products.");
  const draft = microsoft.messages.find((mail) => mail.isDraft && mail.parentFolderId === "drafts" && (mail.body?.content?.includes(document.webUrl) || mail.body?.content?.includes(document.id)));
  if (!draft) fail("No unsent Outlook draft links the created document.");
  const datasheets = atlassian.confluence.pages.filter((page) => /datasheet/i.test(page.title) && /Atlas (2|Lift)/i.test(page.title));
  if (datasheets.length < 2) fail("Both Confluence datasheets are required.");

  stage = "headless Chrome startup";
  const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  await access(chrome);
  await mkdir(screenshots, { recursive: true, mode: 0o700 });
  const profile = await mkdtemp(join(tmpdir(), "workshop-proof-chrome-"));
  let child, socket;
  const pending = new Map();
  try {
    child = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "--window-size=1440,1000", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-50000); });
    child.on("error", () => { /* Report sanitized startup failure below. */ });
    await waitFor(() => /DevTools listening on (ws:\/\/[^\s]+)/.test(stderr), "Chrome failed to start.", 15000);
    const debug = new URL(/DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)[1]).origin.replace("ws:", "http:");
    const target = await (await fetch(`${debug}/json/new?about:blank`, { method: "PUT" })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await once(socket, "open");
    let seq = 0;
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      const call = pending.get(message.id);
      if (!call) return;
      clearTimeout(call.timer); pending.delete(message.id);
      message.error ? call.reject(new Error("Chrome command failed; private details omitted.")) : call.resolve(message.result);
    });
    const cdp = (method, params = {}) => new Promise((resolveCall, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Chrome command timed out.")); }, 20000);
      pending.set(id, { resolve: resolveCall, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) fail("Browser evaluation failed; private details omitted.");
      return result.result.value;
    };
    const navigate = async (url, condition) => {
      await cdp("Page.navigate", { url });
      try { await waitFor(() => evaluate(condition), "Expected service data did not render."); }
      catch (error) { await screenshot("failure-" + stage.replace(/[^a-z0-9]+/gi, "-").toLowerCase()).catch(() => undefined); throw error; }
    };
    await cdp("Runtime.enable"); await cdp("Page.enable");
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const captures = [];
    const browserSecrets = [out.openworkToken, out.password].filter(Boolean);
    const screenshot = async (name) => {
      // Guard all actual visible content, form values and the URL before writing any image.
      const safe = await evaluate(`(() => { const secrets=${JSON.stringify(browserSecrets)}; const visible=[document.body?.innerText || '', location.href, ...[...document.querySelectorAll('input,textarea')].map(e=>e.value)].join('\\n'); return !secrets.some(secret=>visible.includes(secret)) && !document.querySelector('vite-error-overlay'); })()`);
      if (!safe) fail("Screenshot blocked: secret or development error overlay visible.");
      await evaluate("document.fonts.ready.then(()=>true)");
      const image = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const bytes = Buffer.from(image.data, "base64");
      assert.equal(bytes.readUInt32BE(16), 1440, "Screenshot width");
      assert.equal(bytes.readUInt32BE(20), 1000, "Screenshot height");
      await writeFile(join(screenshots, `${name}.png`), bytes, { mode: 0o600 });
      captures.push(`${name}.png`);
    };
    stage = "Jira browser assertion";
    await navigate(new URL(`/jira/browse/${encodeURIComponent(issue.key)}`, out.jira).href, `document.getElementById('issue-title')?.textContent === ${JSON.stringify(marker)} && /Nora Patel/.test(document.querySelector('#issue-assignee option:checked')?.textContent || '')`);
    await screenshot("jira-created-doc-ticket");
    stage = "Outlook browser assertion";
    const mailUrl = new URL(out.outlook); mailUrl.searchParams.set("message", draft.id);
    await navigate(mailUrl.href, `document.getElementById('mailbody')?.textContent.includes(${JSON.stringify(document.id)}) || document.getElementById('mailbody')?.textContent.includes(${JSON.stringify(document.webUrl)})`);
    assert.equal(await evaluate("!!document.getElementById('editdraft') && document.getElementById('detail').innerText.includes('Draft')"), true, "Browser must show an unsent draft");
    await evaluate("document.querySelector('[data-folder=\"drafts\"]')?.click()");
    await waitFor(() => evaluate(`document.getElementById('listtitle')?.textContent === 'Drafts' && !!document.querySelector('[data-id="${draft.id}"]')`), "Drafts folder did not render.");
    await evaluate(`document.querySelector('[data-id="${draft.id}"]').click()`);
    await waitFor(() => evaluate(`document.getElementById('mailbody')?.textContent.includes(${JSON.stringify(document.webUrl)}) && !!document.getElementById('editdraft')`), "Created reply draft did not render.");
    await screenshot("outlook-comparison-draft");
    stage = "OneDrive browser assertion";
    const fileUrl = new URL(out.oneDrive); fileUrl.searchParams.set("item", document.id);
    await navigate(fileUrl.href, `document.querySelector('#detail h1')?.textContent === ${JSON.stringify(document.name)} && /Atlas\\s*2/i.test(document.getElementById('filetext')?.textContent || '') && /Atlas\\s*Lift/i.test(document.getElementById('filetext')?.textContent || '')`);
    assert.equal(await evaluate(`document.getElementById('filetext').textContent === ${JSON.stringify(document.preview.text)}`), true, "Browser preview must match same-world backend");
    await screenshot("onedrive-comparison-document");
    stage = "Confluence browser assertion";
    for (const page of datasheets) {
      await navigate(new URL(`/confluence/pages/${encodeURIComponent(page.id)}`, out.confluence).href, `document.getElementById('page-title')?.textContent === ${JSON.stringify(page.title)} && (document.getElementById('document')?.innerText.length || 0) > 100`);
      await screenshot(/Atlas 2/.test(page.title) ? "confluence-atlas-2-datasheet" : "confluence-atlas-lift-datasheet");
    }
    if (sessionId) {
      stage = "app-web session browser assertion";
      // Existing runtime/bootstrap conventions: scoped runtime token, server override and shell session memory.
      // Only this disposable Chrome profile is changed. Never set a token in the URL or print storage.
      const appOrigin = new URL(out.webUrl).origin;
      const boot = { origin: appOrigin, runtime: out.openworkUrl, token: out.openworkToken, workspaceId: out.workspaceId, sessionId, model: { providerID: out.providerId, modelID: out.modelId } };
      await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const b=${JSON.stringify(boot)}; if(location.origin!==b.origin)return; localStorage.setItem('openwork.preferences',JSON.stringify({defaultModel:b.model,modelVariant:null,providerStepCompleted:true})); localStorage.setItem('openwork.defaultModel',b.model.providerID+'/'+b.model.modelID); localStorage.setItem('openwork.server.urlOverride',b.runtime); localStorage.setItem('openwork.server.token',b.token); localStorage.setItem('openwork.react.activeWorkspace',b.workspaceId); localStorage.setItem('openwork.react.sessionByWorkspace',JSON.stringify({[b.workspaceId]:b.sessionId})); })()` });
      const route = `/workspace/${encodeURIComponent(out.workspaceId)}/session/${encodeURIComponent(sessionId)}`;
      await navigate(new URL(route, out.webUrl).href, `!!window.__openworkControl?.listActions?.().some(action=>action.id==='auth.exchange-grant')`);
      // Supported seeded-world sign-in, not invented credentials or a production account.
      // The browser's local profile still needs its own Den session to expose paid models.
      const denPost = async (path, body, token) => {
        const response = await fetch(out.denApi + path, { method: "POST", redirect: "error", headers: { origin: out.denWeb, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
        if (!response.ok) fail(`Owned Den sign-in failed: HTTP ${response.status}; private response omitted.`);
        return response.json();
      };
      const signedIn = await denPost("/api/auth/sign-in/email", { email: out.email, password: out.password });
      if (typeof signedIn.token !== "string") fail("Owned Den returned no sign-in token.");
      browserSecrets.push(signedIn.token);
      const handoff = await denPost("/v1/auth/desktop-handoff", { desktopScheme: "openwork" }, signedIn.token);
      if (typeof handoff.grant !== "string") fail("Owned Den returned no handoff grant.");
      browserSecrets.push(handoff.grant);
      await evaluate(`window.__openworkControl.execute('auth.exchange-grant',${JSON.stringify({ grant: handoff.grant, baseUrl: out.denWeb, apiBaseUrl: out.denApi })}).then(()=>true)`);
      await waitFor(() => evaluate("!!localStorage.getItem('openwork.den.authToken') && !!localStorage.getItem('openwork.den.activeOrgId')"), "Seeded browser sign-in did not settle.", 60000);
      browserSecrets.push(await evaluate("localStorage.getItem('openwork.den.authToken')"));
      await navigate(new URL(route, out.webUrl).href, `location.pathname === ${JSON.stringify(route)} && !!document.querySelector('main') && document.body.innerText.includes(${JSON.stringify(issue.key)}) && /gpt.?4\\.1/i.test(document.body.innerText) && !document.querySelector('vite-error-overlay')`);
      await screenshot("openwork-completed-session");
    }
    stage = "proof report";
    const result = { verdict: "Passed", sessionId: sessionId ?? null, marker, issueKey: issue.key, draftId: draft.id, documentId: document.id, viewport: { width: 1440, height: 1000 }, captures, checks: ["same-world backend", "DOC assigned to Nora", "Outlook unsent draft links document", "OneDrive browser content matches backend", "both Confluence datasheets", ...(sessionId ? ["app-web existing session"] : [])] };
    await writeFile(join(screenshots, "browser-proof.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error("Browser closed.")); }
    socket?.close();
    await stop(child);
    await rm(profile, { recursive: true, force: true });
  }
}
main().catch(() => {
  // Never echo raw receipt, HTTP body, browser exception, token-bearing expression, or password.
  console.error(`Workshop browser proof failed during ${stage}; private details withheld. No readiness polling or model turn was performed.`);
  process.exitCode = 1;
});
