import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// Only frontend source changes can reach this path. All service code, schema,
// dependency inputs and controller files are part of the running-template key.
const root = "/opt/openwork-preview";
const services = JSON.parse(await readFile(`${root}/services.json`, "utf8"));
const seen = new Set();
async function warm(path) {
  if (seen.has(path) || !path.startsWith("/") || path.startsWith("//")) return;
  seen.add(path);
  const response = await fetch(`${services.app}${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Updated app module unavailable: ${path}`);
  const source = await response.text();
  for (const match of source.matchAll(/(?:from\s*|import\s*\(?\s*|src=)["'](\/[^"']+)["']/g)) await warm(match[1]);
}
// Let the development servers consume checkout's filesystem notifications.
await delay(500);
await warm("/");
if (services.den) {
  for (const path of ["/", "/dashboard", "/dashboard/ai-gateway"]) {
    const response = await fetch(`${services.den}${path}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Updated Den page unavailable: ${path}`);
    await response.text();
  }
  // A reusable template's demo session may be old; each commit gets a renewed one.
  await import("./resume.mjs");
  if (services.desktop && ["ready", "ready-signed-out"].includes((await readFile(`${root}/desktop/status`, "utf8")).trim())) {
    const { attachSurface, addInitScript, browserScript, evaluate } = await import("/workspace/evals/packages/cdp/src/index.ts");
    const { signInDesktopAs } = await import("/workspace/evals/packages/behaviors/src/index.ts");
    const surface = await attachSurface({ name: "preview-refresh", kind: "electron", hostKind: "local", cdpUrl: "http://127.0.0.1:9825" }, { timeoutMs: 30_000 });
    const nonce = randomUUID();
    const init = await addInitScript(surface.client, browserScript((value) => { globalThis.__openworkPreviewReload = value; }, [nonce]));
    try {
      await surface.client.send("Page.reload", { ignoreCache: true });
      let loaded = false;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        loaded = await evaluate(surface.client, browserScript((value) => globalThis.__openworkPreviewReload === value && Boolean(window.__openworkControl?.listActions?.().length), [nonce])).catch(() => false);
        if (loaded) break;
        await delay(250);
      }
      if (!loaded) throw new Error("Desktop did not load the updated frontend");
      const outputs = JSON.parse(await readFile(`${root}/outputs.json`, "utf8"));
      // The desktop signs in through its loopback Den front (see desktop.mjs).
      const den = { webUrl: services.desktopDen ?? services.den, apiUrl: services.api };
      try {
        await signInDesktopAs(surface, den, { ...den, token: outputs.denToken.value, email: outputs.alexEmail.value, password: outputs.alexPassword.value });
        await writeFile(`${root}/desktop/status`, "ready", { mode: 0o600 });
      } catch (error) {
        console.error("Updated desktop is signed out:", error);
        await writeFile(`${root}/desktop/status`, "ready-signed-out", { mode: 0o600 });
      }
    } finally {
      await init.dispose();
      await surface.stop();
    }
  }
  const marker = JSON.parse(await readFile(`${root}/ready-world`, "utf8"));
  await writeFile(`${root}/ready-world`, JSON.stringify({ ...marker, warmedAt: new Date().toISOString(), modules: seen.size }));
} else {
  await import("./health.mjs");
}
await writeFile(`${root}/source-sha`, process.argv[2]);
