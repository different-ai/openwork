import { writeFile } from "node:fs/promises";
import { control, evalIn, quitDesktop } from "@openwork/behaviors";
import { addInitScript, browserScript } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import { mcpMock } from "@openwork/env";
import type { Place, Seed } from "@openwork/env";
import { desktop } from "@openwork/hosts";
import { configureProvider } from "./chat.ts";
import { pidIsAlive, portIsOpen, waitUntil } from "./thread-restart.ts";

export async function pinDurability(seed: Seed, ctx: { place: Place }) {
  if (ctx.place.kind !== "local") throw new Error("This fault world requires an explicitly selected local VM lane");
  const mock = (await mcpMock({}).boot(ctx.place)).handle;
  const bootstrap = seed.tmpPath("pin-bootstrap.json");
  await writeFile(bootstrap, JSON.stringify({ baseUrl: mock.url, apiBaseUrl: mock.url, requireSignin: false }));
  const env = { OPENWORK_DESKTOP_BOOTSTRAP_PATH: bootstrap, VITE_DEN_BASE_URL: mock.url, VITE_DEN_API_BASE_URL: mock.url };
  let app: Surface & { stop(): Promise<void> } = await seed.desktop({ name: "pin-durability", profileDir: seed.tmpPath("pin-profile"), env });
  const profileDir = app.handle.profileDir;
  const port = app.handle.meta?.vitePort;
  if (!profileDir || !port) throw new Error("Missing isolated profile or renderer origin");
  const origin = String(await evalIn(app, () => location.origin));
  const workspace = await seed.workspace(app, seed.tmpPath("pin-workspace"));
  await configureProvider(seed, app, workspace.workspaceId, "pin-fixture", "pin-model", {
    provider: { "pin-fixture": { npm: "@ai-sdk/openai-compatible", name: "Pin fixture", options: { baseURL: `${mock.url}/v1`, apiKey: "fixture-only" }, models: { "pin-model": { name: "Pin fixture" } } } },
  });
  const sessions = [];
  for (let i = 1; i <= 3; i++) sessions.push(await seed.session(app, { title: `Durable pin ${i}` }));
  // Fault injection and storage observation require the actual renderer store.
  // No engine database or Chromium backing file is opened.
  const unrelatedWrite = () => evalIn(app, async () => {
    const module: typeof import("../../apps/app/src/react-app/domains/session/sidebar/session-management-store.ts") = await new Function('return import("/src/react-app/domains/session/sidebar/session-management-store.ts")')();
    module.useSessionManagementStore.getState().setSidebarView("workspaces");
  }, { awaitPromise: true });
  for (const session of sessions.slice(0, 2)) await control(app, "session.pin", { sessionId: session.sessionId });
  const snapshot = () => evalIn(app, async () => {
    const module: typeof import("../../apps/app/src/react-app/domains/session/sidebar/session-management-store.ts") = await new Function('return import("/src/react-app/domains/session/sidebar/session-management-store.ts")')();
    return { key: localStorage.getItem("openwork.react.sessionManagement"), pins: module.useSessionManagementStore.getState().pinnedIds, origin: location.origin };
  }, { awaitPromise: true });
  return {
    get app() { return app; }, sessions, profileDir, snapshot,
    async fault(kind: "read" | "corrupt" | "unavailable") {
      const generation = await evalIn(app, () => performance.timeOrigin);
      if (kind === "corrupt") {
        await evalIn(app, () => localStorage.setItem("openwork.react.sessionManagement", "{broken"));
      } else if (kind === "read") {
        await addInitScript(app.client, () => {
          const getItem = Storage.prototype.getItem;
          Storage.prototype.getItem = function(key) {
            if (key === "openwork.react.sessionManagement") {
              Storage.prototype.getItem = getItem;
              throw new DOMException("Synthetic storage read failure", "SecurityError");
            }
            return getItem.call(this, key);
          };
        });
      } else {
        await app.client.send("Network.enable");
        await app.client.send("Network.setBlockedURLs", { urls: ["*/workspace/*/opencode/*"] });
      }
      await app.client.send("Page.reload");
      await waitUntil("a new document to finish loading", async () => {
        try { return await evalIn(app, browserScript((previous: number) => performance.timeOrigin !== previous && document.readyState === "complete", [generation])); } catch { return false; }
      }, 30_000);
      await waitUntil("the renderer store to load", async () => { try { await snapshot(); return true; } catch { return false; } }, 30_000);
      await unrelatedWrite();
      if (kind === "unavailable") {
        const blocked = await evalIn(app, browserScript(async (workspaceId: string) => {
          const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
          if (!info) throw new Error("Missing fixture server");
          try {
            await fetch(`${info.baseUrl}/workspace/${workspaceId}/opencode/session`, { headers: { Authorization: `Bearer ${info.ownerToken}` }, signal: AbortSignal.timeout(5000) });
            return false;
          } catch { return true; }
        }, [workspace.workspaceId]), { awaitPromise: true });
        if (!blocked) throw new Error("The engine-unavailable fault did not block a session request");
      }
    },
    async restart(kind: "quit" | "kill" | "busy") {
      const pid = app.handle.pid;
      if (!pid) throw new Error("Missing fixture PID");
      if (kind === "busy") {
        // SIGSTOP is a deterministic main-process stall. Only this synthetic
        // Electron main is stopped, never a live app or an engine process.
        const { execFileSync } = await import("node:child_process");
        const raw = execFileSync("lsof", ["-tiTCP:" + app.handle.meta?.cdpPort, "-sTCP:LISTEN"], { encoding: "utf8" });
        const main = Number(raw.trim().split("\n")[0]);
        if (!Number.isSafeInteger(main) || main <= 1) throw new Error("Missing isolated Electron main");
        process.kill(main, "SIGSTOP");
        try {
          await waitUntil("main process stopped", async () => execFileSync("ps", ["-o", "state=", "-p", String(main)], { encoding: "utf8" }).includes("T"), 5000);
          const quitting = quitDesktop(app);
          await new Promise<void>(resolve => setImmediate(resolve));
          process.kill(main, "SIGCONT");
          await quitting;
        } finally {
          try { process.kill(main, "SIGCONT"); } catch { /* already exited */ }
        }
      } else if (kind === "quit") await quitDesktop(app);
      else process.kill(-pid, "SIGKILL");
      if (kind !== "kill") await waitUntil("desktop exit", async () => !pidIsAlive(pid), 60_000);
      await app.stop().catch(() => undefined);
      await waitUntil("renderer origin release", async () => !(await portIsOpen(Number(port))), 30_000);
      app = await desktop({ name: "pin-relaunch", profileDir, env: { ...env, PORT: port, OPENWORK_ELECTRON_START_URL: origin }, prepareSharedResources: false });
      await waitUntil("the renderer store to load", async () => { try { await snapshot(); return true; } catch { return false; } }, 30_000);
    },
    async [Symbol.asyncDispose]() { await app.stop().catch(() => undefined); await mock.stop(); },
  };
}
