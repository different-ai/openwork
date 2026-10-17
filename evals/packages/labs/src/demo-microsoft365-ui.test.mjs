// Standalone browser proof for the single-file fictional Microsoft fixture.
// DEMO_SCREENSHOT_DIR=/approved/path node --test evals/packages/labs/src/demo-microsoft365-ui.test.mjs
// Node 22+; CHROME_BIN can select an installed Chrome/Chromium (always headless).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

async function freePort() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}
async function waitFor(fn, message, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { if (await fn()) return; } catch { /* Wait for startup/render. */ } await delay(60); }
  throw new Error(message);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGTERM");
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
}

test("Microsoft demo: real headless Outlook and OneDrive share REST/MCP state", { timeout: 90000 }, async (t) => {
  const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  try { await access(chrome); } catch { t.skip("Set CHROME_BIN to an installed Chrome/Chromium for browser verification."); return; }
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "demo-microsoft-browser-"));
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [new URL("./demo-microsoft365.mjs", import.meta.url).pathname], { env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DEMO_PUBLIC_URL: base }, stdio: "ignore" });
  let browser, socket;
  t.after(async () => { socket?.close(); if (browser) await stop(browser); await stop(server); await rm(directory, { recursive: true, force: true }); });
  await waitFor(async () => (await fetch(base + "/health")).ok, "Microsoft fixture did not start");
  browser = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${join(directory, "profile")}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let output = ""; browser.stderr.on("data", (data) => { output += data; });
  await waitFor(() => /DevTools listening on (ws:\/\/[^\s]+)/.test(output), "Headless Chrome did not start");
  const endpoint = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output)[1];
  const debugOrigin = new URL(endpoint).origin.replace("ws:", "http:");
  const target = await (await fetch(debugOrigin + "/json/new?about:blank", { method: "PUT" })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, "open");
  let sequence = 0; const pending = new Map(), errors = [];
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
    if (message.method === "Page.javascriptDialogOpening") void cdp("Page.handleJavaScriptDialog", { accept: true });
    if (pending.has(message.id)) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); message.error ? reject(new Error(message.error.message)) : resolve(message.result); }
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const navigate = async (path, condition) => { await cdp("Page.navigate", { url: base + path }); await waitFor(() => evaluate(condition), `${path} did not render`); };
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const fill = (id, value, event = "input") => evaluate(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)};document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}))`);
  const submit = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).requestSubmit()`);
  const state = async () => (await fetch(base + "/state")).json();
  const rest = async (path, method = "GET", body) => {
    const response = await fetch(base + "/v1.0" + path, { method, headers: { authorization: "Bearer demo-microsoft365-token", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(response.ok, await response.clone().text()); return response.status === 204 || response.status === 202 ? null : response.json();
  };
  let rpcId = 0;
  const tool = async (name, args) => {
    const response = await (await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }) })).json();
    assert.equal(response.result.isError, false, JSON.stringify(response)); return JSON.parse(response.result.content[0].text);
  };
  await cdp("Runtime.enable"); await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const screenshot = async (name) => {
    if (!process.env.DEMO_SCREENSHOT_DIR) return;
    await mkdir(process.env.DEMO_SCREENSHOT_DIR, { recursive: true });
    const image = await cdp("Page.captureScreenshot", { format: "png" });
    await writeFile(join(process.env.DEMO_SCREENSHOT_DIR, name + ".png"), Buffer.from(image.data, "base64"));
  };

  await navigate("/outlook", "document.querySelectorAll('.mailrow').length===6");
  assert.equal(await evaluate("document.querySelectorAll('#folders [data-folder]').length"), 5);
  await click('[data-id="mail-blueharbor-2"]');
  await waitFor(() => evaluate("document.getElementById('mailbody')?.textContent.includes('1,200 kg')"), "Reading pane did not open");
  await waitFor(async () => (await rest("/me/messages/mail-blueharbor-2")).isRead, "Opening message did not mark it read");
  await screenshot("outlook-reading-pane");
  await click("#toggleRead");
  await waitFor(async () => !(await rest("/me/messages/mail-blueharbor-2")).isRead, "Unread mutation did not persist");
  await fill("listfilter", "unread", "change");
  await waitFor(() => evaluate("[...document.querySelectorAll('.mailrow')].every(x=>x.classList.contains('unread'))"), "Unread filter is not filtering");
  await fill("listfilter", "all", "change");
  await fill("search", "priya@acme.test");
  await waitFor(() => evaluate("document.querySelectorAll('.mailrow').length===1"), "Sender search did not filter");
  await fill("search", "no matching fictional message");
  await waitFor(() => evaluate("document.getElementById('list').textContent.includes('No matching messages')"), "Mail empty state missing");
  await fill("search", "");
  await click("#archivemail");
  await waitFor(async () => (await rest("/me/messages/mail-blueharbor-2")).parentFolderId === "archive", "Archive did not persist");
  await click('[data-folder="archive"]');
  await waitFor(() => evaluate("document.querySelectorAll('.mailrow').length===1"), "Archive list not refreshed");
  await click('[data-id="mail-blueharbor-2"]');
  await waitFor(() => evaluate("!!document.getElementById('deletemail')"), "Archive message did not open");
  await click("#deletemail");
  await waitFor(async () => (await rest("/me/messages/mail-blueharbor-2")).parentFolderId === "deleteditems", "Delete did not persist");
  await click('[data-folder="deleteditems"]');
  await waitFor(() => evaluate("!!document.querySelector('[data-id=\"mail-blueharbor-2\"]')"), "Deleted item not listed");
  await click('[data-id="mail-blueharbor-2"]');
  await waitFor(() => evaluate("!!document.getElementById('restoremail')"), "Restore control missing");
  await click("#restoremail");
  await waitFor(async () => (await rest("/me/messages/mail-blueharbor-2")).parentFolderId === "inbox", "Restore did not persist");

  await click("#compose");
  await fill("to", "priya@acme.test"); await fill("subject", "Acme browser decision notes"); await fill("body", "Verify the field gate <script>window.injected=true</script>");
  await submit("composeform");
  await waitFor(async () => (await state()).messages.some((m) => m.subject === "Acme browser decision notes" && m.isDraft), "Browser draft was not shared");
  await evaluate("document.getElementById('body').focus();document.getElementById('body').setSelectionRange(3,3)");
  await tool("mail_create_draft", { subject: "Agent draft appears through polling", body: "Acme shared state", to: ["alex@acme.test"] });
  await waitFor(() => evaluate("document.getElementById('list').textContent.includes('Agent draft appears through polling')"), "MCP draft did not refresh in browser");
  assert.deepEqual(await evaluate("({id:document.activeElement.id,start:document.activeElement.selectionStart})"), { id: "body", start: 3 });
  await screenshot("outlook-compose-draft");
  await click("#send");
  await waitFor(async () => (await state()).messages.some((m) => m.subject === "Acme browser decision notes" && m.parentFolderId === "sentitems" && !m.isDraft), "Browser send did not move shared draft");
  await waitFor(() => evaluate("document.getElementById('mailbody')?.textContent.includes('<script>')"), "Sent body not safely rendered");
  assert.equal(await evaluate("window.injected===undefined"), true);
  await click("#reply");
  await waitFor(() => evaluate("!!document.getElementById('composeform')"), "Reply draft editor did not open");
  assert.match(await evaluate("document.getElementById('subject').value"), /^RE:/);

  await navigate("/outlook?view=calendar", "!!document.getElementById('eventform')");
  await fill("eventsubject", "Acme browser pilot gate"); await fill("eventstart", "2026-11-20T09:00"); await fill("eventend", "2026-11-20T09:30"); await fill("eventlocation", "Acme lab B");
  await submit("eventform");
  await waitFor(async () => (await state()).events.some((e) => e.subject === "Acme browser pilot gate"), "Browser calendar create not shared");
  await waitFor(() => evaluate("document.getElementById('eventlist').textContent.includes('Acme browser pilot gate')"), "Calendar event not displayed");
  await screenshot("outlook-calendar");
  const calendarEvent = await tool("calendar_create", { subject: "MCP detailed review", body: { contentType: "Text", content: "Review the lab evidence <script>window.injected=true</script>" }, start: { dateTime: "2026-11-23T09:00:00", timeZone: "Europe/Paris" }, end: { dateTime: "2026-11-23T10:00:00", timeZone: "Europe/Paris" }, attendees: [{ emailAddress: { address: "priya@acme.test", name: "Priya Shah" }, type: "required" }], location: "Lab B" });
  await navigate(new URL(calendarEvent.webLink).pathname + new URL(calendarEvent.webLink).search, "document.getElementById('eventlist')?.textContent.includes('MCP detailed review')");
  assert.match(await evaluate("document.getElementById('eventlist').textContent"), /Priya Shah.*Review the lab evidence/s);
  assert.equal(await evaluate("window.injected===undefined"), true);
  await tool("calendar_update", { event_id: calendarEvent.id, start: "2026-11-24T11:00:00", end: "2026-11-24T12:00:00", time_zone: "Europe/Paris" });
  await waitFor(() => evaluate("document.getElementById('eventlist').textContent.includes('2026-11-24T11:00:00')"), "Rescheduled event did not poll into detail deep link");
  assert.match(await evaluate("document.getElementById('eventlist').textContent"), /Europe\/Paris.*Priya Shah.*Review the lab evidence/s);
  assert.equal(await evaluate("document.querySelectorAll('[data-event-id]').length"), 1);
  await screenshot("outlook-rescheduled-event-detail");

  await navigate("/onedrive", "document.querySelectorAll('.filetable tbody tr').length===4");
  assert.equal(await evaluate("document.querySelector('main').classList.contains('has-preview')"), false);
  const files = (await state()).files, doc = files.find((f) => f.name.endsWith(".docx"));
  await click(`[data-id="${doc.id}"]`);
  await waitFor(() => evaluate("document.getElementById('filetext')?.textContent.includes('497/500')"), "Office bytes did not produce safe preview");
  assert.equal(await evaluate("document.getElementById('edittext')===null"), true, "Office preview must not pretend to edit Office");
  const downloadPath = await evaluate("document.querySelector('#detail a[download],#detail a[href^=\"/download/\"]').getAttribute('href')");
  const downloaded = Buffer.from(await (await fetch(base + downloadPath)).arrayBuffer());
  assert.equal(downloaded.readUInt32LE(0), 0x04034b50);
  await screenshot("onedrive-office-preview");
  await click("#closepreview");
  const textFile = await tool("file_write", { path: "Acme browser notes.txt", content: "Agent created these notes" });
  await waitFor(() => evaluate("document.getElementById('list').textContent.includes('Acme browser notes.txt')"), "MCP file did not poll into OneDrive");
  await click(`[data-id="${textFile.id}"]`);
  await waitFor(() => evaluate("!!document.getElementById('edittext')"), "Text editor control missing");
  await click("#edittext"); await fill("filecontents", "Browser saved these notes <script>window.injected=true</script>"); await submit("textform");
  await waitFor(async () => (await tool("file_read", { item_id: textFile.id })).text.startsWith("Browser saved"), "Browser text edit not visible to MCP");
  await waitFor(() => evaluate("document.getElementById('filetext')?.textContent.startsWith('Browser saved')"), "Saved text not rendered");
  assert.equal(await evaluate("window.injected===undefined"), true);
  await click("#edittext"); await fill("filecontents", "Unsaved browser version");
  await tool("file_write", { path: "Acme browser notes.txt", content: "Agent won the revision race" });
  await submit("textform");
  await waitFor(() => evaluate("document.getElementById('notice').textContent.includes('file changed')"), "Stale eTag did not show a recoverable error");
  assert.equal(await evaluate("document.getElementById('filecontents').value"), "Unsaved browser version");
  await screenshot("onedrive-stale-edit");
  await click("#canceltext");
  await waitFor(() => evaluate("document.getElementById('filetext')?.textContent==='Agent won the revision race'"), "Cancel did not restore shared file revision");
  await click("#closepreview");
  await fill("search", "no matching fictional file");
  await waitFor(() => evaluate("document.getElementById('list').textContent.includes('No matching files')"), "File empty state missing");
  await fill("search", "");
  await click("#newfolder"); await fill("foldername", "Acme browser evidence"); await submit("folderform");
  await waitFor(async () => (await state()).files.some((f) => f.name === "Acme browser evidence" && f.folder), "New folder not persisted");
  const folder = (await state()).files.find((f) => f.name === "Acme browser evidence");
  await waitFor(() => evaluate(`!!document.querySelector('[data-id="${folder.id}"]')`), "New folder row missing");
  await click(`[data-id="${folder.id}"]`);
  await waitFor(() => evaluate("document.getElementById('listtitle').textContent==='Acme browser evidence'"), "Folder navigation failed");
  const uploadPath = join(directory, "Acme-upload.docx"); await writeFile(uploadPath, downloaded);
  const dom = await cdp("DOM.getDocument"); const input = await cdp("DOM.querySelector", { nodeId: dom.root.nodeId, selector: "#upload" });
  await cdp("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [uploadPath] });
  await waitFor(async () => (await state()).files.some((f) => f.name === "Acme-upload.docx" && f.parentReference.id === folder.id), "Upload did not land in current folder");
  const uploaded = (await state()).files.find((f) => f.name === "Acme-upload.docx");
  const bytes = Buffer.from(await (await fetch(base + "/download/" + uploaded.id)).arrayBuffer()); assert.deepEqual(bytes, downloaded);
  await waitFor(() => evaluate("document.getElementById('filetext')?.textContent.includes('497/500')"), "Uploaded Office preview missing");
  await screenshot("onedrive-uploaded-office");
  await click("#backfolder");
  await waitFor(() => evaluate("document.getElementById('listtitle').textContent==='My files'"), "Back to root failed");
  await fill("listfilter", "modified", "change");
  const rootFiles = (await state()).files.filter((file) => file.parentReference.id === "root");
  const modifiedOrder = rootFiles.sort((a, b) => Number(Boolean(b.folder)) - Number(Boolean(a.folder)) || b.lastModifiedDateTime.localeCompare(a.lastModifiedDateTime)).map((file) => file.id);
  await waitFor(async () => JSON.stringify(await evaluate("[...document.querySelectorAll('.filetable [data-id]')].map(x=>x.dataset.id)")) === JSON.stringify(modifiedOrder), "Modified sort did not sort shared metadata");
  await screenshot("onedrive-my-files");
  assert.deepEqual(errors, [], "Browser should not raise uncaught script errors");
});
