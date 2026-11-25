import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { app, BrowserWindow, ipcMain, session } from "electron";
import { createBrowserPanel } from "../../electron/browser-panel.mjs";

const profile = mkdtempSync(path.join(tmpdir(), "openwork-generated-download-"));
app.setPath("userData", profile);
process.on("exit", () => rmSync(profile, { recursive: true, force: true }));
setTimeout(() => { console.error("Timed out waiting for the generated download"); app.exit(1); }, 15000).unref();

async function run() {
  await app.whenReady();
  if (process.platform === "darwin") app.dock.hide();
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    if (request.url === "/connected") {
      response.end("<script>window.opener.postMessage('connected', location.origin); window.close();</script>");
      return;
    }
    response.end('<button onclick="window.open(window.URL.createObjectURL(new Blob([\'export bytes\'], {type:\'application/octet-stream\'})))">Export</button>');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/`;
  const host = new BrowserWindow({ show: false, webPreferences: { preload: path.join(import.meta.dirname, "browser-generated-download-host.cjs") } });
  const panel = createBrowserPanel({ getWindow: () => host });
  panel.registerIpc(ipcMain);
  const loaded = new Promise((resolve) => {
    app.on("web-contents-created", (_event, contents) => {
      contents.on("did-finish-load", () => { if (contents.getURL() === url) resolve(contents); });
    });
  });
  // Deliver the same createTab request as the desktop toolbar.
  await host.loadURL("about:blank");
  await host.webContents.executeJavaScript(`window.createTestTab(${JSON.stringify(url)})`);
  const page = await loaded;
  const destination = path.join(profile, "export.bin");
  const download = new Promise((resolve) => {
    session.fromPartition("persist:openwork-browser").once("will-download", (_event, item) => {
      item.setSavePath(destination);
      item.once("done", (_done, state) => resolve(state));
    });
  });
  await page.executeJavaScript("document.querySelector('button').click()", true);
  assert.equal(await download, "completed");
  assert.equal(readFileSync(destination, "utf8"), "export bytes");
  console.log("Generated export saved with the original bytes");
  const reply = await page.executeJavaScript(`(async () => {
    const popup = window.open("", "_blank");
    if (!popup) return "popup refused";
    const reply = new Promise(resolve => window.addEventListener("message", event => {
      if (event.origin === location.origin && event.source === popup) resolve(event.data);
    }));
    await new Promise(resolve => setTimeout(resolve, 0));
    popup.location.href = "/connected";
    return reply;
  })()`, true);
  assert.equal(reply, "connected", "a site can navigate a blank popup later and receive its reply");
  console.log("The staged popup returned its result to its opener");
  server.close();
}

run().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
