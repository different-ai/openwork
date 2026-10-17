import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { allocateFreePort, connect, listTargets, locate, type Surface } from "@openwork/cdp";
import { workshopWorkflowFrame } from "./workshop-workflow-frame.ts";

test("payload frame matches plain and source-row facts without changing their required values", () => {
  const frame = workshopWorkflowFrame({ products: [{ product: "Atlas 2", evidence: "| Payload | 300 kg |" }, { product: "Atlas Lift", evidence: "| Payload | 1,200 kg (Euro and US pallets) |" }] });
  assert.ok(frame.atlas2.text.test("| Payload | 300 kg |"));
  assert.ok(frame.lift.text.test("| Payload | 1,200 kg (Euro and US pallets) |"));
  assert.ok(!frame.atlas2.text.test("Payload: 999 kg"));
  assert.ok(!frame.atlas2.text.test("Payload: 3300 kg"));
  assert.ok(!frame.lift.text.test("Payload: 11,200 kg"));
  assert.ok(!frame.lift.text.test("Payload: 200 kg"));
  assert.throws(() => workshopWorkflowFrame({ product: "Atlas 2", payload: "300 kg" }), /payload facts/);
});

test("native browser locates payload excerpts and scrolls their real rendered field into view", { timeout: 30000 }, async () => {
  // UI mechanism control only, not a model result or a workshop business fixture.
  const http = createServer((_request, response) => response.end('<!doctype html><html><body><div style="height:1800px">Mechanism control</div><main><p>Atlas 2</p><p>| Payload | 300 kg |</p><p>Atlas Lift</p><p>| Payload | 1,200 kg (Euro and US pallets) |</p></main><div style="height:1500px"></div></body></html>'));
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const address = http.address(); if (!address || typeof address === "string") throw new Error("No owned UI control address");
  const profile = await mkdtemp(join(tmpdir(), "workshop-frame-control-"));
  const port = await allocateFreePort();
  const chrome = spawn(process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, `http://127.0.0.1:${address.port}`], { stdio: "ignore" });
  let surface: Surface | undefined;
  try {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const target = await listTargets(`http://127.0.0.1:${port}`).then((targets) => targets.find((target) => target.type === "page" && target.url === `http://127.0.0.1:${address.port}/`)).catch(() => undefined);
      if (target?.webSocketDebuggerUrl) { surface = { handle: { name: "payload-native-locator-control", kind: "chrome", hostKind: "local", cdpUrl: `http://127.0.0.1:${port}` }, client: await connect(target.webSocketDebuggerUrl) }; break; }
      await delay(50);
    }
    if (!surface) throw new Error("Headless UI control did not become ready");
    let rendered = false;
    while (Date.now() < deadline) {
      rendered = await locate(surface, { text: "Mechanism control" }).then((element) => element.visible).catch(() => false);
      if (rendered) break;
      await delay(50);
    }
    assert.equal(rendered, true, "The actual navigation must finish before testing field matching");
    await assert.rejects(locate(surface, { text: "300 kg" }), /locate|target|found/i, "Original exact-field target reproduces the capture failure");
    const frame = workshopWorkflowFrame({ facts: ["300 kg", "1,200 kg"] });
    const atlas2 = await locate(surface, frame.atlas2);
    const lift = await locate(surface, frame.lift);
    assert.equal(atlas2.visible, true);
    assert.equal(lift.visible, true);
    assert.match(atlas2.text, /Payload.*300 kg/);
    assert.match(lift.text, /Payload.*1,200 kg/);
    assert.ok(atlas2.center.y > 0 && atlas2.center.y < 1000);
    assert.ok(lift.center.y > 0 && lift.center.y < 1000);
  } finally {
    surface?.client.close();
    if (chrome.exitCode === null && chrome.signalCode === null) { const exit = once(chrome, "exit"); chrome.kill("SIGTERM"); await Promise.race([exit, delay(3000)]); if (chrome.exitCode === null && chrome.signalCode === null) { chrome.kill("SIGKILL"); await exit; } }
    http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
});
