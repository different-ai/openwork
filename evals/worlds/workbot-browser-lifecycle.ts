import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { allocateFreePorts } from "@openwork/cdp";
import { chrome } from "@openwork/hosts";
import type { Place, Seed } from "@openwork/env";

const witnessSchema = z.array(z.object({ path: z.string(), body: z.unknown() }));

/** Real WorkbotScreen and browser stream transport. Only the model conversation and
 * computer provider are fixtures. The frame is captured by Chrome from an ordinary
 * local document; it is not evidence that a remote computer performed an external task. */
export async function workbotBrowserLifecycle(_seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  const directory = await mkdtemp(join(tmpdir(), "workbot-browser-proof-"));
  resources.defer(() => rm(directory, { recursive: true, force: true }));
  try {
    const source = await chrome({ host: place.host(), name: "browser-provider-frame", headless: true });
    try {
      await source.client.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
      await source.client.send("Page.navigate", { url: `data:text/html,${encodeURIComponent('<!doctype html><html><head><title>Example Domain</title></head><body style="margin:0;background:#fff;font:20px system-ui;color:#202124"><main style="margin:120px auto;max-width:600px"><h1>Example Domain</h1><p>A local browser page for the browser-stream protocol fixture.</p></main></body></html>')}` });
      await delay(150);
      const frame = z.object({ data: z.string() }).parse(await source.client.send("Page.captureScreenshot", { format: "jpeg", quality: 85 }));
      await writeFile(join(directory, "frame.jpg"), Buffer.from(frame.data, "base64"));
    } finally { await source.stop(); }
    const [port] = await allocateFreePorts(1);
    const url = `http://localhost:${port}/`;
    const child = spawn("pnpm", ["--filter", "@openwork-ee/workbot", "exec", "tsx", "test-fixtures/chat-screen-server.ts", String(port)], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: { ...process.env, WORKBOT_FIXTURE_FRAME: join(directory, "frame.jpg"), WORKBOT_FIXTURE_FROZEN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let logs = "";
    child.stdout.on("data", chunk => { logs += String(chunk); });
    child.stderr.on("data", chunk => { logs += String(chunk); });
    resources.defer(async () => {
      if (child.pid && child.exitCode === null) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* already stopped */ }
        await Promise.race([new Promise<void>(resolve => child.once("exit", () => resolve())), delay(3000)]);
      }
    });
    const until = Date.now() + 30_000;
    while (!await fetch(url).then(response => response.ok).catch(() => false)) {
      if (child.exitCode !== null || Date.now() > until) throw new Error(`Browser fixture failed to start: ${logs}`);
      await delay(100);
    }
    const web = resources.use(await chrome({ host: place.host(), name: "workbot-browser-lifecycle", startUrl: "about:blank", headless: true }));
    let cardObject: string | undefined;
    return {
      web, url,
      async requests() { return witnessSchema.parse(await fetch(`${url}fixture/browser-witness`).then(response => response.json())); },
      // CDP retains the actual DOM node as an opaque handle. This only observes;
      // it never injects a selector marker, changes app state or replaces a frame.
      async keepCardIdentity() {
        const result = z.object({ result: z.object({ objectId: z.string().optional() }) }).parse(await web.client.send("Runtime.evaluate", { expression: 'document.querySelector("[data-workbot-browser-card]")' }));
        cardObject = result.result.objectId;
        if (!cardObject) throw new Error("The browser card did not exist");
      },
      async sameCard() {
        if (!cardObject) return false;
        const result = z.object({ result: z.object({ value: z.boolean() }) }).parse(await web.client.send("Runtime.callFunctionOn", { objectId: cardObject, functionDeclaration: 'function () { return this.isConnected && this === document.querySelector("[data-workbot-browser-card]"); }', returnByValue: true }));
        return result.result.value === true;
      },
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
