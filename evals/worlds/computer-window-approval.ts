import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";
import { createComputerControl } from "../../packages/computer-use/computer-control.mjs";
import { createRemoteComputerAdapter } from "../../packages/computer-use/computer-remote.mjs";

/** Production broker, adapter and ComputerPanel, with an isolated desktop driver. */
export async function computerWindowApproval(_seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  const decisions: unknown[] = [];
  let inputs = 0;
  const adapter = createRemoteComputerAdapter({ id: "fixture", label: "Test desktop", driver: {
    platform: "linux", describe: async () => ({ readiness: "ready", detail: "Ready" }),
    windows: async () => [{ id: 17, title: "Project draft", app: "Editor", region: { x: 0, y: 0, width: 800, height: 600 } }],
    screen: async () => ({ x: 0, y: 0, width: 800, height: 600 }), focus: async () => {},
    screenshot: async () => ({ png: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=", "base64"), width: 1, height: 1 }),
    input: async steps => { inputs += steps.length; return { completed: steps.length }; },
  } });
  // This journey checks admission while paused. The runner must never execute;
  // the controller's colocated test exercises cancellation with the real runtime.
  const control = createComputerControl({ adapters: [adapter], readRemoteFeatureEnabled: async () => true,
    runProgram: async () => { throw new Error("A paused program must not execute"); },
    browserTask: async () => { inputs++; return { ok: true, tabId: "owned" }; },
  });
  resources.defer(async () => { await control.reset(true); });
  const sessionId = "fixture-chat";
  try {
    await control.setFeatureEnabled(true);
    await control.setRemoteEnabled(true);
    const vite = await createServer({
      root: fileURLToPath(new URL("../../apps/app", import.meta.url)),
      configFile: fileURLToPath(new URL("../../apps/app/vite.config.ts", import.meta.url)),
      server: { host: "127.0.0.1", port: 0, strictPort: false },
      plugins: [{ name: "computer-enabled-access-fixture", configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url ?? "/", "http://fixture");
          if (url.pathname.startsWith("/fixture/") && req.method === "POST") {
            try {
              let body = "";
              for await (const chunk of req) body += chunk;
              const input = JSON.parse(body);
              const result = url.pathname === "/fixture/presentation" ? await control.presentation({ sessionId, visible: input.visible })
                : url.pathname === "/fixture/stop" ? await control.halt({ sessionId })
                : url.pathname === "/fixture/snapshot" ? await control.snapshot({ sessionId })
                : await control.interact(input);
              if (url.pathname === "/fixture/decision") decisions.push(input);
              res.setHeader("content-type", "application/json"); res.end(JSON.stringify(result ?? null));
            } catch { res.statusCode = 409; res.end("{}"); }
            return;
          }
          if (url.pathname !== "/") return next();
          const html = await server.transformIndexHtml("/", '<!doctype html><html><head><title>Enabled computer access</title></head><body><script type="module" src="/test-fixtures/computer-window-approval.tsx"></script></body></html>');
          res.setHeader("content-type", "text/html"); res.end(html);
        });
      } }],
    });
    resources.defer(() => vite.close());
    await vite.listen();
    const url = vite.resolvedUrls?.local[0];
    if (!url) throw new Error("The enabled computer fixture did not start");
    const web = resources.use(await chrome({ host: place.host(), name: "computer-enabled-access", startUrl: url, headless: true }));
    return { web, url, decisions: () => structuredClone(decisions), inputs: () => inputs,
      async startWork() {
        return control.execute({ sessionId, name: "computer_open", args: { app_id: "Editor", mode: "control", purpose: "Edit the project draft" } });
      },
      async followUp() {
        await control.endTurn({ sessionId });
        return control.execute({ sessionId, name: "computer_observe", args: {} });
      },
      async snapshot() { return control.snapshot({ sessionId }); },
      async browserWork() { return control.program({ sessionId, surface: "browser", code: 'return await tools.ui.open({url:"https://example.com"});' }); },
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); } };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
