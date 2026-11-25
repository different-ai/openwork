// A hidden Electron window exercises the shipping browser task host, not a
// mock of Chromium's navigation lifetime. No user profile or external site.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { app, BrowserWindow } from "electron";

async function run() {
  const { createBrowserTaskHost } = await import(process.env.OPENWORK_BROWSER_TASK_TEST_MODULE
    || "../../../../packages/computer-use/browser-task.mjs");

  app.commandLine.appendSwitch("disable-gpu");
  app.setPath("userData", process.env.OPENWORK_NAVIGATION_TEST_PROFILE);
  let phase = "waiting for Electron ready";
  const timeout = setTimeout(() => { console.error(`Navigation regression timed out: ${phase}`); app.exit(1); }, 15000);
  await app.whenReady();
  if (process.platform === "darwin") app.dock.hide();
  const server = createServer((request, response) => {
    if (request.url === "/pending") return; // keep the cancelled navigation alive
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>Browser still usable</title><p>Browser still usable</p>");
  });
  phase = "waiting for local server";
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  const contents = window.webContents;
  const tab = { tabId: "native-navigation", webMcpRevision: 0, view: { webContents: contents } };
  const host = createBrowserTaskHost({ getTab: () => tab, tabsFor: () => [tab], ownerOf: () => "chat", activeFor: () => tab.tabId,
    enabled: () => true, allowed: async () => true, changed() {}, isVisible: () => true });
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    phase = "loading initial page";
    await contents.loadURL(origin);
    phase = "starting renderer navigation";
    let witnessed = false;
    let navigationMicrotask = false;
    let stops = 0;
    let reentrantStops = 0;
    let reportStop;
    const stopped = new Promise((resolve) => { reportStop = resolve; });
    const nativeStop = contents.stop.bind(contents);
    contents.stop = () => {
      // Do call the native method: the baseline must reproduce Chromium's CHECK,
      // rather than merely failing an assertion against a stand-in.
      if (navigationMicrotask) reentrantStops++;
      stops++;
      nativeStop();
      reportStop();
    };
    contents.on("did-start-navigation", (_event, url, _inPlace, isMainFrame) => {
      if (!isMainFrame || url !== `${origin}/pending`) return;
      witnessed = true;
      queueMicrotask(() => {
        navigationMicrotask = true;
        host.pause(tab.tabId);
        phase = "waiting for native stop";
        queueMicrotask(() => { navigationMicrotask = false; });
      });
    });
    await contents.executeJavaScript(`location.assign(${JSON.stringify(`${origin}/pending`)})`);
    await stopped;
    assert.equal(witnessed, true, "the cancellation must occur during a real renderer navigation");
    assert.equal(stops, 1, "the pending native navigation must actually be stopped");
    assert.equal(reentrantStops, 0, "native stop must wait for the navigation callback to unwind");
    assert.equal(host.stateFor(tab.tabId).status, "paused");
    host.resume(tab.tabId);
    await contents.loadURL(`${origin}/after`);
    assert.equal(await contents.executeJavaScript("document.body.innerText"), "Browser still usable");
    console.log(JSON.stringify({ ok: true, electron: process.versions.electron, navigationWitness: witnessed, stops, page: "Browser still usable" }));
    clearTimeout(timeout);
    window.destroy();
    server.closeAllConnections();
    server.close();
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}

// Do not hold Electron's module evaluation open while awaiting app readiness.
run().catch((error) => { console.error(error); app.exit(1); });
