import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";

/** Real Workbot client, host parsing, navigation and profile. API inventory and sign-in are deterministic fixtures;
 * this is UI regression evidence, not a live Den/runner or remote-computer integration test. */
export async function workbotProfileComputers(_seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  let access = { profileComputers: false, profileSheet: true, devices: true };
  let inventory: "populated" | "empty" | "error" = "populated";
  const reads: string[] = [];
  const now = Date.now();
  const computer = (id: string, label: string, cloud = false) => ({
    id, label, kind: cloud ? "vm" : "desktop", provider: cloud ? "workbot" : "openwork_desktop",
    source: cloud ? "workbot" : "desktop_app", platform: cloud ? "linux" : "darwin", access: "mine",
    availability: "online", state: "ready", statusDetail: null, lastSeenAt: new Date(now).toISOString(),
    createdAt: new Date(now).toISOString(), appVersion: "1.0.0", computerId: null, workbotChat: cloud ? "main" : null,
    canRename: !cloud, canRemove: !cloud,
  });
  try {
    const vite = await createServer({
      configFile: fileURLToPath(new URL("../../ee/apps/workbot/vite.config.ts", import.meta.url)),
      server: { host: "127.0.0.1", port: 0, strictPort: false },
      plugins: [{ name: "workbot-profile-computers-fixture", configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const path = new URL(req.url ?? "/", `http://${req.headers.host}`).pathname;
          if (!path.startsWith("/v1/workbot")) return next();
          reads.push(`${req.method} ${path}`);
          const json = (body: unknown, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
          if (path === "/v1/workbot/me") return json({ name: "Sam Example", email: "sam@example.test", userId: "user_example", organizationId: "org_example", organizationName: "Example", enabled: true,
            workingStatus: true, centeredProfile: true, profileNav: true, browser: true, calendar: true, sideChats: true, activationChecklist: false,
            ...access, denUrl: "https://workspace.example.test" });
          if (path === "/v1/workbot") return json({ available: true, name: "Workbot", organizationName: "Example", status: "idle", turns: [{ id: "hello_example", text: "Hello", sentAt: now - 2000, finishedAt: now - 1000, status: "done", attachments: [], outputs: [], parts: [{ kind: "text", text: "How can I help?" }], modelSteps: 1, error: null }], hasEarlier: false, filesEnabled: true });
          if (path === "/v1/workbot/chats") return json({ main: null, side: [] });
          if (path === "/v1/workbot/devices") return inventory === "error" ? json({ error: "unavailable" }, 503) : json({ devices: inventory === "empty" ? [] : [computer("desktop_example", "Studio laptop"), computer("cloud_example", "Workbot's computer", true)] });
          if (path === "/v1/workbot/connections") return json({ connections: [] });
          if (path === "/v1/workbot/memory") return json({ files: [] });
          if (path.endsWith("/calendar/v1/automations")) return json({ items: [], nextCursor: null });
          if (path === "/v1/workbot/events") { res.setHeader("content-type", "text/event-stream"); res.end(": fixture\n\n"); return; }
          if (path === "/v1/workbot/computer/viewer") return json({ error: "unavailable" }, 503);
          return json({ error: "not_found" }, 404);
        });
      } }],
    });
    resources.defer(() => vite.close());
    await vite.listen();
    const url = vite.resolvedUrls?.local[0];
    if (!url) throw new Error("Workbot fixture did not start");
    const web = resources.use(await chrome({ host: place.host(), name: "workbot-profile-computers", startUrl: url, headless: true }));
    return {
      web, url,
      setAccess(next: Partial<typeof access>) { access = { ...access, ...next }; },
      setInventory(next: typeof inventory) { inventory = next; },
      reads: () => [...reads],
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
