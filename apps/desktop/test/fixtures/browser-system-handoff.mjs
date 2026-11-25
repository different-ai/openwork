import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { createBrowserPanel } from "../../electron/browser-panel.mjs";
import { EXTERNAL_OPEN_CAPTURE_FILENAME } from "../../electron/open-external.mjs";

const profile = mkdtempSync(path.join(tmpdir(), "openwork-browser-handoff-"));
app.setPath("userData", profile);
process.env.OPENWORK_DEV_MODE = "1";
process.env.OPENWORK_EVAL_CAPTURE_EXTERNAL_OPENS = "1";
process.on("exit", () => rmSync(profile, { recursive: true, force: true }));
setTimeout(() => { console.error("Browser handoff timed out"); app.exit(1); }, 15000).unref();

async function run() {
  await app.whenReady();
  if (process.platform === "darwin") app.dock.hide();
  const host = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(import.meta.dirname, "browser-system-handoff-host.cjs"),
  } });
  let denyExternal = false;
  const panel = createBrowserPanel({ getWindow: () => host, checkPolicy: async (request) => {
    if (request.external && denyExternal) throw new Error("External browser is restricted");
  } });
  panel.registerIpc(ipcMain);
  await host.loadURL("about:blank");
  const server = createServer((_request, response) => response.end("Account settings"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/account/settings?view=keys`;
  const pageLoaded = new Promise((resolve) => {
    app.once("web-contents-created", (_event, page) => {
      page.on("did-finish-load", () => { if (page.getURL() === url) resolve(); });
    });
  });
  const { tabId } = await host.webContents.executeJavaScript(`window.tabs.create(${JSON.stringify(url)})`);
  await pageLoaded;
  const handOff = () => host.webContents.executeJavaScript(`window.tabs.openExternal(${JSON.stringify(tabId)})`);
  await handOff();
  denyExternal = true;
  await assert.rejects(handOff, /External browser is restricted/);
  const capture = readFileSync(path.join(profile, EXTERNAL_OPEN_CAPTURE_FILENAME), "utf8").trim();
  assert.deepEqual(capture.split("\n").map((line) => JSON.parse(line)), [url]);
  console.log("The active page opened once. Managed policy blocked the second handoff.");
  server.close();
}

run().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
