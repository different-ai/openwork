import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";
import { callFunctionOnSurface } from "@openwork/cdp";

/** The real teaching component and styles, without Den, inference or a VM. */
export async function teachingDisclosure(_seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  const cacheDir = await mkdtemp(join(tmpdir(), "teaching-disclosure-vite-"));
  resources.defer(() => rm(cacheDir, { recursive: true, force: true }));
  try {
    const entry = fileURLToPath(new URL("../../ee/apps/workbot/test-fixtures/teaching-disclosure.tsx", import.meta.url));
    const vite = await createServer({
      configFile: fileURLToPath(new URL("../../ee/apps/workbot/vite.config.ts", import.meta.url)),
      cacheDir,
      server: { host: "127.0.0.1", port: 0, strictPort: false },
      plugins: [{ name: "teaching-disclosure-fixture", configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== "/") return next();
          const html = await server.transformIndexHtml("/", `<!doctype html><html><head><title>Teaching disclosure</title></head><body style="margin:0"><div id="root"></div><script type="module" src="/@fs/${entry}"></script></body></html>`);
          response.setHeader("content-type", "text/html"); response.end(html);
        });
      } }],
    });
    resources.defer(() => vite.close());
    await vite.listen();
    const url = vite.resolvedUrls?.local[0];
    if (!url) throw new Error("Teaching disclosure fixture did not start");
    const web = resources.use(await chrome({ host: place.host(), name: "teaching-disclosure", startUrl: url, headless: true }));
    // Fixed read-only markup observation: resolve React-generated ARIA IDREFs
    // without accessing component state or dispatching browser input.
    const relationship = () => callFunctionOnSurface(web, () => Array.from(document.querySelectorAll('[data-testid="workbot-teaching"]'), window => {
      const trigger = window.querySelector("button[aria-expanded]");
      const id = trigger?.getAttribute("aria-controls") ?? "";
      const panel = id ? document.getElementById(id) : null;
      return {
        id, expanded: trigger?.getAttribute("aria-expanded"),
        local: panel !== null && window.contains(panel),
        count: Array.from(document.querySelectorAll("[id]")).filter(element => element.id === id).length,
        visible: panel !== null && panel.getBoundingClientRect().height > 0,
        focused: trigger === document.activeElement,
        bodyPresent: panel?.textContent?.includes("Recorded steps (1)") ?? false,
      };
    }), []);
    return { web, relationship, async [Symbol.asyncDispose]() { await resources.disposeAsync(); } };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
