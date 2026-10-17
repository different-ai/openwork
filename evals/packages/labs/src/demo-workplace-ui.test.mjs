// Standalone integration proof. Node 22+; browser portion uses headless Chrome if installed.
// node --test evals/packages/labs/src/demo-workplace-ui.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { locate } from "../../cdp/src/input.ts";
import { setTimeout as delay } from "node:timers/promises";

async function port() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const result = server.address().port; await new Promise((resolve) => server.close(resolve)); return result;
}
async function waitFor(fn, message, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await fn()) return; } catch { /* Await startup/render. */ } await delay(80); }
  throw new Error(message);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGTERM");
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
}

test("workplace UI shares demo REST state and supports real browser workflows", { timeout: 90000 }, async (t) => {
  const backendPort = await port(), uiPort = await port();
  const backend = `http://127.0.0.1:${backendPort}`, base = `http://127.0.0.1:${uiPort}`;
  const children = [];
  const launch = (file, env) => {
    const child = spawn(process.execPath, [new URL(file, import.meta.url).pathname], { env: { ...process.env, HOST: "127.0.0.1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child); return child;
  };
  t.after(async () => { for (const child of children.reverse()) await stop(child); });
  launch("./demo-atlassian.mjs", { PORT: String(backendPort) });
  launch("./demo-workplace-ui.mjs", { PORT: String(uiPort), ATLASSIAN_BASE_URL: backend });
  await waitFor(async () => (await fetch(base + "/health")).ok && (await fetch(backend + "/health")).ok, "Services did not start");
  const html = await (await fetch(base + "/jira")).text();
  const token = /name="demo-csrf" content="([^"]+)"/.exec(html)[1];
  const proxy = async (path, method = "GET", body) => {
    const response = await fetch(base + "/api/atlassian" + path, { method, headers: { "Content-Type": "application/json", "X-Demo-CSRF": token }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, await response.clone().text()); return response.status === 204 ? null : response.json();
  };
  assert.match(html, /Demo · fictional workspace/);
  assert.equal((await fetch(base + "/api/atlassian/state")).status, 400);
  assert.equal((await fetch(base + "/api/atlassian/jira/rest/api/2/issue", { method: "POST", body: "{}" })).status, 403);
  assert.equal((await fetch(base + "/api/atlassian/jira/rest/api/2/search", { method: "POST", headers: { "X-Demo-CSRF": token }, body: "x".repeat(1024 * 1024 + 1) })).status, 413);
  const created = await proxy("/jira/rest/api/2/issue", "POST", { fields: { project: { key: "DOC" }, summary: "HTTP integration issue", issuetype: { name: "Task" } } });
  const directIssue = await (await fetch(`${backend}/jira/rest/api/2/issue/${created.key}`, { headers: { Authorization: "Bearer demo-pat" } })).json();
  assert.equal(directIssue.fields.summary, "HTTP integration issue");
  const resetRequest = await proxy("/jira/rest/servicedeskapi/request", "POST", { serviceDeskId: "1", requestTypeId: "11", requestFieldValues: { summary: "Fixture Windows reset", customfield_10500: "10600" } });
  assert.equal((await proxy(`/jira/rest/api/2/issue/${resetRequest.issueKey}`)).fields.customfield_10500.value, "Windows login");
  for (const route of ["/jira", `/jira/browse/${created.key}`, "/confluence", "/confluence/pages/163840001"]) assert.equal((await fetch(base + route)).status, 200);

  await t.test("headless browser: search, create, comments, mutations, polling, document edit and sanitization", { timeout: 70000 }, async (browserTest) => {
    const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    try { await access(chrome); } catch { browserTest.skip("Set CHROME_BIN to run real headless browser verification."); return; }
    const profile = await mkdtemp(join(tmpdir(), "demo-workplace-chrome-"));
    const chromeProcess = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    let log = ""; chromeProcess.stderr.on("data", (data) => { log += data; });
    browserTest.after(async () => { await stop(chromeProcess); await rm(profile, { recursive: true, force: true }); });
    await waitFor(() => /DevTools listening on (ws:\/\/[^\s]+)/.test(log), "Chrome did not start");
    const endpoint = /DevTools listening on (ws:\/\/[^\s]+)/.exec(log)[1];
    const debugOrigin = new URL(endpoint).origin.replace("ws:", "http:");
    const target = await (await fetch(debugOrigin + "/json/new?about:blank", { method: "PUT" })).json();
    const socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, "open");
    browserTest.after(() => socket.close());
    let seq = 0; const pending = new Map(); const browserErrors = [];
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === "Runtime.exceptionThrown") browserErrors.push(message.params.exceptionDetails.text);
      if (message.id && pending.has(message.id)) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); message.error ? reject(new Error(message.error.message)) : resolve(message.result); }
    });
    const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression) => {
      const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
    };
    const navigate = async (path, condition) => { await cdp("Page.navigate", { url: base + path }); await waitFor(() => evaluate(condition), `Page ${path} did not render`); };
    const change = async (id, value, event = "input") => {
      await waitFor(() => evaluate(`!document.getElementById(${JSON.stringify(id)}).disabled`), `Control ${id} stayed disabled`);
      return evaluate(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)};document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}))`);
    };
    const click = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).focus();document.getElementById(${JSON.stringify(id)}).click()`);
    await cdp("Runtime.enable"); await cdp("Page.enable");
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const screenshot = async (name) => {
      if (!process.env.DEMO_SCREENSHOT_DIR) return;
      await mkdir(process.env.DEMO_SCREENSHOT_DIR, { recursive: true });
      const image = await cdp("Page.captureScreenshot", { format: "png" });
      await writeFile(join(process.env.DEMO_SCREENSHOT_DIR, name + ".png"), Buffer.from(image.data, "base64"));
    };
    await navigate("/jira", "document.querySelectorAll('#issue-rows tr').length > 3");
    await screenshot("jira-issues");
    await navigate(`/jira/browse/${resetRequest.issueKey}`, "document.getElementById('service-request-fields')?.innerText.includes('Windows login')");
    assert.equal(await evaluate("document.getElementById('service-request-fields').innerText.includes('Reset a password')"), true);
    await screenshot("jira-windows-reset");
    await navigate("/jira", "document.querySelectorAll('#issue-rows tr').length > 3");
    await change("project-filter", "DOC", "change");
    assert.ok(await evaluate("[...document.querySelectorAll('#issue-rows tr')].every(r=>r.textContent.includes('DOC-'))"));
    await evaluate("document.querySelector('[data-view=board]').click()");
    assert.equal(await evaluate("document.getElementById('issue-table').hidden && !document.getElementById('issue-board').hidden"), true);
    assert.ok(await evaluate("[...document.querySelectorAll('.board-card')].every(r=>r.textContent.includes('DOC-'))"));
    await screenshot("jira-project-board");
    await navigate("/jira?project=DOC&view=board", "document.querySelectorAll('.board-card').length > 2");
    assert.equal(await evaluate("document.getElementById('project-filter').value"), "DOC");
    assert.equal(await evaluate("document.getElementById('issue-table').hidden"), true);
    await change("status-filter", "indeterminate", "change");
    assert.equal(await evaluate("document.querySelectorAll('.board-column:first-child .board-card,.board-column:last-child .board-card').length"), 0);
    await screenshot("jira-project-board-filtered");
    await change("status-filter", "", "change");
    await change("assignee-filter", "unassigned", "change");
    assert.ok(await evaluate("[...document.querySelectorAll('#issue-rows tr')].every(r=>r.textContent.includes('Unassigned'))"));
    await change("assignee-filter", "", "change");
    await evaluate("document.querySelector('[data-view=list]').click()");
    await change("sort-issues", "key", "change");
    assert.equal(await evaluate("document.getElementById('list-title').textContent"), await evaluate("document.querySelector('#project-filter option:checked').textContent"));
    await change("search", "HTTP integration");
    assert.equal(await evaluate("document.querySelectorAll('#issue-rows tr').length"), 1);
    await change("search", "<no match>");
    assert.ok(await evaluate("document.getElementById('issue-rows').textContent.includes('No matching issues')"));
    await click("create-issue"); assert.equal(await evaluate("document.getElementById('create-dialog').open"), true);
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    assert.equal(await evaluate("document.getElementById('create-dialog').open"), false);
    assert.equal(await evaluate("document.activeElement.id"), "create-issue");
    await click("create-issue");
    await change("new-project", "DOC", "change"); await change("new-summary", "Browser-created issue <safe>"); await change("new-description", "A real browser draft");
    await screenshot("jira-create-dialog");
    await evaluate("document.getElementById('create-form').requestSubmit()");
    await waitFor(() => evaluate("document.getElementById('issue-title')?.textContent === 'Browser-created issue <safe>'"), "Create issue did not navigate to the created issue");
    await screenshot("jira-created-issue");
    const browserKey = await evaluate("location.pathname.split('/').at(-1)");
    // Use the same native target locator as workshop scene assertions, not an ID-only DOM lookup.
    const surface = { handle: { name: "workplace-regression", kind: "chrome", hostKind: "local", cdpUrl: debugOrigin }, client: { send: cdp, close() {} } };
    const assignee = await locate(surface, { label: "Assignee" });
    assert.equal(assignee.name, "Assignee");
    assert.equal(assignee.value, "");
    assert.equal(assignee.visible, true);
    await click("edit-issue");
    await change("edit-issue-summary", "Browser-edited issue");
    const richDescription = "Description edited in the issue dialog\n\n*Atlas 2*\n* Payload: 300 kg\n* Top speed: {{2.0 m/s}}\n\n<img src=x onerror=window.bad=true>";
    await change("edit-issue-description", richDescription);
    await evaluate("document.getElementById('edit-issue-form').requestSubmit()");
    await waitFor(() => evaluate("document.getElementById('issue-title').textContent === 'Browser-edited issue'"), "Issue edit did not persist");
    assert.equal((await proxy(`/jira/rest/api/2/issue/${browserKey}`)).fields.description, richDescription);
    assert.equal(await evaluate("document.querySelector('#issue-description strong')?.textContent"), "Atlas 2");
    assert.equal(await evaluate("document.querySelectorAll('#issue-description ul li').length"), 2);
    assert.equal(await evaluate("document.querySelector('#issue-description code')?.textContent"), "2.0 m/s");
    assert.equal(await evaluate("document.querySelectorAll('#issue-description img').length"), 0);
    await click("add-comment");
    assert.equal(await evaluate("document.activeElement.id"), "comment-body");
    await change("comment-body", "Browser comment <script>window.bad=true</script>");
    await evaluate("document.getElementById('comment-form').requestSubmit()");
    await waitFor(() => evaluate("document.getElementById('issue-comments').textContent.includes('Browser comment')"), "Comment was not displayed");
    assert.equal(await evaluate("window.bad === undefined"), true);
    await change("issue-priority", "High", "change");
    await waitFor(async () => (await proxy(`/jira/rest/api/2/issue/${browserKey}`)).fields.priority.name === "High", "Priority not persisted");
    await change("issue-assignee", "priya.shah", "change");
    await waitFor(async () => (await proxy(`/jira/rest/api/2/issue/${browserKey}`)).fields.assignee?.displayName === "Priya Shah", "Assignee not persisted");
    assert.equal((await locate(surface, { label: "Assignee" })).value, "priya.shah");
    assert.equal((await locate(surface, { label: "Priority" })).value, "High");
    await proxy(`/jira/rest/api/2/issue/${browserKey}`, "PUT", { fields: { assignee: { name: "nora.patel" } } });
    await waitFor(async () => (await locate(surface, { label: "Assignee" })).value === "nora.patel", "Native Assignee target did not reflect the agent-assigned teammate");
    await change("issue-status", "21", "change");
    await waitFor(async () => (await proxy(`/jira/rest/api/2/issue/${browserKey}`)).fields.status.name === "In Progress", "Transition not persisted");
    await waitFor(() => evaluate("document.querySelector('#issue-status option:checked').textContent === 'In Progress'"), "Transition not rendered");
    await screenshot("jira-updated-issue");
    await evaluate("document.getElementById('comment-body').focus();document.getElementById('comment-body').value='Unsaved draft';document.getElementById('comment-body').setSelectionRange(3,3)");
    await proxy(`/jira/rest/api/2/issue/${browserKey}`, "PUT", { fields: { summary: "Updated from agent REST" } });
    await waitFor(() => evaluate("document.getElementById('issue-title').textContent === 'Updated from agent REST'"), "REST mutation did not auto-refresh");
    assert.deepEqual(await evaluate("({id:document.activeElement.id,value:document.activeElement.value,start:document.activeElement.selectionStart})"), { id: "comment-body", value: "Unsaved draft", start: 3 });
    await navigate("/confluence", "document.querySelectorAll('.page-row').length > 10");
    const firstSpace = await evaluate("document.querySelector('#space-filter option[value]:not([value=\"\"])').value");
    await change("space-filter", firstSpace, "change");
    assert.ok(await evaluate("[...document.querySelectorAll('.page-row small')].every(r=>r.textContent.includes(document.querySelector('#space-filter option:checked').textContent))"));
    await change("space-filter", "", "change");
    await change("search", "Expenses and travel");
    assert.ok(await evaluate("document.querySelectorAll('.page-row').length <= 2 && document.getElementById('page-results').textContent.includes('Expenses and travel')"));
    await navigate("/confluence/pages/163840005", "document.getElementById('page-title')?.textContent === 'IT and security'");
    assert.equal(await evaluate("document.querySelectorAll('#page-outline a').length"), 2);
    await screenshot("confluence-it-policy");
    await navigate("/confluence/pages/163840002", "document.getElementById('page-title')?.textContent === 'Working at the office'");
    const officeBefore = await evaluate("document.getElementById('document').innerHTML");
    const officeHeadings = await evaluate("[...document.querySelectorAll('#document h1,#document h2')].map(node=>node.textContent)");
    const mcpTool = async (name, args) => {
      const rpc = await (await fetch(backend + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json();
      assert.equal(rpc.result.isError, false, rpc.result.content[0].text);
      return JSON.parse(rpc.result.content[0].text);
    };
    const { metadata: office } = await mcpTool("confluence_get_page", { page_id: "163840002" });
    const review = "Workshop review: office guidance checked on 2026-10-16; dog-policy confirmation remains with People Ops.";
    await mcpTool("confluence_update_page", { page_id: office.id, title: office.title, content: office.content.value + "\n\n" + review });
    const { metadata: reviewedOffice } = await mcpTool("confluence_get_page", { page_id: office.id });
    assert.equal(reviewedOffice.version, office.version + 1);
    await waitFor(() => evaluate(`document.getElementById('document').textContent.includes(${JSON.stringify(review)}) && document.getElementById('page-meta').textContent.includes('Version ${reviewedOffice.version}')`), "MCP office update did not render with the actual incremented version");
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#document h1,#document h2')].map(node=>node.textContent)"), officeHeadings);
    // Outline IDs are assigned by the UI; all original rendered content must remain byte-for-byte intact.
    assert.equal(await evaluate("document.getElementById('document').innerHTML"), officeBefore + `<p>${review}</p>`);
    await screenshot("confluence-office-mcp-review");
    await navigate("/confluence/pages/163840001", "document.getElementById('page-title')?.textContent === 'Employee Handbook'");
    await screenshot("confluence-handbook");
    assert.equal(await evaluate("document.querySelectorAll('#space-tree > details[data-space]').length"), 4);
    assert.ok(await evaluate("document.querySelectorAll('#space-tree .tree details').length > 0"));
    assert.equal(await evaluate("document.querySelectorAll('#space-tree > details[open]').length"), 1);
    await evaluate("document.querySelector('#space-tree .tree details summary').click()");
    const collapsedBranch = await evaluate("document.querySelector('#space-tree .tree details').dataset.branch");
    await delay(2300);
    assert.equal(await evaluate(`document.querySelector('[data-branch="${collapsedBranch}"]').open`), false);
    await click("edit-page");
    await change("edit-title", "Handbook revised in browser");
    await evaluate("document.getElementById('document').innerHTML += '<p>Saved from the browser</p>'");
    await click("save-page");
    await waitFor(() => evaluate("document.getElementById('editor-controls').hidden && document.getElementById('page-title').textContent === 'Handbook revised in browser'"), "Document was not saved");
    const saved = await proxy("/confluence/rest/api/content/163840001?expand=body.storage,version");
    assert.match(saved.body.storage.value, /Saved from the browser/);
    assert.match(saved.body.storage.value, /<ul>/); // Formatting survived editing.
    await proxy("/confluence/rest/api/content/163840001", "PUT", { type: "page", title: saved.title, version: { number: saved.version.number + 1 }, body: { storage: { representation: "storage", value: '<h2>Agent update</h2><script>window.injected=true</script><img src=x onerror="window.injected=true"><svg onload="window.injected=true"></svg><p onclick="window.injected=true">Safe paragraph <a href="javascript:alert(1)">unsafe link</a></p><a href="https://jira.acme.test/browse/FLEET-342">Issue</a>' } } });
    await waitFor(() => evaluate("document.getElementById('document').textContent.includes('Agent update')"), "Document did not auto-refresh");
    assert.equal(await evaluate("document.querySelectorAll('#document script,#document img,#document svg,#document [onclick]').length"), 0);
    assert.equal(await evaluate("window.injected === undefined"), true);
    assert.equal(await evaluate("document.querySelector('#document a').getAttribute('href')"), "/jira/browse/FLEET-342");
    assert.equal(await evaluate("document.querySelectorAll('#page-outline a').length"), 1);
    await evaluate("document.querySelector('#page-outline a').click()");
    assert.ok(await evaluate("location.hash.startsWith('#section-') && !!document.querySelector(location.hash)"));
    await click("edit-page"); await change("edit-title", "Discarded draft"); await click("cancel-edit");
    assert.equal(await evaluate("document.getElementById('page-title').textContent"), saved.title);
    assert.deepEqual(browserErrors, []);
    await stop(children[0]);
    await waitFor(() => evaluate("document.getElementById('notice').textContent.includes(\"Couldn't sync\")"), "Offline state did not surface");
    assert.equal(await evaluate("document.getElementById('page-title').textContent"), saved.title);
    assert.ok(await evaluate("document.getElementById('document').textContent.includes('Agent update')"));
    await screenshot("confluence-offline");
    // Optional artifacts above are actual Chrome captures, never generated mock images.
  });
});
