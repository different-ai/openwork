// Isolated Chromium smoke test, run explicitly (never launches the OS browser):
// OPENWORK_MIDDLE_CLICK_TEST_PROFILE=<new unused absolute path> \
//   pnpm --filter @openwork/desktop exec electron electron/browser-middle-click.electron.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, WebContentsView, dialog, ipcMain, session, shell } from "electron";
import { createBrowserPanel } from "./browser-panel.mjs";

// Do not await app readiness at ESM top level: Electron waits for the entry
// module to finish evaluating before it emits ready.
async function run() {
  const profile = process.env.OPENWORK_MIDDLE_CLICK_TEST_PROFILE;
  if (!profile || !path.isAbsolute(profile) || existsSync(profile)) {
    throw new Error("Set OPENWORK_MIDDLE_CLICK_TEST_PROFILE to a new, unused absolute path.");
  }
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  app.disableHardwareAcceleration();
  app.dock?.hide();
  let stage = "start local fixture server";
  const deadline = setTimeout(() => { console.error(`Middle-click smoke test timed out: ${stage}`); app.exit(1); }, 30_000);
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const launches = [];
  const policies = [];
  const preloadErrors = [];
  let denied = false;
  let dialogs = 0;
  // Stub the last native boundary before creating any content.
  shell.openExternal = async (url) => { launches.push(url); };
  dialog.showMessageBox = async () => { dialogs++; return { response: 0, checkboxChecked: false }; };
  for (const channel of ["openwork:desktop-bootstrap-sync", "openwork:desktop-distribution-sync"]) {
    ipcMain.on(channel, event => { event.returnValue = null; });
  }
  let destination;
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(`<body style="margin:0"><a id="link" href="${destination}" target="_blank" style="display:block;width:240px;height:70px"><span>Nested citation / markdown link</span></a></body>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const source = `http://127.0.0.1:${address.port}/`;
  destination = `http://localhost:${address.port}/destination?value=%2F#section`;
  let mainWindow;
  let panel;
  let exitCode = 0;
  try {
    stage = "wait for Electron readiness";
    await app.whenReady();
    app.on("web-contents-created", (_event, contents) => {
      contents.on("preload-error", (_event, _preload, error) => { preloadErrors.push(error); });
    });
    // No production requests, even if a regression permits unwanted navigation.
    // The panel replaces its partition's hook with the checkPolicy below.
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      callback({ cancel: !details.url.startsWith(source) && !details.url.startsWith("about:") });
    });
    mainWindow = new BrowserWindow({ show: false, focusable: false, width: 900, height: 600, webPreferences: {
      preload: path.join(directory, "preload.mjs"), contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false,
    } });
    panel = createBrowserPanel({
      getWindow: () => mainWindow, remoteDebugPort: 0, onDeepLink() {},
      checkPolicy: async (request) => {
        policies.push(request);
        if (request.external && denied) throw new Error("Test policy denial");
        if (!request.external && !request.url.startsWith(source)) throw new Error("Test network isolation");
      },
      showNativeContextMenu: async () => null, closeNativeContextMenu() {},
    });
    const handlers = new Map();
    panel.registerIpc({
      handle(channel, handler) { handlers.set(channel, handler); ipcMain.handle(channel, handler); },
      on(channel, handler) { handlers.set(channel, handler); ipcMain.on(channel, handler); },
    });
    const mainPopups = [];
    mainWindow.webContents.setWindowOpenHandler(details => { mainPopups.push(details.url); return { action: "deny" }; });
    const invoke = (channel, ...args) => handlers.get(channel)({ sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame }, ...args);
    stage = "load app fixture";
    await mainWindow.loadURL(source);
    async function settle() { await new Promise(resolve => setTimeout(resolve, 200)); }
    async function click(contents, button, modifiers = []) {
      const point = await contents.executeJavaScript(`(() => {
        globalThis.fixtureInputs = [];
        for (const type of ["mousedown", "mouseup", "auxclick", "click"]) document.addEventListener(type,
          event => fixtureInputs.push({ type, button: event.button, trusted: event.isTrusted }), { capture: true, once: true });
        const r = document.getElementById("link").getBoundingClientRect();
        return { x: Math.round(r.x + 30), y: Math.round(r.y + 20) };
      })()`);
      contents.sendInputEvent({ type: "mouseDown", button, modifiers, clickCount: 1, ...point });
      contents.sendInputEvent({ type: "mouseUp", button, modifiers, clickCount: 1, ...point });
      await settle();
    }
    async function verifyExternalClick(contents, button = "middle", modifiers = []) {
      launches.length = 0;
      policies.length = 0;
      const before = invoke("openwork:browser:state").tabs.length;
      const currentUrl = contents.getURL();
      await click(contents, button, modifiers);
      assert.deepEqual(preloadErrors, []);
      assert.deepEqual(launches, [destination], `${stage}; input events: ${JSON.stringify(await contents.executeJavaScript("fixtureInputs"))}`);
      assert.deepEqual(policies.filter(item => item.external), [{ url: destination, external: true }]);
      assert.equal(invoke("openwork:browser:state").tabs.length, before);
      assert.equal(contents.getURL(), currentUrl);
      assert.deepEqual(mainPopups, []);
      denied = true;
      launches.length = 0;
      await click(contents, button, modifiers);
      assert.deepEqual(launches, []);
      assert.equal(invoke("openwork:browser:state").tabs.length, before);
      assert.equal(contents.getURL(), currentUrl);
      assert.deepEqual(mainPopups, []);
      denied = false;
      // A synthetic main-world event must not grant native external browsing.
      const eventType = button === "middle" ? "auxclick" : "click";
      const eventInit = { button: button === "middle" ? 1 : 0, detail: 1, metaKey: modifiers.includes("meta"), ctrlKey: modifiers.includes("control"), bubbles: true, cancelable: true };
      await contents.executeJavaScript(`(() => {
        const link = document.getElementById("link");
        // Cancel only the synthetic event's ordinary DOM default, after the
        // isolated capture handler. An erroneous native launch is still visible.
        link.addEventListener(${JSON.stringify(eventType)}, event => event.preventDefault(), { once: true });
        link.dispatchEvent(new MouseEvent(${JSON.stringify(eventType)}, ${JSON.stringify(eventInit)}));
      })()`);
      await settle();
      assert.deepEqual(launches, []);
    }
    stage = "dispatch app input";
    const accelerator = process.platform === "darwin" ? "meta" : "control";
    await verifyExternalClick(mainWindow.webContents);
    await verifyExternalClick(mainWindow.webContents, "left", [accelerator]);
    policies.length = 0;
    await click(mainWindow.webContents, "left");
    assert.deepEqual(mainPopups, [destination], "ordinary primary-click popup behavior is unchanged");
    assert.deepEqual(launches, [], "primary click must not also launch externally");
    assert.deepEqual(policies.filter(item => item.external), []);
    assert.equal(invoke("openwork:browser:state").tabs.length, 0);
    assert.equal(mainWindow.webContents.getURL(), source);
    mainPopups.length = 0;
    invoke("openwork:browser:show", { x: 0, y: 0, width: 600, height: 400 }, "fixture");
    invoke("openwork:browser:createTab", "about:blank", "fixture");
    await settle();
    const view = mainWindow.contentView.children.find(child => child instanceof WebContentsView);
    assert.ok(view);
    await view.webContents.loadURL(`${source}embedded`);
    stage = "dispatch embedded input";
    // Chromium drops WebContentsView mouse events while its native host is hidden.
    // Show only this isolated fixture without activating or focusing it.
    mainWindow.showInactive();
    await settle();
    await verifyExternalClick(view.webContents);
    await verifyExternalClick(view.webContents, "left", [accelerator]);
    assert.equal(dialogs, 4);
    console.log("PASS: Chromium middle and Cmd/Ctrl-click in app and embedded main frame open exactly once; no built-in popup/navigation; denial and synthetic events do not launch; unmodified app left click unchanged. OS launch stubbed.");
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    panel?.destroy();
    mainWindow?.destroy();
    server.close();
    clearTimeout(deadline);
    app.exit(exitCode);
  }
}

void run().catch(error => { console.error(error); app.exit(1); });
